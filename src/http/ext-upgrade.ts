/**
 * `/api/ext` 的 token → 绑定（device-execution D7、browser-identity D1/D2）。从 serve.ts 抽出来是为了能单测：
 * 这一步决定了一条连接算哪个 profile，判错了就是用个人号去执行工作号的事。
 *
 * - 本机 token：带 `nodeId` → `local:<nodeId>`，一个节点一条 relay；不带（老扩展）→ 兼容槽 `local`。
 *   同机多个 profile 共享这把 token，一个 profile 能冒充另一个的 `nodeId`——同机同用户，不防（D2）。
 * - 配对 token：第一次带着 `nodeId` 连上时把它记进绑定；之后带着**另一个** `nodeId` 来连 → 4004。
 *   不带 `nodeId`（老扩展、或扩展降级）照旧放行：它说不出自己是谁，也就冒充不了谁。
 */
import { tokenEqual } from '../../shared/browser-relay/token.ts'
import type { ExtHandshake } from '../../shared/browser-relay/handshake.ts'
import type { ExtUpgradeRefusal } from './ext-relay.ts'
import { LOCAL_BINDING, localNodeBinding } from './ext-relay-registry.ts'

/** 配对绑定的 token 带着另一个节点来连（token 被拷到了别的 profile）。扩展据此停止重连。 */
export const FOREIGN_NODE_CLOSE_CODE = 4004

export interface ExtTokenDeps {
  localToken: string
  bindings: {
    bindingForToken(token: string): { bindingId: string; nodeId?: string } | undefined
    touch(bindingId: string): void
    recordNode(bindingId: string, nodeId: string): unknown
  }
  log?: (line: string) => void
}

export function resolveExtToken(token: string, hs: ExtHandshake, deps: ExtTokenDeps): string | ExtUpgradeRefusal | null {
  if (tokenEqual(token, deps.localToken)) return hs.nodeId ? localNodeBinding(hs.nodeId) : LOCAL_BINDING
  const b = deps.bindings.bindingForToken(token)
  if (!b) return null
  if (hs.nodeId && b.nodeId && b.nodeId !== hs.nodeId) {
    deps.log?.(`[ext-relay] binding ${b.bindingId} belongs to ${b.nodeId}, refused a connection from ${hs.nodeId}`)
    return { close: FOREIGN_NODE_CLOSE_CODE, reason: 'binding belongs to another node' }
  }
  if (hs.nodeId && !b.nodeId) deps.bindings.recordNode(b.bindingId, hs.nodeId)
  // 连上即记一次 lastSeen（拒掉的不算：那不是这条绑定的浏览器）。
  deps.bindings.touch(b.bindingId)
  return b.bindingId
}
