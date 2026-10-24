import type { StandbyDiagnosis, StandbyEntry, StandbyManager } from './manager.ts'
import type { StandbyInertReason } from './wire.ts'

/**
 * 一个实例的 standby 钩子（`ctx.packages.standby`，`src/kernel/plugins/packages.ts` 装配）。
 *
 * 过去 manager 与「为什么没接线」住在模块级变量里，serve.ts 接线、内核 dispose 复位——同进程
 * 跑第二个实例时两个内核读写同一对全局，互相污染，而残留与「这次真的够不着 Docker」长得一模一样。
 * 现在每个实例各持一份，serve.ts 经 `ctx.packages.standby` 接线。
 *
 * 没接线（serve 没接 / stdio / 单测）→ `withAwake` 恒直跑、`origin`/`managed` 恒空
 * （spec:降级绝不搞挂主链路）。
 */
export class StandbyHooks {
  private manager: StandbyManager | null = null
  /** 只在真没接线时作数：接上了就没有「为什么没接线」这回事，别让一个陈旧的原因
   *  跟在一个健康的 manager 后面把判据带偏。 */
  private inert: StandbyInertReason | null = null

  /** serve（wireStandby）在 bootstrap 后接线；传 null 复位（内核 dispose / adopt 半路撤销）。
   *  只动 manager，不动 inert——inert 的生命周期归 setInertReason（两者由 serve 分别绑定）。 */
  bind(m: StandbyManager | null): void {
    this.manager = m
  }

  /** 没接线时**为什么**（wireStandby 的三个 inert 出口，见 StandbyInertReason）。
   *  随内核 dispose 一起复位。 */
  setInertReason(r: StandbyInertReason | null): void {
    this.inert = r
  }

  /** 只在真没接线时作数（见上）。 */
  inertReason(): StandbyInertReason | null {
    return this.manager ? null : this.inert
  }

  /** 只读探测：现在接上了吗。没有 Docker / 没插件声明 standby 是**常态降级**，
   *  由 serve.ts 显式申报成 degraded，不进那行告警（module-hooks.ts）。 */
  get bound(): boolean {
    return this.manager !== null
  }

  // 这里曾经还导出过一个 ensureAwake:引用计数改造之后,全部五个调用点都改成了 withAwake
  // (只保证"进入时醒着"不够——reaper 会在长请求中途把容器抽走),它就再没人用了。删掉,免得下一个
  // 调用方以为它是个平级的选项而选错。manager 内部那个 ensureAwake 仍在(withAwake 就建在它上面)。

  /** 长请求的首选形式:整段请求期间持有引用,reaper 不会把容器从脚下抽走。
   *  没接线时退化为"直接跑 fn" —— 未接线是常态(stdio/单测),绝不能因此改变调用方行为。 */
  async withAwake<T>(service: string, fn: () => Promise<T>): Promise<T> {
    if (!this.manager) return fn()
    return this.manager.withAwake(service, fn)
  }

  /** 前置预热:提前把 standby 容器唤醒,但**不持有引用**——与 withAwake 是两回事,别拿它替代
   *  withAwake 去包真正的请求(那样 reaper 会在长请求中途把容器抽走)。用途单一:入队时抢跑冷启,
   *  让容器装权重与排队/取音频并行;真正跑请求时仍由 withAwake 确保醒着。fire-and-forget,调用方
   *  自负吞错(唤醒超时是可重试的,真容错在转写任务层的延迟重排,不在这里)。未接线(stdio/单测/
   *  compose 档没接线)或非 standby 服务 → no-op,和其余降级方向一致。 */
  async prewarm(service: string): Promise<void> {
    if (!this.manager) return
    await this.manager.ensureAwake(service)
  }

  snapshot(): StandbyEntry[] {
    return this.manager?.snapshot() ?? []
  }

  /** host 档动态取址:醒着的容器的 loopback origin。未接线/asleep → null。
   *  host 档的 plugin-target resolver 指到这里(取址必须先 withAwake,见
   *  plugin-target.ts 头注的档位契约)。 */
  origin(service: string): string | null {
    return this.manager?.origin(service) ?? null
  }

  /** 这个 service 是否被 standby 管着(含别名命中)——"管不管得着",不是"现在醒着吗"。
   *  未接线(stdio/单测/compose 档没接线的路径)→ false,和其余降级方向一致。
   *  给 readiness 判断用,见 bootstrap.ts identifyReady 头注。 */
  managed(service: string): boolean {
    return this.manager?.managed(service) ?? false
  }

  /** 只读对质,给 target() 答空时的现场记录用(见 manager.diagnose)。
   *  **未接线 → null,不是一份「什么都没有」的 diagnosis**:"standby 根本没接线(没 Docker /
   *  没插件声明 standby → inert)"和"接了但这个 service 查不到"是两种病,记录里必须分得开。 */
  async diagnose(service: string): Promise<StandbyDiagnosis | null> {
    return this.manager ? this.manager.diagnose(service) : null
  }
}
