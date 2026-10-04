import { describe, it, expect, vi } from 'vitest'

// 前台采集会把用户的 active 标签抢走。抢完得还回去——但**只在他没有自己走开的时候**：
// 用户在采集期间主动切到别处，说明他不想看这个采集标签，此时"还回去"就成了第二次打扰。
//
// 闸门判据是「当前 active 标签在不在会话组里」，不是后端传来的某个 tabId：后端在**抢焦点
// 之前**就记下了用户原来在哪，那时候采集标签可能还没建出来（建标签本身就是抢焦点的动作），
// 它的 id 无从谈起。所以"焦点还在采集手里吗"只能由扩展在还的那一刻自己看。
function makeChrome(state: { active: number; tabs: number[]; members: number[] }) {
  const updates: Array<{ tabId: number; active: boolean }> = []
  return {
    chrome: {
      storage: {
        session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
        // 出身账本存 storage.local（见 driver.ts 的 ensureLedgerFresh）
        local: {
          get: vi.fn(async () => ({
            tabGroup: { groupId: 1, members: state.members.map((t) => [t, 'created']) },
          })),
          set: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
        },
        onChanged: { addListener: vi.fn() },
      },
      tabs: {
        query: vi.fn(async () => (state.active ? [{ id: state.active }] : [])),
        update: vi.fn(async (tabId: number, props: { active: boolean }) => {
          if (!state.tabs.includes(tabId)) throw new Error(`No tab with id: ${tabId}`)
          updates.push({ tabId, active: props.active })
          state.active = tabId
          return { id: tabId }
        }),
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      tabGroups: { onRemoved: { addListener: vi.fn() } },
      cookies: { getAll: vi.fn(async () => []) },
      debugger: { onEvent: { addListener: vi.fn() }, onDetach: { addListener: vi.fn() } },
      runtime: { onMessage: { addListener: vi.fn() }, lastError: undefined },
    },
    updates,
  }
}

async function load(state: { active: number; tabs: number[]; members?: number[] }) {
  const m = makeChrome({ members: [], ...state })
  vi.stubGlobal('chrome', m.chrome)
  vi.resetModules()
  return { dispatch: (await import('./driver.ts')).dispatch, ...m }
}

describe('dispatch op:activeTab', () => {
  it('reports which tab the user was looking at', async () => {
    const { dispatch } = await load({ active: 7, tabs: [7, 9] })
    const res = await dispatch({ id: 1, op: 'activeTab' })
    expect((res.result as { tabId: number | null }).tabId).toBe(7)
  })

  it('reports null rather than failing when there is no active tab', async () => {
    // 一个窗口都没有是唤起 Chrome 的常态（host-agent 用 --no-startup-window 拉起）。
    const { dispatch } = await load({ active: 0, tabs: [] })
    const res = await dispatch({ id: 2, op: 'activeTab' })
    expect(res.error).toBeUndefined()
    expect((res.result as { tabId: number | null }).tabId).toBeNull()
  })
})

describe('dispatch op:activateTab', () => {
  it('switches back when the采集标签 (a session-group member) still holds the focus', async () => {
    const s = { active: 42, tabs: [7, 42], members: [42] }
    const { dispatch, updates } = await load(s)
    await dispatch({ id: 3, op: 'activateTab', tabId: 7 })
    expect(updates).toEqual([{ tabId: 7, active: true }])
  })

  it('does NOTHING when the user already walked away', async () => {
    // 采集期间用户自己切到了 99——一个组外的标签。他已经不在看采集了，再把他拽回 7 是第二次打扰。
    const s = { active: 99, tabs: [7, 42, 99], members: [42] }
    const { dispatch, updates } = await load(s)
    const res = await dispatch({ id: 4, op: 'activateTab', tabId: 7 })
    expect(updates).toEqual([])
    expect(res.error).toBeUndefined()          // 不是失败，是「本来就不该动」
    expect((res.result as { restored: boolean }).restored).toBe(false)
  })

  it('a tab the user closed meanwhile is not an error', async () => {
    // 还的目标可能在采集期间被关掉。还不回去无所谓——用户当下看的东西比这重要。
    const s = { active: 42, tabs: [42], members: [42] }
    const { dispatch } = await load(s)
    const res = await dispatch({ id: 5, op: 'activateTab', tabId: 7 })
    expect(res.error).toBeUndefined()
    expect((res.result as { restored: boolean }).restored).toBe(false)
  })

  it('no active tab at all: nothing to take the focus back from', async () => {
    const s = { active: 0, tabs: [7], members: [42] }
    const { dispatch, updates } = await load(s)
    const res = await dispatch({ id: 6, op: 'activateTab', tabId: 7 })
    expect(updates).toEqual([])
    expect((res.result as { restored: boolean }).restored).toBe(false)
  })
})
