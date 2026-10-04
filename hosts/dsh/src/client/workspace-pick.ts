/**
 * 「这句话该落到哪个工作区」——一份判据，两个调用方（`ask-conversation` 与
 * `compose-into-conversation`）。
 *
 * **为什么要自己算**：DSH 0.1.2 起 `WorkspaceSnapshot` 只剩 `items` / `phase` 这几格，
 * 那个替我们答完这个问题的 `recentWorkspaceId` 没有了；而 `uiWorkspace.startSession()`
 * 虽然仍按「当前的、其次最近的」挑，却**不回**它挑中的 session id——我们要那个 id 去铸
 * scope（`createScope(ctx, sessionId)`），所以只能走 `connectWorkspace(id)`，也就得自己
 * 先把 id 算出来。
 *
 * 判据沿用旧语义：**当前会话所在的那个工作区优先，其次最近改动过的那个**。两个都
 * 没有 = 用户还没有任何工作区，这时候不能替他挑一个（`connectWorkspace` 只受理名册里的 id）。
 *
 * "当前会话"那半步在 0.2.0 换了来源（没有现成的 `current` 了，改从引用计数推）——
 * 判据只有一份，住 `current-session.ts`，那里有头注。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { currentMainSessionId } from './current-session.ts'

/**
 * 工作区名册到齐了没有。
 *
 * `phase` 是 0.1.2 的到货生命周期（`'pending' | 'ready'`），顶替了旧的 `baselinesReady`：
 * **`items` 为空并不等于「没有工作区」**——页面刚起时它也是空的，照那个判断会把「来得早」
 * 误报成「你没有工作区」。
 * @param ctx - 客户端 context。
 * @returns 名册已经从 host 到齐则 true。
 */
export function workspaceRosterReady(ctx: Context): boolean {
  return ctx.workspaces?.list.getSnapshot().phase === 'ready'
}

/**
 * 挑一个工作区。
 * @param ctx - 客户端 context。
 * @returns 工作区 id；名册为空时 undefined。
 */
export function recentWorkspaceId(ctx: Context): WorkspaceId | undefined {
  const items = ctx.workspaces?.list.getSnapshot().items
  if (items === undefined || items.length === 0) return undefined
  const current = currentMainSessionId(ctx)
  if (current !== undefined) {
    const owning = items.find((w) => w.sessionIds.includes(current))
    if (owning !== undefined) return owning.workspaceId
  }
  // 名册顺序是用户的手动排序，不是时间序——所以「最近」要看 `updatedAt`，别取 items[0]。
  let best = items[0]!
  for (const w of items) if (w.updatedAt > best.updatedAt) best = w
  return best.workspaceId
}
