import { describe, it, expect, vi, afterEach } from 'vitest'

// ── 截图的上界 ──────────────────────────────────────────────────────────────
// `Page.captureScreenshot` 等的是合成器**真的产出一帧**，而一个不显示在屏幕上的标签
// 不产帧 —— 这条命令会一直挂着（实测 12.0s / 18.5s / 26.1s / 30.0s，30s 那档是后端
// 中继的闸门兜底）。后端那侧 2 秒就放手了（`FLUSH_FRAME_BUDGET_MS`），所以挂在 Chrome
// 里的这条命令**已经没人要了**。这组测试钉住扩展侧自己的上界：到点回一个明确的失败，
// 绝不静默成功，也绝不误伤别的命令。

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

afterEach(() => {
  vi.useRealTimers()
})

describe('Page.captureScreenshot 的扩展侧上界', () => {
  it('这个上界必须比后端放手的那 2 秒严 —— 比它宽就等于没有', async () => {
    const mod = await loadModule(makeChrome(vi.fn(async () => ({}))))
    expect(mod.SCREENSHOT_BUDGET_MS).toBeLessThan(2_000)
  })

  it('标签不产帧、命令永不兑现：到点回明确失败，绝不静默成功', async () => {
    vi.useFakeTimers()
    // 活体形状：截图要等一帧，而不显示在屏幕上的标签正是不产帧的那个 —— 回执永不到来。
    const sendCommand = vi.fn((_t: unknown, method: string) =>
      method === 'Page.captureScreenshot' ? new Promise(() => {}) : Promise.resolve({ ok: true }),
    )
    const mod = await loadModule(makeChrome(sendCommand))
    await mod.addTabToGroup(5, 'created')

    const pending = mod.dispatch({ id: 1, tabId: 5, method: 'Page.captureScreenshot', params: {} })
    // 两个预算：第一发（正常路）+ 回落到离屏档再一发。两发都没帧才算真的没帧。
    await vi.advanceTimersByTimeAsync(2 * mod.SCREENSHOT_BUDGET_MS + 20)
    const res = await pending

    expect(res.error).toMatch(/Page\.captureScreenshot/)
    // 失败必须说得出是哪一类失败（没帧），否则上层只能猜
    expect(res.error).toMatch(/帧|frame/)
    expect(res.result).toBeUndefined()
  })

  it('正常截图照常返回，不被这道闸误伤', async () => {
    const sendCommand = vi.fn(async () => ({ data: 'AAAA' }))
    const mod = await loadModule(makeChrome(sendCommand))
    await mod.addTabToGroup(5, 'created')

    const res = await mod.dispatch({ id: 2, tabId: 5, method: 'Page.captureScreenshot', params: {} })
    expect(res.error).toBeUndefined()
    expect(res.result).toEqual({ data: 'AAAA' })
  })

  // ── 遮挡窗口的回落 ────────────────────────────────────────────────────────
  // 不产帧不是物理限制，是渲染器在"反正没人看"时停了合成。setDeviceMetricsOverride 把它
  // 切到离屏合成面上，跟窗口显不显示脱钩。**这条回落是这条链路上唯一让无人值守的定时任务
  // （锁着屏的早上）还能截到验证码的东西**——没有它，那种任务必然静默失败。
  it('第一发没帧 → 带 captureBeyondViewport 重试一发，成功；clip 之类的原参数照样带上', async () => {
    vi.useFakeTimers()
    const calls: Array<Record<string, unknown> | undefined> = []
    let shots = 0
    const sendCommand = vi.fn((_t: unknown, method: string, params?: Record<string, unknown>) => {
      if (method !== 'Page.captureScreenshot') return Promise.resolve({ ok: true })
      calls.push(params)
      shots++
      // 第一发永不兑现（窗口被盖住）；beyond-viewport 那一发正常回。
      return shots === 1 ? new Promise(() => {}) : Promise.resolve({ data: 'BBBB' })
    })
    const mod = await loadModule(makeChrome(sendCommand))
    await mod.addTabToGroup(5, 'created')

    const pending = mod.dispatch({
      id: 9, tabId: 5, method: 'Page.captureScreenshot', params: { format: 'jpeg', clip: { x: 1 } },
    })
    await vi.advanceTimersByTimeAsync(mod.SCREENSHOT_BUDGET_MS + 10)
    const res = await pending

    expect(res.error).toBeUndefined()
    expect(res.result).toEqual({ data: 'BBBB' })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.captureBeyondViewport).toBeUndefined()
    expect(calls[1]?.captureBeyondViewport).toBe(true)
    // 回落不能把原来的参数弄丢——丢了 clip 就会截整页，验证码那一小块就找不回来了。
    expect(calls[1]?.format).toBe('jpeg')
    expect(calls[1]?.clip).toEqual({ x: 1 })
  })

  it('看得见的窗口一次就成：回落一次都不发', async () => {
    let shots = 0
    const sendCommand = vi.fn(async (_t: unknown, method: string) => {
      if (method === 'Page.captureScreenshot') shots++
      return { data: 'AAAA' }
    })
    const mod = await loadModule(makeChrome(sendCommand))
    await mod.addTabToGroup(5, 'created')

    await mod.dispatch({ id: 10, tabId: 5, method: 'Page.captureScreenshot', params: {} })
    expect(shots).toBe(1)
  })

  // 回落那一发也可能挂住（渲染器就是那个不干活的）。没有上界的话表现是一路挂到中继的 30s，
  // 而那个错误只会说"命令没回"，分不出是哪一步没回——活体上真的这么栽过一次。
  it('回落那一发也带上界：两个预算之后必须回明确失败，不许挂到中继超时', async () => {
    vi.useFakeTimers()
    const sendCommand = vi.fn((_t: unknown, method: string) =>
      method === 'Page.captureScreenshot' ? new Promise(() => {}) : Promise.resolve({ ok: true }),
    )
    const mod = await loadModule(makeChrome(sendCommand))
    await mod.addTabToGroup(5, 'created')

    let settled = false
    const pending = mod
      .dispatch({ id: 11, tabId: 5, method: 'Page.captureScreenshot', params: {} })
      .then((r) => { settled = true; return r })
    await vi.advanceTimersByTimeAsync(2 * mod.SCREENSHOT_BUDGET_MS + 20)
    expect(settled).toBe(true)
    expect((await pending).error).toMatch(/帧|frame/)
  })

  it('这道闸只管要真帧的那条命令：别的命令该等多久还等多久', async () => {
    vi.useFakeTimers()
    let release: ((v: unknown) => void) | undefined
    const sendCommand = vi.fn((_t: unknown, method: string) =>
      method === 'Runtime.evaluate'
        ? new Promise((r) => {
            release = r
          })
        : Promise.resolve({ ok: true }),
    )
    const mod = await loadModule(makeChrome(sendCommand))
    await mod.addTabToGroup(5, 'created')

    let settled = false
    const pending = mod
      .dispatch({ id: 3, tabId: 5, method: 'Runtime.evaluate', params: { expression: '1' } })
      .then((r) => {
        settled = true
        return r
      })
    await vi.advanceTimersByTimeAsync(3 * mod.SCREENSHOT_BUDGET_MS)
    expect(settled).toBe(false) // 截图的上界不该把它砍掉

    release?.({ result: { value: 1 } })
    const res = await pending
    expect(res.error).toBeUndefined()
  })
})
