/**
 * 实例钩子的**登记与生命周期**。
 *
 * `plugin-target`（`ctx.packages.targets`）与 `standby`（`ctx.packages.standby`）如今都是
 * 实例对象，`bindModuleHook` 只负责把「绑上 / 复位」登记进内核 effect：`fiber.dispose()` 时
 * 复位，一个进程跑第二次 bootstrap 不会再读到上一次的残留。
 *
 * **未接线可观测**：`reportUnboundHooks` 在启动完成处报一行「谁还是 null」。探针由调用方
 * 递（实例上拿），降级档（没有 Docker、查询档不起调度中心）是**故意不接**，由调用方显式申报
 * 进 `degraded`，不进告警——否则这行日志第一天就变成噪音，然后没人再读它。
 */
import type { Context } from 'cordis'

/**
 * 把一次模块级全局的绑定登记成内核 effect：挂载时 `bind()`、销毁时 `unbind()`。
 *
 * **`bind()` 是同步立刻执行的**（cordis 的 effect 回调即刻跑），所以包装不会推迟任何调用点的
 * 时机——`setPluginTargetResolver` 必须早于 adapter/client 构造，这条约束在包装后仍然成立。
 *
 * `kernel` 缺席（单测直连 bootstrap、不传内核）时退化为直接 `bind()`：没有内核就没有销毁口，
 * 行为与包装前一字不差。
 */
export function bindModuleHook(kernel: Context | undefined, bind: () => void, unbind: () => void): void {
  if (!kernel) {
    bind()
    return
  }
  kernel.effect(() => {
    bind()
    return unbind
  })
}

/** 一个模块级钩子的只读探测面：名字 + 「现在接上了吗」。 */
export interface HookProbe {
  name: string
  bound: () => boolean
}

export interface UnboundHooksReport {
  /** 调用方显式申报的「这一档就是故意不接」，不进告警。 */
  degraded?: readonly string[]
  log: (msg: string) => void
  probes?: readonly HookProbe[]
}

/**
 * 启动完成处报一行仍为 null 的钩子。**全绑、或剩下的全是申报过的降级档 → 一个字都不打**：
 * 这行日志的全部价值在于「不该是 null 的它是 null」，掺进常态就等于没有。
 */
export function reportUnboundHooks(opts: UnboundHooksReport): void {
  const degraded = new Set(opts.degraded ?? [])
  const unbound = (opts.probes ?? []).filter((p) => !p.bound()).map((p) => p.name)
  const unexpected = unbound.filter((n) => !degraded.has(n))
  if (unexpected.length === 0) return
  const off = unbound.filter((n) => degraded.has(n))
  opts.log(
    `[stream] hooks unbound: ${unexpected.join(', ')}`
      + (off.length ? ` (intentionally off: ${off.join(', ')})` : ''),
  )
}
