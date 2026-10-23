/**
 * 每个登录态槽位一个 `CookiePuller`（device-execution D4/D7，browser-identity D10）：经那个节点自己的扩展绑定
 * 去取，写进那个节点自己的快照。说不出节点的连接（本机兼容槽、老扩展的配对绑定）仍按设备一份。
 *
 * 按槽位缓存而不是每次 new：puller 自带「同一时刻只有一轮在飞」的去重，每次 new 就没有了。
 *
 * 取哪条绑定：节点槽位 = 那个节点的绑定（本机 `local:<nodeId>`，远程是记着这个 `nodeId` 的配对绑定），
 * 与登录 recipe 跑在同一个 Chrome 里，登完取回的才是刚登上的那份。设备槽位 = 本机兼容槽；远程设备上
 * 没记过节点的绑定里，执行内取这次执行选定的那条，执行外取任意一条在线的。
 */
import { CookiePuller, type CookiePullTransport, type CookieSnapshot } from './cookie-puller.ts'
import { parseCookieSlot } from './cookie-slot.ts'
import { LOCAL_BINDING, LOCAL_DEVICE, currentPlacement } from '../devices/run-context.ts'
import type { DebugEntry } from '../debug.ts'

export interface DeviceCookiePullerDeps {
  browsers: {
    bindingsOf(deviceId: string): string[]
    nodeOf(bindingId: string): string | undefined
    isOnline(bindingId: string): boolean
    relay(bindingId: string): Pick<CookiePullTransport, 'cookiePull'>
  }
  storeFor: (slot: string) => CookieSnapshot
  /**
   * 这个节点该取哪些域。本机 = 今天的全集；远程设备只取绑到它的 facility 的域。按节点传进来是给计划 4 的
   * 身份 / 环境目标留的口（解析到这个节点的 facility），今天只有设备目标，节点参数还不参与。
   */
  requiredDomainsFor: (deviceId: string, nodeId?: string) => string[]
  log?: (line: string) => void
  report?: (entry: DebugEntry) => void
}

export function makeDeviceCookiePullers(deps: DeviceCookiePullerDeps): (slot: string) => CookiePuller {
  const pullers = new Map<string, CookiePuller>()
  const { browsers } = deps
  /** 这个槽位此刻经哪条绑定取；没有可用的 = undefined（这一轮跳过，不碰快照）。 */
  const bindingFor = (deviceId: string, nodeId: string | undefined): string | undefined => {
    if (nodeId) return browsers.bindingsOf(deviceId).find((b) => browsers.nodeOf(b) === nodeId)
    if (deviceId === LOCAL_DEVICE) return LOCAL_BINDING
    const legacy = browsers.bindingsOf(deviceId).filter((b) => !browsers.nodeOf(b) && browsers.isOnline(b))
    const p = currentPlacement()
    const pinned = p.deviceId === deviceId ? p.browser?.bindingId : undefined
    return pinned && legacy.includes(pinned) ? pinned : legacy[0]
  }
  return (slot) => {
    let p = pullers.get(slot)
    if (p) return p
    const { deviceId, nodeId } = parseCookieSlot(slot)
    const relay: CookiePullTransport = {
      get connected() {
        const b = bindingFor(deviceId, nodeId)
        return b !== undefined && browsers.isOnline(b)
      },
      cookiePull: (domains) => {
        const b = bindingFor(deviceId, nodeId)
        if (!b) return Promise.reject(new Error(`没有可用的扩展绑定：${slot}`))
        return browsers.relay(b).cookiePull(domains)
      },
    }
    p = new CookiePuller({
      relay,
      store: deps.storeFor(slot),
      requiredDomains: () => deps.requiredDomainsFor(deviceId, nodeId),
      ...(deps.log && { log: deps.log }),
      ...(deps.report && { report: deps.report }),
    })
    pullers.set(slot, p)
    return p
  }
}
