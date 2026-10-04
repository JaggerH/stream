// 模型结论进账本之前的代码闸（spec 2026-09-03-netdisk-llm-adjudicator §5）。**模型不删文件**：
// 这里只放行 is-episode / not-episode 两种决定，从不碰删除；`prefer`（两份留哪份）v1 不经这条闸,
// 压根不会被问到模型（spec §2 边界）。
import { DURATION_TOLERANCE_S } from '../match-spec.ts'
import { qiConflict } from '../reconcile/plan.ts'
import type { Card, CardCandidate } from './cards.ts'
import type { Decision } from './prompt.ts'

/** 离谱到这个数视为"缺席"，不参与时长比对（spec §5 条 5：探测失败不是证据）。 */
const OUTRAGEOUS_DURATION_S = 12 * 3600

const usableDurationS = (s: number | undefined): number | undefined =>
  s !== undefined && s <= OUTRAGEOUS_DURATION_S ? s : undefined

export type GateResult = { ok: true } | { ok: false; reason: string }

/**
 * 逐条过闸（spec §5）：
 *  · `is-episode` 必须同时满足 5 条——confidence high、leftKey 在 candidates 里、期号闸
 *    （`qiConflict`）、季一致（`dirSeason` vs 候选季号）、时长（对节目单与对货架上已有那份，
 *    两处都在场才比）；
 *  · `not-episode` 只要前两条（confidence high、leftKey 在 candidates 里）；
 *  · `unsure` 与非 `high` 的 confidence 一律不收（不区分 verdict，先挡）。
 *
 * 只依赖 `Card` 与 `Decision`，不碰 IO——落账、撤回、再跑一轮都是 `service.ts` 的事（Task B）。
 */
export function admitDecision(card: Card, decision: Decision): GateResult {
  if (decision.verdict === 'unsure') return { ok: false, reason: 'unsure：模型自己拿不准' }
  if (decision.confidence !== 'high') return { ok: false, reason: 'confidence 不是 high' }
  // `not-episode` 不带 leftKey = 「都不是」：对这张卡上每一个候选各落一条 not-episode（prompt 明说可以答
  // none）。活体（脱口秀，2026-09-03）：6 张卡模型全答 none、闸按"没给 leftKey"整批拒收，等于白问。
  if (decision.verdict === 'not-episode' && !decision.leftKey) {
    return card.candidates.length > 0 ? { ok: true } : { ok: false, reason: '卡上没有候选，"都不是"无处可落' }
  }
  if (!decision.leftKey) return { ok: false, reason: '没给 leftKey' }

  const candidate = card.candidates.find((c) => c.leftKey === decision.leftKey)
  if (!candidate) return { ok: false, reason: 'leftKey 不在这张卡的 candidates 里——模型凭空指了一集' }

  if (decision.verdict === 'not-episode') return { ok: true }

  // 以下四条只对 is-episode 生效（spec §5 条 3–5）。
  const conflict = qiConflict(card.file.name, candidate.title)
  if (conflict) return { ok: false, reason: `期号闸：${conflict}` }

  const seasonMismatch = seasonInconsistent(card, candidate)
  if (seasonMismatch) return { ok: false, reason: seasonMismatch }

  const fileDurationS = usableDurationS(card.file.durationS)
  if (candidate.authorityDurationS !== undefined && fileDurationS !== undefined) {
    if (Math.abs(fileDurationS - candidate.authorityDurationS) > DURATION_TOLERANCE_S) {
      return { ok: false, reason: '时长与节目单差得太多' }
    }
  }
  const existingDurationS = usableDurationS(candidate.existing?.durationS)
  if (existingDurationS !== undefined && fileDurationS !== undefined) {
    if (Math.abs(fileDurationS - existingDurationS) > DURATION_TOLERANCE_S) {
      return { ok: false, reason: '时长与货架上已有那份差得太多——不是同一集的另一版' }
    }
  }

  return { ok: true }
}

/** 季一致性检查（spec §5 条 4）。两侧任一没有季概念（播客/电影绑定、或抽不出季号的 leftKey）
 *  就没有可比的东西，视为通过——多季判断只对能判出季的绑定成立。 */
function seasonInconsistent(card: Card, candidate: CardCandidate): string | null {
  if (card.dirSeason == null || candidate.season == null) return null
  if (card.dirSeason !== candidate.season) {
    return `季不一致：目录是 S${card.dirSeason}，候选是 S${candidate.season}`
  }
  return null
}
