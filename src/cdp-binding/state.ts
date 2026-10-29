/**
 * 绑定的本地状态文件：配对换来的 token 与这个「节点」的 id。
 *
 * **为什么要有它**：配对的代价是一次性码（得有人把码交进来），而进程会重启（systemd、
 * 浏览器挂起恢复、机器重开）。状态文件在 = 重启后直接 verify 重连，不再要码。
 *
 * **只放这两样**（外加一个非机密的绑定 id，见下）：配对码用完即弃，绝不落盘；token 是这个
 * 文件里唯一的秘密，所以文件权限 0600，且**写失败就抛**——悄悄写不进去，表现是"这次能连、
 * 下次重启又得重新配对"，而那时候多半没人在机器前。
 *
 * `bindingId` 不是秘密（服务端本来就存着它、它只用来挑那把 token 的哈希），但 `/api/ext/verify`
 * 必须带它才能证明对端也持有这把 token（见 `pairing.ts`），所以它跟 token 住在一起。
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface CdpBindingState {
  /** 配对换来的绑定 token。 */
  token: string
  /** 这个绑定实例的节点 id（`node_<uuid>`）——服务端据此认出「同一台机器上的同一个绑定」。 */
  nodeId: string
  /** 配对回执里的绑定 id（非机密；verify 用它挑 HMAC key）。 */
  bindingId: string
}

const NODE_ID = /^node_[A-Za-z0-9-]{1,59}$/

/** 新节点的 id。形状与服务端 `cleanNodeId` 认的那个一致（`node_` + uuid）。 */
export function newNodeId(): string {
  return `node_${randomUUID()}`
}

/**
 * 读状态。文件不在 / 读不懂 / 字段不全 → `null`（调用方据此重新配对）。
 *
 * 读不懂时**不抛**：一个坏掉的状态文件不该让进程起不来——重配一次就能恢复，而抛错的表现是
 * 一个永远起不来的服务。但调用方必须把这件事说进日志（`readCdpBindingState` 只回答"有没有"）。
 */
export function readCdpBindingState(file: string): CdpBindingState | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const s = parsed as Record<string, unknown>
  if (typeof s.token !== 'string' || !s.token) return null
  if (typeof s.nodeId !== 'string' || !NODE_ID.test(s.nodeId)) return null
  if (typeof s.bindingId !== 'string' || !s.bindingId) return null
  return { token: s.token, nodeId: s.nodeId, bindingId: s.bindingId }
}

/**
 * 写状态：目录按需建，文件 0600，**先写临时文件再 rename**。
 *
 * 直接覆写的话，进程在写一半时被杀 = 一个半截 JSON = 下次启动读不懂 = 重新配对，而那时候
 * 可能没有码可喂。rename 在同一个目录内是原子的：要么是旧文件，要么是完整的新文件。
 * `mode` 只在创建时生效，所以对已存在的文件再 `chmod` 一次（同 `secrets.ts` 的写法）。
 */
export function writeCdpBindingState(file: string, state: CdpBindingState): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
  chmodSync(file, 0o600)
}
