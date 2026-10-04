import { describe, it, expect, vi } from 'vitest'

// 采集 lane 故意落空白页（后端紧接着自己导航一次，这样一次搜索只加载一次页面）。
// waitForNav 的判据是「已经离开 about:blank 且文档就绪」——目标本身就是 about:blank 时，
// 那条判据永远不成立，会空转满 30 秒，newTab 命令因此不返回。
// 活体 2026-07-29：用户搜索后看到两个空白标签、永不跳转，正是这个。
function makeChrome(readyHref: string) {
  const calls: string[] = []
  return {
    calls,
    chrome: {
      storage: {
        session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
        onChanged: { addListener: vi.fn() },
      },
      windows: { getAll: vi.fn(async () => [{ id: 1 }]), create: vi.fn(async () => ({ id: 1 })) },
      tabs: {
        create: vi.fn(async () => ({ id: 7 })),
        get: vi.fn(async () => ({ id: 7, groupId: 99, url: readyHref })),
        group: vi.fn(async () => 99),
        query: vi.fn(async () => []),
        update: vi.fn(async () => ({ id: 7 })),
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      tabGroups: { update: vi.fn(async () => {}), onRemoved: { addListener: vi.fn() } },
      cookies: { getAll: vi.fn(async () => []) },
      debugger: {
        attach: vi.fn(async () => {}),
        sendCommand: vi.fn(async (_t: unknown, method: string) => {
          calls.push(method)
          if (method === 'Runtime.evaluate') {
            return { result: { value: JSON.stringify({ rs: 'complete', href: readyHref }) } }
          }
          return {}
        }),
        onEvent: { addListener: vi.fn() },
        onDetach: { addListener: vi.fn() },
      },
      runtime: { onMessage: { addListener: vi.fn() }, lastError: undefined },
    },
  }
}

async function load(readyHref: string) {
  const m = makeChrome(readyHref)
  vi.stubGlobal('chrome', m.chrome)
  vi.resetModules()
  return { dispatch: (await import('./driver.ts')).dispatch, ...m }
}

describe('newTab(about:blank)', () => {
  it('目标就是空白页时不等导航 —— 否则 newTab 空转 30 秒、后端那句 goto 永远轮不上', async () => {
    // 页面会一直停在 about:blank（因为那就是目标），旧逻辑在这里必然等满超时。
    const { dispatch } = await load('about:blank')
    const res = await dispatch({ id: 1, op: 'newTab', url: 'about:blank', waitUntil: 'load' })
    expect(res.error).toBeUndefined()
    expect((res.result as { tabId: number }).tabId).toBe(7)
  }, 5_000)

  it('目标是真地址时照常等到它离开 about:blank', async () => {
    const { dispatch, calls } = await load('https://real.test/')
    const res = await dispatch({ id: 2, op: 'newTab', url: 'https://real.test/', waitUntil: 'load' })
    expect(res.error).toBeUndefined()
    expect(calls).toContain('Runtime.evaluate') // 确实探过 readyState/href
  }, 5_000)
})
