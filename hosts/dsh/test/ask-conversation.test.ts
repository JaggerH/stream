// 「转成文字 → 开一条对话发出去」这三步。钉的是**顺序和参数**：先拿到会话、切过去、再发。
// 顺序错了的症状是"消息发进了上一条会话"——用户看到的是新会话空着，而旧会话里凭空多一句。
//
// 夹具照 DSH 0.2.0 的形状：名册（`ctx.workspaces.list`，只有 `items` / `phase`）和导航
// （`ctx.uiWorkspace` 的 `connectWorkspace` / `openSession`）是两个服务，「最近那个工作区」
// 由我们自己算（`src/client/workspace-pick.ts`），「当前那条会话」也从引用计数推
// （`src/client/current-session.ts`）。
//
// **0.2.0 的两处改名都在这份夹具里**：切会话从 `ctx.sessions.open` 挪到了
// `ctx.uiWorkspace.openSession`；会话名册快照里没有 `current` 了，改成 `ids` + `byId` 里
// 那格 `retainedBy.mainView`。
import { describe, expect, it, vi } from 'vitest'

import { askInNewConversation, askWhenWorkspaceReady } from '../src/client/ask-conversation.ts'

/** 一行工作区名册。`updatedAt` 是「最近」的判据，`sessionIds` 让「当前会话所在的那个」认得出来。 */
const WS = (id: string, updatedAt: string, sessionIds: string[] = []) =>
  ({ workspaceId: id, path: `/w/${id}`, title: id, sessionIds, createdAt: updatedAt, updatedAt })

/**
 * 一份 0.2.0 形状的会话名册快照。
 * @param current - "当前那条"的 id（`retainedBy.mainView > 0` 那条）；undefined = 一条都没有。
 */
function sessionList(current: string | undefined) {
  if (current === undefined) return { ids: [] as string[], byId: {} as Record<string, unknown> }
  return { ids: [current], byId: { [current]: { retainedBy: { mainView: 1 } } } }
}

function makeCtx(opts: {
  /** 显式给 `[]` 才是"没有工作区"——所以这一格要写全，别用 `?? 默认值` 兜。 */
  items?: ReturnType<typeof WS>[]
  ready?: boolean
  /** 当前会话的 id（= 名册里 `retainedBy.mainView > 0` 那条）。 */
  current?: string | undefined
  subscribe?: (fn: () => void) => () => void
} = {}) {
  const items = opts.items ?? [WS('w1', '2026-09-01T00:00:00Z')]
  const send = vi.fn().mockResolvedValue(undefined)
  const open = vi.fn()
  const connectWorkspace = vi.fn().mockResolvedValue('s1')
  const ctx = {
    conversation: { send },
    sessions: { list: { getSnapshot: () => sessionList(opts.current) } },
    uiWorkspace: { connectWorkspace, openSession: open },
    workspaces: {
      list: {
        getSnapshot: () => ({ items, phase: (opts.ready ?? true) ? 'ready' : 'pending' }),
        subscribe: opts.subscribe ?? ((): (() => void) => () => {}),
      },
    },
  }
  return { ctx, send, open, connectWorkspace }
}

describe('askInNewConversation', () => {
  it('拿会话 → 切过去 → 发这一句', async () => {
    const { ctx, send, open, connectWorkspace } = makeCtx()
    await askInNewConversation(ctx as never, '转成文字')
    expect(connectWorkspace).toHaveBeenCalledWith('w1')
    expect(open).toHaveBeenCalledWith('s1')
    expect(send).toHaveBeenCalledWith('转成文字')
    // 发消息必须发生在切过去**之后**：反了就发进上一条会话。
    expect(open.mock.invocationCallOrder[0]!).toBeLessThan(send.mock.invocationCallOrder[0]!)
  })

  it('当前会话所在的那个工作区优先于「最近改动」的那个', async () => {
    const { ctx, connectWorkspace } = makeCtx({
      items: [WS('w1', '2026-09-05T00:00:00Z'), WS('w2', '2026-09-01T00:00:00Z', ['sX'])],
      current: 'sX',
    })
    await askInNewConversation(ctx as never, '转成文字')
    expect(connectWorkspace).toHaveBeenCalledWith('w2')
  })

  it('没有当前会话时取 updatedAt 最新的那个（名册顺序是手动排序，不是时间序）', async () => {
    const { ctx, connectWorkspace } = makeCtx({
      items: [WS('w1', '2026-09-01T00:00:00Z'), WS('w2', '2026-09-05T00:00:00Z')],
    })
    await askInNewConversation(ctx as never, '转成文字')
    expect(connectWorkspace).toHaveBeenCalledWith('w2')
  })

  it('还没有工作区 → 抛人话（面板那侧会把它弹成 toast），不静默吞掉', async () => {
    const { ctx, send } = makeCtx({ items: [] })
    await expect(askInNewConversation(ctx as never, '转成文字')).rejects.toThrow(/工作区/)
    expect(send).not.toHaveBeenCalled()
  })

  it('对话服务还没就位 → 同样抛，不去建会话', async () => {
    const { ctx, connectWorkspace } = makeCtx()
    const bare = { ...ctx, conversation: undefined }
    await expect(askInNewConversation(bare as never, '转成文字')).rejects.toThrow(/还没就位/)
    expect(connectWorkspace).not.toHaveBeenCalled()
  })
})

describe('askWhenWorkspaceReady（深链那一档）', () => {
  it('名册还没就位时先不发，就位那一刻发一次——且只发一次', async () => {
    let notify: (() => void) | undefined
    let ready = false
    const send = vi.fn().mockResolvedValue(undefined)
    const ctx = {
      conversation: { send },
      sessions: { list: { getSnapshot: () => sessionList(undefined) } },
      uiWorkspace: { connectWorkspace: vi.fn().mockResolvedValue('s1'), openSession: vi.fn() },
      workspaces: {
        list: {
          getSnapshot: () => ({
            items: ready ? [WS('w1', '2026-09-01T00:00:00Z')] : [],
            phase: ready ? 'ready' : 'pending',
          }),
          subscribe: (fn: () => void) => { notify = fn; return () => { notify = undefined } },
        },
      },
    }
    askWhenWorkspaceReady(ctx as never, '转成文字')
    expect(send).not.toHaveBeenCalled()

    ready = true
    notify?.()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

    // 名册之后再抖动几次也不许再发一条——重复发消息是要花钱的，而且用户没做任何事。
    notify?.()
    notify?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('返回的撤销函数拦得住尚未发出的那一次（页面切走后不许凭空发消息）', () => {
    let notify: (() => void) | undefined
    const send = vi.fn()
    const ctx = {
      conversation: { send },
      sessions: { list: { getSnapshot: () => sessionList(undefined) } },
      uiWorkspace: { connectWorkspace: vi.fn().mockResolvedValue('s1'), openSession: vi.fn() },
      workspaces: {
        list: {
          getSnapshot: () => ({ items: [WS('w1', '2026-09-01T00:00:00Z')], phase: 'pending' }),
          subscribe: (fn: () => void) => { notify = fn; return () => {} },
        },
      },
    }
    const stop = askWhenWorkspaceReady(ctx as never, '转成文字')
    stop()
    notify?.()
    expect(send).not.toHaveBeenCalled()
  })
})
