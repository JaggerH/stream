/**
 * 每台设备一个 `CookiePuller`（design D4、D7）：经那台设备上的扩展绑定去取，写进那台设备的快照。
 *
 * 按设备缓存而不是每次 new：puller 自带「同一时刻只有一轮在飞」的去重，每次 new 就没有了。
 *
 * 取哪条绑定：在一次执行里 = 这次执行选定的那条（`pickBrowser`，与登录 recipe 跑在同一个 Chrome 里，
 * 登完取回的才是刚登上的那份）；执行之外（扩展刚连上、cookie 变了）= 设备上此刻最合适的那条。
 */
import { CookiePuller, type CookiePullTransport, type CookieSnapshot } from './cookie-puller.ts'
import { pickBrowser } from '../devices/placement.ts'
import { LOCAL_DEVICE, currentDeviceId } from '../devices/run-context.ts'
import type { DebugEntry } from '../debug.ts'

export interface DeviceCookiePullerDeps {
  /** 本机扩展那条中继（今天的行为，原样）。 */
  local: CookiePullTransport
  browsers: {
    pick(deviceId: string): string
    hasBrowser(deviceId: string): boolean
    relay(bindingId: string): Pick<CookiePullTransport, 'cookiePull'>
  }
  storeFor: (deviceId: string) => CookieSnapshot
  /** 这台设备该取哪些域。本机 = 今天的全集；远程设备只取绑到它的 facility 的域。 */
  requiredDomainsFor: (deviceId: string) => string[]
  log?: (line: string) => void
  report?: (entry: DebugEntry) => void
}

export function makeDeviceCookiePullers(deps: DeviceCookiePullerDeps): (deviceId: string) => CookiePuller {
  const pullers = new Map<string, CookiePuller>()
  return (deviceId) => {
    let p = pullers.get(deviceId)
    if (p) return p
    const relay: CookiePullTransport = deviceId === LOCAL_DEVICE ? deps.local : {
      get connected() { return deps.browsers.hasBrowser(deviceId) },
      cookiePull: (domains) => {
        const bindingId = currentDeviceId() === deviceId ? pickBrowser(deps.browsers) : deps.browsers.pick(deviceId)
        return deps.browsers.relay(bindingId).cookiePull(domains)
      },
    }
    p = new CookiePuller({
      relay,
      store: deps.storeFor(deviceId),
      requiredDomains: () => deps.requiredDomainsFor(deviceId),
      ...(deps.log && { log: deps.log }),
      ...(deps.report && { report: deps.report }),
    })
    pullers.set(deviceId, p)
    return p
  }
}
