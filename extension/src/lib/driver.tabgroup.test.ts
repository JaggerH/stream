import { describe, it, expect, vi } from 'vitest'

// ── fake chrome：内存 storage.session + tabs.group + 各监听口 ──
// driver.ts 顶层 import 即 chrome.debugger.onEvent.addListener(...)（模块加载副作用），
// 故 mock 须在 import 之前就位；每个 case 用独立 chrome + vi.resetModules() 拿到全新的
// 模块内存态（groupMem/ownedMem 是模块单例）。
function makeChrome() {
  const session: Record<string, unknown> = {}
  // 出身账本存 storage.local（跨扩展重载存活，失效判据见 driver.ts 的 ensureLedgerFresh）；
  // ownedTabs 仍在 session。
  const local: Record<string, unknown> = {}
  return {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: session[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(session, obj)
        }),
      },
      local: {
        get: vi.fn(async (key: string) => ({ [key]: local[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(local, obj)
        }),
        remove: vi.fn(async (key: string) => {
          delete local[key]
        }),
      },
    },
    tabs: {
      // 无 groupId → 建新组（返回新 id）；带 groupId → 追加进该组（返回同 id）
      group: vi.fn(async (opts: { groupId?: number; tabIds: number[] }) => opts.groupId ?? 777),
      create: vi.fn(),
      remove: vi.fn(async () => {}),
      query: vi.fn(async () => []),
      onUpdated: { addListener: vi.fn() }, // 模块加载即注册拖入/拖出监听，须存在
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
    _local: local,
  }
}

type FakeChrome = ReturnType<typeof makeChrome>

async function loadModule(chrome: FakeChrome) {
  vi.stubGlobal('chrome', chrome)
  vi.resetModules()
  return import('./driver.ts')
}

describe('会话级标签组', () => {
  it('首个 tab 建新组：chrome.tabs.group({tabIds}) 且记住 groupId', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    const gid = await mod.addTabToGroup(5, 'created')
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [5] })
    expect(gid).toBe(777)
    expect(await mod.groupId()).toBe(777)
  })

  it('后续 tab 追加进已有组：chrome.tabs.group({groupId, tabIds})', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    await mod.addTabToGroup(6, 'adopted')
    expect(chrome.tabs.group).toHaveBeenLastCalledWith({ groupId: 777, tabIds: [6] })
  })

  it('成员表带出身标记，持久化进 chrome.storage.local', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    await mod.addTabToGroup(6, 'adopted')
    expect(chrome._local.tabGroup).toEqual({
      groupId: 777,
      members: [
        [5, 'created'],
        [6, 'adopted'],
      ],
    })
    expect(await mod.groupMembers()).toEqual([
      { tabId: 5, origin: 'created' },
      { tabId: 6, origin: 'adopted' },
    ])
  })

  it('SW 重启：hydrate 从 storage 恢复组成员 + 出身 + groupId', async () => {
    const chrome = makeChrome()
    chrome._local.tabGroup = {
      groupId: 42,
      members: [
        [10, 'created'],
        [20, 'adopted'],
      ],
    }
    const mod = await loadModule(chrome)
    expect(await mod.groupId()).toBe(42)
    expect(await mod.tabOrigin(10)).toBe('created')
    expect(await mod.tabOrigin(20)).toBe('adopted')
    expect(await mod.groupMembers()).toEqual([
      { tabId: 10, origin: 'created' },
      { tabId: 20, origin: 'adopted' },
    ])
  })

  it('保留现有 owned 机制不破：reconcileOnWake 仍从 ownedTabs 快照工作', async () => {
    const chrome = makeChrome()
    chrome._session.ownedTabs = [1, 2]
    const mod = await loadModule(chrome)
    await mod.reconcileOnWake()
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 1 })
    expect(chrome.tabs.remove).toHaveBeenCalledWith(1)
    expect(chrome._session.ownedTabs).toEqual([]) // 清空快照
  })

  // ── 问题 1：hydrateGroup 双重 hydrate 竞态破坏「一会话一组」 ──
  // groupMem 冷时，队列内 hydrate（建组写路径）与队列外只读 hydrate（groupId 访问器）并发。
  // buggy 版 hydrateGroup 的 `if (groupMem)` 守卫在 await 之前判过一次即失效，await 后无条件
  // 覆盖单例——后写者（用冷快照的只读路径）胜，把已立好 groupId 的单例覆成空对象；下一个
  // addTabToGroup 误判「无组」→ 建出第二个组。修法 = memoize in-flight hydrate promise（once-guard）。
  it('groupMem 冷时并发建组+只读 groupId：只建一个组（不双 hydrate 覆盖单例）', async () => {
    const chrome = makeChrome()
    // 账本时效判定在本用例外（标记已在 session 里）——这里只测 hydrate 的双读竞态
    chrome._session.tabGroupChecked = true
    // 让账本的 storage.get 可手动定序，且快照锁定在「调用时刻」（真 chrome 语义：读时取值、稍后送达）
    const gets: Array<() => void> = []
    chrome.storage.local.get = vi.fn((key: string) => {
      const snap = { [key]: chrome._local[key] }
      return new Promise<Record<string, unknown>>((resolve) => {
        gets.push(() => resolve(snap))
      })
    }) as unknown as FakeChrome['storage']['local']['get']
    const mod = await loadModule(chrome)

    const p5 = mod.addTabToGroup(5, 'created') // 走 groupQueue 一跳后才发 get
    const pRead = mod.groupId() // 同步进 hydrate，随后发 get（冷快照）
    // 放行到「两条路径都已发出自己的 get」为止。不能只 await 一个微任务：hydrate 前面还隔着
    // 账本时效判定的一次 storage.session.get（见 driver.ts ensureLedgerFresh）。
    await new Promise((r) => setTimeout(r, 0))

    // 后发的建组(write) get 先落地：立好组、持久化 groupId
    gets.pop()?.()
    await p5
    // 先发的只读(read) get 后落地：它读到的是冷快照，若覆盖单例即 bug
    gets.pop()?.()
    await pRead

    await mod.addTabToGroup(6, 'adopted')
    const groupCalls = (chrome.tabs.group as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ groupId?: number; tabIds: number[] }]
    >
    const createCalls = groupCalls.filter((c) => c[0].groupId == null)
    expect(createCalls).toEqual([[{ tabIds: [5] }]]) // 只有一次「建新组」
    expect(chrome.tabs.group).toHaveBeenLastCalledWith({ groupId: 777, tabIds: [6] }) // tab6 是追加
  })

  // ── 问题 2：groupId 失效自锁 ──
  // 用户手动解散组后 g.groupId 陈旧，chrome.tabs.group({groupId:陈旧,...}) 会 reject，
  // buggy 版让整个 addTabToGroup 抛错、`g.groupId=groupId` 那行永不到达→陈旧 id 留着→
  // 后续每次都撞死 id 永久失败。修法 = 带 groupId 建组失败则作为新组重建。
  it('groupId 陈旧（组被手动解散）：作为新组重建，不永久自锁', async () => {
    const chrome = makeChrome()
    chrome._local.tabGroup = { groupId: 99, members: [[1, 'created']] } // 预置陈旧组
    chrome.tabs.group = vi.fn(async (opts: { groupId?: number; tabIds: number[] }) => {
      if (opts.groupId != null) throw new Error('No group with id 99') // 陈旧组已被解散→reject
      return 555 // 无 groupId → 建新组
    }) as unknown as FakeChrome['tabs']['group']
    const mod = await loadModule(chrome)

    const gid = await mod.addTabToGroup(7, 'created')
    expect(gid).toBe(555) // 重建成新组
    expect(await mod.groupId()).toBe(555) // 单例 groupId 已更新，不再撞陈旧 id
    expect(chrome.tabs.group).toHaveBeenNthCalledWith(1, { groupId: 99, tabIds: [7] }) // 先试陈旧组
    expect(chrome.tabs.group).toHaveBeenNthCalledWith(2, { tabIds: [7] }) // reject 后作为新组重建
  })
})
