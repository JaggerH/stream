import { describe, it, expect, vi } from 'vitest'

// ── fake chrome：tab 此刻停在哪个 URL 由 currentUrl 编排 ──
// 逐动作域名校验是红线从「只碰自建」松到「只碰组内」之后补回的那道安全：防止一个
// mutating 动作发起后、页面被导航到别的站，动作落到非预期的域名上。
// 「发起时的域名」= dispatch 传入的 expectDomain；「执行前的当前域名」= currentUrl。
function makeChrome(currentUrl = 'https://a.example/page') {
  const session: Record<string, unknown> = {}
  const tabsUpdated: Array<(tabId: number, changeInfo: { groupId?: number }) => unknown> = []
  const sendCommand = vi.fn(async (_t: unknown, method: string) => {
    if (method === 'Runtime.evaluate') {
      // waitForNav 仍读 readyState；域名探针已不走页面 JS（见 tabs.get）
      return { result: { value: JSON.stringify({ rs: 'complete', href: currentUrl }) } }
    }
    return { ok: true }
  })
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
      // 域名探针 + 归属判据的共同真相源：浏览器进程自己的记录，页面伪造不了
      get: vi.fn(async (tabId: number) => ({ id: tabId, url: currentUrl, title: 'T', groupId: 777 })),
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
      sendCommand,
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

describe('逐动作域名校验（mutating 动作）', () => {
  it('域名未变：mutating 动作放行', async () => {
    const chrome = makeChrome('https://a.example/page')
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    const res = await mod.dispatch({
      id: 1,
      tabId: 5,
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed' },
      expectDomain: 'a.example',
    })
    expect(res.error).toBeUndefined()
  })

  it('中途导航到别的域名：mutating 动作被拒并报域名不匹配', async () => {
    // 发起时在 a.example，执行前页面已跑到 evil.example
    const chrome = makeChrome('https://evil.example/steal')
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    const res = await mod.dispatch({
      id: 2,
      tabId: 5,
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed' },
      expectDomain: 'a.example',
    })
    expect(res.error).toMatch(/domain|域名/i)
    expect(res.error).toMatch(/evil\.example/)
    expect(res.error).toMatch(/a\.example/)
  })

  it('域名不匹配时绝不把动作发到页面上', async () => {
    const chrome = makeChrome('https://evil.example/steal')
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    await mod.dispatch({
      id: 3,
      tabId: 5,
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed' },
      expectDomain: 'a.example',
    })
    const dispatched = chrome.debugger.sendCommand.mock.calls.filter(
      (c: unknown[]) => c[1] === 'Input.dispatchMouseEvent',
    )
    expect(dispatched).toHaveLength(0)
  })

  it('未声明 expectDomain（读类动作/兼容旧后端）：不校验、照常放行', async () => {
    const chrome = makeChrome('https://whatever.example/x')
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    const res = await mod.dispatch({ id: 4, tabId: 5, method: 'Runtime.evaluate', params: { expression: '1' } })
    expect(res.error).toBeUndefined()
  })

  it('【安全】探针不碰页面 JS：页面覆写 JSON.stringify 也伪造不了域名', async () => {
    // 若探针在页面主世界求值，恶意页面可覆写 JSON.stringify 返回伪造的 href 骗过校验，
    // 且「被调用即预言机」——页面精确知道 AI 正要动手，能按需触发跳转。故探针必须走
    // 浏览器进程自己的记录（chrome.tabs.get），页面伪造不到。
    const chrome = makeChrome('https://evil.example/steal')
    // 模拟被污染的页面：任何页内求值都撒谎说自己还在 a.example
    chrome.debugger.sendCommand = vi.fn(async () => ({
      result: { value: JSON.stringify({ rs: 'complete', href: 'https://a.example/page' }) },
    })) as unknown as FakeChrome['debugger']['sendCommand']

    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    const res = await mod.dispatch({
      id: 6,
      tabId: 5,
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed' },
      expectDomain: 'a.example',
    })

    // 页面撒了谎，但 tabs.get 说的是 evil.example —— 必须以浏览器为准，拒掉
    expect(res.error).toMatch(/evil\.example/)
    expect(chrome.tabs.get).toHaveBeenCalledWith(5)
  })

  it('子域名视作不同域：a.example ≠ evil.a.example 不放行', async () => {
    const chrome = makeChrome('https://evil.a.example/x')
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    const res = await mod.dispatch({
      id: 5,
      tabId: 5,
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed' },
      expectDomain: 'a.example',
    })
    expect(res.error).toMatch(/domain|域名/i)
  })
})
