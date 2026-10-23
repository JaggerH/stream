import { describe, it, expect } from 'vitest'
import { assertDeviceReady, assertRecipeRunnable, makeFacilityPlacement, pickBrowser, resolvePlacement, unavailableBindings } from './placement.ts'
import { DeviceIncapable, DeviceOffline } from './errors.ts'
import { runOnDevice } from './run-context.ts'

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

describe('pickBrowser（一次执行选一次扩展绑定，design D7）', () => {
  const NAS = { deviceId: 'linux:nas', allowHosts: [] }
  const seq = (...ids: string[]) => {
    let i = 0
    return { pick: (_dev: string) => ids[i++] ?? 'exhausted' }
  }
  it('执行之外 = 本机此刻的默认节点，不钉（browser-identity D2）', () => {
    const r = seq('local:node_a', 'local:node_b')
    expect(pickBrowser(r)).toBe('local:node_a')
    expect(pickBrowser(r)).toBe('local:node_b')
  })
  it('本机上的执行：钉住第一次选中的在线节点', async () => {
    const r = { ...seq('local:node_a', 'local:node_b'), isOnline: () => true }
    await runOnDevice({ deviceId: 'local', allowHosts: [] }, async () => {
      expect(pickBrowser(r)).toBe('local:node_a')
      expect(pickBrowser(r)).toBe('local:node_a')
    })
  })
  it('本机没有在线节点时回兼容槽，但不钉——唤起之后连上的节点要能接住这次执行', async () => {
    const online = new Set<string>()
    const r = { pick: () => (online.size ? [...online][0]! : 'local'), isOnline: (id: string) => online.has(id) }
    await runOnDevice({ deviceId: 'local', allowHosts: [] }, async () => {
      expect(pickBrowser(r)).toBe('local')
      online.add('local:node_a')
      expect(pickBrowser(r)).toBe('local:node_a')
      online.add('local:node_b')
      expect(pickBrowser(r)).toBe('local:node_a')
    })
  })
  it('keeps the first pick for the whole run', async () => {
    const r = seq('ext:a', 'ext:b')
    await runOnDevice(NAS, async () => {
      expect(pickBrowser(r)).toBe('ext:a')
      await new Promise((res) => setTimeout(res, 1))
      expect(pickBrowser(r)).toBe('ext:a')
    })
  })
  it('两次执行各选各的', async () => {
    const r = seq('ext:a', 'ext:b')
    await runOnDevice(NAS, async () => expect(pickBrowser(r)).toBe('ext:a'))
    await runOnDevice(NAS, async () => expect(pickBrowser(r)).toBe('ext:b'))
  })
  it('registry 的 DeviceIncapable / DeviceOffline 原样抛出', async () => {
    const no = { pick: () => { throw new DeviceIncapable('linux:nas', 'browser') } }
    await expect(runOnDevice(NAS, async () => pickBrowser(no))).rejects.toBeInstanceOf(DeviceIncapable)
    const off = { pick: () => { throw new DeviceOffline('linux:nas') } }
    await expect(runOnDevice(NAS, async () => pickBrowser(off))).rejects.toBeInstanceOf(DeviceOffline)
  })
})

describe('assertRecipeRunnable', () => {
  const NAS = { deviceId: 'linux:nas', allowHosts: [] }
  it('浏览器类 recipe 在远程设备上：没接 registry 就 fail closed', () => {
    expect(() => assertRecipeRunnable(NAS, 'browser')).toThrow(DeviceIncapable)
  })
  it('接了 registry：设备上有在线绑定就放行', async () => {
    await runOnDevice(NAS, async () => expect(() => assertRecipeRunnable(NAS, 'browser', undefined, { pick: () => 'ext:a' })).not.toThrow())
  })
  it('接了 registry：没有绑定照样 DeviceIncapable', async () => {
    const no = { pick: () => { throw new DeviceIncapable('linux:nas', 'browser') } }
    await expect(runOnDevice(NAS, async () => assertRecipeRunnable(NAS, 'browser', undefined, no))).rejects.toBeInstanceOf(DeviceIncapable)
  })
  it('桌面 recipe 仍不派到远程设备', () => {
    expect(() => assertRecipeRunnable(NAS, 'desktop', undefined, { pick: () => 'ext:a' })).toThrow(DeviceIncapable)
  })
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
