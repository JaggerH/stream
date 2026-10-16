import { describe, it, expect } from 'vitest'
import { assertDeviceReady, assertLocalBrowser, makeFacilityPlacement, resolvePlacement, unavailableBindings } from './placement.ts'
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

describe('assertLocalBrowser', () => {
  it('local 放行', () => expect(() => assertLocalBrowser({ deviceId: 'local', allowHosts: [] })).not.toThrow())
  it('远程设备 fail-closed', () => expect(() => assertLocalBrowser({ deviceId: 'linux:nas', allowHosts: [] })).toThrow(DeviceIncapable))
})

describe('makeFacilityPlacement（采集与调度器共用的同一个解析器）', () => {
  const network = (f: string) => (f === 'eastmoney' ? { packageId: 'em', facility: 'eastmoney', hosts } : undefined)
  const resolve = makeFacilityPlacement({ bindings: { get: binding }, network })
  it('facility 绑到设备：设备 + 包声明的主机', () => {
    expect(resolve('eastmoney')).toEqual({ deviceId: 'linux:nas', allowHosts: hosts })
  })
  it('没有 facility：local，不查绑定', () => {
    expect(resolve(undefined)).toEqual({ deviceId: 'local', allowHosts: [] })
  })
})

describe('unavailableBindings（绑定表打不开）', () => {
  const b = unavailableBindings()
  it('任何有 facility 的执行都拒绝——宁可失败，也不在错误的位置下单', () => {
    expect(() => resolvePlacement({ facility: 'eastmoney', binding: (f) => b.get(f), hosts })).toThrow(/设备绑定表不可用/)
  })
  it('没有 facility 的执行照常 local', () => {
    expect(resolvePlacement({ binding: (f) => b.get(f), hosts: [] }).deviceId).toBe('local')
  })
  it('任务显式指定了设备：不查绑定表', () => {
    expect(resolvePlacement({ taskDevice: 'linux:nas', facility: 'eastmoney', binding: (f) => b.get(f), hosts }).deviceId).toBe('linux:nas')
  })
})
