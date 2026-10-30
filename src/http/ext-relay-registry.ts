/**
 * 每条扩展绑定一条 `ExtRelay`（device-execution D7）。配对绑定的 relay 在它第一次连上时建，之后常驻
 * （断开只是 `connected=false`，pending 由 relay 自己 reject）。
 *
 * **本机按节点（browser-identity D2）。** 同一台机器上每个 Chrome profile 的扩展各是一个节点：握手带
 * `nodeId` 的本机连接落 `local:<nodeId>`，一个节点一条 relay，互不顶替；不带的（老扩展）落兼容槽
 * `local`——那条在构造时交进来、永远在，行为与升级前一模一样（以最新为准）。
 *
 * 「设备有浏览器」= 至少一条挂在它上面的绑定在线。选哪条（`pick`）：设备的默认节点在线就选它，
 * 否则最近连上的那条。本机一条都不在线时回兼容槽，不抛——本机的 Chrome 可以被唤起，调用方会等它连上。
 *
 * `local` 这个 getter 不是某一条 relay，而是一个门面（`LocalExtRelay`）：每次调用经 `pickBrowser`
 * 解析到本机的某个节点。本机路径上直接拿 relay 的地方有三十来处，不逐个改。
 */
import { DeviceIncapable, DeviceOffline } from '../devices/errors.ts'
import { pickBrowser } from '../devices/placement.ts'
import { LOCAL_BINDING, LOCAL_DEVICE, currentDeviceId } from '../devices/run-context.ts'
import type { ExtHandshake } from '../../shared/browser-relay/handshake.ts'
import type { ExtCdpEvent, ExtRelay, ExtSocket } from './ext-relay.ts'

export { LOCAL_BINDING }

/** 本机节点的绑定 id。 */
export const localNodeBinding = (nodeId: string): string => `${LOCAL_BINDING}:${nodeId}`

/** 本机的绑定：兼容槽 `local` 与每个节点的 `local:<nodeId>`。 */
export const isLocalBinding = (bindingId: string): boolean =>
  bindingId === LOCAL_BINDING || bindingId.startsWith(`${LOCAL_BINDING}:`)

export interface NodeSeenEvent {
  nodeId: string
  deviceId: string
  bindingId: string
  profileDir?: string
  profileName?: string
}

/** ExtRelayRegistry 的上下线事件载荷（at = 毫秒时间戳；deviceId / nodeId 认不出时不带）。 */
export interface ExtChange {
  bindingId: string
  deviceId?: string
  nodeId?: string
  online: boolean
  at: number
}

/** 认领帧的回答（`ProfileClaims.redeem` 的结果）。 */
export type ClaimReply = { ok: true; profileDir: string; profileName: string } | { ok: false; error: string }

export interface ExtRelayRegistryDeps {
  /** 本机兼容槽：不带 `nodeId` 的老扩展连这条。 */
  local: ExtRelay
  makeRelay: (bindingId: string) => ExtRelay
  /** 配对绑定挂在哪台设备（`ExtBindingStore.get`）；本机的不经它。 */
  deviceOf: (bindingId: string) => string | undefined
  /** 设备上的配对绑定；本机的由 registry 自己数（它们不在绑定表里）。 */
  bindingsOf: (deviceId: string) => string[]
  /** 设备的默认浏览器是哪条绑定（默认节点的绑定，迁移前是 `ExtBindingStore.defaultOf`）。没注入 = 没有默认。 */
  defaultOf?: (deviceId: string) => string | undefined
  /** 配对绑定记下的节点（`ExtBindingStore.get().nodeId`）。本机节点的从绑定 id 上读。 */
  nodeOf?: (bindingId: string) => string | undefined
  /** 带 `nodeId` 的连接连上了（`NodeStore.seen`）。 */
  onNodeSeen?: (n: NodeSeenEvent) => void
  now?: () => number
}

export class ExtRelayRegistry {
  private readonly relays = new Map<string, ExtRelay>()
  private readonly connectedAt = new Map<string, number>()
  private readonly sockets = new Map<string, ExtSocket & { close?: (code: number, reason: string) => void }>()
  // 连接时记下的「这条绑定属于哪台设备」。撤销绑定先删绑定表行、后 kick 连接，kick 发 offline
  // 事件时 deviceOf 已查不出这条绑定——嵌入方按 deviceId 折叠上下线，丢了这个字段事件就等于没发。
  private readonly deviceByBinding = new Map<string, string>()
  private readonly localRelayHooks: Array<(r: ExtRelay) => void> = []
  readonly local: LocalExtRelay

  constructor(private readonly deps: ExtRelayRegistryDeps) {
    this.relays.set(LOCAL_BINDING, deps.local)
    this.local = new LocalExtRelay(this)
  }

  connect(bindingId: string, socket: ExtSocket & { close?: (code: number, reason: string) => void }, info?: ExtHandshake): void {
    const prev = this.sockets.get(bindingId)
    let r = this.relays.get(bindingId)
    if (!r) {
      r = this.deps.makeRelay(bindingId)
      this.relays.set(bindingId, r)
      if (isLocalBinding(bindingId)) for (const fn of this.localRelayHooks) fn(r)
    }
    r.connect(socket, info)
    if (!isLocalBinding(bindingId)) {
      const dev = this.deviceOf(bindingId)
      if (dev) this.deviceByBinding.set(bindingId, dev)
    }
    this.sockets.set(bindingId, socket)
    const at = (this.deps.now ?? Date.now)()
    this.connectedAt.set(bindingId, at)
    // 新连接顶掉旧连接：旧 socket 立刻关掉，不等心跳判死。先换 sockets 再关——旧 socket 的
    // teardown 靠身份认出「已被顶替」，不会发 offline。
    if (prev && prev !== socket) {
      try {
        prev.close?.(1001, 'replaced by a newer connection')
      } catch {
        /* 已经断了 */
      }
    }
    // **每次握手成功都发一条 online**（含顶掉旧连接的重连）：嵌入方按事件折状态，绑定挂起期间
    // 可能已被压成离线，重连不发事件就只能等它自己的兜底对账。事件幂等。
    this.emitChange({ bindingId, deviceId: this.deviceOf(bindingId), nodeId: this.nodeOf(bindingId), online: true, at })
    if (info?.nodeId) {
      const deviceId = this.deviceOf(bindingId)
      // 节点表写不进去不影响这条连接：表只服务默认节点与留痕，relay 本身已经能用了。
      if (deviceId) {
        try {
          this.deps.onNodeSeen?.({
            nodeId: info.nodeId, deviceId, bindingId,
            ...(info.profileDir ? { profileDir: info.profileDir } : {}),
            ...(info.profileName ? { profileName: info.profileName } : {}),
          })
        } catch { /* 同上 */ }
      }
    }
    for (const fn of this.connectedListeners) {
      try { fn(bindingId) } catch { /* 听众的问题不是中继的问题 */ }
    }
  }

  private readonly connectedListeners: Array<(bindingId: string) => void> = []

  /** 任何一条绑定连上（含重连）时叫一声——登录态取数挂在这儿（本机节点与配对绑定的 relay 是连上时
   *  才建的，没法提前在它身上挂 `onConnected`）。 */
  onBindingConnected(fn: (bindingId: string) => void): void {
    this.connectedListeners.push(fn)
  }

  // ── 上下线事件（openspec embeddable-device-gateway）───────────────────────────
  private readonly changeListeners: Array<(ch: ExtChange) => void> = []

  /** 绑定连上 / 断开时叫一声。**每次握手成功都发一条 online**（含顶掉旧连接的重连）；被顶掉的
   *  旧 socket 关闭是 no-op。撤销走 kick，自然发 offline。监听器抛错只记日志，不影响连接。 */
  onChange(fn: (ch: ExtChange) => void): void {
    this.changeListeners.push(fn)
  }

  private emitChange(ch: ExtChange): void {
    for (const fn of this.changeListeners) {
      try { fn(ch) } catch { /* 听众的问题不是中继的问题 */ }
    }
  }

  /** 对每一条本机 relay（现有的，以及之后才连上的节点）各调一次——门面的长期监听靠它扇出。 */
  eachLocalRelay(fn: (r: ExtRelay) => void): void {
    for (const [id, r] of this.relays) if (isLocalBinding(id)) fn(r)
    this.localRelayHooks.push(fn)
  }

  deviceOf(bindingId: string): string | undefined {
    return isLocalBinding(bindingId) ? LOCAL_DEVICE : this.deps.deviceOf(bindingId)
  }

  /** offline 事件里报的设备：优先用连接时记下的（撤销删行之后 deviceOf 查不出），其次再查绑定表。 */
  private knownDeviceOf(bindingId: string): string | undefined {
    return this.deviceByBinding.get(bindingId) ?? this.deviceOf(bindingId)
  }

  /** 这条绑定是哪个节点。兼容槽与没记过节点的配对绑定（老扩展）没有。 */
  nodeOf(bindingId: string): string | undefined {
    if (bindingId === LOCAL_BINDING) return undefined
    if (isLocalBinding(bindingId)) return bindingId.slice(LOCAL_BINDING.length + 1)
    return this.deps.nodeOf?.(bindingId)
  }

  disconnect(bindingId: string, socket: ExtSocket): void {
    this.relays.get(bindingId)?.disconnect(socket)
    if (this.sockets.get(bindingId) !== socket) return
    this.sockets.delete(bindingId)
    this.connectedAt.delete(bindingId)
    this.emitChange({ bindingId, deviceId: this.knownDeviceOf(bindingId), nodeId: this.nodeOf(bindingId), online: false, at: (this.deps.now ?? Date.now)() })
  }

  /** 撤销：断开并忘掉。返回它当时在不在线。 */
  kick(bindingId: string, code: number, reason: string): boolean {
    const s = this.sockets.get(bindingId)
    // 先让 relay 自己断开：在途命令要立刻 reject，不能等 close 事件——那时这条 relay 已经被忘掉了。
    if (s) this.relays.get(bindingId)?.disconnect(s)
    this.sockets.delete(bindingId)
    this.connectedAt.delete(bindingId)
    // 本机的 relay 不忘：门面挂在它们身上的监听要一直在。
    if (!isLocalBinding(bindingId)) this.relays.delete(bindingId)
    const deviceId = this.knownDeviceOf(bindingId)
    this.deviceByBinding.delete(bindingId)
    if (!s) return false
    this.emitChange({ bindingId, deviceId, nodeId: this.nodeOf(bindingId), online: false, at: (this.deps.now ?? Date.now)() })
    try { s.close?.(code, reason) } catch { /* 已经断了 */ }
    return true
  }

  /** WS 上收到的一帧交给那条绑定的 relay；已被撤销（relay 已忘）的帧丢掉。 */
  handleMessage(bindingId: string, raw: string): void {
    const r = this.relays.get(bindingId)
    if (!r) return
    if (this.maybeClaim(bindingId, raw)) return
    r.handleMessage(raw)
  }

  private claimHandler: ((bindingId: string, nonce: string) => ClaimReply) | undefined

  /**
   * 扩展经这条绑定交回认领码（browser-identity D3：`{ type: 'claim', nonce }`）。帧要知道是哪条绑定交的
   * ——同设备校验就靠它——而 relay 不知道自己是哪条绑定，所以在这里、交给 relay 之前截下。
   */
  onClaim(fn: (bindingId: string, nonce: string) => ClaimReply): void {
    this.claimHandler = fn
  }

  /**
   * 是认领帧就处理掉、回 `{ type: 'claim-result', nonce, ...}`，返回 true。先看长度和字面量再解析：
   * 这条路上过的是全部 CDP 回执，大的有几 MB（截图），每帧都 `JSON.parse` 两遍不值得。
   */
  private maybeClaim(bindingId: string, raw: string): boolean {
    if (raw.length > 1024 || !raw.includes('"claim"')) return false
    let msg: { type?: unknown; nonce?: unknown }
    try { msg = JSON.parse(raw) } catch { return false }
    if (msg?.type !== 'claim') return false
    const nonce = typeof msg.nonce === 'string' ? msg.nonce : ''
    let reply: ClaimReply
    try {
      reply = this.claimHandler && nonce ? this.claimHandler(bindingId, nonce) : { ok: false, error: '这个 Stream 不接受认领' }
    } catch (e) {
      reply = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    try { this.sockets.get(bindingId)?.send(JSON.stringify({ type: 'claim-result', nonce, ...reply })) } catch { /* 已经断了 */ }
    return true
  }

  relay(bindingId: string): ExtRelay {
    const r = this.relays.get(bindingId)
    if (!r) throw new Error(`没有这条扩展绑定的中继：${bindingId}`)
    return r
  }

  isOnline(bindingId: string): boolean {
    return this.relays.get(bindingId)?.connected ?? false
  }

  /** 设备上的全部绑定。本机 = 兼容槽 + 连上过的每个节点（D2）。 */
  bindingsOf(deviceId: string): string[] {
    if (deviceId === LOCAL_DEVICE) return [...this.relays.keys()].filter(isLocalBinding)
    return this.deps.bindingsOf(deviceId)
  }

  hasBrowser(deviceId: string): boolean {
    return this.bindingsOf(deviceId).some((b) => this.isOnline(b))
  }

  pick(deviceId: string): string {
    const all = this.bindingsOf(deviceId)
    const online = all.filter((b) => this.isOnline(b))
    if (deviceId === LOCAL_DEVICE) {
      // 本机一条都不在线：回兼容槽，与升级前一致——调用方（ensureHarvestBrowser）会唤起 Chrome 再等。
      if (!online.length) return LOCAL_BINDING
    } else {
      if (!all.length) throw new DeviceIncapable(deviceId, 'browser')
      if (!online.length) throw new DeviceOffline(deviceId)
    }
    // 默认是偏好不是约束：它离线时照旧选最近连上的，不让这次执行因为一个设置失败。
    const preferred = this.deps.defaultOf?.(deviceId)
    if (preferred && online.includes(preferred)) return preferred
    return online.reduce((best, b) => ((this.connectedAt.get(b) ?? 0) > (this.connectedAt.get(best) ?? 0) ? b : best))
  }

  /** 面板与诊断用：每条已知 relay 的在线状态。 */
  statuses(): Array<{ bindingId: string; deviceId: string; online: boolean; since: string | null }> {
    return [...this.relays.entries()].map(([bindingId, r]) => ({
      bindingId,
      deviceId: this.deviceOf(bindingId) ?? '?',
      online: r.connected,
      since: r.status().since,
    }))
  }
}

/**
 * `registry.local`：一个 `ExtRelay` 形状的门面（browser-identity D2），每次调用时解析到本机某个节点的 relay。
 *
 * - 执行内（上下文在本机）：经 `pickBrowser`，第一次解析钉在执行上下文上，之后整次执行不变——中途新连上
 *   的 profile 接不走这次执行。
 * - 执行外（面板、MCP 工具）与远程设备上的执行：本机此刻的默认节点，不钉。「本机」不因为在远程执行里
 *   被调用就变成远程。
 *
 * **不缓存解析结果。** 长期监听（`onConnected` / `onCookiesChanged`）扇出到每一条本机 relay，包括之后
 * 才连上的节点；`onEvent` 是跟着一次订阅走的，挂在解析出来的那一条上。
 */
export class LocalExtRelay {
  /** 订阅号 → 下订阅的那条 relay：退订得回到同一个节点（订阅号是各节点自己编的）。 */
  private readonly subscriptions = new Map<number, ExtRelay>()

  constructor(private readonly reg: ExtRelayRegistry) {}

  /** 这一次调用落在哪条本机绑定上。 */
  bindingId(): string {
    return currentDeviceId() === LOCAL_DEVICE ? pickBrowser(this.reg) : this.reg.pick(LOCAL_DEVICE)
  }

  private get r(): ExtRelay {
    return this.reg.relay(this.bindingId())
  }

  get connected(): boolean {
    return this.r.connected
  }

  status(): { connected: boolean; since: string | null } {
    return this.r.status()
  }

  onConnected(fn: () => void): void {
    this.reg.eachLocalRelay((r) => r.onConnected(fn))
  }

  onCookiesChanged(fn: (domains: string[]) => void): void {
    this.reg.eachLocalRelay((r) => r.onCookiesChanged(fn))
  }

  onEvent(listener: (event: ExtCdpEvent) => void): () => void {
    return this.r.onEvent(listener)
  }

  sendCommand(...a: Parameters<ExtRelay['sendCommand']>): ReturnType<ExtRelay['sendCommand']> { return this.r.sendCommand(...a) }
  frameSessions(...a: Parameters<ExtRelay['frameSessions']>): ReturnType<ExtRelay['frameSessions']> { return this.r.frameSessions(...a) }
  openedSince(...a: Parameters<ExtRelay['openedSince']>): ReturnType<ExtRelay['openedSince']> { return this.r.openedSince(...a) }
  newTab(...a: Parameters<ExtRelay['newTab']>): ReturnType<ExtRelay['newTab']> { return this.r.newTab(...a) }
  openTab(...a: Parameters<ExtRelay['openTab']>): ReturnType<ExtRelay['openTab']> { return this.r.openTab(...a) }
  closeTab(...a: Parameters<ExtRelay['closeTab']>): ReturnType<ExtRelay['closeTab']> { return this.r.closeTab(...a) }
  list(): ReturnType<ExtRelay['list']> { return this.r.list() }
  cookieNames(...a: Parameters<ExtRelay['cookieNames']>): ReturnType<ExtRelay['cookieNames']> { return this.r.cookieNames(...a) }
  cookiePull(...a: Parameters<ExtRelay['cookiePull']>): ReturnType<ExtRelay['cookiePull']> { return this.r.cookiePull(...a) }
  activeTab(): ReturnType<ExtRelay['activeTab']> { return this.r.activeTab() }
  activateTab(...a: Parameters<ExtRelay['activateTab']>): ReturnType<ExtRelay['activateTab']> { return this.r.activateTab(...a) }

  async subscribe(tabId: number, domains: string[]): Promise<number> {
    const r = this.r
    const id = await r.subscribe(tabId, domains)
    this.subscriptions.set(id, r)
    return id
  }

  unsubscribe(subscriptionId: number): Promise<void> {
    const r = this.subscriptions.get(subscriptionId) ?? this.r
    this.subscriptions.delete(subscriptionId)
    return r.unsubscribe(subscriptionId)
  }
}
