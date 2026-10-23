/**
 * 登录态的「槽位」（browser-identity D10）：一份快照归谁。
 *
 * - 节点：`<deviceId>/<nodeId>` → `data/cookies/<deviceId>/<nodeId>.json`。同一台电脑的两个 profile 各一份，
 *   互不覆盖——这是本 change 要的那条隔离。
 * - 设备：`<deviceId>` → `data/cookies/<deviceId>.json`。只剩说不出自己是哪个节点的连接用它：本机兼容槽
 *   （老扩展）、没记过节点的配对绑定，以及从没连过任何节点的设备（只有 `http.fetch` 的 Linux agent）。
 *
 * 槽位是字符串，好让 `CookieSource.fetch(key)` 与 provider 的缓存键都不用改形状。
 */
import { cleanNodeId } from '../../shared/browser-relay/handshake.ts'
import { pickBrowser, type BrowserPicker } from '../devices/placement.ts'
import { currentPlacement } from '../devices/run-context.ts'

export function cookieSlot(deviceId: string, nodeId?: string): string {
  return nodeId ? `${deviceId}/${nodeId}` : deviceId
}

/** 拆回（设备，节点）。最后一段不是节点 id 的形状 = 整个都是设备 id。 */
export function parseCookieSlot(slot: string): { deviceId: string; nodeId?: string } {
  const i = slot.lastIndexOf('/')
  const nodeId = i > 0 ? cleanNodeId(slot.slice(i + 1)) : undefined
  return nodeId ? { deviceId: slot.slice(0, i), nodeId } : { deviceId: slot }
}

export interface SlotBrowsers extends BrowserPicker {
  isOnline(bindingId: string): boolean
  deviceOf(bindingId: string): string | undefined
  nodeOf(bindingId: string): string | undefined
}

export function slotOfBinding(browsers: Pick<SlotBrowsers, 'deviceOf' | 'nodeOf'>, bindingId: string, fallbackDevice: string): string {
  return cookieSlot(browsers.deviceOf(bindingId) ?? fallbackDevice, browsers.nodeOf(bindingId))
}

export interface SlotNodes {
  forDevice(deviceId: string): Array<{ nodeId: string; isDefault: boolean; lastSeenAt: number }>
}

/**
 * 这一次读登录态读哪个槽位。和浏览器命令同一个答案（D10：`cookieFor` 读的是这次执行选定的节点）：
 *
 * 1. 这次执行已经钉了浏览器 → 那条绑定的节点。
 * 2. 否则问 `pickBrowser`（执行内会顺手钉住，纯 HTTP 的执行也由此带上节点）；选出来的在线 → 它的节点。
 * 3. 设备上一个在线的都没有（Chrome 关着）→ 设备的默认节点，再退到最近见过的节点。纯 HTTP 的执行在
 *    Chrome 关着时照样有登录态：快照在盘上，只是读哪一份要有个说法。不退到设备旧文件——那份可能是
 *    别的 profile 的。
 * 4. 设备从没连过节点 → 设备槽位（升级前的那份文件）。
 */
export function currentCookieSlot(browsers: SlotBrowsers, nodes?: SlotNodes): string {
  const p = currentPlacement()
  const pinned = p.browser?.bindingId
  if (pinned) return slotOfBinding(browsers, pinned, p.deviceId)
  let id: string | undefined
  try {
    id = pickBrowser(browsers)
  } catch {
    id = undefined // 设备没有浏览器 / 都离线：不是读登录态的错，往下退
  }
  if (id && browsers.isOnline(id)) return slotOfBinding(browsers, id, p.deviceId)
  const known = nodes?.forDevice(p.deviceId) ?? []
  const n = known.find((x) => x.isDefault) ?? [...known].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0]
  return cookieSlot(p.deviceId, n?.nodeId)
}
