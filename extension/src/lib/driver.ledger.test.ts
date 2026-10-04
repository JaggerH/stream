import { describe, it, expect, vi, afterEach } from 'vitest'

// ── 出身账本的存放处与失效判据 ──
//
// 账本（会话组 id + 每个 tab 的出身）原来存 chrome.storage.session，而 session **扩展一重载
// 就被清空**。清空后 reconcileOnWake 只能靠 findExistingGroup 认领遗留组、认不出出身，于是
// 一律标 'adopted' —— 那是"我不知道，往安全方向猜"的默认值，不是"我看见用户拖进来"的观测
// 事实。后果：开发期每重载一次扩展，组里所有 probe 就永久免疫回收，reclaimOrphanTabs 形同虚设。
//
// 搬到 storage.local 之后账本跨浏览器重启也活着，而 **tabId 只在一次浏览器会话内有意义**
// （重启后会被复用给完全无关的标签）。所以搬家的同时必须回答"旧记录怎么失效"：
//
//   判据 = chrome.runtime.onStartup。文档写死它"Fired when a profile that has this extension
//   installed first starts up" —— 只在浏览器 profile 启动时触发，**扩展重载不触发**。
//   于是：重载 → 没有 onStartup → 账本原样留着（出身保住）；浏览器重启 → onStartup → 账本作废。
//
// 还有一道**时序**闸门：浏览器启动时 SW 顶层代码和 onStartup 派发几乎同时发生，不等一下就
// 可能"拿着上一次会话的账本先动手、onStartup 随后才到"。所以本次扩展加载的第一次 hydrate
// 会给 onStartup 留一个短暂宽限期（只在真有账本时等，且每次扩展加载只等一次——判定结果记在
// storage.session 里，SW 被回收重启不会重等）。

type Origin = 'probe' | 'created' | 'adopted'

/** fake chrome：local / session 两套独立内存存储 + 一个可手动触发的 onStartup。 */
function makeChrome(opts: { ledger?: { groupId: number; members: [number, Origin][] }; live?: number[]; existingGroup?: number } = {}) {
  const local: Record<string, unknown> = {}
  const session: Record<string, unknown> = {}
  if (opts.ledger) {
    local.tabGroup = opts.ledger
  }
  const live = new Set(opts.live ?? [])
  const startupListeners: Array<() => unknown> = []
  const gid = opts.existingGroup ?? 777
  return {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: local[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(local, obj)
        }),
        remove: vi.fn(async (key: string) => {
          delete local[key]
        }),
      },
      session: {
        get: vi.fn(async (key: string) => ({ [key]: session[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(session, obj)
        }),
      },
    },
    runtime: {
      onStartup: { addListener: vi.fn((fn: () => unknown) => startupListeners.push(fn)) },
    },
    tabs: {
      group: vi.fn(async (o: { groupId?: number; tabIds: number[] }) => {
        o.tabIds.forEach((t) => live.add(t))
        return o.groupId ?? gid
      }),
      ungroup: vi.fn(async (tabId: number) => {
        live.delete(tabId)
      }),
      get: vi.fn(async (tabId: number) => ({
        id: tabId,
        url: 'https://a.example/x',
        title: 'T',
        groupId: live.has(tabId) ? gid : -1,
      })),
      query: vi.fn(async (q: { groupId?: number }) => (q.groupId === gid ? [...live].map((id) => ({ id })) : [])),
      create: vi.fn(async () => ({ id: 5 })),
      remove: vi.fn(async (tabId: number) => {
        live.delete(tabId)
      }),
      onUpdated: { addListener: vi.fn() },
    },
    tabGroups: {
      query: vi.fn(async (q: { title?: string }) => (q.title === 'Stream' ? [{ id: gid, title: 'Stream' }] : [])),
      update: vi.fn(async () => {}),
      onUpdated: { addListener: vi.fn() },
    },
    windows: { create: vi.fn(), getAll: vi.fn(async () => [{ id: 1 }]) },
    debugger: {
      onEvent: { addListener: vi.fn() },
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({})),
    },
    _local: local,
    _session: session,
    /** 模拟 Chrome 在浏览器启动时派发 onStartup。 */
    _fireStartup: () => startupListeners.forEach((f) => f()),
  }
}

type FakeChrome = ReturnType<typeof makeChrome>

async function loadModule(chrome: FakeChrome) {
  vi.stubGlobal('chrome', chrome)
  vi.resetModules()
  return import('./driver.ts')
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** 把宽限期推过去 = 走"没有 onStartup"那条路（扩展重载）。用假定时器，别真等 2 秒。 */
async function passGrace(): Promise<void> {
  await vi.advanceTimersByTimeAsync(3000)
}

describe('账本存 storage.local —— 扩展重载不再丢出身', () => {
  it('【核心】重载后（session 空、local 有账本）probe 仍是 probe，不再被降级成 adopted', async () => {
    // 这正是 reclaimOrphanTabs 失效的病根：出身一丢，孤儿探针就永久免疫回收。
    vi.useFakeTimers()
    const chrome = makeChrome({ ledger: { groupId: 777, members: [[5, 'probe']] }, live: [5] })
    const mod = await loadModule(chrome)

    const origin = mod.tabOrigin(5)
    await passGrace()
    expect(await origin).toBe('probe')
    expect(await mod.groupId()).toBe(777)
  })

  it('新建 tab 的出身写进 storage.local（不再写 session）', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)

    await mod.addTabToGroup(5, 'probe')

    expect(chrome._local.tabGroup).toEqual({ groupId: 777, members: [[5, 'probe']] })
    expect(chrome._session.tabGroup).toBeUndefined()
  })

  it('重载后 reclaimOrphanTabs 能收孤儿探针（本次任务的目的）', async () => {
    vi.useFakeTimers()
    const chrome = makeChrome({ ledger: { groupId: 777, members: [[5, 'probe']] }, live: [5] })
    const mod = await loadModule(chrome)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ tabIds: [] }) })))

    const reclaimed = mod.reclaimOrphanTabs('http://127.0.0.1:8900', { minAgeMs: 0 })
    await passGrace()
    await reclaimed

    expect(chrome.tabs.remove).toHaveBeenCalledWith(5)
  })
})

describe('浏览器重启 → onStartup → 账本作废（tabId 跨会话会被复用）', () => {
  it('【红线】onStartup 之后，上一次会话记为 probe 的 tabId 绝不被 remove', async () => {
    // 重启后 tabId 5 可能是用户的任意一个标签。拿着过期账本动手 = 关掉陌生标签。
    const chrome = makeChrome({ ledger: { groupId: 777, members: [[5, 'probe']] }, live: [5] })
    const mod = await loadModule(chrome)
    chrome._fireStartup()

    await mod.reconcileOnWake()

    expect(chrome.tabs.remove).not.toHaveBeenCalled()
    // 认不出出身 → 仍按保守默认收编为 adopted（红线：绝不 remove）
    expect(await mod.tabOrigin(5)).toBe('adopted')
  })

  it('作废是把 local 里的账本真正删掉，不是只在内存里绕过', async () => {
    const chrome = makeChrome({ ledger: { groupId: 777, members: [[5, 'probe']] }, live: [] })
    const mod = await loadModule(chrome)
    chrome._fireStartup()

    await mod.groupId()

    expect((chrome._local.tabGroup as { members?: unknown[] } | undefined)?.members ?? []).not.toContainEqual([5, 'probe'])
  })
})

describe('时序闸门：别抢在 onStartup 前面动手', () => {
  it('有账本时，第一次 hydrate 给 onStartup 留宽限期；期内到达仍作废账本', async () => {
    vi.useFakeTimers()
    const chrome = makeChrome({ ledger: { groupId: 777, members: [[5, 'probe']] }, live: [5] })
    const mod = await loadModule(chrome)

    // SW 顶层先跑到这里，onStartup 还没派发
    const pending = mod.tabOrigin(5)
    await vi.advanceTimersByTimeAsync(50)
    chrome._fireStartup() // 宽限期内到达

    expect(await pending).toBeUndefined() // 账本已作废：出身无从谈起（组要靠 reconcile 重新认领）
  })

  it('宽限期内没有 onStartup（= 扩展重载）→ 账本原样保留', async () => {
    vi.useFakeTimers()
    const chrome = makeChrome({ ledger: { groupId: 777, members: [[5, 'probe']] }, live: [5] })
    const mod = await loadModule(chrome)

    const pending = mod.tabOrigin(5)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(await pending).toBe('probe')
  })

  it('没有账本时不等宽限期（全新会话不该被拖慢）', async () => {
    vi.useFakeTimers()
    const chrome = makeChrome()
    const mod = await loadModule(chrome)

    // 不推进定时器就能拿到结果 = 没在等
    await expect(mod.groupId()).resolves.toBeNull()
  })

  it('判定每次扩展加载只做一次：SW 回收重启（session 里的判定标记还在）不再重等', async () => {
    vi.useFakeTimers()
    const chrome = makeChrome({ ledger: { groupId: 777, members: [[5, 'probe']] }, live: [5] })
    const mod1 = await loadModule(chrome)
    const first = mod1.tabOrigin(5)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await first).toBe('probe')

    // 同一次扩展加载内 SW 被回收又醒来：模块内存清空，storage 原样
    const mod2 = await loadModule(chrome)
    await expect(mod2.tabOrigin(5)).resolves.toBe('probe') // 不推进定时器 = 没重等
  })
})
