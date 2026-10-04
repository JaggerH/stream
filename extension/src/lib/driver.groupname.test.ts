import { describe, it, expect, vi } from 'vitest'

// ── 会话标签组要有名字 ──
// 没名字的组在标签栏上是一块灰色无字的东西，用户认不出那是"AI 正在操作的范围"。
// 而整套归属模型的前提就是这个组**对用户可见可辨**——拖进去=授权、拖出来=撤销，
// 认不出它就等于边界没长在用户眼里。命名不是装饰，是这个设计的一部分。
function makeChrome() {
  const session: Record<string, unknown> = {}
  const live = new Set<number>()
  return {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: session[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(session, obj)
        }),
      },
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    },
    tabs: {
      group: vi.fn(async (o: { groupId?: number; tabIds: number[] }) => {
        o.tabIds.forEach((t) => live.add(t))
        return o.groupId ?? 777
      }),
      ungroup: vi.fn(async () => {}),
      get: vi.fn(async (tabId: number) => ({ id: tabId, url: 'https://a.example/x', title: 'T', groupId: 777 })),
      create: vi.fn(async () => ({ id: 5 })),
      remove: vi.fn(async () => {}),
      query: vi.fn(async () => []),
      onUpdated: { addListener: vi.fn() },
    },
    tabGroups: { onUpdated: { addListener: vi.fn() }, update: vi.fn(async () => ({})) },
    windows: { create: vi.fn(), getAll: vi.fn(async () => [{ id: 1 }]) },
    debugger: {
      onEvent: { addListener: vi.fn() },
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({ result: { value: '{}' } })),
    },
    _session: session,
  }
}

type FakeChrome = ReturnType<typeof makeChrome>

async function loadModule(chrome: FakeChrome) {
  vi.stubGlobal('chrome', chrome)
  vi.resetModules()
  return import('./driver.ts')
}

describe('会话标签组命名', () => {
  it('建组时给它起名 Stream，让用户在标签栏上认得出这是 AI 的操作范围', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)

    await mod.addTabToGroup(5, 'created')

    expect(chrome.tabGroups.update).toHaveBeenCalledWith(777, expect.objectContaining({ title: 'Stream' }))
  })

  it('往已有组里追加 tab 时不再改名 —— 用户改过的名字不该被覆写回去', async () => {
    const chrome = makeChrome()
    const mod = await loadModule(chrome)
    await mod.addTabToGroup(5, 'created') // 建组，命名一次
    ;(chrome.tabGroups.update as ReturnType<typeof vi.fn>).mockClear()

    await mod.addTabToGroup(6, 'created') // 追加进同一组

    expect(chrome.tabGroups.update).not.toHaveBeenCalled()
  })

  it('命名 API 抛异常时不拖垮建组 —— 组能用比有名字重要', async () => {
    const chrome = makeChrome()
    chrome.tabGroups.update = vi.fn(async () => {
      throw new Error('no tabGroups permission')
    }) as unknown as FakeChrome['tabGroups']['update']
    const mod = await loadModule(chrome)

    await expect(mod.addTabToGroup(5, 'created')).resolves.toBe(777)
    expect(await mod.tabOrigin(5)).toBe('created') // 成员表照记不误
  })

  it('命名 API 压根不存在（没 tabGroups 权限的真实形态）时也不拖垮建组', async () => {
    // 没权限时 chrome.tabGroups 或它的 update 是**不存在**，不是抛 rejection——
    // 那是一个同步 TypeError，`.catch()` 接不住。这条测的就是那个形态：
    // 上一条（mock 成抛异常）走的是另一条路，漏掉了它。
    const chrome = makeChrome()
    ;(chrome as { tabGroups?: unknown }).tabGroups = { onUpdated: { addListener: vi.fn() } } // 有对象、没 update
    const mod = await loadModule(chrome as FakeChrome)

    await expect(mod.addTabToGroup(5, 'created')).resolves.toBe(777)
    expect(await mod.tabOrigin(5)).toBe('created')
  })

  it('陈旧组重建后，新组同样有名字', async () => {
    // 用户手动解散组 → 带陈旧 id 的 group() 抛 → 重建新组。这条路也得命名，
    // 否则"解散一次组"就永久退化成一个无名灰块。
    const chrome = makeChrome()
    chrome._session.tabGroup = { groupId: 99, members: [] } // 预置陈旧组
    let first = true
    chrome.tabs.group = vi.fn(async (o: { groupId?: number; tabIds: number[] }) => {
      if (first && o.groupId != null) {
        first = false
        throw new Error('No group with id 99')
      }
      return 888
    }) as unknown as FakeChrome['tabs']['group']
    const mod = await loadModule(chrome)

    await mod.addTabToGroup(5, 'created')

    expect(chrome.tabGroups.update).toHaveBeenCalledWith(888, expect.objectContaining({ title: 'Stream' }))
  })
})
