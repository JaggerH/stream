import { describe, it, expect, vi } from 'vitest'

// 一个扩展同时服务两个 Stream（design D7）：本机那条（local）和一条配对绑定（ext:a）。
// 钉住的是隔离：组、账本、tab 归属、cookie 范围各归各的；实例 A 碰不到实例 B 的 tab。
function makeChrome(opts: { bindings?: unknown[]; config?: Record<string, unknown> } = {}) {
  const session: Record<string, unknown> = {}
  const local: Record<string, unknown> = {
    config: opts.config ?? { baseUrl: '', domains: [], autoSync: true },
    bindings: opts.bindings ?? [],
  }
  let nextGroup = 700
  /** tabId → 它此刻在 Chrome 里的 groupId（浏览器那一侧的真相，inGroup 要拿它核账本）。 */
  const tabGroupOf = new Map<number, number>()
  const onUpdated: Array<(tabId: number, info: { groupId?: number }) => unknown> = []
  const cookies = [
    { name: 'sid', value: 'em-secret', domain: '.eastmoneysec.com' },
    { name: 'gm', value: 'mail-secret', domain: '.mail.google.com' },
  ]
  return {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: session[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(session, obj) }),
      },
      local: {
        get: vi.fn(async (key: string | string[]) =>
          Array.isArray(key) ? Object.fromEntries(key.map((k) => [k, local[k]])) : { [key]: local[key] }),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(local, obj) }),
        remove: vi.fn(async (key: string) => { delete local[key] }),
      },
    },
    tabs: {
      group: vi.fn(async (o: { groupId?: number; tabIds: number[] }) => {
        const gid = o.groupId ?? nextGroup++
        for (const t of o.tabIds) tabGroupOf.set(t, gid)
        return gid
      }),
      get: vi.fn(async (tabId: number) => ({ id: tabId, groupId: tabGroupOf.get(tabId) ?? -1, windowId: 1, url: 'https://x.example/' })),
      create: vi.fn(),
      remove: vi.fn(async () => {}),
      ungroup: vi.fn(async () => {}),
      query: vi.fn(async () => []),
      onUpdated: { addListener: vi.fn((fn: (typeof onUpdated)[number]) => { onUpdated.push(fn) }) },
      onCreated: { addListener: vi.fn() },
    },
    tabGroups: { onUpdated: { addListener: vi.fn() }, query: vi.fn(async () => []), update: vi.fn(async () => {}) },
    windows: { create: vi.fn(), getAll: vi.fn(async () => [{ id: 1 }]), get: vi.fn(async () => ({ type: 'normal' })) },
    cookies: {
      getAll: vi.fn(async ({ domain }: { domain: string }) => cookies.filter((c) => c.domain === `.${domain}`)),
    },
    debugger: {
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({})),
    },
    _local: local,
    _tabGroupOf: tabGroupOf,
    _drag: (tabId: number, gid: number) => {
      tabGroupOf.set(tabId, gid)
      return Promise.all(onUpdated.map((fn) => fn(tabId, { groupId: gid })))
    },
  }
}

type FakeChrome = ReturnType<typeof makeChrome>

async function load(chrome: FakeChrome) {
  vi.stubGlobal('chrome', chrome)
  vi.resetModules()
  return import('./driver.ts')
}

const PAIRED = {
  id: 'ext:a', kind: 'paired', baseUrl: 'https://main.example', token: 't', label: 'NAS',
  domains: [], requiredDomains: ['eastmoneysec.com', 'mail.google.com'], approvedDomains: ['eastmoneysec.com'], autoSync: true,
}

describe('driver — 按扩展绑定', () => {
  it('两条绑定各一个组、各一本账，本机的存储键不变', async () => {
    const chrome = makeChrome({ bindings: [PAIRED] })
    const mod = await load(chrome)
    const a = mod.runtime('ext:a', 'NAS')
    const gLocal = await mod.addTabToGroup(5, 'created')
    const gA = await mod.addTabToGroup(6, 'created', a)
    expect(gLocal).not.toBe(gA)
    expect(chrome._local.tabGroup).toMatchObject({ groupId: gLocal, members: [[5, 'created']] })
    expect(chrome._local['tabGroup:ext:a']).toMatchObject({ groupId: gA, members: [[6, 'created']] })
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(gA, { title: 'Stream · NAS', color: 'blue' })
  })

  it('refuses a tab owned by another binding', async () => {
    const chrome = makeChrome({ bindings: [PAIRED] })
    const mod = await load(chrome)
    const a = mod.runtime('ext:a', 'NAS')
    await mod.addTabToGroup(5, 'created') // 本机组里的
    chrome.debugger.attach.mockClear()
    const reply = await mod.dispatch({ id: 1, tabId: 5, method: 'Runtime.evaluate', params: { expression: '1' } }, a)
    expect(reply.error).toMatch(/not in the session tab group/)
    expect(chrome.debugger.attach).not.toHaveBeenCalled()
    // 本机那条照常能驱动它
    const ok = await mod.dispatch({ id: 2, tabId: 5, method: 'Runtime.evaluate', params: { expression: '1' } })
    expect(ok.error).toBeUndefined()
  })

  it('closeTab / list 也只认自己的组', async () => {
    const chrome = makeChrome({ bindings: [PAIRED] })
    const mod = await load(chrome)
    const a = mod.runtime('ext:a', 'NAS')
    await mod.addTabToGroup(5, 'created')
    await mod.addTabToGroup(6, 'created', a)
    expect((await mod.dispatch({ id: 1, op: 'closeTab', tabId: 5 }, a)).error).toMatch(/not in the session tab group/)
    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(5)
    const listed = (await mod.dispatch({ id: 2, op: 'list' }, a)).result as { tabs: Array<{ tabId: number }> }
    expect(listed.tabs.map((t) => t.tabId)).toEqual([6])
  })

  it('用户把一张 tab 拖进 ext:a 的组 → 归 ext:a；再拖进本机组 → 从 ext:a 撤销、归本机', async () => {
    const chrome = makeChrome({ bindings: [PAIRED] })
    const mod = await load(chrome)
    const a = mod.runtime('ext:a', 'NAS')
    const gLocal = await mod.addTabToGroup(5, 'created')
    const gA = await mod.addTabToGroup(6, 'created', a)
    await chrome._drag(9, gA)
    expect(await mod.tabOrigin(9, a)).toBe('adopted')
    expect(await mod.tabOrigin(9)).toBeUndefined()
    await chrome._drag(9, gLocal)
    expect(await mod.tabOrigin(9)).toBe('adopted')
    expect(await mod.tabOrigin(9, a)).toBeUndefined()
  })

  it('ext:a 组里的 tab 开出的新标签归 ext:a，且不进本机的 owned 集合', async () => {
    const chrome = makeChrome({ bindings: [PAIRED] })
    const mod = await load(chrome)
    const a = mod.runtime('ext:a', 'NAS')
    const gA = await mod.addTabToGroup(6, 'probe', a)
    chrome._tabGroupOf.set(11, gA) // Chrome 自己把它放进了开启者的组
    await mod.onTabCreated({ id: 11, openerTabId: 6, windowId: 1, groupId: gA } as chrome.tabs.Tab)
    expect(await mod.tabOrigin(11, a)).toBe('probe')
    expect(await mod.tabOrigin(11)).toBeUndefined()
  })

  it('cookiePull：配对绑定只给批准过的域，其余明说 refused', async () => {
    const chrome = makeChrome({ bindings: [PAIRED] })
    const mod = await load(chrome)
    const a = mod.runtime('ext:a', 'NAS')
    const reply = await mod.dispatch({ id: 1, op: 'cookiePull', domains: ['eastmoneysec.com', 'mail.google.com'] }, a)
    const out = reply.result as { cookies: Record<string, unknown[]>; refused: string[] }
    expect(Object.keys(out.cookies)).toEqual(['eastmoneysec.com'])
    expect(out.refused).toEqual(['mail.google.com'])
    expect(JSON.stringify(reply)).not.toContain('mail-secret')
  })

  it('cookieNames：配对绑定范围外的域答空，不探测', async () => {
    const chrome = makeChrome({ bindings: [PAIRED] })
    const mod = await load(chrome)
    const a = mod.runtime('ext:a', 'NAS')
    const reply = await mod.dispatch({ id: 1, op: 'cookieNames', domain: 'mail.google.com' }, a)
    expect(reply.result).toEqual({ names: [] })
    expect(chrome.cookies.getAll).not.toHaveBeenCalled()
  })

  it('两条绑定的退避互不影响', async () => {
    const chrome = makeChrome({ bindings: [PAIRED] })
    const mod = await load(chrome)
    const a = mod.runtime('ext:a', 'NAS')
    a.backoff = 16_000
    expect(mod.runtime().backoff).toBe(1000)
  })
})
