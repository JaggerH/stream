import type { StandbyDiagnosis, StandbyEntry, StandbyManager } from './manager.ts'
import type { StandbyInertReason } from './wire.ts'

let injected: StandbyManager | null = null
let inert: StandbyInertReason | null = null

/** serve.ts 在 bootstrap 后接线;stdio/单测不接 → ensureAwake 恒 no-op(spec:降级绝不搞挂主链路)。 */
export function setStandbyManager(m: StandbyManager | null): void { injected = m }

/** 没接线时**为什么**（wireStandby 的三个 inert 出口，见 StandbyInertReason）。
 *  serve.ts 在 wireStandby 之后设，随内核 dispose 一起复位——**这个全局必须能复位**：
 *  同进程跑第二次 bootstrap 会读到上一次的残留，而残留与"这次真的够不着 Docker"
 *  长得一模一样（plugin-target.ts 的 resolver 为这条踩过一次）。 */
export function setStandbyInertReason(r: StandbyInertReason | null): void { inert = r }

/** 只在真没接线时作数：接上了就没有"为什么没接线"这回事，别让一个陈旧的原因
 *  跟在一个健康的 manager 后面把判据带偏。 */
export function standbyInertReason(): StandbyInertReason | null { return injected ? null : inert }

/** 只读探测：现在接上了吗。给启动完成处的「hooks unbound」那一行用
 *  （`src/kernel/plugins/module-hooks.ts`）。没有 Docker / 没插件声明 standby 是**常态降级**，
 *  由 serve.ts 显式申报成 degraded，不进那行告警。 */
export function isStandbyBound(): boolean { return injected !== null }

// 这里曾经还导出过一个 ensureAwake:引用计数改造之后,全部五个调用点都改成了 withAwake
// (只保证"进入时醒着"不够——reaper 会在长请求中途把容器抽走),它就再没人用了。删掉,免得下一个
// 调用方以为它是个平级的选项而选错。manager 内部那个 ensureAwake 仍在(withAwake 就建在它上面)。

/** 长请求的首选形式:整段请求期间持有引用,reaper 不会把容器从脚下抽走。
 *  没接线时退化为"直接跑 fn" —— 未接线是常态(stdio/单测),绝不能因此改变调用方行为。 */
export async function withAwake<T>(service: string, fn: () => Promise<T>): Promise<T> {
  if (!injected) return fn()
  return injected.withAwake(service, fn)
}

/** 前置预热:提前把 standby 容器唤醒,但**不持有引用**——与 withAwake 是两回事,别拿它替代
 *  withAwake 去包真正的请求(那样 reaper 会在长请求中途把容器抽走)。用途单一:入队时抢跑冷启,
 *  让容器装权重与排队/取音频并行;真正跑请求时仍由 withAwake 确保醒着。fire-and-forget,调用方
 *  自负吞错(唤醒超时是可重试的,真容错在转写任务层的延迟重排,不在这里)。未接线(stdio/单测/
 *  compose 档没接线)或非 standby 服务 → no-op,和其余 hook 的降级方向一致。 */
export async function prewarmStandby(service: string): Promise<void> {
  if (!injected) return
  await injected.ensureAwake(service)
}

export function standbySnapshot(): StandbyEntry[] { return injected?.snapshot() ?? [] }

/** host 档动态取址:醒着的容器的 loopback origin。未接线/asleep → null。
 *  bootstrap 在 host 档把 pluginTarget resolver 指到这里(取址必须先 withAwake,见
 *  plugin-target.ts 头注的档位契约)。 */
export function standbyOrigin(service: string): string | null {
  return injected?.origin(service) ?? null
}

/** 这个 service 是否被 standby 管着(含别名命中)——"管不管得着",不是"现在醒着吗"。
 *  未接线(stdio/单测/compose 档没接线的路径)→ false,和其余 hook 函数的降级方向一致。
 *  给 readiness 判断用,见 bootstrap.ts identifyReady 头注。 */
export function standbyManaged(service: string): boolean {
  return injected?.managed(service) ?? false
}

/** 只读对质,给 `pluginTarget` 答空时的现场记录用(见 manager.diagnose)。
 *  **未接线 → null,不是一份「什么都没有」的 diagnosis**:"standby 根本没接线(没 Docker /
 *  没插件声明 standby → inert)"和"接了但这个 service 查不到"是两种病,记录里必须分得开。 */
export async function standbyDiagnose(service: string): Promise<StandbyDiagnosis | null> {
  return injected ? injected.diagnose(service) : null
}
