/**
 * 这个扩展实例的「节点」身份（browser-identity D1）。
 *
 * Chrome 不给扩展任何读 profile 的 API，但 `chrome.storage.local` 是按 profile 隔离的——所以第一次
 * 运行时在这里生成一个 `nodeId` 存起来，它就是这个 profile 的稳定标识。扩展重装、profile 删了重建，
 * 存储没了，就得到一个新的 `nodeId`，Stream 按新节点处理。这正是对的：那确实是另一套登录态。
 *
 * `profileDir` / `profileName` 由认领（计划 2）写进来；没认领过就没有，握手里也不带。
 */
const NODE_KEY = 'node'

export interface NodeInfo {
  nodeId: string
  profileDir?: string
  profileName?: string
}

/** 同一个 SW 实例里并发首读（本机与配对绑定同时起连接）只生成一次。 */
let pending: Promise<NodeInfo> | null = null

export function getNode(): Promise<NodeInfo> {
  pending ??= load().finally(() => { pending = null })
  return pending
}

async function load(): Promise<NodeInfo> {
  const stored = (await chrome.storage.local.get(NODE_KEY))[NODE_KEY] as Partial<NodeInfo> | undefined
  if (stored && typeof stored.nodeId === 'string' && stored.nodeId) return stored as NodeInfo
  const node: NodeInfo = { nodeId: `node_${crypto.randomUUID()}` }
  await chrome.storage.local.set({ [NODE_KEY]: node })
  return node
}

/**
 * 握手要带的 query：`nodeId`，以及存储里有的 profile 两格。走 query 与 `extVersion` 那三格同一个理由
 * （后端在 connect 那一刻就要它）；它们不是 secret，token 仍走 subprotocol。
 */
export function nodeQuery(n: NodeInfo): string {
  const q = new URLSearchParams({ nodeId: n.nodeId })
  if (n.profileDir) q.set('profileDir', n.profileDir)
  if (n.profileName) q.set('profileName', n.profileName)
  return q.toString()
}
