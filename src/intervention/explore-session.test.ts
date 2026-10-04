import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as acp from '@agentclientprotocol/sdk'
import { InterventionRunStore } from './run-store.ts'
import { ExploreSession, type ExploreSessionDeps } from './explore-session.ts'
import { StateGraphStore } from '../replay/state-graph-store.ts'
import { ObservationLedger } from '../replay/observation-ledger.ts'
import { scriptedAgent, inProcess, type Turn } from './__fixtures__/scripted-agent.ts'
import type { ExploreSurface } from './explore-surface.ts'
import type { InventoryItem } from './explore-graph.ts'
import type { StateGraph } from '../replay/state-graph.ts'
import type { EventInput } from '../events/store.ts'
import type { RunEvent } from './types.ts'

/** 三页假站：home →（点 1）→ search（可退回）；home →（点 2）→ post（退不回）；点 3 没变化。 */
function fakeSurface(): ExploreSurface {
  let page: 'home' | 'search' | 'post' = 'home'
  const items: Record<'home' | 'search' | 'post', InventoryItem[]> = {
    home: [
      { n: 1, tag: 'a', href: '/search', rect: { x: 0, y: 0, w: 1, h: 1 } },
      { n: 2, tag: 'button', name: '发布', rect: { x: 0, y: 0, w: 1, h: 1 } },
      { n: 3, tag: 'button', name: '刷新', rect: { x: 0, y: 0, w: 1, h: 1 } },
    ],
    search: [{ n: 9, tag: 'a', href: '/home', rect: { x: 0, y: 0, w: 1, h: 1 } }],
    post: [],
  }
  const urls = { home: 'https://a.example/home', search: 'https://a.example/search', post: 'https://a.example/post' }
  return {
    side: 'browser',
    url: async () => urls[page],
    inventory: async () => items[page],
    exists: async () => false,
    click: async (ref) => {
      if (page === 'home' && ref === 1) page = 'search'
      else if (page === 'home' && ref === 2) page = 'post'
      return true
    },
    back: async () => { if (page === 'search') page = 'home' },
    settle: async () => ({ settled: true, waitedMs: 0 }),
    scene: async () => ({ side: 'browser', url: urls[page], elements: items[page].map((i) => ({ n: i.n, ...(i.name ? { name: i.name } : {}), rect: i.rect })) }),
    perceptionDriver: () => ({ currentUrl: async () => urls[page], exists: async () => false }),
  }
}

/**
 * home 上多一个「搜索」按钮，但它**只灵一次**——第二次点纹丝不动。
 * 用来造出「判完效果重放不回去」那一档：`to` 是 a/search，而人实际留在 a/home。
 */
function flakyButtonSurface(): ExploreSurface {
  let page: 'home' | 'search' = 'home'
  let buttonLeft = 1
  const items: Record<'home' | 'search', InventoryItem[]> = {
    home: [
      { n: 1, tag: 'a', href: '/search', rect: { x: 0, y: 0, w: 1, h: 1 } },
      { n: 4, tag: 'button', name: '搜索', rect: { x: 0, y: 0, w: 1, h: 1 } },
    ],
    search: [{ n: 9, tag: 'a', href: '/home', rect: { x: 0, y: 0, w: 1, h: 1 } }],
  }
  const urls = { home: 'https://a.example/home', search: 'https://a.example/search' }
  return {
    side: 'browser',
    url: async () => urls[page],
    inventory: async () => items[page],
    exists: async () => false,
    click: async (ref) => {
      if (page !== 'home') return true
      if (ref === 1) { page = 'search'; return true }
      if (ref === 4) { if (buttonLeft-- <= 0) return false; page = 'search'; return true }
      return true
    },
    back: async () => { if (page === 'search') page = 'home' },
    settle: async () => ({ settled: true, waitedMs: 0 }),
    scene: async () => ({ side: 'browser', url: urls[page], elements: [] }),
    perceptionDriver: () => ({ currentUrl: async () => urls[page], exists: async () => false }),
  }
}

/** 退回之后落在一个图里没有的屏上——`identify` 认不出，`back()` 该回 unknown。 */
function backToLimboSurface(): ExploreSurface {
  let page: 'home' | 'limbo' = 'home'
  const urls = { home: 'https://a.example/home', limbo: 'https://a.example/limbo' }
  return {
    side: 'browser',
    url: async () => urls[page],
    inventory: async () => (page === 'home' ? [{ n: 1, tag: 'a', href: '/search', rect: { x: 0, y: 0, w: 1, h: 1 } }] : []),
    exists: async () => false,
    click: async () => true,
    back: async () => { page = 'limbo' },
    settle: async () => ({ settled: true, waitedMs: 0 }),
    scene: async () => ({ side: 'browser', url: urls[page], elements: [] }),
    perceptionDriver: () => ({ currentUrl: async () => urls[page], exists: async () => false }),
  }
}

/**
 * 点一下只开一个面板：**URL 一个字不变**（活体 xhs 的搜索面板就是这样）。
 * `identify` 这时仍然认成 from，我们判 noop——而它其实是一屏新东西。
 */
function domOnlySurface(): ExploreSurface {
  let open = false
  const exists = async (sel: string): Promise<boolean> => sel === '.panel' && open
  return {
    side: 'browser',
    url: async () => 'https://a.example/home',
    inventory: async () => [{ n: 1, tag: 'button', name: '搜索', rect: { x: 0, y: 0, w: 1, h: 1 } }],
    exists,
    click: async () => { open = true; return true },
    back: async () => { open = false },
    settle: async () => ({ settled: true, waitedMs: 0 }),
    scene: async () => ({ side: 'browser', url: 'https://a.example/home', elements: [] }),
    perceptionDriver: () => ({ currentUrl: async () => 'https://a.example/home', exists }),
  }
}

/**
 * 点了之后**过一会儿**才真跳（导航是异步的）。`settle` 之前认，认到的是跳之前那一屏。
 * 活体 xhs：点侧栏「点点ai」确实跳到了 `/ai_chat`，而我们在 `/explore` 上判了 noop。
 */
function slowNavSurface(delayMs = 200, neverSettles = false) {
  let page: 'home' | 'chat' = 'home'
  const urls = { home: 'https://a.example/home', chat: 'https://a.example/chat' }
  let settleCalls = 0
  const s: ExploreSurface = {
    side: 'browser',
    url: async () => urls[page],
    inventory: async () => (page === 'home' ? [{ n: 1, tag: 'a', href: '/chat', rect: { x: 0, y: 0, w: 1, h: 1 } }] : []),
    exists: async () => false,
    // 点击立刻返回，导航 delayMs 之后才发生——真实浏览器就是这样
    click: async () => { setTimeout(() => { page = 'chat' }, delayMs); return true },
    back: async () => { page = 'home' },
    settle: async () => {
      settleCalls++
      await new Promise((r) => setTimeout(r, delayMs + 50))
      // `neverSettles` 那一档模拟「等到上限还在动」：回执如实说没稳
      return neverSettles ? { settled: false, waitedMs: 3000 } : { settled: true, waitedMs: delayMs + 50 }
    },
    scene: async () => ({ side: 'browser', url: urls[page], elements: [] }),
    perceptionDriver: () => ({ currentUrl: async () => urls[page], exists: async () => false }),
  }
  return { surface: s, settleCalls: () => settleCalls }
}

const limits = { turns: 20, tokens: 1_000_000, wallMs: 60_000 }
/** 第一轮故意慢一点：测试要在同一条 run 还活着的时候替 agent 把图探完（基类的 turn 是真异步的）。 */
const slowTurns = (ms = 200): Turn[] => [
  async () => { await new Promise((r) => setTimeout(r, ms)); return { stopReason: 'end_turn' } },
]

/** Cloudflare Turnstile 那一屏：URL 和首页一模一样（同源返回），只有 DOM 多了 widget。 */
function cfSurface(extra: (sel: string) => boolean): ExploreSurface {
  const s = fakeSurface()
  return { ...s, exists: async (sel) => extra(sel), perceptionDriver: () => ({ currentUrl: s.url, exists: async (sel) => extra(sel) }) }
}

function harness(
  turns: Turn[] = slowTurns(),
  llmRefs: number[] | 'unavailable' = [],
  over: { surface?: ExploreSurface; authored?: StateGraph; limits?: typeof limits } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'explore-'))
  const store = new InterventionRunStore(':memory:')
  const notes: EventInput[] = []
  const graphs = new StateGraphStore(join(dir, 'learned'), () => over.authored)
  const surface = over.surface ?? fakeSurface()
  const deps: ExploreSessionDeps = {
    store,
    notify: (e) => notes.push(e),
    log: () => {},
    openAgent: inProcess(scriptedAgent(turns).app),
    mcpEndpoint: () => undefined,
    mcpToolNames: () => ['graph_frontier', 'graph_act', 'graph_record_state', 'graph_back', 'graph_mark_irrelevant', 'cdp_look'],
    workRoot: join(dir, 'work'),
    idleTimeoutMs: 60_000,
    draftDir: join(dir, 'drafts'),
    surface: () => surface,
    graphs,
    observations: new ObservationLedger(join(dir, 'obs')),
    llm: () => (llmRefs === 'unavailable'
      ? undefined
      : (async () => ({ content: JSON.stringify({ refs: llmRefs, rationale: 'x' }), raw: {} })) as unknown as NonNullable<ReturnType<ExploreSessionDeps['llm']>>),
  }
  const s = new ExploreSession(deps, {
    facility: 'a', sourceId: 'a-home', target: 'chrome:1', goal: '到搜索页',
    config: { command: { command: 'x', args: [] }, limits: over.limits ?? limits },
    limits: { maxStates: 60, maxDepth: 8 },
  })
  return { s, store, notes, graphs, deps }
}

const HOME = { kind: 'url' as const, pattern: 'https://a.example/home*' }
const SEARCH = { kind: 'url' as const, pattern: 'https://a.example/search*' }
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('ExploreSession', () => {
  it('起步：当前屏没认出 → frontier 回 state:null 且 items 空；起名过闸后列出可点项、拉黑闸剔掉「发布」', async () => {
    const { s } = harness(slowTurns(), [2])
    void s.start()
    await settle(30)
    expect(await s.frontier()).toMatchObject({ state: null, items: [] })
    expect(await s.recordState({ id: 'a/home', features: [HOME] })).toEqual({ ok: true, stateId: 'a/home', edgeRecorded: false, replaced: false })
    const f = await s.frontier()
    expect(f.state).toBe('a/home')
    expect(f.items.map((i) => i.ref).sort()).toEqual([1, 3])
    expect(f.blocked).toBe(1)
    await s.cancel()
  })

  it('act：noop / unknown（起名后自动补边）/ reversible（自动补反边）', async () => {
    const { s } = harness()
    void s.start()
    await settle(30)
    await s.recordState({ id: 'a/home', features: [HOME] })
    await s.frontier()
    expect(await s.act(3)).toMatchObject({ from: 'a/home', to: 'unchanged', effect: 'noop', edgeRecorded: false, at: 'a/home' })
    expect(await s.act(1)).toMatchObject({ from: 'a/home', to: 'unknown', edgeRecorded: false, at: 'unknown' })
    expect(await s.recordState({ id: 'a/search', features: [SEARCH] })).toMatchObject({ ok: true })
    // 起名之后自动判效果：退一次能回 home → reversible（判完人被送回 a/search，见下一条用例）
    // 退到刚才那一格 → how:'edge'，并且**把它消费掉**：再退一次就不该还报 edge
    expect(await s.back()).toMatchObject({ at: 'a/home', how: 'edge' })
    expect(await s.back()).toMatchObject({ at: 'a/home', how: 'browser-back' })
    const draft = s.draftSnapshot()
    expect(draft.transitions.map((t) => [t.from, t.to, t.effect])).toEqual(
      expect.arrayContaining([['a/home', 'a/search', 'reversible'], ['a/search', 'a/home', 'reversible']]),
    )
    await s.cancel()
  })

  it('点了收不回的那一屏没过拉黑闸（没配运行时模型）→ 整屏冻结，不探', async () => {
    const { s } = harness(slowTurns(), 'unavailable')
    void s.start()
    await settle(30)
    await s.recordState({ id: 'a/home', features: [HOME] })
    const f = await s.frontier()
    expect(f.items).toEqual([])
    expect(s.draftSnapshot().frozen).toEqual(['a/home'])
    await s.cancel()
  })

  it('id 不带前缀 / 特征不是网页面的 / 与已知状态撞 → 拒且说清', async () => {
    const { s } = harness()
    void s.start()
    await settle(30)
    expect(await s.recordState({ id: 'home', features: [{ kind: 'url', pattern: 'x' }] })).toMatchObject({ ok: false, reason: 'bad-id' })
    expect(await s.recordState({ id: 'a/home', features: [{ kind: 'text', text: 'x' }] })).toMatchObject({ ok: false, reason: 'bad-feature' })
    expect(await s.recordState({ id: 'a/home', features: [] })).toMatchObject({ ok: false, reason: 'bad-feature' })
    // 起的名字在当前屏上不成立 → 拒（起了名却认不出，frontier 永远列不出来）
    expect(await s.recordState({ id: 'a/elsewhere', features: [SEARCH] })).toMatchObject({ ok: false, reason: 'bad-feature' })
    await s.recordState({ id: 'a/home', features: [HOME] })
    // 同一个 id 再来一次是**改特征**（见下面那条用例），但新的一组仍得在当前屏上成立
    expect(await s.recordState({ id: 'a/home', features: [{ kind: 'url', pattern: 'y' }] })).toMatchObject({ ok: false, reason: 'bad-feature' })
    await s.cancel()
  })

  it('markIrrelevant：没起过名的状态拒；标过之后不再展开', async () => {
    const { s } = harness()
    void s.start()
    await settle(30)
    expect(s.markIrrelevant('a/nope')).toEqual({ ok: false })
    await s.recordState({ id: 'a/home', features: [HOME] })
    expect(s.markIrrelevant('a/home')).toEqual({ ok: true })
    expect((await s.frontier()).items).toEqual([])
    await s.cancel()
  })

  it('frontier 耗尽 → 交 graph 提议、停成 proposal/frontier-exhausted', async () => {
    // 全拉黑 1、2：home 的 frontier 只剩 3（noop），点完就探尽了
    const { s, store, notes } = harness(slowTurns(120), [1, 2])
    void s.start()
    await settle(30)
    await s.recordState({ id: 'a/home', features: [HOME] })
    await s.frontier()
    await s.act(3)
    expect((await s.frontier()).exhausted).toBe(true)
    await settle(400)
    const run = store.get(s.runId)!
    expect(run.stopped).toEqual({ produced: 'proposal', reason: 'frontier-exhausted' })
    const p = store.proposals({ runId: s.runId })[0]!
    expect(p.kind).toBe('graph')
    expect((p.draft as { states: unknown[] }).states).toHaveLength(1)
    expect(notes.some((n) => n.type === 'intervention.proposal')).toBe(true)
  })

  it('可逆边判完人停在 to（否则 to 成孤儿）；有可逆边照样走得到 exhausted', async () => {
    const { s } = harness(slowTurns(1000), [2])   // 拉黑「发布」，home 只剩 1、3
    void s.start()
    await settle(30)
    await s.recordState({ id: 'a/home', features: [HOME] })
    await s.frontier()
    await s.act(1)
    await s.recordState({ id: 'a/search', features: [SEARCH] })
    // 判可逆时人被送回过 home，判完必须再点回来——不然 a/search 永远没人能到，它的 frontier 一次都列不出来
    const atSearch = await s.frontier()
    expect(atSearch.state).toBe('a/search')
    // 回执里的 at = 此刻在哪（这一档等于 to）；noop 那一档 at 留在 from
    expect(await s.act(9)).toMatchObject({ from: 'a/search', to: 'unchanged', at: 'a/search' })
    expect((await s.frontier()).exhausted).toBe(false)   // home 还剩 ref 3
    expect(await s.back()).toMatchObject({ at: 'a/home' })
    await s.act(3)
    expect((await s.frontier()).exhausted).toBe(true)
    await s.cancel()
  })

  it('回执的 at 说的是「人此刻在哪」，不是 to：重放没回去时如实回 from 并在事件里说清', async () => {
    const { s, store } = harness(slowTurns(1000), [], { surface: flakyButtonSurface() })
    void s.start()
    await settle(30)
    await s.recordState({ id: 'a/home', features: [HOME] })
    await s.frontier()
    await s.act(1)
    await s.recordState({ id: 'a/search', features: [SEARCH] })   // 这一步把 a/search 认进草稿
    await s.back()
    await s.frontier()
    // 「搜索」按钮只灵一次：去得了 a/search、判完退回 home 之后重放却点不动
    const r = await s.act(4)
    expect(r).toMatchObject({ from: 'a/home', to: 'a/search', effect: 'reversible', edgeRecorded: true, at: 'a/home' })
    expect(store.events(s.runId).some((e: RunEvent) => e.title.includes('重放那一步没回到'))).toBe(true)
    await s.cancel()
  })

  it('识别的优先级：死路 > 全局/包自带 > 本次草稿（同一个 URL 上的 CF 拦截页不能被草稿吞掉）', async () => {
    const authored: StateGraph = {
      states: [{ id: 'a/blocked', group: 'wall', deadEnd: '站点把这个出口封了', features: [{ kind: 'dom', selector: '.dead' }] }],
      transitions: [],
    }
    // 这一屏同时命中三条：内置 cf/turnstile（dom）、包自带的死路（dom）、草稿里的 a/home（url）
    const surface = cfSurface((sel) => sel.includes('cf-turnstile') || sel === '.dead')
    const { s } = harness(slowTurns(1000), [], { surface, authored })
    void s.start()
    await settle(30)
    expect(await s.recordState({ id: 'a/home', features: [HOME] })).toMatchObject({ ok: true })
    expect(await s.back()).toMatchObject({ at: 'a/blocked' })
    await s.cancel()
  })

  it('内置全局那层也在 known 里：CF 挑战页不会被当成「没见过的新屏」', async () => {
    const surface = cfSurface((sel) => sel.includes('cf-turnstile'))
    const { s } = harness(slowTurns(1000), [], { surface })
    void s.start()
    await settle(30)
    // 图里一个自己的状态都没有，但内置那三档认得出这一屏 → 不是 unknown
    expect(await s.back()).toMatchObject({ at: 'cf/turnstile' })
    await s.cancel()
  })

  it('死路上一条边都不落：frontier 空 + 说清理由，act 直接拒，known() 不被毒死', async () => {
    // 这一屏命中内置的 cf/banned（死路）。落一条以它为 from 的边之后，assembleGraph 会永远抛
    // 「已声明为死路，不该再有出口」——每一次 identify 都炸，run 再也回不来。
    const surface = cfSurface((sel) => sel.includes('cf-error'))
    const { s, store } = harness(slowTurns(1000), [], { surface })
    void s.start()
    await settle(30)
    const f = await s.frontier()
    expect(f.state).toBe('cf/banned')
    expect(f.items).toEqual([])
    expect(store.events(s.runId).some((e: RunEvent) => e.title.includes('是死路'))).toBe(true)
    await expect(s.act(1)).rejects.toThrow(/死路上不能点/)
    expect(s.draftSnapshot().transitions).toEqual([])
    // 图还认得出这一屏 = known() 没被毒死
    expect(await s.back()).toMatchObject({ at: 'cf/banned' })
    await s.cancel()
  })

  it('不经 frontier 直接 act：拉黑闸照样过一遍（拉黑的 ref 拒；没过闸的屏整个拒）', async () => {
    const { s } = harness(slowTurns(1000), [2])   // 模型说 #2「发布」点了收不回
    void s.start()
    await settle(30)
    await s.recordState({ id: 'a/home', features: [HOME] })
    // agent 用允许的 cdp_look({inventory:true}) 自己拿到编号，直接 act——不调 frontier
    await expect(s.act(2)).rejects.toThrow(/不在 a\/home 的 frontier 里/)
    expect(s.draftSnapshot().transitions).toEqual([])
    expect(await s.act(3)).toMatchObject({ from: 'a/home', effect: 'noop' })   // 没被拉黑的照旧能点
    await s.cancel()
  })

  it('没过拉黑闸（没配模型）的那一屏：直接 act 也点不动', async () => {
    const { s } = harness(slowTurns(1000), 'unavailable')
    void s.start()
    await settle(30)
    await s.recordState({ id: 'a/home', features: [HOME] })
    await expect(s.act(1)).rejects.toThrow(/没过拉黑闸/)
    expect(s.draftSnapshot().transitions).toEqual([])
    await s.cancel()
  })

  it('取消也要交图：草稿非空 → 落一条 graph 提议，stopped.produced 是 proposal', async () => {
    const { s, store } = harness(slowTurns(1000), [])
    void s.start()
    await settle(30)
    await s.recordState({ id: 'a/home', features: [HOME] })
    await s.cancel()
    const p = store.proposals({ runId: s.runId })
    expect(p).toHaveLength(1)
    expect(p[0]).toMatchObject({ kind: 'graph', status: 'pending' })
    expect(store.get(s.runId)!.stopped).toEqual({ produced: 'proposal', reason: 'cancelled' })
  })

  it('草稿为空时取消 → 没有提议，produced 是 nothing（不交一份空图）', async () => {
    const { s, store } = harness(slowTurns(1000), [])
    void s.start()
    await settle(30)
    await s.cancel()
    expect(store.proposals({ runId: s.runId })).toHaveLength(0)
    expect(store.get(s.runId)!.stopped).toEqual({ produced: 'nothing', reason: 'cancelled' })
  })

  it('撞闸也要交图：turns 闸撞上 → proposal / gate:turns，不是 paused', async () => {
    // 闸设成 1 轮：第一轮结束就撞。那一轮故意慢一点，好让我们在它结束前先探到一个状态。
    const { s, store } = harness(slowTurns(300), [], { limits: { turns: 1, tokens: 1_000_000, wallMs: 60_000 } })
    void s.start()
    await settle(30)
    await s.recordState({ id: 'a/home', features: [HOME] })
    await settle(500)
    const run = store.get(s.runId)!
    expect(run.stopped).toEqual({ produced: 'proposal', reason: 'gate:turns' })
    expect(store.proposals({ runId: s.runId })).toHaveLength(1)
  })

  it('back 退到一个认不出的屏 → at:unknown 且 current 清空，下一步 act 说「先起名」', async () => {
    const { s } = harness(slowTurns(1000), [], { surface: backToLimboSurface() })
    void s.start()
    await settle(30)
    await s.recordState({ id: 'a/home', features: [HOME] })
    expect(await s.back()).toMatchObject({ at: 'unknown', how: 'none' })
    // 不清 current 的话，下一步会照着一屏我们其实已经不在的元素去点，而每一步回执都正常
    await expect(s.act(1)).rejects.toThrow(/当前屏还没认出/)
    await s.cancel()
  })

  it('点了只改 DOM 不改 URL：先判成死键，起名之后把那条边补上（活体 xhs 搜索面板）', async () => {
    const { s } = harness(slowTurns(1000), [], { surface: domOnlySurface() })
    void s.start()
    await settle(30)
    await s.recordState({ id: 'a/home', features: [HOME] })
    await s.frontier()
    expect(await s.act(1)).toMatchObject({ to: 'unchanged', effect: 'noop', edgeRecorded: false })
    // agent 看出这一屏其实变了，用 dom 特征给它起名 —— 这条边必须补上，否则两个状态之间没有路
    expect(await s.recordState({ id: 'a/panel', features: [{ kind: 'dom', selector: '.panel' }] }))
      .toMatchObject({ ok: true, stateId: 'a/panel', edgeRecorded: true })
    expect(s.draftSnapshot().transitions.map((t) => [t.from, t.to, t.effect]))
      .toEqual(expect.arrayContaining([['a/home', 'a/panel', 'reversible']]))
    await s.cancel()
  })

  it('补边只补紧接着那一下：中间插了 frontier / act 就作废，不给自己连自环', async () => {
    const { s } = harness(slowTurns(1000), [], { surface: domOnlySurface() })
    void s.start()
    await settle(30)
    await s.recordState({ id: 'a/home', features: [HOME] })
    await s.frontier()
    await s.act(1)
    await s.frontier()          // 重新看了一眼这一屏 → 上一次 noop 的补边机会过期
    expect(await s.recordState({ id: 'a/panel', features: [{ kind: 'dom', selector: '.panel' }] }))
      .toMatchObject({ ok: true, edgeRecorded: false })
    expect(s.draftSnapshot().transitions).toEqual([])
    await s.cancel()
  })

  it('noop 之后退了一步：补边机会作废，别把「退到的这一屏」当成那一下点出来的', async () => {
    const { s } = harness(slowTurns(1000), [], { surface: domOnlySurface() })
    void s.start()
    await settle(30)
    await s.recordState({ id: 'a/home', features: [HOME] })
    await s.frontier()
    await s.act(1)                 // 点开面板，但 URL 没变 → 判成 noop，记下补边机会
    await s.back()                 // 退回去（面板关了）——那一下点击不通向接下来起名的这一屏
    expect(await s.recordState({ id: 'a/plain', features: [{ kind: 'dom', selector: '.panel', absent: true }] }))
      .toMatchObject({ ok: true, edgeRecorded: false })
    expect(s.draftSnapshot().transitions).toEqual([])
    await s.cancel()
  })

  it('点完先等这一屏停下来再认：导航晚 200ms 才发生，不能判成死键', async () => {
    const nav = slowNavSurface(200)
    const { s } = harness(slowTurns(2000), [], { surface: nav.surface })
    void s.start()
    await settle(30)
    await s.recordState({ id: 'a/home', features: [HOME] })
    await s.frontier()
    const r = await s.act(1)
    // 不等就认 → 判 noop（一条真实存在的路被永久标成死的，而回执看起来正常）
    expect(r).toMatchObject({ from: 'a/home', to: 'unknown', at: 'unknown' })
    expect(nav.settleCalls()).toBeGreaterThan(0)
    await s.cancel()
  })

  it('这一屏等到上限还在动：留一条痕再认（别让「等稳了认的」和「等烦了认的」长一样）', async () => {
    const nav = slowNavSurface(50, true)
    const { s, store } = harness(slowTurns(2000), [], { surface: nav.surface })
    void s.start()
    await settle(30)
    await s.recordState({ id: 'a/home', features: [HOME] })
    await s.frontier()
    const r = await s.act(1)
    expect(store.events(s.runId).some((e: RunEvent) => e.title.includes('还没停下来，按当前样子认'))).toBe(true)
    expect(r.from).toBe('a/home')   // 照认不误，只是留了痕
    await s.cancel()
  })

  it('自己起的名可以再改特征（太宽的 url 收紧成 dom）；包自带 / 学到的那两层仍然拒', async () => {
    const authored: StateGraph = {
      states: [{ id: 'a/authored', features: [{ kind: 'dom', selector: '.never' }] }],
      transitions: [],
    }
    const { s } = harness(slowTurns(1000), [], { surface: domOnlySurface(), authored })
    void s.start()
    await settle(30)
    expect(await s.recordState({ id: 'a/home', features: [HOME] })).toMatchObject({ ok: true, replaced: false })
    // 发现 url 太宽 → 同一个 id 换一组特征（当前屏上仍成立）
    const again = await s.recordState({ id: 'a/home', features: [HOME, { kind: 'dom', selector: '.panel', absent: true }] })
    expect(again).toMatchObject({ ok: true, stateId: 'a/home', replaced: true, edgeRecorded: false })
    const draft = s.draftSnapshot()
    expect(draft.states).toHaveLength(1)
    expect(draft.states[0]!.features).toHaveLength(2)
    // 包自带那层不许改：那是别人已经接受过的定义
    expect(await s.recordState({ id: 'a/authored', features: [HOME] })).toMatchObject({ ok: false, reason: 'clash' })
    await s.cancel()
  })

  it('agent 说探不下去：草稿非空也要交图，通知照发（别让已经探到的白探）', async () => {
    const { s, store, notes } = harness([
      async () => { await new Promise((r) => setTimeout(r, 150)); return { stopReason: 'end_turn' } },
      async (cx) => { await cx.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'UNREPAIRABLE: 要打字才能搜索，我点不出结果页' } }); return { stopReason: 'end_turn' } },
    ])
    void s.start()
    await settle(30)
    await s.recordState({ id: 'a/home', features: [HOME] })
    await settle(400)
    const run = store.get(s.runId)!
    expect(run.stopped).toEqual({ produced: 'proposal', reason: 'end_turn' })
    expect(store.proposals({ runId: s.runId })).toHaveLength(1)
    expect(notes.some((n) => n.type === 'intervention.unrepairable')).toBe(true)
  })

  it('草稿为空时说探不下去 → 还是 verdict-unrepairable（不交空图）', async () => {
    const { s, store } = harness([
      async (cx) => { await cx.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'UNREPAIRABLE: 整站要登录' } }); return { stopReason: 'end_turn' } },
    ])
    void s.start()
    await settle(200)
    expect(store.get(s.runId)!.stopped).toEqual({ produced: 'verdict-unrepairable', reason: 'end_turn' })
    expect(store.proposals({ runId: s.runId })).toHaveLength(0)
  })

  it('空转闸：连续 3 轮草稿一个字没变 → paused（人可继续），不是一路撞满 turns 闸', async () => {
    const { s, store } = harness([async () => ({ stopReason: 'end_turn' })])
    void s.start()
    await settle(200)
    const run = store.get(s.runId)!
    expect(run.status).toBe('paused')
    expect(run.usage.turns).toBe(3)
    const paused = store.events(s.runId).find((e: RunEvent) => e.kind === 'status_changed' && e.title.includes('暂停'))!
    expect(paused.title).toContain('连续 3 轮没有推进探索')
  })

  it('agent 自己想点页面 → 门自动拒（事件留痕），agent 收到的是 reject 选项', async () => {
    let answered: acp.RequestPermissionResponse | undefined
    const { s, store } = harness([
      async (cx) => {
        answered = await cx.ask({ toolCallId: 'p1', title: 'cdp_act', rawInput: { kind: 'click', ref: 1 } })
        return { stopReason: 'end_turn' }
      },
    ])
    void s.start()
    await settle(120)
    expect(answered).toEqual({ outcome: { outcome: 'selected', optionId: 'n' } })
    const events = store.events(s.runId)
    const asked = events.find((e: RunEvent) => e.kind === 'permission_requested')!
    expect(asked.data).toMatchObject({ auto: true, rejected: true })
    expect(String(asked.data && (asked.data as { why: string }).why)).toContain('graph_act')
    expect(events.some((e: RunEvent) => e.kind === 'permission_answered')).toBe(true)
    await s.cancel()
  })

  it('agent 只给放行选项时：回 cancelled 且 optionId 记成 null（不静默当成放行）', async () => {
    let answered: acp.RequestPermissionResponse | undefined
    const { s, store } = harness([
      async (cx) => {
        answered = await cx.ask({ toolCallId: 'p1', title: 'cdp_act', rawInput: { kind: 'type' } }, [{ optionId: 'y', name: 'ok', kind: 'allow_once' }])
        return { stopReason: 'end_turn' }
      },
    ])
    void s.start()
    await settle(120)
    expect(answered).toEqual({ outcome: { outcome: 'cancelled' } })
    const ans = store.events(s.runId).find((e: RunEvent) => e.kind === 'permission_answered')!
    expect(ans.data).toMatchObject({ auto: true, optionId: null })
    await s.cancel()
  })
})
