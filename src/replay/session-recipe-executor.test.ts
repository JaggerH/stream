import { describe, expect, it } from 'vitest'
import { SessionRecipeExecutor } from './session-recipe-executor.ts'
import { RecipeSessionManager } from './session-manager.ts'
import type { CanonicalBrowserRecipe } from './recipe.ts'
import { makeExtPageDriver, type ExtRawPage } from './browser-ext-drive.ts'
import { resolveTransport, type Transport, type TransportDeps } from './transport.ts'
import type { RecipeSessionSpec } from './recipe.ts'

// Exercise the ONE transport seam end-to-end: a no-op cloak launcher (never used by the
// executor) keeps resolveTransport from building a real browser, extRelay undefined keeps
// ext-cdp's relay behaviour identical to before.
const testDeps: TransportDeps = {
  extLauncher: null as never,
  extRelay: undefined as never,
}
const transportFor = (_spec: RecipeSessionSpec) => resolveTransport(testDeps)

/** Wrap a bare launcher fn as a Transport — the session manager now resolves a whole Transport
 *  per session; these tests only care about its `.launcher` (evaluate/screenshot go unused here). */
function managerTransport(launch: Transport['launcher']['launch']): Transport {
  return {
    launcher: { launch },
    driverFactory: () => ({}) as never,
    relayFactory: () => undefined,
    evaluate: async () => undefined,
    screenshot: async () => null,
    elementShot: async () => null,
    bringToFront: async () => {},
    url: async () => 'https://test.example/',
  }
}

const recipe: CanonicalBrowserRecipe = {
  version: 2, kind: 'browser', sourceId: 'demo', cookieDomain: 'x.test', entryUrl: 'https://x.test/',
  loginCheck: { loggedIn: '.me', wall: '.wall' }, session: { facility: 'demo', lifecycle: 'persistent', visibility: 'unattended' },
  steps: [], observers: [{ kind: 'dom', trigger: 'entry', itemSelector: '.card', fields: { id: {} }, input: { itemsAt: 'items', dedupeBy: 'id', targetCount: 1, mapping: { guid: 'id' } } }],
  output: { itemsAt: 'items', dedupeBy: 'guid', targetCount: 1, mapping: { guid: 'id' } },
}

describe('SessionRecipeExecutor', () => {
  it('leases a generic facility session and runs a canonical recipe', async () => {
    let closes = 0
    const sessions = new RecipeSessionManager(() => managerTransport(async () => {
        return {
          page: { evaluate: async () => undefined as never },
          rawPage: {
            tabId: 7,
            async cdp() { return {} },
            async evalExpr(expression: string) {
              if (expression.includes('extractCards')) return [{ id: 'n1' }]
              if (expression.includes('document.querySelector')) return expression.includes('.me')
              return undefined
            },
          },
          close: async () => { closes++ },
        }
    }))
    const result = await new SessionRecipeExecutor(sessions, transportFor).execute(recipe, {})
    expect(result).toMatchObject({ outcome: 'ok', items: [{ guid: 'n1' }] })
    expect(closes).toBe(0)
    await sessions.closeAll()
    expect(closes).toBe(1)
  })

  it('evicts a stale tab and retries the task once on a fresh one', async () => {
    let launches = 0
    const sessions = new RecipeSessionManager(() => managerTransport(async () => {
        const tab = ++launches
        return {
          page: { evaluate: async () => undefined as never },
          rawPage: {
            tabId: tab,
            async cdp() { return {} },
            async evalExpr(expression: string) {
              if (tab === 1) throw new Error('No tab with given id 1')
              if (expression.includes('extractCards')) return [{ id: 'n1' }]
              if (expression.includes('document.querySelector')) return expression.includes('.me')
              return undefined
            },
          },
          close: async () => {},
        }
    }))
    const result = await new SessionRecipeExecutor(sessions, transportFor).execute(recipe, {})
    expect(launches).toBe(2)
    expect(result).toMatchObject({ outcome: 'ok', items: [{ guid: 'n1' }] })
  })

  it('builds driver + relay from the injected Transport, not its own transport branch', async () => {
    // Prove the executor does not decide driver/relay by an internal if/else:
    // it must call the injected Transport's factories with the lease's rawPage. Spy on both.
    const raw = {
      tabId: 42,
      async cdp() { return {} },
      async evalExpr(expression: string) {
        if (expression.includes('extractCards')) return [{ id: 'n1' }]
        if (expression.includes('document.querySelector')) return expression.includes('.me')
        return undefined
      },
    }
    const sessions = new RecipeSessionManager(() => managerTransport(async () => {
        return { page: { evaluate: async () => undefined as never }, rawPage: raw, close: async () => {} }
    }))
    let driverArg: unknown
    let relayArg: unknown
    const transport: Transport = {
      launcher: null as never,
      driverFactory: (r) => { driverArg = r; return makeExtPageDriver(r as ExtRawPage) },
      relayFactory: (r) => { relayArg = r; return undefined },
      evaluate: async () => undefined,
      screenshot: async () => null,
      elementShot: async () => null,
      bringToFront: async () => {},
      url: async () => 'https://test.example/',
    }
    const result = await new SessionRecipeExecutor(sessions, () => transport).execute(recipe, {})
    expect(driverArg).toBe(raw)
    expect(relayArg).toBe(raw)
    expect(result).toMatchObject({ outcome: 'ok', items: [{ guid: 'n1' }] })
  })
})

// 采集**永远不抢屏幕**。三档（silent/debug/foreground）收敛成两档之后，`interactive` 只决定
// 标签开在哪（前台可见 vs 后台），executor 这一层再不碰焦点——「每次运行自动把窗口提到最前」
// 那套连同它的 returnFocus 一起退役了。
//
// 为什么这条要有测试守着：抢焦点是**看不见的副作用**，回归了不会让任何断言变红，只会在某个
// 半夜把用户的屏幕抢走。所以这里直接断言 transport 的 bringToFront 一次都没被调过。
describe('SessionRecipeExecutor — 任何档都不抢焦点', () => {
  const rawPage = (): ExtRawPage => ({
    tabId: 3,
    async cdp() { return {} },
    async evalExpr<T>(expression: string): Promise<T> {
      if (expression.includes('extractCards')) return [{ id: 'n1' }] as T
      if (expression.includes('document.querySelector')) return expression.includes('.me') as T
      return undefined as T
    },
  })

  function harness(visibility: 'unattended' | 'interactive') {
    const calls: string[] = []
    const raw = rawPage()
    const sessions = new RecipeSessionManager(() => managerTransport(async () => ({
      page: { evaluate: async () => undefined as never }, rawPage: raw, close: async () => {},
    })))
    const transport: Transport = {
      launcher: null as never,
      driverFactory: (r) => makeExtPageDriver(r as ExtRawPage),
      relayFactory: () => undefined,
      evaluate: async () => undefined,
      screenshot: async () => null,
      elementShot: async () => null,
      url: async () => 'https://x.test/',
      // 留着 bringToFront 是因为 transport 仍然提供它（focusFacilityTab 用得上：用户点
      // 「带我去看登录页」）。executor 不该碰它——碰了这里就红。
      bringToFront: async () => { calls.push('front') },
    }
    const exec = new SessionRecipeExecutor(sessions, () => transport)
    const spec = { ...recipe, session: { ...recipe.session, visibility } }
    return { calls, run: () => exec.execute(spec, {}) }
  }

  it.each(['unattended', 'interactive'] as const)('%s 档：跑完一轮，焦点相关的一个都没调', async (visibility) => {
    const { calls, run } = harness(visibility)
    const out = await run()
    expect(out.outcome).toBe('ok')
    expect(calls).toEqual([])
  })
})

// 抽取的 ref 由 executor 从**这份 recipe 自己的 manifest 声明**绑出来，recipe 体里根本没有
// ref 这个字段。这不是风格问题：ref 一旦能在运行期由 recipe 说了算，一份 recipe 就能往别人的
// 凭据槽里写。这一组测的就是"绑不出来时拒写"，而不是"写对了没"。
describe('SessionRecipeExecutor — 抽取 sink 的绑定', () => {
  const keyRecipe = (meta: unknown): CanonicalBrowserRecipe => ({
    ...recipe,
    sourceId: 'k',
    steps: [],
    observers: [],
    allowEmpty: true,
    extract: { field: 'apiKey', pattern: 'gsk_[A-Za-z0-9]+' },
    meta: meta as never,
  })

  async function run(recipeIn: CanonicalBrowserRecipe) {
    const writes: Array<[string, string, string]> = []
    const raw: ExtRawPage = {
      tabId: 5,
      async cdp() { return {} },
        async evalExpr<T>(expression: string): Promise<T> {
        if (expression.includes('innerText')) return '你的 key gsk_zzz111 请复制' as T
        if (expression.includes('document.querySelector')) return expression.includes('.me') as T
        return undefined as T
      },
    }
    const sessions = new RecipeSessionManager(() => managerTransport(async () => ({
      page: { evaluate: async () => undefined as never }, rawPage: raw, close: async () => {},
    })))
    const transport: Transport = {
      launcher: null as never,
      driverFactory: (r) => makeExtPageDriver(r as ExtRawPage),
      relayFactory: () => undefined,
      evaluate: async () => undefined,
      screenshot: async () => null,
      elementShot: async () => null,
      bringToFront: async () => {},
      url: async () => 'https://x.test/',
    }
    const exec = new SessionRecipeExecutor(sessions, () => transport, undefined, (ref, field, value) =>
      writes.push([ref, field, value]),
    )
    const out = await exec.execute(recipeIn, {})
    return { writes, out }
  }

  it('manifest 声明了这个 secret 槽 → 写进它自己的 ref', async () => {
    const { writes, out } = await run(
      keyRecipe({ runtime_config: { ref: 'groq', fields: { apiKey: { type: 'secret', label: 'K' } } } }),
    )
    expect(writes).toEqual([['groq', 'apiKey', 'gsk_zzz111']])
    expect(out.extract).not.toContain('gsk_') // 状态行不带值
  })

  it('字段声明成 string 不是 secret → 拒写，且在 outcome 里说清楚', async () => {
    const { writes, out } = await run(
      keyRecipe({ runtime_config: { ref: 'groq', fields: { apiKey: { type: 'string', label: 'K' } } } }),
    )
    expect(writes).toEqual([])
    expect(out.extract).toContain('拒绝')
  })

  it('没有 runtime_config 声明 → 拒写（绑不出目标就没有目标）', async () => {
    const { writes, out } = await run(keyRecipe({}))
    expect(writes).toEqual([])
    expect(out.extract).toContain('拒绝')
  })
})

// ── secret_params 的注入：闸 3（只给内置包）+ 值缺席即停 ────────────────────────────
//
// 装载期那几闸（只读自己那一格 / 字段必须声明为 secret / call 的次序 / 不许有 evaluate）
// 在 `secret-params.test.ts`。这里验的是**运行期才知道的那两件**：这份 recipe 从哪来，
// 以及那一格到底配没配值。
describe('SessionRecipeExecutor — secret_params 注入', () => {
  const SLOT = { ref: 'dfcf:jagger', fields: { jymm: { type: 'secret', label: '交易密码' } } }

  const loginRecipe = (meta: unknown): CanonicalBrowserRecipe => ({
    ...recipe, sourceId: 'dfcf/login', steps: [], observers: [], allowEmpty: true, meta: meta as never,
  })

  const stubRawPage = (): ExtRawPage => ({
    tabId: 5,
    async cdp() { return {} },
    async evalExpr<T>(): Promise<T> { return undefined as T },
  })
  const stubTransport = (): Transport => ({
    launcher: null as never,
    driverFactory: (r) => makeExtPageDriver(r as ExtRawPage),
    relayFactory: () => undefined,
    evaluate: async () => undefined,
    screenshot: async () => null,
    elementShot: async () => null,
    bringToFront: async () => {},
    url: async () => 'https://x.test/',
  })

  /** runner 换成只记参数的桩：这一组关心「递过去的是什么」，不是页面上发生了什么。 */
  function harness(opts: { builtin?: boolean; stored?: Record<string, string>; noReader?: boolean }) {
    const seen: Array<Record<string, string>> = []
    const raw = stubRawPage()
    const sessions = new RecipeSessionManager(() => managerTransport(async () => ({
      page: { evaluate: async () => undefined as never }, rawPage: raw, close: async () => {},
    })))
    const exec = new SessionRecipeExecutor(
      sessions, () => stubTransport(),
      { run: async (_r: unknown, params: Record<string, string>) => {
        seen.push({ ...params })
        return { outcome: 'ok', items: [], trace: [] }
      } } as never,
      undefined, undefined, undefined,
      opts.noReader ? undefined : (ref, field) => opts.stored?.[`${ref}.${field}`],
      () => opts.builtin ?? false,
    )
    return { seen, exec }
  }

  it('内置包 + 配了值 ⇒ 注入进参数袋，调用方给的参数原样保留', async () => {
    const { seen, exec } = harness({ builtin: true, stored: { 'dfcf:jagger.jymm': 's3cret' } })
    await exec.execute(loginRecipe({ runtime_config: SLOT, secret_params: ['jymm'] }), { alias: 'jagger' })
    expect(seen).toEqual([{ alias: 'jagger', jymm: 's3cret' }])
  })

  it('闸 3：不是内置包 ⇒ 拒绝执行，一个字节都不注入', async () => {
    const { seen, exec } = harness({ builtin: false, stored: { 'dfcf:jagger.jymm': 's3cret' } })
    await expect(exec.execute(loginRecipe({ runtime_config: SLOT, secret_params: ['jymm'] }), {}))
      .rejects.toThrow(/只有内置包/)
    expect(seen).toEqual([])
  })

  it('那一格没配值 ⇒ 停，绝不让 {jymm} 以字面量打进密码框', async () => {
    // 放行的话站点只回一句"密码错误"——排查时看起来像密码不对，实际是根本没配。
    const { exec } = harness({ builtin: true, stored: {} })
    await expect(exec.execute(loginRecipe({ runtime_config: SLOT, secret_params: ['jymm'] }), {}))
      .rejects.toThrow(/没有值/)
  })

  it('宿主没接凭据读口 ⇒ 硬失败，不是静默跑一个没填的', async () => {
    const { exec } = harness({ builtin: true, noReader: true })
    await expect(exec.execute(loginRecipe({ runtime_config: SLOT, secret_params: ['jymm'] }), {}))
      .rejects.toThrow(/没有接凭据读口/)
  })

  it('没声明 secret_params 的 recipe 一切照旧 —— 这一格是 opt-in', async () => {
    const { seen, exec } = harness({ builtin: false })
    await exec.execute(loginRecipe({}), { alias: 'jagger' })
    expect(seen).toEqual([{ alias: 'jagger' }])
  })

  it('注入不改调用方那个对象 —— 它在别处被引用，往里塞凭据就是撒出去', async () => {
    const mine: Record<string, string> = { alias: 'jagger' }
    const { exec } = harness({ builtin: true, stored: { 'dfcf:jagger.jymm': 's3cret' } })
    await exec.execute(loginRecipe({ runtime_config: SLOT, secret_params: ['jymm'] }), mine)
    expect(mine).toEqual({ alias: 'jagger' })
  })
})

// ── locate 步的坐标系（orderedFor）从这一层递给 runner ──────────────────────────────
//
// 账本住在 harvest 域，runner 不认识它；调用方（包代码 / HTTP / MCP）也不该各自去塞 `ordered`。
// 这里是每次 canonical browser recipe 运行的唯一必经处，所以钉住「注入的那份账本函数原样递到
// runner 的 opts，且按 recipe 的 facility 问它就是账本给的答案」。漏接的症状极安静：locate 每趟
// 都 MISS 落 fallback-nav（对 xhs 就是「没 token 就注定失败」），没有任何一处会喊。
describe('SessionRecipeExecutor — orderedFor 递到 runner', () => {
  const stubRawPage = (): ExtRawPage => ({
    tabId: 7,
    async cdp() { return {} },
    async evalExpr<T>(): Promise<T> { return undefined as T },
  })
  const stubTransport = (): Transport => ({
    launcher: null as never,
    driverFactory: (r) => makeExtPageDriver(r as ExtRawPage),
    relayFactory: () => undefined,
    evaluate: async () => undefined,
    screenshot: async () => null,
    elementShot: async () => null,
    bringToFront: async () => {},
    url: async () => 'https://x.test/',
  })
  function harness(orderedFor?: (facility: string) => string[]) {
    const seenOpts: Array<Record<string, unknown>> = []
    const raw = stubRawPage()
    const sessions = new RecipeSessionManager(() => managerTransport(async () => ({
      page: { evaluate: async () => undefined as never }, rawPage: raw, close: async () => {},
    })))
    const exec = new SessionRecipeExecutor(
      sessions, () => stubTransport(),
      { run: async (_r: unknown, _p: unknown, _d: unknown, opts: Record<string, unknown>) => {
        seenOpts.push(opts)
        return { outcome: 'ok', items: [], trace: [] }
      } } as never,
      undefined, undefined, undefined, undefined, undefined, undefined,
      orderedFor,
    )
    return { seenOpts, exec }
  }

  it('注入的账本函数原样递给 runner，按 recipe.session.facility 问它 = 账本的答案', async () => {
    const asked: string[] = []
    const ledger = new Map([['demo', ['a1', 'a2']], ['other', ['z9']]])
    const { seenOpts, exec } = harness((facility) => { asked.push(facility); return ledger.get(facility) ?? [] })
    await exec.execute({ ...recipe, steps: [], observers: [], allowEmpty: true }, {})
    expect(seenOpts).toHaveLength(1)
    const orderedFor = seenOpts[0].orderedFor as ((f: string) => string[]) | undefined
    expect(typeof orderedFor).toBe('function')
    expect(orderedFor!(recipe.session.facility)).toEqual(['a1', 'a2'])
    expect(asked).toEqual(['demo'])
  })

  it('没注入 ⇒ opts 里没有 orderedFor（runner 走缺省：空坐标系，不是报错）', async () => {
    const { seenOpts, exec } = harness(undefined)
    await exec.execute({ ...recipe, steps: [], observers: [], allowEmpty: true }, {})
    expect(seenOpts).toHaveLength(1)
    expect('orderedFor' in seenOpts[0]).toBe(false)
  })
})

// ── 一次搜索只加载一次页面 ──────────────────────────────────────────────────────────
//
// 曾经是两次：建标签时导航到 entryUrl（observer 还没挂，这一遍白载），runner 再 goto 一遍
// （这次才有人听）。用户看到的是「搜一次，页面跳两次」。
describe('SessionRecipeExecutor — 新建 lane 的落点', () => {
  function harness(r: CanonicalBrowserRecipe) {
    const launches: string[] = []
    const sessions = new RecipeSessionManager(() => managerTransport(async (url) => {
      launches.push(url)
      return { page: { evaluate: async () => undefined as never }, rawPage: { tabId: 3 }, close: async () => {} }
    }))
    return { launches, exec: new SessionRecipeExecutor(sessions, transportFor) }
  }

  it('自己会导航的 recipe → 落空白页，别先白载一遍', async () => {
    const { launches, exec } = harness(recipe)
    await exec.execute(recipe, {})
    expect(launches).toEqual(['about:blank'])
  })

  it('rideCurrentPage 的 recipe → 落 entryUrl：它不自己导航，落点就是工作上下文', async () => {
    const riding = { ...recipe, rideCurrentPage: true, entryUrl: 'https://x.test/explore' }
    const { launches, exec } = harness(riding)
    await exec.execute(riding, {})
    expect(launches).toEqual(['https://x.test/explore'])
  })
})

// ── 频率闸门：落到站点上的每一次运行都要先过它 ──────────────────────────────────────
//
// 封号数的是频率（2026-07-29 亲历：高频打 xhs detail → 登录墙，拟人轨迹全程开着）。闸门
// 因此装在所有 recipe 的共同入口上，而不是 recipe 自己身上——一个 facility 上同时有搜索、
// detail、互动三条线，只有这里看得见总量。
describe('SessionRecipeExecutor — 频率闸门', () => {
  function harness(take: (facility: string) => Promise<void>, order: string[]) {
    const sessions = new RecipeSessionManager(() => managerTransport(async () => {
      order.push('newTab')
      return { page: { evaluate: async () => undefined as never }, rawPage: { tabId: 3 }, close: async () => {} }
    }))
    return new SessionRecipeExecutor(sessions, transportFor, undefined, undefined, { take })
  }

  it('先过闸门再开标签 —— 被限速时连 tab 都不该开', async () => {
    const order: string[] = []
    const exec = harness(async (f) => { order.push(`take:${f}`) }, order)
    await exec.execute(recipe, {})
    expect(order[0]).toBe('take:demo')
    expect(order).toContain('newTab')
  })

  it('闸门拒了就不开标签 —— 拒绝要一路冒上去，不能被吞成"这次没采到"', async () => {
    const order: string[] = []
    const exec = harness(async () => { throw new Error('rate limited') }, order)
    await expect(exec.execute(recipe, {})).rejects.toThrow('rate limited')
    expect(order).not.toContain('newTab')
  })

  /**
   * 起跑前就没人要了（用户点开一条详情、立刻又点了另一条）：**一发都不该扣**。
   * 那是封号预算，花在一个没人看的答案上是纯亏。
   */
  it('开跑前已被放弃 → 不花令牌、不开标签，如实报 cancelled', async () => {
    const order: string[] = []
    const exec = harness(async (f) => { order.push(`take:${f}`) }, order)
    const outcome = await exec.execute(recipe, {}, AbortSignal.abort())
    expect(outcome.outcome).toBe('cancelled')
    expect(order).toEqual([])
  })
})

// ── 退让闸门：被拦之后先别去打 ─────────────────────────────────────────────────────
//
// 和上面那道是两件事：那道管频率（一分钟几次），这道管「站点已经把我们拦下了」。后者
// 在前者眼里完全合法——频率没超，于是下一次照打不误，而每一次都在加深那个拦截。
describe('SessionRecipeExecutor — 退让闸门', () => {
  function harness(cooldown: {
    assertReady(f: string): void
    blocked(f: string, why: string): void
    cleared(f: string): void
  }, order: string[]) {
    const sessions = new RecipeSessionManager(() => managerTransport(async () => {
      order.push('newTab')
      return { page: { evaluate: async () => undefined as never }, rawPage: { tabId: 3 }, close: async () => {} }
    }))
    return new SessionRecipeExecutor(sessions, transportFor, undefined, undefined, undefined, cooldown)
  }

  it('冷却中 → 连令牌都不花、标签更不开，拒绝一路冒上去', async () => {
    const order: string[] = []
    const exec = harness({
      assertReady: () => { throw new Error('"demo" 正在冷却') },
      blocked: () => {}, cleared: () => {},
    }, order)
    await expect(exec.execute(recipe, {})).rejects.toThrow('正在冷却')
    expect(order).not.toContain('newTab')
  })

  it('撞墙 → 记一次被拦（needsLogin 是全链路上唯一具名的"被站点挡住"信号）', async () => {
    const order: string[] = []
    const blocked: string[] = []
    const sessions = new RecipeSessionManager(() => managerTransport(async () => ({
      page: { evaluate: async () => undefined as never }, rawPage: { tabId: 3 }, close: async () => {},
    })))
    const exec = new SessionRecipeExecutor(
      sessions, transportFor,
      { run: async () => ({ outcome: 'needsLogin', items: [], trace: [], reason: '撞上 /sorry' }) } as never,
      undefined, undefined,
      { assertReady: () => {}, blocked: (f, why) => blocked.push(`${f}:${why}`), cleared: () => {} },
    )
    const out = await exec.execute(recipe, {})
    expect(out.outcome).toBe('needsLogin')
    expect(blocked).toEqual(['demo:撞上 /sorry'])
    expect(order).not.toContain('take')
  })

  it('风控挑战 → 同样记一次被拦（对用户的说法不同，但退让是一样的）', async () => {
    // challenged 和 needsLogin 在**文案上必须分开**（一个要用户去登录，一个什么都不用做），
    // 但在**退让上必须合并**：两者都是"站方让我们等"，不进冷却就是接着去撞。
    const blocked: string[] = []
    const sessions = new RecipeSessionManager(() => managerTransport(async () => ({
      page: { evaluate: async () => undefined as never }, rawPage: { tabId: 3 }, close: async () => {},
    })))
    const exec = new SessionRecipeExecutor(
      sessions, transportFor,
      { run: async () => ({ outcome: 'challenged', items: [], trace: [], reason: '站方弹了验证码' }) } as never,
      undefined, undefined,
      { assertReady: () => {}, blocked: (f, why) => blocked.push(`${f}:${why}`), cleared: () => {} },
    )
    const out = await exec.execute(recipe, {})
    expect(out.outcome).toBe('challenged')
    expect(blocked).toEqual(['demo:站方弹了验证码'])
  })

  it('跑成一次 → 清账（站点已经不生气了，没有理由还留着）', async () => {
    const cleared: string[] = []
    const sessions = new RecipeSessionManager(() => managerTransport(async () => ({
      page: { evaluate: async () => undefined as never }, rawPage: { tabId: 3 }, close: async () => {},
    })))
    const exec = new SessionRecipeExecutor(
      sessions, transportFor,
      { run: async () => ({ outcome: 'ok', items: [], trace: [] }) } as never,
      undefined, undefined,
      { assertReady: () => {}, blocked: () => {}, cleared: (f) => cleared.push(f) },
    )
    await exec.execute(recipe, {})
    expect(cleared).toEqual(['demo'])
  })

  it('撞墙 → 顺手排空小时预算，并把"这一小时发了几发"交给台账', async () => {
    // 这两件事必须一起做：不排空的话，冷却一过就按原速接着打，而 perHour 那道闸门管不了
    // 这一格——它只知道我们发了几发，不知道我们已经被拦下过。
    const drained: string[] = []
    const blocked: Array<{ f: string; spentLastHour?: number }> = []
    const sessions = new RecipeSessionManager(() => managerTransport(async () => ({
      page: { evaluate: async () => undefined as never }, rawPage: { tabId: 3 }, close: async () => {},
    })))
    const exec = new SessionRecipeExecutor(
      sessions, transportFor,
      { run: async () => ({ outcome: 'needsLogin', items: [], trace: [], reason: '撞上 /sorry' }) } as never,
      undefined,
      { take: async () => {}, drainBudget: (f) => { drained.push(f); return 97 } },
      { assertReady: () => {}, blocked: (f, _why, ctx) => blocked.push({ f, spentLastHour: ctx?.spentLastHour }), cleared: () => {} },
    )
    await exec.execute(recipe, {})
    expect(drained).toEqual(['demo'])
    expect(blocked).toEqual([{ f: 'demo', spentLastHour: 97 }])
  })

  it('限流器没接 drainBudget（老装配）→ 退让照旧，不炸', async () => {
    const blocked: Array<{ spentLastHour?: number }> = []
    const sessions = new RecipeSessionManager(() => managerTransport(async () => ({
      page: { evaluate: async () => undefined as never }, rawPage: { tabId: 3 }, close: async () => {},
    })))
    const exec = new SessionRecipeExecutor(
      sessions, transportFor,
      { run: async () => ({ outcome: 'needsLogin', items: [], trace: [], reason: 'x' }) } as never,
      undefined,
      { take: async () => {} },
      { assertReady: () => {}, blocked: (_f, _why, ctx) => blocked.push({ spentLastHour: ctx?.spentLastHour }), cleared: () => {} },
    )
    await exec.execute(recipe, {})
    expect(blocked).toEqual([{ spentLastHour: undefined }])
  })
})

describe('SessionRecipeExecutor — 把 recipe 自己那道限流闸递给闸门', () => {
  // 这条钉的是**接线**，不是限流算法（算法在 facility-rate-limit.test.ts）。
  //
  // 为什么值得单独一条：接错的样子是**静默无效**——闸门看着声明了，实际一发都没拦，而
  // "没拦"和"还没到阈值"长得一模一样。同一个形状这个文件里已经有过一次（`builtinPackage`
  // 曾经收 sourceId：recipe 体里是局部名、集合里装的是全名，判据恒为 false）。
  // 这里同时钉住 v2 recipe 的 `meta` 能活到执行器手里——canonical 化是整块透传的，
  // 哪天改成逐字段挑，这条会红。
  const rateLimited: CanonicalBrowserRecipe = {
    ...recipe,
    meta: { rateLimit: { burst: 2, perMinute: 0.5, perHour: 6 } },
  }

  function spyLimiter() {
    const calls: Array<{ facility: string; source?: { id: string; limit?: unknown } }> = []
    return {
      calls,
      take: async (facility: string, source?: { id: string; limit?: unknown }) => {
        calls.push({ facility, source })
      },
    }
  }

  async function runWith(r: CanonicalBrowserRecipe, limiter: ReturnType<typeof spyLimiter>) {
    const sessions = new RecipeSessionManager(() => managerTransport(async () => ({
      page: { evaluate: async () => undefined as never },
      rawPage: {
        tabId: 1,
        async cdp() { return {} },
        async evalExpr(expression: string) {
          if (expression.includes('extractCards')) return [{ id: 'n1' }]
          if (expression.includes('document.querySelector')) return expression.includes('.me')
          return undefined
        },
      } as unknown as ExtRawPage,
      close: async () => {},
    })))
    const out = await new SessionRecipeExecutor(sessions, transportFor, undefined, undefined, limiter)
      .execute(r, {})
    await sessions.closeAll()
    return out
  }

  it('声明了就把 facility + 这条 recipe 自己的 limit 一起递过去', async () => {
    const limiter = spyLimiter()
    const out = await runWith(rateLimited, limiter)
    expect(out).toMatchObject({ outcome: 'ok' })
    expect(limiter.calls).toEqual([
      { facility: 'demo', source: { id: 'demo', limit: { burst: 2, perMinute: 0.5, perHour: 6 } } },
    ])
  })

  it('没声明就只递 facility —— limit 是 undefined，闸门那边照老行为走', async () => {
    const limiter = spyLimiter()
    await runWith(recipe, limiter)
    expect(limiter.calls).toHaveLength(1)
    expect(limiter.calls[0].facility).toBe('demo')
    expect(limiter.calls[0].source?.limit).toBeUndefined()
  })
})

describe('SessionRecipeExecutor adoptTab — riding the tab the user has open', () => {
  const riding: CanonicalBrowserRecipe = {
    ...recipe,
    entryUrl: '{url}',
    adoptTab: { urlPrefix: 'https://x.test/chat/', param: 'url' },
  }

  /** A transport whose launcher can list group tabs and adopt one; records launches, adopts, navigations.
   *  Tabs default to origin 'adopted' (the user dragged them in); pass `origin` to model our own lane tabs. */
  function adoptingTransport(given: Array<{ tabId: number; url: string; title: string; origin?: 'created' | 'probe' | 'adopted' }>) {
    const tabs = given.map((t) => ({ origin: 'adopted' as const, ...t }))
    const log: string[] = []
    const rawPage = (tabId: number, initialHref: string) => ({
      tabId,
      href: initialHref,
      async cdp(method: string, p?: { url?: string }) {
        if (method === 'Page.navigate') { log.push(`navigate ${p?.url}`); this.href = p!.url! }
        return {}
      },
      async evalExpr(expression: string) {
        if (expression.includes('readyState')) return { href: this.href, state: 'complete' }
        if (expression.includes('location.href')) return this.href
        if (expression.includes('extractCards')) return [{ id: 'n1' }]
        if (expression.includes('document.querySelector')) return expression.includes('.me')
        return undefined
      },
    })
    const transport: Transport = {
      ...managerTransport(async (url) => {
        log.push(`launch ${url}`)
        return { page: { evaluate: async () => undefined as never }, rawPage: rawPage(99, url), close: async () => { log.push('close 99') } }
      }),
    }
    transport.launcher.listTabs = async () => tabs
    transport.launcher.adopt = async (tabId) => {
      log.push(`adopt ${tabId}`)
      const t = tabs.find((x) => x.tabId === tabId)!
      return { page: { evaluate: async () => undefined as never }, rawPage: rawPage(tabId, t.url), close: async () => { log.push(`close ${tabId}`) } }
    }
    return { transport, log }
  }

  it('no url given, exactly one matching group tab → rides it, fills the param, never launches or navigates', async () => {
    const { transport, log } = adoptingTransport([
      { tabId: 42, url: 'https://x.test/chat/777', title: 'chat' },
      { tabId: 43, url: 'https://x.test/home', title: 'home' },
    ])
    const sessions = new RecipeSessionManager(() => transport)
    const result = await new SessionRecipeExecutor(sessions, transportFor).execute(riding, {})
    expect(result).toMatchObject({ outcome: 'ok', items: [{ guid: 'n1' }] })
    expect(log).toEqual(['adopt 42', 'close 42'])
  })

  it('url given and a group tab holds it → rides that tab (hash/query on the copied URL do not matter)', async () => {
    const { transport, log } = adoptingTransport([
      { tabId: 41, url: 'https://x.test/chat/1', title: 'a' },
      { tabId: 42, url: 'https://x.test/chat/777?from=history', title: 'b' },
    ])
    const sessions = new RecipeSessionManager(() => transport)
    const result = await new SessionRecipeExecutor(sessions, transportFor).execute(riding, { url: 'https://x.test/chat/777' })
    expect(result.outcome).toBe('ok')
    expect(log).toEqual(['adopt 42', 'close 42'])
  })

  it('our own parked lane tab is never ridden even when it holds the URL — it is a stale render; the lane path reloads instead', async () => {
    const { transport, log } = adoptingTransport([
      { tabId: 42, url: 'https://x.test/chat/777', title: 'parked', origin: 'probe' },
    ])
    const sessions = new RecipeSessionManager(() => transport)
    const result = await new SessionRecipeExecutor(sessions, transportFor).execute(riding, { url: 'https://x.test/chat/777' })
    expect(result.outcome).toBe('ok')
    expect(log).toEqual(['launch about:blank', 'navigate https://x.test/chat/777'])
  })

  it('url given but no group tab holds it → falls back to the facility lane and navigates there', async () => {
    const { transport, log } = adoptingTransport([{ tabId: 41, url: 'https://x.test/chat/1', title: 'a' }])
    const sessions = new RecipeSessionManager(() => transport)
    const result = await new SessionRecipeExecutor(sessions, transportFor).execute(riding, { url: 'https://x.test/chat/777' })
    expect(result.outcome).toBe('ok')
    expect(log).toEqual(['launch about:blank', 'navigate https://x.test/chat/777'])
  })

  it('no url and no matching tab → blocked with a reason that says what to do; nothing is opened', async () => {
    const { transport, log } = adoptingTransport([{ tabId: 43, url: 'https://x.test/home', title: 'home' }])
    const sessions = new RecipeSessionManager(() => transport)
    const result = await new SessionRecipeExecutor(sessions, transportFor).execute(riding, {})
    expect(result.outcome).toBe('blocked')
    expect(result.reason).toMatch(/拖进组|把地址传进来/)
    expect(log).toEqual([])
  })

  it('no url and several matching tabs → blocked, listing them instead of guessing', async () => {
    const { transport, log } = adoptingTransport([
      { tabId: 41, url: 'https://x.test/chat/1', title: 'a' },
      { tabId: 42, url: 'https://x.test/chat/2', title: 'b' },
    ])
    const sessions = new RecipeSessionManager(() => transport)
    const result = await new SessionRecipeExecutor(sessions, transportFor).execute(riding, {})
    expect(result.outcome).toBe('blocked')
    expect(result.reason).toContain('https://x.test/chat/1')
    expect(result.reason).toContain('https://x.test/chat/2')
    expect(log).toEqual([])
  })
})
