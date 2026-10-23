/** 身份表的纯函数：面板设备页与目标下拉（任务编辑器在主 bundle 里）共用，不带任何组件。 */
import type { IdentityRow, NodeRow } from '../../lib/api.ts'

/** 一个节点给人看的名字：用户起的名字 → 认领来的 profile 名 → 绑定名（配对时扩展报的）→ 未识别。 */
export function nodeTitle(n: Pick<NodeRow, 'label' | 'profileName'>, fallback?: string): string {
  return n.label ?? n.profileName ?? fallback ?? '未识别的 profile'
}

/** 「3 分钟前」。身份表的新鲜度决定执行前要不要再核对（采集 10 分钟、动作 60 秒），所以给相对时间。 */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

export interface IdentityGroup {
  facility: string
  accountId?: string
  name: string
  signedIn: boolean
  verifiedAt: number
  nodes: Array<{ nodeId: string; name: string; online: boolean; signedIn: boolean }>
}

/**
 * 身份表的行是（facility，节点）；给人看的是（facility，账号）——同一个账号可以登在好几个 profile 里
 * （D6：身份 = facility + 账号，出现在多个节点上）。登出且从没见过账号的行各自成组。
 */
export function groupIdentities(rows: IdentityRow[], nodes: NodeRow[] = []): IdentityGroup[] {
  const byNode = new Map(nodes.map((n) => [n.nodeId, n]))
  const groups = new Map<string, IdentityGroup>()
  for (const r of rows) {
    const key = `${r.facility}\u0000${r.accountId ?? `-${r.nodeId}`}`
    const g = groups.get(key) ?? {
      facility: r.facility,
      ...(r.accountId ? { accountId: r.accountId } : {}),
      name: r.displayName ?? r.accountId ?? '（已登出）',
      signedIn: false,
      verifiedAt: 0,
      nodes: [],
    }
    const n = byNode.get(r.nodeId)
    g.nodes.push({ nodeId: r.nodeId, name: n ? nodeTitle(n) : r.profileName ?? r.nodeId, online: r.online, signedIn: r.state === 'signed-in' })
    g.signedIn ||= r.state === 'signed-in'
    g.verifiedAt = Math.max(g.verifiedAt, r.verifiedAt)
    // 显示名以登着的那一行为准（登出的行保留的是上次的名字）。
    if (r.state === 'signed-in' && r.displayName) g.name = r.displayName
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => a.facility.localeCompare(b.facility) || a.name.localeCompare(b.name))
}
