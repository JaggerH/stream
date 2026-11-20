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

async function start(helloTimeoutMs = 2000, pingIntervalMs?: number, log: (line: string) => void = () => {}) {
  server = createServer()
  const registry = new HostRelayRegistry()
  attachHostRelay(server, registry, { token: TOKEN, log, helloTimeoutMs, ...(pingIntervalMs ? { pingIntervalMs } : {}) })
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

  it('a hello with a partly malformed capability manifest connects; the bad entries are dropped and logged once', async () => {
    const lines: string[] = []
    const { registry, url } = await start(2000, undefined, (l) => lines.push(l))
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, TOKEN])
    await new Promise((r) => ws.on('open', r))
    ws.send(JSON.stringify({ ...helloFrame, capsVersion: 1, caps: { 'ui.tree': { v: 1 }, 'ui.act': { v: 1, availability: 'later' }, 'screen.shot': { v: 0 } } }))
    await until(() => registry.devices().length === 1)
    expect(registry.devices()[0]!.hello.caps).toEqual({ 'ui.tree': { v: 1 } })
    const manifestLines = lines.filter((l) => l.includes('capability manifest'))
    expect(manifestLines).toHaveLength(1)
    expect(manifestLines[0]).toMatch(/ui\.act.*later/)
    ws.close()
  })

  it('a hello whose caps container has the wrong type still connects, without caps', async () => {
    const { registry, url } = await start()
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, TOKEN])
    await new Promise((r) => ws.on('open', r))
    ws.send(JSON.stringify({ ...helloFrame, capsVersion: 1, caps: ['ui.tree'] }))
    await until(() => registry.devices().length === 1)
    expect(registry.devices()).toHaveLength(1)
    expect(registry.devices()[0]!.hello).not.toHaveProperty('caps')
    ws.close()
  })

  it('a same-device reconnect routes ops to the newest socket and survives the old one closing', async () => {
    const { registry, url } = await start()
    const a = new WebSocket(url, [HOST_RELAY_PROTOCOL, TOKEN])
    await new Promise((r) => a.on('open', r))
    const aClosed = new Promise<number>((r) => a.on('close', (code) => r(code)))
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
    // 顶掉旧连接时服务端主动关它（1001），不等心跳——挂起醒来的那条半开连接不会一直占着
    await expect(aClosed).resolves.toBe(1001)
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

async function startWithDevices(
  mapOrAuth: Record<string, string> | ((t: string) => string | undefined),
  seen: string[] = [],
  onDeviceState?: (id: string, prev: unknown, next: unknown) => void,
) {
  const deviceAuth = typeof mapOrAuth === 'function' ? mapOrAuth : (t: string) => mapOrAuth[t]
  const srv = createServer()
  server = srv
  const registry = new HostRelayRegistry()
  attachHostRelay(srv, registry, {
    token: TOKEN, log: () => {}, helloTimeoutMs: 2000,
    deviceAuth,
    onDeviceSeen: (id) => void seen.push(id),
    onDeviceState,
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const url = `ws://127.0.0.1:${(srv.address() as AddressInfo).port}/api/host`
  return { registry, url }
}
const phoneHello = (deviceId: string) =>
  ({ type: 'hello', deviceId, platform: 'android', name: 'K80', agentVersion: '0.1.0', ops: ['click'] })
const iosHello = (deviceId: string) =>
  ({ type: 'hello', deviceId, platform: 'ios', name: 'iPhone', agentVersion: '0.3.0', ops: ['find'], iosVersion: '18.2', path: 'xctest-session' })

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

  it('a paired ios device connects with its token and keeps the ios facts its hello declared', async () => {
    const seen: string[] = []
    const { registry, url } = await startWithDevices({ 'ios-token': 'ios:p1' }, seen)
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, 'ios-token'])
    await new Promise((r) => ws.on('open', r))
    ws.send(JSON.stringify(iosHello('ios:p1')))
    await until(() => registry.devices().length === 1)
    // A phone surface, same as android: recipe target selection finds it by surface, not by OS.
    expect(registry.deviceFor('mobile')?.hello.deviceId).toBe('ios:p1')
    expect(registry.devices()[0]!.hello).toMatchObject({ platform: 'ios', iosVersion: '18.2', path: 'xctest-session' })
    expect(seen).toEqual(['ios:p1'])
    ws.close()
  })

  it('answers an android hello with the backend clock and leaves desktop agents alone', async () => {
    const { registry, url } = await startWithDevices({ 'dev-token': 'android:k80' }, [])
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, 'dev-token'])
    await new Promise((r) => ws.on('open', r))
    const got = new Promise<string>((r) => ws.once('message', (d) => r(String(d))))
    ws.send(JSON.stringify(phoneHello('android:k80')))
    const frame = JSON.parse(await got)
    expect(frame.type).toBe('time')
    expect(typeof frame.serverTime).toBe('number')
    expect(Math.abs(Date.now() - frame.serverTime)).toBeLessThan(5_000)
    await until(() => registry.devices().length === 1)
    // A desktop agent has no phone health to feed — the backend sends it no time frame.
    const ws2 = new WebSocket(url, [HOST_RELAY_PROTOCOL, TOKEN])
    await new Promise((r) => ws2.on('open', r))
    const desktopGot = new Promise<string>((r) => ws2.once('message', () => r('got-frame')))
    ws2.send(JSON.stringify(helloFrame))
    await until(() => registry.devices().length === 2)
    const raced = await Promise.race([desktopGot, new Promise<string>((r) => setTimeout(() => r('nothing'), 300))])
    expect(raced).toBe('nothing')
    ws.close()
    ws2.close()
  })

  it('routes state frames to the registry and to onDeviceState, not to the relay', async () => {
    const seenStates: Array<[string, unknown, unknown]> = []
    const { registry, url } = await startWithDevices(
      { 'dev-token': 'android:k80' }, [], (id, prev, next) => void seenStates.push([id, prev, next]))
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, 'dev-token'])
    await new Promise((r) => ws.on('open', r))
    ws.send(JSON.stringify(phoneHello('android:k80')))
    await until(() => registry.devices().length === 1)
    const relay = registry.deviceFor('android')!.relay
    let handled = 0
    const orig = relay.handleMessage.bind(relay)
    relay.handleMessage = (raw: string) => { handled++; orig(raw) }
    const state = { a11yEnabled: false, screenOn: true, keyguardLocked: false, battery: 40, charging: false }
    ws.send(JSON.stringify({ type: 'state', ...state }))
    await until(() => seenStates.length === 1)
    expect(seenStates[0]).toEqual(['android:k80', undefined, state])
    expect(registry.devices()[0].state?.a11yEnabled).toBe(false)
    expect(handled).toBe(0)
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

  it('a deviceAuth that throws at hello time fails closed with 1011, not a revoke', async () => {
    let calls = 0
    const seen: string[] = []
    const { registry, url } = await startWithDevices(() => {
      if (++calls === 1) return 'android:k80'
      throw new Error('store unavailable')
    }, seen)
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, 'dev-token'])
    await new Promise((r) => ws.on('open', r))
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    ws.send(JSON.stringify(phoneHello('android:k80')))
    expect(await closed).toBe(1011)
    await until(() => false)
    expect(calls).toBe(2)
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

  it('a linux device token with a linux hello connects', async () => {
    const seen: string[] = []
    const { registry, url } = await startWithDevices({ 'tok-linux': 'linux:abc' }, seen)
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, 'tok-linux'])
    await new Promise((r) => ws.on('open', r))
    ws.send(JSON.stringify({ ...phoneHello('linux:abc'), platform: 'linux', name: 'NAS', ops: ['http.fetch'] }))
    await until(() => registry.devices().length === 1)
    expect(registry.devices()[0].hello).toMatchObject({ deviceId: 'linux:abc', platform: 'linux' })
    expect(seen).toEqual(['linux:abc'])
    ws.close()
  })

  it('a device token whose hello id does not start with its platform is closed 4003', async () => {
    const { registry, url } = await startWithDevices({ 'tok-linux': 'linux:abc' })
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, 'tok-linux'])
    await new Promise((r) => ws.on('open', r))
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    ws.send(JSON.stringify(phoneHello('linux:abc')))
    expect(await closed).toBe(4003)
    expect(registry.devices()).toHaveLength(0)
  })

  it('the shared secret cannot claim the linux platform', async () => {
    const { registry, url } = await start()
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, TOKEN])
    await new Promise((r) => ws.on('open', r))
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    ws.send(JSON.stringify({ ...phoneHello('linux:abc'), platform: 'linux' }))
    expect(await closed).toBe(4003)
    expect(registry.devices()).toHaveLength(0)
  })

  it('the shared secret cannot claim the ios platform either — ios devices must pair', async () => {
    const { registry, url } = await start()
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, TOKEN])
    await new Promise((r) => ws.on('open', r))
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    ws.send(JSON.stringify(iosHello('ios:abc')))
    expect(await closed).toBe(4003)
    expect(registry.devices()).toHaveLength(0)
  })

  it('a device token cannot register as a desktop host', async () => {
    const seen: string[] = []
    const { registry, url } = await startWithDevices({ 'dev-token': 'android:k80' }, seen)
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, 'dev-token'])
    await new Promise((r) => ws.on('open', r))
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    ws.send(JSON.stringify({ ...phoneHello('android:k80'), platform: 'windows' }))
    expect(await closed).toBe(4003)
    expect(registry.devices()).toHaveLength(0)
    expect(registry.deviceFor('desktop')).toBeUndefined()
    expect(seen).toEqual([])
  })

  it('frames from a kicked socket no longer reach the relay', async () => {
    const { registry, url } = await startWithDevices({ 'dev-token': 'android:k80' })
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, 'dev-token'])
    await new Promise((r) => ws.on('open', r))
    ws.send(JSON.stringify(phoneHello('android:k80')))
    await until(() => registry.devices().length === 1)
    const relay = registry.deviceFor('android')!.relay
    let handled = 0
    const orig = relay.handleMessage.bind(relay)
    relay.handleMessage = (raw: string) => { handled++; orig(raw) }
    registry.kick('android:k80', 4003, 'revoked')
    expect(registry.devices()).toHaveLength(0)
    ws.send(JSON.stringify({ id: 1, result: [] }))
    await new Promise((r) => setTimeout(r, 50))
    expect(handled).toBe(0)
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

  it('a deviceAuth that throws is answered with 503 (an internal error is not a revoke)', async () => {
    const srv = createServer()
    server = srv
    attachHostRelay(srv, new HostRelayRegistry(), {
      token: TOKEN, log: () => {}, deviceAuth: () => { throw new Error('boom') },
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const ws = new WebSocket(`ws://127.0.0.1:${(srv.address() as AddressInfo).port}/api/host`, [HOST_RELAY_PROTOCOL, 'dev-token'])
    const status = await new Promise<number>((r) => ws.on('unexpected-response', (_q, res) => r(res.statusCode ?? 0)))
    expect(status).toBe(503)
  })
})

describe('attachHostRelay 心跳', () => {
  // 设备被冻住（虚拟机挂起、合盖、断网但没收到 FIN）时 TCP 不会关；不查 pong，设备会永远显示在线，
  // 派过去的 op 要等到超时才失败。
  it('不回 pong 的设备在两个心跳周期内被断开并移出在线表', async () => {
    const { registry, url } = await start(2000, 40)
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, TOKEN], { autoPong: false })
    ws.on('open', () => ws.send(JSON.stringify(helloFrame)))
    await until(() => registry.devices().length === 1)
    expect(registry.devices()).toHaveLength(1)
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
    await until(() => registry.devices().length === 0)
    expect(registry.devices()).toHaveLength(0)
    await closed
  })

  it('正常回 pong 的设备一直在线', async () => {
    const { registry, url } = await start(2000, 40)
    const ws = new WebSocket(url, [HOST_RELAY_PROTOCOL, TOKEN])
    ws.on('open', () => ws.send(JSON.stringify(helloFrame)))
    await until(() => registry.devices().length === 1)
    await new Promise((r) => setTimeout(r, 300))
    expect(registry.devices()).toHaveLength(1)
    ws.terminate()
  })
})
