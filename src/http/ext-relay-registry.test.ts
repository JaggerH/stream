import { describe, expect, it } from 'vitest'
import { ExtRelay } from './ext-relay.ts'
import { ExtRelayRegistry } from './ext-relay-registry.ts'
import { DeviceIncapable, DeviceOffline } from '../devices/errors.ts'

const sock = () => ({ send: () => {} })
const make = (bindings: Record<string, string>, defaults: Record<string, string> = {}) => {
  let t = 0
  const reg = new ExtRelayRegistry({
    local: new ExtRelay(),
    makeRelay: () => new ExtRelay(),
    deviceOf: (id) => bindings[id],
    bindingsOf: (dev) => Object.keys(bindings).filter((k) => bindings[k] === dev),
    defaultOf: (dev) => defaults[dev],
    now: () => ++t,
  })
  return reg
}

describe('ExtRelayRegistry', () => {
  it('local always picks local', () => {
    expect(make({}).pick('local')).toBe('local')
  })

  it('no binding on the device → device-incapable', () => {
    expect(() => make({}).pick('linux:nas')).toThrow(DeviceIncapable)
  })

  it('bindings exist but none online → device-offline', () => {
    expect(() => make({ 'ext:a': 'linux:nas' }).pick('linux:nas')).toThrow(DeviceOffline)
  })

  it('picks the most recently connected online binding of that device', () => {
    const reg = make({ 'ext:a': 'linux:nas', 'ext:b': 'linux:nas', 'ext:c': 'linux:pc' })
    reg.connect('ext:a', sock())
    reg.connect('ext:c', sock())
    reg.connect('ext:b', sock())
    expect(reg.pick('linux:nas')).toBe('ext:b')
    expect(reg.hasBrowser('linux:nas')).toBe(true)
  })

  it('the device default wins over a more recent connection while it is online', () => {
    const reg = make({ 'ext:a': 'linux:nas', 'ext:b': 'linux:nas' }, { 'linux:nas': 'ext:a' })
    reg.connect('ext:a', sock())
    reg.connect('ext:b', sock())
    expect(reg.pick('linux:nas')).toBe('ext:a')
  })

  it('an offline default falls back to the most recent online binding, not an error', () => {
    const reg = make({ 'ext:a': 'linux:nas', 'ext:b': 'linux:nas', 'ext:c': 'linux:nas' }, { 'linux:nas': 'ext:a' })
    reg.connect('ext:b', sock())
    reg.connect('ext:c', sock())
    expect(reg.pick('linux:nas')).toBe('ext:c')
  })

  it('a disconnected binding is skipped', () => {
    const reg = make({ 'ext:a': 'linux:nas', 'ext:b': 'linux:nas' })
    const a = sock()
    const b = sock()
    reg.connect('ext:a', a)
    reg.connect('ext:b', b)
    reg.disconnect('ext:b', b)
    expect(reg.pick('linux:nas')).toBe('ext:a')
  })

  it('kick rejects in-flight commands and closes the socket with the given code', async () => {
    const reg = make({ 'ext:a': 'linux:nas' })
    const closed: Array<[number, string]> = []
    reg.connect('ext:a', { send: () => {}, close: (c, r) => closed.push([c, r]) })
    const pending = reg.relay('ext:a').list()
    expect(reg.kick('ext:a', 4003, 'revoked')).toBe(true)
    await expect(pending).rejects.toThrow()
    expect(closed).toEqual([[4003, 'revoked']])
    expect(reg.isOnline('ext:a')).toBe(false)
  })

  it('relay(id) of an unknown binding throws instead of handing out a fresh relay', () => {
    expect(() => make({}).relay('ext:nope')).toThrow(/ext:nope/)
  })
})
