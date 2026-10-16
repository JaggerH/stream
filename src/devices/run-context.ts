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

export interface RunPlacement {
  deviceId: string
  /** 本次执行所属包声明的主机名后缀（`stream.network.hosts`，缺省 = `stream.credentials`）。 */
  allowHosts: readonly string[]
}

const LOCAL: RunPlacement = Object.freeze({ deviceId: LOCAL_DEVICE, allowHosts: Object.freeze([]) as readonly string[] })
const store = new AsyncLocalStorage<RunPlacement>()

export function runOnDevice<T>(p: RunPlacement, fn: () => Promise<T>): Promise<T> {
  return store.run(p, fn)
}

export function currentPlacement(): RunPlacement {
  return store.getStore() ?? LOCAL
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
