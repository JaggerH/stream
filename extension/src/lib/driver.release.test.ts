import { describe, it, expect, vi } from 'vitest'

// ── 被 Stream 唤起的 profile：执行期间按住、执行完放掉（browser-identity D8）──
// Chrome 实测：静默加载的 profile 不会自己卸载；关掉它的最后一扇窗，5 秒内卸载。所以执行中途不能关最后一扇窗
// （按住），执行完要关（放掉）——只关 Stream 自己的标签与只装着它们的窗，用户的一根毛都不碰。

/** 一个只有窗与标签的小 Chrome：关掉窗里最后一张标签，窗随之消失（真 Chrome 也是这样）。 */
function makeChrome(initial: Record<number, number[]>) {
  const session: Record<string, unknown> = {}
  const local: Record<string, unknown> = {}
  const windows = new Map<number, number[]>(Object.entries(initial).map(([w, t]) => [Number(w), [...t]]))
  const grouped = new Set<number>()
  const urls = new Map<number, string>()
  let nextWin = 100
  let nextTab = 500
  const store = (bag: Record<string, unknown>) => ({
    get: vi.fn(async (key: string | string[]) => Object.fromEntries((Array.isArray(key) ? key : [key]).map((k) => [k, bag[k]]))),
    set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(bag, obj) }),
    remove: vi.fn(async (key: string | string[]) => { for (const k of Array.isArray(key) ? key : [key]) delete bag[k] }),
  })
  const windowOf = (tabId: number) => [...windows].find(([, ts]) => ts.includes(tabId))?.[0]
  const removeTab = (tabId: number) => {
    const w = windowOf(tabId)
    if (w == null) return
    const left = windows.get(w)!.filter((t) => t !== tabId)
    if (left.length) windows.set(w, left)
    else windows.delete(w)
    grouped.delete(tabId)
  }
  const chrome = {
    storage: { session: store(session), local: store(local), onChanged: { addListener: vi.fn() } },
    tabs: {
      group: vi.fn(async (opts: { groupId?: number; tabIds: number[] }) => { opts.tabIds.forEach((t) => grouped.add(t)); return opts.groupId ?? 777 }),
      ungroup: vi.fn(async (tabId: number) => { grouped.delete(tabId) }),
      get: vi.fn(async (tabId: number) => {
        const w = windowOf(tabId)
        if (w == null) throw new Error('No tab')
        return { id: tabId, windowId: w, active: false, url: urls.get(tabId) ?? 'https://a.example/', title: 'T', groupId: grouped.has(tabId) ? 777 : -1 }
      }),
      remove: vi.fn(async (tabId: number) => { removeTab(tabId) }),
      update: vi.fn(async (tabId: number, props: { url?: string }) => { if (props.url) urls.set(tabId, props.url); return { id: tabId } }),
      query: vi.fn(async (q: { windowId?: number; groupId?: number }) => {
        if (q.windowId != null) return (windows.get(q.windowId) ?? []).map((id) => ({ id }))
        if (q.groupId === 777) return [...grouped].map((id) => ({ id }))
        return []
      }),
      create: vi.fn(async () => ({ id: ++nextTab })),
      onUpdated: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
      onCreated: { addListener: vi.fn() },
    },
    tabGroups: { onUpdated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() }, update: vi.fn(async () => {}), query: vi.fn(async () => []) },
    windows: {
      getAll: vi.fn(async () => [...windows].map(([id, ts]) => ({ id, type: 'normal', tabs: ts.map((t) => ({ id: t, windowId: id })) }))),
      create: vi.fn(async () => { const id = ++nextWin; const t = ++nextTab; windows.set(id, [t]); return { id, tabs: [{ id: t }] } }),
      remove: vi.fn(async (id: number) => { windows.delete(id) }),
      get: vi.fn(async (id: number) => ({ id, type: 'normal' })),
      update: vi.fn(async () => ({})),
    },
    system: { display: { getInfo: vi.fn(async () => []) } },
    debugger: {
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({})),
    },
    runtime: { onMessage: { addListener: vi.fn() }, lastError: undefined },
  }
  return { chrome, windows, grouped, urls }
}

async function load(initial: Record<number, number[]>) {
  const w = makeChrome(initial)
  vi.stubGlobal('chrome', w.chrome)
  vi.resetModules()
  const mod = await import('./driver.ts')
  return { ...w, mod }
}

describe('holdProfile：执行中途不关最后一扇窗', () => {
  it('按住时关最后一扇窗里最后一张自建标签 → 标签换成 about:blank 留着，窗还在', async () => {
    const { mod, windows, urls, chrome } = await load({ 1: [5] })
    await mod.addTabToGroup(5, 'probe')
    expect((await mod.dispatch({ id: 1, op: 'holdProfile' })).error).toBeUndefined()
    const res = await mod.dispatch({ id: 2, op: 'closeTab', tabId: 5 })
    expect(res.error).toBeUndefined()
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
    expect(windows.get(1)).toEqual([5])
    expect(urls.get(5)).toBe('about:blank')
    // 还在组里：放掉时由 releaseProfile 关
    expect(await mod.tabOrigin(5)).toBe('probe')
  })

  it('不是最后一张（同窗还有别的）→ 照常关', async () => {
    const { mod, windows } = await load({ 1: [5, 6] })
    await mod.addTabToGroup(5, 'probe')
    await mod.dispatch({ id: 1, op: 'holdProfile' })
    await mod.dispatch({ id: 2, op: 'closeTab', tabId: 5 })
    expect(windows.get(1)).toEqual([6])
  })

  it('没按住 → 照常关（窗随之关掉），与升级前一样', async () => {
    const { mod, windows } = await load({ 1: [5] })
    await mod.addTabToGroup(5, 'created')
    await mod.dispatch({ id: 2, op: 'closeTab', tabId: 5 })
    expect(windows.size).toBe(0)
  })
})

describe('releaseProfile：只收 Stream 的东西，换来卸载', () => {
  it('只装着自建标签的窗被关掉；回报没有用户窗口、即将卸载', async () => {
    const { mod, windows } = await load({ 1: [5, 6] })
    await mod.addTabToGroup(5, 'probe')
    await mod.addTabToGroup(6, 'created')
    await mod.dispatch({ id: 1, op: 'holdProfile' })
    const res = await mod.dispatch({ id: 2, op: 'releaseProfile' })
    expect(res.result).toEqual({ closedTabs: 2, userWindows: 0, unloading: true })
    expect(windows.size).toBe(0)
    expect(await mod.groupMembers()).toEqual([])
  })

  it('用户自己的窗：只关我们的标签，他的窗和标签都不碰；他拖进组的（adopted）原样留着', async () => {
    const { mod, windows, grouped, chrome } = await load({ 1: [5], 2: [7, 8, 9] })
    await mod.addTabToGroup(5, 'probe')
    await mod.addTabToGroup(8, 'created')
    await mod.addTabToGroup(9, 'adopted')
    const res = await mod.dispatch({ id: 2, op: 'releaseProfile' })
    expect(res.result).toEqual({ closedTabs: 2, userWindows: 1, unloading: false })
    expect(windows.has(1)).toBe(false)
    expect(windows.get(2)).toEqual([7, 9])
    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(9)
    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(7)
    // 拖进组是用户自己的授权，收尾不替他撤销（他的窗也不会因此关掉）
    expect(grouped.has(9)).toBe(true)
  })

  it('一扇窗都没有（纯 HTTP 的执行）→ 造一扇不聚焦的窗再关掉', async () => {
    const { mod, windows, chrome } = await load({})
    const res = await mod.dispatch({ id: 2, op: 'releaseProfile' })
    expect(res.result).toEqual({ closedTabs: 0, userWindows: 0, unloading: true })
    expect(chrome.windows.create).toHaveBeenCalledWith({ focused: false, url: 'about:blank' })
    expect(chrome.windows.remove).toHaveBeenCalledTimes(1)
    expect(windows.size).toBe(0)
  })

  it('放掉之后不再按住：再关最后一张就真关', async () => {
    const { mod, windows } = await load({ 1: [5] })
    await mod.dispatch({ id: 1, op: 'holdProfile' })
    await mod.dispatch({ id: 2, op: 'releaseProfile' })
    windows.set(3, [11])
    await mod.addTabToGroup(11, 'probe')
    await mod.dispatch({ id: 3, op: 'closeTab', tabId: 11 })
    expect(windows.has(3)).toBe(false)
  })
})
