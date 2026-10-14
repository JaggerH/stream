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
