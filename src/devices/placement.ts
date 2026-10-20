/** 一次执行在哪台设备上：任务覆盖 → facility 默认设备 → local。执行开始时解析一次，之后不变。 */
import { DeviceIncapable, DeviceOffline } from './errors.ts'
import { LOCAL_BINDING, LOCAL_DEVICE, currentPlacement, type RunPlacement } from './run-context.ts'

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

/** facility → 默认设备的读口（`FacilityDeviceStore` 满足它；表打不开时换成 `unavailableBindings`）。 */
export interface FacilityBindings {
  get(facility: string): string | undefined
}

/**
 * 绑定表打不开（文件锁 / 损坏）时的替身：**查就抛**。不能当成「没有绑定 = 全部本机」——
 * 用户把东财绑在大陆的 NAS 上，表一坏就改从加州的本机下单，那正是这套设计要防的事。
 * 没有 facility 的执行根本不查绑定（`resolvePlacement`），照常 local。
 */
export function unavailableBindings(): FacilityBindings {
  return {
    get() {
      throw new Error('设备绑定表不可用——拒绝执行，以免在错误的位置下单')
    },
  }
}

/**
 * 源 facility → placement。ReplayAdapter 与调度器共用**同一个**解析器（各写一份迟早会分叉：
 * 一边按 facility 派到 NAS、另一边仍在本机）。包的主机声明调用时才取——热装卸会变。
 */
export function makeFacilityPlacement(deps: {
  bindings: FacilityBindings
  network: (facility: string) => PackageNetwork | undefined
}): (facility: string | undefined) => RunPlacement {
  return (facility) => resolvePlacement({
    facility,
    binding: (f) => deps.bindings.get(f),
    hosts: facility ? deps.network(facility)?.hosts ?? [] : [],
  })
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

/** 设备 → 它上面的一条在线扩展绑定（`ExtRelayRegistry` 满足它）。没有绑定 / 都离线时抛。 */
export interface BrowserPicker {
  pick(deviceId: string): string
}

/**
 * 本次执行用哪个扩展绑定（design D7）。第一次问时选、记在执行上下文的 `browser` 记号上，之后整次
 * 执行不变——中途新连上的 Chrome 不会把一半的登录切到另一个浏览器里。没有执行上下文（面板、MCP
 * 工具）或执行在 `local` 上 = 本机扩展。
 */
export function pickBrowser(reg: BrowserPicker): string {
  const p = currentPlacement()
  if (p.deviceId === LOCAL_DEVICE) return LOCAL_BINDING
  if (p.browser?.bindingId) return p.browser.bindingId
  const id = reg.pick(p.deviceId)
  if (p.browser) p.browser.bindingId = id
  return id
}

/**
 * 一条 recipe 能不能在这个 placement 上跑，在任何出站、唤起浏览器、发帧之前判。
 * - `http` / `html`：只走 `fetchFor`，要设备有 `http.fetch`（`ready`）。
 * - `desktop`：第一版不把桌面 recipe 派到绑定设备（spec「无界面设备不接 UI recipe」）——
 *   不判就会在本机桌面上点，结果却记在设备名下。
 * - 其余（`browser` / `fetch` 会话类）：要设备上有在线的扩展绑定（`browsers`，同时把这次执行的
 *   绑定选定）。没接 `browsers` 的调用点 fail closed：宁可失败，也不在本机 Chrome 里替远程设备登录。
 */
export function assertRecipeRunnable(
  p: RunPlacement,
  kind: string,
  ready?: (p: RunPlacement, need: string) => void,
  browsers?: BrowserPicker,
): void {
  if (p.deviceId === LOCAL_DEVICE) return
  if (kind === 'http' || kind === 'html') { ready?.(p, 'http.fetch'); return }
  if (kind === 'desktop') throw new DeviceIncapable(p.deviceId, 'desktop')
  if (!browsers) throw new DeviceIncapable(p.deviceId, 'browser')
  pickBrowser(browsers)
}
