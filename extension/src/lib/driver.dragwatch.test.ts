import { describe, it, expect, vi } from 'vitest'

// ── fake chrome：在标签组基础上补 tabs.onUpdated（进/出组的可靠信号：changeInfo.groupId）──
// driver.ts 顶层即注册 chrome.tabs.onUpdated.addListener（模块加载副作用），故 fake 须在
// import 前就位并捕获 listener；_fireTabUpdated 手动派发一次事件并 await 处理器（listener
// 回传 onTabGroupChange 的 promise，真 chrome 忽略返回值，测试借它等串行队列排空）。
function makeChrome() {
  const session: Record<string, unknown> = {}
  const tabsUpdated: Array<(tabId: number, changeInfo: { groupId?: number }) => unknown> = []
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
      onUpdated: { addListener: vi.fn((fn: (t: number, c: { groupId?: number }) => unknown) => tabsUpdated.push(fn)) },
    },
    tabGroups: { onUpdated: { addListener: vi.fn() } },
    windows: { create: vi.fn(), getAll: vi.fn(async () => [{ id: 1 }]) },
    debugger: {
      onEvent: { addListener: vi.fn() },
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({})),
    },
    _session: session,
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

describe('拖入授权 / 拖出撤销监听', () => {
  it('拖入会话组：进可操作集合、出身标记 adopted、现身 groupMembers', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created') // 建组 777
    await chrome._fireTabUpdated(9, { groupId: 777 }) // 用户把 tab9 拖进组
    expect(await mod.tabOrigin(9)).toBe('adopted')
    expect(await mod.groupMembers()).toContainEqual({ tabId: 9, origin: 'adopted' })
  })

  it('拖出会话组（groupId 变 -1）：chrome.debugger.detach 被调、移出成员表', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    await mod.addTabToGroup(6, 'adopted')
    await chrome._fireTabUpdated(6, { groupId: -1 }) // 拖出组
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 6 })
    expect(await mod.tabOrigin(6)).toBeUndefined()
    expect((await mod.groupMembers()).map((m) => m.tabId)).toEqual([5])
  })

  it('移入别的组（groupId 变走）：同样视为撤销，detach + 移出', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(6, 'adopted') // 组 777
    await chrome._fireTabUpdated(6, { groupId: 888 }) // 被拖去另一个组
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 6 })
    expect(await mod.tabOrigin(6)).toBeUndefined()
  })

  it('无关 tab 的组变化（非本会话组）：不采纳、不 detach', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created') // 组 777
    await chrome._fireTabUpdated(9, { groupId: 888 }) // 进了别的组，与本会话无关
    expect(await mod.tabOrigin(9)).toBeUndefined()
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
  })

  it('程序化建组回声（onUpdated 报 created tab 进本组）不改其出身为 adopted', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created') // 组 777
    await chrome._fireTabUpdated(5, { groupId: 777 }) // chrome.tabs.group() 的事件回声
    expect(await mod.tabOrigin(5)).toBe('created') // 已是成员 → 不被覆写成 adopted
  })

  it('拖出的 tab 若在 owned：一并清出 owned 集合', async () => {
    const chrome = makeChrome()
    chrome._session.ownedTabs = [6]
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(6, 'created')
    await chrome._fireTabUpdated(6, { groupId: -1 })
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 6 })
    expect(chrome._session.ownedTabs).toEqual([]) // owned 快照清空
  })

  it('非组归属的 tab 更新（无 groupId 字段）：忽略', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    await chrome._fireTabUpdated(5, {}) // 例如 status/title 变化，与组无关
    expect(await mod.tabOrigin(5)).toBe('created')
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
  })
})
