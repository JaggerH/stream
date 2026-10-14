import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { attachHostRelay, HOST_RELAY_PROTOCOL, STALE_HOST_PROTOCOL } from './host-relay.ts'
import { HostRelayRegistry } from './host-registry.ts'

const TOKEN = 'secret-token'
const helloFrame = { type: 'hello', deviceId: 'desktop:pc', platform: 'windows', name: 'PC', agentVersion: '0.1.0', ops: ['find'] }

let server: Server | undefined
afterEach(async () => {
  const s = server
  server = undefined
  if (s) await new Promise<void>((r) => s.close(() => r()))
})

async function start(helloTimeoutMs = 2000) {
  server = createServer()
  const registry = new HostRelayRegistry()
  attachHostRelay(server, registry, { token: TOKEN, log: () => {}, helloTimeoutMs })
  const srv = server
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const url = `ws://127.0.0.1:${(srv.address() as AddressInfo).port}/api/host`
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

  it('an offer that includes v1 alongside v2 still gets the 426', async () => {
    const { url } = await start()
    const ws = new WebSocket(url, [STALE_HOST_PROTOCOL, HOST_RELAY_PROTOCOL, TOKEN])
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

  it('a same-device reconnect routes ops to the newest socket and survives the old one closing', async () => {
    const { registry, url } = await start()
    const a = new WebSocket(url, [HOST_RELAY_PROTOCOL, TOKEN])
    await new Promise((r) => a.on('open', r))
    a.send(JSON.stringify(helloFrame))
    await until(() => registry.devices().length === 1)
    const b = new WebSocket(url, [HOST_RELAY_PROTOCOL, TOKEN])
    await new Promise((r) => b.on('open', r))
    const aGot: string[] = []
    a.on('message', (d) => aGot.push(d.toString()))
    const bGot = new Promise<string>((r) => b.once('message', (d) => r(d.toString())))
    b.send(JSON.stringify(helloFrame))
    await new Promise((r) => setTimeout(r, 50))
    expect(registry.devices()).toHaveLength(1)
    const p = registry.deviceFor('desktop')!.relay.send({ op: 'find' })
    const frame = JSON.parse(await bGot)
    expect(frame.op).toBe('find')
    expect(aGot).toHaveLength(0)
    b.send(JSON.stringify({ id: frame.id, result: ['ok'] }))
    await expect(p).resolves.toEqual(['ok'])
    a.close()
    await new Promise((r) => a.on('close', r))
    await new Promise((r) => setTimeout(r, 50))
    expect(registry.devices()).toHaveLength(1)
    b.close()
    await until(() => registry.devices().length === 0)
    expect(registry.devices()).toHaveLength(0)
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
  it('a device revoked between upgrade and hello cannot register', async () => {
    const map: Record<string, string> = { 'dev-token': 'android:k80' }
    const seen: string[] = []
    const { registry, url } = await startWithDevices(map, seen)
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, 'dev-token'])
    await new Promise((r) => ws.on('open', r))
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    delete map['dev-token']
    ws.send(JSON.stringify(phoneHello('android:k80')))
    expect(await closed).toBe(4003)
    expect(registry.devices()).toHaveLength(0)
    expect(seen).toEqual([])
  })

  it('the shared secret cannot claim the android platform', async () => {
    const { registry, url } = await start()
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, TOKEN])
    await new Promise((r) => ws.on('open', r))
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    ws.send(JSON.stringify(phoneHello('android:k80')))
    expect(await closed).toBe(4003)
    expect(registry.devices()).toHaveLength(0)
  })

  it('frames after a closing 4003 are ignored', async () => {
    const { registry, url } = await startWithDevices({ 'dev-token': 'android:k80' })
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, 'dev-token'])
    await new Promise((r) => ws.on('open', r))
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    ws.send(JSON.stringify(phoneHello('android:wrong')))
    ws.send(JSON.stringify(phoneHello('android:k80')))
    expect(await closed).toBe(4003)
    await new Promise((r) => setTimeout(r, 50))
    expect(registry.devices()).toHaveLength(0)
  })

  it('a deviceAuth that throws is answered with 401', async () => {
    const srv = createServer()
    server = srv
    attachHostRelay(srv, new HostRelayRegistry(), {
      token: TOKEN, log: () => {}, deviceAuth: () => { throw new Error('boom') },
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const ws = new WebSocket(`ws://127.0.0.1:${(srv.address() as AddressInfo).port}/api/host`, [HOST_RELAY_PROTOCOL, 'dev-token'])
    const status = await new Promise<number>((r) => ws.on('unexpected-response', (_q, res) => r(res.statusCode ?? 0)))
    expect(status).toBe(401)
  })
})
