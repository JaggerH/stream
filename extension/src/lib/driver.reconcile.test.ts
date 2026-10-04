import { describe, it, expect, vi } from 'vitest'

// ── SW 醒来与浏览器对账（不是无差别回收）──
// 病根：账本（storage.session 的成员表）被当成真相，可浏览器才是真相。MV3 SW 一空闲就死，
// 它死着的那段时间里用户的拖入/拖出/关 tab 全都没人听见——醒来时账本已经不对了。
// 旧行为 reapOrphanTabs 在 SW 每次醒来时无差别回收组内自建 tab：用户正看着的交互 tab
// （cdp_look target:'chrome' interactive:true / kept:true）会被从眼皮底下关掉，用户拖入的授权被静默撤销。
//
// 新行为：醒来先对账（浏览器真实组成员为准），只回收「没人看的后台探针」。
function makeChrome(opts: { groupId?: number; members?: [number, string][]; live?: number[] } = {}) {
  const session: Record<string, unknown> = {} // ownedTabs 等只需活到 SW 回收的东西
  const local: Record<string, unknown> = {} // 出身账本（跨扩展重载存活）
  if (opts.groupId !== undefined) local.tabGroup = { groupId: opts.groupId, members: opts.members ?? [] }
  // 浏览器眼里此刻真实在组内的 tab（对账的真相源）
  const live = new Set(opts.live ?? [])
  const tabsUpdated: Array<(tabId: number, changeInfo: { groupId?: number }) => unknown> = []
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
      group: vi.fn(async (o: { groupId?: number; tabIds: number[] }) => {
        o.tabIds.forEach((t) => live.add(t))
        return o.groupId ?? 777
      }),
      ungroup: vi.fn(async (tabId: number) => {
        live.delete(tabId)
      }),
      // 真相源：tab 此刻真实的组归属；不在 live 里 = 已被拖出（groupId -1）
      get: vi.fn(async (tabId: number) => ({
        id: tabId,
        url: 'https://a.example/x',
        title: 'T',
        groupId: live.has(tabId) ? (opts.groupId ?? 777) : -1,
      })),
      query: vi.fn(async (q: { groupId?: number }) =>
        q.groupId != null && q.groupId === (opts.groupId ?? 777) ? [...live].map((id) => ({ id })) : [],
      ),
      create: vi.fn(async () => ({ id: 5 })),
      remove: vi.fn(async (tabId: number) => {
        live.delete(tabId)
      }),
      onUpdated: { addListener: vi.fn((fn: (t: number, c: { groupId?: number }) => unknown) => tabsUpdated.push(fn)) },
    },
    tabGroups: { onUpdated: { addListener: vi.fn() } },
    windows: { create: vi.fn(), getAll: vi.fn(async () => [{ id: 1 }]) },
    debugger: {
      onEvent: { addListener: vi.fn() },
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({ result: { value: JSON.stringify({ rs: 'complete', href: 'https://a.example/x' }) } })),
    },
    _session: session,
    _local: local,
    _live: live,
  }
}

type FakeChrome = ReturnType<typeof makeChrome>

async function loadModule(chrome: FakeChrome) {
  vi.stubGlobal('chrome', chrome)
  vi.resetModules()
  return import('./driver.ts')
}

describe('SW 醒来对账：只回收没人看的探针', () => {
  it('【核心】交互 tab（created）不被 remove —— 用户可能正看着它', async () => {
    // 这正是 close 是「命令」而非 finally 的前提：AI 一轮走完主动关、或用户手动关，
    // 都不该由「SW 恰好重启了一次」代劳。
    const chrome = makeChrome({ groupId: 777, members: [[5, 'created']], live: [5] })
    const mod = await loadModule(chrome)

    await mod.reconcileOnWake()

    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(5)
    expect(await mod.tabOrigin(5)).toBe('created') // 仍在组、仍可操作
  })

  it('后台探针（probe）仍被回收 —— 没人看的泄漏必须有人兜底', async () => {
    const chrome = makeChrome({ groupId: 777, members: [[7, 'probe']], live: [7] })
    const mod = await loadModule(chrome)

    await mod.reconcileOnWake()

    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 7 })
    expect(chrome.tabs.remove).toHaveBeenCalledWith(7)
    expect(await mod.tabOrigin(7)).toBeUndefined()
  })

  it('【红线】用户拖入(adopted)的 tab：不 remove，且授权保留（不静默撤销）', async () => {
    const chrome = makeChrome({ groupId: 777, members: [[9, 'adopted']], live: [9] })
    const mod = await loadModule(chrome)

    await mod.reconcileOnWake()

    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(9)
    // 授权是用户给的，SW 重启不是撤销授权的理由
    expect(await mod.tabOrigin(9)).toBe('adopted')
  })
})

describe('独立窗组（openTab ownWindow）', () => {
  // 主组里没有它、它在自己那扇窗的组里——醒来对账不能把它当成"被拖出去了"撤掉
  function withWindowGroup(windowLive: number[]) {
    const chrome = makeChrome({ groupId: 777, members: [[5, 'adopted'], [30, 'created']], live: [5] })
    ;(chrome._local.tabGroup as { windowGroups?: number[] }).windowGroups = [888]
    const mainGet = chrome.tabs.get.getMockImplementation()!
    chrome.tabs.get.mockImplementation(async (tabId: number) =>
      windowLive.includes(tabId) ? { id: tabId, url: 'http://g.test/', title: 'G', groupId: 888 } : mainGet(tabId),
    )
    const mainQuery = chrome.tabs.query.getMockImplementation()!
    chrome.tabs.query.mockImplementation(async (q: { groupId?: number }) =>
      q.groupId === 888 ? windowLive.map((id) => ({ id })) : mainQuery(q),
    )
    return chrome
  }

  it('成员留着、照样可驱动，也不会被塞回主组', async () => {
    const chrome = withWindowGroup([30])
    const mod = await loadModule(chrome)
    await mod.reconcileOnWake()
    expect(await mod.tabOrigin(30)).toBe('created')
    expect(chrome.tabs.group).not.toHaveBeenCalledWith(expect.objectContaining({ tabIds: [30] }))
    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(30)
  })

  it('用户关了那扇窗 → 组从账本删掉、成员撤销', async () => {
    const chrome = withWindowGroup([])
    const mod = await loadModule(chrome)
    await mod.reconcileOnWake()
    expect(await mod.tabOrigin(30)).toBeUndefined()
    expect((chrome._local.tabGroup as { windowGroups?: number[] }).windowGroups ?? []).toEqual([])
  })
})

describe('SW 死期间漏掉的事件：醒来补账', () => {
  it('用户趁 SW 死时把 tab 拖出组 → 移出账本、detach，绝不 remove', async () => {
    // 账本说 9 在组，浏览器说它已不在（live 里没有）
    const chrome = makeChrome({ groupId: 777, members: [[9, 'adopted']], live: [] })
    const mod = await loadModule(chrome)

    await mod.reconcileOnWake()

    expect(await mod.tabOrigin(9)).toBeUndefined() // 撤销授权
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 9 })
    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(9) // 用户的 tab，还活着
  })

  it('自建 tab 被用户拖出组 → 也只移出账本，不 remove（拖出=这是我的了）', async () => {
    const chrome = makeChrome({ groupId: 777, members: [[5, 'created']], live: [] })
    const mod = await loadModule(chrome)

    await mod.reconcileOnWake()

    expect(await mod.tabOrigin(5)).toBeUndefined()
    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(5)
  })

  it('用户趁 SW 死时把 tab 拖进组 → 醒来采纳为 adopted', async () => {
    // 浏览器说 12 在组里，账本却没有它 —— 拖入即授权，事件漏了也要补上
    const chrome = makeChrome({ groupId: 777, members: [], live: [12] })
    const mod = await loadModule(chrome)

    await mod.reconcileOnWake()

    expect(await mod.tabOrigin(12)).toBe('adopted')
    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(12)
  })

  it('向后兼容：旧版 owned 残留（无组概念）仍被回收', async () => {
    const chrome = makeChrome()
    chrome._session.ownedTabs = [1, 2]
    const mod = await loadModule(chrome)

    await mod.reconcileOnWake()

    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 1 })
    expect(chrome.tabs.remove).toHaveBeenCalledWith(1)
    expect(chrome._session.ownedTabs).toEqual([])
  })
})

describe('归属判据以浏览器为准（账本可能过期）', () => {
  it('【安全】账本说在组、浏览器说已被拖出 → 拒绝 attach', async () => {
    // 拖出=撤销授权。若 onUpdated 事件在 SW 死/丢事件时漏掉，账本会残留一条陈旧授权；
    // 拿账本当准就等于对一个用户已经收回的 tab 动手。浏览器的 groupId 才是真相。
    const chrome = makeChrome({ groupId: 777, members: [[5, 'created']], live: [] })
    const mod = await loadModule(chrome)

    const res = await mod.dispatch({ id: 1, tabId: 5, method: 'Runtime.evaluate', params: { expression: '1' } })

    expect(res.error).toMatch(/group|组/i)
    expect(chrome.debugger.attach).not.toHaveBeenCalled()
  })

  it('账本与浏览器一致 → 放行', async () => {
    const chrome = makeChrome({ groupId: 777, members: [[5, 'created']], live: [5] })
    const mod = await loadModule(chrome)

    const res = await mod.dispatch({ id: 2, tabId: 5, method: 'Runtime.evaluate', params: { expression: '1' } })

    expect(res.error).toBeUndefined()
  })
})

describe('撤销授权时视觉与账本一致', () => {
  it('【红线】关 adopted tab：chrome.tabs.ungroup 移出组，绝不 remove', async () => {
    // 只从账本里删、不 ungroup 的话，tab 仍显示在会话组里（用户以为还授权着），
    // 而 AI 一碰就报「不在组内」—— 用户看到的和实际生效的对不上。
    const chrome = makeChrome({ groupId: 777, members: [[9, 'adopted']], live: [9] })
    const mod = await loadModule(chrome)

    const res = await mod.dispatch({ id: 3, op: 'closeTab', tabId: 9 })

    expect(res.error).toBeUndefined()
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith(9)
    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(9)
  })
})

describe('reload 后认领现存组（storage.session 被清、浏览器里旧组还在）', () => {
  // reload 清空 storage.session → 账本 groupId=null。但浏览器里旧 "Stream" 组 + tab 还在。
  // 修复前:reconcileOnWake 跳过、addTabToGroup 另建新组 → 旧 tab 孤儿(list 不到、close 拒绝)。
  // 修复后:两处都先认领现存同名组(绑 id + tab 收回账本为 adopted，红线:不 remove)。
  function makeChromeWithOrphan(groupId: number, tabIds: number[]) {
    const session: Record<string, unknown> = {} // 空 = storage.session 被清
    const live = new Set(tabIds)
    return {
      storage: {
        session: {
          get: vi.fn(async (k: string) => ({ [k]: session[k] })),
          set: vi.fn(async (o: Record<string, unknown>) => {
            Object.assign(session, o)
          }),
        },
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      },
      tabGroups: {
        query: vi.fn(async (q: { title?: string }) => (q.title === 'Stream' ? [{ id: groupId, title: 'Stream' }] : [])),
        update: vi.fn(async () => {}),
        onUpdated: { addListener: vi.fn() },
      },
      tabs: {
        query: vi.fn(async (q: { groupId?: number }) => (q.groupId === groupId ? [...live].map((id) => ({ id })) : [])),
        get: vi.fn(async (id: number) => ({ id, url: 'https://a/x', title: 'T', groupId: live.has(id) ? groupId : -1 })),
        group: vi.fn(async (o: { groupId?: number; tabIds: number[] }) => {
          o.tabIds.forEach((t) => live.add(t))
          return o.groupId ?? groupId
        }),
        ungroup: vi.fn(async () => {}),
        create: vi.fn(async () => ({ id: 99 })),
        remove: vi.fn(async (id: number) => {
          live.delete(id)
        }),
        onUpdated: { addListener: vi.fn() },
      },
      debugger: {
        onEvent: { addListener: vi.fn() },
        attach: vi.fn(async () => {}),
        detach: vi.fn(async () => {}),
        sendCommand: vi.fn(async () => ({})),
      },
      windows: { create: vi.fn(), getAll: vi.fn(async () => [{ id: 1 }]) },
      _session: session,
      _live: live,
    }
  }

  it('reconcileOnWake 认领现存 "Stream" 组，其 tab 收回账本为 adopted，绝不 remove', async () => {
    const chrome = makeChromeWithOrphan(777, [5, 6])
    const mod = await loadModule(chrome as unknown as FakeChrome)

    await mod.reconcileOnWake()

    expect(await mod.groupId()).toBe(777) // 绑定恢复,不再 null
    expect(await mod.tabOrigin(5)).toBe('adopted') // 旧 tab 收回账本、安全出身
    expect(await mod.tabOrigin(6)).toBe('adopted')
    expect(chrome.tabs.remove).not.toHaveBeenCalled() // 红线:认领不销毁
  })

  it('addTabToGroup 加入现存组而非另建新组（reload 后不再攒重复组）', async () => {
    const chrome = makeChromeWithOrphan(777, [5])
    const mod = await loadModule(chrome as unknown as FakeChrome)

    const gid = await mod.addTabToGroup(42, 'created')

    expect(gid).toBe(777) // 复用旧组
    expect(chrome.tabs.group).toHaveBeenCalledWith({ groupId: 777, tabIds: [42] }) // 加入而非新建
    expect(await mod.tabOrigin(5)).toBe('adopted') // 旧 tab 一并收回
    expect(await mod.tabOrigin(42)).toBe('created') // 新 tab 保留真实出身
  })
})
