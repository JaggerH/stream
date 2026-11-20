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

export type HostPlatform = 'windows' | 'macos' | 'android' | 'ios' | 'linux'
/** What a recipe targets. A recipe asks for a surface, not for an OS: both phone platforms are the
 *  one `mobile` surface, and the device's own ops decide what actually runs there. */
export type HostSurface = 'desktop' | 'mobile'

export interface HostHello {
  deviceId: string
  platform: HostPlatform
  name: string
  agentVersion: string
  /** The ops this agent implements. The driver checks this before sending anything. */
  ops: string[]
  /**
   * 允许主实例经设备连接转发到这台设备**回环地址**的端口（openspec `device-loopback-forward`）。
   * 设备端自己的配置给出来的；缺省缺失 = 一台端口都不允许（fail closed）。agent 收到转发请求
   * 后还会再校验一次——这格里的是"声明"，不是"唯一防线"。
   */
  ports?: number[]
  /**
   * The capability manifest (openspec `device-capability-manifest`): what this device can do, by
   * capability id, so a consumer can adapt to a device class instead of probing ops one by one.
   * Absent = the agent predates the manifest (or declared a schema version this backend does not
   * know); only `ops` is known about it then. Present and empty = the device declares none.
   */
  caps?: DeviceCaps
  /** iOS only: the OS version the agent runs on (for example `18.2`). Device info, not dispatch. */
  iosVersion?: string
  /**
   * iOS only: how the agent reaches the device. Three values today — `native-accessibility`
   * (iOS 27+, the paired native services), `xctest-session` (iOS 18–26, an in-process XCTest
   * session) and `unsupported` (below 18, no ops declared). Kept as device info and never
   * interpreted here, so a value this backend has not seen yet is kept too.
   */
  path?: string
}

/** The caps schema versions this backend reads. A hello with another `capsVersion` still connects;
 *  its `caps` are ignored (an incompatible future shape must not be half-read, nor lock the device out). */
export const CAPS_SCHEMA_VERSION = 1

/** When a capability is usable. `always` (also what an absent value means): whenever the device is
 *  online. `foreground`: only while the device's agent app is in front. `push`: only by waking the
 *  device through a push channel. */
export type CapAvailability = 'always' | 'foreground' | 'push'
const AVAILABILITIES: ReadonlySet<string> = new Set(['always', 'foreground', 'push'])

/** One declared capability: `v` is the capability's own version (a positive integer). */
export interface DeviceCapability {
  v: number
  availability?: CapAvailability
}

/** Capability id → descriptor. The vocabulary is open (`ui.tree`, `ui.act`, `screen.shot`,
 *  `app.launch`, `app.in_use`, `input.text`, `notify.post`, `intent.run` today); an id this backend
 *  does not know is kept, so a consumer newer than the backend can read it. */
export type DeviceCaps = Record<string, DeviceCapability>

/** At most this many capabilities per hello; the vocabulary is a handful of ids. */
export const MAX_HELLO_CAPS = 64
// Dot-separated lowercase words; a segment may carry a hyphen (`ios.ax-native`,
// `ios.xctest-session`). Widening the grammar only ever keeps ids, never refuses a device.
const CAP_ID = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/

/**
 * `hello.caps` under `hello.capsVersion`, read leniently so an older backend never locks out a newer
 * device. Missing `caps` = undefined (an agent that predates the manifest). A `capsVersion` that is
 * not a known version (including a malformed one) = undefined: the manifest is ignored, the hello
 * stands. A container that is not an object = undefined as well. Inside a known version each entry
 * is judged on its own: a bad id, a `v` that is not a positive integer, an availability outside the
 * set, or an entry past [MAX_HELLO_CAPS] is dropped and named through [onDrop]; the rest are kept.
 * Unknown extra fields inside an entry are dropped too.
 */
function parseCaps(raw: unknown, version: unknown, onDrop: (why: string) => void): DeviceCaps | undefined {
  if (raw === undefined) return undefined
  // A manifest without a version is read as version 1: the field was introduced with it.
  if ((version ?? CAPS_SCHEMA_VERSION) !== CAPS_SCHEMA_VERSION) {
    onDrop(`capsVersion ${JSON.stringify(version)} is not one this backend reads; manifest ignored`)
    return undefined
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    onDrop('caps is not an object; manifest ignored')
    return undefined
  }
  const out: DeviceCaps = {}
  let kept = 0
  for (const [id, e] of Object.entries(raw as Record<string, unknown>)) {
    const drop = (why: string) => onDrop(`caps entry ${JSON.stringify(id.slice(0, 64))} dropped: ${why}`)
    if (kept >= MAX_HELLO_CAPS) { drop(`more than ${MAX_HELLO_CAPS} entries`); continue }
    if (id.length > 64 || !CAP_ID.test(id)) { drop('bad id'); continue }
    if (e === null || typeof e !== 'object' || Array.isArray(e)) { drop('not an object'); continue }
    const { v, availability } = e as Record<string, unknown>
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) { drop('v is not a positive integer'); continue }
    if (availability !== undefined && (typeof availability !== 'string' || !AVAILABILITIES.has(availability))) {
      drop(`unknown availability ${JSON.stringify(availability)}`)
      continue
    }
    out[id] = { v, ...(availability !== undefined ? { availability: availability as CapAvailability } : {}) }
    kept++
  }
  return out
}

/**
 * Device-side health facts (`device-app-in-use-health`): the phone reports what only it can see,
 * and judges none of it. `clockSkewMs` is the device clock minus the backend clock, measured
 * against the `{type:"time", serverTime}` frame the backend sends after an android `hello`
 * (positive = the device is ahead); absent until that frame arrived on this connection.
 * `networkOk` is the OS's validated-reachability verdict on the device's default network.
 */
export interface DeviceHealth {
  clockSkewMs?: number
  networkOk?: boolean
}

/** What a phone reports about itself: sent right after `hello`, every 30 s, and on every
 *  accessibility-service change. The backend only stores the latest one. */
export interface HostDeviceState {
  a11yEnabled: boolean
  screenOn: boolean
  keyguardLocked: boolean
  battery: number
  charging: boolean
  /** Optional device facts; an app that predates them sends no `health` at all. */
  health?: DeviceHealth
}

/** `null` for anything that is not a complete state frame. A partial frame is dropped, not
 *  merged: a missing `a11yEnabled` read as `false` would raise a false alarm. An optional `health`
 *  is either absent, an object with well-typed fields, or it sinks the whole frame the same way —
 *  a malformed `health: "fine"` silently read as "no health" would hide the app's defect. */
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
  let health: DeviceHealth | undefined
  if (m.health !== undefined) {
    const h = m.health
    if (h === null || typeof h !== 'object' || Array.isArray(h)) return null
    const { clockSkewMs, networkOk } = h as Record<string, unknown>
    if (clockSkewMs !== undefined && typeof clockSkewMs !== 'number') return null
    if (networkOk !== undefined && typeof networkOk !== 'boolean') return null
    health = {
      ...(clockSkewMs !== undefined ? { clockSkewMs } : {}),
      ...(networkOk !== undefined ? { networkOk } : {}),
    }
  }
  return { a11yEnabled, screenOn, keyguardLocked, battery, charging, ...(health !== undefined ? { health } : {}) }
}

export interface HostDevice {
  hello: HostHello
  relay: WsHostRelay
  ops: ReadonlySet<string>
  connectedAt: number
  state?: HostDeviceState
}

const PLATFORMS: ReadonlySet<string> = new Set(['windows', 'macos', 'android', 'ios', 'linux'])

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/**
 * `hello.iosVersion` / `hello.path`: short non-empty strings. They are device info, not dispatch,
 * so a value this backend cannot read is dropped on its own — the same leniency as `caps`; a
 * cosmetic field never refuses a device.
 */
function parseIosFacts(version: unknown, agentPath: unknown): Pick<HostHello, 'iosVersion' | 'path'> {
  const fact = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 && v.length <= 64 ? v : undefined)
  const iosVersion = fact(version)
  const path = fact(agentPath)
  return { ...(iosVersion !== undefined ? { iosVersion } : {}), ...(path !== undefined ? { path } : {}) }
}

/** 一台设备最多声明多少个可转发端口。配置文件是人写的，64 个足够任何合理用法。 */
export const MAX_HELLO_PORTS = 64

/** `hello.ports`：缺失 = undefined（fail closed）；数组 = 去重后的合法端口。任何一格不合法（非
 *  整数、越界、超量）都是 `null`——与 hello 的其他字段同一条规矩：畸形不默认、要被点名。 */
function parsePorts(v: unknown): number[] | null | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) return null
  if (v.length > MAX_HELLO_PORTS) return null
  const out: number[] = []
  for (const p of v) {
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) return null
    if (!out.includes(p)) out.push(p)
  }
  return out
}

/**
 * Parse the first frame of a connection. **Anything malformed is `null`, never a default**: a
 * `hello` with a missing `ops` turned into `[]` would make every op on that device fail as
 * "unsupported", and the agent's real defect (it sent a broken hello) would never be named.
 */
export function parseHello(raw: string, onCapsDrop: (why: string) => void = () => {}): HostHello | null {
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
  const ports = parsePorts(m.ports)
  if (ports === null) return null
  // Lenient by design (unlike ports): what a device can do is a declaration for consumers, and a
  // stricter older backend would otherwise refuse every newer device that extends it.
  const caps = parseCaps(m.caps, m.capsVersion, onCapsDrop)
  // The iOS facts are device info like `caps`, not dispatch: only an ios hello carries them.
  const ios = platform === 'ios' ? parseIosFacts(m.iosVersion, m.path) : {}
  return { deviceId, platform: platform as HostPlatform, name, agentVersion, ops: ops as string[], ...(ports ? { ports } : {}), ...(caps ? { caps } : {}), ...ios }
}

/** Both phone platforms are the one mobile surface: whichever phone is connected answers a phone
 *  recipe, and what it can do is decided by its ops, not by its OS. */
export function surfaceOf(p: HostPlatform): HostSurface {
  return p === 'android' || p === 'ios' ? 'mobile' : 'desktop'
}

interface Live {
  hello: HostHello
  socket: HostSocket
  ops: ReadonlySet<string>
  connectedAt: number
  state?: HostDeviceState
}

export type DeviceFetchRelay = Pick<WsHostRelay, 'fetchOp' | 'connected'>
/** 转发通道的窄视图（openspec `device-loopback-forward`）。 */
export type DeviceForwardRelay = Pick<WsHostRelay, 'forwardOp' | 'openForwardWs' | 'connected'>

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
    this.emitChange({
      deviceId: hello.deviceId, name: hello.name, platform: hello.platform, online: true, at: now, ops: hello.ops,
      ...(hello.caps ? { caps: hello.caps } : {}),
      ...(hello.iosVersion ? { iosVersion: hello.iosVersion } : {}),
      ...(hello.path ? { path: hello.path } : {}),
    })
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

  /** The device a recipe for `surface` runs on: the most recently connected one. `android` is the
   *  pre-`mobile` spelling of the same surface and stays accepted for callers written before iOS. */
  deviceFor(surface: HostSurface | 'android'): HostDevice | undefined {
    const want: HostSurface = surface === 'android' ? 'mobile' : surface
    let best: HostDevice | undefined
    for (const d of this.devices()) {
      // 无界面设备不承接任何 surface 的 UI recipe；它只经执行位置绑定被点名使用。
      if (d.hello.platform === 'linux') continue
      if (surfaceOf(d.hello.platform) !== want) continue
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

  /** 在线设备 `hello.ports` 的快照；离线 = undefined。缺了 `ports` 字段 = 空数组（同样一台都不许）。 */
  portsOf(id: string): readonly number[] | undefined {
    return this.live.get(id)?.hello.ports ?? []
  }

  /** 一台在线、声明了 `op`（`http.forward` / `ws.forward`）的设备的转发通道；否则 undefined。 */
  forwardRelay(id: string, op: 'http.forward' | 'ws.forward'): DeviceForwardRelay | undefined {
    if (!this.hasOp(id, op)) return undefined
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

/** HostRelayRegistry 的上下线事件载荷（at = 毫秒时间戳）。online 事件带当次 hello 声明的 op 集
 *  （重连换了 op 集合，事件就是最新事实）；offline 不带 ops——设备已断，没有「现在的 ops」。
 *  `caps` 同理：online 事件带当次 hello 的能力清单（没声明就没有这一格），offline 不带。 */
export interface HostChange {
  deviceId: string
  name: string
  platform: string
  online: boolean
  at: number
  ops?: string[]
  caps?: DeviceCaps
  /** The iOS facts of a phone's online hello (absent on other platforms and on offline changes). */
  iosVersion?: string
  path?: string
}
