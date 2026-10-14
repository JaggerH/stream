# Device Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone pairs with Stream by scanning a QR code in the panel and gets its own device
token. It connects to `/api/host` with that token, and the panel can list and revoke paired devices.

**Architecture:** A `DeviceStore` (a JSON file in the data dir, mode 0600) holds paired devices with
**hashed** tokens and keeps one-time pairing codes in memory. Four routes sit on top of it: create
a code (loopback only), pair (exempt from the token, because the code is the credential), list, and
revoke. `attachHostRelay` accepts either the shared token (Stream Desktop) or a device token. A
device token is bound to its `deviceId`, so a `hello` that claims another id is closed. Revoking a
device drops its live socket. The panel gets a "手机" section with the QR code and the device list.

**Tech Stack:** TypeScript (Node, Hono, `ws`, vitest), React (the panel, with vitest and Testing Library), `uqr` (QR to SVG).

**Spec:** `openspec/changes/android-phone-surface/design.md` §D4. Plan 1 (`openspec/changes/android-phone-surface/plans/01-host-relay-v2.md`) is merged.

## Global Constraints

- Pairing code: 6 decimal digits, 5-minute TTL, single use. After 5 failed pair attempts, every
  outstanding code is invalidated.
- Device ids are `android:<uuid>`, assigned by the backend at pairing.
- Device tokens are 256-bit random hex. Only `sha256(token)` is stored, and it is compared in
  constant time.
- Device store file: `<dataDir>/devices.json`, mode 0600.
- `POST /api/devices/pairing-code` answers **loopback only**. `POST /api/devices/pair` is exempt from
  the API access token, but not from the Host/Origin checks.
- QR payload is the JSON string `{"stream":"pair","v":1,"backend":"<http://lan-ip:port>","code":"<6 digits>"}`.
- A connection made with a device token whose `hello.deviceId` differs from the bound id is closed
  with **4003**.
- Revoking a device closes its live socket with **4003**.
- Worktree: `/home/jagger/projects/stream/.claude/worktrees/phone-pairing`. Use absolute paths and
  `git -C <worktree>`. Tests: `/home/jagger/projects/stream/scripts/qrun.sh <worktree>/node_modules/.bin/vitest run --root <worktree> <paths>`.
  Panel tests: the same command with `--root <worktree>/app`.
- Never `pnpm install` in the worktree. Never `git stash`, `git reset`, `git checkout --`, or
  `git commit --amend`.
- Public docs are English and describe the current state only.
- The live backend `127.0.0.1:8900` carries real-money tasks. Do not restart it on weekdays
  09:40–09:50 or 14:50–15:05.

---

### Task 1 (controller, main checkout): add `uqr` to the panel

A worktree cannot add dependencies (AGENTS.md), so the controller does this on `main`:

- [ ] **Step 1:** In `/home/jagger/projects/stream`: `pnpm --filter ./app add uqr@0.1.2`
- [ ] **Step 2:** Run `git status --short` and confirm that only `app/package.json` and `pnpm-lock.yaml` changed.
- [ ] **Step 3:** Commit on main: `chore(app): add uqr for rendering pairing QR codes`.
- [ ] **Step 4:** Rebase the worktree branch onto main: `git -C <worktree> rebase main`.

---

### Task 2: `DeviceStore`

**Files:**
- Create: `src/devices/device-store.ts`
- Test: `src/devices/device-store.test.ts`

**Interfaces:**
- Produces:
  - `interface PairedDevice { deviceId: string; name: string; platform: 'android'; pairedAt: number; lastSeenAt?: number }`
  - `type PairResult = { ok: true; deviceId: string; deviceToken: string } | { ok: false; reason: 'invalid-code' }`
  - `class DeviceStore { constructor(file: string, opts?: { now?: () => number; random?: (bytes: number) => Buffer });
    createPairingCode(): { code: string; expiresAt: number };
    pair(code: string, name: string): PairResult;
    deviceForToken(token: string): string | undefined;
    list(): PairedDevice[];
    revoke(deviceId: string): boolean;
    touch(deviceId: string): void }`
  - `const PAIRING_TTL_MS = 5 * 60_000`, `const MAX_PAIR_FAILURES = 5`

- [ ] **Step 1: Write the failing tests**

```ts
// src/devices/device-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceStore, PAIRING_TTL_MS, MAX_PAIR_FAILURES } from './device-store.ts'

let file: string
let now: number
const make = () => new DeviceStore(file, { now: () => now })

beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'devices-')), 'devices.json')
  now = 1_000_000
})

describe('DeviceStore', () => {
  it('pairing codes are six digits and expire after the TTL', () => {
    const s = make()
    const { code, expiresAt } = s.createPairingCode()
    expect(code).toMatch(/^\d{6}$/)
    expect(expiresAt).toBe(now + PAIRING_TTL_MS)
    now += PAIRING_TTL_MS + 1
    expect(s.pair(code, 'K80')).toEqual({ ok: false, reason: 'invalid-code' })
  })

  it('a code pairs exactly once and yields an android device id and a token', () => {
    const s = make()
    const { code } = s.createPairingCode()
    const r = s.pair(code, 'K80')
    if (!r.ok) throw new Error('expected ok')
    expect(r.deviceId).toMatch(/^android:[0-9a-f-]{36}$/)
    expect(r.deviceToken).toMatch(/^[0-9a-f]{64}$/)
    expect(s.pair(code, 'again')).toEqual({ ok: false, reason: 'invalid-code' })
    expect(s.deviceForToken(r.deviceToken)).toBe(r.deviceId)
    expect(s.deviceForToken('0'.repeat(64))).toBeUndefined()
  })

  it('stores only a hash of the token, in a 0600 file, and survives a reload', () => {
    const s = make()
    const r = s.pair(s.createPairingCode().code, 'K80')
    if (!r.ok) throw new Error('expected ok')
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain(r.deviceToken)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const reloaded = make()
    expect(reloaded.deviceForToken(r.deviceToken)).toBe(r.deviceId)
    expect(reloaded.list()).toEqual([{ deviceId: r.deviceId, name: 'K80', platform: 'android', pairedAt: now }])
  })

  it(`${MAX_PAIR_FAILURES} wrong codes invalidate every outstanding code`, () => {
    const s = make()
    const { code } = s.createPairingCode()
    const wrong = code === '000000' ? '111111' : '000000'
    for (let i = 0; i < MAX_PAIR_FAILURES; i++) s.pair(wrong, 'x')
    expect(s.pair(code, 'K80')).toEqual({ ok: false, reason: 'invalid-code' })
    const fresh = s.createPairingCode()
    expect(s.pair(fresh.code, 'K80').ok).toBe(true)
  })

  it('revoke removes the device and its token stops resolving', () => {
    const s = make()
    const r = s.pair(s.createPairingCode().code, 'K80')
    if (!r.ok) throw new Error('expected ok')
    expect(s.revoke(r.deviceId)).toBe(true)
    expect(s.revoke(r.deviceId)).toBe(false)
    expect(s.deviceForToken(r.deviceToken)).toBeUndefined()
    expect(make().list()).toEqual([])
  })

  it('touch records lastSeenAt', () => {
    const s = make()
    const r = s.pair(s.createPairingCode().code, 'K80')
    if (!r.ok) throw new Error('expected ok')
    now += 5000
    s.touch(r.deviceId)
    expect(s.list()[0].lastSeenAt).toBe(now)
  })

  it('a blank name becomes "Android" and a long name is capped at 64 characters', () => {
    const s = make()
    const r = s.pair(s.createPairingCode().code, '   ')
    if (!r.ok) throw new Error('expected ok')
    expect(s.list()[0].name).toBe('Android')
    const r2 = s.pair(s.createPairingCode().code, 'x'.repeat(200))
    if (!r2.ok) throw new Error('expected ok')
    expect(s.list()[1].name).toHaveLength(64)
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run: `qrun.sh vitest run --root <worktree> src/devices/device-store.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/devices/device-store.ts
/**
 * Paired phones and their tokens.
 *
 * **Only a hash of each token is stored.** The token is a credential that drives the phone, so a
 * copy of this file must not be enough to impersonate a device. Comparison is constant-time.
 *
 * Pairing codes live **in memory only**. A code is a five-minute, single-use secret, so having a
 * backend restart invalidate every open code is the safe direction. Five wrong attempts
 * invalidate every outstanding code, so nobody can walk the 10^6 code space within one TTL.
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const PAIRING_TTL_MS = 5 * 60_000
export const MAX_PAIR_FAILURES = 5
const MAX_NAME = 64

export interface PairedDevice {
  deviceId: string
  name: string
  platform: 'android'
  pairedAt: number
  lastSeenAt?: number
}

export type PairResult =
  | { ok: true; deviceId: string; deviceToken: string }
  | { ok: false; reason: 'invalid-code' }

interface Row extends PairedDevice {
  tokenHash: string
}

const sha256 = (s: string) => createHash('sha256').update(s).digest()

export class DeviceStore {
  private rows: Row[]
  private readonly codes = new Map<string, number>()
  private failures = 0
  private readonly now: () => number
  private readonly random: (bytes: number) => Buffer

  constructor(
    private readonly file: string,
    opts: { now?: () => number; random?: (bytes: number) => Buffer } = {},
  ) {
    this.now = opts.now ?? Date.now
    this.random = opts.random ?? randomBytes
    this.rows = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { devices: Row[] }).devices : []
  }

  createPairingCode(): { code: string; expiresAt: number } {
    this.dropExpired()
    let code: string
    do code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    while (this.codes.has(code))
    const expiresAt = this.now() + PAIRING_TTL_MS
    this.codes.set(code, expiresAt)
    return { code, expiresAt }
  }

  pair(code: string, name: string): PairResult {
    this.dropExpired()
    if (!this.codes.has(code)) {
      this.failures++
      if (this.failures >= MAX_PAIR_FAILURES) {
        this.codes.clear()
        this.failures = 0
      }
      return { ok: false, reason: 'invalid-code' }
    }
    this.codes.delete(code)
    this.failures = 0
    const deviceId = `android:${randomUUID()}`
    const deviceToken = this.random(32).toString('hex')
    const clean = name.trim().slice(0, MAX_NAME) || 'Android'
    this.rows.push({
      deviceId, name: clean, platform: 'android', pairedAt: this.now(),
      tokenHash: sha256(deviceToken).toString('hex'),
    })
    this.save()
    return { ok: true, deviceId, deviceToken }
  }

  deviceForToken(token: string): string | undefined {
    const h = sha256(token)
    let hit: string | undefined
    // Walk every row so the time taken does not reveal which row matched.
    for (const r of this.rows) {
      const stored = Buffer.from(r.tokenHash, 'hex')
      if (stored.length === h.length && timingSafeEqual(stored, h)) hit = r.deviceId
    }
    return hit
  }

  list(): PairedDevice[] {
    return this.rows.map(({ tokenHash: _h, ...d }) => d)
  }

  revoke(deviceId: string): boolean {
    const before = this.rows.length
    this.rows = this.rows.filter((r) => r.deviceId !== deviceId)
    if (this.rows.length === before) return false
    this.save()
    return true
  }

  touch(deviceId: string): void {
    const r = this.rows.find((x) => x.deviceId === deviceId)
    if (!r) return
    r.lastSeenAt = this.now()
    this.save()
  }

  private dropExpired(): void {
    const t = this.now()
    for (const [c, exp] of this.codes) if (exp <= t) this.codes.delete(c)
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify({ devices: this.rows }, null, 2) + '\n', { mode: 0o600 })
    chmodSync(this.file, 0o600)
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass.** Expected: 7 passed.

- [ ] **Step 5: Commit** `src/devices/device-store.ts src/devices/device-store.test.ts`:
  `feat(devices): store paired phones with hashed tokens and one-time pairing codes`

---

### Task 3: `/api/host` accepts device tokens and can drop a device

**Files:**
- Modify: `src/http/host-relay.ts` (`HostSocket`, `verifyHostUpgrade`, `attachHostRelay`)
- Modify: `src/http/host-registry.ts` (add `kick`)
- Test: `src/http/host-relay.attach.test.ts`, `src/http/host-registry.test.ts`

**Interfaces:**
- Consumes: `DeviceStore.deviceForToken` and `DeviceStore.touch` (Task 2). The relay sees them only
  as callbacks.
- Produces:
  - `HostSocket` gains `close?(code?: number, reason?: string): void`.
  - `HostRelayRegistry.kick(deviceId: string, code: number, reason: string): boolean`. It closes the
    live socket and returns whether one was live.
  - `export function offeredToken(protocolHeader: string | undefined, protocol: string): string | null`
  - `attachHostRelay(server, registry, opts: { token: string; deviceAuth?: (token: string) => string | undefined; onDeviceSeen?: (deviceId: string) => void; path?; log?; helloTimeoutMs? })`

- [ ] **Step 1: Write the failing tests**

Append to `src/http/host-registry.test.ts`:

```ts
describe('HostRelayRegistry.kick', () => {
  it('closes the live socket of that device only', () => {
    const reg = new HostRelayRegistry()
    const closed: Array<[number | undefined, string | undefined]> = []
    const phone: HostSocket = { send: () => {}, close: (c, r) => void closed.push([c, r]) }
    reg.connect(phone, hello({ deviceId: 'android:x', platform: 'android' }))
    reg.connect(fakeSocket().socket, hello())
    expect(reg.kick('android:x', 4003, 'revoked')).toBe(true)
    expect(closed).toEqual([[4003, 'revoked']])
    expect(reg.kick('android:nope', 4003, 'revoked')).toBe(false)
  })
})
```

Append to `src/http/host-relay.attach.test.ts`. The file already has `server`, `TOKEN`, `until`,
and an `afterEach` that closes `server` when it is set. Reuse them:

```ts
async function startWithDevices(map: Record<string, string>, seen: string[] = []) {
  const srv = createServer()
  server = srv
  const registry = new HostRelayRegistry()
  attachHostRelay(srv, registry, {
    token: TOKEN, log: () => {}, helloTimeoutMs: 2000,
    deviceAuth: (t) => map[t],
    onDeviceSeen: (id) => void seen.push(id),
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const url = `ws://127.0.0.1:${(srv.address() as AddressInfo).port}/api/host`
  return { registry, url }
}
const phoneHello = (deviceId: string) =>
  ({ type: 'hello', deviceId, platform: 'android', name: 'K80', agentVersion: '0.1.0', ops: ['click'] })

describe('attachHostRelay device tokens', () => {
  it('a device token connects as its bound device and is reported as seen', async () => {
    const seen: string[] = []
    const { registry, url } = await startWithDevices({ 'dev-token': 'android:k80' }, seen)
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, 'dev-token'])
    await new Promise((r) => ws.on('open', r))
    ws.send(JSON.stringify(phoneHello('android:k80')))
    await until(() => registry.deviceFor('android') !== undefined)
    expect(registry.deviceFor('android')?.hello.deviceId).toBe('android:k80')
    expect(seen).toEqual(['android:k80'])
    ws.close()
  })

  it('a device token claiming another device id is closed with 4003', async () => {
    const { registry, url } = await startWithDevices({ 'dev-token': 'android:k80' })
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, 'dev-token'])
    await new Promise((r) => ws.on('open', r))
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    ws.send(JSON.stringify(phoneHello('android:someone-else')))
    expect(await closed).toBe(4003)
    expect(registry.devices()).toHaveLength(0)
  })

  it('an unknown token is refused with 401', async () => {
    const { url } = await startWithDevices({})
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, 'nope'])
    const status = await new Promise<number>((r) => ws.on('unexpected-response', (_q, res) => r(res.statusCode ?? 0)))
    expect(status).toBe(401)
  })

  it('kicking a device closes its socket with 4003', async () => {
    const { registry, url } = await startWithDevices({ 'dev-token': 'android:k80' })
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, 'dev-token'])
    await new Promise((r) => ws.on('open', r))
    ws.send(JSON.stringify(phoneHello('android:k80')))
    await until(() => registry.devices().length === 1)
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    registry.kick('android:k80', 4003, 'revoked')
    expect(await closed).toBe(4003)
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail** (`kick` and `deviceAuth` do not exist yet).

- [ ] **Step 3: Implement**

In `host-relay.ts`, replace the `HostSocket` interface:

```ts
/** A fake socket only needs `send`; `close` lets the registry drop a revoked device. */
export interface HostSocket {
  send(data: string): void
  close?(code?: number, reason?: string): void
}
```

Add `offeredToken` above `verifyHostUpgrade`, and make `verifyHostUpgrade` use it. Its signature
and behavior stay the same, because the event-source relay also calls it:

```ts
/** The single non-protocol entry of a `Sec-WebSocket-Protocol` offer, which is the token. `null`
 *  when the offer does not carry exactly one. */
export function offeredToken(protocolHeader: string | undefined, protocol: string): string | null {
  const rest = (protocolHeader ?? '').split(',').map((s) => s.trim()).filter((p) => p && p !== protocol)
  return rest.length === 1 ? rest[0] : null
}

export function verifyHostUpgrade(
  info: { origin?: string; protocolHeader?: string },
  token: string,
  protocol: string = HOST_RELAY_PROTOCOL,
): boolean {
  if (/^https?:\/\//i.test(info.origin ?? '')) return false
  const t = offeredToken(info.protocolHeader, protocol)
  return t !== null && tokenEqual(t, token)
}
```

In `attachHostRelay`:
- Add `deviceAuth?: (token: string) => string | undefined` and `onDeviceSeen?: (deviceId: string) => void`
  to `opts`, and destructure them.
- Replace the token check in the `upgrade` handler (the `const ok = verifyHostUpgrade(...)` block and
  its 401 branch) with:

```ts
    let boundDevice: string | undefined
    const shared = verifyHostUpgrade(
      { origin: req.headers.origin, protocolHeader: req.headers['sec-websocket-protocol'] },
      token,
    )
    if (!shared) {
      const t = /^https?:\/\//i.test(req.headers.origin ?? '')
        ? null
        : offeredToken(req.headers['sec-websocket-protocol'], HOST_RELAY_PROTOCOL)
      boundDevice = t ? deviceAuth?.(t) : undefined
      if (!boundDevice) {
        log(`[host-relay] rejected upgrade (origin=${req.headers.origin ?? '<none>'})`)
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, boundDevice))
```

- Change the connection handler to `wss.on('connection', (socket, _req, boundDevice?: string) => {`.
- In the hello branch, after `parseHello` succeeds and before `clearTimeout(helloTimer)` and `registry.connect`:

```ts
      if (boundDevice !== undefined && hello.deviceId !== boundDevice) {
        log(`[host-relay] device token for ${boundDevice} sent a hello for ${hello.deviceId} — closing`)
        socket.close(4003, 'device id does not match its token')
        return
      }
```

  After `registry.connect(...)`, add: `if (boundDevice !== undefined) onDeviceSeen?.(boundDevice)`.

In `host-registry.ts`, add to the class:

```ts
  /** Drop a device's live connection (revoked). Its pending ops fail as disconnected through the
   *  socket's close handler. */
  kick(deviceId: string, code: number, reason: string): boolean {
    const l = this.live.get(deviceId)
    if (!l) return false
    l.socket.close?.(code, reason)
    return true
  }
```

- [ ] **Step 4: Run the tests.** Run `src/http/host-registry.test.ts src/http/host-relay.attach.test.ts src/http/host-relay.test.ts src/event-source`.
  The event-source tests call `verifyHostUpgrade` with their own protocol name. Expected: PASS.

- [ ] **Step 5: Commit** the four files: `feat(host-relay): accept per-device tokens bound to their device id, and let the registry drop a device`

---

### Task 4: Device routes, the pairing exemption, and serve wiring

**Files:**
- Create: `src/http/device-routes.ts`
- Test: `src/http/device-routes.test.ts`
- Modify: `src/http/access-guard.ts` (add `lanBaseUrls`, make `lanUrls` use it), `src/http/access-guard.test.ts`
- Modify: `src/http/app.ts` (`accessGate`: exempt `POST /api/devices/pair` from the token verdict), `src/http/access-guard.app.test.ts`
- Modify: `src/serve.ts` (construct `DeviceStore`, mount the routes, pass `deviceAuth` and `onDeviceSeen` to `attachHostRelay`)

**Interfaces:**
- Consumes: `DeviceStore` (Task 2), and `HostRelayRegistry.devices()` and `kick` (Task 3).
- Produces: `mountDeviceRoutes(app: Hono, deps: DeviceRoutesDeps): void`, where
  `DeviceRoutesDeps = { store: DeviceStore; registry: Pick<HostRelayRegistry, 'devices' | 'kick'>; isLocal: (c: Context) => boolean; backendUrls: (c: Context) => string[] }`.
  Routes:
  - `POST /api/devices/pairing-code` → 200 `{ code, expiresAt, qr: string[] }`, with one QR payload
    JSON per backend URL. 403 when the caller is not local.
  - `POST /api/devices/pair` with body `{ code: string, name?: string }` → 200 `{ deviceId, deviceToken }`.
    400 for a bad body. 403 `{error:'invalid-code'}` for a wrong code.
  - `GET /api/devices` → `{ devices: Array<{ deviceId, name, platform, paired: boolean, online: boolean, pairedAt?, lastSeenAt?, agentVersion? }> }`.
    Paired phones are merged with every online device, and Stream Desktop shows as
    `paired:false, online:true`.
  - `DELETE /api/devices/:id` → 204 when revoked, which also kicks the live socket with 4003
    `revoked`. 404 when the device is unknown.
  - `export const TOKEN_EXEMPT_ROUTES: ReadonlyArray<{ method: string; path: string }> = [{ method: 'POST', path: '/api/devices/pair' }]`

- [ ] **Step 1: Write the failing tests**

```ts
// src/http/device-routes.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountDeviceRoutes } from './device-routes.ts'
import { DeviceStore } from '../devices/device-store.ts'
import { HostRelayRegistry } from './host-registry.ts'

let store: DeviceStore
let registry: HostRelayRegistry
let local: boolean
let app: Hono

beforeEach(() => {
  store = new DeviceStore(join(mkdtempSync(join(tmpdir(), 'devroutes-')), 'devices.json'))
  registry = new HostRelayRegistry()
  local = true
  app = new Hono()
  mountDeviceRoutes(app, {
    store, registry,
    isLocal: () => local,
    backendUrls: () => ['http://10.9.8.21:8900'],
  })
})

const post = (path: string, body?: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

describe('device routes', () => {
  it('only this machine can mint a pairing code; the QR payload names backend and code', async () => {
    local = false
    expect((await post('/api/devices/pairing-code')).status).toBe(403)
    local = true
    const res = await post('/api/devices/pairing-code')
    expect(res.status).toBe(200)
    const body = await res.json() as { code: string; qr: string[] }
    expect(JSON.parse(body.qr[0])).toEqual({ stream: 'pair', v: 1, backend: 'http://10.9.8.21:8900', code: body.code })
  })

  it('pairing with the code returns a token; a wrong code is 403 invalid-code', async () => {
    const { code } = await (await post('/api/devices/pairing-code')).json() as { code: string }
    local = false // the phone is not this machine
    const bad = await post('/api/devices/pair', { code: code === '000000' ? '111111' : '000000' })
    expect(bad.status).toBe(403)
    expect(await bad.json()).toEqual({ error: 'invalid-code' })
    const ok = await post('/api/devices/pair', { code, name: 'K80' })
    expect(ok.status).toBe(200)
    const { deviceId, deviceToken } = await ok.json() as { deviceId: string; deviceToken: string }
    expect(store.deviceForToken(deviceToken)).toBe(deviceId)
  })

  it('a malformed pair body is 400', async () => {
    expect((await post('/api/devices/pair', { code: 123 })).status).toBe(400)
    expect((await app.request('/api/devices/pair', { method: 'POST', body: 'nope' })).status).toBe(400)
  })

  it('lists paired phones merged with online devices', async () => {
    const r = store.pair(store.createPairingCode().code, 'K80')
    if (!r.ok) throw new Error('expected ok')
    registry.connect({ send: () => {} }, { deviceId: 'desktop:pc', platform: 'windows', name: 'PC', agentVersion: '0.1.0', ops: [] })
    const { devices } = await (await app.request('/api/devices')).json() as { devices: Array<Record<string, unknown>> }
    expect(devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: r.deviceId, name: 'K80', platform: 'android', paired: true, online: false }),
      expect.objectContaining({ deviceId: 'desktop:pc', platform: 'windows', paired: false, online: true, agentVersion: '0.1.0' }),
    ]))
  })

  it('revoking drops the live socket and forgets the token', async () => {
    const r = store.pair(store.createPairingCode().code, 'K80')
    if (!r.ok) throw new Error('expected ok')
    const closed: number[] = []
    registry.connect({ send: () => {}, close: (c) => void closed.push(c ?? 0) },
      { deviceId: r.deviceId, platform: 'android', name: 'K80', agentVersion: '0.1.0', ops: [] })
    const res = await app.request(`/api/devices/${encodeURIComponent(r.deviceId)}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(closed).toEqual([4003])
    expect(store.deviceForToken(r.deviceToken)).toBeUndefined()
    expect((await app.request(`/api/devices/${encodeURIComponent(r.deviceId)}`, { method: 'DELETE' })).status).toBe(404)
  })
})
```

Add to `src/http/access-guard.test.ts`, and import `lanBaseUrls`:

```ts
it('lanBaseUrls lists http://<ipv4>:<port> without a token, and lanUrls appends the token to each', () => {
  for (const u of lanBaseUrls('8900')) expect(u).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:8900$/)
  expect(lanUrls('8900', 't')).toEqual(lanBaseUrls('8900').map((u) => `${u}/?token=t`))
})
```

Add an app-level test for the exemption to `src/http/access-guard.app.test.ts`. Build the app with
`accessGuard` set, using that file's existing helper. Then check two things:
- A non-loopback `POST /api/devices/pair` without a token must **not** get the 401 body that
  contains "需要出示访问令牌". The route is not mounted in that harness, so a 404 is fine.
- A non-loopback `GET /api/devices` without a token must still get 401.

Follow the file's existing pattern for faking a non-loopback peer.

- [ ] **Step 2: Run the tests and confirm they fail.**

- [ ] **Step 3: Implement**

```ts
// src/http/device-routes.ts
/**
 * Pairing and managing phones (design D4).
 *
 * `pairing-code` answers **this machine only**. A code lets a device in, so minting one needs
 * someone in front of the machine, the same rule as `/api/access-token`. `pair` is the one route
 * the API token does not guard (see `TOKEN_EXEMPT_ROUTES`): the phone has no token yet, and the
 * code itself is the credential. Host and Origin checks still apply to it.
 */
import type { Context, Hono } from 'hono'
import type { DeviceStore } from '../devices/device-store.ts'
import type { HostRelayRegistry } from './host-registry.ts'

export const TOKEN_EXEMPT_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'POST', path: '/api/devices/pair' },
]

export interface DeviceRoutesDeps {
  store: DeviceStore
  registry: Pick<HostRelayRegistry, 'devices' | 'kick'>
  isLocal: (c: Context) => boolean
  /** Base URLs where a phone on the LAN can reach this backend (`http://<ip>:<port>`). */
  backendUrls: (c: Context) => string[]
}

export function mountDeviceRoutes(app: Hono, deps: DeviceRoutesDeps): void {
  app.post('/api/devices/pairing-code', (c) => {
    if (!deps.isLocal(c)) return c.json({ error: '配对码只能在运行 Stream 的那台机器上生成' }, 403)
    const { code, expiresAt } = deps.store.createPairingCode()
    const qr = deps.backendUrls(c).map((backend) => JSON.stringify({ stream: 'pair', v: 1, backend, code }))
    return c.json({ code, expiresAt, qr })
  })

  app.post('/api/devices/pair', async (c) => {
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'body 不是合法 JSON' }, 400) }
    const { code, name } = (body ?? {}) as { code?: unknown; name?: unknown }
    if (typeof code !== 'string' || (name !== undefined && typeof name !== 'string')) {
      return c.json({ error: 'code 必须是字符串，name 可选且必须是字符串' }, 400)
    }
    const r = deps.store.pair(code, name ?? '')
    if (!r.ok) return c.json({ error: r.reason }, 403)
    return c.json({ deviceId: r.deviceId, deviceToken: r.deviceToken })
  })

  app.get('/api/devices', (c) => {
    const online = new Map(deps.registry.devices().map((d) => [d.hello.deviceId, d]))
    const paired = deps.store.list().map((d) => {
      const live = online.get(d.deviceId)
      return { ...d, paired: true, online: !!live, ...(live ? { agentVersion: live.hello.agentVersion } : {}) }
    })
    const pairedIds = new Set(paired.map((d) => d.deviceId))
    const others = [...online.values()]
      .filter((d) => !pairedIds.has(d.hello.deviceId))
      .map((d) => ({
        deviceId: d.hello.deviceId, name: d.hello.name, platform: d.hello.platform,
        paired: false, online: true, agentVersion: d.hello.agentVersion,
      }))
    return c.json({ devices: [...paired, ...others] })
  })

  app.delete('/api/devices/:id', (c) => {
    const id = c.req.param('id')
    if (!deps.store.revoke(id)) return c.json({ error: '没有这台设备' }, 404)
    deps.registry.kick(id, 4003, 'revoked')
    return c.body(null, 204)
  })
}
```

In `access-guard.ts`, replace `lanUrls` with:

```ts
/** `http://<ipv4>:<port>` for every non-internal IPv4 interface, i.e. where a LAN device can reach us. */
export function lanBaseUrls(port: string): string[] {
  const out: string[] = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      out.push(`http://${a.address}:${port}`)
    }
  }
  return out
}

export function lanUrls(port: string, token: string): string[] {
  return lanBaseUrls(port).map((u) => `${u}/?token=${encodeURIComponent(token)}`)
}
```

In `app.ts`, inside `accessGate`, right before `const verdict = authorizeAccess({`:

```ts
      // The one token-exempt route. A phone that is pairing has no token yet, and its one-time
      // code is the credential (device-routes.ts). The Host/Origin check above still applied.
      if (TOKEN_EXEMPT_ROUTES.some((r) => r.method === c.req.method && r.path === c.req.path)) {
        await next()
        return
      }
```

Also add `import { TOKEN_EXEMPT_ROUTES } from './device-routes.ts'`.

In `serve.ts`:
- Construct the store next to where `extToken` is loaded (same directory as `ext-relay-token` and
  `api-token`):
  `const deviceStore = new DeviceStore(join(dirname(config.item_db), 'devices.json'))`.
- Next to `mountTaskRoutes`, mount the routes:

```ts
  mountDeviceRoutes(app, {
    store: deviceStore,
    registry: harvest.hostRelays,
    isLocal: (c) => isLoopbackAddress(peerAddress(c)),
    backendUrls: (c) => lanBaseUrls((c.req.header('Host') ?? '').split(':')[1] || String(PORT)),
  })
```

  Import `isLoopbackAddress`, `peerAddress` and `lanBaseUrls` from `./http/access-guard.ts`, and
  `mountDeviceRoutes` and `DeviceStore`. Check whether `join` and `dirname` are already imported.
- In the `attachHostRelay(...)` call, add
  `deviceAuth: (t) => deviceStore.deviceForToken(t), onDeviceSeen: (id) => deviceStore.touch(id)`.

- [ ] **Step 4: Run** `src/http/device-routes.test.ts src/http/access-guard.test.ts src/http/access-guard.app.test.ts src/http/app.test.ts`,
  then `cd <worktree> && pnpm_config_verify_deps_before_run=false pnpm typecheck`. Expected: PASS, 0 errors.

- [ ] **Step 5: Commit** all changed files: `feat(devices): pair phones over the LAN with a one-time code, list and revoke them`

---

### Task 5: Panel "手机" section

**Files:**
- Create: `app/src/components/PhoneDevicesSettings.tsx`
- Test: `app/src/components/PhoneDevicesSettings.test.tsx`
- Modify: `app/src/lib/api.ts` (add `devices` to `api` and the `DeviceRow` type)
- Modify: `app/src/components/BackendSettings.tsx` (add the section after "远程访问")

**Interfaces:**
- Consumes: the four routes from Task 4.
- Produces: `api.devices = { list, pairingCode, revoke }` and `<PhoneDevicesSettings conn={conn} />`.

- [ ] **Step 1: Write the failing test**

```tsx
// app/src/components/PhoneDevicesSettings.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PhoneDevicesSettings } from './PhoneDevicesSettings.tsx'

const conn = { baseUrl: 'http://127.0.0.1:8900' } as never
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

const json = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body })

describe('PhoneDevicesSettings', () => {
  it('lists devices with their online state and revokes a paired phone', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.resolve({ ok: true, status: 204, json: async () => null })
      return json({ devices: [
        { deviceId: 'android:1', name: 'K80', platform: 'android', paired: true, online: true },
        { deviceId: 'desktop:pc', name: 'PC', platform: 'windows', paired: false, online: true },
      ] })
    })
    render(<PhoneDevicesSettings conn={conn} />)
    expect(await screen.findByText('K80')).toBeTruthy()
    expect(screen.getByText('PC')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '撤销 PC' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '撤销 K80' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8900/api/devices/android%3A1', expect.objectContaining({ method: 'DELETE' })))
  })

  it('shows the code and one QR per backend address after "添加手机"', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith('/api/devices/pairing-code')) {
        return json({ code: '123456', expiresAt: Date.now() + 300_000, qr: [
          JSON.stringify({ stream: 'pair', v: 1, backend: 'http://10.9.8.21:8900', code: '123456' }),
        ] })
      }
      return json({ devices: [] })
    })
    const { container } = render(<PhoneDevicesSettings conn={conn} />)
    fireEvent.click(await screen.findByRole('button', { name: '添加手机' }))
    expect(await screen.findByText('123456')).toBeTruthy()
    expect(screen.getByText('http://10.9.8.21:8900')).toBeTruthy()
    expect(container.querySelectorAll('svg[data-pair-qr]')).toHaveLength(1)
  })
})
```

If the panel's `authHeaders(conn)` reads fields that `{ baseUrl }` does not have, build `conn` the
way `BackendSettings.test.tsx` or `RemoteAccessSettings` tests do instead.

- [ ] **Step 2: Run the test.** Run it with `--root <worktree>/app src/components/PhoneDevicesSettings.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement**

In `api.ts`, inside `export const api = {`, after `accessToken`:

```ts
  /** Paired phones and online host agents (design D4). `pairingCode` answers on this machine only. */
  devices: {
    list: (c: Connection) => get<{ devices: DeviceRow[] }>(c, '/api/devices'),
    pairingCode: (c: Connection) => post<{ code: string; expiresAt: number; qr: string[] }>(c, '/api/devices/pairing-code', {}),
    revoke: (c: Connection, id: string) => del<null>(c, `/api/devices/${encodeURIComponent(id)}`),
  },
```

Add this type next to the other exported types:

```ts
export interface DeviceRow {
  deviceId: string
  name: string
  platform: 'windows' | 'macos' | 'android'
  paired: boolean
  online: boolean
  pairedAt?: number
  lastSeenAt?: number
  agentVersion?: string
}
```

```tsx
// app/src/components/PhoneDevicesSettings.tsx
import { useCallback, useEffect, useState } from 'react'
import { renderSVG } from 'uqr'
import { toast } from './acrylic/sonner.tsx'
import { api, ApiError, type Connection, type DeviceRow } from '../lib/api.ts'

/**
 * Phones paired with Stream, plus the host agents online right now.
 *
 * "添加手机" mints a one-time code (this machine only) and shows one QR code per LAN address. The
 * Stream app on the phone scans it and pairs. Revoking forgets the phone's token and drops its live
 * connection at once. Stream Desktop is listed but cannot be revoked, because it connects with the
 * machine's own secret rather than a paired token.
 */
export function PhoneDevicesSettings({ conn }: { conn: Connection }) {
  const [devices, setDevices] = useState<DeviceRow[] | null>(null)
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number; qr: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api.devices.list(conn)
      .then((d) => { setDevices(d.devices); setError(null) })
      .catch((e) => setError(e instanceof ApiError ? e.message : '后端未响应'))
  }, [conn])
  useEffect(load, [load])

  const startPairing = async () => {
    try {
      setPairing(await api.devices.pairingCode(conn))
    } catch (e) {
      toast.error('生成配对码失败', { description: e instanceof ApiError ? e.message : '后端未响应' })
    }
  }

  const revoke = async (d: DeviceRow) => {
    try {
      await api.devices.revoke(conn, d.deviceId)
      load()
    } catch (e) {
      toast.error('撤销失败', { description: e instanceof ApiError ? e.message : '后端未响应' })
    }
  }

  if (error) return <div className="text-[12px] text-muted-foreground">{error}</div>
  if (!devices) return <div className="text-[12px] text-muted-foreground">读取中…</div>

  return (
    <div className="space-y-2.5">
      {devices.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">还没有设备。</p>
      ) : (
        <ul className="space-y-1.5">
          {devices.map((d) => (
            <li key={d.deviceId} className="flex items-center gap-2 rounded-md border border-[var(--acr-border-soft)] px-2.5 py-1.5">
              <span className={`size-1.5 shrink-0 rounded-full ${d.online ? 'bg-emerald-400' : 'bg-muted-foreground/40'}`} />
              <span className="min-w-0 flex-1 truncate text-[12px]">{d.name}</span>
              <span className="text-[11px] text-muted-foreground">{d.platform === 'android' ? '安卓' : '电脑'}</span>
              {d.paired && (
                <button
                  type="button"
                  aria-label={`撤销 ${d.name}`}
                  onClick={() => revoke(d)}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  撤销
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={startPairing}
        className="rounded-md border border-[var(--acr-border-soft)] px-2.5 py-1.5 text-[12px] hover:border-foreground/40"
      >
        添加手机
      </button>

      {pairing && (
        <div className="space-y-2">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            用手机上的 Stream 扫码，或手动输入地址和配对码。配对码 5 分钟内有效，只能用一次。
          </p>
          <div className="font-mono text-[20px] tracking-[0.3em]">{pairing.code}</div>
          {pairing.qr.length === 0 ? (
            <p className="rounded-md bg-amber-400/10 px-2.5 py-2 text-[12px] text-amber-300">
              这台机器现在没有局域网地址，手机够不着它。
            </p>
          ) : (
            pairing.qr.map((payload) => {
              const backend = (JSON.parse(payload) as { backend: string }).backend
              return (
                <div key={payload} className="space-y-1">
                  <div
                    className="w-40 rounded bg-white p-2"
                    // renderSVG returns a self-contained <svg>; tag it so tests can count codes.
                    dangerouslySetInnerHTML={{ __html: renderSVG(payload).replace('<svg', '<svg data-pair-qr') }}
                  />
                  <div className="font-mono text-[11px] text-muted-foreground">{backend}</div>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
```

In `BackendSettings.tsx`, add this right after the "远程访问" `SettingsSection`:

```tsx
              {/* 手机配对：配对码只在本机生成（后端对非 loopback 直接 403）。 */}
              <SettingsSection
                title="手机"
                collapsible
                {...section('phones')}
                footnote="手机装 Stream 后扫码配对"
              >
                <SettingsBlock>
                  <PhoneDevicesSettings conn={conn} />
                </SettingsBlock>
              </SettingsSection>
```

Also add `import { PhoneDevicesSettings } from './PhoneDevicesSettings.tsx'`. If `section(...)`
takes a typed key union, add `'phones'` to it.

- [ ] **Step 4: Run** the new test plus `src/components/BackendSettings.test.tsx`, both with
  `--root <worktree>/app`. Then run the root typecheck
  (`cd <worktree> && pnpm_config_verify_deps_before_run=false pnpm typecheck`), which covers `app/`.
  If it does not, run the typecheck script that `app/package.json` defines. Expected: PASS.

- [ ] **Step 5: Commit** the four files: `feat(panel): pair phones with a QR code and list or revoke devices`

---

### Task 6: Spec delta, cookbook, full suite, live check

**Files:**
- Create: `openspec/changes/android-phone-surface/specs/device-pairing/spec.md`
- Modify: `docs/API.md` (the remote-access section near `/api/access-token`)

- [ ] **Step 1: Write the spec delta**

```markdown
## ADDED Requirements

### Requirement: Phones pair with a one-time code and get their own token

The backend SHALL mint pairing codes (6 digits, 5-minute TTL, single use) only for requests from
the local machine. Pairing with a valid code SHALL return a new `android:<uuid>` device id and a
256-bit device token, of which only a hash is stored. Five failed attempts SHALL invalidate every
outstanding code. The pair route SHALL NOT require the API access token.

#### Scenario: a code from another machine is refused
- **WHEN** a non-loopback client requests a pairing code
- **THEN** the backend answers 403 and mints nothing

#### Scenario: a code pairs once
- **WHEN** a phone pairs with a valid code, and then a second phone tries the same code
- **THEN** the first receives a device id and token, and the second is refused with `invalid-code`

### Requirement: Device tokens are bound to their device

`/api/host` SHALL accept a device token in place of the shared secret. A connection authorized by
a device token whose `hello.deviceId` differs from the bound id SHALL be closed with 4003.
Revoking a device SHALL forget its token and close its live connection with 4003.

#### Scenario: a revoked phone is dropped at once
- **WHEN** the user revokes a connected phone in the panel
- **THEN** its socket closes with 4003 and its token no longer authorizes an upgrade
```

Run `openspec validate android-phone-surface` from the worktree. Expected: valid.

- [ ] **Step 2: Update the cookbook.** In `docs/API.md`, next to the `/api/access-token` paragraph,
  add a short "Pairing a phone" paragraph. It should state the four routes, the loopback-only and
  token-exempt rules, and the QR payload format. Write in English and describe the current state
  only.

- [ ] **Step 3: Commit** `docs(devices): document phone pairing and add its spec delta`.

- [ ] **Step 4: Run the full suite.** Run
  `qrun.sh vitest run --root <worktree> > <worktree>/.superpowers/sdd/pairing-full-suite.log 2>&1`,
  then the `app` suite the same way with `--root <worktree>/app` (log `pairing-app-suite.log`), then
  the root typecheck. Read failures from the log files.

- [ ] **Step 5 (controller): land and check it live.** Do this outside the trading windows.
  1. Rebase onto main and ff-merge. Check `GET /api/tasks` for a `running` row, then run
     `systemctl --user restart stream-back.service`.
  2. `curl -s -X POST 127.0.0.1:8900/api/devices/pairing-code` returns a code and a `qr` entry with the LAN IP.
  3. Pair from the LAN address, as the phone would:
     `curl -s -X POST http://<lan-ip>:8900/api/devices/pair -H 'content-type: application/json' -d '{"code":"<code>","name":"curl"}'`.
     It returns a `deviceId` and a `deviceToken`.
  4. `curl -s 127.0.0.1:8900/api/devices` lists `curl` (paired, offline) and `desktop:cortana` (online).
  5. `curl -s -X DELETE 127.0.0.1:8900/api/devices/<id>` returns 204. List again: the device is gone.
  6. Open the panel settings and check that the "手机" section shows the QR code.
