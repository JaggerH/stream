import type { ExecutionStrategy } from './types.ts'
import { sequentialStrategy } from './sequential.ts'
import { concurrentStrategy } from './concurrent.ts'
import { expandStrategy } from './expand.ts'

/** 内置策略唯一注册点。加新策略要动三处：在这里注册、user-store 的 CHECK 约束加一次迁移、
 * `src/packages/descriptor.ts` 的 strategy 枚举（包声明的 Provider 行按它收窄——漏了那一处，
 * 包里写上新策略名会被装载期直接拒掉）。
 * 新策略若是顺次语义（按序试成员、命中即停），须自行调用 `ctx.admit`，并把整表过一遍
 * `forceProbeShortest`（breaker.ts，兜底不变量的唯一实现）——熔断裁决在策略层，
 * 不在管道；管道只管单成员超时/分类/健康账，不会替策略做"要不要跳过这个成员"的判断。 */
export function builtinStrategies(): Map<string, ExecutionStrategy> {
  const m = new Map<string, ExecutionStrategy>()
  for (const s of [sequentialStrategy, concurrentStrategy, expandStrategy]) m.set(s.name, s)
  return m
}

export const BUILTIN_STRATEGY_NAMES: string[] = [...builtinStrategies().keys()]

/** 这个策略名支持 `collect()` 吗——注册表是唯一判据，绑定校验与执行器分发问的是同一件事，
 *  不各写一份名单（今天答 true 的只有 concurrent）。未知策略名答 false：绑定侧先拒，比等到
 *  执行器那句 `unknown strategy` 早一步。 */
export function strategySupportsCollect(name: string): boolean {
  return !!builtinStrategies().get(name)?.collect
}
export type { ExecutionStrategy, StrategyContext, StrategyMemberView } from './types.ts'
