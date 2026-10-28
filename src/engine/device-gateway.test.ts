// 设备网关（openspec embeddable-device-gateway）：嵌入方把四组设备路由与两条中继挂到**自己的**
// server 上（basePath 可自定义），配对 → WS → 上下线事件整条链路都走宿主的端口。
// 这里用真实的 createStream 临时实例 + 测试自建的 http server 走完整链路。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { serve } from '@hono/node-server'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { Hono } from 'hono'
import WebSocket from 'ws'
import { createRuntime } from './runtime.ts'
import { createStream, type Stream } from './index.ts'
import { readConfig } from '../bootstrap.ts'
import { deviceGateway } from './device-gateway.ts'
import { EXT_RELAY_PROTOCOL } from '../http/ext-relay.ts'
import { HOST_RELAY_PROTOCOL } from '../http/host-relay.ts'
import { STREAM_EXTENSION_ID } from '../ext-id.ts'
import type { DeviceChange } from './devices.ts'

const roots: string[] = []
const open: Stream[] = []
const servers: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => {})
  for (const s of servers.splice(0)) {
    s.close()
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

async function tempStream(): Promise<Stream> {
  const root = mkdtempSync(join(tmpdir(), 'stream-gw-'))
  roots.push(root)
  const base = readConfig(join(root, 'config.yaml'), { STREAM_DATA_DIR: root })
  const config = { ...base, packages_dir: join(root, 'packages'), rsshub_catalog: '', deployment: { ...base.deployment, scheduler: false } }
  const stream = await createStream({ dataDir: root, config, runtime: createRuntime(), log: () => {} })
  open.push(stream)
  return stream
}

/** 宿主侧的最小装配：Hono 挂网关，upgrade 交给 gateway.handleUpgrade，回端口号。 */
async function hostApp(stream: Stream, opts: { isAdmin: () => boolean; pingIntervalMs?: number; log?: (l: string) => void }): Promise<{ port: number; upgrades: boolean[] }> {
  const gateway = deviceGateway(stream, {
    basePath: '/api/stream',
    isAdmin: () => opts.isAdmin(),
    backendUrls: () => ['http://198.51.100.7:1234'],
    ...(opts.pingIntervalMs ? { pingIntervalMs: opts.pingIntervalMs } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  })
  const app = new Hono()
  app.route('/api/stream', gateway.app)
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  const upgrades: boolean[] = []
  server.on('upgrade', (req, socket: Duplex, head) => { upgrades.push(gateway.handleUpgrade(req, socket, head)) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push({
    close: () => {
      ;(server as unknown as import('node:http').Server).closeAllConnections?.()
      return new Promise<void>((resolve) => (server as unknown as import('node:http').Server).close(() => resolve()))
    },
  })
  return { port: (server.address() as AddressInfo).port, upgrades }
}

const json = async (port: number, method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

/** 一个「冻住的」设备：手工完成 WS 握手、发一帧 hello，之后什么都不回（不回 pong）。 */
async function frozenDevice(port: number, token: string, hello: Record<string, unknown>): Promise<void> {
  const { connect } = await import('node:net')
  const sock = connect(port, '127.0.0.1')
  await new Promise<void>((resolve) => sock.once('connect', resolve))
  const key = randomBytes(16).toString('base64')
  sock.write(
    `GET /api/stream/host HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
    `Sec-WebSocket-Protocol: ${HOST_RELAY_PROTOCOL}, ${token}\r\n\r\n`,
  )
  await new Promise<void>((resolve) => {
    const on = (buf: Buffer) => { if (buf.includes('101')) { sock.off('data', on); resolve() } }
    sock.on('data', on)
  })
  // 一帧带掩码的 text frame（client→server 必须掩码）；hello 一百多字节，走 126 扩展长度形状。
  const payload = Buffer.from(JSON.stringify({ type: 'hello', ...hello }))
  const mask = randomBytes(4)
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!))
  const head = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff])
  sock.write(Buffer.concat([head, mask, masked]))
}

describe('deviceGateway（宿主自建 server + Hono，basePath /api/stream）', () => {
  it('isAdmin=false 管理口 403；true 时签码 → 配对 → WS 握手 → onChange 设备上下线；handleUpgrade 让出别人的路径', async () => {
    const stream = await tempStream()
    let admin = false
    const { port, upgrades } = await hostApp(stream, { isAdmin: () => admin })
    const changes: DeviceChange[] = []
    stream.devices.onChange((c) => changes.push(c))

    // 没有管理鉴权：签配对码被拒
    expect((await json(port, 'POST', '/api/stream/devices/pairing-code')).status).toBe(403)
    admin = true
    const code = await json(port, 'POST', '/api/stream/devices/pairing-code')
    expect(code.status).toBe(200)
    // 配对码回执里的地址来自宿主的 backendUrls（二维码第一项里也带）
    expect(JSON.parse((code.body!.qr as string[])[0]!).backends).toEqual(['http://198.51.100.7:1234'])

    // 设备用一次性码换 token，经宿主的 server 连 /api/stream/host
    const pair = await json(port, 'POST', '/api/stream/devices/pair', { code: code.body!.code, name: '测试机', platform: 'linux' })
    expect(pair.status).toBe(200)
    const deviceId = pair.body!.deviceId as string
    const token = pair.body!.deviceToken as string

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream/host`, [HOST_RELAY_PROTOCOL, token])
    await new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
    ws.send(JSON.stringify({ type: 'hello', deviceId, platform: 'linux', name: '测试机', agentVersion: '1.0.0', ops: ['browser.tabs'] }))
    await vi.waitFor(() => {
      expect(changes).toContainEqual({ kind: 'device', deviceId, name: '测试机', platform: 'linux', online: true, at: expect.any(Number) })
    })
    // 快照：启动时先读一次的口
    expect(stream.devices.online().devices.map((d) => d.deviceId)).toContain(deviceId)
    ws.close()
    await vi.waitFor(() => {
      expect(changes).toContainEqual({ kind: 'device', deviceId, name: '测试机', platform: 'linux', online: false, at: expect.any(Number) })
    })

    // 别人的路径（这里没有兜底者）：handleUpgrade 返回 false；socket 没人接、客户端悬着——
    // 所以只断言认领结果，不等客户端报错。
    const before = upgrades.length
    const stranger = new WebSocket(`ws://127.0.0.1:${port}/api/stream/other`)
    // 悬着的握手没人应答：客户端稍后自己报 error，吞掉（我们断言的是服务端让出了路径）。
    stranger.on('error', () => {})
    await new Promise((r) => setTimeout(r, 400))
    expect(upgrades.slice(before)).toEqual([false])
    stranger.terminate()
  })

  it('扩展绑定：签 ext 配对码 → ext/pair → 连 /api/stream/ext → binding online；新连接顶掉旧连接只发一次 online', async () => {
    const stream = await tempStream()
    const { port } = await hostApp(stream, { isAdmin: () => true })
    const changes: DeviceChange[] = []
    stream.devices.onChange((c) => changes.push(c))

    // 先有一台已配对设备
    const code = await json(port, 'POST', '/api/stream/devices/pairing-code')
    const pair = await json(port, 'POST', '/api/stream/devices/pair', { code: code.body!.code, name: '测试机', platform: 'linux' })
    const deviceId = pair.body!.deviceId as string

    const extCode = await json(port, 'POST', `/api/stream/devices/${deviceId}/ext-pairing-code`)
    expect(extCode.status).toBe(200)
    expect(extCode.body!.backends).toEqual(['http://198.51.100.7:1234'])
    const extPair = await json(port, 'POST', '/api/stream/ext/pair', { code: extCode.body!.code }, { origin: `chrome-extension://${STREAM_EXTENSION_ID}` })
    expect(extPair.status).toBe(200)
    const bindingId = extPair.body!.bindingId as string
    const token = extPair.body!.token as string

    const open1 = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream/ext`, [EXT_RELAY_PROTOCOL, token], { origin: `chrome-extension://${STREAM_EXTENSION_ID}` })
      ws.on('open', () => resolve(ws)); ws.on('error', reject)
    })
    await vi.waitFor(() => {
      expect(changes).toContainEqual({ kind: 'binding', bindingId, deviceId, online: true, at: expect.any(Number) })
    })
    const onlineCount = () => changes.filter((c) => c.kind === 'binding' && c.bindingId === bindingId && c.online).length

    // 新连接顶掉旧连接：只多一条 online，旧连接随后关闭不再发 offline
    const open2 = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream/ext`, [EXT_RELAY_PROTOCOL, token], { origin: `chrome-extension://${STREAM_EXTENSION_ID}` })
      ws.on('open', () => resolve(ws)); ws.on('error', reject)
    })
    await vi.waitFor(() => expect(open2.readyState).toBe(WebSocket.OPEN))
    await new Promise((r) => setTimeout(r, 100))
    expect(onlineCount()).toBe(1)
    open1.close()
    await new Promise((r) => setTimeout(r, 100))
    expect(changes.some((c) => c.kind === 'binding' && c.bindingId === bindingId && !c.online)).toBe(false)
    // 快照里这条绑定在线
    expect(stream.devices.online().bindings.map((b) => b.bindingId)).toContain(bindingId)
    open2.close()
    await vi.waitFor(() => {
      expect(changes).toContainEqual({ kind: 'binding', bindingId, deviceId, online: false, at: expect.any(Number) })
    })
  })

  it('心跳：不回 pong 的设备在两个周期内 offline（pingIntervalMs 小值）', async () => {
    const stream = await tempStream()
    const { port } = await hostApp(stream, { isAdmin: () => true, pingIntervalMs: 50 })
    const changes: DeviceChange[] = []
    stream.devices.onChange((c) => changes.push(c))

    const code = await json(port, 'POST', '/api/stream/devices/pairing-code')
    const pair = await json(port, 'POST', '/api/stream/devices/pair', { code: code.body!.code, name: '冻住的机器', platform: 'linux' })
    const deviceId = pair.body!.deviceId as string
    const token = pair.body!.deviceToken as string

    await frozenDevice(port, token, { deviceId, platform: 'linux', name: '冻住的机器', agentVersion: '1.0.0', ops: [] })
    await vi.waitFor(() => {
      expect(changes).toContainEqual({ kind: 'device', deviceId, name: '冻住的机器', platform: 'linux', online: true, at: expect.any(Number) })
    })
    // 不回 pong：keepRelayAlive 两个周期内判死 → close → offline
    await vi.waitFor(() => {
      expect(changes).toContainEqual({ kind: 'device', deviceId, name: '冻住的机器', platform: 'linux', online: false, at: expect.any(Number) })
    }, { timeout: 2000 })
  })

  it('网关日志里没有设备 token 与配对码（签码、配对、连上、断开各走一遍）', async () => {
    const stream = await tempStream()
    const lines: string[] = []
    const { port } = await hostApp(stream, { isAdmin: () => true, log: (l) => lines.push(l) })
    const code = await json(port, 'POST', '/api/stream/devices/pairing-code')
    const pair = await json(port, 'POST', '/api/stream/devices/pair', { code: code.body!.code, name: '测试机', platform: 'linux' })
    const token = pair.body!.deviceToken as string
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream/host`, [HOST_RELAY_PROTOCOL, token])
    await new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
    ws.send(JSON.stringify({ type: 'hello', deviceId: pair.body!.deviceId, platform: 'linux', name: '测试机', agentVersion: '1.0.0', ops: [] }))
    await new Promise((r) => setTimeout(r, 200))
    ws.close()
    await new Promise((r) => setTimeout(r, 100))
    const all = lines.join('\n')
    expect(all).not.toContain(token)
    expect(all).not.toContain(String(code.body!.code))
    // 连接建立与断开在日志里看得见（帮排查），但只带 origin 不带凭证
    expect(all).toContain('device connected')
  })
})
