import { describe, expect, it, vi } from 'vitest'
import type { Transport } from './transport.ts'
import { RecipeSessionManager, LaneBusyForLoginError } from './session-manager.ts'

/** A minimal Transport whose launcher tracks launches/closes; evaluate/screenshot are unused here. */
function fakeLauncher() {
  let next = 1
  const closes: number[] = []
  const launches: Array<{ url: string; interactive?: boolean }> = []
  const launcher: Transport = {
    launcher: {
      async launch(url, _wait, opts) {
        const id = next++
        launches.push({ url, interactive: opts?.interactive })
        return {
          page: { evaluate: vi.fn() as never },
          rawPage: { id },
          close: async () => { closes.push(id) },
        }
      },
    },
    driverFactory: () => ({}) as never,
    relayFactory: () => undefined,
    evaluate: async () => undefined,
    screenshot: async () => null,
    elementShot: async () => null,
    bringToFront: async () => {},
    url: async () => 'https://demo.test/',
  }
  return { launcher, launches, closes }
}

/**
 * 常驻 lane 跨后端重启：lane 映射只在进程内存里，重启前 closeAll 会关掉标签、重启后扩展对账会收走没人认领的
 * 自建标签——Photopea 工作台标签里有用户的文档，两样都不行。
 */
describe('RecipeSessionManager — keepAlive lane 跨重启', () => {
  const spec = { facility: 'photopea', lifecycle: 'persistent' as const, visibility: 'unattended' as const, keepAlive: true }
  const memStore = () => { let pins: Record<string, number> = {}; return { load: () => ({ ...pins }), save: (p: Record<string, number>) => { pins = { ...p } }, peek: () => pins } }
  const tabLauncher = (alive: Set<number>) => {
    let next = 100
    const launches: number[] = [], adopts: number[] = [], closes: number[] = []
    const t: Transport = {
      launcher: {
        async launch() { const tabId = next++; alive.add(tabId); launches.push(tabId); return { page: { evaluate: vi.fn() as never }, rawPage: { tabId }, close: async () => { closes.push(tabId); alive.delete(tabId) } } },
        async adopt(tabId: number) { if (!alive.has(tabId)) throw new Error('not in group'); adopts.push(tabId); return { page: { evaluate: vi.fn() as never }, rawPage: { tabId }, close: async () => {} } },
      },
      driverFactory: () => ({}) as never, relayFactory: () => undefined, evaluate: async () => undefined,
      screenshot: async () => null, elementShot: async () => null, bringToFront: async () => {},
      url: async (raw: unknown) => { if (!alive.has((raw as { tabId: number }).tabId)) throw new Error('gone'); return 'https://www.photopea.com/api/' },
    }
    return { t, launches, adopts, closes }
  }

  it('关停不关常驻标签，落盘的 tabId 在新进程里算认领、下一轮原地骑回去', async () => {
    const alive = new Set<number>(); const store = memStore()
    const a = tabLauncher(alive)
    const m1 = new RecipeSessionManager(() => a.t, { keepAliveStore: store })
    await (await m1.acquire(spec, 'https://www.photopea.com/api/')).release()
    await m1.closeAll()
    expect(a.closes).toEqual([])
    expect(store.peek()).toEqual({ 'photopea\0default': 100 })

    const b = tabLauncher(alive)
    const m2 = new RecipeSessionManager(() => b.t, { keepAliveStore: store })
    expect(m2.pinnedTabIds()).toEqual([100])           // 还没骑回去就已经认领——扩展对账不会收它
    await (await m2.acquire(spec, 'https://www.photopea.com/api/')).release()
    expect(b.adopts).toEqual([100])
    expect(b.launches).toEqual([])
  })

  it('落盘的那张没了（用户关了）→ 忘掉它、开新的、记新的', async () => {
    const alive = new Set<number>(); const store = memStore(); store.save({ 'photopea\0default': 42 })
    const b = tabLauncher(alive)
    const m = new RecipeSessionManager(() => b.t, { keepAliveStore: store })
    await (await m.acquire(spec, 'https://www.photopea.com/api/')).release()
    expect(b.launches).toEqual([100])
    expect(store.peek()).toEqual({ 'photopea\0default': 100 })
  })

  it('显式关 lane 照关，并从落盘里删掉', async () => {
    const alive = new Set<number>(); const store = memStore()
    const a = tabLauncher(alive)
    const m = new RecipeSessionManager(() => a.t, { keepAliveStore: store })
    await (await m.acquire(spec, 'https://www.photopea.com/api/')).release()
    await m.closeLane('photopea')
    expect(a.closes).toEqual([100])
    expect(store.peek()).toEqual({})
  })
})

describe('RecipeSessionManager visibility', () => {
  it('runs a silent session in a background tab — CDP Input needs a focused window, and a silent recipe must never steal one', async () => {
    const f = fakeLauncher()
    const lease = await new RecipeSessionManager(() => f.launcher).acquire(
      { facility: 'demo', lifecycle: 'one-shot', visibility: 'unattended' }, 'https://demo.test/',
    )
    await lease.release()
    expect(f.launches).toEqual([{ url: 'https://demo.test/', interactive: false }])
  })

  it('runs a debug session in an interactive window', async () => {
    const f = fakeLauncher()
    const lease = await new RecipeSessionManager(() => f.launcher).acquire(
      { facility: 'demo', lifecycle: 'persistent', visibility: 'interactive' }, 'https://demo.test/',
    )
    await lease.release()
    expect(f.launches).toEqual([{ url: 'https://demo.test/', interactive: true }])
  })
})

/** monotonic clock so lastUsedAt ordering (LRU) and the grace window are deterministic. */
function clock(start = 1000, step = 10) {
  let t = start
  return () => (t += step)
}

describe('RecipeSessionManager budget', () => {
  const persistent = (facility: string) => ({ facility, lifecycle: 'persistent' as const, visibility: 'unattended' as const })

  it('evicts the LRU idle lane when a new lane would exceed the global cap', async () => {
    const f = fakeLauncher()
    const mgr = new RecipeSessionManager(() => f.launcher, { maxLanesGlobal: 2, graceMs: 0, now: clock() })
    await (await mgr.acquire(persistent('a'), 'u')).release()
    await (await mgr.acquire(persistent('b'), 'u')).release()
    await (await mgr.acquire(persistent('c'), 'u')).release() // third would exceed cap → reap LRU idle ('a')
    expect(f.closes).toEqual([1])
    expect(mgr.lanes().map((l) => l.facility).sort()).toEqual(['b', 'c'])
  })

  it('never evicts a lane with an in-flight lease — oversubscribes instead of starving a harvest', async () => {
    const f = fakeLauncher()
    const mgr = new RecipeSessionManager(() => f.launcher, { maxLanesGlobal: 1, graceMs: 0, now: clock() })
    const held = await mgr.acquire(persistent('a'), 'u') // leased, NOT released
    const b = await mgr.acquire(persistent('b'), 'u') // cap=1 but 'a' is busy → cannot evict → oversubscribe
    expect(f.closes).toEqual([]) // nothing reaped
    expect(mgr.lanes()).toHaveLength(2)
    await held.release()
    await b.release()
  })

  it('腾位置时跳过 keepAlive 的 lane,挤最老的普通 lane', async () => {
    const f = fakeLauncher()
    const mgr = new RecipeSessionManager(() => f.launcher, { maxLanesGlobal: 2, graceMs: 0, now: clock() })
    await (await mgr.acquire({ ...persistent('photopea'), keepAlive: true }, 'u')).release() // 最老,但常驻
    await (await mgr.acquire(persistent('b'), 'u')).release()
    await (await mgr.acquire(persistent('c'), 'u')).release()
    expect(f.closes).toEqual([2])
    expect(mgr.lanes().map((l) => l.facility).sort()).toEqual(['c', 'photopea'])
  })

})

describe('RecipeSessionManager', () => {
  it('closes a one-shot browser when its lease is released', async () => {
    const f = fakeLauncher()
    const manager = new RecipeSessionManager(() => f.launcher)
    const lease = await manager.acquire(
      { facility: 'demo', lifecycle: 'one-shot', visibility: 'unattended' },
      'https://demo.test/',
    )
    expect(lease.rawPage).toEqual({ id: 1 })
    await lease.release()
    await lease.release()
    expect(f.closes).toEqual([1])
  })

  it('reuses one persistent browser across sequential facility leases', async () => {
    const f = fakeLauncher()
    const manager = new RecipeSessionManager(() => f.launcher)
    const spec = { facility: 'xhs', lifecycle: 'persistent' as const, visibility: 'unattended' as const }
    const a = await manager.acquire(spec, 'https://www.xiaohongshu.com/explore')
    await a.release()
    const b = await manager.acquire(spec, 'https://www.xiaohongshu.com/explore')
    expect(b.rawPage).toBe(a.rawPage)
    expect(f.launches).toHaveLength(1)
    expect(f.closes).toEqual([])
    await b.release()
    await manager.closeFacility('xhs')
    expect(f.closes).toEqual([1])
  })

  it('serializes tasks that target the same persistent facility', async () => {
    const f = fakeLauncher()
    const manager = new RecipeSessionManager(() => f.launcher)
    const spec = { facility: 'xhs', lifecycle: 'persistent' as const, visibility: 'unattended' as const }
    const a = await manager.acquire(spec, 'https://x.test/')
    let acquired = false
    const pending = manager.acquire(spec, 'https://x.test/').then((lease) => {
      acquired = true
      return lease
    })
    await Promise.resolve()
    expect(acquired).toBe(false)
    await a.release()
    const b = await pending
    expect(acquired).toBe(true)
    await b.release()
  })

  it('creates only one tab when the first two facility acquires race', async () => {
    const f = fakeLauncher()
    const manager = new RecipeSessionManager(() => f.launcher)
    const spec = { facility: 'xhs', lifecycle: 'persistent' as const, visibility: 'unattended' as const }
    const firstPromise = manager.acquire(spec, 'https://x.test/')
    const secondPromise = manager.acquire(spec, 'https://x.test/')
    const first = await firstPromise
    expect(f.launches).toHaveLength(1)
    await first.release()
    const second = await secondPromise
    expect(f.launches).toHaveLength(1)
    await second.release()
  })

  it('keeps different facilities independent', async () => {
    const f = fakeLauncher()
    const manager = new RecipeSessionManager(() => f.launcher)
    const xhs = await manager.acquire({ facility: 'xhs', lifecycle: 'persistent', visibility: 'unattended' }, 'https://x.test/')
    const other = await manager.acquire({ facility: 'other', lifecycle: 'persistent', visibility: 'unattended' }, 'https://o.test/')
    expect(f.launches).toHaveLength(2)
    await Promise.all([xhs.release(), other.release()])
  })

  it('opens every lane through the injected transport', async () => {
    const calls: string[] = []
    const t = { launcher: { launch: async () => { calls.push('launch'); return { page: {} as any, rawPage: {}, close: async () => {} } } } }
    const mgr = new RecipeSessionManager(() => t as any)
    await (await mgr.acquire({ facility: 'a', lifecycle: 'one-shot', visibility: 'unattended' }, 'https://x', 'load')).release()
    await (await mgr.acquire({ facility: 'b', lifecycle: 'one-shot', visibility: 'unattended' }, 'https://x', 'load')).release()
    expect(calls).toEqual(['launch', 'launch'])
  })

  it('runs multiple lanes of one facility in parallel — own tab + own tail, but the same facility', async () => {
    const f = fakeLauncher()
    const manager = new RecipeSessionManager(() => f.launcher)
    const feed = { facility: 'xhs', laneKey: 'feed', lifecycle: 'persistent' as const, visibility: 'unattended' as const }
    const search = { facility: 'xhs', laneKey: 'search', lifecycle: 'persistent' as const, visibility: 'unattended' as const }
    const a = await manager.acquire(feed, 'https://x.test/')
    // acquiring the SEARCH lane must NOT block on the FEED lane's still-held tail (parallel);
    // if lanes shared a tail this await would hang until `a` releases.
    const b = await manager.acquire(search, 'https://x.test/')
    expect(f.launches).toHaveLength(2) // two tabs
    expect(a.rawPage).not.toBe(b.rawPage) // distinct pages
    expect(manager.state('xhs', 'feed')).toMatchObject({ laneKey: 'feed', status: 'leased' })
    expect(manager.state('xhs', 'search')).toMatchObject({ laneKey: 'search', status: 'leased' })
    await a.release()
    await b.release()
    await manager.closeFacility('xhs') // closes BOTH lanes of the facility
    expect(f.closes.slice().sort()).toEqual([1, 2])
  })

  it('closes only one lane with closeLane, leaving the facility\'s other lanes alive', async () => {
    const f = fakeLauncher()
    const manager = new RecipeSessionManager(() => f.launcher)
    const feed = { facility: 'xhs', laneKey: 'feed', lifecycle: 'persistent' as const, visibility: 'unattended' as const }
    const search = { facility: 'xhs', laneKey: 'search', lifecycle: 'persistent' as const, visibility: 'unattended' as const }
    await (await manager.acquire(feed, 'https://x.test/')).release()
    await (await manager.acquire(search, 'https://x.test/')).release()
    await manager.closeLane('xhs', 'search')
    expect(f.closes).toEqual([2]) // only the search lane's tab closed
    expect(manager.state('xhs', 'feed')).toMatchObject({ status: 'idle' })
    expect(manager.state('xhs', 'search')).toBeNull()
  })

  it('evicts a blocked persistent session after the lease releases', async () => {
    const f = fakeLauncher()
    const manager = new RecipeSessionManager(() => f.launcher)
    const spec = { facility: 'xhs', lifecycle: 'persistent' as const, visibility: 'unattended' as const }
    const a = await manager.acquire(spec, 'https://x.test/')
    a.markBlocked('background throttled')
    expect(manager.state('xhs')).toMatchObject({ status: 'blocked', reason: 'background throttled' })
    await a.release()
    expect(f.closes).toEqual([1])
    const b = await manager.acquire(spec, 'https://x.test/')
    expect(b.rawPage).toEqual({ id: 2 })
    await b.release()
  })
})

/**
 * 一条 lane 的 tab 是复用的，不是每次 acquire 重开一个。
 *
 * 这里曾经有一对测试守着「recipe 换了 transport（cloak ⇄ ext-cdp）就得关掉旧 tab 重开」。
 * 只剩一个浏览器之后，换 transport 这件事不存在了，那条规则连同它的故障模式一起消失——留下的
 * 只有「同一条 lane 反复 acquire 不该白关一次 tab」这半条。
 */
describe('RecipeSessionManager — 同一条 lane 复用 tab', () => {
  const spy = (closed: string[]) => ({
    launcher: {
      launch: async () => ({ page: {} as any, rawPage: {}, close: async () => { closed.push('closed') } }),
    },
  })

  it('反复 acquire 同一条 lane → 照旧复用，不该白关一次 tab', async () => {
    const closed: string[] = []
    const mgr = new RecipeSessionManager(() => spy(closed) as any)
    const base = { facility: 'xhs', lifecycle: 'persistent' as const, visibility: 'unattended' as const }
    await (await mgr.acquire(base, 'https://x.test/')).release()
    await (await mgr.acquire(base, 'https://x.test/')).release()
    expect(closed).toEqual([])
  })
})

/**
 * 闲置回收。正常收尾是使用者显式关（离开频道 → POST /api/facilities/:id/close）；这里兜的是
 * 那条回调跑不到的路：用户直接关掉浏览器标签、Chrome 崩了、或者人就这么走了。
 */
describe('RecipeSessionManager — 闲置 lane 回收', () => {
  const persistent = (facility: string) => ({ facility, lifecycle: 'persistent' as const, visibility: 'unattended' as const })

  it('闲置超时的 lane 被关掉,并报出关了谁', async () => {
    const f = fakeLauncher()
    let t = 1000
    const mgr = new RecipeSessionManager(() => f.launcher, { now: () => t })
    await (await mgr.acquire(persistent('xhs'), 'https://x.test/')).release()
    t += 11 * 60_000
    expect(await mgr.reapIdle(10 * 60_000)).toEqual(['xhs/default'])
    expect(mgr.lanes()).toHaveLength(0)
  })

  it('还没到闲置线的 lane 不动 —— 去接杯水回来不该发现会话没了', async () => {
    const f = fakeLauncher()
    let t = 1000
    const mgr = new RecipeSessionManager(() => f.launcher, { now: () => t })
    await (await mgr.acquire(persistent('xhs'), 'https://x.test/')).release()
    t += 60_000
    expect(await mgr.reapIdle(10 * 60_000)).toEqual([])
    expect(mgr.lanes()).toHaveLength(1)
  })

  it('keepAlive 的 lane 闲置多久都不回收 —— 工作台标签里有用户的东西', async () => {
    const f = fakeLauncher()
    let t = 1000
    const mgr = new RecipeSessionManager(() => f.launcher, { now: () => t })
    await (await mgr.acquire({ ...persistent('photopea'), keepAlive: true }, 'https://x.test/')).release()
    t += 24 * 60 * 60_000
    expect(await mgr.reapIdle(10 * 60_000)).toEqual([])
    expect(f.closes).toEqual([])
  })

  it('keepAlive 的 lane 跑出 blocked 也不关，下一轮骑同一张标签', async () => {
    const f = fakeLauncher()
    const mgr = new RecipeSessionManager(() => f.launcher)
    const spec = { ...persistent('photopea'), keepAlive: true }
    const a = await mgr.acquire(spec, 'https://x.test/')
    a.markBlocked('iframe 没就绪')
    await a.release()
    expect(f.closes).toEqual([])
    const b = await mgr.acquire(spec, 'https://x.test/')
    expect(b.rawPage).toEqual({ id: 1 })
    await b.release()
  })

  it('有人正租着就绝不回收 —— 哪怕它"闲置"很久(长任务)', async () => {
    const f = fakeLauncher()
    let t = 1000
    const mgr = new RecipeSessionManager(() => f.launcher, { now: () => t })
    const lease = await mgr.acquire(persistent('xhs'), 'https://x.test/') // 不 release：在飞
    t += 60 * 60_000
    expect(await mgr.reapIdle(10 * 60_000)).toEqual([])
    await lease.release()
  })
})

// ── 用户手动关掉了那个 tab：内存里的 lane 成了孤儿 ─────────────────────────────────────
//
// 活体（2026-07-28）：用户把采集开的 tab 手动关了，之后每次搜索都报错——**换个关键词重搜
// 还是同一个错**。因为复用分支只看 map 里有没有记录，从不问"那个 tab 还在吗"，于是这条
// 死记录会一直被复用下去，永远不自愈。单次失败是合理的（账本没了），永久失败不是。
describe('RecipeSessionManager —— 登录流程占着 lane 时，采集当场退', () => {
  const spec = { facility: 'xhs', lifecycle: 'persistent' as const, visibility: 'unattended' as const }

  it('登录占着 → 采集不排队，抛 LaneBusyForLoginError', async () => {
    // 排队的尽头一定是成员超时（登录会占到用户扫完，分钟级；搜索每个成员只有 25 秒），
    // 而且报出来是"这个源超时"，把"你需要登录"这个唯一可操作的信息盖掉了。
    const f = fakeLauncher()
    const m = new RecipeSessionManager(() => f.launcher)
    const login = await m.acquire(spec, 'about:blank', 'commit', 'login')
    await expect(m.acquire(spec, 'https://x.test/')).rejects.toBeInstanceOf(LaneBusyForLoginError)
    await login.release()
  })

  it('登录放手之后，采集照常拿得到', async () => {
    const f = fakeLauncher()
    const m = new RecipeSessionManager(() => f.launcher)
    const login = await m.acquire(spec, 'about:blank', 'commit', 'login')
    await login.release()
    const harvest = await m.acquire(spec, 'https://x.test/')
    expect(harvest.rawPage).toBeTruthy()
    await harvest.release()
  })

  it('采集之间照常排队 —— 快速失败只针对登录，不是把并发拆了', async () => {
    const f = fakeLauncher()
    const m = new RecipeSessionManager(() => f.launcher)
    const a = await m.acquire(spec, 'https://x.test/')
    let got = false
    const pending = m.acquire(spec, 'https://x.test/').then((l) => { got = true; return l })
    await Promise.resolve()
    expect(got).toBe(false) // 排着，没有被拒
    await a.release()
    await (await pending).release()
    expect(got).toBe(true)
  })

  it('登录自己不会被登录挡住 —— 闸门只拦采集', async () => {
    const f = fakeLauncher()
    const m = new RecipeSessionManager(() => f.launcher)
    const first = await m.acquire(spec, 'about:blank', 'commit', 'login')
    let second: { release: () => Promise<void> } | null = null
    const p = m.acquire(spec, 'about:blank', 'commit', 'login').then((l) => (second = l))
    await first.release()
    await p
    expect(second).not.toBeNull()
    await second!.release()
  })
})

describe('RecipeSessionManager 复用前探活', () => {
  /** launcher 同上，但 transport.url 可以被指定为"这个 tab 已经没了"。 */
  function withLiveness() {
    const f = fakeLauncher()
    const dead = new Set<number>()
    const urlCalls: number[] = []
    const t = f.launcher as { url: Transport['url'] }
    t.url = async (rawPage: unknown) => {
      const id = (rawPage as { id: number }).id
      urlCalls.push(id)
      if (dead.has(id)) throw new Error('No tab with given id')
      return 'https://demo.test/'
    }
    return { ...f, dead, urlCalls }
  }
  const persistentSpec = { facility: 'demo', lifecycle: 'persistent' as const, visibility: 'unattended' as const }

  it('丢掉已经死掉的 lane 并重建，而不是把死记录递出去', async () => {
    const f = withLiveness()
    const m = new RecipeSessionManager(() => f.launcher)
    const first = await m.acquire(persistentSpec, 'https://demo.test/')
    await first.release()

    f.dead.add(1)                                   // 用户手动关掉了 tab 1
    const second = await m.acquire(persistentSpec, 'https://demo.test/')
    await second.release()

    // 重新开了一个，而不是把死掉的 rawPage 再递一次
    expect(f.launches).toHaveLength(2)
    expect((second.rawPage as { id: number }).id).toBe(2)
  })

  it('活着的 lane 照常复用，不会因为多探一次就重建', async () => {
    const f = withLiveness()
    const m = new RecipeSessionManager(() => f.launcher)
    const a = await m.acquire(persistentSpec, 'https://demo.test/')
    await a.release()
    const b = await m.acquire(persistentSpec, 'https://demo.test/')
    await b.release()
    expect(f.launches).toHaveLength(1)              // 复用，没重开
    expect((b.rawPage as { id: number }).id).toBe(1)
  })

  it('死一次之后能自愈——第三次搜索不该还撞同一条死记录', async () => {
    // 这条正是活体症状：换个关键词重搜还是报错。丢弃必须真的把它从 map 里摘掉。
    const f = withLiveness()
    const m = new RecipeSessionManager(() => f.launcher)
    await (await m.acquire(persistentSpec, 'https://demo.test/')).release()
    f.dead.add(1)
    await (await m.acquire(persistentSpec, 'https://demo.test/')).release()   // 重建成 tab 2
    const third = await m.acquire(persistentSpec, 'https://demo.test/')
    await third.release()
    expect(f.launches).toHaveLength(2)              // 第三次复用了活着的 tab 2
    expect((third.rawPage as { id: number }).id).toBe(2)
  })

  it('探活自带死线：标签不答话时不能一直等中继的 30 秒', async () => {
    // 活体 2026-07-29：用户一次搜索里 xhs 和 douyin **同时**报 `timed out after 25000ms`。
    // 真相不是两个源都坏了，是两条 lane 都是上个后端进程留下的孤儿——探活走中继的默认
    // 超时（30s），比每个成员 25s 的预算还长，于是探活本身把预算烧光了。
    const f = withLiveness()
    const t = f.launcher as { url: Transport['url'] }
    t.url = () => new Promise(() => {}) // 永不 settle：死标签就是这个形状
    const m = new RecipeSessionManager(() => f.launcher)
    const first = await m.acquire(persistentSpec, 'https://demo.test/')
    await first.release()
    const started = Date.now()
    const second = await m.acquire(persistentSpec, 'https://demo.test/')
    await second.release()
    // 探不通 → 当死的 → 重建，而且要快。给 10s 的断言余量，真实死线是 2s。
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(f.launches.length).toBe(2)
  }, 20_000)

  it('一次性 lane 不探活——它每次都新建，没有可复用的记录', async () => {
    const f = withLiveness()
    const m = new RecipeSessionManager(() => f.launcher)
    await (await m.acquire(
      { facility: 'demo', lifecycle: 'one-shot', visibility: 'unattended' }, 'https://demo.test/',
    )).release()
    expect(f.urlCalls).toHaveLength(0)
  })
})
