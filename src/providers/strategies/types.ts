import type { ProviderRecord } from '../../store/types.ts'
import type { InvokeResult, CollectResult } from '../invoke-types.ts'
import type { MemberOutcome } from '../member-pipeline.ts'
import type { Admission } from '../breaker.ts'

/** 策略眼里的成员：只有寻址键 / 真源 id / 叶子还是组合子。attempt 闭包不外露——碰成员
 *  的唯一口子是 ctx.run（打点、超时、健康账都钉在那条管道上）。 */
export interface StrategyMemberView { name: string; sourceId: string; kind: 'source' | 'provider' }

/** 声明式源调用：策略"点单"，取数由执行器做（`deps.fetchSource(m.sourceId, input, params)`）。
 *
 *  为什么是一份描述而不是一个闭包：闭包版（旧 `opts.attempt` + `ctx.fetchSource`）等于把裸取数
 *  递到策略手里——策略可以自己 `await fetchSource(...)` 而完全绕开管道（打点/超时/分类/健康账
 *  一个都不记），这道门就只剩注释在守。描述式把"要哪个源、参数是什么、空批怎么算"收成三个字段，
 *  取数与包装全在执行器那一处，类型上再没有绕过管道的路。 */
export interface StrategySourceCall {
  /** 传给 fetchSource 的参数（策略现算的，如 expand 从 A-item 映射出来的钻取键）。 */
  params?: Record<string, unknown>
  /** 空批怎么算：
   *  'decline' → 空数组归 null（记 miss，对齐标准源成员"空批 = decline"的语义）；
   *  'ok'      → 空数组照样算 win（expand 的 B 钻：钻空是"这条 handle 没链接"的常态，不是源故障，
   *              不该占熔断账）。 */
  empty: 'decline' | 'ok'
  /** 覆盖喂给 fetchSource 的 input；省略 = ctx.input。 */
  input?: unknown
}

export interface StrategyContext {
  record: ProviderRecord
  members: StrategyMemberView[]
  input: unknown
  accept: (r: unknown) => boolean
  /** 碰成员的唯一口子（也是唯一的取数口）。m 来自 ctx.members 时直接执行其绑定 attempt；
   *  带 `source` 描述时由执行器现场构造 attempt（expand 的 A 壳 / B 钻——它们的 params 是策略
   *  现算的，不在成员声明里，所以 members 恒空）。既不在 members 里、又没带 source 描述 = 策略
   *  写错了，run 会在进管道前显式抛错（而不是伪装成上游失败）。 */
  run: (m: StrategyMemberView, opts?: { timeoutMs?: number; source?: StrategySourceCall }) => Promise<MemberOutcome>
  /** 单成员熔断裁决。kind:'provider' 恒放行（组合子行不进源健康账本）。顺次语义的策略逐成员
   *  问完之后，必须把结果过一遍 `forceProbeShortest`（breaker.ts）补上兜底不变量——别自己再写
   *  一份"全员冷却就探最短"，那份代码只有一个家。 */
  admit: (m: StrategyMemberView) => Admission
}

export interface ExecutionStrategy {
  name: string
  invoke(ctx: StrategyContext): Promise<InvokeResult>
  collect?(ctx: StrategyContext): Promise<CollectResult>
}
