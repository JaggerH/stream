import { describe, it, expect, vi } from 'vitest'

// ── close/reap 按 tab 出身分流 + interactive 档入组 ──
// 红线：AI 自建(created)的 tab 才能被 remove 回收；用户拖入(adopted)的 tab 只 detach +
// 移出组，绝不 chrome.tabs.remove——那是用户自己的 tab、可能有未保存数据，销毁它是红线。
type WindowCreateOpts = {
  focused?: boolean
  state?: string
  url?: string
  left?: number
  top?: number
  width?: number
  height?: number
}

function makeChrome() {
  const session: Record<string, unknown> = {}
  const tabsUpdated: Array<(tabId: number, changeInfo: { groupId?: number }) => unknown> = []
  // 浏览器眼里真实在会话组内的 tab —— 归属判据的真相源（账本只是出身缓存，会过期）
  const live = new Set<number>()
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
      group: vi.fn(async (opts: { groupId?: number; tabIds: number[] }) => {
        opts.tabIds.forEach((t) => live.add(t))
        return opts.groupId ?? 777
      }),
      ungroup: vi.fn(async (tabId: number) => {
        live.delete(tabId)
      }),
      get: vi.fn(async (tabId: number) => ({
        id: tabId,
        url: 'https://a.example/x',
        title: 'T',
        groupId: live.has(tabId) ? 777 : -1,
      })),
      create: vi.fn(async () => ({ id: 5 })),
      remove: vi.fn(async (tabId: number) => {
        live.delete(tabId)
      }),
      query: vi.fn(async (q: { groupId?: number }) => (q.groupId === 777 ? [...live].map((id) => ({ id })) : [])),
      onUpdated: { addListener: vi.fn((fn: (t: number, c: { groupId?: number }) => unknown) => tabsUpdated.push(fn)) },
    },
    tabGroups: { onUpdated: { addListener: vi.fn() } },
    windows: {
      // 建模真实 chrome.windows.create 的参数约束，否则一个「文档明令禁止、活体必抛」的
      // 组合能在 fake 上一路绿灯（这正是上一版的 bug：非法组合抛错被 .catch 吞掉，
      // 窗口根本没造出来，tabs.create 照旧 "No current window"）。
      create: vi.fn(async (opts: WindowCreateOpts = {}) => {
        const { focused, state, left, top, width, height } = opts
        if (focused === false && (state === 'maximized' || state === 'fullscreen'))
          throw new Error(`The 'focused' option cannot be combined with the state '${state}'`)
        const hasBounds = [left, top, width, height].some((v) => v !== undefined)
        if (hasBounds && state !== undefined && state !== 'normal')
          throw new Error(`The 'state' option '${state}' cannot be combined with 'left', 'top', 'width', or 'height'`)
        return { id: 1, tabs: [{ id: 5 }] }
      }),
      getAll: vi.fn(async () => [{ id: 1 }]),
    },
    system: {
      display: {
        getInfo: vi.fn(async () => [
          { id: 'd1', isPrimary: true, workArea: { left: 0, top: 0, width: 2560, height: 1400 } },
        ]),
      },
    },
    debugger: {
      onEvent: { addListener: vi.fn() },
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (_t: unknown, method: string) =>
        method === 'Runtime.evaluate'
          ? { result: { value: JSON.stringify({ rs: 'complete', href: 'https://a.example/x' }) } }
          : {},
      ),
    },
    _session: session,
    // 用户拖动 tab：浏览器那边的组归属先变，扩展再收到 onUpdated（真实顺序）
    _fireTabUpdated: (tabId: number, changeInfo: { groupId?: number }) => {
      if (changeInfo.groupId === 777) live.add(tabId)
      else if (changeInfo.groupId !== undefined) live.delete(tabId)
      return Promise.all(tabsUpdated.map((l) => l(tabId, changeInfo)))
    },
  }
}

type FakeChrome = ReturnType<typeof makeChrome>

async function loadModule(chrome: FakeChrome) {
  vi.stubGlobal('chrome', chrome)
  vi.resetModules()
  return import('./driver.ts')
}

describe('close 按 tab 出身分流', () => {
  it('关 AI 自建(created) tab：detach + chrome.tabs.remove 回收', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    const res = await mod.dispatch({ id: 1, op: 'closeTab', tabId: 5 })
    expect(res.error).toBeUndefined()
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 5 })
    expect(chrome.tabs.remove).toHaveBeenCalledWith(5)
    expect(await mod.tabOrigin(5)).toBeUndefined() // 已移出组
  })

  it('【红线】关用户拖入(adopted) tab：只 detach + 移出组，绝不 remove', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created') // 建组
    await chrome._fireTabUpdated(9, { groupId: 777 }) // 用户拖入 tab9
    expect(await mod.tabOrigin(9)).toBe('adopted')

    const res = await mod.dispatch({ id: 2, op: 'closeTab', tabId: 9 })

    expect(res.error).toBeUndefined()
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 9 })
    // 红线：用户自己的 tab 绝不被销毁
    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(9)
    expect(await mod.tabOrigin(9)).toBeUndefined() // 已移出组（撤销）
  })

  it('关组外 tab：拒', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    const res = await mod.dispatch({ id: 3, op: 'closeTab', tabId: 77 })
    expect(res.error).toMatch(/group|组/i)
    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(77)
  })
})

// SW 醒来的语义（对账 + 只回收 probe，含"用户 tab 绝不 remove"红线）见
// driver.reconcile.test.ts —— 那里连"账本已过期"的情形一并锁住，比这里原来的更严。
// 本文件只管 close 这条命令本身。

describe('interactive 档：当前窗口新 tab + 入组（非独开窗口）', () => {
  it('background:false → chrome.tabs.create（当前窗口）而非 windows.create，且入组 created', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)

    const res = await mod.dispatch({ id: 4, op: 'newTab', url: 'https://a.example/x', background: false })

    expect(res.error).toBeUndefined()
    // 采用 Anthropic 模型：标签组在用户眼前那一栏、可拖，比飘在旁边的独立窗口更可见可控
    expect(chrome.windows.create).not.toHaveBeenCalled()
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://a.example/x' }))
    expect(await mod.tabOrigin(5)).toBe('created')
  })

  it('background:true（后台采集档）：仍是 active:false 的后台 tab，且出身 probe', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.dispatch({ id: 5, op: 'newTab', url: 'https://a.example/x', background: true })
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://a.example/x', active: false })
    expect(chrome.windows.create).not.toHaveBeenCalled()
    // 没人看着它 → SW 醒来必须兜底回收它（前台档 created 则相反，见 reconcile 测试）
    expect(await mod.tabOrigin(5)).toBe('probe')
  })
})

/**
 * 唤起来的 Chrome 可能一个窗口都没有 —— 那时候 `chrome.tabs.create` 会抛 "No current window"。
 *
 * 两个来源，都不是理论情况（2026-07-28 活体撞到）：host-agent 用 `--no-startup-window` 拉起浏览器
 * （为了不抢屏）；以及新版 Chrome 关掉窗口后进程常驻托盘，"关了" ≠ 进程退出。两种情况下扩展都连着、
 * 看起来一切正常，直到建标签当场炸。
 */
describe('没有窗口时先造一个（不聚焦），有窗口时绝不造', () => {
  it('零窗口 → 造一个铺满 workArea 的不聚焦窗口（显式 bounds，绝不带 state）再建标签', async () => {
    const chrome = makeChrome()
    chrome.windows.getAll = vi.fn(async () => [])
    const mod = await loadModule(chrome)
    const res = await mod.dispatch({ id: 9, op: 'newTab', url: 'https://a.example/x', background: true })
    expect(res.error).toBeUndefined()
    // 铺满主显示器的可用区，但不抢焦点
    // 窗口直接开在目标地址上——它自带的那张标签就是采集标签，不再另建一张 about:blank 孤儿
    expect(chrome.windows.create).toHaveBeenCalledWith({
      focused: false,
      url: 'https://a.example/x',
      left: 0,
      top: 0,
      width: 2560,
      height: 1400,
    })
    // 红线：state 与 focused:false / bounds 都互斥，带上它调用当场抛错 → 窗口造不出来
    expect(chrome.windows.create.mock.calls[0][0]).not.toHaveProperty('state')
    // 用窗口自带的那张标签（id 5），不另建——另建会留下一张组外的 about:blank 孤儿
    expect(chrome.tabs.create).not.toHaveBeenCalled()
    expect(await mod.tabOrigin(5)).toBe('probe')
  })

  it('取不到显示器信息 → 降级成无 bounds 的 create（尺寸差点，但窗口必须造得出来）', async () => {
    const chrome = makeChrome()
    chrome.windows.getAll = vi.fn(async () => [])
    chrome.system.display.getInfo = vi.fn(async () => {
      throw new Error('no system.display permission')
    })
    const mod = await loadModule(chrome)
    const res = await mod.dispatch({ id: 11, op: 'newTab', url: 'https://a.example/x', background: true })
    expect(res.error).toBeUndefined()
    expect(chrome.windows.create).toHaveBeenCalledWith({ focused: false, url: 'https://a.example/x' })
    expect(chrome.tabs.create).not.toHaveBeenCalled() // 照样用窗口自带的那张标签
  })

  it('有窗口 → 一个新窗口都不开(否则每次采集都在用户桌面上弹窗口)', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.dispatch({ id: 10, op: 'newTab', url: 'https://a.example/x', background: true })
    expect(chrome.windows.create).not.toHaveBeenCalled()
  })
})
