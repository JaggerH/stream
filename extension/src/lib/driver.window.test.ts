import { describe, it, expect, vi } from 'vitest'

// Chrome 一个窗口都没有是**唤起它的常态**（host-agent 用 --no-startup-window 拉起进程），
// 于是采集/打开的第一步都得先造一扇窗。那扇窗自带一张初始标签——**必须就用它**。
// 另建一张的代价是留下一张组外孤儿：用户在标签栏里看得见它，它却不属于 Stream 组、
// 没有出身、reconcileOnWake 也不认领它，只能靠用户自己动手关。

function makeChrome() {
  const calls = { windowUrls: [] as string[], createdTabs: [] as string[], grouped: [] as number[][] }
  const local: Record<string, unknown> = {}
  let windows: number[] = []
  return {
    calls,
    chrome: {
      storage: {
        session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
        local: {
          get: vi.fn(async (key: string) => ({ [key]: local[key] })),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(local, obj)
          }),
          remove: vi.fn(async () => {}),
        },
        onChanged: { addListener: vi.fn() },
      },
      windows: {
        getAll: vi.fn(async () => windows.map((id) => ({ id }))),
        create: vi.fn(async ({ url }: { url: string }) => {
          calls.windowUrls.push(url)
          windows = [1]
          return { id: 1, tabs: [{ id: 7, url, windowId: 1, title: '' }] }
        }),
        update: vi.fn(async () => ({})),
      },
      tabs: {
        create: vi.fn(async ({ url }: { url: string }) => {
          calls.createdTabs.push(url)
          return { id: 8, url, windowId: 1, title: '' }
        }),
        get: vi.fn(async (id: number) => ({ id, groupId: 99, url: 'https://real.test/', title: 'R' })),
        group: vi.fn(async (opts: { groupId?: number; tabIds: number[] }) => {
          calls.grouped.push(opts.tabIds)
          return opts.groupId ?? 99
        }),
        query: vi.fn(async () => []),
        update: vi.fn(async () => ({})),
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      tabGroups: {
        update: vi.fn(async () => ({})),
        query: vi.fn(async () => []),
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      cookies: { getAll: vi.fn(async () => []) },
      debugger: {
        attach: vi.fn(async () => {}),
        detach: vi.fn(async () => {}),
        sendCommand: vi.fn(async (_t: unknown, method: string) =>
          method === 'Runtime.evaluate'
            ? { result: { value: JSON.stringify({ rs: 'complete', href: 'https://real.test/' }) } }
            : {},
        ),
        onEvent: { addListener: vi.fn() },
        onDetach: { addListener: vi.fn() },
      },
      runtime: { onMessage: { addListener: vi.fn() }, lastError: undefined },
      system: { display: { getInfo: vi.fn(async () => []) } },
    },
  }
}

async function load() {
  const m = makeChrome()
  vi.stubGlobal('chrome', m.chrome)
  vi.resetModules()
  return { dispatch: (await import('./driver.ts')).dispatch, ...m }
}

describe('零窗口时造窗（newTab）', () => {
  it('用那扇窗自带的标签，不再另建一张——否则留下一张组外的 about:blank 孤儿', async () => {
    const { dispatch, calls, chrome } = await load()
    const res = await dispatch({ id: 1, op: 'newTab', url: 'https://real.test/', waitUntil: 'load' })
    expect(res.error).toBeUndefined()
    expect(calls.windowUrls).toEqual(['https://real.test/']) // 窗口直接开在目标地址上
    expect(chrome.tabs.create).not.toHaveBeenCalled()
    expect((res.result as { tabId: number }).tabId).toBe(7)
    expect(calls.grouped).toEqual([[7]]) // 且它进了会话组
  }, 5_000)

  it('造窗回不来标签（造窗失败 / 旧 Chrome）→ 退回 tabs.create，采集不整条挂掉', async () => {
    const { dispatch, chrome, calls } = await load()
    chrome.windows.create = vi.fn(async () => ({ id: 1 })) as unknown as typeof chrome.windows.create
    const res = await dispatch({ id: 2, op: 'newTab', url: 'https://real.test/', waitUntil: 'load' })
    expect(res.error).toBeUndefined()
    expect(calls.createdTabs).toEqual(['https://real.test/'])
    expect((res.result as { tabId: number }).tabId).toBe(8)
    expect(calls.grouped).toEqual([[8]])
  }, 5_000)
})
