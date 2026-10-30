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

  // 撤销绑定先删表行、后 kick 连接：kick 发 offline 事件时表里已经查不到这条绑定了，
  // 事件必须仍带 deviceId（嵌入方按 deviceId 折叠上下线，丢了这个字段事件就等于没发）。
  it('offline events carry the device a binding belonged to at connect time, even after the store row is gone', () => {
    const changes: Array<{ bindingId: string; deviceId?: string; online: boolean }> = []
    const bindings: Record<string, string> = { 'ext:a': 'linux:nas' }
    const reg = make(bindings)
    reg.onChange((ch) => changes.push(ch))
    const s = sock()
    reg.connect('ext:a', s)
    delete bindings['ext:a'] // 模拟「先撤销、后 kick」：deviceOf 已查不出这条绑定
    reg.disconnect('ext:a', s)
    expect(changes.at(-1)).toMatchObject({ bindingId: 'ext:a', deviceId: 'linux:nas', online: false })
  })

  // 设备挂起醒来时，绑定往往在服务端判死之前就重连上了——那条旧 socket 还半开着。新握手必须
  // **发一条 online**（嵌入方可能已被压成离线），并当场关掉旧的半开连接，不等心跳。
  it('a reconnect that replaces a half-open socket still emits online, and closes the old one', () => {
    const changes: Array<{ bindingId: string; online: boolean }> = []
    const reg = make({ 'ext:a': 'linux:nas' })
    reg.onChange((ch) => changes.push(ch))
    const closed: Array<[number, string]> = []
    const a = { send: () => {}, close: (code: number, reason: string) => void closed.push([code, reason]) }
    reg.connect('ext:a', a)
    reg.connect('ext:a', sock())
    expect(changes.filter((c) => c.online).map((c) => c.bindingId)).toEqual(['ext:a', 'ext:a'])
    expect(closed).toEqual([[1001, 'replaced by a newer connection']])
    // 被顶掉的旧 socket 随后关闭：不发 offline（它已经不是当前那条了）
    reg.disconnect('ext:a', a)
    expect(changes.at(-1)?.online).toBe(true)
  })

  it('kick after the store row is gone still names the device', () => {
    const changes: Array<{ bindingId: string; deviceId?: string; online: boolean }> = []
    const bindings: Record<string, string> = { 'ext:a': 'linux:nas' }
    const reg = make(bindings)
    reg.onChange((ch) => changes.push(ch))
    reg.connect('ext:a', sock())
    delete bindings['ext:a']
    expect(reg.kick('ext:a', 4003, 'revoked')).toBe(true)
    expect(changes.at(-1)).toMatchObject({ bindingId: 'ext:a', deviceId: 'linux:nas', online: false })
  })
})
