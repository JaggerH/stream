// src/providers/ladder-trace.ts
//
// 一次 Provider 调用**走了梯子上的哪几档**——谁赢了、每档多久、没成的为什么。
// 从执行器的 InvokeResult 投影出来，两个消费方共用：DebugBox（一次性，见 debug-entry.ts）
// 与转换记录（持久化，见 src/conversions/store.ts）。
import type { InvokeResult, InvokeMiss } from './executor.ts'

export interface ResolveRung {
  member: string
  /** 真源 id——寻址键可能是用户起的实例名（`zhipu`），单看它答不出背后是哪个 source。 */
  source: string
  ms: number
  /** `rejected` 不是执行器产出的——LlmForTask 的升级重试（`src/llm/task.ts`）事后把一档赢了但被
   *  `validate` 否决的 rung 改写成它，好让走法里「答过但不算数」和「真的赢了」区分得开。 */
  outcome: 'win' | 'miss' | 'error' | 'rejected'
  reason?: string
}

/** Turn an executor InvokeResult ladder into debug rungs (per-member ms/outcome, joined with the
 *  miss reason). Shared by every resolve-style channel (audio / video / transcribe). */
export function resolveRungs(res: InvokeResult | null): ResolveRung[] {
  if (!res) return []
  const reasonOf = new Map((res.misses ?? []).map((m) => [m.member, m.reason]))
  return (res.timings ?? []).map((t) => ({ member: t.member, source: t.source, ms: t.ms, outcome: t.outcome, reason: t.outcome === 'win' ? undefined : reasonOf.get(t.member) }))
}

/** 一次 Provider 调用的**梯子走法**：谁赢了（`via` = 赢家的寻址键，null = 全员没结果），
 *  以及每一档各花多久、结果如何、没成的为什么。
 *
 *  这不只是"调试信息"：它是「这条结果是谁产出的」这个问题的**唯一**答案来源。执行器每次
 *  invoke 都算出它，过去只喂给 DebugBox（一次性、随会话消失），转换记录里因此查不到——
 *  同一条 OCR 结果，是白嫖的视觉模型出的还是本地 MinerU 兜的底，事后无从分辨。存下来才有历史。 */
export interface LadderTrace {
  via: string | null
  rungs: ResolveRung[]
}

/** InvokeResult → 可持久化的梯子走法。`res` 为 null（成员一个都没跑起来）时给空走法，
 *  不是 undefined——"跑了但全没成"和"根本没调用"由 rungs 空不空区分。 */
export function ladderTrace(res: InvokeResult | null): LadderTrace {
  return { via: res && res.strategy === 'sequential' ? res.via : null, rungs: resolveRungs(res) }
}

/** 带着梯子走法一起抛的失败。**失败恰恰是最需要走法的时候**——「为什么没出结果」的答案就是
 *  「梯子上每一档分别怎么了」；用普通 Error 一抛，那份信息在 catch 之前就没了。 */
export class LadderError extends Error {
  constructor(message: string, readonly ladder: LadderTrace) {
    super(message)
    this.name = 'LadderError'
  }
}

/** 从任意 throw 值里取出梯子走法（不是 LadderError 就没有）。 */
export function ladderOf(e: unknown): LadderTrace | undefined {
  return e instanceof LadderError ? e.ladder : undefined
}

/** sequential 行拿到 `value: null` 时，两种完全不同的真相：全员 decline（这台机器**没有**这个
 *  能力）vs 有成员试了但真的失败（**有**能力，这次没干成）。两者若被一起说成"没有结果"，
 *  排查方向会指反——前者该去配置，后者该去查模型/端点。
 *
 *  判据用 `InvokeMiss.stack`：执行器只在真 catch 到抛出的错误时才写这个字段，decline（无结果）
 *  和合同拒绝都不写（见 `executor.ts` `InvokeMiss` 的字段注释）。不做字符串匹配 reason——
 *  `stack` 就是为这个判定结构化带出的。
 *
 *  返回 `null` = 干净的"没有能力"，调用方可以照常走"未识别/未配置"的路；返回非 null =
 *  真失败的原因（member + reason 拼好），调用方应该把它当错误抛出去，不能悄悄吞成"没结果"。 */
export function realFailureReason(misses: InvokeMiss[]): string | null {
  const failed = misses.filter((m) => m.stack !== undefined)
  if (failed.length === 0) return null
  return failed.map((m) => `${m.member}: ${m.reason}`).join('；')
}
