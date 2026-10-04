import type { ExecutionStrategy } from './types.ts'
import { missOf, timingOf, type MemberOutcome } from '../member-pipeline.ts'
import { tagSource } from '../invoke-types.ts'
import type { InvokeMiss, InvokeTiming } from '../invoke-types.ts'

/** 并发：全成员并行,合格结果合并。第一期不接熔断(无顺序可省;要不要跳冷却源按需再加,spec §2 非目标)。
 *  经管道执行 = 并发面首次记健康账(行为变化已在 spec §4 明示)。 */
export const concurrentStrategy: ExecutionStrategy = {
  name: 'concurrent',

  async invoke(ctx) {
    const outcomes: MemberOutcome[] = await Promise.all(ctx.members.map((m) => ctx.run(m)))
    const misses: InvokeMiss[] = []
    const timings: InvokeTiming[] = []
    const wins: MemberOutcome[] = []
    for (const o of outcomes) {
      timings.push(timingOf(o))
      if (o.kind === 'win') wins.push(o)
      else misses.push(missOf(o))
    }
    return {
      strategy: 'concurrent', provider: ctx.record.id,
      // per-item 溯源打**真源 id**(非成员寻址键):读回方(scheduler.normalizeRaw / facetOneSource)
      // 拿它当源 id 查 manifest——同源两实例走同一个 normalizer(语义与迁移前逐字一致)。
      items: wins.flatMap((w) => (Array.isArray(w.value) ? w.value : [w.value]).map((it) => tagSource(it, w.sourceId))),
      sources: wins.map((w) => w.member),
      misses, timings,
    }
  },

  async collect(ctx) {
    const outcomes: MemberOutcome[] = await Promise.all(ctx.members.map((m) => ctx.run(m)))
    return {
      strategy: 'concurrent', provider: ctx.record.id,
      results: outcomes.filter((o) => o.kind === 'win').map((o) => ({ member: o.member, value: o.value })),
      misses: outcomes.filter((o) => o.kind !== 'win').map(missOf),
      timings: outcomes.map(timingOf),
    }
  },
}
