import { describe, it, expect, vi } from 'vitest'

// 被 Stream 自建标签开出来的标签（window.open / target=_blank）要进账本、进组、可驱动——
// 否则 cdp_pages 列不出它，AI 盯着旧标签得出"点了没反应"（2026-09-29 活体，微信小程序后台的
// 「前往管理」）。用户拖进来的标签开出来的东西则不收：那是他自己的页面。
//
// 同一份文件还钉 iframe 子会话（OOPIF）：auto-attach 挂上的子会话被记下、`frames` op 列得出、
// 命令带 sessionId 能打进去，而不认识的 sessionId 被拒。

type Tab = { id: number; windowId: number; groupId: number; url: string; title: string; active?: boolean; openerTabId?: number }

function makeChrome() {
  const local: Record<string, unknown> = {}
  const tabs = new Map<number, Tab>()
  const windowType = new Map<number, string>([[1, 'normal'], [2, 'normal'], [3, 'popup']])
  const listeners: { onCreated?: (t: Tab) => void; onEvent?: (s: { tabId?: number; sessionId?: string }, m: string, p: unknown) => void } = {}
  let nextGroup = 500
  const sent: Array<{ target: unknown; method: string; params: unknown }> = []
  const chrome = {
    storage: {
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      local: {
        get: vi.fn(async (key: string) => ({ [key]: local[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => void Object.assign(local, obj)),
        remove: vi.fn(async () => {}),
      },
      onChanged: { addListener: vi.fn() },
    },
    windows: {
      getAll: vi.fn(async () => [{ id: 1 }]),
      get: vi.fn(async (id: number) => {
        if (!windowType.has(id)) throw new Error('no window')
        return { id, type: windowType.get(id) }
      }),
      create: vi.fn(),
      update: vi.fn(async () => ({})),
    },
    tabs: {
      create: vi.fn(async ({ url }: { url: string }) => {
        const t = { id: 10, windowId: 1, groupId: -1, url, title: '' }
        tabs.set(10, t)
        return t
      }),
      get: vi.fn(async (id: number) => {
        const t = tabs.get(id)
        if (!t) throw new Error(`No tab with id: ${id}`)
        return t
      }),
      group: vi.fn(async (opts: { groupId?: number; tabIds: number[]; createProperties?: { windowId: number } }) => {
        const gid = opts.groupId ?? nextGroup++
        for (const id of opts.tabIds) tabs.get(id)!.groupId = gid
        return gid
      }),
      query: vi.fn(async (q: { groupId?: number }) => [...tabs.values()].filter((t) => q.groupId == null || t.groupId === q.groupId)),
      update: vi.fn(async () => ({})),
      ungroup: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
      onCreated: { addListener: vi.fn((fn: (t: Tab) => void) => void (listeners.onCreated = fn)) },
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
      sendCommand: vi.fn(async (target: unknown, method: string, params: unknown) => {
        sent.push({ target, method, params })
        if (method === 'Runtime.evaluate') return { result: { value: JSON.stringify({ rs: 'complete', href: 'https://a.test/' }) } }
        return {}
      }),
      onEvent: { addListener: vi.fn((fn: typeof listeners.onEvent) => void (listeners.onEvent = fn)) },
      onDetach: { addListener: vi.fn() },
    },
    runtime: { onMessage: { addListener: vi.fn() }, lastError: undefined },
    system: { display: { getInfo: vi.fn(async () => []) } },
  }
  return { chrome, tabs, listeners, sent, windowType }
}

async function load() {
  const m = makeChrome()
  vi.stubGlobal('chrome', m.chrome)
  vi.resetModules()
  const mod = await import('./driver.ts')
  return { ...mod, ...m }
}

/** 先让 Stream 开一张交互标签（出身 created，进主组）。 */
async function openStreamTab(env: Awaited<ReturnType<typeof load>>): Promise<number> {
  const res = await env.dispatch({ id: 1, op: 'newTab', url: 'https://a.test/', waitUntil: 'load', background: false })
  expect(res.error).toBeUndefined()
  return (res.result as { tabId: number }).tabId
}

const listTabs = async (env: Awaited<ReturnType<typeof load>>) =>
  ((await env.dispatch({ id: 9, op: 'list' })).result as { tabs: Array<Record<string, unknown>> }).tabs

describe('自建标签开出来的标签归 Stream', () => {
  it('同一扇窗：进开启者的组、出身沿用 created、list 带 openerTabId，且可以 attach', async () => {
    const env = await load()
    const opener = await openStreamTab(env)
    const child: Tab = { id: 20, windowId: 1, groupId: -1, url: '', title: 'child', openerTabId: opener }
    env.tabs.set(20, child)
    await env.onTabCreated(child as unknown as chrome.tabs.Tab)
    expect(env.tabs.get(20)!.groupId).toBe(env.tabs.get(opener)!.groupId)
    const listed = await listTabs(env)
    expect(listed.find((t) => t.tabId === 20)).toMatchObject({ origin: 'created', grouped: true, openerTabId: opener })
    // 可驱动：CDP 命令不再被"不在组内"拒掉
    const r = await env.dispatch({ id: 3, tabId: 20, method: 'Runtime.evaluate', params: { expression: '1' } })
    expect(r.error).toBeUndefined()
  })

  it('另一扇普通窗：在那扇窗里另建一组（组只能待在一扇窗里），不把它拽回主窗', async () => {
    const env = await load()
    const opener = await openStreamTab(env)
    const child: Tab = { id: 21, windowId: 2, groupId: -1, url: '', title: 'c', openerTabId: opener }
    env.tabs.set(21, child)
    await env.onTabCreated(child as unknown as chrome.tabs.Tab)
    expect(env.chrome.tabs.group).toHaveBeenLastCalledWith({ tabIds: [21], createProperties: { windowId: 2 } })
    expect((await listTabs(env)).find((t) => t.tabId === 21)).toMatchObject({ grouped: true })
  })

  it('popup 窗：放不了组，照样在册、可驱动，list 标 popup', async () => {
    const env = await load()
    const opener = await openStreamTab(env)
    const child: Tab = { id: 22, windowId: 3, groupId: -1, url: '', title: 'p', openerTabId: opener }
    env.tabs.set(22, child)
    const groupCalls = env.chrome.tabs.group.mock.calls.length
    await env.onTabCreated(child as unknown as chrome.tabs.Tab)
    expect(env.chrome.tabs.group.mock.calls.length).toBe(groupCalls)
    expect((await listTabs(env)).find((t) => t.tabId === 22)).toMatchObject({ popup: true, grouped: false })
    const r = await env.dispatch({ id: 4, tabId: 22, method: 'Runtime.evaluate', params: { expression: '1' } })
    expect(r.error).toBeUndefined()
  })

  it('用户拖进来的标签（adopted）开出来的不收——那是他自己的页面', async () => {
    const env = await load()
    const opener = await openStreamTab(env)
    // 把开启者改成 adopted：用户拖入的那一类
    env.tabs.set(30, { id: 30, windowId: 1, groupId: env.tabs.get(opener)!.groupId, url: 'https://u.test/', title: 'u' })
    await env.addTabToGroup(30, 'adopted')
    const child: Tab = { id: 31, windowId: 1, groupId: -1, url: '', title: 'x', openerTabId: 30 }
    env.tabs.set(31, child)
    await env.onTabCreated(child as unknown as chrome.tabs.Tab)
    expect((await listTabs(env)).some((t) => t.tabId === 31)).toBe(false)
    const r = await env.dispatch({ id: 5, tabId: 31, method: 'Runtime.evaluate', params: {} })
    expect(r.error).toMatch(/not in the session tab group/)
  })

  it('没有 opener 的新标签（用户自己 Ctrl+T）一律不碰', async () => {
    const env = await load()
    await openStreamTab(env)
    const t: Tab = { id: 40, windowId: 1, groupId: -1, url: '', title: '' }
    env.tabs.set(40, t)
    await env.onTabCreated(t as unknown as chrome.tabs.Tab)
    expect((await listTabs(env)).some((x) => x.tabId === 40)).toBe(false)
  })
})

describe('iframe 子会话（OOPIF）', () => {
  it('attach 时开 auto-attach（flatten，只要 iframe）；attachedToTarget 被记下，frames op 列得出', async () => {
    const env = await load()
    const tab = await openStreamTab(env)
    const aa = env.sent.find((s) => s.method === 'Target.setAutoAttach')
    expect(aa?.params).toMatchObject({ autoAttach: true, flatten: true, waitForDebuggerOnStart: false })
    env.listeners.onEvent!({ tabId: tab }, 'Target.attachedToTarget', {
      sessionId: 'S1',
      targetInfo: { type: 'iframe', targetId: 'F1', url: 'https://other.test/f' },
    })
    // 嵌套 OOPIF 要在子会话上再开一次
    expect(env.sent.some((s) => s.method === 'Target.setAutoAttach' && (s.target as { sessionId?: string }).sessionId === 'S1')).toBe(true)
    const r = await env.dispatch({ id: 6, op: 'frames', tabId: tab })
    expect(r.result).toEqual({ sessions: [{ sessionId: 'S1', targetId: 'F1', url: 'https://other.test/f' }] })
  })

  it('命令带 sessionId 就打进那条子会话；不认识的 sessionId 被拒（不替后端去碰别的东西）', async () => {
    const env = await load()
    const tab = await openStreamTab(env)
    env.listeners.onEvent!({ tabId: tab }, 'Target.attachedToTarget', {
      sessionId: 'S1',
      targetInfo: { type: 'iframe', targetId: 'F1', url: 'u' },
    })
    const ok = await env.dispatch({ id: 7, tabId: tab, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'S1' })
    expect(ok.error).toBeUndefined()
    expect(env.sent.at(-1)!.target).toEqual({ tabId: tab, sessionId: 'S1' })
    const bad = await env.dispatch({ id: 8, tabId: tab, method: 'Runtime.evaluate', params: {}, sessionId: 'NOPE' })
    expect(bad.error).toMatch(/not an iframe session/)
    env.listeners.onEvent!({ tabId: tab, sessionId: undefined }, 'Target.detachedFromTarget', { sessionId: 'S1' })
    expect(env.frameSessionsOf(tab)).toEqual([])
  })
})
