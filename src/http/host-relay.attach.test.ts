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
