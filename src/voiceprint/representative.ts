import type { DiarizedSegment } from './resolve.ts'
import type { WindowSpeakerRep } from './engine-client.ts'

/**
 * 「一组段的代表向量」的**唯一口径**：时长加权单位均值。
 *
 * 为什么要单独成一个模块：这套口径此前在两处各写了一遍，而只有一处跟着改过——
 * `05582fc4` 把跨窗合并（`windowed.ts`）的代表从「最长单段」换成加权均值，
 * 声纹库那一侧（`identify.ts` 的簇代表 → `store.ts` 的 `enrollFromCluster`）却仍是
 * 「该簇第一段的原始 embedding」。后果在真实数据上兑现了：喜剧之王 E02 的过合并簇
 * 「林简七」第一段恰好是庞博的七秒点评，于是登记进声纹库的那份"林简七"存的是庞博的声音
 * （全程留档在 `docs/superpowers/specs/2026-07-25-voiceprint-global-clustering-design.md` §8.1）。
 * 口径分叉本身就是 bug 的温床——所以现在只有这一份实现。
 *
 * ⚠ **换这个口径 = 换距离尺度**。凡是拿这些向量之间的距离做判断的常数
 * （`windowed.ts` 的 `DEFAULT_THRESHOLD`、`identify.ts` 的认名阈值）都必须重新定，
 * 且**存量声纹会全部失效**——旧口径算出的向量与新口径不可比。
 */
export interface Representative {
  /** 单位向量；`null` = 取不出代表（没有任何可用段，或所有段时长为零）。 */
  emb: number[] | null
  /** 参与计算的段的累计时长（秒）。 */
  durationS: number
  /** 贡献了方向的段数（原始向量非零、且减去 center 后仍非零）。 */
  usableSegments: number
}

function normalizeToUnit(v: number[]): number[] | null {
  let sq = 0
  for (const x of v) sq += x * x
  const n = Math.sqrt(sq)
  if (!(n > 0)) return null
  return v.map((x) => x / n)
}

/** 原始向量是否非零。判零必须用它、且必须在减 center 之前调用：减完之后一个原本全零的
 *  段会变成 `-center`（非零），于是原来被正确丢弃的垃圾段会混进来。 */
function isNonZero(v: number[]): boolean {
  for (const x of v) if (x !== 0) return true
  return false
}

/**
 * 一组段的代表向量 = 各段单位向量按**段时长**加权的均值，再归一化。
 *
 * 为什么先单位化再加权平均（而不是直接平均原始向量）：段级 embedding 的模长携带的是
 * 「这段音频有多响/多长」，不是「这是谁」；不先归一化，一段特别响的插话就能主导整个代表。
 *
 * @param center 可选的共享成分（如全集均值），在单位化之前从每段原始向量里减掉。
 *   缺省不减 —— 与历史行为逐字节一致。
 */
export function representativeOf(
  segments: Iterable<DiarizedSegment>,
  center?: number[] | null,
): Representative {
  function* weighted(): Generator<{ vec: number[]; weight: number }> {
    for (const s of segments) {
      // 判零看**原始**向量（见 isNonZero 头注）——顺序不可与减 center 对调
      if (!isNonZero(s.embedding)) continue
      const centered = center ? s.embedding.map((x, i) => x - (center[i] ?? 0)) : s.embedding
      // 减完恰好落在原点（该段等于 center）也会被 weightedUnitMean 的判零挡掉
      yield { vec: centered, weight: s.end - s.start }
    }
  }
  const { emb, weight, used } = weightedUnitMean(weighted())
  return { emb, durationS: weight, usableSegments: used }
}

/**
 * 上面那条口径的**计算核**：一组 (向量, 权重) → 各自单位化后按权重求均值，再归一化。
 *
 * 单独拆出来是为了让**库用簇代表**（`windowed.ts` 把同一全局簇下各窗的干净代表聚起来）
 * 走的是同一份实现，而不是照着抄一遍——口径分叉正是本模块头注记的那个 bug 的温床。
 * 输入不再是「段」而是任意带权向量，因为干净代表不是段：它是容器拼接门控后音频重算的
 * 一个向量，权重取该「窗内说话人」的**实际发言秒数**。
 *
 * 零向量、以及归一化不出方向的项直接跳过（不占权重）。全部跳过或总权重为 0 → `emb: null`。
 */
export function weightedUnitMean(
  items: Iterable<{ vec: number[]; weight: number }>,
): { emb: number[] | null; weight: number; used: number } {
  let sum: number[] | null = null
  let weight = 0
  let used = 0
  for (const it of items) {
    if (!isNonZero(it.vec)) continue
    const u = normalizeToUnit(it.vec)
    if (!u) continue
    if (!sum) sum = new Array<number>(u.length).fill(0)
    for (let i = 0; i < u.length; i++) sum[i] += u[i] * it.weight
    weight += it.weight
    used += 1
  }
  const emb = sum && weight > 0 ? normalizeToUnit(sum.map((x) => x / weight)) : null
  return { emb, weight, used }
}

/**
 * 容器给的 `speakers[]` → 「局部 speaker → 干净单位向量」。**弃权者与空向量都不在结果里**。
 *
 * 弃权（`abstained`）必须在这里就被挡掉，而不是靠下游各自判：弃权的语义是「容器看过音频
 * 之后说这段回答不了『这是谁』」，它一旦漏进任何一份代表，被门控拦下的脏音频就又回来了。
 * 缺省（整个 `speakers` 没有这一条）是另一回事——那只是没人算过，退回段级均值是对的，
 * 所以这里只负责「有没有干净代表」，不负责兜底。
 */
export function cleanRepsOf(speakers: WindowSpeakerRep[] | undefined): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const sp of speakers ?? []) {
    if (sp.abstained || !sp.embedding.length) continue
    const u = normalizeToUnit(sp.embedding)
    if (u) out.set(sp.speaker, u)
  }
  return out
}
