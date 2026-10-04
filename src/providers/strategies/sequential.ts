import type { ExecutionStrategy, StrategyContext, StrategyMemberView } from './types.ts'
import { forceProbeShortest, type Admission } from '../breaker.ts'
import { missOf, timingOf } from '../member-pipeline.ts'
import type { InvokeMiss, InvokeTiming } from '../invoke-types.ts'

/** 顺次：按用户声明的原序试到第一个合格结果。降级不重排——熔断只决定"跳过与否"。
 *
 *  **无 collect**：collect 是"全收"语义下的另一种结果形状（逐成员成对），而顺次的语义就是
 *  首胜即停——"逐个问但一个都不停"不是顺次，是并发。要全收就把行改成 concurrent。
 *  调用方对顺次行调 collect 会在执行器分发处拿到显式报错（带策略名与行 id）。 */

/** 熔断裁决预计算。逐成员问 `ctx.admit`（组合成员 kind:'provider' 在那儿恒放行——不进源健康
 *  账本，这层豁免是策略语义），再把整表过一遍 `forceProbeShortest` 补上兜底不变量：全员冷却时
 *  强行放行剩余最短的那个。**那份不变量不在这儿实现**——它和 `SourceBreaker.plan()`
 *  （ResolveEngine 走的那条）是同一份代码。 */
function planAdmissions(ctx: StrategyContext): Array<{ m: StrategyMemberView; adm: Admission }> {
  const adms = forceProbeShortest(ctx.members.map((m) => ctx.admit(m)))
  return ctx.members.map((m, i) => ({ m, adm: adms[i] }))
}

const frozenMiss = (m: StrategyMemberView, retryInMs: number): InvokeMiss =>
  ({ member: m.name, reason: `熔断冷却中（约 ${Math.ceil(retryInMs / 1000)}s 后重试）` })

export const sequentialStrategy: ExecutionStrategy = {
  name: 'sequential',

  async invoke(ctx) {
    const misses: InvokeMiss[] = []
    const timings: InvokeTiming[] = []
    for (const { m, adm } of planAdmissions(ctx)) {
      if (!adm.allow) { misses.push(frozenMiss(m, adm.retryInMs)); continue }
      const o = await ctx.run(m)
      timings.push(timingOf(o))
      if (o.kind === 'win') return { strategy: 'sequential', provider: ctx.record.id, value: o.value, via: m.name, misses, timings }
      misses.push(missOf(o))
    }
    return { strategy: 'sequential', provider: ctx.record.id, value: null, via: null, misses, timings }
  },
}
