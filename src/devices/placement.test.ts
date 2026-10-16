import { describe, it, expect } from 'vitest'
import { assertDeviceReady, resolvePlacement } from './placement.ts'
import { DeviceIncapable, DeviceOffline } from './errors.ts'

const bindings: Record<string, string> = { eastmoney: 'linux:nas' }
const binding = (f: string) => bindings[f]
const hosts = ['eastmoneysec.com']

describe('resolvePlacement', () => {
  it('任务覆盖优先', () => {
    expect(resolvePlacement({ taskDevice: 'windows:pc', facility: 'eastmoney', binding, hosts }).deviceId).toBe('windows:pc')
  })
  it('没有覆盖就跟随 facility', () => {
    expect(resolvePlacement({ facility: 'eastmoney', binding, hosts })).toEqual({ deviceId: 'linux:nas', allowHosts: hosts })
  })
  it('都没有就是 local', () => {
    expect(resolvePlacement({ facility: 'xueqiu', binding, hosts: [] }).deviceId).toBe('local')
    expect(resolvePlacement({ binding, hosts: [] }).deviceId).toBe('local')
  })
})

describe('assertDeviceReady', () => {
  const dir = {
    isOnline: (id: string) => id === 'linux:nas',
    hasOp: (id: string, op: string) => id === 'linux:nas' && op === 'http.fetch',
  }
  it('local 永远就绪', () => expect(() => assertDeviceReady({ deviceId: 'local', allowHosts: [] }, dir, 'browser')).not.toThrow())
  it('离线', () => expect(() => assertDeviceReady({ deviceId: 'android:p', allowHosts: [] }, dir, 'http.fetch')).toThrow(DeviceOffline))
  it('能力不足', () => expect(() => assertDeviceReady({ deviceId: 'linux:nas', allowHosts: [] }, dir, 'browser')).toThrow(DeviceIncapable))
  it('就绪', () => expect(() => assertDeviceReady({ deviceId: 'linux:nas', allowHosts: [] }, dir, 'http.fetch')).not.toThrow())
})
