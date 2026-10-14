# Host Relay v2 (multi-device) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/api/host` accepts several agents at once. Each agent opens with a `hello` that names the
device and declares its op set, and the backend keeps one relay per device.

**Architecture:** A new `HostRelayRegistry` owns one `WsHostRelay` per `deviceId`. The relay itself
(per-op pairing, session lease, abort) is unchanged. `attachHostRelay` speaks `host-relay.v2`: it
refuses v1, requires `hello` as the first frame, then routes frames to that device's relay.
`makeDesktopDriver` takes the device's declared op set and decides "not supported" before sending.
Stream Desktop (Rust) sends `hello` right after connecting.

**Tech Stack:** TypeScript (Node, `ws`, vitest), Rust (tokio-tungstenite, serde_json, sysinfo).

**Spec:** `openspec/changes/android-phone-surface/design.md` §D2 (this plan) — D1/D3–D7 are later plans.

## Global Constraints

- Protocol name is exactly `host-relay.v2`. No v1 compatibility. A v1 offer gets HTTP 426 with the body
  `Stream Desktop is too old — update it (this backend speaks host-relay.v2)`.
- The `hello` frame is `{type:'hello', deviceId, platform:'windows'|'macos'|'android', name, agentVersion, ops: string[]}`.
- `windows` and `macos` map to surface `desktop`. `android` maps to surface `android`.
- Per-device semantics stay as today: latest connection wins *per deviceId*, one session lease per device.
- Run tests in the worktree with absolute paths:
  `scripts/qrun.sh node_modules/.bin/vitest run --root <worktree> <path>` and
  `scripts/qrun.sh cargo test --manifest-path <worktree>/app/host-agent/Cargo.toml`.
- Never `pnpm install` in the worktree. Link `node_modules` from the main checkout (AGENTS.md).
- Live backend `127.0.0.1:8900` carries real-money tasks. Do not restart it on weekdays 09:40–09:50 or
  14:50–15:05.

---

### Task 1: `hello` parsing and the device registry

**Files:**
- Create: `src/http/host-registry.ts`
- Test: `src/http/host-registry.test.ts`

**Interfaces:**
- Consumes: `WsHostRelay`, `HostSocket` from `src/http/host-relay.ts` (unchanged).
- Produces:
  - `type HostPlatform = 'windows' | 'macos' | 'android'`
  - `type HostSurface = 'desktop' | 'android'`
  - `interface HostHello { deviceId: string; platform: HostPlatform; name: string; agentVersion: string; ops: string[] }`
  - `function parseHello(raw: string): HostHello | null`
  - `function surfaceOf(p: HostPlatform): HostSurface`
  - `interface HostDevice { hello: HostHello; relay: WsHostRelay; ops: ReadonlySet<string>; connectedAt: number }`
  - `class HostRelayRegistry { connect(socket, hello, now?): WsHostRelay; disconnect(socket, deviceId): void; deviceFor(surface): HostDevice | undefined; devices(): HostDevice[] }`

- [ ] **Step 1: Write the failing tests**

```ts
// src/http/host-registry.test.ts
import { describe, it, expect } from 'vitest'
import { HostRelayRegistry, parseHello, surfaceOf, type HostHello } from './host-registry.ts'
import { HostRelayDisconnected, type HostSocket } from './host-relay.ts'

function fakeSocket() {
  const sent: string[] = []
  const socket: HostSocket = { send: (d) => void sent.push(d) }
  return { socket, sent }
}
const hello = (over: Partial<HostHello> = {}): HostHello => ({
  deviceId: 'desktop:pc', platform: 'windows', name: 'PC', agentVersion: '0.1.0', ops: ['click', 'find'], ...over,
})

describe('parseHello', () => {
  it('accepts a well-formed hello frame', () => {
    expect(parseHello(JSON.stringify({ type: 'hello', ...hello() }))).toEqual(hello())
  })
  it('rejects anything that is not a hello — a missing field must not become a default', () => {
    expect(parseHello('not json')).toBeNull()
    expect(parseHello(JSON.stringify({ id: 1, result: {} }))).toBeNull()
    expect(parseHello(JSON.stringify({ type: 'hello', ...hello(), platform: 'linux' }))).toBeNull()
    expect(parseHello(JSON.stringify({ type: 'hello', ...hello(), deviceId: '' }))).toBeNull()
    expect(parseHello(JSON.stringify({ type: 'hello', ...hello(), ops: 'click' }))).toBeNull()
    expect(parseHello(JSON.stringify({ type: 'hello', ...hello(), ops: ['click', 3] }))).toBeNull()
  })
})

describe('surfaceOf', () => {
  it('windows and macos are the desktop surface; android is its own', () => {
    expect(surfaceOf('windows')).toBe('desktop')
    expect(surfaceOf('macos')).toBe('desktop')
    expect(surfaceOf('android')).toBe('android')
  })
})

describe('HostRelayRegistry', () => {
  it('a phone connecting does not knock the PC off — each device keeps its own relay', async () => {
    const reg = new HostRelayRegistry()
    const pc = fakeSocket()
    const phone = fakeSocket()
    const pcRelay = reg.connect(pc.socket, hello())
    reg.connect(phone.socket, hello({ deviceId: 'android:k80', platform: 'android', name: 'K80', ops: ['click'] }))
    const p = pcRelay.send({ op: 'find' })
    expect(pc.sent).toHaveLength(1)
    expect(phone.sent).toHaveLength(0)
    pcRelay.handleMessage(JSON.stringify({ id: 1, result: [] }))
    await expect(p).resolves.toEqual([])
    expect(reg.deviceFor('desktop')?.hello.deviceId).toBe('desktop:pc')
    expect(reg.deviceFor('android')?.hello.deviceId).toBe('android:k80')
  })

  it('latest connection wins per device, and the relay (with its lease state) is reused', async () => {
    const reg = new HostRelayRegistry()
    const a = fakeSocket()
    const b = fakeSocket()
    const r1 = reg.connect(a.socket, hello())
    const pending = r1.send({ op: 'find' })
    const r2 = reg.connect(b.socket, hello())
    expect(r2).toBe(r1)
    await expect(pending).rejects.toBeInstanceOf(HostRelayDisconnected)
    expect(reg.devices()).toHaveLength(1)
  })

  it('a stale socket closing does not drop the device that replaced it', () => {
    const reg = new HostRelayRegistry()
    const a = fakeSocket()
    const b = fakeSocket()
    reg.connect(a.socket, hello())
    reg.connect(b.socket, hello())
    reg.disconnect(a.socket, 'desktop:pc')
    expect(reg.deviceFor('desktop')).toBeDefined()
    reg.disconnect(b.socket, 'desktop:pc')
    expect(reg.deviceFor('desktop')).toBeUndefined()
  })

  it('deviceFor picks the most recently connected device of that surface', () => {
    const reg = new HostRelayRegistry()
    reg.connect(fakeSocket().socket, hello({ deviceId: 'desktop:a' }), 1)
    reg.connect(fakeSocket().socket, hello({ deviceId: 'desktop:b' }), 2)
    expect(reg.deviceFor('desktop')?.hello.deviceId).toBe('desktop:b')
  })

  it('exposes the declared ops as a set', () => {
    const reg = new HostRelayRegistry()
    reg.connect(fakeSocket().socket, hello({ ops: ['click'] }))
    const d = reg.deviceFor('desktop')!
    expect(d.ops.has('click')).toBe(true)
    expect(d.ops.has('readText')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `scripts/qrun.sh node_modules/.bin/vitest run --root <worktree> src/http/host-registry.test.ts`
Expected: FAIL, `Cannot find module './host-registry.ts'`.

- [ ] **Step 3: Implement the registry**

```ts
// src/http/host-registry.ts
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `scripts/qrun.sh node_modules/.bin/vitest run --root <worktree> src/http/host-registry.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/http/host-registry.ts src/http/host-registry.test.ts
git -C <worktree> commit -m "feat(host-relay): add a per-device relay registry keyed by the agent's hello"
```

---

### Task 2: `attachHostRelay` speaks `host-relay.v2`

**Files:**
- Modify: `src/http/host-relay.ts` (the `HOST_RELAY_PROTOCOL` constant and `attachHostRelay`, lines 16–17 and 410–457)
- Test: `src/http/host-relay.attach.test.ts` (new)

**Interfaces:**
- Consumes: `HostRelayRegistry`, `parseHello` (Task 1).
- Produces: `attachHostRelay(server: Server, registry: HostRelayRegistry, opts: { token: string; path?: string; log?: (line: string) => void; helloTimeoutMs?: number }): WebSocketServer`.
  `HOST_RELAY_PROTOCOL === 'host-relay.v2'`. `STALE_HOST_PROTOCOL === 'host-relay.v1'` (exported for the test).

- [ ] **Step 1: Write the failing tests**

```ts
// src/http/host-relay.attach.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { attachHostRelay, HOST_RELAY_PROTOCOL, STALE_HOST_PROTOCOL } from './host-relay.ts'
import { HostRelayRegistry } from './host-registry.ts'

const TOKEN = 'secret-token'
const helloFrame = { type: 'hello', deviceId: 'desktop:pc', platform: 'windows', name: 'PC', agentVersion: '0.1.0', ops: ['find'] }

let server: Server
afterEach(() => new Promise<void>((r) => server.close(() => r())))

async function start(helloTimeoutMs = 2000) {
  server = createServer()
  const registry = new HostRelayRegistry()
  attachHostRelay(server, registry, { token: TOKEN, log: () => {}, helloTimeoutMs })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/host`
  return { registry, url }
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10))
}

describe('attachHostRelay (v2)', () => {
  it('protocol name is host-relay.v2', () => {
    expect(HOST_RELAY_PROTOCOL).toBe('host-relay.v2')
  })

  it('a v1 agent is refused with 426 and a message that names the fix', async () => {
    const { url } = await start()
    const ws = new WebSocket(url, [STALE_HOST_PROTOCOL, TOKEN])
    const res = await new Promise<{ status: number; body: string }>((resolve) => {
      ws.on('unexpected-response', (_req, r) => {
        let body = ''
        r.on('data', (c) => (body += c))
        r.on('end', () => resolve({ status: r.statusCode ?? 0, body }))
      })
    })
    expect(res.status).toBe(426)
    expect(res.body).toMatch(/Stream Desktop is too old/)
  })

  it('a device is registered only after its hello, and ops then reach it', async () => {
    const { registry, url } = await start()
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, TOKEN])
    await new Promise((r) => ws.on('open', r))
    expect(registry.devices()).toHaveLength(0)
    ws.send(JSON.stringify(helloFrame))
    await until(() => registry.devices().length === 1)
    const dev = registry.deviceFor('desktop')!
    const got = new Promise<string>((r) => ws.once('message', (d) => r(d.toString())))
    const p = dev.relay.send({ op: 'find' })
    const frame = JSON.parse(await got)
    expect(frame.op).toBe('find')
    ws.send(JSON.stringify({ id: frame.id, result: ['ok'] }))
    await expect(p).resolves.toEqual(['ok'])
    ws.close()
    await until(() => registry.devices().length === 0)
    expect(registry.devices()).toHaveLength(0)
  })

  it('a first frame that is not a hello closes the connection with 4001', async () => {
    const { registry, url } = await start()
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, TOKEN])
    await new Promise((r) => ws.on('open', r))
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    ws.send(JSON.stringify({ id: 1, result: {} }))
    expect(await closed).toBe(4001)
    expect(registry.devices()).toHaveLength(0)
  })

  it('silence instead of a hello closes the connection with 4001 after the timeout', async () => {
    const { url } = await start(50)
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, TOKEN])
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    expect(await closed).toBe(4001)
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `scripts/qrun.sh node_modules/.bin/vitest run --root <worktree> src/http/host-relay.attach.test.ts`
Expected: FAIL. `STALE_HOST_PROTOCOL` is not exported, and the protocol is still `host-relay.v1`.

- [ ] **Step 3: Implement**

In `src/http/host-relay.ts`, replace the protocol constant (lines 16–17):

```ts
/** WS subprotocol name. Client offers [HOST_RELAY_PROTOCOL, token]; server echoes only the name. */
export const HOST_RELAY_PROTOCOL = 'host-relay.v2'
/** The previous protocol. It is refused with a message naming the fix, never accepted. */
export const STALE_HOST_PROTOCOL = 'host-relay.v1'
```

Add the import at the top:

```ts
import { parseHello, type HostRelayRegistry } from './host-registry.ts'
```

Replace `attachHostRelay` (from its doc comment to the end of the file) with:

```ts
/**
 * Mount the `/api/host` WS endpoint and feed a {@link HostRelayRegistry}.
 *
 * Handshake order: (1) a `host-relay.v1` offer gets **426** with a message that names the fix. A
 * stale agent must not look like a token problem or like a backend that is down. (2) Then
 * `verifyHostUpgrade` checks the origin and the token. (3) After the upgrade, the **first frame must
 * be a `hello`** within `helloTimeoutMs`. Anything else closes with 4001. Only then is the device
 * registered and frames routed to its relay. A ~20s WS ping keeps the connection warm.
 */
export function attachHostRelay(
  server: Server,
  registry: HostRelayRegistry,
  opts: { token: string; path?: string; log?: (line: string) => void; helloTimeoutMs?: number },
): WebSocketServer {
  const { token, path = '/api/host', log = console.log, helloTimeoutMs = 5_000 } = opts
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols: Set<string>) =>
      protocols.has(HOST_RELAY_PROTOCOL) ? HOST_RELAY_PROTOCOL : false,
  })
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '', 'http://localhost').pathname
    if (pathname !== path) return // not our path: leave for other WSS upgrade listeners
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim())
    if (offered.includes(STALE_HOST_PROTOCOL) && !offered.includes(HOST_RELAY_PROTOCOL)) {
      const body = `Stream Desktop is too old — update it (this backend speaks ${HOST_RELAY_PROTOCOL})`
      log(`[host-relay] refused a ${STALE_HOST_PROTOCOL} agent — ${body}`)
      socket.write(
        `HTTP/1.1 426 Upgrade Required\r\nContent-Type: text/plain; charset=utf-8\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      )
      socket.destroy()
      return
    }
    const ok = verifyHostUpgrade(
      { origin: req.headers.origin, protocolHeader: req.headers['sec-websocket-protocol'] },
      token,
    )
    if (!ok) {
      log(`[host-relay] rejected upgrade (origin=${req.headers.origin ?? '<none>'})`)
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  wss.on('connection', (socket) => {
    let deviceId: string | null = null
    const helloTimer = setTimeout(() => {
      if (deviceId === null) socket.close(4001, 'expected hello')
    }, helloTimeoutMs)
    helloTimer.unref?.()
    const ping = setInterval(() => {
      try {
        socket.ping()
      } catch {
        /* ping throws once the socket closes; the close handler cleans up */
      }
    }, 20_000)
    socket.on('message', (data) => {
      const raw = data.toString()
      if (deviceId !== null) {
        registry.devices().find((d) => d.hello.deviceId === deviceId)?.relay.handleMessage(raw)
        return
      }
      const hello = parseHello(raw)
      if (!hello) {
        log('[host-relay] first frame was not a hello — closing')
        socket.close(4001, 'expected hello')
        return
      }
      clearTimeout(helloTimer)
      deviceId = hello.deviceId
      registry.connect(socket, hello)
      log(`[host-relay] device connected ${hello.deviceId} (${hello.platform}, ${hello.name}, v${hello.agentVersion}, ${hello.ops.length} ops)`)
    })
    const teardown = () => {
      clearTimeout(helloTimer)
      clearInterval(ping)
      if (deviceId !== null) registry.disconnect(socket, deviceId)
    }
    socket.on('close', teardown)
    socket.on('error', teardown)
  })
  return wss
}
```

Frames go to the relay that is live for this socket's `deviceId`. A newer socket of the same device
replaces it in the registry, and the old socket's late replies go to the same relay. The relay drops
ids it no longer knows, which is today's behavior.

- [ ] **Step 4: Run both relay test files**

Run: `scripts/qrun.sh node_modules/.bin/vitest run --root <worktree> src/http/host-relay.attach.test.ts src/http/host-relay.test.ts src/http/host-registry.test.ts`
Expected: PASS. In `host-relay.test.ts`, the `verifyHostUpgrade` test that compares against
`HOST_RELAY_PROTOCOL` still passes because it uses the constant, not a literal. If any test hard-codes
`'host-relay.v1'`, change it to `HOST_RELAY_PROTOCOL`.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/http/host-relay.ts src/http/host-relay.attach.test.ts src/http/host-relay.test.ts
git -C <worktree> commit -m "feat(host-relay): speak host-relay.v2 with a mandatory hello; refuse v1 agents by name"
```

---

### Task 3: The driver checks declared ops before sending

**Files:**
- Modify: `src/replay/desktop-driver.ts` (`isUnsupportedOp` at 366–369 and `makeDesktopDriver` at 376–539)
- Test: `src/replay/desktop-driver.test.ts` (replace the test at line 235, add three tests)

**Interfaces:**
- Produces:
  - `export const DESKTOP_OPS: ReadonlySet<string>`: the full Stream Desktop op set (same names as `OP_NAMES` in `app/host-agent/src/protocol.rs`).
  - `export class UnsupportedOpError extends Error { readonly op: string }`
  - `makeDesktopDriver(raw: HostRelay, ops: ReadonlySet<string> = DESKTOP_OPS): DesktopDriver`

- [ ] **Step 1: Write the failing tests**

Replace the test `'老 agent 回 unsupported 错 → 两个读屏 op 都回 null，不抛'` (line 235–239) with:

```ts
  it('an op the device did not declare: read ops return null without sending anything', async () => {
    const { r, sent } = relay({})
    const d = makeDesktopDriver(r, new Set(['click']))
    expect(await d.readText()).toBeNull()
    expect(await d.readElements()).toBeNull()
    expect(await d.findImage(Buffer.from('png'))).toBeNull()
    expect(await d.nudge()).toBe(false)
    await d.status('x')
    expect(sent).toEqual([])
  })
  it('an action op the device did not declare fails fast as UnsupportedOpError', async () => {
    const { r, sent } = relay({})
    const d = makeDesktopDriver(r, new Set(['find']))
    await expect(d.click({ x: 0, y: 0, w: 1, h: 1 })).rejects.toBeInstanceOf(UnsupportedOpError)
    await expect(d.click({ x: 0, y: 0, w: 1, h: 1 })).rejects.toThrow(/unsupported-op: click/)
    expect(sent).toEqual([])
  })
  it('a declared op that fails on the agent is not swallowed as "unsupported"', async () => {
    const r: HostRelay = { async send() { throw new Error('unknown op: readText') } }
    await expect(makeDesktopDriver(r).readText()).rejects.toThrow(/unknown op/)
  })
  it('with no op set given, the full Stream Desktop set is assumed', () => {
    expect(DESKTOP_OPS.has('readText')).toBe(true)
    expect(DESKTOP_OPS.size).toBe(22)
  })
```

Add `UnsupportedOpError` and `DESKTOP_OPS` to the file's import from `./desktop-driver.ts`. The `relay(...)`
helper already exists in this file; it returns `{ r, sent }` and records `{op, args}` per send.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `scripts/qrun.sh node_modules/.bin/vitest run --root <worktree> src/replay/desktop-driver.test.ts`
Expected: FAIL. `UnsupportedOpError` and `DESKTOP_OPS` are not exported.

- [ ] **Step 3: Implement**

Replace `isUnsupportedOp` (lines 366–369) with:

```ts
/**
 * Every op Stream Desktop implements. **Same list as `OP_NAMES` in `app/host-agent/src/protocol.rs`**;
 * an agent declares its own subset in `hello.ops`, and this is the default for callers that build a
 * driver without a device (tests, and any path that has not been given one).
 */
export const DESKTOP_OPS: ReadonlySet<string> = new Set([
  'windows', 'scopeWindow', 'focusApp', 'ensureApp', 'find', 'invoke', 'setValue',
  'click', 'moveMouse', 'scroll', 'type', 'press', 'readSubtree', 'screenshot', 'findImage',
  'readText', 'readElements', 'url', 'sleep', 'nudge', 'status', 'clearInput',
])

/** The device did not declare this op. Raised before anything is sent. */
export class UnsupportedOpError extends Error {
  constructor(readonly op: string) {
    super(`unsupported-op: ${op} is not declared by this device`)
    this.name = 'UnsupportedOpError'
  }
}
```

In `makeDesktopDriver`, change the signature and put a guard in front of the traced relay:

```ts
export function makeDesktopDriver(raw: HostRelay, ops: ReadonlySet<string> = DESKTOP_OPS): DesktopDriver {
```

Right after the existing `const relay: HostRelay = process.env.STREAM_DESKTOP_SEE_TRACE ? … : raw`
block, rename that binding to `traced` and add:

```ts
  /** Undeclared ops never reach the wire. A capability the device lacks is decided here, from what
   *  it said it can do, not by sending the op and pattern-matching the error that comes back. */
  const relay: HostRelay = {
    send(op) {
      return ops.has(op.op) ? traced.send(op) : Promise.reject(new UnsupportedOpError(op.op))
    },
    ...(traced.withSession ? { withSession: traced.withSession.bind(traced) } : {}),
  }
```

Replace the five fallback bodies. Each one now asks the op set first and has no `try/catch`:

```ts
    async nudge() {
      // Not declared = this agent has no way to wake the renderer without moving the pointer; the
      // caller falls back to `moveMouse`. A declared nudge that fails (e.g. `nudge-refused` on a
      // locked screen) throws — "could not wake it" must not read as "woke it".
      if (!ops.has('nudge')) return false
      await relay.send({ op: 'nudge' })
      return true
    },
    async status(text) {
      // A missing status line must not fail the step.
      if (!ops.has('status')) return
      await relay.send({ op: 'status', args: { text } })
    },
```

```ts
    async readText(region) {
      if (!ops.has('readText')) return null
      const r = (await relay.send({ op: 'readText', args: { ...(region ? { region } : {}) } })) as TextRead | undefined
      return r && r.window ? { texts: r.texts ?? [], window: r.window, scale: r.scale ?? 1 } : null
    },
    async readElements(opts) {
      if (!ops.has('readElements')) return null
      const args = {
        ...(opts?.region ? { region: opts.region } : {}),
        icons: opts?.icons === true,
        // runner 恒给这一格（`recipe.app.a11y ?? true`，见 desktop-runner.ts）；直接调 driver
        // 的调用方（不经 runner）不给时，就让 agent 按它自己的缺省（true）走。
        ...(opts?.a11y !== undefined ? { a11y: opts.a11y } : {}),
      }
      const r = (await relay.send({ op: 'readElements', args })) as ElementsRead | undefined
      if (!r?.window) return null
      return {
        // **空名当作没名字**：见 `SeeElement.name`。
        elements: (r.elements ?? []).map((e) => ({ rect: e.rect, kind: e.kind, ...(e.name ? { name: e.name } : {}) })),
        window: r.window,
        scale: r.scale ?? 1,
      }
    },
    async findImage(templatePng, region) {
      if (!ops.has('findImage')) return null
      const r = (await relay.send({ op: 'findImage', args: { template: templatePng.toString('base64'), ...(region ? { region } : {}) } })) as Partial<ImageHit> | undefined
      return r?.rect && typeof r.score === 'number' ? { rect: r.rect, score: r.score } : null
    },
```

Then search the file for any remaining `isUnsupportedOp` reference. There must be none:
`grep -n isUnsupportedOp <worktree>/src` → no output.

- [ ] **Step 4: Run the driver, runner and router tests**

Run: `scripts/qrun.sh node_modules/.bin/vitest run --root <worktree> src/replay/desktop-driver.test.ts src/replay/desktop-runner.test.ts src/mcp/cdp-router.test.ts src/replay/desktop-see.test.ts`
Expected: PASS. If a test relied on a thrown `unknown op` being turned into `null`/`false`, it was
testing the removed v1 fallback. Rewrite it to build the driver with an op set that omits that op.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/replay/desktop-driver.ts src/replay/desktop-driver.test.ts
git -C <worktree> commit -m "refactor(desktop-driver): decide unsupported ops from the device's declared set, not from errors"
```

---

### Task 4: Wire the registry into harvest and serve

**Files:**
- Modify: `src/kernel/plugins/harvest.ts` (field `hostRelay` at line 50, construction at 198–201, `ensureHarvestBrowser` at 480–523, provide at 555)
- Modify: `src/serve.ts:1059`
- Test: `src/kernel/plugins/harvest.test.ts` (lines 55, 138–147, 176–200)

**Interfaces:**
- Consumes: `HostRelayRegistry` (Task 1), `attachHostRelay(server, registry, …)` (Task 2), `makeDesktopDriver(relay, ops)` (Task 3).
- Produces: the harvest service exposes `hostRelays: HostRelayRegistry` in place of `hostRelay`. `desktopDriver()` keeps its signature `() => DesktopDriver | undefined`.

- [ ] **Step 1: Update the tests first**

In `harvest.test.ts`, change the provided-keys list (line 55) from `'hostRelay'` to `'hostRelays'`.

Replace the test at lines 138–147 with:

```ts
  // 接缝 4：desktopDriver 每次现判注册表里有没有桌面设备，不是启动那一刻的快照。
  it('desktopDriver 每次现判是否有桌面设备在线', async () => {
    const { kernel } = await mount()
    const h = kernel.harvest
    expect(h.desktopDriver()).toBeUndefined()
    h.hostRelays.connect({ send: () => {} }, {
      deviceId: 'desktop:pc', platform: 'windows', name: 'PC', agentVersion: '0.1.0', ops: ['ensureApp'],
    })
    expect(h.desktopDriver()).toBeDefined()
    await quiesceKernel(kernel)
  })
```

In the test `'ensureApp 用短等待上界（20s），不是默认的 180s'`, replace the two lines that touch
`h.hostRelay` (the `withSession` override and the `connected` defineProperty) with:

```ts
    const relay = h.hostRelays.connect({ send: () => {} }, {
      deviceId: 'desktop:pc', platform: 'windows', name: 'PC', agentVersion: '0.1.0', ops: ['ensureApp'],
    })
    relay.withSession = vi.fn(async (fn, opts) => {
      capturedWaitMs.push(opts?.waitMs ?? 180_000)
      return fn()
    }) as typeof relay.withSession
```

Delete the now-unused line `Object.defineProperty(h.hostRelay, 'connected', …)`.

- [ ] **Step 2: Run and confirm they fail**

Run: `scripts/qrun.sh node_modules/.bin/vitest run --root <worktree> src/kernel/plugins/harvest.test.ts`
Expected: FAIL. `h.hostRelays` is undefined.

- [ ] **Step 3: Implement**

`src/kernel/plugins/harvest.ts`:

```ts
// import: replace `WsHostRelay` with the registry
import { HostRelayRegistry } from '../../http/host-registry.ts'
```

Line 50 (service type): `hostRelays: HostRelayRegistry`

Lines 198–201:

```ts
    // host-desktop Engine 中继：每台设备一条（`hello` 报身份），serve.ts 用 attachHostRelay 把
    // /api/host 挂到 http server。没有桌面设备在线时 desktopDriver 返 undefined → kind:'desktop'
    // source 以 miss 落档（不抛）：前置条件不在就是 miss，不是故障。
    const hostRelays = new HostRelayRegistry({ sessionWaitMs: config.hostSessionWaitMs })
    // 原生窗口驱动的**唯一构造点**：adapter（kind:'desktop' source）与 cdp_* 的 desktop/app 两档
    // 共用它。两处各建一份会让"有没有桌面设备"出现两个答案。
    const desktopDriver = () => {
      const dev = hostRelays.deviceFor('desktop')
      return dev ? makeDesktopDriver(dev.relay, dev.ops) : undefined
    }
```

In `ensureHarvestBrowser`, replace `if (hostRelay.connected) {` and `const driver = makeDesktopDriver(hostRelay)` with:

```ts
      const dev = hostRelays.deviceFor('desktop')
      if (dev) {
        const driver = makeDesktopDriver(dev.relay, dev.ops)
```

and replace both `hostRelay.withSession(` with `dev.relay.withSession(`.

In `ctx.provide('harvest', { … })`, replace `hostRelay,` with `hostRelays,`.

`src/serve.ts:1059`:

```ts
    const wss = attachHostRelay(server as unknown as Server, harvest.hostRelays, { token: extToken })
```

- [ ] **Step 4: Typecheck and run the affected tests**

Run: `pnpm_config_verify_deps_before_run=false pnpm --dir <worktree> typecheck`
Expected: no errors. If the compiler names another `hostRelay` consumer, switch it to
`hostRelays.deviceFor('desktop')` in the same way.

Run: `scripts/qrun.sh node_modules/.bin/vitest run --root <worktree> src/kernel/plugins/harvest.test.ts src/mcp src/http`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/kernel/plugins/harvest.ts src/kernel/plugins/harvest.test.ts src/serve.ts
git -C <worktree> commit -m "feat(harvest): resolve the desktop driver from the per-device host registry"
```

---

### Task 5: Stream Desktop sends `hello` on `host-relay.v2`

**Files:**
- Modify: `app/host-agent/src/main.rs` (`PROTOCOL` at line 48; `run_session` after the `connected` log, ~line 547)
- Modify: `app/host-agent/src/relay.rs` (add `hello_frame` and its test)

**Interfaces:**
- Consumes: `protocol::OP_NAMES`.
- Produces: `pub fn hello_frame(device_id: &str, platform: &str, name: &str, version: &str, ops: &[&str]) -> serde_json::Value` and `pub fn local_hello() -> serde_json::Value` in `relay.rs`.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `app/host-agent/src/relay.rs`:

```rust
    /// The hello is the backend's only source for "which device is this and what can it do". Field
    /// names cross a process boundary with no compiler checking them, so they are pinned here.
    #[test]
    fn hello_frame_has_the_wire_shape_the_backend_parses() {
        let v = hello_frame("desktop:pc", "windows", "PC", "0.1.0", &["click", "find"]);
        assert_eq!(v["type"], "hello");
        assert_eq!(v["deviceId"], "desktop:pc");
        assert_eq!(v["platform"], "windows");
        assert_eq!(v["name"], "PC");
        assert_eq!(v["agentVersion"], "0.1.0");
        assert_eq!(v["ops"], serde_json::json!(["click", "find"]));
    }

    /// The local hello declares every op this binary dispatches, under a stable device id.
    #[test]
    fn local_hello_declares_all_ops_and_a_desktop_id() {
        let v = local_hello();
        assert_eq!(v["ops"].as_array().unwrap().len(), crate::protocol::OP_NAMES.len());
        assert!(v["deviceId"].as_str().unwrap().starts_with("desktop:"));
        assert!(matches!(v["platform"].as_str().unwrap(), "windows" | "macos"));
    }
```

Append to the `tests` module in `app/host-agent/src/main.rs`:

```rust
    /// The first frame on a fresh connection must be the hello — the v2 relay closes the socket
    /// with 4001 on anything else.
    #[tokio::test]
    async fn the_first_frame_after_connecting_is_the_hello() {
        use futures_util::StreamExt;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let echo = |_r: &Request, mut resp: Response| {
                resp.headers_mut().insert(SEC_WEBSOCKET_PROTOCOL, PROTOCOL.parse().unwrap());
                Ok(resp)
            };
            let mut ws = tokio_tungstenite::accept_hdr_async(stream, echo).await.unwrap();
            let first = ws.next().await.unwrap().unwrap();
            serde_json::from_str::<Value>(first.to_text().unwrap()).unwrap()
        });
        let url = format!("ws://{addr}/api/host");
        let mut backend = Backend::default();
        let first = tokio::select! {
            _ = run_session(&url, "token", &mut backend, None) => panic!("session ended before the server read a frame"),
            v = server => v.unwrap(),
        };
        assert_eq!(first["type"], "hello");
        assert_eq!(PROTOCOL, "host-relay.v2");
    }
```

- [ ] **Step 2: Run and confirm they fail**

Run: `scripts/qrun.sh cargo test --manifest-path <worktree>/app/host-agent/Cargo.toml hello`
Expected: FAIL (compile error: `hello_frame` / `local_hello` not found).

- [ ] **Step 3: Implement**

In `relay.rs`, above `#[cfg(test)]`:

```rust
/// The `hello` the v2 relay requires as the first frame: which device this is and which ops it
/// implements. The backend decides "unsupported" from `ops` before sending anything, so this list
/// must be what `dispatch` actually handles.
pub fn hello_frame(device_id: &str, platform: &str, name: &str, version: &str, ops: &[&str]) -> serde_json::Value {
    serde_json::json!({
        "type": "hello",
        "deviceId": device_id,
        "platform": platform,
        "name": name,
        "agentVersion": version,
        "ops": ops,
    })
}

/// This machine's hello. The device id is the host name, so it is stable across agent restarts and
/// a reconnect is recognised as the same device (its session lease carries over).
pub fn local_hello() -> serde_json::Value {
    let host = sysinfo::System::host_name().unwrap_or_else(|| "unknown".to_string());
    let platform = match std::env::consts::OS {
        "macos" => "macos",
        _ => "windows",
    };
    hello_frame(
        &format!("desktop:{}", host.to_lowercase()),
        platform,
        &host,
        env!("CARGO_PKG_VERSION"),
        crate::protocol::OP_NAMES,
    )
}
```

In `main.rs`, line 48:

```rust
const PROTOCOL: &str = "host-relay.v2";
```

Update the comment at line ~530 to say `[host-relay.v2, <token>]`.

In `run_session`, right after `let (mut tx, mut rx) = ws.split();`:

```rust
    // v2: the relay registers this device only after a hello, and closes with 4001 on anything else.
    if tx.send(Message::Text(relay::local_hello().to_string())).await.is_err() {
        return SessionEnd::Disconnected;
    }
```

(`relay` is the module name already used for `Supervisor` and `SessionEnd`. If it is imported as
items rather than as a module, call `crate::relay::local_hello()`.)

- [ ] **Step 4: Run the full agent test suite and the Windows cross-check**

Run: `scripts/qrun.sh cargo test --manifest-path <worktree>/app/host-agent/Cargo.toml`
Expected: PASS, including the three existing reconnect tests.

Run: `scripts/qrun.sh cargo check --manifest-path <worktree>/app/host-agent/Cargo.toml --target x86_64-pc-windows-gnu`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add app/host-agent/src/main.rs app/host-agent/src/relay.rs
git -C <worktree> commit -m "feat(stream-desktop): open host-relay.v2 sessions with a hello that declares the op set"
```

---

### Task 6: Spec delta, cookbook, and live swap

**Files:**
- Create: `openspec/changes/android-phone-surface/specs/desktop-recipe-replay/spec.md`
- Modify: whichever of `docs/ARCHITECTURE.md` / `docs/ENGINE.md` / `app/host-agent/README.md` describe `/api/host` as a single connection or as `host-relay.v1`

- [ ] **Step 1: Write the spec delta**

```markdown
## ADDED Requirements

### Requirement: Multi-device host relay

The `/api/host` relay SHALL speak `host-relay.v2`. The first frame of every connection SHALL be a
`hello` that declares `deviceId`, `platform` (`windows` | `macos` | `android`), `name`,
`agentVersion` and `ops`. The relay SHALL keep one session lease per device, so recipes on different
devices run concurrently and recipes on the same device serialize. A new connection SHALL replace
only the previous connection of the same `deviceId`.

#### Scenario: a phone connecting does not disconnect the PC
- **WHEN** a desktop agent is connected and an Android agent completes its hello
- **THEN** both devices are listed, and an op sent to the desktop device reaches only the desktop socket

#### Scenario: a connection without a hello is closed
- **WHEN** the first frame of a connection is not a valid hello, or none arrives within 5 seconds
- **THEN** the relay closes the socket with code 4001 and registers no device

#### Scenario: a v1 agent is refused by name
- **WHEN** an agent offers only `host-relay.v1`
- **THEN** the upgrade is answered with HTTP 426 and a body saying Stream Desktop is too old

### Requirement: Declared op sets decide capability

The desktop driver SHALL decide whether a device supports an op from the device's declared `ops`,
before sending. A read op the device does not declare (`readText`, `readElements`, `findImage`)
SHALL return `null`, `nudge` SHALL return `false`, and `status` SHALL be a no-op. Any other
undeclared op SHALL fail with `UnsupportedOpError` without being sent. An error returned by the
agent for a declared op SHALL propagate unchanged.

#### Scenario: an undeclared action fails before the wire
- **WHEN** a recipe step clicks on a device whose hello did not declare `click`
- **THEN** the step fails with `unsupported-op: click` and nothing is sent to the device
```

Run: `openspec validate android-phone-surface` from the worktree.
Expected: valid (the change now has a delta).

- [ ] **Step 2: Bring the cookbook to the current state**

Run: `grep -rn -E "host-relay\.v1|single connection|one agent|Single-connection" <worktree>/docs <worktree>/app/host-agent/README.md <worktree>/src/http/host-relay.ts`

For each hit, rewrite it to describe the current state in English: `host-relay.v2`, one relay per
device keyed by the hello's `deviceId`, ops declared in the hello. Write current state only, with no
"previously" wording (see the cookbook rule in the global principles). The `WsHostRelay` class
comment's "Single-connection assumption (one host, one agent)" becomes "One relay per device; the
registry (`host-registry.ts`) holds one per `deviceId`."

- [ ] **Step 3: Commit**

```bash
git -C <worktree> add openspec/changes/android-phone-surface/specs docs app/host-agent/README.md src/http/host-relay.ts
git -C <worktree> commit -m "docs(host-relay): describe the v2 multi-device relay and add its spec delta"
```

- [ ] **Step 4: Full suite before landing**

Run: `scripts/qrun.sh node_modules/.bin/vitest run --root <worktree>` and
`pnpm_config_verify_deps_before_run=false pnpm --dir <worktree> typecheck`
Expected: all green. Save the full output to a file in the scratchpad and read failures from the
file, not from the tail.

- [ ] **Step 5: Build the new Stream Desktop before landing**

The protocol change is breaking, so the new exe must be ready **before** the backend switches over:

```bash
scripts/qrun.sh cargo build --release --manifest-path <worktree>/app/host-agent/Cargo.toml --target x86_64-pc-windows-gnu
```

Find which exe the live backend runs:

```bash
powershell.exe -NoProfile -Command "Get-Process stream-desktop -ErrorAction SilentlyContinue | Select-Object Id,Path"
```

- [ ] **Step 6: Land and swap (outside 09:40–09:50 / 14:50–15:05 on weekdays)**

1. ff-merge the branch into `main` (rebase first if `main` moved).
2. Stop the old agent by its PID from Step 5: `taskkill.exe /PID <pid> /F`. Then copy
   `target/x86_64-pc-windows-gnu/release/stream-desktop.exe` over the path from Step 5.
3. `stream restart`. The backend respawns the agent from that path.
4. Verify in the backend log:
   `grep "device connected desktop:" <the backend log>` shows one line with `(windows, …, 22 ops)`.
5. Verify end to end through MCP: `cdp_look` with `target:'desktop'` returns the window list.

If Step 4 shows `refused a host-relay.v1 agent`, the old exe is still the one running. Repeat the
kill and copy with the path the refusal came from.
