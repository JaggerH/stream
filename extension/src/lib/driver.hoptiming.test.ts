import { describe, it, expect, vi, afterEach } from 'vitest'

// ── 慢命令的分段时间戳：扩展这一半 ─────────────────────────────────────────────
// `Page.navigate` 偶发挂满 30s，而扩展侧此前只记总耗时 —— 答不出"慢在哪一跳"。
// 一条 CDP 命令在 SW 里要走两段：先 ensureAttached（+ 可选 assertDomain），再真发
// CDP。两段都会打进 Chrome、都可能挂，而 attach 这一格今天完全是黑的。
//
// **时钟**：这里所有的数都在 SW 自己的钟上量（同侧相减）。跨侧那一段由后端拿
// backendTotalMs - swMs 算，所以本侧的义务只有一个：把 swMs 如实带回执里。
// 设计见 docs/superpowers/specs/2026-08-19-ext-cdp-slow-command-hop-timing-design.md。

interface Hooks {
  sendCommand?: ReturnType<typeof vi.fn>
  attach?: ReturnType<typeof vi.fn>
}

function makeChrome(hooks: Hooks = {}) {
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
      attach: hooks.attach ?? vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: hooks.sendCommand ?? vi.fn(async () => ({})),
    },
  }
}

async function loadModule(chrome: ReturnType<typeof makeChrome>) {
  vi.stubGlobal('chrome', chrome)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
  vi.resetModules()
  return import('./driver.ts')
}

/** debugLog 走 console.warn + HTTP；这里只截 console.warn 那一份（它一定先发生、且同步）。 */
function captureDebugLogs() {
  const seen: Array<{ event: string; fields: Record<string, unknown> }> = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    const m = /^\[ext-cdp\] ([\w-]+):/.exec(String(args[0] ?? ''))
    if (m) seen.push({ event: m[1], fields: (args[1] ?? {}) as Record<string, unknown> })
  })
  return seen
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('扩展侧慢命令的分段时间戳', () => {
  it('每条回执都带 swMs —— 后端靠它减出 WS 那两段，不去猜', async () => {
    const mod = await loadModule(makeChrome())
    await mod.addTabToGroup(5, 'created')
    const res = await mod.dispatch({ id: 1, tabId: 5, method: 'Page.navigate', params: { url: 'https://a.example' } })
    expect(typeof res.swMs).toBe('number')
    expect(res.swMs).toBeGreaterThanOrEqual(0)
  })

  it('失败的回执一样带 swMs —— 挂住那次多半就是以失败收场的', async () => {
    const mod = await loadModule(makeChrome({ sendCommand: vi.fn(async () => { throw new Error('boom') }) }))
    await mod.addTabToGroup(5, 'created')
    const res = await mod.dispatch({ id: 1, tabId: 5, method: 'Page.navigate', params: {} })
    expect(res.error).toMatch(/boom/)
    expect(typeof res.swMs).toBe('number')
  })

  it('5s 看门狗要说清"CDP 发出去了没有" —— attach 挂住时这一格当场砍掉一半嫌疑', async () => {
    vi.useFakeTimers()
    const seen = captureDebugLogs()
    // 活体形状：卡在 attach，底层 CDP 命令压根还没发出去
    const mod = await loadModule(makeChrome({ attach: vi.fn(() => new Promise(() => {})) }))
    await mod.addTabToGroup(5, 'created')

    void mod.dispatch({ id: 1, tabId: 5, method: 'Page.navigate', params: {} })
    await vi.advanceTimersByTimeAsync(mod.SLOW_COMMAND_MS + 50)

    const slow = seen.find((s) => s.event === 'slow-command')
    expect(slow).toBeDefined()
    expect(slow!.fields.cdpIssued).toBe(false)
    // 还没发出去，就没有 preCdpMs 可报 —— 缺席就是缺席，不许填 0
    expect(slow!.fields.preCdpMs).toBeUndefined()
  })

  it('CDP 已发出、挂在 tab 那侧：看门狗报 cdpIssued:true 和 attach 花掉的 preCdpMs', async () => {
    vi.useFakeTimers()
    const seen = captureDebugLogs()
    // 只让 Page.navigate 挂住 —— ensureAttached 自己也走 sendCommand（mitigateThrottle），
    // 一刀切全挂就卡在 attach 那一步，量的就不是这一格了。
    const mod = await loadModule(makeChrome({
      sendCommand: vi.fn((_t: unknown, method: string) =>
        method === 'Page.navigate' ? new Promise(() => {}) : Promise.resolve({}),
      ),
    }))
    await mod.addTabToGroup(5, 'created')

    void mod.dispatch({ id: 1, tabId: 5, method: 'Page.navigate', params: {} })
    await vi.advanceTimersByTimeAsync(mod.SLOW_COMMAND_MS + 50)

    const slow = seen.find((s) => s.event === 'slow-command')
    expect(slow!.fields.cdpIssued).toBe(true)
    expect(typeof slow!.fields.preCdpMs).toBe('number')
  })

  it('真回来了：slow-command-done 把 SW 侧两段拆开报', async () => {
    vi.useFakeTimers()
    const seen = captureDebugLogs()
    let release: ((v: unknown) => void) | undefined
    const mod = await loadModule(makeChrome({
      sendCommand: vi.fn((_t: unknown, method: string) =>
        method === 'Page.navigate' ? new Promise((r) => { release = r }) : Promise.resolve({}),
      ),
    }))
    await mod.addTabToGroup(5, 'created')

    const pending = mod.dispatch({ id: 1, tabId: 5, method: 'Page.navigate', params: {} })
    await vi.advanceTimersByTimeAsync(mod.SLOW_COMMAND_MS + 50)
    release?.({ frameId: 'F' })
    await pending

    const done = seen.find((s) => s.event === 'slow-command-done')
    expect(done).toBeDefined()
    expect(done!.fields.cdpIssued).toBe(true)
    expect(typeof done!.fields.preCdpMs).toBe('number')
    expect(typeof done!.fields.cdpMs).toBe('number')
    // 两段之和不该超过总耗时（同一个钟上的量，必须自洽）
    expect((done!.fields.preCdpMs as number) + (done!.fields.cdpMs as number))
      .toBeLessThanOrEqual(done!.fields.elapsedMs as number)
  })

  it('不走 CDP 的 op（list）：cdpIssued 为 false，两段缺席而不是 0', async () => {
    vi.useFakeTimers()
    const seen = captureDebugLogs()
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created')
    // list 逐个 chrome.tabs.get 取 url/title —— 让它挂住，op 就停在 CDP 之外的那一侧
    chrome.tabs.get = vi.fn(() => new Promise(() => {})) as never

    void mod.dispatch({ id: 1, op: 'list' })
    await vi.advanceTimersByTimeAsync(mod.SLOW_COMMAND_MS + 50)

    const slow = seen.find((s) => s.event === 'slow-command')
    expect(slow!.fields.cdpIssued).toBe(false)
    expect(slow!.fields.cdpMs).toBeUndefined()
  })

  it('快命令一条账都不记 —— 这条通道是 200 条的环，别冲干净它', async () => {
    const seen = captureDebugLogs()
    const mod = await loadModule(makeChrome())
    await mod.addTabToGroup(5, 'created')
    await mod.dispatch({ id: 1, tabId: 5, method: 'Page.navigate', params: {} })
    expect(seen.filter((s) => s.event.startsWith('slow-command'))).toHaveLength(0)
  })
})
