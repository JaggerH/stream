import { describe, it, expect } from 'vitest'
import { ReplayAdapter, toDataItem, stampHarvestOrder, NeedsLoginError, ActionRecipeBlockedError, type ReplayAdapterDeps } from './adapter.ts'
import type { ReplayLauncher, ReplayPage } from '../../replay/browser-fetch.ts'
import type { Recipe, BrowserRecipe, CanonicalBrowserRecipe } from '../../replay/recipe.ts'
import type { RunBrowserOutcome } from '../../replay/browser-drive.ts'
import type { SourceManifest } from '../../manifest/types.ts'
import { EnvironmentUnavailableError } from '../../failure.ts'
import { HostSessionQueueTimeout, HostRelayDisconnected, HostAbortedByUser } from '../../http/host-relay.ts'
import type { DebugEntry } from '../../debug.ts'
import type { SeeResolver } from '../../replay/desktop-see.ts'

/** 一个不干活的识别层：这几条用例只关心"工厂有没有被递到 runner 手上"，梯子本身有它自己的测试。 */
const NOOP_SEE: SeeResolver = {
  resolve: async () => null,
  matches: async () => [],
  invalidate() {},
  modelCalls: 0,
  localInterrupts: () => [],
}

const RECIPE: Recipe = {
  version: 1, kind: 'fetch', sourceId: 'replay-hn', cookieDomain: '', entryUrl: 'https://hn.algolia.com/',
  request: { url: 'https://hn.algolia.com/api/v1/search?query={query}&page={page}', method: 'GET' },
  pagination: { mode: 'increment', itemsAt: 'hits', param: 'page', start: 0, step: 1, maxPages: 1 },
  assert: [{ path: 'hits', desc: 'no hits' }],
  mapping: { title: 'title', url: 'url', author: 'author' },
}

const MANIFEST = { id: 'replay-hn' } as SourceManifest

/** launcher whose page returns a canned one-page response */
function fakeLauncher(): ReplayLauncher {
  return {
    async launch() {
      const page: ReplayPage = {
        async evaluate() {
          return { status: 200, text: '{"hits":[{"title":"A","url":"http://a","author":"u"}]}' } as never
        },
      }
      return { page, close: async () => {} }
    },
  }
}

function deps(over: Partial<ReplayAdapterDeps> = {}): ReplayAdapterDeps {
  return {
    recipes: { load: () => RECIPE },
    makeLauncher: () => fakeLauncher(),
    ...over,
  }
}

describe('toDataItem', () => {
  it('maps url→link and derives guid', () => {
    expect(toDataItem({ title: 'A', url: 'http://a' })).toMatchObject({ title: 'A', link: 'http://a', guid: 'http://a' })
  })
})

// ── output.timestampFrom:'harvest-order' ─────────────────────────────────────────────────
//
// 「我的收藏」这类清单：上游只给每条内容的**发布时间**，不给「我什么时候收藏的」。照发布时间排，
// 昨天收藏的一条老视频会沉到 150 条的第 142 位——用户在收藏页前 30 条里能看见它，在 Stream 里
// 却翻不到，表现成「采集漏了」（2026-09-03 实测：前 30 条里 10 条是这种）。
describe('stampHarvestOrder', () => {
  const NOW = Date.UTC(2026, 8, 3, 9, 15, 0)
  const canonical = (over: Partial<CanonicalBrowserRecipe['output']> = {}): CanonicalBrowserRecipe => ({
    version: 1, kind: 'browser', sourceId: 'x', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
    loginCheck: { loggedIn: '.me', wall: '.wall' },
    session: { facility: 'x', lifecycle: 'one-shot', visibility: 'unattended' },
    steps: [], observers: [],
    output: { itemsAt: 'items', dedupeBy: 'guid', targetCount: 10, mapping: { guid: 'guid' }, ...over },
  })

  it('stamps pubDate = now − index seconds in harvest order, overriding the mapped pubDate', () => {
    const items = [
      { guid: 'a', pubDate: 1000 },        // an OLD video collected most recently
      { guid: 'b', pubDate: 1788246899 },
      { guid: 'c' },
    ]
    const out = stampHarvestOrder(items, canonical({ timestampFrom: 'harvest-order' }), NOW)
    expect(out.map((i) => i.pubDate)).toEqual([
      new Date(NOW).toISOString(),
      new Date(NOW - 1000).toISOString(),
      new Date(NOW - 2000).toISOString(),
    ])
    // the upstream publish time is not lost — it still rides on the raw item
    expect(out[0]).toMatchObject({ guid: 'a' })
  })

  it('leaves items untouched when the recipe does not opt in', () => {
    const items = [{ guid: 'a', pubDate: 1000 }]
    expect(stampHarvestOrder(items, canonical(), NOW)).toEqual(items)
    expect(stampHarvestOrder(items, RECIPE, NOW)).toEqual(items)
  })

  it('applies on the facility-session path (the path canonical browser recipes actually take)', async () => {
    const recipe = canonical({ timestampFrom: 'harvest-order' })
    const a = new ReplayAdapter(deps({
      recipes: { load: () => recipe },
      sessionFetch: async () => [{ guid: 'old', pubDate: 1000 }, { guid: 'new', pubDate: 1788246899 }],
    }))
    const items = (await a.fetch({}, { id: 'x' } as SourceManifest)) as Array<Record<string, unknown>>
    const t = items.map((i) => Date.parse(String(i.pubDate)))
    expect(t[0] - t[1]).toBe(1000)   // first-harvested stays newest, one second apart
    expect(Date.now() - t[0]).toBeLessThan(60_000)
  })
})

describe('ReplayAdapter', () => {
  // decline ≠ "采到 0 条"：带上成功指针，collection 流的替换层才分得清（2026-07-30 spec）。
  // **没有总开关**——每种 kind 只在自己的前置条件缺席时 decline（下面这条是 desktop 缺 agent）。
  // C1: 动作 recipe（meta.action:true）曾经只在 MCP 的 run_action_recipe 一处挡（confirmed 闸），
  // 而 stream_read → scheduler.readSourceNormalized → fetchSource → adapter.fetch 这条路完全没
  // 看 meta.action，等于给模型指名的同一个 sourceId 留了一条不经确认就能真的跑起来的后门。
  it('meta.action:true 的 recipe 走普通采集路径（fetch）会被拒，不会真的执行', async () => {
    const a = new ReplayAdapter(deps({
      recipes: {
        load: () => ({ version: 1, kind: 'desktop', sourceId: 'qq-send', meta: { action: true } }) as unknown as Recipe,
      },
      desktopDriver: () => ({}) as never,
      runDesktop: async () => { throw new Error('不该跑到这里——闸应该在此之前就拒绝') },
    }))
    await expect(a.fetch({}, { id: 'qq-send' } as SourceManifest)).rejects.toBeInstanceOf(ActionRecipeBlockedError)
  })

  // C2：第一方 UI 路径（前端按钮 → 后端 handler）显式声明 userInitiated 之后应当放行——
  // 这是判据从"是不是动作"改成"是不是用户第一方触发"之后新增的那半，跟上面那条 C1
  // 一起钉住整道闸：不声明拒、声明了放。
  it('meta.action:true 的 recipe 带 userInitiated:true 时放行，真的会跑', async () => {
    const a = new ReplayAdapter(deps({
      recipes: {
        load: () => ({ version: 1, kind: 'desktop', sourceId: 'xhs-like', meta: { action: true } }) as unknown as Recipe,
      },
      desktopDriver: () => ({}) as never,
      runDesktop: async () => ({ outcome: 'ok' as const, items: [{ noteId: 'n1', action: 'like', ok: 'true' }], driftReason: null }),
    }))
    const items = await a.fetch({ noteId: 'n1', action: 'like' }, { id: 'xhs-like' } as SourceManifest, { runtimeConfig: {}, userInitiated: true })
    expect(items).toEqual([{ noteId: 'n1', action: 'like', ok: 'true', link: undefined, guid: undefined }])
  })

  // 非 action recipe 不受这个标记影响——带不带 userInitiated 都照常跑到 runDesktop。
  it('非 action recipe 不看 userInitiated，带不带都正常执行', async () => {
    const outcomes: boolean[] = []
    const a = new ReplayAdapter(deps({
      recipes: { load: () => ({ version: 1, kind: 'desktop', sourceId: 'd1' }) as unknown as Recipe },
      desktopDriver: () => ({}) as never,
      runDesktop: async () => { outcomes.push(true); return { outcome: 'ok', items: [], driftReason: null } },
    }))
    await a.fetch({}, { id: 'd1' } as SourceManifest)
    await a.fetch({}, { id: 'd1' } as SourceManifest, { runtimeConfig: {}, userInitiated: true })
    expect(outcomes).toEqual([true, true])
  })

  // 接线的唯一判据：**runner 手上有没有那个工厂**。宿主装配了识别层却没递到这一跳，症状是
  // 一条用了 `see` 的 recipe 报 drift 说"没配识别层"——而后端明明配了，查起来会一路查错方向。
  it('kind:desktop 装配了 makeSee → runner 拿到的 opts.see 是函数，且绑的是这条 recipe 的 sourceId', async () => {
    const seen: unknown[] = []
    const bound: string[] = []
    const a = new ReplayAdapter(deps({
      recipes: { load: () => ({ version: 1, kind: 'desktop', sourceId: 'd1' }) as unknown as Recipe },
      desktopDriver: () => ({}) as never,
      makeSee: (_driver, sourceId) => { bound.push(sourceId); return NOOP_SEE },
      runDesktop: (async (_r: unknown, _p: unknown, d: unknown, opts?: { see?: (d: unknown) => unknown }) => {
        seen.push(opts?.see)
        opts?.see?.(d)
        return { outcome: 'ok', items: [], driftReason: null }
      }) as never,
    }))
    await a.fetch({}, { id: 'd1' } as SourceManifest)
    expect(typeof seen[0]).toBe('function')
    expect(bound).toEqual(['d1'])
  })

  // 采集这条路也要把本机学到的落地方式原样递到 runner——它和 run_action_recipe 那条路**共用
  // 同一份存储**。这一跳漏了的表现是采集永远只跑包里自带的 grounding，学到的东西只有另一条
  // 路看得见，而两条路每一步照样"成功"。
  it('kind:desktop 把 recipeOverrides 原样递给 runner', async () => {
    const seen: unknown[] = []
    const recipeOverrides = { groundingsFor: () => [], recordRun: () => {} }
    const a = new ReplayAdapter(deps({
      recipes: { load: () => ({ version: 1, kind: 'desktop', sourceId: 'd1' }) as unknown as Recipe },
      desktopDriver: () => ({}) as never,
      recipeOverrides,
      runDesktop: (async (_r: unknown, _p: unknown, _d: unknown, opts?: { overrides?: unknown }) => {
        seen.push(opts?.overrides)
        return { outcome: 'ok', items: [], driftReason: null }
      }) as never,
    }))
    await a.fetch({}, { id: 'd1' } as SourceManifest)
    expect(seen[0]).toBe(recipeOverrides)
  })

  // 设施键只有清单上有（`DesktopRecipe` 不带）。不透传 → Broker 退回 sourceId，同一站的状态
  // 与观测学散到几份文件里，而两边都不报错，所以这一跳必须钉着。
  it('kind:desktop 把清单上的 facility 透传给 runner', async () => {
    const seen: Array<string | undefined> = []
    const a = new ReplayAdapter(deps({
      recipes: { load: () => ({ version: 1, kind: 'desktop', sourceId: 'd1' }) as unknown as Recipe },
      desktopDriver: () => ({}) as never,
      runDesktop: (async (_r: unknown, _p: unknown, _d: unknown, opts?: { facility?: string }) => {
        seen.push(opts?.facility)
        return { outcome: 'ok', items: [], driftReason: null }
      }) as never,
    }))
    await a.fetch({}, { id: 'd1', facility: { key: 'wechat', label: '微信' } } as unknown as SourceManifest)
    // 清单上没有 facility 时如实缺席（不补 sourceId 顶替——那是 Broker 那一侧的退路）。
    await a.fetch({}, { id: 'd1' } as SourceManifest)
    expect(seen).toEqual(['wechat', undefined])
  })

  // 反例：没装配就必须**是 undefined 而不是一个返回空的函数**——runner 据此报"宿主没接识别层"，
  // 那句话和"界面变了"是两个完全不同的下一步。
  it('kind:desktop 没装配 makeSee → opts.see 缺席，不伪造一个空实现', async () => {
    const seen: unknown[] = []
    const a = new ReplayAdapter(deps({
      recipes: { load: () => ({ version: 1, kind: 'desktop', sourceId: 'd1' }) as unknown as Recipe },
      desktopDriver: () => ({}) as never,
      runDesktop: (async (_r: unknown, _p: unknown, _d: unknown, opts?: { see?: unknown }) => {
        seen.push(opts?.see)
        return { outcome: 'ok', items: [], driftReason: null }
      }) as never,
    }))
    await a.fetch({}, { id: 'd1' } as SourceManifest)
    expect(seen[0]).toBeUndefined()
  })

  // drift 留现场：桌面这一侧没有 DevTools、没有 DOM 快照，一步做完屏幕上什么都不剩。
  // "模板命中却点空"和"模型指错了"的下一步完全不同，光看 driftReason 分不出来。
  it('kind:desktop drift → debug bus 上留一条带 seeVia / dismissed 的现场', async () => {
    const entries: DebugEntry[] = []
    const a = new ReplayAdapter(deps({
      recipes: { load: () => ({ version: 1, kind: 'desktop', sourceId: 'd1' }) as unknown as Recipe },
      desktopDriver: () => ({}) as never,
      runDesktop: (async () => ({
        outcome: 'drift',
        items: [],
        driftReason: '没读到送达确认',
        seeVia: { '发送按钮': 'template' },
        dismissed: ['{"text":"稍后再说"}'],
      })) as never,
      onDebug: (e) => entries.push(e),
    }))
    await expect(a.fetch({}, { id: 'd1' } as SourceManifest)).rejects.toThrow()
    const scene = entries.find((e) => e.key === 'seeContext')
    expect(scene).toMatchObject({ channel: 'desktop', ok: false })
    expect(JSON.stringify(scene?.fields)).toContain('template')
    expect(JSON.stringify(scene?.fields)).toContain('稍后再说')
  })

  /**
   * **成功的那一趟同样要留现场。** 弹窗是这条链路上最典型的"成功了但不对劲"：广告框被关掉、
   * recipe 照常跑完、结果一切正常，于是没有人知道每一轮都要先关一次广告。只在 drift 路径上
   * 记，等于这件事永远看不见——而 `recordSeeContext` 的 `ok` 形参本来就是为这一档留的。
   */
  it('kind:desktop 成功但消化过打断 → 现场照记，ok 是 true', async () => {
    const entries: DebugEntry[] = []
    const a = new ReplayAdapter(deps({
      recipes: { load: () => ({ version: 1, kind: 'desktop', sourceId: 'd1' }) as unknown as Recipe },
      desktopDriver: () => ({}) as never,
      runDesktop: (async () => ({
        outcome: 'ok',
        items: [],
        driftReason: null,
        seeVia: { '发送按钮': 'template' },
        dismissed: ['{"text":"稍后再说"}'],
      })) as never,
      onDebug: (e) => entries.push(e),
    }))
    await a.fetch({}, { id: 'd1' } as SourceManifest)
    const scene = entries.find((e) => e.key === 'seeContext')
    expect(scene).toMatchObject({ channel: 'desktop', ok: true })
    expect(JSON.stringify(scene?.fields)).toContain('稍后再说')
  })

  // 反例：成功且整趟没用过 see 的普通桌面 recipe 不该因此多出一条空现场（每轮都记 = 噪音）。
  it('kind:desktop 成功但整趟没用过 see → 不记那条现场', async () => {
    const entries: DebugEntry[] = []
    const a = new ReplayAdapter(deps({
      recipes: { load: () => ({ version: 1, kind: 'desktop', sourceId: 'd1' }) as unknown as Recipe },
      desktopDriver: () => ({}) as never,
      runDesktop: (async () => ({ outcome: 'ok', items: [], driftReason: null })) as never,
      onDebug: (e) => entries.push(e),
    }))
    await a.fetch({}, { id: 'd1' } as SourceManifest)
    expect(entries.filter((e) => e.key === 'seeContext')).toHaveLength(0)
  })

  // 反例：没用 `see` 的 recipe drift 时不该多出一条空现场——每一条 debug 条目都要有信息量，
  // 否则这个频道会被"什么都没有"淹掉，真正的现场反而看不见。
  it('kind:desktop drift 但整趟没用过 see → 不记那条现场', async () => {
    const entries: DebugEntry[] = []
    const a = new ReplayAdapter(deps({
      recipes: { load: () => ({ version: 1, kind: 'desktop', sourceId: 'd1' }) as unknown as Recipe },
      desktopDriver: () => ({}) as never,
      runDesktop: (async () => ({ outcome: 'drift', items: [], driftReason: '窗口没找到' })) as never,
      onDebug: (e) => entries.push(e),
    }))
    await expect(a.fetch({}, { id: 'd1' } as SourceManifest)).rejects.toThrow()
    expect(entries.filter((e) => e.key === 'seeContext')).toHaveLength(0)
  })

  it('kind:desktop 没有 Stream Desktop 时 decline，同样带 authoritative:false', async () => {
    const a = new ReplayAdapter(deps({
      recipes: { load: () => ({ version: 1, kind: 'desktop', sourceId: 'd1' }) as unknown as Recipe },
      desktopDriver: () => undefined,
    }))
    expect(await a.fetch({}, MANIFEST)).toEqual({ items: [], authoritative: false })
  })

  // I2：会话租约排队超时的 decline 之前和"这个源本来就没有新内容"一模一样——不记 health、
  // 不进 debug 通道。现在要往 debug bus 记一条（channel host-agent），源数量多、单趟耗时长
  // 逼近 sessionWaitMs 时才有得查，不然只能凭空猜。
  it('kind:desktop 会话租约排队超时 → decline 且往 debug bus 记一条 host-agent 频道的条目', async () => {
    const entries: DebugEntry[] = []
    const a = new ReplayAdapter(deps({
      recipes: { load: () => ({ version: 1, kind: 'desktop', sourceId: 'd1' }) as unknown as Recipe },
      desktopDriver: () => ({}) as never,
      runDesktop: async () => { throw new HostSessionQueueTimeout() },
      onDebug: (e) => entries.push(e),
    }))
    expect(await a.fetch({}, { id: 'd1' } as SourceManifest)).toEqual({ items: [], authoritative: false })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ channel: 'desktop', key: 'sessionQueueTimeout', ok: false })
    expect(entries[0].summary).toContain('d1')
  })

  // 反例：agent 断线/op 超时这两种走的是不同诊断方向（agent 本身不健康），不该跟排队超时
  // 混进同一条 debug entry——否则"该等"和"该查 agent"就分不开了。
  it('kind:desktop agent 断线时 decline，但不记 sessionQueueTimeout 那条 debug entry', async () => {
    const entries: DebugEntry[] = []
    const a = new ReplayAdapter(deps({
      recipes: { load: () => ({ version: 1, kind: 'desktop', sourceId: 'd1' }) as unknown as Recipe },
      desktopDriver: () => ({}) as never,
      runDesktop: async () => { throw new HostRelayDisconnected() },
      onDebug: (e) => entries.push(e),
    }))
    expect(await a.fetch({}, MANIFEST)).toEqual({ items: [], authoritative: false })
    expect(entries).toHaveLength(0)
  })

  // 用户按热键叫停 → 和"这个源这轮没有新内容"同样收场。**不记 drift、不隔离**：用户叫停
  // 不是 recipe 坏了，隔离会让一次手动干预连累这个源之后的每一轮。
  it('kind:desktop 用户中止 → decline，且不记 drift（更不会隔离这个源）', async () => {
    const drifts: string[] = []
    const entries: DebugEntry[] = []
    const a = new ReplayAdapter(deps({
      recipes: { load: () => ({ version: 1, kind: 'desktop', sourceId: 'd1' }) as unknown as Recipe },
      desktopDriver: () => ({}) as never,
      runDesktop: async () => { throw new HostAbortedByUser('user-hotkey') },
      ledger: {
        shouldRun: () => true,
        recordDrift: (id: string) => { drifts.push(id); return { status: 'ok' } },
        recordSuccess: () => {},
      } as never,
      onDebug: (e) => entries.push(e),
    }))
    expect(await a.fetch({}, { id: 'd1' } as SourceManifest)).toEqual({ items: [], authoritative: false })
    expect(drifts).toEqual([])
    expect(entries).toHaveLength(0)
  })

  it('confirms the browser EVERY round, runs the recipe, and returns DataItem-shaped raw', async () => {
    let ensureCount = 0
    const a = new ReplayAdapter(deps({ ensureTransport: async () => { ensureCount++ } }))
    const items = (await a.fetch({ query: 'x' }, MANIFEST)) as Array<Record<string, unknown>>
    await a.fetch({ query: 'y' }, MANIFEST)
    // 每轮都确认，不 memo：浏览器是用户的，上一轮在不代表这一轮还在。
    expect(ensureCount).toBe(2)
    expect(items[0]).toMatchObject({ title: 'A', link: 'http://a', guid: 'http://a', author: 'u' })
  })

  it("passes the recipe's cookieDomain (and its broker cookie) to makeLauncher", async () => {
    const seen: Array<{ cookieHeader?: string; cookieDomain?: string }> = []
    const a = new ReplayAdapter(deps({
      cookieFor: async () => 'sess=abc',
      makeLauncher: (opts) => { seen.push(opts); return fakeLauncher() },
    }))
    await a.fetch({ query: 'x' }, MANIFEST)
    // cookieDomain 是空串时传 undefined（"没有域"而不是"域是空字符串"）
    expect(seen[0]).toEqual({ cookieHeader: 'sess=abc', cookieDomain: RECIPE.cookieDomain || undefined })
  })

  it('runs ensureTransport BEFORE building the launcher', async () => {
    const order: string[] = []
    const a = new ReplayAdapter(deps({
      ensureTransport: async () => { order.push('ensure') },
      makeLauncher: () => { order.push('launcher'); return fakeLauncher() },
    }))
    await a.fetch({ query: 'x' }, MANIFEST)
    // 顺序是承重的：launcher 一拿到就去开 tab，浏览器必须在那之前已经确认活着。
    expect(order).toEqual(['ensure', 'launcher'])
  })

  it('lets ensureTransport abort the run before any tab is opened (browser unreachable)', async () => {
    let launched = false
    const a = new ReplayAdapter(deps({
      ensureTransport: async () => { throw new EnvironmentUnavailableError('relay down') },
      makeLauncher: () => { launched = true; return fakeLauncher() },
    }))
    await expect(a.fetch({ query: 'x' }, MANIFEST)).rejects.toBeInstanceOf(EnvironmentUnavailableError)
    expect(launched).toBe(false)
  })

  it('lets a facility session execute a recipe without going through the legacy launcher path', async () => {
    let ensured = false
    let launched = false
    const a = new ReplayAdapter(deps({
      ensureTransport: async () => { ensured = true },
      makeLauncher: () => { launched = true; return fakeLauncher() },
      sessionFetch: async (_recipe, params, manifest) => {
        expect(params).toEqual({ keyword: '露营' })
        expect(manifest.id).toBe('replay-hn')
        return [{ title: 'Shadow', link: 'https://x.test/n1' }]
      },
    }))
    expect(await a.fetch({ keyword: '露营' }, MANIFEST)).toEqual([
      expect.objectContaining({ title: 'Shadow', guid: 'https://x.test/n1' }),
    ])
    expect(ensured).toBe(false)
    expect(launched).toBe(false)
  })

  it('a quarantined source declines without launching (ledger.shouldRun=false)', async () => {
    let launched = false
    const a = new ReplayAdapter(deps({
      makeLauncher: () => { launched = true; return fakeLauncher() },
      ledger: { shouldRun: () => false } as unknown as import('../../replay/repair-ledger.ts').RepairLedger,
    }))
    expect(await a.fetch({ query: 'x' }, MANIFEST)).toEqual({ items: [], authoritative: false })
    expect(launched).toBe(false)
  })

  it('classifies a session outcome into typed source errors', async () => {
    const { sessionOutcomeToItems } = await import('./adapter.ts')
    const { RecipeBlockedError } = await import('../../replay/session-recipe-executor.ts')
    const { ReplayDriftError } = await import('../../replay/interpret.ts')
    const base = { items: [{ guid: 'n1' }], trace: [] }
    expect(sessionOutcomeToItems({ outcome: 'ok', ...base }, 's1')).toEqual([{ guid: 'n1' }])
    expect(() => sessionOutcomeToItems({ outcome: 'needsLogin', ...base }, 's1')).toThrow(NeedsLoginError)
    expect(() => sessionOutcomeToItems({ outcome: 'drift', ...base, reason: 'shape moved' }, 's1')).toThrow(ReplayDriftError)
    expect(() => sessionOutcomeToItems({ outcome: 'blocked', ...base, reason: 'wall' }, 's1')).toThrow(RecipeBlockedError)
  })

  it('records session-recipe drift to the ledger and requests repair on quarantine', async () => {
    const { ReplayDriftError } = await import('../../replay/interpret.ts')
    const drifts: string[] = []
    const repairs: string[] = []
    const a = new ReplayAdapter(deps({
      sessionFetch: async () => { throw new ReplayDriftError('note state shape moved', 0) },
      ledger: {
        shouldRun: () => true,
        recordDrift: (id: string) => { drifts.push(id); return { status: 'quarantined' } as never },
        recordSuccess: () => {},
      } as unknown as import('../../replay/repair-ledger.ts').RepairLedger,
      repairRunner: { requestRepair: async ({ sourceId }: { sourceId: string }) => { repairs.push(sourceId) } } as never,
    }))
    await expect(a.fetch({ query: 'x' }, MANIFEST)).rejects.toThrow(/shape moved/)
    expect(drifts).toEqual(['replay-hn'])
    expect(repairs).toEqual(['replay-hn'])
  })

  // 漂移那一刻问一次「这个源坏了会连累谁」，答案既落进账、也随修复请求送出去。
  // 缺了这条接线，账里那一格永远是空的，而空和「没人受连累」长得一模一样。
  it('把 affectedSources 一路带到账本和修复请求里', async () => {
    const { ReplayDriftError } = await import('../../replay/interpret.ts')
    const asked: string[] = []
    let recorded: readonly string[] | undefined
    let requested: string[] | undefined
    const a = new ReplayAdapter(deps({
      sessionFetch: async () => { throw new ReplayDriftError('note state shape moved', 0) },
      affectedSources: (id: string) => { asked.push(id); return [id, 'other/consumer'] },
      ledger: {
        shouldRun: () => true,
        recordDrift: (_id: string, _r: string, _v: number, affected?: readonly string[]) => {
          recorded = affected
          return { status: 'quarantined', affectedSources: affected && [...affected] } as never
        },
        recordSuccess: () => {},
      } as unknown as import('../../replay/repair-ledger.ts').RepairLedger,
      repairRunner: {
        requestRepair: async (job: { affectedSources?: string[] }) => { requested = job.affectedSources },
      } as never,
    }))
    await expect(a.fetch({ query: 'x' }, MANIFEST)).rejects.toThrow(/shape moved/)
    expect(asked).toEqual(['replay-hn'])
    expect(recorded).toEqual(['replay-hn', 'other/consumer'])
    expect(requested).toEqual(['replay-hn', 'other/consumer'])
  })

  // 诊断问不出来不该掀翻采集：漂移记录照记，只是「这一格没算过」。
  it('affectedSources 抛了也不影响漂移记账', async () => {
    const { ReplayDriftError } = await import('../../replay/interpret.ts')
    const drifts: string[] = []
    const a = new ReplayAdapter(deps({
      sessionFetch: async () => { throw new ReplayDriftError('note state shape moved', 0) },
      affectedSources: () => { throw new Error('ambiguous source id') },
      ledger: {
        shouldRun: () => true,
        recordDrift: (id: string) => { drifts.push(id); return { status: 'ok' } as never },
        recordSuccess: () => {},
      } as unknown as import('../../replay/repair-ledger.ts').RepairLedger,
    }))
    await expect(a.fetch({ query: 'x' }, MANIFEST)).rejects.toThrow(/shape moved/)
    expect(drifts).toEqual(['replay-hn'])
  })

  it('records drift to the ledger when the recipe throws ReplayDriftError', async () => {
    const drifts: Array<{ id: string; reason: string; v: number }> = []
    const driftLauncher: ReplayLauncher = {
      async launch() {
        const page: ReplayPage = { async evaluate() { return { status: 200, text: '{}' } as never } } // no hits → drift
        return { page, close: async () => {} }
      },
    }
    const a = new ReplayAdapter(deps({
      makeLauncher: () => driftLauncher,
      ledger: {
        shouldRun: () => true,
        recordDrift: (id: string, reason: string, v: number) => { drifts.push({ id, reason, v }); return {} as never },
        recordSuccess: () => {},
      } as unknown as import('../../replay/repair-ledger.ts').RepairLedger,
    }))
    await expect(a.fetch({ query: 'x' }, MANIFEST)).rejects.toThrow()
    expect(drifts).toHaveLength(1)
    expect(drifts[0]).toMatchObject({ id: 'replay-hn', v: 1 })
  })
})

// ── Tier-C dispatch ───────────────────────────────────────────────────────────

const RECIPE_C: BrowserRecipe = {
  version: 2, kind: 'browser', sourceId: 'replay-feed', cookieDomain: 'x.com', entryUrl: 'https://x.com/',
  loginCheck: { loggedIn: '.me', wall: '.login-wall' },
  actions: [{ kind: 'scroll', dwell_s: [1, 2], maxTimes: 3, noProgressStop: 2 }],
  harvest: { urlPattern: '*/feed*', dedupeBy: 'id', itemsAt: 'data', targetCount: 2, mapping: { title: 't' }, assert: [] },
}
const MANIFEST_C = { id: 'replay-feed' } as SourceManifest

function outcome(over: Partial<RunBrowserOutcome>): RunBrowserOutcome {
  return { outcome: 'ok', items: [], trace: [], seed: 42, driftReason: null, ...over }
}

describe('ReplayAdapter — tier C', () => {
  function depsC(runBrowser: ReplayAdapterDeps['runBrowser'], over: Partial<ReplayAdapterDeps> = {}): ReplayAdapterDeps {
    return deps({ recipes: { load: () => RECIPE_C }, runBrowser, ...over })
  }

  it('ok → items through toDataItem, recordSuccess called', async () => {
    let successes = 0
    const a = new ReplayAdapter(depsC(
      async () => outcome({ items: [{ title: 'A', url: 'http://a' }] }),
      {
        makeLauncher: () => fakeLauncher(),
        ledger: {
          shouldRun: () => true, recordSuccess: () => { successes++ }, recordDrift: () => ({}) as never,
        } as unknown as import('../../replay/repair-ledger.ts').RepairLedger,
      },
    ))
    const items = (await a.fetch({}, MANIFEST_C)) as Array<Record<string, unknown>>
    expect(items[0]).toMatchObject({ title: 'A', link: 'http://a', guid: 'http://a' })
    expect(successes).toBe(1)
  })

  it('drift → recordDrift with seed+trace context, ReplayDriftError thrown', async () => {
    const drifts: Array<{ id: string; reason: string; v: number }> = []
    const a = new ReplayAdapter(depsC(
      async () => outcome({ outcome: 'drift', driftReason: 'no response matched urlPattern' }),
      {
        ledger: {
          shouldRun: () => true,
          recordDrift: (id: string, reason: string, v: number) => { drifts.push({ id, reason, v }); return {} as never },
          recordSuccess: () => {},
        } as unknown as import('../../replay/repair-ledger.ts').RepairLedger,
      },
    ))
    await expect(a.fetch({}, MANIFEST_C)).rejects.toThrow(/no response matched/)
    expect(drifts).toHaveLength(1)
    expect(drifts[0].reason).toContain('no response matched urlPattern')
    expect(drifts[0].reason).toContain('seed=42')
    expect(drifts[0].v).toBe(2)
  })

  it('needsLogin → NeedsLoginError, ledger untouched', async () => {
    let driftCalls = 0
    let successCalls = 0
    const a = new ReplayAdapter(depsC(
      async () => outcome({ outcome: 'needsLogin' }),
      {
        ledger: {
          shouldRun: () => true,
          recordDrift: () => { driftCalls++; return {} as never },
          recordSuccess: () => { successCalls++ },
        } as unknown as import('../../replay/repair-ledger.ts').RepairLedger,
      },
    ))
    await expect(a.fetch({}, MANIFEST_C)).rejects.toThrow(NeedsLoginError)
    expect(driftCalls).toBe(0)
    expect(successCalls).toBe(0)
  })
})

// ── cookie 快路：没登录这件事，能不开 tab 就答出来 ───────────────────────────────────
//
// 会话 cookie 一个都不在 ⇒ 一定没登录。这时不该付「开 tab + 导航 + 等渲染」的钱去确认一件
// 已经确定的事——尤其在搜索这种多源并发的场景里，用户等的是别的源的结果。
describe('ReplayAdapter — session precheck (cookie fast path)', () => {
  const SESSION_MANIFEST = {
    id: 'replay-feed',
    auth: {
      type: 'session', facility: 'xhs', login: 'qr',
      loginUrl: 'https://x/explore', qrSelector: '.qr',
      cookieDomain: 'xiaohongshu.com', sessionCookies: ['web_session'],
    },
  } as unknown as SourceManifest

  function sessionDeps(over: Partial<ReplayAdapterDeps> = {}): ReplayAdapterDeps {
    return deps({ recipes: { load: () => RECIPE_C }, ...over })
  }

  it('declines WITHOUT opening a tab when the session cookie is gone', async () => {
    let sessionFetchCalls = 0
    const a = new ReplayAdapter(sessionDeps({
      cookieNames: async () => ['a1', 'webId'],           // web_session 不在
      sessionFetch: async () => { sessionFetchCalls++; return [] },
    }))
    await expect(a.fetch({}, SESSION_MANIFEST)).rejects.toThrow(NeedsLoginError)
    expect(sessionFetchCalls).toBe(0)                      // 关键：一个 tab 都没开
  })

  it('proceeds normally when a session cookie is present (cookie can never say "yes")', async () => {
    let sessionFetchCalls = 0
    const a = new ReplayAdapter(sessionDeps({
      cookieNames: async () => ['web_session'],
      sessionFetch: async () => { sessionFetchCalls++; return [{ title: 'A', url: 'http://a' }] },
    }))
    expect(await a.fetch({}, SESSION_MANIFEST)).toEqual([
      expect.objectContaining({ title: 'A' }),
    ])
    expect(sessionFetchCalls).toBe(1)                      // 权威判断仍在页面上
  })

  it('proceeds when the cookie lookup fails — an outage is not a logout', async () => {
    // 扩展没连的时候答案是「不知道」。判成没登录，会在用户关一晚电脑之后把好好的源全报成掉线。
    let sessionFetchCalls = 0
    const a = new ReplayAdapter(sessionDeps({
      cookieNames: async () => { throw new Error('ext relay disconnected') },
      sessionFetch: async () => { sessionFetchCalls++; return [] },
    }))
    await a.fetch({}, SESSION_MANIFEST)
    expect(sessionFetchCalls).toBe(1)
  })

  it('skips the fast path entirely for a source that declares no session cookies', async () => {
    let cookieLookups = 0
    let sessionFetchCalls = 0
    const a = new ReplayAdapter(sessionDeps({
      cookieNames: async () => { cookieLookups++; return [] },
      sessionFetch: async () => { sessionFetchCalls++; return [] },
    }))
    await a.fetch({}, MANIFEST_C)                          // 没有 auth 声明
    expect(cookieLookups).toBe(0)
    expect(sessionFetchCalls).toBe(1)
  })
})
