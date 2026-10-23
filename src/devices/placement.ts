/**
 * 一次执行落在哪里：任务覆盖 → facility 默认目标 → local。执行开始时解析一次，之后不变。
 * 目标有设备 / 身份 / 环境三种（browser-identity D7）：设备目标就地同步解；身份 / 环境目标交给
 * `IdentityRouter`（选节点、唤起、核对），它决定设备与扩展绑定。
 */
import { DeviceIncapable, DeviceOffline, IdentityOffline } from './errors.ts'
import { LOCAL_DEVICE, activePlacement, currentPlacement, type RunPlacement } from './run-context.ts'
import { LOCAL_TARGET, describeTarget, type Target } from './target.ts'
import type { IdentityRouter, RunPurpose } from '../identity/identity-router.ts'

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
  /** 完整的目标（设备 / 身份 / 环境，browser-identity D7）。没有它的实现只有设备目标。 */
  target?(facility: string): Target | undefined
  /** 全部绑定——远程设备的 cookie 域靠它反查（哪些 facility 绑到了这台）。表打不开时没有它。 */
  list?(): Array<{ facility: string; deviceId: string }>
  /** 全部目标（含身份 / 环境）：远程节点要交出哪些域也看它（browser-identity D10）。 */
  targets?(): Array<{ facility: string; target: Target }>
}

/**
 * 远程节点该交出哪些 facility 的登录态（D10）：绑到这台设备的，加上身份 / 环境目标会落到这个节点上的。
 * 身份目标在每个节点上都要——得先知道各节点上登着谁才选得出节点，`http` 形状的探测就靠这份快照；
 * 环境目标只在标了那个环境的节点上要。没说是哪个节点（老扩展、兼容槽）只有设备那部分。
 */
export function facilitiesForNode(bindings: Pick<FacilityBindings, 'list' | 'targets'> | undefined, deviceId: string, node?: { environment?: string | undefined }): string[] {
  const out = (bindings?.list?.() ?? []).filter((b) => b.deviceId === deviceId).map((b) => b.facility)
  if (node) {
    for (const { facility, target: t } of bindings?.targets?.() ?? []) {
      if (t.kind === 'identity' || (t.kind === 'environment' && t.environment === node.environment)) out.push(facility)
    }
  }
  return [...new Set(out)].sort()
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
 * 源 facility → placement。ReplayAdapter、调度器、任务中心共用**同一个**解析器（各写一份迟早会分叉：
 * 一边按 facility 派到 NAS、另一边仍在本机）。包的主机声明调用时才取——热装卸会变。
 *
 * 异步：身份 / 环境目标要选节点、可能唤起 profile、可能去站点核对。同一次执行里再为同一个 facility 问
 * （调度器之下的 ReplayAdapter、动作里读这个 facility 的源）就复用外层那份，不再选一遍。
 */
export function makeFacilityPlacement(deps: {
  bindings: FacilityBindings
  network: (facility: string) => PackageNetwork | undefined
  /** 身份 / 环境目标的解析器（现取：身份表打不开时没有它，这类目标一律 identity-offline）。 */
  router?: () => IdentityRouter | undefined
}): (facility: string | undefined, purpose?: RunPurpose) => Promise<RunPlacement> {
  return async (facility, purpose = 'harvest') => {
    const cur = activePlacement()
    if (facility !== undefined && cur?.facility === facility) return cur
    const target = facility !== undefined ? facilityTarget(deps.bindings, facility) ?? LOCAL_TARGET : LOCAL_TARGET
    return placeRun({
      target,
      ...(facility !== undefined ? { facility } : {}),
      hosts: facility ? deps.network(facility)?.hosts ?? [] : [],
      router: deps.router?.(),
      purpose,
    })
  }
}

/**
 * 同步、只认设备目标的版本：给只拿 placement 判「能不能在这里跑」、不进执行上下文的调用点（MCP 的
 * `run_action_recipe`）。facility 目标是身份 / 环境时抛 `identity-offline`——它没法把执行钉到那个节点上，
 * 就不能在默认节点上替那个身份做事。
 */
export function makeDevicePlacement(deps: {
  bindings: FacilityBindings
  network: (facility: string) => PackageNetwork | undefined
}): (facility: string | undefined) => RunPlacement {
  return (facility) => resolvePlacement({
    facility,
    binding: (f) => deviceTargetOf(deps.bindings, f),
    hosts: facility ? deps.network(facility)?.hosts ?? [] : [],
  })
}

/** facility 的默认目标：有 `target` 读它，老实现只有设备（`get`）。没绑 = undefined。 */
export function facilityTarget(bindings: FacilityBindings, facility: string): Target | undefined {
  if (bindings.target) return bindings.target(facility)
  const deviceId = bindings.get(facility)
  return deviceId !== undefined ? { kind: 'device', deviceId } : undefined
}

/**
 * 目标 → placement。设备目标与升级前一样；身份 / 环境目标由路由器选出节点，节点的设备与绑定预先填进
 * placement（`pickBrowser` 之后不再重选），另带 `identity` 与收尾的 `release`。
 *
 * **没有回落分支**：没有 facility、没有路由器、路由器选不出——都是 `identity-offline`。
 */
export async function placeRun(input: {
  target: Target
  facility?: string
  hosts: readonly string[]
  router?: IdentityRouter
  purpose: RunPurpose
}): Promise<RunPlacement> {
  const { target, facility } = input
  const base = { allowHosts: input.hosts, ...(facility !== undefined ? { facility } : {}) }
  if (target.kind === 'device') return { deviceId: target.deviceId, ...base }
  const label = describeTarget(target, facility)
  if (facility === undefined) throw new IdentityOffline('?', label, '动作所属的包没有声明 facility，身份无从说起')
  if (!input.router) throw new IdentityOffline(facility, label, '身份表不可用')
  const r = await input.router.resolve({ target, facility, purpose: input.purpose })
  return {
    deviceId: r.node.deviceId,
    ...base,
    browser: { bindingId: r.node.bindingId },
    identity: r.identity,
    release: r.release,
  }
}

/**
 * facility 的默认设备。目标是身份 / 环境时**抛**，不回 undefined：回 undefined 就是「没绑 = 本机」，
 * 而身份目标绝不退回本机（browser-identity D7）。
 */
export function deviceTargetOf(bindings: FacilityBindings, facility: string): string | undefined {
  const t = facilityTarget(bindings, facility)
  if (t && t.kind !== 'device') throw new IdentityOffline(facility, describeTarget(t, facility), '这条路径不按身份路由——拒绝执行，不在默认浏览器里替这个身份做事')
  return t?.deviceId
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

/** 设备 → 它上面的一条在线扩展绑定（`ExtRelayRegistry` 满足它）。没有绑定 / 都离线时抛；本机例外，回兼容槽。 */
export interface BrowserPicker {
  pick(deviceId: string): string
  /** 本机那条兜底要不要钉住看它：没给 = 本机一律不钉。 */
  isOnline?(bindingId: string): boolean
}

/**
 * 本次执行用哪个扩展绑定（device-execution D7、browser-identity D2）。第一次问时选、记在执行上下文的
 * `browser` 记号上，之后整次执行不变——中途新连上的 Chrome / profile 不会把一半的登录切到另一个浏览器里。
 * 没有执行上下文（面板、MCP 工具）= 本机此刻的默认节点，不钉。
 *
 * 本机一个节点都不在线时 `pick` 回兼容槽 `local`，**这一刻不钉**：`ensureHarvestBrowser` 会唤起 Chrome
 * 再等，连上来的是哪个节点、执行就该落在哪个节点上；钉在一条不在线的兼容槽上，这次执行就再也用不上它。
 */
export function pickBrowser(reg: BrowserPicker): string {
  const p = currentPlacement()
  if (p.browser?.bindingId) return p.browser.bindingId
  const id = reg.pick(p.deviceId)
  if (p.browser && (p.deviceId !== LOCAL_DEVICE || reg.isOnline?.(id) === true)) p.browser.bindingId = id
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
