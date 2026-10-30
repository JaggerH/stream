/**
 * Every agent connected to `/api/host`, keyed by the device it declared in its `hello`.
 *
 * One `WsHostRelay` per device, **kept across reconnects**: a reconnect is the same device coming back,
 * so its session lease and abort epoch carry over, exactly as they did when there was only one relay.
 * "Latest connection wins" is therefore per device. A phone connecting never touches the PC's
 * connection, and two recipes on two devices do not wait for each other.
 */
import { WsHostRelay, type HostSocket } from './host-relay.ts'
import { LOCAL_DEVICE } from '../devices/run-context.ts'

export type HostPlatform = 'windows' | 'macos' | 'android' | 'linux'
/** What a recipe targets. A recipe asks for a surface, not for an OS. */
export type HostSurface = 'desktop' | 'android'

export interface HostHello {
  deviceId: string
  platform: HostPlatform
  name: string
  agentVersion: string
  /** The ops this agent implements. The driver checks this before sending anything. */
  ops: string[]
}

/** What a phone reports about itself: sent right after `hello`, every 30 s, and on every
 *  accessibility-service change. The backend only stores the latest one. */
export interface HostDeviceState {
  a11yEnabled: boolean
  screenOn: boolean
  keyguardLocked: boolean
  battery: number
  charging: boolean
}

/** `null` for anything that is not a complete state frame. A partial frame is dropped, not
 *  merged: a missing `a11yEnabled` read as `false` would raise a false alarm. */
export function parseState(raw: string): HostDeviceState | null {
  let m: Record<string, unknown>
  try {
    m = JSON.parse(raw)
  } catch {
    return null
  }
  if (m === null || typeof m !== 'object' || m.type !== 'state') return null
  const { a11yEnabled, screenOn, keyguardLocked, battery, charging } = m
  if (typeof a11yEnabled !== 'boolean' || typeof screenOn !== 'boolean' || typeof keyguardLocked !== 'boolean') return null
  if (typeof battery !== 'number' || typeof charging !== 'boolean') return null
  return { a11yEnabled, screenOn, keyguardLocked, battery, charging }
}

export interface HostDevice {
  hello: HostHello
  relay: WsHostRelay
  ops: ReadonlySet<string>
  connectedAt: number
  state?: HostDeviceState
}

const PLATFORMS: ReadonlySet<string> = new Set(['windows', 'macos', 'android', 'linux'])

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/**
 * Parse the first frame of a connection. **Anything malformed is `null`, never a default**: a
 * `hello` with a missing `ops` turned into `[]` would make every op on that device fail as
 * "unsupported", and the agent's real defect (it sent a broken hello) would never be named.
 */
export function parseHello(raw: string): HostHello | null {
  let m: Record<string, unknown>
  try {
    m = JSON.parse(raw)
  } catch {
    return null
  }
  if (m === null || typeof m !== 'object' || m.type !== 'hello') return null
  const { deviceId, platform, name, agentVersion, ops } = m
  if (!nonEmpty(deviceId) || !nonEmpty(name) || !nonEmpty(agentVersion)) return null
  // `local` 是后端本机的保留 id（fetchFor 见到它就走本机），不能被一台设备占用。
  if (deviceId.trim().toLowerCase() === LOCAL_DEVICE) return null
  if (typeof platform !== 'string' || !PLATFORMS.has(platform)) return null
  if (!Array.isArray(ops) || !ops.every((o) => typeof o === 'string')) return null
  return { deviceId, platform: platform as HostPlatform, name, agentVersion, ops: ops as string[] }
}

export function surfaceOf(p: HostPlatform): HostSurface {
  return p === 'android' ? 'android' : 'desktop'
}

interface Live {
  hello: HostHello
  socket: HostSocket
  ops: ReadonlySet<string>
  connectedAt: number
  state?: HostDeviceState
}

export type DeviceFetchRelay = Pick<WsHostRelay, 'fetchOp' | 'connected'>

export class HostRelayRegistry {
  private readonly relays = new Map<string, WsHostRelay>()
  private readonly live = new Map<string, Live>()

  constructor(private readonly relayOpts?: { timeoutMs?: number; sessionWaitMs?: number; fetchQueueWaitMs?: number }) {}

  /** A device finished its handshake. Returns that device's relay. */
  connect(socket: HostSocket, hello: HostHello, now: number = Date.now()): WsHostRelay {
    const prev = this.live.get(hello.deviceId)
    let relay = this.relays.get(hello.deviceId)
    if (!relay) {
      relay = new WsHostRelay(this.relayOpts)
      this.relays.set(hello.deviceId, relay)
    }
    relay.connect(socket)
    this.live.set(hello.deviceId, { hello, socket, ops: new Set(hello.ops), connectedAt: now })
    // 新连接顶掉旧连接：旧 socket 立刻关掉，不等心跳判死（设备被冻住 / 断网时它会半开着）。
    // 先换 live 再关：旧 socket 的 close 处理器靠 socket 身份认出「已被顶替」，不会发 offline。
    if (prev && prev.socket !== socket) {
      try {
        prev.socket.close?.(1001, 'replaced by a newer connection')
      } catch {
        /* 已经断了 */
      }
    }
    // **每次都发 online**，包括顶掉旧连接的重连：嵌入方按事件折在线状态，设备挂起期间它可能
    // 已经把行压成离线（厂商说挂起），重连不发事件就只能等它自己的兜底对账（一个心跳周期一拍）
    // ——那正是恢复后「重连上了但表不翻」的来源。事件幂等，消费方行已在线时无变化。
    this.emitChange({ deviceId: hello.deviceId, name: hello.name, platform: hello.platform, online: true, at: now })
    return relay
  }

  /** A socket closed. A socket that was already replaced by a newer one changes nothing. */
  disconnect(socket: HostSocket, deviceId: string): void {
    this.relays.get(deviceId)?.disconnect(socket)
    const l = this.live.get(deviceId)
    if (l?.socket !== socket) return
    this.live.delete(deviceId)
    this.emitChange({ deviceId, name: l.hello.name, platform: l.hello.platform, online: false, at: Date.now() })
  }

  /** Drop a device's live connection (revoked). Deregisters synchronously (live entry gone, pending
   *  ops fail as disconnected) rather than waiting for the peer to acknowledge the close; the later
   *  close handler's `disconnect` is a no-op because both guards compare socket identity. */
  kick(deviceId: string, code: number, reason: string): boolean {
    const l = this.live.get(deviceId)
    if (!l) return false
    this.disconnect(l.socket, deviceId)
    l.socket.close?.(code, reason)
    return true
  }

  /** The device a recipe for `surface` runs on: the most recently connected one. */
  deviceFor(surface: HostSurface): HostDevice | undefined {
    let best: HostDevice | undefined
    for (const d of this.devices()) {
      // 无界面设备不承接任何 surface 的 UI recipe；它只经执行位置绑定被点名使用。
      if (d.hello.platform === 'linux') continue
      if (surfaceOf(d.hello.platform) !== surface) continue
      if (!best || d.connectedAt > best.connectedAt) best = d
    }
    return best
  }

  /** 调度用的窄视图：在不在线、声明了哪些 op。 */
  isOnline(id: string): boolean {
    return this.live.has(id)
  }

  hasOp(id: string, op: string): boolean {
    return this.live.get(id)?.ops.has(op) ?? false
  }

  /** 一台在线且声明了 `http.fetch` 的设备的 HTTP 通道；否则 undefined。 */
  fetchRelay(id: string): DeviceFetchRelay | undefined {
    if (!this.hasOp(id, 'http.fetch')) return undefined
    return this.relays.get(id)
  }

  devices(): HostDevice[] {
    return [...this.live.values()].map((l) => ({
      hello: l.hello,
      relay: this.relays.get(l.hello.deviceId)!,
      ops: l.ops,
      connectedAt: l.connectedAt,
      ...(l.state ? { state: l.state } : {}),
    }))
  }

  /** Store a device's latest state. Returns the previous state so the caller can act on a
   *  transition. A device that is not live is ignored. */
  setState(deviceId: string, state: HostDeviceState): HostDeviceState | undefined {
    const l = this.live.get(deviceId)
    if (!l) return undefined
    const prev = l.state
    l.state = state
    return prev
  }

  // ── 上下线事件（openspec embeddable-device-gateway）───────────────────────────
  private readonly changeListeners: Array<(ch: HostChange) => void> = []

  /** 设备连上 / 断开时叫一声。**每次握手成功都发一条 online**（含顶掉旧连接的重连——挂起醒来后
   *  嵌入方要靠它当场把行拉回在线）；被顶掉的旧 socket 关闭是 no-op。心跳判死走 close → disconnect，
   *  自然发 offline。监听器抛错只记日志，不影响连接。 */
  onChange(fn: (ch: HostChange) => void): void {
    this.changeListeners.push(fn)
  }

  private emitChange(ch: HostChange): void {
    for (const fn of this.changeListeners) {
      try { fn(ch) } catch { /* 听众的问题不是中继的问题 */ }
    }
  }
}

/** HostRelayRegistry 的上下线事件载荷（at = 毫秒时间戳）。 */
export interface HostChange {
  deviceId: string
  name: string
  platform: string
  online: boolean
  at: number
}
