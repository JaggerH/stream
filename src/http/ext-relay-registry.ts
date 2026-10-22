/**
 * 每条扩展绑定一条 `ExtRelay`（design D7）。`local` 那条就是今天的单例，构造时交进来、永远在；
 * 配对绑定的 relay 在它第一次连上时建，之后常驻（断开只是 `connected=false`，pending 由 relay 自己 reject）。
 *
 * 「设备有浏览器」= 至少一条挂在它上面的绑定在线。选哪条：最近连上的那条——计划 4 的默认绑定落地前，
 * 这是唯一不需要用户配置就说得通的规则（刚开的那个 Chrome 最可能是用户正看着的）。
 */
import { DeviceIncapable, DeviceOffline } from '../devices/errors.ts'
import { LOCAL_BINDING, LOCAL_DEVICE } from '../devices/run-context.ts'
import type { ExtHandshake } from '../../shared/browser-relay/handshake.ts'
import type { ExtRelay, ExtSocket } from './ext-relay.ts'

export { LOCAL_BINDING }

export interface ExtRelayRegistryDeps {
  local: ExtRelay
  makeRelay: (bindingId: string) => ExtRelay
  /** 绑定挂在哪台设备（`ExtBindingStore.get`）；`local` 不经它。 */
  deviceOf: (bindingId: string) => string | undefined
  bindingsOf: (deviceId: string) => string[]
  /** 设备的默认浏览器（`ExtBindingStore.defaultOf`）。没注入 = 没有默认。 */
  defaultOf?: (deviceId: string) => string | undefined
  now?: () => number
}

export class ExtRelayRegistry {
  private readonly relays = new Map<string, ExtRelay>()
  private readonly connectedAt = new Map<string, number>()
  private readonly sockets = new Map<string, ExtSocket & { close?: (code: number, reason: string) => void }>()

  constructor(private readonly deps: ExtRelayRegistryDeps) {
    this.relays.set(LOCAL_BINDING, deps.local)
  }

  get local(): ExtRelay {
    return this.deps.local
  }

  connect(bindingId: string, socket: ExtSocket & { close?: (code: number, reason: string) => void }, info?: ExtHandshake): void {
    let r = this.relays.get(bindingId)
    if (!r) {
      r = this.deps.makeRelay(bindingId)
      this.relays.set(bindingId, r)
    }
    r.connect(socket, info)
    this.sockets.set(bindingId, socket)
    this.connectedAt.set(bindingId, (this.deps.now ?? Date.now)())
    for (const fn of this.connectedListeners) {
      try { fn(bindingId) } catch { /* 听众的问题不是中继的问题 */ }
    }
  }

  private readonly connectedListeners: Array<(bindingId: string) => void> = []

  /** 任何一条绑定连上（含重连）时叫一声——登录态取数挂在这儿（配对绑定的 relay 是连上时才建的，
   *  没法提前在它身上挂 `onConnected`）。 */
  onBindingConnected(fn: (bindingId: string) => void): void {
    this.connectedListeners.push(fn)
  }

  deviceOf(bindingId: string): string | undefined {
    return bindingId === LOCAL_BINDING ? LOCAL_DEVICE : this.deps.deviceOf(bindingId)
  }

  disconnect(bindingId: string, socket: ExtSocket): void {
    this.relays.get(bindingId)?.disconnect(socket)
    if (this.sockets.get(bindingId) === socket) {
      this.sockets.delete(bindingId)
      this.connectedAt.delete(bindingId)
    }
  }

  /** 撤销：断开并忘掉。返回它当时在不在线。 */
  kick(bindingId: string, code: number, reason: string): boolean {
    const s = this.sockets.get(bindingId)
    // 先让 relay 自己断开：在途命令要立刻 reject，不能等 close 事件——那时这条 relay 已经被忘掉了。
    if (s) this.relays.get(bindingId)?.disconnect(s)
    this.sockets.delete(bindingId)
    this.connectedAt.delete(bindingId)
    if (bindingId !== LOCAL_BINDING) this.relays.delete(bindingId)
    if (!s) return false
    try { s.close?.(code, reason) } catch { /* 已经断了 */ }
    return true
  }

  /** WS 上收到的一帧交给那条绑定的 relay；已被撤销（relay 已忘）的帧丢掉。 */
  handleMessage(bindingId: string, raw: string): void {
    this.relays.get(bindingId)?.handleMessage(raw)
  }

  relay(bindingId: string): ExtRelay {
    const r = this.relays.get(bindingId)
    if (!r) throw new Error(`没有这条扩展绑定的中继：${bindingId}`)
    return r
  }

  isOnline(bindingId: string): boolean {
    return this.relays.get(bindingId)?.connected ?? false
  }

  hasBrowser(deviceId: string): boolean {
    if (deviceId === LOCAL_DEVICE) return this.deps.local.connected
    return this.deps.bindingsOf(deviceId).some((b) => this.isOnline(b))
  }

  pick(deviceId: string): string {
    if (deviceId === LOCAL_DEVICE) return LOCAL_BINDING
    const all = this.deps.bindingsOf(deviceId)
    if (!all.length) throw new DeviceIncapable(deviceId, 'browser')
    const online = all.filter((b) => this.isOnline(b))
    if (!online.length) throw new DeviceOffline(deviceId)
    // 默认是偏好不是约束：它离线时照旧选最近连上的，不让这次执行因为一个设置失败。
    const preferred = this.deps.defaultOf?.(deviceId)
    if (preferred && online.includes(preferred)) return preferred
    return online.reduce((best, b) => ((this.connectedAt.get(b) ?? 0) > (this.connectedAt.get(best) ?? 0) ? b : best))
  }

  /** 面板与诊断用：每条已知 relay 的在线状态。 */
  statuses(): Array<{ bindingId: string; deviceId: string; online: boolean; since: string | null }> {
    return [...this.relays.entries()].map(([bindingId, r]) => ({
      bindingId,
      deviceId: bindingId === LOCAL_BINDING ? LOCAL_DEVICE : this.deps.deviceOf(bindingId) ?? '?',
      online: r.connected,
      since: r.status().since,
    }))
  }
}
