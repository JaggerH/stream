/**
 * 「这一次执行在哪台设备上、允许访问哪些主机」——挂在 AsyncLocalStorage 上，跨 await 传播。
 *
 * 为什么不按参数透传：code 包的 `activate(ctx)` 拿到的 `ctx` 是长寿命对象，按次透传就要改
 * 所有包的签名；ALS 让 `ctx.fetch` / `ctx.cookieFor` 签名不变而行为按次变化。
 * 没有上下文 = `local`——现有调用路径一条不改就保持原样。
 * 权威设计：openspec/changes/device-execution/design.md D3。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export const LOCAL_DEVICE = 'local'
/** 本机扩展那条绑定（native host 信任链）的 id。配对绑定是 `ext:<uuid>`（design D7）。 */
export const LOCAL_BINDING = 'local'

export interface RunPlacement {
  deviceId: string
  /** 本次执行所属包声明的主机名后缀（`stream.network.hosts`，缺省 = `stream.credentials`）。 */
  allowHosts: readonly string[]
  /**
   * 本次执行用哪个扩展绑定。`runOnDevice` 每次执行给一个空记号；第一次需要浏览器时由
   * `pickBrowser`（placement.ts）填上，之后整次执行不变。
   */
  browser?: { bindingId?: string }
  /**
   * 本次执行是否已有请求经设备发出。由执行入口（任务中心 runAction）每次执行新建一个，
   * `fetchFor` 在帧写上 socket 时置位。置位之后的任何失败都可能是「下了一半单」，不得重试——
   * 包把错误吞成普通 Error、或者下一笔撞上 DeviceOffline，都靠它兜住。
   */
  dispatch?: DispatchMarker
  /**
   * 这份 placement 是为哪个 facility 解析的。同一次执行里再为同一个 facility 问一次（调度器之下的
   * ReplayAdapter、动作里读源）就复用它（`makeFacilityPlacement`）——身份目标的解析要选节点、可能唤起、
   * 可能核对，同一次执行里做两遍既慢，也可能两次选中不同的节点。
   */
  facility?: string
  /** 按身份 / 环境解析出来的执行（browser-identity D7）：哪个身份、在哪个节点上。运行记录读它。 */
  identity?: RunIdentity
  /**
   * 执行结束后要做的收尾（唤起的 profile 收回去，D8）。`runOnDevice` 在 finally 里叫一次；
   * 同一个 placement 再进 `runOnDevice`（嵌套复用）不叫。
   */
  release?: () => Promise<void>
}

export interface RunIdentity {
  facility: string
  accountId: string
  /** 执行那一刻身份表里的显示名（之后改名不跟着变）。 */
  accountName?: string
  nodeId: string
}

export interface DispatchMarker {
  dispatched: boolean
}

const LOCAL: RunPlacement = Object.freeze({ deviceId: LOCAL_DEVICE, allowHosts: Object.freeze([]) as readonly string[] })
const store = new AsyncLocalStorage<RunPlacement>()

export async function runOnDevice<T>(p: RunPlacement, fn: () => Promise<T>): Promise<T> {
  // 已经在这份 placement 里了（嵌套的入口复用了外层的）：不另起一层，也不替外层收尾。
  if (store.getStore() === p) return fn()
  try {
    // 记号挂在这一层而不是各个执行入口：入口有好几个（任务中心、调度器、采集 adapter），漏一个
    // 就是那条路上每次用浏览器都重选一次。已经带了记号的（外层执行传下来的）原样沿用。
    return await store.run(p.browser ? p : { ...p, browser: {} }, fn)
  } finally {
    // 收尾不能遮住执行本身的结果：它失败了，profile 只是还在后台开着（面板看得见，D8）。
    if (p.release) await p.release().catch(() => {})
  }
}

export function currentPlacement(): RunPlacement {
  return store.getStore() ?? LOCAL
}

/** 此刻所在的执行上下文；不在任何执行里 = undefined（不是 `local` 的那份冻结默认值）。 */
export function activePlacement(): RunPlacement | undefined {
  return store.getStore()
}

export function currentDeviceId(): string {
  return currentPlacement().deviceId
}

const norm = (s: string) => s.trim().toLowerCase().replace(/^\./, '').replace(/\.$/, '')

/** 主机名后缀匹配。**不是子串**：`evil-eastmoneysec.com` 不算 `eastmoneysec.com`。 */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = norm(host)
  return allow.some((d) => {
    const s = norm(d)
    return s !== '' && (h === s || h.endsWith(`.${s}`))
  })
}
