/**
 * Every agent connected to `/api/host`, keyed by the device it declared in its `hello`.
 *
 * One `WsHostRelay` per device, **kept across reconnects**: a reconnect is the same device coming back,
 * so its session lease and abort epoch carry over, exactly as they did when there was only one relay.
 * "Latest connection wins" is therefore per device. A phone connecting never touches the PC's
 * connection, and two recipes on two devices do not wait for each other.
 */
import { WsHostRelay, type HostSocket } from './host-relay.ts'

export type HostPlatform = 'windows' | 'macos' | 'android'
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

export interface HostDevice {
  hello: HostHello
  relay: WsHostRelay
  ops: ReadonlySet<string>
  connectedAt: number
}

const PLATFORMS: ReadonlySet<string> = new Set(['windows', 'macos', 'android'])

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
}

export class HostRelayRegistry {
  private readonly relays = new Map<string, WsHostRelay>()
  private readonly live = new Map<string, Live>()

  constructor(private readonly relayOpts?: { timeoutMs?: number; sessionWaitMs?: number }) {}

  /** A device finished its handshake. Returns that device's relay. */
  connect(socket: HostSocket, hello: HostHello, now: number = Date.now()): WsHostRelay {
    let relay = this.relays.get(hello.deviceId)
    if (!relay) {
      relay = new WsHostRelay(this.relayOpts)
      this.relays.set(hello.deviceId, relay)
    }
    relay.connect(socket)
    this.live.set(hello.deviceId, { hello, socket, ops: new Set(hello.ops), connectedAt: now })
    return relay
  }

  /** A socket closed. A socket that was already replaced by a newer one changes nothing. */
  disconnect(socket: HostSocket, deviceId: string): void {
    this.relays.get(deviceId)?.disconnect(socket)
    if (this.live.get(deviceId)?.socket === socket) this.live.delete(deviceId)
  }

  /** Drop a device's live connection (revoked). Its pending ops fail as disconnected through the
   *  socket's close handler. */
  kick(deviceId: string, code: number, reason: string): boolean {
    const l = this.live.get(deviceId)
    if (!l) return false
    l.socket.close?.(code, reason)
    return true
  }

  /** The device a recipe for `surface` runs on: the most recently connected one. */
  deviceFor(surface: HostSurface): HostDevice | undefined {
    let best: HostDevice | undefined
    for (const d of this.devices()) {
      if (surfaceOf(d.hello.platform) !== surface) continue
      if (!best || d.connectedAt > best.connectedAt) best = d
    }
    return best
  }

  devices(): HostDevice[] {
    return [...this.live.values()].map((l) => ({
      hello: l.hello,
      relay: this.relays.get(l.hello.deviceId)!,
      ops: l.ops,
      connectedAt: l.connectedAt,
    }))
  }
}
