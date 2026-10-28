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
import type { HarvestService } from '../kernel/plugins/harvest.ts'

/** 设备 / 绑定的上下线事件（openspec `embeddable-device-gateway`）。由两条中继注册表在连接建立 /
 *  断开时发出；同一设备新连接顶掉旧连接只发一次 online。 */
export type DeviceChange =
  | { kind: 'device'; deviceId: string; name: string; platform: string; online: boolean; at: number }
  | { kind: 'binding'; bindingId: string; deviceId: string; nodeId?: string; online: boolean; at: number }

/** `online()` 的快照：嵌入方启动时先读一次再订阅 `onChange`。 */
export interface DeviceSnapshot {
  devices: Array<{ deviceId: string; name: string; platform: string }>
  bindings: Array<{ bindingId: string; deviceId: string; nodeId?: string }>
}

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
  /**
   * 设备 / 绑定的上下线事件（openspec `embeddable-device-gateway`）。接线发生在 bootstrap 装好
   * harvest 域之后（`wireDeviceChanges`），所以接线前的快照是空的——`createStream` 返回前就接线了，
   * 正常调用方看不到那个窗口。监听器抛错只记日志，不影响连接。
   */
  onChange(listener: (c: DeviceChange) => void): () => void
  /** 当前在线的设备与绑定（启动时先读一次再订阅 `onChange`）。 */
  online(): DeviceSnapshot
}

/**
 * 把两条中继注册表的连接事件折成统一的 {@link DeviceChange}，接进 `openDevices` 建的汇点。
 * 在 `createStream` 里 bootstrap 之后调一次；`off` 不需要——注册表随内核关停一起消失。
 */
export function wireDeviceChanges(devices: StreamDevices, harvest: HarvestService, log: (line: string) => void): void {
  const listeners = new Set<(c: DeviceChange) => void>()
  // bootstrap 期间（正常时序不存在）已经订阅的，一并转入正式名单。
  for (const l of earlyListeners.get(devices)?.splice(0) ?? []) listeners.add(l)
  const emit = (c: DeviceChange) => {
    for (const fn of listeners) {
      try { fn(c) } catch (e) {
        // 监听器抛错只记日志：连接本身不该为一个旁观者背锅。
        log(`[devices] change listener threw: ${errText(e)}`)
      }
    }
  }
  harvest.hostRelays.onChange((ch) =>
    emit({ kind: 'device', deviceId: ch.deviceId, name: ch.name, platform: ch.platform, online: ch.online, at: ch.at }))
  harvest.extRelays.onChange((ch) => {
    if (ch.deviceId === undefined) return
    emit({ kind: 'binding', bindingId: ch.bindingId, deviceId: ch.deviceId, ...(ch.nodeId ? { nodeId: ch.nodeId } : {}), online: ch.online, at: ch.at })
  })
  devices.onChange = (listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  devices.online = (): DeviceSnapshot => ({
    devices: harvest.hostRelays.devices().map((d) => ({ deviceId: d.hello.deviceId, name: d.hello.name, platform: d.hello.platform })),
    bindings: harvest.extRelays.statuses()
      .filter((s) => s.online && s.deviceId !== '?')
      .map((s) => ({ bindingId: s.bindingId, deviceId: s.deviceId, ...(harvest.extRelays.nodeOf(s.bindingId) ? { nodeId: harvest.extRelays.nodeOf(s.bindingId) } : {}) })),
  })
}

/** 接线前的订阅落这里（`wireDeviceChanges` 接上时一并转入正式监听名单）。正常时序下是空的。 */
const earlyListeners = new WeakMap<StreamDevices, Array<(c: DeviceChange) => void>>()

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
  const devices: StreamDevices = {
    deviceStore,
    extBindings,
    ...(facilityDevices ? { facilityDevices } : {}),
    facilityBindings,
    ...(nodes ? { nodes } : {}),
    ...(identities ? { identities } : {}),
    // bootstrap 装好 harvest 域之前（`wireDeviceChanges` 还没跑）的过渡实现：订阅先收着，
    // 快照诚实回空。createStream 返回前一定接线，调用方看不到这个窗口。
    onChange: (listener) => {
      const early = earlyListeners.get(devices)!
      early.push(listener)
      return () => { const i = early.indexOf(listener); if (i !== -1) early.splice(i, 1) }
    },
    online: () => ({ devices: [], bindings: [] }),
  }
  earlyListeners.set(devices, [])
  return devices
}
