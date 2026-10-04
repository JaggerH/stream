import { describe, it, expect, vi } from 'vitest'

// ── 关自建标签时页面弹「离开此网站？」→ 替它按掉，照关 ──
// 用户在探针里改过东西（2026-09-19 活体：Photopea 的 lane 标签被拿去改 PSD），页面注册了
// beforeunload，tabs.remove 会停在对话框上直到有人点。自建标签关就是关：remove 期间盯着
// Page.javascriptDialogOpening，一来就 handleJavaScriptDialog accept。
type Listener = (source: { tabId?: number }, method: string, params?: unknown) => void

function makeChrome() {
  const session: Record<string, unknown> = {}
  const local: Record<string, unknown> = {}
  const live = new Set<number>()
  const listeners: Listener[] = []
  const store = (bag: Record<string, unknown>) => ({
    get: vi.fn(async (key: string | string[]) => Object.fromEntries((Array.isArray(key) ? key : [key]).map((k) => [k, bag[k]]))),
    set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(bag, obj) }),
    remove: vi.fn(async (key: string | string[]) => { for (const k of Array.isArray(key) ? key : [key]) delete bag[k] }),
  })
  let dialogAccepted: (() => void) | null = null
  const sendCommand = vi.fn(async (_t: { tabId: number }, method: string) => {
    if (method === 'Page.handleJavaScriptDialog') dialogAccepted?.()
    return {}
  })
  return {
    storage: { session: store(session), local: store(local) },
    tabs: {
      group: vi.fn(async (opts: { groupId?: number; tabIds: number[] }) => { opts.tabIds.forEach((t) => live.add(t)); return opts.groupId ?? 777 }),
      ungroup: vi.fn(async (tabId: number) => { live.delete(tabId) }),
      get: vi.fn(async (tabId: number) => ({ id: tabId, active: false, url: 'https://a.example/', title: 'T', groupId: live.has(tabId) ? 777 : -1 })),
      create: vi.fn(async () => ({ id: 5 })),
      // 页面拦了 beforeunload：remove 挂在对话框上，直到有人 handleJavaScriptDialog
      remove: vi.fn(async (tabId: number) => {
        await new Promise<void>((resolve, reject) => {
          dialogAccepted = resolve
          const t = setTimeout(() => reject(new Error('dialog never accepted')), 500)
          for (const l of listeners) l({ tabId }, 'Page.javascriptDialogOpening', { type: 'beforeunload', message: '' })
          void t
        })
        live.delete(tabId)
      }),
      query: vi.fn(async (q: { groupId?: number }) => (q.groupId === 777 ? [...live].map((id) => ({ id })) : [])),
      onUpdated: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
    },
    tabGroups: { onUpdated: { addListener: vi.fn() }, update: vi.fn(async () => {}) },
    windows: { create: vi.fn(async () => ({ id: 1, tabs: [{ id: 5 }] })), getAll: vi.fn(async () => [{ id: 1 }]) },
    system: { display: { getInfo: vi.fn(async () => []) } },
    debugger: {
      onEvent: { addListener: vi.fn((fn: Listener) => listeners.push(fn)) },
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand,
    },
  }
}

describe('关自建标签撞上 beforeunload 对话框', () => {
  it('remove 期间收到 javascriptDialogOpening → accept，标签照关、不挂', async () => {
    const chrome = makeChrome()
    vi.stubGlobal('chrome', chrome)
    vi.resetModules()
    const mod = await import('./driver.ts')
    await mod.addTabToGroup(5, 'probe')
    const res = await mod.dispatch({ id: 1, op: 'closeTab', tabId: 5 })
    expect(res.error).toBeUndefined()
    expect(chrome.tabs.remove).toHaveBeenCalledWith(5)
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 5 }, 'Page.enable')
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 5 }, 'Page.handleJavaScriptDialog', { accept: true })
    // remove 在 detach 之前：detach 了就收不到对话框事件
    const order = chrome.debugger.detach.mock.invocationCallOrder[0]!
    expect(chrome.tabs.remove.mock.invocationCallOrder[0]!).toBeLessThan(order)
    expect(await mod.tabOrigin(5)).toBeUndefined()
  })

  it('别的标签弹对话框（不是我们在关的）→ 不碰', async () => {
    const chrome = makeChrome()
    vi.stubGlobal('chrome', chrome)
    vi.resetModules()
    await import('./driver.ts')
    const [l] = (chrome.debugger.onEvent.addListener as unknown as { mock: { calls: Listener[][] } }).mock.calls.map((c) => c[0]!)
    l!({ tabId: 9 }, 'Page.javascriptDialogOpening', { type: 'beforeunload' })
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith({ tabId: 9 }, 'Page.handleJavaScriptDialog', expect.anything())
  })
})
