import type { MatchSpec } from '../types.ts'
import type { SpecAmbiguity, SpecAssignment, SpecLeft, SpecMatchResult, SpecRight, StageCtx } from '../match-spec.ts'
import { computeCoverage } from '../match-spec.ts'
import { matchByEvidence } from './resolve.ts'
import type { Ask, Resolution } from './types.ts'

/**
 * 引擎 → 两个消费方接口的**适配层**：把 `Resolution` 投影成 `SpecMatchResult`
 * （assignments + ambiguous + coverage）。
 *
 * 为什么要有它而不是让消费方直接吃 `Resolution`：`sync.ts` 那侧的覆盖率
 * （`computeCoverage`）按 `StageCtx` 的四个字段算，前端与账本的字段名都长在上面。
 * 这层在，判决的形状与对外契约就能各自演进。
 *
 * **不丢**（I1 的边界条件）：`SpecMatchResult` 那三个字段装不下的东西——文件侧问句（I3）、
 * 每个文件的裁决轨迹——由 `EvidenceMatchResult.resolution` 原样带出。适配层只做投影，
 * 绝不做取舍：判决在这里少一样，下游就永远看不见它了。
 */

export interface EvidenceMatchResult extends SpecMatchResult {
  /**
   * 完整判决。上面那三个字段是它的**投影**，不是另一份结论。
   * 归档器（`reconcile/plan.ts`）读的是这一份：残差判定（`residual`）、文件侧问句
   * （`asks` 里带 `path` 的那些）、hover card 的 `trails` 都只在这里有。
   */
  resolution: Resolution
}

/** 集侧问句 → `SpecAmbiguity`。文件侧问句（I3）没有 `leftKey`，不走这里，见 `fileAsksOf`。 */
const toAmbiguity = (a: Ask): SpecAmbiguity => ({
  leftKey: a.leftKey!,
  stage: a.stage as SpecAmbiguity['stage'],
  reason: a.reason as SpecAmbiguity['reason'],
  candidates: a.candidates,
  threshold: a.threshold,
  margin: a.margin,
})

/**
 * 集侧问句（有 `leftKey`）。**判据是 `leftKey` 在不在，不是 reason 的取值**——
 * `dual-episode-conflict` 这个新 reason 只出现在文件侧，但把两者绑死会让"将来某条集侧规则
 * 也想用新 reason"变成一个静默丢弃的坑。
 */
export const leftAsksOf = (res: Resolution): Ask[] => res.asks.filter((a) => a.leftKey != null)
/** 文件侧问句（I3 的双集冲突卡）。`SpecMatchResult` 里没有它的位置，只能走 `resolution`。 */
export const fileAsksOf = (res: Resolution): Ask[] => res.asks.filter((a) => a.path != null)

/**
 * `Resolution` → `StageCtx`（覆盖率的取数形）。四个字段：
 *  - `usedRight` = 全部认领路径 + 同集其余份。裁决层的 `used` 只在 `claim`/`runSweep` 里长，
 *    两处都把结果写进了 `assignments`，所以这个并集**就是**它，不是近似。
 *  - `ambiguous` 只收集侧问句：`computeCoverage` 靠 `ambiguous.has(leftKey)` 分
 *    "有像样候选没敢配" 与 "压根没信号"，混进文件侧问句会把某一集凭空算成 ambiguous。
 */
export function ctxFromResolution(res: Resolution): StageCtx {
  const assignments = new Map<string, SpecAssignment>()
  const usedRight = new Set<string>()
  for (const [leftKey, a] of res.assignments) {
    // `losers` 空时**整个字段缺席**（下游普遍写 `a.losers ?? []`，但深比较的测试看得见
    // 空数组与缺席的区别，绑定里存量 matchSpec 的形状也是缺席）。
    assignments.set(leftKey, {
      rightFile: a.path,
      confidence: a.confidence,
      status: a.status,
      ...(a.losers.length ? { losers: a.losers } : {}),
    })
    usedRight.add(a.path)
    for (const l of a.losers) usedRight.add(l)
  }
  const ambiguous = new Map<string, SpecAmbiguity>()
  for (const a of leftAsksOf(res)) ambiguous.set(a.leftKey!, toAmbiguity(a))
  return { assignments, usedRight, ambiguous, missingByKey: new Map(res.missingByLeft) }
}

/** `Resolution` + 完整两侧 → 消费方那份结果（覆盖率仍由 `computeCoverage` 算，同一把尺）。 */
export function resultFrom(res: Resolution, left: SpecLeft[], right: SpecRight[]): EvidenceMatchResult {
  const ctx = ctxFromResolution(res)
  return {
    assignments: ctx.assignments,
    ambiguous: [...ctx.ambiguous.values()],
    coverage: computeCoverage(left, right, ctx),
    resolution: res,
  }
}

/** **消费方入口**：谱 + 两侧 → `SpecMatchResult` + 完整判决。`sync.ts` 调的就是它。 */
export function matchByEvidenceResult(spec: MatchSpec, left: SpecLeft[], right: SpecRight[]): EvidenceMatchResult {
  return resultFrom(matchByEvidence(spec, left, right), left, right)
}

/** 空判决——季分区折叠的幺元。 */
export function emptyResolution(): Resolution {
  return { assignments: new Map(), asks: [], residual: [], trails: new Map(), missingByLeft: new Map() }
}

/**
 * 合并两份判决——**季分区专用**（左键互不相交、右侧文件已按季分好区，
 * 后写覆盖前写）。`residual`/`asks`/`trails` 直接并：一个文件只属于一个季的分区，两份判决
 * 里不会同时出现；归不了季的文件夹压根不进任何分区，两边都没有它——它照常报成 orphan。
 */
export function mergeResolutions(a: Resolution, b: Resolution): Resolution {
  return {
    assignments: new Map([...a.assignments, ...b.assignments]),
    asks: [...a.asks, ...b.asks],
    residual: [...a.residual, ...b.residual],
    trails: new Map([...a.trails, ...b.trails]),
    missingByLeft: new Map([...a.missingByLeft, ...b.missingByLeft]),
  }
}
