/**
 * 模块级可变全局（「钩子」）的**登记与生命周期**。
 *
 * 有三个模块因为拿不到 bootstrap 的闭包而只能靠模块级变量接线：`plugin-target`（每个
 * `resolveXUrl` 都读它）、`standby/hook`（`withAwake` 读它）、`tasks/deps`（Job 类经动态
 * import 加载，闭包不到构造现场）。消费侧的 getter 一律不动——这里改的只有两件事：
 *
 * 1. **登记随内核挂卸**：`bindModuleHook` 把 set 包进 `ctx.effect()`，`fiber.dispose()` 时复位
 *    为 null。过去这些全局从不复位，一个进程里跑两次 bootstrap（测试、将来的重启）会读到上一
 *    次的残留，而残留和「正确接线」运行时完全无法区分。
 * 2. **未接线可观测**：`reportUnboundHooks` 在启动完成处报一行「谁还是 null」。
 *    降级档（没有 Docker、查询档不起调度中心）是**故意不接**，由调用方显式申报进 `degraded`，
 *    不进告警——否则这行日志第一天就变成噪音，然后没人再读它。
 */
import type { Context } from 'cordis'
import { isPluginTargetBound } from '../../plugins/plugin-target.ts'
import { isStandbyBound } from '../../plugins/standby/hook.ts'
import { isTaskDepsBound } from '../../tasks/deps.ts'

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

/**
 * 全仓模块级钩子的名册。**往这三个之外再加一个模块级全局，就得在这里加一行**——否则
 * 「忘了接线」又会变回一个没人报的静默降级。
 */
export const MODULE_HOOKS: readonly HookProbe[] = [
  { name: 'pluginTarget', bound: isPluginTargetBound },
  { name: 'standby', bound: isStandbyBound },
  { name: 'taskDeps', bound: isTaskDepsBound },
]

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
  const unbound = (opts.probes ?? MODULE_HOOKS).filter((p) => !p.bound()).map((p) => p.name)
  const unexpected = unbound.filter((n) => !degraded.has(n))
  if (unexpected.length === 0) return
  const off = unbound.filter((n) => degraded.has(n))
  opts.log(
    `[stream] hooks unbound: ${unexpected.join(', ')}`
      + (off.length ? ` (intentionally off: ${off.join(', ')})` : ''),
  )
}
