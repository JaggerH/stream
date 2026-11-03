import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { WsHostRelay } from './host-relay.ts'
import { HostRelayRegistry } from './host-registry.ts'
import {
  deviceForwardApp, deviceForwardUpgrade, mintForwardCredential, verifyForwardCredential,
  forwardSecretOf, maskCredential, FORWARD_BASE_PATH,
} from './device-forward.ts'

const SECRET = 'test-secret'

// ── 凭证 ────────────────────────────────────────────────────────────────────

describe('转发凭证', () => {
  const scope = { device: 'linux:abc', port: 8765 }

  it('签发与校验：范围一致、未过期 → ok', () => {
    const { cred } = mintForwardCredential(SECRET, scope, { now: () => 1_000 })
    expect(verifyForwardCredential(SECRET, scope, cred, 1_000 + 1)).toEqual({ ok: true })
  })

  it('过期 → credential-expired', () => {
    const { cred } = mintForwardCredential(SECRET, scope, { ttlMs: 60_000, now: () => 1_000 })
    expect(verifyForwardCredential(SECRET, scope, cred, 61_001)).toEqual({ ok: false, reason: 'credential-expired' })
  })

  it('范围不符（device / port / widget 各自）→ credential-scope', () => {
    const { cred } = mintForwardCredential(SECRET, { ...scope, widget: 'status-card' }, { now: () => 1_000 })
    expect(verifyForwardCredential(SECRET, { device: 'linux:other', port: 8765 }, cred, 2_000)).toMatchObject({ ok: false, reason: 'credential-scope' })
    expect(verifyForwardCredential(SECRET, { device: 'linux:abc', port: 8888 }, cred, 2_000)).toMatchObject({ ok: false, reason: 'credential-scope' })
    expect(verifyForwardCredential(SECRET, { device: 'linux:abc', port: 8765, widget: 'other-card' }, cred, 2_000)).toMatchObject({ ok: false, reason: 'credential-scope' })
  })

  it('签名不符（换了 secret / 篡改载荷）→ credential-scope；乱串 → credential-malformed', () => {
    const { cred } = mintForwardCredential(SECRET, scope, { now: () => 1_000 })
    expect(verifyForwardCredential('other-secret', scope, cred, 2_000)).toMatchObject({ ok: false, reason: 'credential-scope' })
    expect(verifyForwardCredential(SECRET, scope, 'garbage', 2_000)).toMatchObject({ ok: false, reason: 'credential-malformed' })
  })

  it('日志打码：只出现前 8 位', () => {
    const { cred } = mintForwardCredential(SECRET, scope)
    expect(maskCredential(cred)).toBe(cred.slice(0, 8) + '…')
  })

  it('密钥从 extToken 派生：同一 extToken 稳定，不同 extToken 不同', () => {
    expect(forwardSecretOf('a')).toBe(forwardSecretOf('a'))
    expect(forwardSecretOf('a')).not.toBe(forwardSecretOf('b'))
  })
})

// ── HTTP 入口 ───────────────────────────────────────────────────────────────

/** 假设备目录：一台设备、一个 relay（fake socket 收帧、手动回帧）。 */
function fakeDevice(opts?: { ports?: number[] }) {
  const relay = new WsHostRelay()
  const sent: { id: number; op: string; args?: Record<string, unknown> }[] = []
  relay.connect({ send: (d: string) => sent.push(JSON.parse(d)) })
  const ports = opts?.ports ?? [8765]
  const directory = {
    isOnline: () => true,
    portsOf: () => ports,
    forwardRelay: (_id: string, op: 'http.forward' | 'ws.forward') => (op === 'http.forward' ? relay : undefined),
  }
  const result = (status: number, headers: [string, string][], body: string) => {
    const frame = sent.find((f) => f.op === 'http.forward')
    if (frame) relay.handleMessage(JSON.stringify({ id: frame.id, result: { status, headers, body, url: frame.args?.path } }))
  }
  return { relay, sent, directory, result }
}

function forwardApp(directory: ReturnType<typeof fakeDevice>['directory']) {
  const app = new Hono()
  app.route('/api', deviceForwardApp({ directory, secret: SECRET }, { base: FORWARD_BASE_PATH }))
  return app
}

const credFor = (scope: { device: string; port: number }) => mintForwardCredential(SECRET, scope).cred

describe('HTTP 转发入口', () => {
  it('完整往返：凭证对、端口声明过 → 设备收到剥掉身份头的请求，响应带回 CSP 头', async () => {
    const d = fakeDevice()
    const app = forwardApp(d.directory)
    const cred = credFor({ device: 'linux:abc', port: 8765 })
    const p = app.request(`/api/fwd/linux:abc/8765/${cred}/status?x=1`, {
      method: 'GET',
      headers: { cookie: 'stream-session=secret', authorization: 'Bearer user-token', 'x-custom': 'keep-me' },
    })
    await vi.waitFor(() => expect(d.sent).toHaveLength(1))
    // 剥掉主实例身份，保留普通头，带上转发凭证
    const headers = d.sent[0].args!.headers as [string, string][]
    const names = headers.map(([k]) => k.toLowerCase())
    expect(names).not.toContain('cookie')
    expect(names).not.toContain('authorization')
    expect(names).toContain('x-custom')
    expect(names).toContain('x-stream-fwd-cred')
    expect(d.sent[0].args).toMatchObject({ port: 8765, path: '/status?x=1', method: 'GET' })
    d.result(200, [['content-type', 'text/plain'], ['set-cookie', 'a=1']], Buffer.from('ok').toString('base64'))
    const res = await p
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    // 直开也沙箱 + Set-Cookie 剥掉
    expect(res.headers.get('content-security-policy')).toBe('sandbox allow-scripts allow-forms')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('只转声明过的端口：未声明 / 设备没声明 ports 字段 → 403 port-not-declared 且不发帧', async () => {
    const d = fakeDevice({ ports: [8765] })
    const app = forwardApp(d.directory)
    const res = await app.request(`/api/fwd/linux:abc/9999/${credFor({ device: 'linux:abc', port: 9999 })}/x`)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('port-not-declared')

    const none = fakeDevice({ ports: [] })
    const app2 = forwardApp(none.directory)
    const res2 = await app2.request(`/api/fwd/linux:abc/8765/${credFor({ device: 'linux:abc', port: 8765 })}/x`)
    expect(res2.status).toBe(403)
    expect(((await res2.json()) as { error: string }).error).toBe('port-not-declared')
    expect(d.sent).toHaveLength(0)
    expect(none.sent).toHaveLength(0)
  })

  it('凭证过期 / 范围不符 → 403，设备收不到帧', async () => {
    const d = fakeDevice()
    const app = forwardApp(d.directory)
    // 过期：now 固定在签发后 61 分钟
    const expired = mintForwardCredential(SECRET, { device: 'linux:abc', port: 8765 }, { ttlMs: 60_000, now: () => 0 }).cred
    const res = await app.request(`/api/fwd/linux:abc/8765/${expired}/x`)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('credential-expired')
    // 拿 A 端口的凭证访问 B 端口
    const res2 = await app.request(`/api/fwd/linux:abc/8888/${credFor({ device: 'linux:abc', port: 8765 })}/x`)
    expect(res2.status).toBe(403)
    expect(((await res2.json()) as { error: string }).error).toBe('credential-scope')
    // 拿 A 设备的凭证访问 B 设备
    const res3 = await app.request(`/api/fwd/linux:other/8765/${credFor({ device: 'linux:abc', port: 8765 })}/x`)
    expect(res3.status).toBe(403)
    expect(d.sent).toHaveLength(0)
  })

  it('请求体超限 → 413 且不发帧', async () => {
    const d = fakeDevice()
    const app = forwardApp(d.directory)
    const big = Buffer.alloc(1024 * 1024 + 1, 'a').toString('base64')
    const res = await app.request(`/api/fwd/linux:abc/8765/${credFor({ device: 'linux:abc', port: 8765 })}/upload`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from(big, 'base64'),
    })
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toBe('payload-too-large')
    expect(d.sent).toHaveLength(0)
  })

  it('响应体超限 → 413（设备侧已回的，入口同样给出 413 形状）', async () => {
    const d = fakeDevice()
    const app = forwardApp(d.directory)
    const p = app.request(`/api/fwd/linux:abc/8765/${credFor({ device: 'linux:abc', port: 8765 })}/big`)
    await vi.waitFor(() => expect(d.sent).toHaveLength(1))
    // 设备回一个超 8 MiB 的响应体
    const frame = d.sent[0]
    d.relay.handleMessage(JSON.stringify({
      id: frame.id,
      error: 'too-large: 响应体超过 8388608 字节',
      code: 'too-large',
    }))
    const res = await p
    expect(res.status).toBe(413)
  })

  it('限流：同一 (来源, device, port) 打满桶 → 429', async () => {
    const d = fakeDevice()
    const directory = { ...d.directory, isOnline: () => false } // 离线让每个过闸门的请求以 502 落定，桶照样消耗
    const app = new Hono()
    app.route('/api', deviceForwardApp({ directory, secret: SECRET, rateLimit: { capacity: 3, refillPerSecond: 0.001 } }, { base: FORWARD_BASE_PATH }))
    const cred = credFor({ device: 'linux:abc', port: 8765 })
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) {
      const r = await app.request(`/api/fwd/linux:abc/8765/${cred}/x`)
      statuses.push(r.status)
    }
    expect(statuses).toEqual([502, 502, 502, 429, 429])
  })

  it('设备离线 → 502 device-offline', async () => {
    const d = fakeDevice()
    const directory = { ...d.directory, isOnline: () => false }
    const app = forwardApp(directory)
    const res = await app.request(`/api/fwd/linux:abc/8765/${credFor({ device: 'linux:abc', port: 8765 })}/x`)
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toBe('device-offline')
  })

  it('挂载在任意前缀下：解析相对前缀', async () => {
    const d = fakeDevice()
    const app = new Hono()
    app.route('/x/fwd', deviceForwardApp({ directory: d.directory, secret: SECRET }, { base: '/x/fwd', path: '' }))
    const p = app.request(`/x/fwd/linux:abc/8765/${credFor({ device: 'linux:abc', port: 8765 })}/i.html`)
    await vi.waitFor(() => expect(d.sent).toHaveLength(1))
    expect(d.sent[0].args!.path).toBe('/i.html')
    d.result(200, [], '')
    expect((await p).status).toBe(200)
  })
})

// ── WebSocket 往返（真 upgrade：入口 socket ↔ 设备 fake socket）────────────

describe('WS 转发入口', () => {
  it('WebSocket 往返：入口客户端 ↔ 设备回环（假 relay 手动泵帧）', async () => {
    const relay = new WsHostRelay()
    const deviceSent: { id?: number; op?: string; type?: string; args?: Record<string, unknown>; b64?: string }[] = []
    relay.connect({ send: (d: string) => deviceSent.push(JSON.parse(d)) })
    const directory = {
      isOnline: () => true,
      portsOf: () => [8765] as readonly number[],
      forwardRelay: (_id: string, op: 'http.forward' | 'ws.forward') => (op === 'ws.forward' ? relay : undefined),
    }

    // 一个真的 http server 供客户端升级
    const server = createServer()
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      const handler = deviceForwardUpgrade({ directory, secret: SECRET }, { base: FORWARD_BASE_PATH })
      handler(req, socket, head)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port

    const cred = credFor({ device: 'linux:abc', port: 8765 })
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/fwd/linux:abc/8765/${cred}/ws?room=1`)
    const clientGot: string[] = []
    let clientClosed = false
    client.on('message', (d) => clientGot.push(d.toString()))
    client.on('close', () => { clientClosed = true })

    // 设备收到 ws.forward op：回 ok（建连确认）
    await vi.waitFor(() => expect(deviceSent.some((f) => f.op === 'ws.forward')).toBe(true))
    const opFrame = deviceSent.find((f) => f.op === 'ws.forward')!
    expect(opFrame.args).toMatchObject({ port: 8765, path: '/ws?room=1' })
    const headers = (opFrame.args!.headers as [string, string][])
    expect(headers.map(([k]) => k.toLowerCase())).not.toContain('cookie')
    expect(opFrame.id).toBeTypeOf('number')
    relay.handleMessage(JSON.stringify({ id: opFrame.id, result: { ok: true } }))

    // 客户端 → 设备
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    client.send('ping-from-client')
    await vi.waitFor(() => expect(deviceSent.some((f) => f.type === 'fwd-data')).toBe(true))
    const dataFrame = deviceSent.find((f) => f.type === 'fwd-data')!
    expect(dataFrame.id).toBe(opFrame.id)
    expect(Buffer.from(String(dataFrame.b64), 'base64').toString()).toBe('ping-from-client')

    // 设备 → 客户端
    relay.handleMessage(JSON.stringify({ type: 'fwd-data', id: opFrame.id, b64: Buffer.from('pong-from-device').toString('base64') }))
    await vi.waitFor(() => expect(clientGot).toEqual(['pong-from-device']))

    // 设备侧关闭 → 客户端连接关闭
    relay.handleMessage(JSON.stringify({ type: 'fwd-close', id: opFrame.id }))
    await vi.waitFor(() => expect(clientClosed).toBe(true))

    client.terminate()
    await new Promise<void>((r) => { wss.close(() => r()); server.close(() => r()) })
  })

  it('凭证不对的升级被 403 拒绝，不留半开连接', async () => {
    const relay = new WsHostRelay()
    relay.connect({ send: () => {} })
    const directory = {
      isOnline: () => true,
      portsOf: () => [8765] as readonly number[],
      forwardRelay: (_id: string, op: 'http.forward' | 'ws.forward') => (op === 'ws.forward' ? relay : undefined),
    }
    const server = createServer()
    server.on('upgrade', (req, socket, head) => {
      deviceForwardUpgrade({ directory, secret: SECRET }, { base: FORWARD_BASE_PATH })(req, socket, head)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    // 端口未声明的凭证：直接用 A 端口凭证打 B 端口
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/fwd/linux:abc/8888/${credFor({ device: 'linux:abc', port: 8765 })}/ws`)
    const codes: number[] = []
    client.on('unexpected-response', (_req, res) => { codes.push(res.statusCode ?? 0); client.terminate() })
    await vi.waitFor(() => expect(codes).toEqual([403]))
    server.close()
  })
})

// ── host-relay：ws.forward 会话 ─────────────────────────────────────────────

describe('WsHostRelay.openForwardWs', () => {
  it('建连确认后开箱可用：send/close/数据帧按 id 路由', async () => {
    const r = new WsHostRelay()
    const sent: Record<string, unknown>[] = []
    r.connect({ send: (d: string) => sent.push(JSON.parse(d)) })
    const got: string[] = []
    let closed = false
    const s = r.openForwardWs({ port: 8765, cred: 'c', path: '/ws', headers: [] }, {
      onData: (b64) => got.push(Buffer.from(b64, 'base64').toString()),
      onClose: () => { closed = true },
    })
    // op 帧带 port/cred/path
    const op = sent[0] as { id: number; op: string; args: Record<string, unknown> }
    expect(op.op).toBe('ws.forward')
    expect(op.args).toMatchObject({ port: 8765, path: '/ws' })
    // 建连确认 → opened
    r.handleMessage(JSON.stringify({ id: op.id, result: { ok: true } }))
    await s.opened
    // 后端 → 设备
    s.send(Buffer.from('x').toString('base64'))
    expect(sent.some((f) => (f as { type?: string }).type === 'fwd-data' && (f as { id?: number }).id === op.id)).toBe(true)
    // 设备 → 后端
    r.handleMessage(JSON.stringify({ type: 'fwd-data', id: op.id, b64: Buffer.from('y').toString('base64') }))
    expect(got).toEqual(['y'])
    // 设备关 → onClose
    r.handleMessage(JSON.stringify({ type: 'fwd-close', id: op.id }))
    expect(closed).toBe(true)
  })

  it('建连被拒 → opened 拒绝并带 code', async () => {
    const r = new WsHostRelay()
    const sent: Record<string, unknown>[] = []
    r.connect({ send: (d: string) => sent.push(JSON.parse(d)) })
    const s = r.openForwardWs({ port: 9, cred: 'c', path: '/', headers: [] }, { onData: () => {}, onClose: () => {} })
    const opId = (sent[0] as { id: number }).id
    r.handleMessage(JSON.stringify({ id: opId, error: 'connect-failed: ECONNREFUSED', code: 'connect-failed' }))
    await expect(s.opened).rejects.toMatchObject({ code: 'connect-failed' })
  })

  it('设备断连 → 所有会话 onClose', async () => {
    const r = new WsHostRelay()
    const sent: Record<string, unknown>[] = []
    const sock = { send: (d: string) => sent.push(JSON.parse(d)), close: () => {} }
    r.connect(sock)
    let closed = false
    const s = r.openForwardWs({ port: 8765, cred: 'c', path: '/', headers: [] }, { onData: () => {}, onClose: () => { closed = true } })
    const opId = (sent[0] as { id: number }).id
    r.handleMessage(JSON.stringify({ id: opId, result: { ok: true } }))
    await s.opened
    r.disconnect(sock)
    expect(closed).toBe(true)
    // 断连后再 send 不抛
    expect(() => s.send('x')).not.toThrow()
  })
})
