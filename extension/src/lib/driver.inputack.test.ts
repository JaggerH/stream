import { describe, it, expect, vi, afterEach } from 'vitest'

// ── 可信鼠标事件：发了就算，不等 Chrome 的回执 ──────────────────────────────
// 活体实测（2026-09-03，后台标签、焦点模拟开着）：同一条通道上一次 `Runtime.evaluate`
// 往返 36ms，而一次可信点击（8 次 move + 按下 + 松开 + 一次读矩形）要 5.9–9.7 秒；
// 页内探针同时证明这 11 个事件**在 262ms 内全都送达了页面**。慢的只有回执——鼠标事件
// 要做命中测试，命中测试要一帧，而 Chrome 不给看不见的标签画帧。
//
// 这组测试钉三件事：鼠标事件的回执不再等 Chrome；别的命令**照旧等**（名单是窄的）；
// 发命令之前那两道门（attach / 域名校验）仍然照常拒。

function makeChrome(sendCommand: ReturnType<typeof vi.fn>) {
  const session: Record<string, unknown> = {}
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
      get: vi.fn(async (tabId: number) => ({ id: tabId, url: 'https://a.example/p', title: 'T', groupId: 777 })),
      create: vi.fn(async () => ({ id: 5 })),
      remove: vi.fn(async () => {}),
      query: vi.fn(async () => []),
      onUpdated: { addListener: vi.fn() },
    },
    tabGroups: { onUpdated: { addListener: vi.fn() } },
    windows: { create: vi.fn(), getAll: vi.fn(async () => [{ id: 1 }]) },
    debugger: {
      onEvent: { addListener: vi.fn() },
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand,
    },
  }
}

async function loadModule(chrome: ReturnType<typeof makeChrome>) {
  vi.stubGlobal('chrome', chrome)
  vi.resetModules()
  return import('./driver.ts')
}

/** 活体形状：这条命令的回执永不到来（后台标签没有帧可等）。 */
const neverAcks = (methods: string[]) =>
  vi.fn((_t: unknown, method: string, _params?: unknown) =>
    methods.includes(method) ? new Promise(() => {}) : Promise.resolve({ ok: true }),
  )

afterEach(() => {
  vi.useRealTimers()
})

describe('可信鼠标事件不等回执', () => {
  it('Chrome 的回执永不到来，dispatch 照样立刻回——这正是那 6–10 秒的去处', async () => {
    const sendCommand = neverAcks(['Input.dispatchMouseEvent'])
    const mod = await loadModule(makeChrome(sendCommand))
    await mod.addTabToGroup(5, 'created')

    const res = await mod.dispatch({
      id: 1,
      tabId: 5,
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 1, y: 2 },
    })

    expect(res).toMatchObject({ id: 1 })
    expect(res).not.toHaveProperty('error')
    // 命令**确实发出去了**——不等回执不等于不发。
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 5 }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 1,
      y: 2,
    })
  })

  it('顺序还是保的：后端逐条 await，回执一快那个串行就是真的串行', async () => {
    const sendCommand = neverAcks(['Input.dispatchMouseEvent'])
    const mod = await loadModule(makeChrome(sendCommand))
    await mod.addTabToGroup(5, 'created')

    // 一次点击的形状：8 次 move → 按下 → 松开。逐条 await，跟后端那边一样。
    const types = [...Array(8).fill('mouseMoved'), 'mousePressed', 'mouseReleased']
    for (const [i, type] of types.entries()) {
      await mod.dispatch({ id: i, tabId: 5, method: 'Input.dispatchMouseEvent', params: { type } })
    }

    const sent = sendCommand.mock.calls
      .filter((c) => c[1] === 'Input.dispatchMouseEvent')
      .map((c) => (c[2] as { type: string }).type)
    expect(sent).toEqual(types)
  })

  it('名单是窄的：键盘事件照旧等回执（它不做命中测试，回执又便宜又有意义）', async () => {
    vi.useFakeTimers()
    const mod = await loadModule(makeChrome(neverAcks(['Input.dispatchKeyEvent'])))
    await mod.addTabToGroup(5, 'created')

    let settled = false
    void mod
      .dispatch({ id: 1, tabId: 5, method: 'Input.dispatchKeyEvent', params: { type: 'keyDown' } })
      .then(() => {
        settled = true
      })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(settled).toBe(false)
  })

  it('发命令之前那两道门仍然照常拒——不等回执不是不设防', async () => {
    const sendCommand = neverAcks(['Input.dispatchMouseEvent'])
    const mod = await loadModule(makeChrome(sendCommand))
    await mod.addTabToGroup(5, 'created')

    // tab 已经跳到别的域名上了：这一动作必须被拒，且**一条命令都不许发出去**。
    const res = (await mod.dispatch({
      id: 1,
      tabId: 5,
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed' },
      expectDomain: 'b.example',
    })) as { error?: string }

    expect(res.error).toMatch(/domain changed|域名不匹配/)
    expect(sendCommand.mock.calls.filter((c) => c[1] === 'Input.dispatchMouseEvent')).toHaveLength(0)
  })
})
