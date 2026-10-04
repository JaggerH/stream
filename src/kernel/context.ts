/**
 * Stream 的进程内内核 —— 一个 Cordis 根 context。
 *
 * 它今天只做两件事：**给能力一个共同的挂载点**，和**给进程退出一个统一的销毁口**
 * （`kernel.fiber.dispose()` 一路撤销所有经 `ctx.effect()` 登记的句柄/定时器）。
 * 业务逻辑一行都不在这儿——服务是随 Phase 1/2 一个个搬进来的。
 * 设计与分期见 `docs/superpowers/specs/2026-08-16-cordis-kernel-adoption-design.md`。
 *
 * **这个文件是全仓 declaration-merging 的集中地——但集中的是规则，不是声明本身**：
 *
 * - `declare module 'cordis'` 的 `Context` / `Events` 扩展，**写在各服务自己的模块里**
 *   （服务定义和它的 ctx key 挨着，一起搬走、一起删掉，不会留下孤儿声明）。
 * - **ctx key 一律带域前缀**（`ctx.providerDirectory`，不是 `ctx.registry`）。服务名和事件名
 *   在 Cordis 里是**全局扁平命名空间**，上游本体已占 `logger` / `events` / `registry` /
 *   `reflect` / `fiber` 五个——撞上去就是静默覆盖上游服务。Stream 自己已有的同名概念
 *   （`Registry` 类、`EventsService` 类）不冲突：那些是类，不是 ctx key。
 * - 事件用 waterfall 时：**纯观察型 listener 必须调 `next()`**，否则静默吞掉下游默认行为。
 */
import { Context } from 'cordis'

/**
 * 建一个 Stream 内核根 context。
 *
 * 有意保持成 `new Context()` 一层薄壳而不是子类：品牌化的价值在于**只有一个地方 new**，
 * 于是"内核长什么样"以后要改（注入基础服务、换 vendor 分支）只改这里，调用方不动。
 */
export function createKernel(): Context {
  return new Context()
}

/** `quiesceKernel` 的超时上限（毫秒）。销毁卡住时进程照样得退。 */
export const KERNEL_QUIESCE_TIMEOUT_MS = 5_000

/**
 * 把整棵树销毁掉并**等到真的静下来**。
 *
 * `fiber.dispose()` resolve 之后可能还有后继 transition（卸载会触发别的 fiber 状态变化），
 * 光 await 它不代表撤销完了——要轮 `fiber.inertia` 直到它变成 `undefined`。
 *
 * 超时是有意的：关停路径的第一职责是**让进程真的退出**。销毁卡死时宁可漏掉几个 disposer
 * （反正下一秒 `process.exit(0)` 就把进程端了），也不能把 SIGTERM 拖成一次强杀。
 */
export async function quiesceKernel(
  kernel: Context,
  timeoutMs: number = KERNEL_QUIESCE_TIMEOUT_MS
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
    // 别让这个兜底定时器自己把事件循环钉住——它存在只为「卡住时能往下走」。
    timer.unref?.()
  })
  try {
    await Promise.race([
      (async () => {
        await kernel.fiber.dispose()
        while (kernel.fiber.inertia !== undefined) await kernel.fiber.inertia
      })(),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
