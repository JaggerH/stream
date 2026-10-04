import { describe, it, expect, vi } from 'vitest'

// ── fake chrome：标签组 + tabs.onUpdated（拖入/拖出信号）+ tabs.get（list 取 url/title）──
// driver.ts 顶层即注册 chrome.debugger.onEvent / chrome.tabs.onUpdated 监听（模块加载副作用），
// 故 fake 须在 import 前就位；每 case 独立 chrome + vi.resetModules() 拿全新模块内存态。
function makeChrome() {
  const session: Record<string, unknown> = {}
  const tabsUpdated: Array<(tabId: number, changeInfo: { groupId?: number }) => unknown> = []
  // groupId 省略 = 在会话组内（多数 case）；显式给 -1 表示"存在但不在组"
const tabInfo: Record<number, { url?: string; title?: string; groupId?: number }> = {}
  return {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: session[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(session, obj)
        }),
      },
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    },
    tabs: {
      group: vi.fn(async (opts: { groupId?: number; tabIds: number[] }) => opts.groupId ?? 777),
      create: vi.fn(),
      remove: vi.fn(async () => {}),
      query: vi.fn(async () => []),
      // groupId 默认在会话组内（归属判据以浏览器为准，账本只是出身缓存）；tabInfo 可覆盖
      get: vi.fn(async (tabId: number) => {
        const info = tabInfo[tabId]
        if (!info) throw new Error(`No tab with id ${tabId}`)
        return { id: tabId, groupId: 777, ...info }
      }),
      onUpdated: {
        addListener: vi.fn((fn: (t: number, c: { groupId?: number }) => unknown) => tabsUpdated.push(fn)),
      },
    },
    tabGroups: { onUpdated: { addListener: vi.fn() } },
    windows: { create: vi.fn(), getAll: vi.fn(async () => [{ id: 1 }]) },
    debugger: {
      onEvent: { addListener: vi.fn() },
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({ ok: true })),
    },
    _session: session,
    _tabInfo: tabInfo,
    _fireTabUpdated: (tabId: number, changeInfo: { groupId?: number }) =>
      Promise.all(tabsUpdated.map((l) => l(tabId, changeInfo))),
  }
}

type FakeChrome = ReturnType<typeof makeChrome>

async function loadModule(chrome: FakeChrome) {
  vi.stubGlobal('chrome', chrome)
  vi.resetModules()
  return import('./driver.ts')
}

describe('list 枚举组内 tab', () => {
  it('返回组内每个 tab 的 {tabId, url, title}（插入序）', async () => {
    const chrome = makeChrome()
    chrome._tabInfo[5] = { url: 'https://a.test/', title: 'A' }
    chrome._tabInfo[6] = { url: 'https://b.test/', title: 'B' }
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    await mod.addTabToGroup(6, 'adopted')
    const reply = await mod.dispatch({ id: 1, op: 'list' })
    // 这一条钉的是 list 的**内容**，不是回执的字段全集：每条回执还带一个 `swMs`
    // （SW 侧耗时，后端拿它减出 WS 那两段），所以这里比 result 而不是整个对象。
    expect(reply.id).toBe(1)
    expect(reply.result).toEqual({
      tabs: [
        { tabId: 5, url: 'https://a.test/', title: 'A', origin: 'created', grouped: true, active: false },
        { tabId: 6, url: 'https://b.test/', title: 'B', origin: 'adopted', grouped: true, active: false },
      ],
    })
  })

  it('组外 tab 不出现在 list 结果（只枚举组成员表）', async () => {
    const chrome = makeChrome()
    chrome._tabInfo[5] = { url: 'https://a.test/', title: 'A' }
    chrome._tabInfo[99] = { url: 'https://evil.test/', title: 'Evil', groupId: -1 } // 存在但不在组
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    const reply = await mod.dispatch({ id: 2, op: 'list' })
    expect(reply.result).toEqual({ tabs: [{ tabId: 5, url: 'https://a.test/', title: 'A', origin: 'created', grouped: true, active: false }] })
  })

  it('成员已消失（tabs.get 抛错）：跳过，不阻断枚举', async () => {
    const chrome = makeChrome()
    chrome._tabInfo[5] = { url: 'https://a.test/', title: 'A' }
    // tab6 在组成员表但 chrome 里已不存在（监听尚未及移除）
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    await mod.addTabToGroup(6, 'created')
    const reply = await mod.dispatch({ id: 3, op: 'list' })
    expect(reply.result).toEqual({ tabs: [{ tabId: 5, url: 'https://a.test/', title: 'A', origin: 'created', grouped: true, active: false }] })
  })
})

describe('归属边界：组内可操作 / 组外拒', () => {
  it('组内 tab 的 CDP 命令：attach + sendCommand 执行', async () => {
    const chrome = makeChrome()
    chrome._tabInfo[5] = { url: 'https://a.test/', title: 'A' }
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    const reply = await mod.dispatch({ id: 3, tabId: 5, method: 'Runtime.evaluate', params: { expression: '1' } })
    expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 5 }, '1.3')
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 5 }, 'Runtime.evaluate', { expression: '1' })
    expect(reply).toMatchObject({ id: 3, result: { ok: true } })
  })

  it('组外 tab 的 CDP 命令：清晰错、绝不 attach', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created') // 组内只有 5
    const reply = await mod.dispatch({ id: 4, tabId: 99, method: 'Runtime.evaluate', params: {} })
    expect(reply.id).toBe(4)
    expect(reply.error).toMatch(/99/)
    expect(reply.error).toMatch(/group|组/i)
    expect(chrome.debugger.attach).not.toHaveBeenCalled()
  })

  it('adopted（拖入）tab 也算组内可操作', async () => {
    const chrome = makeChrome()
    chrome._tabInfo[9] = { url: 'https://user.test/', title: 'U' }
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created') // 建组 777
    await chrome._fireTabUpdated(9, { groupId: 777 }) // 用户拖入 tab9 → adopted
    const reply = await mod.dispatch({ id: 5, tabId: 9, method: 'Runtime.evaluate', params: {} })
    expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 9 }, '1.3')
    expect(reply).toMatchObject({ id: 5, result: { ok: true } })
  })

  it('subscribe 组外 tab 被拒（清晰错、不 attach）', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    const reply = await mod.dispatch({ id: 6, op: 'subscribe', tabId: 99, domains: ['Network'] })
    expect(reply.error).toMatch(/99/)
    expect(chrome.debugger.attach).not.toHaveBeenCalled()
  })

  it('closeTab 组外 tab 被拒（清晰错、不 remove）', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    const reply = await mod.dispatch({ id: 7, op: 'closeTab', tabId: 99 })
    expect(reply.error).toMatch(/99/)
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
  })
})

describe('newTab 自建 tab 自动入组（组成员判据下才可自 attach）', () => {
  it('background 档：创建的 tab 入会话组、可被后续 CDP 命令操作', async () => {
    const chrome = makeChrome()
    chrome._tabInfo[50] = { url: 'https://a.test/', title: 'A' }
    chrome.tabs.create = vi.fn(async () => ({ id: 50 })) as unknown as FakeChrome['tabs']['create']
    // waitForNav 走 Runtime.evaluate 读 readyState —— 让它一次即达标
    chrome.debugger.sendCommand = vi.fn(async (_t: unknown, method: string) => {
      if (method === 'Runtime.evaluate')
        return { result: { value: JSON.stringify({ rs: 'complete', href: 'https://a.test/' }) } }
      return { ok: true }
    }) as unknown as FakeChrome['debugger']['sendCommand']
    const mod = await loadModule(chrome)
    const reply = await mod.dispatch({ id: 1, op: 'newTab', url: 'https://a.test/', background: true })
    expect(reply).toMatchObject({ id: 1, result: { tabId: 50 } })
    // 自建 tab 现身组成员表（background 档没人看着 → 出身 probe），且 list 能枚举到它
    expect(await mod.tabOrigin(50)).toBe('probe')
    expect((await mod.groupMembers()).map((m) => m.tabId)).toContain(50)
  })
})
