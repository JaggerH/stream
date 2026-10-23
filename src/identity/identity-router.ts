/**
 * 按身份 / 环境选节点（browser-identity D7）。执行开始时解析一次，选出的节点决定设备与扩展绑定，整次执行不变。
 *
 * - 身份目标：候选 = 身份表里该 facility 下这个账号为 `signed-in` 的节点。
 * - 环境目标：候选 = 标了这个环境、且该 facility 为 `signed-in` 的节点。同一环境里登着两个号时取最近核对过的
 *   ——用户选的是环境、不是账号，这一层歧义是他接受的。
 * - 挑法：在线的优先，同为在线取最近核对过的。
 *
 * **没有回落分支。** 候选为空、都离线——这里只会抛 `IdentityOffline`。不读设备默认、不回 `local`、不换成
 * 同一节点上别的账号。读这个文件的人如果想加一个「实在不行就……」，那正是这套设计要防的事。
 */
import { IdentityOffline } from '../devices/errors.ts'
import type { RunIdentity } from '../devices/run-context.ts'
import { describeTarget, type Target } from '../devices/target.ts'
import type { SiteIdentity } from './identity-store.ts'

/** 执行的用途：决定执行前核对的新鲜度窗口（D9）。采集 10 分钟，任务中心的动作 60 秒。 */
export type RunPurpose = 'harvest' | 'action'

export type IdentityTarget = Exclude<Target, { kind: 'device' }>

/** 路由要知道的节点信息（`NodeStore` 的行满足它）。 */
export interface RouterNode {
  nodeId: string
  deviceId: string
  bindingId: string
  profileDir?: string
  profileName?: string
  label?: string
  environment?: string
  wokenAt?: number
}

export interface IdentityRouterDeps {
  /** 该 facility 在身份表里的全部行（现读：探测随时在写）。 */
  identities(facility: string): SiteIdentity[]
  node(nodeId: string): RouterNode | undefined
  isOnline(bindingId: string): boolean
  now?: () => number
  log?: (line: string) => void
}

export interface IdentityRequest {
  target: IdentityTarget
  facility: string
  purpose: RunPurpose
}

/** 解析结果：在哪个节点上、以哪个身份；`release` 由 `runOnDevice` 在执行结束时叫一次。 */
export interface IdentityRoute {
  node: RouterNode
  identity: RunIdentity
  release(): Promise<void>
}

export interface IdentityRouter {
  resolve(req: IdentityRequest): Promise<IdentityRoute>
}

interface Candidate {
  node: RouterNode
  row: SiteIdentity & { accountId: string }
  online: boolean
}

/** 通知与错误里怎么称呼一个节点：「工作」（环境：工作）。 */
export function nodeWhere(n: Pick<RouterNode, 'nodeId' | 'label' | 'profileName' | 'environment'>): string {
  const name = n.label ?? n.profileName ?? n.nodeId
  return `「${name}」${n.environment && n.environment !== name ? `（环境：${n.environment}）` : ''}`
}

export function makeIdentityRouter(deps: IdentityRouterDeps): IdentityRouter & { candidates(target: IdentityTarget, facility: string): Candidate[] } {
  const candidates = (target: IdentityTarget, facility: string): Candidate[] => {
    const out: Candidate[] = []
    for (const row of deps.identities(facility)) {
      // `signed-out` 的行保留着上次的账号 id（界面显示「已登出」），它不是候选。
      if (row.state !== 'signed-in' || !row.accountId) continue
      if (target.kind === 'identity' && row.accountId !== target.accountId) continue
      const node = deps.node(row.nodeId)
      if (!node) continue
      if (target.kind === 'environment' && node.environment !== target.environment) continue
      out.push({ node, row: row as Candidate['row'], online: deps.isOnline(node.bindingId) })
    }
    return out.sort((a, b) => Number(b.online) - Number(a.online) || b.row.verifiedAt - a.row.verifiedAt)
  }

  const resolve = async (req: IdentityRequest): Promise<IdentityRoute> => {
    const { target, facility } = req
    const label = describeTarget(target, facility)
    const all = candidates(target, facility)
    if (!all.length) throw new IdentityOffline(facility, label, '身份表里没有哪个浏览器 profile 登着它')
    const pick = all.find((c) => c.online)
    if (!pick) throw new IdentityOffline(facility, label, '登着它的 profile 都不在线')
    return {
      node: pick.node,
      identity: {
        facility,
        accountId: pick.row.accountId,
        ...(pick.row.displayName ? { accountName: pick.row.displayName } : {}),
        nodeId: pick.node.nodeId,
      },
      release: async () => {},
    }
  }

  return { resolve, candidates }
}
