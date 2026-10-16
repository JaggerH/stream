/** 一次执行在哪台设备上：任务覆盖 → facility 默认设备 → local。执行开始时解析一次，之后不变。 */
import { DeviceIncapable, DeviceOffline } from './errors.ts'
import { LOCAL_DEVICE, type RunPlacement } from './run-context.ts'

/** 包的执行位置相关声明：它的 facility 与允许访问的主机（`stream.network.hosts` ?? `stream.credentials`）。 */
export interface PackageNetwork {
  packageId: string
  facility: string
  hosts: readonly string[]
}

export function resolvePlacement(input: {
  taskDevice?: string
  facility?: string
  binding: (facility: string) => string | undefined
  hosts: readonly string[]
}): RunPlacement {
  const deviceId = input.taskDevice
    ?? (input.facility !== undefined ? input.binding(input.facility) : undefined)
    ?? LOCAL_DEVICE
  return { deviceId, allowHosts: input.hosts }
}

/** 派发前就把「去不了」说出来，不发任何帧。`local` 是后端本机，永远就绪。 */
export function assertDeviceReady(
  p: RunPlacement,
  dir: { isOnline(id: string): boolean; hasOp(id: string, op: string): boolean },
  need: string,
): void {
  if (p.deviceId === LOCAL_DEVICE) return
  if (!dir.isOnline(p.deviceId)) throw new DeviceOffline(p.deviceId)
  if (!dir.hasOp(p.deviceId, need)) throw new DeviceIncapable(p.deviceId, need)
}

/**
 * 浏览器通道（登录）目前只通本机——远程设备的浏览器中继在 device-browser-relay 接上。
 * 在那之前，绑定到远程设备的执行若在本机 Chrome 里登录，就是「PC 登录、NAS 下单」，宁可失败。
 */
export function assertLocalBrowser(p: RunPlacement): void {
  if (p.deviceId !== LOCAL_DEVICE) throw new DeviceIncapable(p.deviceId, 'browser')
}

/**
 * 一条 recipe 能不能在这个 placement 上跑，在任何出站、唤起浏览器、发帧之前判。
 * - `http` / `html`：只走 `fetchFor`，要设备有 `http.fetch`（`ready`）。
 * - `desktop`：第一版不把桌面 recipe 派到绑定设备（spec「无界面设备不接 UI recipe」）——
 *   不判就会在本机桌面上点，结果却记在设备名下。
 * - 其余（`browser` / `fetch` 会话类）：浏览器中继落地前一律只通本机，**不看设备声明的 op**——
 *   设备即便声明了 `browser`，采集也只会在本机 Chrome 上跑。
 */
export function assertRecipeRunnable(
  p: RunPlacement,
  kind: string,
  ready?: (p: RunPlacement, need: string) => void,
): void {
  if (p.deviceId === LOCAL_DEVICE) return
  if (kind === 'http' || kind === 'html') { ready?.(p, 'http.fetch'); return }
  if (kind === 'desktop') throw new DeviceIncapable(p.deviceId, 'desktop')
  assertLocalBrowser(p)
}
