import { describe, it, expect, vi, afterEach } from 'vitest'

// ── 后端重启留下的孤儿采集标签：照后端认领名单回收 ──
//
// lane→tab 只在后端进程内存里。后端一重启，用户 Chrome 里还开着的采集标签就没人认了：
// 新进程不知道它、`closeFacilityTabs` 够不着、SW 也不一定死过（对账原来只在 SW 启动时跑）。
// 开发期后端重启频繁，一次漏一个。
//
// 红线（三条，测试逐条钉住）：
//   1. 问不到后端（网络错 / 非 200）→ **什么都不做**。宁可漏关，不可误关。
//   2. `adopted`（用户亲手拖进来的）→ 永不 remove，跟后端认不认无关。授权是用户给的。
//   3. `created`（给人看的交互标签）→ 不动。用户可能正看着；它就在可见的标签组里。
// 只回收 `probe`：后台采集标签，没人看，泄漏无人察觉。

function makeChrome() {
  const session: Record<string, unknown> = {}
  const local: Record<string, unknown> = {} // 出身账本
  const live = new Set<number>()
  return {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: session[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(session, obj) }),
      },
      local: {
        get: vi.fn(async (key: string) => ({ [key]: local[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(local, obj) }),
        remove: vi.fn(async (key: string) => { delete local[key] }),
      },
    },
    tabs: {
      group: vi.fn(async (opts: { groupId?: number; tabIds: number[] }) => {
        opts.tabIds.forEach((t) => live.add(t))
        return opts.groupId ?? 777
      }),
      ungroup: vi.fn(async (tabId: number) => { live.delete(tabId) }),
      get: vi.fn(async (tabId: number) => ({
        id: tabId, url: 'https://a.example/x', title: 'T', groupId: live.has(tabId) ? 777 : -1,
      })),
      create: vi.fn(async () => ({ id: 5 })),
      remove: vi.fn(async (tabId: number) => { live.delete(tabId) }),
      query: vi.fn(async (q: { groupId?: number }) => (q.groupId === 777 ? [...live].map((id) => ({ id })) : [])),
      onUpdated: { addListener: vi.fn() },
    },
    tabGroups: { onUpdated: { addListener: vi.fn() } },
    windows: { create: vi.fn(async () => ({ id: 1, tabs: [{ id: 5 }] })), getAll: vi.fn(async () => [{ id: 1 }]) },
    system: { display: { getInfo: vi.fn(async () => [{ id: 'd1', isPrimary: true, workArea: { left: 0, top: 0, width: 2560, height: 1400 } }]) } },
    debugger: {
      onEvent: { addListener: vi.fn() },
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({})),
    },
  }
}

type FakeChrome = ReturnType<typeof makeChrome>

async function loadModule(chrome: FakeChrome) {
  vi.stubGlobal('chrome', chrome)
  vi.resetModules()
  return import('./driver.ts')
}

/** 后端答什么由每个用例给；返回 fetch 的调用次数供断言"问都没问就动手"这类错误。 */
function stubFetch(reply: { ok: boolean; body?: unknown } | Error) {
  const fn = vi.fn(async () => {
    if (reply instanceof Error) throw reply
    return { ok: reply.ok, json: async () => reply.body } as unknown as Response
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => { vi.unstubAllGlobals() })

/** 建一个组、放进若干成员，返回模块。 */
async function withGroup(chrome: FakeChrome, members: Array<[number, 'probe' | 'created' | 'adopted']>) {
  const mod = await loadModule(chrome)
  for (const [tabId, origin] of members) await mod.addTabToGroup(tabId, origin)
  return mod
}

describe('reclaimOrphanTabs —— 照后端认领名单收孤儿', () => {
  it('后端不认的 probe 标签 → 回收', async () => {
    const chrome = makeChrome()
    const mod = await withGroup(chrome, [[5, 'probe'], [6, 'probe']])
    stubFetch({ ok: true, body: { tabIds: [6] } }) // 后端只认 6
    await mod.reclaimOrphanTabs('http://127.0.0.1:8900', { minAgeMs: 0 })
    expect(chrome.tabs.remove).toHaveBeenCalledWith(5)
    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(6)
  })

  it('后端一个都不认（刚重启）→ probe 全收', async () => {
    const chrome = makeChrome()
    const mod = await withGroup(chrome, [[5, 'probe'], [6, 'probe']])
    stubFetch({ ok: true, body: { tabIds: [] } })
    await mod.reclaimOrphanTabs('http://127.0.0.1:8900', { minAgeMs: 0 })
    expect(chrome.tabs.remove.mock.calls.map((c) => c[0]).sort()).toEqual([5, 6])
  })

  it('【红线】问不到后端（网络错）→ 一个都不动', async () => {
    const chrome = makeChrome()
    const mod = await withGroup(chrome, [[5, 'probe']])
    stubFetch(new Error('ECONNREFUSED'))
    await mod.reclaimOrphanTabs('http://127.0.0.1:8900', { minAgeMs: 0 })
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
  })

  it('【红线】后端答非 200（如 503 没接会话层）→ 一个都不动，别当成空集合', async () => {
    const chrome = makeChrome()
    const mod = await withGroup(chrome, [[5, 'probe']])
    stubFetch({ ok: false })
    await mod.reclaimOrphanTabs('http://127.0.0.1:8900', { minAgeMs: 0 })
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
  })

  it('【红线】adopted（用户拖入）后端不认也绝不 remove', async () => {
    const chrome = makeChrome()
    const mod = await withGroup(chrome, [[9, 'adopted']])
    stubFetch({ ok: true, body: { tabIds: [] } })
    await mod.reclaimOrphanTabs('http://127.0.0.1:8900', { minAgeMs: 0 })
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
  })

  it('【红线】created（给人看的交互标签）不动——用户可能正看着', async () => {
    const chrome = makeChrome()
    const mod = await withGroup(chrome, [[7, 'created']])
    stubFetch({ ok: true, body: { tabIds: [] } })
    await mod.reclaimOrphanTabs('http://127.0.0.1:8900', { minAgeMs: 0 })
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
  })

  it('刚建出来的标签有宽限期——后端还没来得及登记进 lane，别误杀', async () => {
    // 竞态：采集刚 newTab 完、后端那边 lane 还没登记好，此时对账会看到"后端不认"。
    // 建标签的就是这个 SW，所以它自己知道谁是刚生的——用内存里的建档时刻挡住这一类。
    const chrome = makeChrome()
    const mod = await withGroup(chrome, [[5, 'probe']])
    stubFetch({ ok: true, body: { tabIds: [] } })
    await mod.reclaimOrphanTabs('http://127.0.0.1:8900', { minAgeMs: 60_000 })
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
  })
})
