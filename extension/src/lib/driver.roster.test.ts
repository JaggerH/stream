import { describe, it, expect, vi } from 'vitest'

// ── 浏览器重启 → Chrome 恢复出上次会话的自建标签 → 按自建名单认回出身 ──
//
// 用户现象：每次重启 Chrome 都会打开一张上次采集留下的标签（蓝色 Stream 组里），没人收。
// 根因：账本（tabGroup）在 onStartup 时被作废（tabId 跨会话不可信），恢复出来的标签被
// findExistingGroup 一律收编为 adopted——红线拦着绝不 remove，probe 就永远没人回收。
//
// 修法（不依赖 tabId——官方文档写死 "Tab IDs are unique within a browser session"，恢复出来
// 的标签拿的是新 id）：addTabToGroup 时把「自建 + URL」另记一份不随 onStartup 作废的名单；
// 重启后对恢复组内、被保守降级为 adopted 的成员按 URL 认回出身。红线不变：名单认不出的
// 照旧 adopted、绝不 remove。
//
// 红线：用户拖入的 tab 绝不因名单被 remove——名单只认领「此刻标为 adopted 且 URL 对得上」
// 的成员，组外标签一律不碰。

const PROBE_URL = 'https://www.xiaohongshu.com/explore'
const OTHER_URL = 'https://a.example/x'

/** 模拟「浏览器重启」后的世界：storage.local 里留着上一次会话的名单；浏览器里恢复出来的
 *  Stream 组（groupId 会变、tabId 全是新 id）；账本已被 onStartup 清掉（local.tabGroup 缺席）。 */
function makeChromeAfterRestart(opts: {
  roster?: Array<{ url: string; origin: 'probe' | 'created'; tabId?: number }>
  /** 恢复出来的组里的标签（新 tabId、真实 URL） */
  restoredTabs?: Array<{ id: number; url: string }>
  /** 组外的用户标签（新 tabId、真实 URL） */
  outsideTabs?: Array<{ id: number; url: string }>
  newGroupId?: number
} = {}) {
  const local: Record<string, unknown> = {}
  const session: Record<string, unknown> = {}
  const gid = opts.newGroupId ?? 888 // 重启后组 id 也换了
  // 名单按上一会话写入的形状存（键 ROSTER_KEY，绑定 id 为 local 的那层）
  local.tabRoster = { local: (opts.roster ?? []).map((r) => ({ tabId: r.tabId ?? 5, url: r.url, origin: r.origin })) }
  // 账本已被 onStartup 作废：local.tabGroup 不存在
  const allTabs = [...(opts.restoredTabs ?? []), ...(opts.outsideTabs ?? [])]
  const live = new Set((opts.restoredTabs ?? []).map((t) => t.id))
  const removed: number[] = []
  const ungrouped: number[] = []
  return {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: local[key] }),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(local, obj)
        },
        remove: async (key: string) => {
          delete local[key]
        },
      },
      session: {
        get: async (key: string) => ({ [key]: session[key] }),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(session, obj)
        },
      },
    },
    runtime: { onStartup: { addListener: vi.fn() } },
    tabs: {
      group: async (o: { groupId?: number; tabIds: number[] }) => {
        o.tabIds.forEach((t) => live.add(t))
        return o.groupId ?? gid
      },
      ungroup: async (tabId: number) => {
        live.delete(tabId)
        ungrouped.push(tabId)
      },
      get: async (tabId: number) => {
        const t = allTabs.find((x) => x.id === tabId)
        if (!t) throw new Error(`No tab with id: ${tabId}`)
        return { id: tabId, url: t.url, title: 'T', groupId: live.has(tabId) ? gid : -1 }
      },
      query: async (q: { groupId?: number }) =>
        q.groupId === gid ? (opts.restoredTabs ?? []).map((t) => ({ id: t.id })) : [],
      create: async () => ({ id: 5 }),
      remove: async (tabId: number) => {
        removed.push(tabId)
        live.delete(tabId)
      },
      onUpdated: { addListener: vi.fn() },
    },
    tabGroups: {
      query: async (q: { title?: string }) => (q.title === 'Stream' ? [{ id: gid, title: 'Stream' }] : []),
      update: async () => {},
      onUpdated: { addListener: vi.fn() },
    },
    windows: { create: vi.fn(), getAll: async () => [{ id: 1 }] },
    debugger: {
      onEvent: { addListener: vi.fn() },
      attach: async () => {},
      detach: async () => {},
      sendCommand: async () => ({}),
    },
    _removed: removed,
    _ungrouped: ungrouped,
    _local: local,
  }
}

type FakeChrome = ReturnType<typeof makeChromeAfterRestart>

async function loadModule(chrome: FakeChrome) {
  vi.stubGlobal('chrome', chrome)
  vi.resetModules()
  return import('./driver.ts')
}

describe('浏览器重启后按自建名单收回恢复出来的自建标签', () => {
  it('【核心】恢复出来的 probe（新 tabId、同 URL、在恢复组内）被关掉', async () => {
    // 上次会话 tabId 5 的探针，重启后变成 tabId 41 —— URL 相同即认领
    const chrome = makeChromeAfterRestart({
      roster: [{ url: PROBE_URL, origin: 'probe', tabId: 5 }],
      restoredTabs: [{ id: 41, url: PROBE_URL }],
    })
    const mod = await loadModule(chrome)

    await mod.reconcileOnWake()

    expect(chrome._removed).toContain(41)
    expect(await mod.tabOrigin(41)).toBeUndefined() // 已回收，出账本
  })

  it('恢复出来的 created 留在主组并记回 created（不 remove）', async () => {
    const chrome = makeChromeAfterRestart({
      roster: [{ url: OTHER_URL, origin: 'created', tabId: 6 }],
      restoredTabs: [{ id: 42, url: OTHER_URL }],
    })
    const mod = await loadModule(chrome)

    await mod.reconcileOnWake()

    expect(chrome._removed).not.toContain(42)
    expect(await mod.tabOrigin(42)).toBe('created')
  })

  it('名单里没有的恢复标签照旧 adopted，绝不 remove（红线）', async () => {
    const chrome = makeChromeAfterRestart({
      roster: [],
      restoredTabs: [{ id: 43, url: PROBE_URL }],
    })
    const mod = await loadModule(chrome)

    await mod.reconcileOnWake()

    expect(chrome._removed).not.toContain(43)
    expect(await mod.tabOrigin(43)).toBe('adopted')
  })

  it('名单里的 URL 出现在组外的用户标签上：不关（只在恢复组内认领）', async () => {
    const chrome = makeChromeAfterRestart({
      roster: [{ url: PROBE_URL, origin: 'probe' }],
      restoredTabs: [{ id: 44, url: OTHER_URL }],
      outsideTabs: [{ id: 50, url: PROBE_URL }], // 用户自己开的同 URL 标签，不在组里
    })
    const mod = await loadModule(chrome)

    await mod.reconcileOnWake()

    expect(chrome._removed).not.toContain(50)
  })

  it('同 URL 两张恢复标签而名单只有一条 → 只认领一张，另一张照旧 adopted', async () => {
    const chrome = makeChromeAfterRestart({
      roster: [{ url: PROBE_URL, origin: 'probe' }],
      restoredTabs: [
        { id: 45, url: PROBE_URL },
        { id: 46, url: PROBE_URL },
      ],
    })
    const mod = await loadModule(chrome)

    await mod.reconcileOnWake()

    // 恰好一张被收（名单一条只够认领一张），另一张绝不 remove
    expect(chrome._removed.filter((id) => id === 45 || id === 46)).toHaveLength(1)
    const survivors = [45, 46].filter((id) => !chrome._removed.includes(id))
    expect(survivors).toHaveLength(1)
    expect(await mod.tabOrigin(survivors[0]!)).toBe('adopted')
  })

  it('名单在认领后被清掉（不跨启动累积；认领不到也清）', async () => {
    const chrome = makeChromeAfterRestart({
      roster: [{ url: OTHER_URL, origin: 'probe' }], // 组内没有这个 URL
      restoredTabs: [{ id: 47, url: PROBE_URL }],
    })
    const mod = await loadModule(chrome)

    await mod.reconcileOnWake()

    expect(chrome._removed).not.toContain(47)
    expect(((chrome._local.tabRoster as { local?: unknown[] }).local) ?? []).toEqual([])
  })

  it('【红线】名单 URL 与用户拖入的组内标签相同且它已不是 adopted 时不误关：认领只作用于此刻标 adopted 的成员', async () => {
    // 用户把同 URL 的标签拖进组、又已在账本里有真实出身（非 adopted）→ 名单不碰它。
    // 这里直接构造：恢复组里 tab 48 已被账本记为 created（对账第②步之前已在册）。
    const chrome = makeChromeAfterRestart({
      roster: [{ url: PROBE_URL, origin: 'probe' }],
      restoredTabs: [{ id: 48, url: PROBE_URL }],
    })
    const mod = await loadModule(chrome)
    // 预置账本成员（模拟对账前已在册且出身不是 adopted）
    await mod.addTabToGroup(48, 'created')
    // 恢复 nameGroup 之前的场景没意义——这里账本活着，不会走认领分支；
    // 改为直接断言：名单里 tabId 48 的记录不会让一张 created 的标签被 remove
    expect(await mod.tabOrigin(48)).toBe('created')

    await mod.reconcileOnWake()

    expect(chrome._removed).not.toContain(48)
  })
})
