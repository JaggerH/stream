/**
 * 设备 / 节点 / 身份这几张表（design D1 的 `devices`）：执行位置的真相源，实例的一部分。
 *
 * 都只依赖数据目录，要在 `bootstrap()` 之前建好——adapters / harvest / auth 几个域装配时就要它们。
 * 三张 sqlite 表与 TaskStore 同一个 `stream.db`。各自打不开时的降级不一样，理由写在各自那一格。
 */
import { join } from 'node:path'
import type { Context } from 'cordis'
import { DeviceStore } from '../devices/device-store.ts'
import { ExtBindingStore } from '../devices/ext-binding-store.ts'
import { FacilityDeviceStore } from '../devices/facility-devices.ts'
import { NodeStore } from '../devices/node-store.ts'
import { unavailableBindings, type FacilityBindings } from '../devices/placement.ts'
import { SiteIdentityStore } from '../identity/identity-store.ts'
import { errText } from '../err-text.ts'

export interface StreamDevices {
  /** 已配对设备（`devices.json`）。 */
  deviceStore: DeviceStore
  /** 扩展绑定（design D7）：别的机器上的 Chrome 用一次性码挂到某台已配对设备上。本机扩展不在表里。 */
  extBindings: ExtBindingStore
  /** facility → 默认设备。打不开 = undefined（绑定路由不挂）。 */
  facilityDevices?: FacilityDeviceStore
  /** 执行侧读的那一份：表开着就是它，打不开就是查就抛的替身。 */
  facilityBindings: FacilityBindings
  /** 浏览器节点（browser-identity D1）。打不开 = undefined。 */
  nodes?: NodeStore
  /** 站点身份（browser-identity D6）。打不开 = undefined。 */
  identities?: SiteIdentityStore
}

/** 建表；sqlite 句柄登记成内核 effect（先登记 = 关停时最后关，晚于所有吃它们的域）。 */
export function openDevices(stateDir: string, kernel: Context, log: (...args: unknown[]) => void): StreamDevices {
  const deviceStore = new DeviceStore(join(stateDir, 'devices.json'), { log })
  const extBindings = new ExtBindingStore(join(stateDir, 'ext-bindings.json'), { log })
  const streamDb = join(stateDir, 'stream.db')
  // 开不起来（文件锁/损坏）不让启动失败，但**不是**「没有绑定 = 全部本机」：用户把一个交易站点绑在异地的 NAS 上，
  // 表一坏就改从本机下单，正是这套设计要防的事。换成查就抛的替身——有 facility 的执行一律拒绝，
  // 没有 facility 的照常 local。绑定路由不挂（读写都无从谈起）。
  let facilityDevices: FacilityDeviceStore | undefined
  let facilityBindings: FacilityBindings
  try {
    facilityDevices = new FacilityDeviceStore(streamDb)
    facilityBindings = facilityDevices
  } catch (e) {
    log(`[stream] facility device bindings UNAVAILABLE — open failed: ${errText(e)}; runs of any facility will be refused until this is fixed`)
    facilityBindings = unavailableBindings()
  }
  // 节点表打不开就没有：本机多个 profile 照样各连各的，只是没有默认节点、不留节点记录——它不像 facility
  // 绑定那样决定「在哪儿下单」，没必要因此拒绝执行。
  let nodes: NodeStore | undefined
  try {
    nodes = new NodeStore(streamDb)
  } catch (e) {
    log(`[stream] browser nodes UNAVAILABLE — open failed: ${errText(e)}; profiles still connect, without defaults`)
  }
  // 身份表打不开就没有：不影响执行，只是答不出「哪个号」。
  let identities: SiteIdentityStore | undefined
  try {
    identities = new SiteIdentityStore(streamDb)
  } catch (e) {
    log(`[stream] site identities UNAVAILABLE — open failed: ${errText(e)}`)
  }
  // 搬进库入口之前这三条连接从没人关；同进程多实例时不关就是句柄泄漏。
  kernel.effect(() => () => {
    for (const s of [identities, nodes, facilityDevices]) { try { s?.close() } catch { /* 关一条失败不拖累其余 */ } }
  })
  return { deviceStore, extBindings, ...(facilityDevices ? { facilityDevices } : {}), facilityBindings, ...(nodes ? { nodes } : {}), ...(identities ? { identities } : {}) }
}
