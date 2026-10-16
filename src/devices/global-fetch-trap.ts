/**
 * 全局 `fetch` 的运行时兜底：在非 `local` 的执行上下文里，任何直接调 `globalThis.fetch` 的代码
 * 都抛 `DeviceIncapable(http.fetch)`，而不是悄悄从后端本机发出去。
 *
 * 为什么需要它：包的出站必须走 `ctx.fetch` / `fetchFor`（按执行上下文派到设备），守卫测试
 * （`src/no-bare-fetch-in-packages.guard.test.ts`）挡的是 `packages/**` 里的源码。挡不住的是：
 * 第三方依赖里的 `fetch(`、npm 上装来的旧版包、守卫正则漏掉的写法。这些调用在绑定到 NAS 的执行
 * 里会从加州的本机发出——「绝不回落 local」被一行别人的代码破掉。这里在运行时补一道。
 *
 * **只是 best-effort**：主控制仍是守卫测试与 `ctx.fetch`。内嵌 facility（RSSHub 的
 * request-rewriter）之后若用 `Object.defineProperties(globalThis, { fetch })` 换掉全局 fetch，
 * 而它的实现不委托给装它之前的那个全局（即本陷阱），这道兜底就被替换掉了。RSSHub 当前的改写器
 * 包的是装它时的 `globalThis.fetch`，所以陷阱仍在链上；但别把安全性押在第三方实现细节上。
 *
 * 不影响 `local`：本机执行原样委托给装陷阱之前的全局 fetch。`ownedFetch` 用的是 owned-outbound
 * 在模块顶层快照的原始 fetch，也不经过这里。
 */
import { DeviceIncapable } from './errors.ts'
import { LOCAL_DEVICE, currentPlacement } from './run-context.ts'

export function makeGlobalFetchTrap(prev: typeof fetch): typeof fetch {
  const trap = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const { deviceId } = currentPlacement()
    if (deviceId === LOCAL_DEVICE) return prev(input, init)
    const e = new DeviceIncapable(deviceId, 'http.fetch')
    e.message = `设备 ${deviceId}：包直接调用了全局 fetch——在远程设备上执行时必须用 ctx.fetch`
    return Promise.reject(e)
  }
  return trap as typeof fetch
}

/**
 * 在 serve 装配时调用一次（owned-outbound 已经快照了原始 fetch 之后）。返回卸载函数（测试用）。
 */
export function installGlobalFetchTrap(): () => void {
  const prev = globalThis.fetch
  globalThis.fetch = makeGlobalFetchTrap(prev)
  return () => { globalThis.fetch = prev }
}
