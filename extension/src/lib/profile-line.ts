/**
 * popup 顶部那一行：这个扩展实例在哪个 profile、哪个环境里（browser-identity D12）。
 *
 * profile 名来自认领（扩展自己的 `chrome.storage.local.node`，认领时写进去）；环境只有 Stream 知道
 * （用户在面板上给节点标的），所以再问一次后端的节点表、找自己那一行。后端问不着就只说存储里有的。
 *
 * 没认领过的 profile 说不出自己是谁——Chrome 不给扩展读 profile 的 API，只能由 Stream Desktop 用这个
 * profile 打开扩展自己的认领页来认（D3）。所以这时说「未识别的 profile」，外加一行去哪里点。
 */
import type { NodeInfo } from './node.ts'

export interface ProfileLine {
  title: string
  claimed: boolean
  hint?: string
}

/** 后端节点表里自己那一行（`GET /api/devices/nodes`）用得上的几格。 */
export interface RemoteNode {
  profileDir?: string
  profileName?: string
  label?: string
  environment?: string
}

export const UNCLAIMED_HINT = '在 Stream 面板的「管理 → 设备」里点「识别 profile」，Stream 就能认出这是哪个 Chrome profile。'

export function profileLine(node: NodeInfo, remote: RemoteNode | undefined): ProfileLine {
  const name = remote?.label ?? remote?.profileName ?? node.profileName
  const claimed = !!(remote?.profileDir ?? node.profileDir) && !!name
  if (!claimed || !name) return { title: '未识别的 profile', claimed: false, hint: UNCLAIMED_HINT }
  return { title: remote?.environment ? `${remote.environment} · ${name}` : name, claimed: true }
}

/** 读存储 + 问后端。还没有 `nodeId`（SW 一次都没跑过）时回 null：那时什么都说不出。 */
export async function readProfileLine(baseUrl: string): Promise<ProfileLine | null> {
  const node = (await chrome.storage.local.get('node')).node as NodeInfo | undefined
  if (!node?.nodeId) return null
  let remote: RemoteNode | undefined
  if (baseUrl) try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/devices/nodes`)
    if (res.ok) {
      const body = (await res.json()) as { nodes?: Array<RemoteNode & { nodeId: string }> | null }
      remote = body.nodes?.find((n) => n.nodeId === node.nodeId)
    }
  } catch { /* 后端够不着：只用存储里的 */ }
  return profileLine(node, remote)
}
