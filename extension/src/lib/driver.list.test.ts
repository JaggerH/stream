import { describe, it, expect, vi } from 'vitest'

// ── fake chrome：在标签组/拖拽基础上补 tabs.get（list 靠它取每个成员的 url/title）──
// list 与归属边界都经导出的 dispatch 走真实协议路径（而非直接调内部函数），确保测的是
// 中继线上真会发生的事。
function makeChrome() {
  const session: Record<string, unknown> = {}
  const tabsUpdated: Array<(tabId: number, changeInfo: { groupId?: number }) => unknown> = []
  const tabInfo: Record<number, { url: string; title: string }> = {
    5: { url: 'https://a.example/1', title: 'A one' },
    9: { url: 'https://b.example/2', title: 'B two' },
    77: { url: 'https://private.example/secret', title: '用户私人 tab' },
  }
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
      // groupId 默认在会话组内（归属判据以浏览器为准，账本只是出身缓存）；tabInfo 可覆盖
      get: vi.fn(async (tabId: number) => {
        const t = tabInfo[tabId]
        if (!t) throw new Error(`No tab with id ${tabId}`)
        return { id: tabId, groupId: 777, ...t }
      }),
      create: vi.fn(async () => ({ id: 5 })),
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
      sendCommand: vi.fn(async () => ({ ok: true })),
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

describe('list 枚举组内 tab', () => {
  it('返回组内每个 tab 的 {tabId,url,title,origin}，组外 tab 不出现；origin 分得清自建与用户拖入', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created') // AI 自建，建组 777
    await chrome._fireTabUpdated(9, { groupId: 777 }) // 用户拖入 tab9
    // tab77 存在于浏览器但从未进组 —— 不该出现在 list 里

    const res = await mod.dispatch({ id: 1, op: 'list' })

    expect(res.error).toBeUndefined()
    expect(res.result).toEqual({
      tabs: [
        { tabId: 5, url: 'https://a.example/1', title: 'A one', origin: 'created', grouped: true, active: false },
        { tabId: 9, url: 'https://b.example/2', title: 'B two', origin: 'adopted', grouped: true, active: false },
      ],
    })
    // 组外的私人 tab 绝不泄漏
    expect(JSON.stringify(res.result)).not.toContain('private.example')
  })

  it('空组：list 返回空数组而非报错', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    const res = await mod.dispatch({ id: 2, op: 'list' })
    expect(res.error).toBeUndefined()
    expect(res.result).toEqual({ tabs: [] })
  })

  it('成员 tab 已被用户关掉：list 跳过它、不整条失败', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    await mod.addTabToGroup(404, 'created') // tabInfo 里没有 404 → tabs.get 抛
    const res = await mod.dispatch({ id: 3, op: 'list' })
    expect(res.error).toBeUndefined()
    expect(res.result).toEqual({ tabs: [{ tabId: 5, url: 'https://a.example/1', title: 'A one', origin: 'created', grouped: true, active: false }] })
  })
})

describe('归属边界：组内即可操作，组外一律拒', () => {
  it('组内自建 tab：CDP 命令放行', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    const res = await mod.dispatch({ id: 4, tabId: 5, method: 'Runtime.evaluate', params: { expression: '1' } })
    expect(res.error).toBeUndefined()
    expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 5 }, '1.3')
  })

  it('组内 adopted（用户拖入）tab：同样放行 —— 这正是「接管任意 tab」的落点', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created') // 建组
    await chrome._fireTabUpdated(9, { groupId: 777 }) // 用户拖入 tab9 = 授权
    const res = await mod.dispatch({ id: 5, tabId: 9, method: 'Runtime.evaluate', params: { expression: '1' } })
    expect(res.error).toBeUndefined()
    expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 9 }, '1.3')
  })

  it('组外 tab：拒绝并报清晰错，绝不 attach', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    const res = await mod.dispatch({ id: 6, tabId: 77, method: 'Runtime.evaluate', params: { expression: '1' } })
    expect(res.error).toMatch(/77/)
    expect(res.error).toMatch(/group|组/i)
    expect(chrome.debugger.attach).not.toHaveBeenCalledWith({ tabId: 77 }, '1.3')
  })

  it('拖出后（撤销）：曾在组内的 tab 再被操作 → 拒', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    await chrome._fireTabUpdated(9, { groupId: 777 }) // 拖入
    await chrome._fireTabUpdated(9, { groupId: -1 }) // 再拖出 = 撤销
    const res = await mod.dispatch({ id: 7, tabId: 9, method: 'Runtime.evaluate', params: { expression: '1' } })
    expect(res.error).toMatch(/9/)
    expect(res.error).toMatch(/group|组/i)
  })

  it('subscribe 同样按组内判据：组外 tab 拒', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    const res = await mod.dispatch({ id: 8, op: 'subscribe', tabId: 77, domains: ['Network'] })
    expect(res.error).toMatch(/group|组/i)
  })
})

describe('newTab 自建 tab 必须入组（否则自己就被边界拒、list 也看不到）', () => {
  it('background 档 newTab：tab 入会话组、出身 probe、随后可操作', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    // waitForNav 靠 Runtime.evaluate 读 readyState —— 让它一次就满足
    chrome.debugger.sendCommand = vi.fn(async (_t: unknown, method: string) =>
      method === 'Runtime.evaluate'
        ? { result: { value: JSON.stringify({ rs: 'complete', href: 'https://a.example/1' }) } }
        : {},
    ) as unknown as FakeChrome['debugger']['sendCommand']

    const res = await mod.dispatch({ id: 9, op: 'newTab', url: 'https://a.example/1', background: true })

    expect(res.error).toBeUndefined()
    expect(res.result).toEqual({ tabId: 5 })
    expect(await mod.tabOrigin(5)).toBe('probe') // 后台档没人看着 → SW 醒来兜底回收它
    expect(await mod.groupMembers()).toContainEqual({ tabId: 5, origin: 'probe' })
  })
})
