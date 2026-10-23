import { describe, it, expect, vi } from 'vitest'

// 一个 profile、一条绑定，浏览器里至多一个 Stream 组（design D13）。
//
// 病根：组内标签在**别的普通窗**里开出新标签（站点 window.open 开新窗）时，旧版在那扇窗里另建一组
// 「Stream 独立窗」。组不能跨窗，交互标签（created）SW 醒来又不回收，于是窗和组只增不减——用户实测
// 攒了近 50 个。改为：把新标签挪回主组那扇窗、入主组，随它开出来的空窗关掉；popup 照旧不动。
// 升级后醒来把旧版留下的「Stream 独立窗」组收编掉，同名的多个主组合并成一个。

type Tab = { id: number; windowId: number; groupId: number; url: string; title: string; openerTabId?: number }
type Group = { id: number; title?: string }

function makeChrome() {
  const local: Record<string, unknown> = {}
  const session: Record<string, unknown> = {}
  const tabs = new Map<number, Tab>()
  const windows = new Map<number, string>([[1, 'normal']]) // windowId → type
  const groups = new Map<number, Group>()
  let nextGroup = 500
  let nextTab = 10
  /** 组的窗口 = 它的标签所在的窗（组只能待在一扇窗里）；没有标签的组在浏览器里就不存在了。 */
  const groupWindow = (gid: number) => [...tabs.values()].find((t) => t.groupId === gid)?.windowId
  const liveGroups = () => [...groups.values()].filter((g) => groupWindow(g.id) != null)
  const chrome = {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: session[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => void Object.assign(session, obj)),
      },
      local: {
        get: vi.fn(async (key: string | string[]) =>
          Object.fromEntries((Array.isArray(key) ? key : [key]).map((k) => [k, local[k]])),
        ),
        set: vi.fn(async (obj: Record<string, unknown>) => void Object.assign(local, obj)),
        remove: vi.fn(async (key: string) => void delete local[key]),
      },
      onChanged: { addListener: vi.fn() },
    },
    windows: {
      getAll: vi.fn(async () => [...windows.keys()].map((id) => ({ id, type: windows.get(id) }))),
      get: vi.fn(async (id: number) => {
        if (!windows.has(id)) throw new Error(`No window with id: ${id}`)
        return { id, type: windows.get(id) }
      }),
      create: vi.fn(),
      update: vi.fn(async () => ({})),
      remove: vi.fn(async (id: number) => {
        windows.delete(id)
        for (const t of [...tabs.values()]) if (t.windowId === id) tabs.delete(t.id)
      }),
    },
    tabs: {
      create: vi.fn(async ({ url }: { url: string }) => {
        const win = [...windows.keys()].find((w) => windows.get(w) === 'normal')!
        const t = { id: nextTab++, windowId: win, groupId: -1, url, title: '' }
        tabs.set(t.id, t)
        return t
      }),
      get: vi.fn(async (id: number) => {
        const t = tabs.get(id)
        if (!t) throw new Error(`No tab with id: ${id}`)
        return t
      }),
      group: vi.fn(async (opts: { groupId?: number; tabIds: number[]; createProperties?: { windowId: number } }) => {
        let gid: number
        let win: number
        if (opts.groupId != null) {
          const w = groupWindow(opts.groupId)
          if (w == null) throw new Error(`No group with id: ${opts.groupId}`)
          gid = opts.groupId
          win = w
        } else {
          gid = nextGroup++
          groups.set(gid, { id: gid })
          win = opts.createProperties?.windowId ?? tabs.get(opts.tabIds[0])!.windowId
        }
        // 真 Chrome：进别的窗的组 = 标签被挪进那扇窗
        for (const id of opts.tabIds) Object.assign(tabs.get(id)!, { groupId: gid, windowId: win })
        return gid
      }),
      move: vi.fn(async (id: number, props: { windowId?: number; index: number }) => {
        const t = tabs.get(id)!
        if (props.windowId != null) {
          if (windows.get(props.windowId) !== 'normal') throw new Error('Tabs can only be moved to and from normal windows.')
          Object.assign(t, { windowId: props.windowId, groupId: -1 })
        }
        return t
      }),
      query: vi.fn(async (q: { groupId?: number; windowId?: number }) =>
        [...tabs.values()].filter(
          (t) => (q.groupId == null || t.groupId === q.groupId) && (q.windowId == null || t.windowId === q.windowId),
        ),
      ),
      update: vi.fn(async () => ({})),
      ungroup: vi.fn(async (ids: number | number[]) => {
        for (const id of [ids].flat()) if (tabs.has(id)) tabs.get(id)!.groupId = -1
      }),
      remove: vi.fn(async (id: number) => void tabs.delete(id)),
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
      onCreated: { addListener: vi.fn() },
    },
    tabGroups: {
      update: vi.fn(async (gid: number, p: { title?: string }) => {
        Object.assign(groups.get(gid)!, p)
        return groups.get(gid)
      }),
      get: vi.fn(async (gid: number) => {
        const w = groupWindow(gid)
        if (w == null) throw new Error(`No group with id: ${gid}`)
        return { ...groups.get(gid)!, windowId: w }
      }),
      query: vi.fn(async (q: { title?: string }) =>
        liveGroups()
          .filter((g) => q.title == null || g.title === q.title)
          .map((g) => ({ ...g, windowId: groupWindow(g.id) })),
      ),
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    cookies: { getAll: vi.fn(async () => []) },
    debugger: {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (_t: unknown, method: string) =>
        method === 'Runtime.evaluate' ? { result: { value: JSON.stringify({ rs: 'complete', href: 'https://a.test/' }) } } : {},
      ),
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
    runtime: { onMessage: { addListener: vi.fn() }, lastError: undefined },
    system: { display: { getInfo: vi.fn(async () => []) } },
  }
  /** 浏览器里此刻还在的组（按标题）。 */
  const groupTitles = () => liveGroups().map((g) => g.title)
  /** 造一个现存的组（模拟旧版留下的），返回 groupId。 */
  const seedGroup = (title: string, windowId: number, tabIds: number[]): number => {
    const gid = nextGroup++
    groups.set(gid, { id: gid, title })
    if (!windows.has(windowId)) windows.set(windowId, 'normal')
    for (const id of tabIds) tabs.set(id, { id, windowId, groupId: gid, url: `https://t${id}.test/`, title: '' })
    return gid
  }
  return { chrome, tabs, windows, groups, local, groupTitles, seedGroup }
}

async function load(setup?: (m: ReturnType<typeof makeChrome>) => void) {
  const m = makeChrome()
  setup?.(m)
  vi.stubGlobal('chrome', m.chrome)
  vi.resetModules()
  const mod = await import('./driver.ts')
  return { ...mod, ...m }
}
type Env = Awaited<ReturnType<typeof load>>

async function openStreamTab(env: Env): Promise<number> {
  const res = await env.dispatch({ id: 1, op: 'newTab', url: 'https://a.test/', waitUntil: 'load', background: false })
  expect(res.error).toBeUndefined()
  return (res.result as { tabId: number }).tabId
}

const listTabs = async (env: Env) =>
  ((await env.dispatch({ id: 9, op: 'list' })).result as { tabs: Array<Record<string, unknown>> }).tabs

describe('组内标签在别的普通窗里开出新标签', () => {
  it('挪回主组那扇窗、入主组；随它开出来的空窗关掉；浏览器里没有新增组', async () => {
    const env = await load()
    const opener = await openStreamTab(env)
    const main = env.tabs.get(opener)!.groupId
    env.windows.set(2, 'normal')
    const child: Tab = { id: 21, windowId: 2, groupId: -1, url: '', title: 'c', openerTabId: opener }
    env.tabs.set(21, child)
    await env.onTabCreated(child as unknown as chrome.tabs.Tab)

    expect(env.chrome.tabs.move).toHaveBeenCalledWith(21, expect.objectContaining({ windowId: 1 }))
    expect(env.tabs.get(21)).toMatchObject({ windowId: 1, groupId: main })
    expect(env.chrome.windows.remove).toHaveBeenCalledWith(2)
    expect(env.groupTitles()).toEqual(['Stream'])
    expect((await listTabs(env)).find((t) => t.tabId === 21)).toMatchObject({ origin: 'created', grouped: true })
    const r = await env.dispatch({ id: 3, tabId: 21, method: 'Runtime.evaluate', params: { expression: '1' } })
    expect(r.error).toBeUndefined()
  })

  it('那扇窗里还有用户自己的标签：只挪我们的，窗不关', async () => {
    const env = await load()
    const opener = await openStreamTab(env)
    env.windows.set(2, 'normal')
    env.tabs.set(50, { id: 50, windowId: 2, groupId: -1, url: 'https://mine.test/', title: 'mine' })
    const child: Tab = { id: 21, windowId: 2, groupId: -1, url: '', title: 'c', openerTabId: opener }
    env.tabs.set(21, child)
    await env.onTabCreated(child as unknown as chrome.tabs.Tab)

    expect(env.tabs.get(21)!.windowId).toBe(1)
    expect(env.chrome.windows.remove).not.toHaveBeenCalled()
    expect(env.tabs.get(50)).toMatchObject({ windowId: 2, groupId: -1 })
  })

  it('popup 窗：不挪、不建组，照旧在册可驱动', async () => {
    const env = await load()
    const opener = await openStreamTab(env)
    env.windows.set(3, 'popup')
    const child: Tab = { id: 22, windowId: 3, groupId: -1, url: '', title: 'p', openerTabId: opener }
    env.tabs.set(22, child)
    const groupCalls = env.chrome.tabs.group.mock.calls.length
    await env.onTabCreated(child as unknown as chrome.tabs.Tab)

    expect(env.chrome.tabs.move).not.toHaveBeenCalled()
    expect(env.chrome.tabs.group.mock.calls.length).toBe(groupCalls)
    expect(env.chrome.windows.remove).not.toHaveBeenCalled()
    expect(env.tabs.get(22)!.windowId).toBe(3)
    expect((await listTabs(env)).find((t) => t.tabId === 22)).toMatchObject({ popup: true, grouped: false })
  })

  it('主组那扇窗被用户关了：下一次要标签时在当前窗里重建主组，仍只有一个组', async () => {
    const env = await load()
    await openStreamTab(env)
    env.windows.set(2, 'normal')
    await env.chrome.windows.remove(1) // 用户关窗：窗连同主组一起没了
    const tab = await openStreamTab(env)

    expect(env.tabs.get(tab)!.windowId).toBe(2)
    expect(env.groupTitles()).toEqual(['Stream'])
    expect((await listTabs(env)).find((t) => t.tabId === tab)).toMatchObject({ grouped: true })
  })

  it('开启者在 popup 里、主组已没了：新标签所在的普通窗里重建主组，不挪', async () => {
    const env = await load()
    const opener = await openStreamTab(env)
    env.windows.set(3, 'popup')
    const popupTab: Tab = { id: 22, windowId: 3, groupId: -1, url: '', title: 'p', openerTabId: opener }
    env.tabs.set(22, popupTab)
    await env.onTabCreated(popupTab as unknown as chrome.tabs.Tab)
    env.windows.set(2, 'normal')
    await env.chrome.windows.remove(1)
    const child: Tab = { id: 23, windowId: 2, groupId: -1, url: '', title: 'c', openerTabId: 22 }
    env.tabs.set(23, child)
    await env.onTabCreated(child as unknown as chrome.tabs.Tab)

    expect(env.tabs.get(23)).toMatchObject({ windowId: 2 })
    expect(env.tabs.get(23)!.groupId).not.toBe(-1)
    expect(env.chrome.windows.remove).not.toHaveBeenCalledWith(2)
    expect(env.groupTitles()).toEqual(['Stream'])
  })
})

describe('升级收编：旧版的「Stream 独立窗」组', () => {
  it('47 个旧组 → 只剩一个 Stream 组；probe 关、created 挪进主组、adopted 只解组且仍开着；空窗关掉', async () => {
    const legacy: number[] = []
    const env = await load((m) => {
      const main = m.seedGroup('Stream', 1, [10])
      // 47 扇窗、每扇一组：100 号起每组一张 created；第一组多一张 probe，最后一组多一张用户拖入的
      for (let i = 0; i < 47; i++) legacy.push(m.seedGroup('Stream 独立窗', 100 + i, [100 + i]))
      m.tabs.set(200, { id: 200, windowId: 100, groupId: legacy[0], url: '', title: 'probe' })
      m.tabs.set(300, { id: 300, windowId: 146, groupId: legacy[46], url: '', title: 'user' })
      // 账本只认得前 40 组（后 7 组是账本作废前留下的，只能按名字认出来）
      const members: [number, string][] = [[10, 'created'], [200, 'probe'], [300, 'adopted']]
      for (let i = 0; i < 40; i++) members.push([100 + i, 'created'])
      m.local.tabGroup = { groupId: main, windowGroups: legacy.slice(0, 40), members }
    })
    await env.reconcileOnWake()

    expect(env.groupTitles()).toEqual(['Stream'])
    // 红线：用户拖进来的那张仍开着、不在任何组里
    expect(env.tabs.get(300)).toMatchObject({ groupId: -1, windowId: 146 })
    expect(env.chrome.tabs.remove).not.toHaveBeenCalledWith(300)
    expect(env.windows.has(146)).toBe(true)
    // probe 关掉
    expect(env.tabs.has(200)).toBe(false)
    // 账本认得的 created 挪进主组那扇窗、进主组
    const main = env.tabs.get(10)!.groupId
    for (let i = 0; i < 40; i++) expect(env.tabs.get(100 + i)).toMatchObject({ windowId: 1, groupId: main })
    // 认不出出身的（账本作废后的）一律当 adopted：只解组，不关
    for (let i = 40; i < 46; i++) {
      expect(env.tabs.get(100 + i)).toMatchObject({ groupId: -1 })
      expect(env.chrome.tabs.remove).not.toHaveBeenCalledWith(100 + i)
    }
    // 因收编空出来的窗关掉
    for (let i = 0; i < 40; i++) expect(env.windows.has(100 + i)).toBe(false)
    // 旧字段不再写回
    expect((env.local.tabGroup as Record<string, unknown>).windowGroups).toBeUndefined()
    expect(await env.tabOrigin(300)).toBeUndefined()
    expect(await env.tabOrigin(100)).toBe('created')
  })

  it('同名的多个主组合并进第一个，空出来的窗关掉', async () => {
    const env = await load((m) => {
      m.seedGroup('Stream', 1, [10, 11])
      m.seedGroup('Stream', 2, [20])
      m.seedGroup('Stream', 3, [30])
      m.windows.set(4, 'normal')
      m.tabs.set(40, { id: 40, windowId: 3, groupId: -1, url: 'https://mine.test/', title: 'mine' })
    })
    await env.reconcileOnWake()

    expect(env.groupTitles()).toEqual(['Stream'])
    const main = env.tabs.get(10)!.groupId
    for (const id of [11, 20, 30]) expect(env.tabs.get(id)).toMatchObject({ groupId: main, windowId: 1 })
    expect(env.windows.has(2)).toBe(false)
    expect(env.windows.has(3)).toBe(true) // 还有用户自己的标签
    expect(env.chrome.tabs.remove).not.toHaveBeenCalled()
    expect((await env.groupMembers()).map((m) => m.tabId).sort()).toEqual([10, 11, 20, 30])
  })

  it('账本里的主组不是第一个同名组：以账本的为准', async () => {
    const env = await load((m) => {
      m.seedGroup('Stream', 2, [20])
      const main = m.seedGroup('Stream', 1, [10])
      m.local.tabGroup = { groupId: main, members: [[10, 'created']] }
    })
    await env.reconcileOnWake()
    expect(env.groupTitles()).toEqual(['Stream'])
    expect(env.tabs.get(20)).toMatchObject({ windowId: 1, groupId: env.tabs.get(10)!.groupId })
  })
})
