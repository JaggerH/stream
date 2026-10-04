import { describe, it, expect, vi } from 'vitest'

// op:openTab = 「打开一个页面」这件事本身：find-or-open，不挂 debugger、不注入脚本。
// 它存在的理由是 newTab 那条路开不了 chrome://* —— attach 一步炸 `Cannot access a chrome:// URL`，
// 而 tab 早就建出来了，留下一个没人管的空窗口（真发生过两次）。

type FakeTab = { id: number; url: string; title: string; windowId: number; groupId?: number }

function makeChrome(state: { tabs: FakeTab[]; windows: number[]; nextId?: number; titleAfter?: number }) {
  const calls = {
    updated: [] as number[],
    focused: [] as number[],
    created: [] as string[],
    grouped: [] as Array<{ groupId?: number; tabIds: number[]; createProperties?: { windowId?: number } }>,
    windowUrls: [] as string[],
    windowOpts: [] as Array<Record<string, unknown>>,
    groupTitles: [] as string[],
  }
  let getCount = 0
  const local: Record<string, unknown> = {}
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
      tabs: {
        query: vi.fn(async (q: { groupId?: number } = {}) =>
          state.tabs.filter((t) => q.groupId == null || t.groupId === q.groupId).map((t) => ({ ...t })),
        ),
        get: vi.fn(async (id: number) => {
          const t = state.tabs.find((x) => x.id === id)
          if (!t) throw new Error(`No tab with id: ${id}`)
          getCount += 1
          // titleAfter：第 N 次 get 之后才有 title——模拟"刚建出来的 tab 还没标题"
          if (state.titleAfter != null && getCount >= state.titleAfter) t.title = t.title || 'Extensions'
          return { ...t }
        }),
        create: vi.fn(async ({ url }: { url: string }) => {
          const id = state.nextId ?? 99
          calls.created.push(url)
          const tab = { id, url, title: '', windowId: 1 }
          state.tabs.push(tab)
          return { ...tab }
        }),
        update: vi.fn(async (tabId: number, _p: { active: boolean }) => {
          calls.updated.push(tabId)
          return { id: tabId }
        }),
        group: vi.fn(async (opts: { groupId?: number; tabIds: number[]; createProperties?: { windowId?: number } }) => {
          calls.grouped.push(opts)
          // 新窗里另起的组给另一个 id，好和主组分开
          const gid = opts.groupId ?? (opts.createProperties ? 888 : 777)
          for (const t of state.tabs) if (opts.tabIds.includes(t.id)) t.groupId = gid
          return gid
        }),
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      tabGroups: {
        update: vi.fn(async (_id: number, p: { title: string }) => {
          calls.groupTitles.push(p.title)
          return {}
        }),
        query: vi.fn(async () => []),
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      windows: {
        getAll: vi.fn(async () => state.windows.map((id) => ({ id }))),
        // 真 chrome：windows.create 回来的 Window 带着它那张初始标签——调用方要用的就是它。
        create: vi.fn(async (opts: { url: string }) => {
          calls.windowUrls.push(opts.url)
          calls.windowOpts.push(opts)
          const id = state.nextId ?? 99
          const win = state.windows.length ? Math.max(...state.windows) + 1 : 1
          const tab = { id, url: opts.url, title: '', windowId: win }
          state.tabs.push(tab)
          state.windows.push(win)
          return { id: win, tabs: [{ ...tab }] }
        }),
        update: vi.fn(async (windowId: number) => {
          calls.focused.push(windowId)
          return { id: windowId }
        }),
      },
      cookies: { getAll: vi.fn(async () => []) },
      debugger: {
        attach: vi.fn(async () => {
          throw new Error('Cannot access a chrome:// URL')
        }),
        sendCommand: vi.fn(async () => ({})),
        onEvent: { addListener: vi.fn() },
        onDetach: { addListener: vi.fn() },
      },
      runtime: { onMessage: { addListener: vi.fn() }, lastError: undefined },
      system: { display: { getInfo: vi.fn(async () => []) } },
    },
  }
}

async function load(state: { tabs: FakeTab[]; windows: number[]; nextId?: number; titleAfter?: number }) {
  const m = makeChrome(state)
  vi.stubGlobal('chrome', m.chrome)
  vi.resetModules()
  const mod = await import('./driver.ts')
  return { dispatch: mod.dispatch, sameUrl: mod.sameUrl, ...m }
}

type Receipt = { tabId: number; title: string; url: string; created: boolean }

describe('sameUrl', () => {
  it('ignores the trailing slash — chrome://extensions IS chrome://extensions/', async () => {
    const { sameUrl } = await load({ tabs: [], windows: [1] })
    expect(sameUrl('chrome://extensions', 'chrome://extensions/')).toBe(true)
    expect(sameUrl('https://a.test/x/', 'https://a.test/x')).toBe(true)
    expect(sameUrl('https://a.test', 'https://a.test/')).toBe(true)
  })
  it('ignores scheme/host case but keeps path case (the server does)', async () => {
    const { sameUrl } = await load({ tabs: [], windows: [1] })
    expect(sameUrl('HTTPS://A.test/x', 'https://a.TEST/x')).toBe(true)
    expect(sameUrl('https://a.test/X', 'https://a.test/x')).toBe(false)
  })
  it('keeps query and hash significant — #privacy is which screen, not decoration', async () => {
    const { sameUrl } = await load({ tabs: [], windows: [1] })
    expect(sameUrl('chrome://settings/#privacy', 'chrome://settings/')).toBe(false)
    expect(sameUrl('https://a.test/?q=1', 'https://a.test/?q=2')).toBe(false)
    expect(sameUrl('chrome://settings#privacy', 'chrome://settings/#privacy')).toBe(true)
  })
  it('unparsable addresses fall back to exact compare — rather one extra tab than the wrong one', async () => {
    const { sameUrl } = await load({ tabs: [], windows: [1] })
    expect(sameUrl('not a url', 'not a url')).toBe(true)
    expect(sameUrl('not a url', 'https://a.test')).toBe(false)
  })
})

describe('dispatch op:openTab', () => {
  it('reuses an already-open tab (activates it, focuses its window) instead of piling up duplicates', async () => {
    const { dispatch, calls } = await load({
      tabs: [{ id: 5, url: 'chrome://extensions/', title: 'Extensions', windowId: 3 }],
      windows: [3],
    })
    const res = await dispatch({ id: 1, op: 'openTab', url: 'chrome://extensions' })
    expect(res.error).toBeUndefined()
    expect(res.result as Receipt).toEqual({ tabId: 5, title: 'Extensions', url: 'chrome://extensions/', created: false })
    expect(calls.updated).toEqual([5])
    expect(calls.focused).toEqual([3])
    expect(calls.created).toEqual([])
  })

  it('creates the tab when nothing matches, and says created:true', async () => {
    const { dispatch, calls, chrome } = await load({
      tabs: [{ id: 5, url: 'https://other.test/', title: 'Other', windowId: 1 }],
      windows: [1],
      nextId: 7,
      titleAfter: 2,
    })
    const res = await dispatch({ id: 2, op: 'openTab', url: 'chrome://extensions' })
    const r = res.result as Receipt
    expect(r.tabId).toBe(7)
    expect(r.created).toBe(true)
    expect(calls.created).toEqual(['chrome://extensions'])
    expect(calls.focused).toEqual([1])
    // 这条命令的全部意义就在于此：chrome:// 页面开得了，因为压根没碰 debugger。
    expect(chrome.debugger.attach).not.toHaveBeenCalled()
  })

  it('waits for a title to show up (the caller needs it to build app:chrome.exe/<title>)', async () => {
    const { dispatch } = await load({ tabs: [], windows: [1], nextId: 8, titleAfter: 3 })
    const r = (await dispatch({ id: 3, op: 'openTab', url: 'chrome://extensions' })).result as Receipt
    expect(r.title).toBe('Extensions')
  })

  it('returns a receipt with a title FIELD even when the page never titled itself', async () => {
    // 超时不是失败：字段一定在（可为空串），让调用方自己决定退不退。
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 200 })
    try {
      const { dispatch } = await load({ tabs: [], windows: [1], nextId: 9 })
      const r = (await dispatch({ id: 4, op: 'openTab', url: 'https://slow.test' })).result as Receipt
      expect(r).toEqual({ tabId: 9, title: '', url: 'https://slow.test', created: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('creates a window first when Chrome has none (--no-startup-window is the normal wake-up)', async () => {
    const { dispatch, chrome, calls } = await load({ tabs: [], windows: [], nextId: 10, titleAfter: 1 })
    const r = (await dispatch({ id: 5, op: 'openTab', url: 'https://a.test' })).result as Receipt
    expect(chrome.windows.create).toHaveBeenCalled()
    // 那扇窗自带一张标签——**用它**，别再 tabs.create 一张。否则窗口那张 about:blank 就是一张
    // 谁也不认领、组外、没人回收的孤儿标签（用户看得见它，而它不在 Stream 组里）。
    expect(calls.windowUrls).toEqual(['https://a.test'])
    expect(chrome.tabs.create).not.toHaveBeenCalled()
    expect(r.tabId).toBe(10)
  })

  // ── 归属：扩展自己开的标签，一律进会话组 ──
  // 判据是「这张标签是不是我们开的」，不是「它可不可被驱动」。用户在标签栏里看到的每一张
  // Stream 开出来的页面都该在 Stream 组里，不管它是 https 还是 chrome://——组是**归属与可见**
  // 的边界（拖出即撤销），不可驱动只是 chrome:// 自身的限制，与归属无关。
  it('puts the tab it created into the session group', async () => {
    const { dispatch, calls, chrome } = await load({ tabs: [], windows: [1], nextId: 11, titleAfter: 1 })
    await dispatch({ id: 6, op: 'openTab', url: 'chrome://extensions' })
    expect(calls.grouped).toEqual([{ tabIds: [11] }])
    expect(await chrome.storage.local.set.mock.calls.length).toBeGreaterThan(0)
    // 归属不等于挂 debugger：这条命令依旧一个字节都不注入。
    expect(chrome.debugger.attach).not.toHaveBeenCalled()
  })

  it('groups the tab it created in the window it had to create', async () => {
    const { dispatch, calls } = await load({ tabs: [], windows: [], nextId: 12, titleAfter: 1 })
    await dispatch({ id: 7, op: 'openTab', url: 'https://a.test' })
    expect(calls.grouped).toEqual([{ tabIds: [12] }])
  })

  it('does NOT drag a tab the user already had open into the group — we only activated it', async () => {
    // find-or-open 命中的那张是**用户自己的**标签。把它拽进 Stream 组等于替他做了「拖入=授权」
    // 那个动作；我们只是切过去看一眼。回执里的 created:false 就是这个分界。
    const { dispatch, calls } = await load({
      tabs: [{ id: 5, url: 'https://a.test/', title: 'A', windowId: 3 }],
      windows: [3],
    })
    await dispatch({ id: 8, op: 'openTab', url: 'https://a.test' })
    expect(calls.grouped).toEqual([])
  })
})

// ownWindow:给要一直跑着的页面（游戏）单开一扇窗。整条的意义是**不抢用户的屏幕**：
// 跟用户挤一扇窗，它一被挤到后台就不出帧，要它跑就得切回来，而 Chrome 切标签会把整扇窗抬到前面。
describe('dispatch op:openTab ownWindow', () => {
  const GAME = 'http://127.0.0.1:8090/index.html?stream'

  it('opens in a new unfocused window, groups it THERE, and never focuses anything', async () => {
    const { dispatch, calls } = await load({ tabs: [{ id: 5, url: 'https://x.test/', title: 'X', windowId: 3 }], windows: [3], nextId: 20, titleAfter: 1 })
    const r = (await dispatch({ id: 1, op: 'openTab', url: GAME, ownWindow: true })).result as Receipt
    expect(r).toMatchObject({ tabId: 20, created: true })
    expect(calls.windowOpts).toEqual([expect.objectContaining({ url: GAME, focused: false })])
    // 组只能待在一扇窗里：编进主组会把标签搬回用户那扇窗，所以在新窗里另起一组
    expect(calls.grouped).toEqual([{ tabIds: [20], createProperties: { windowId: 4 } }])
    expect(calls.groupTitles).toEqual(['Stream 独立窗'])
    expect(calls.focused).toEqual([])
    expect(calls.updated).toEqual([])
  })

  it('stays drivable: list reports it as grouped', async () => {
    const { dispatch } = await load({ tabs: [], windows: [3], nextId: 21, titleAfter: 1 })
    await dispatch({ id: 1, op: 'openTab', url: GAME, ownWindow: true })
    const { tabs } = (await dispatch({ id: 2, op: 'list' })).result as { tabs: Array<{ tabId: number; grouped: boolean; origin: string }> }
    expect(tabs).toEqual([expect.objectContaining({ tabId: 21, grouped: true, origin: 'created' })])
  })

  it('reuses its own window tab on the next call — no new window, no activate, no focus', async () => {
    const { dispatch, calls } = await load({ tabs: [], windows: [3], nextId: 22, titleAfter: 1 })
    await dispatch({ id: 1, op: 'openTab', url: GAME, ownWindow: true })
    const r = (await dispatch({ id: 2, op: 'openTab', url: GAME, ownWindow: true })).result as Receipt
    expect(r).toMatchObject({ tabId: 22, created: false })
    expect(calls.windowOpts).toHaveLength(1)
    expect(calls.updated).toEqual([])
    expect(calls.focused).toEqual([])
  })

  it("ignores the user's own tab on the same URL — that one lives in the user's window", async () => {
    const { dispatch, calls } = await load({ tabs: [{ id: 5, url: GAME, title: 'Game', windowId: 3 }], windows: [3], nextId: 23, titleAfter: 1 })
    const r = (await dispatch({ id: 1, op: 'openTab', url: GAME, ownWindow: true })).result as Receipt
    expect(r).toMatchObject({ tabId: 23, created: true })
    expect(calls.updated).toEqual([])
    expect(calls.focused).toEqual([])
  })
})
