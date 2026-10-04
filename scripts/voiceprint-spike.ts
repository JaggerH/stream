/**
 * 声纹跨窗合并的离线评估器（spike 用）。
 *
 * 读 Task 2 留下的窗 dump（含每段嵌入），跑「新全局凝聚 @默认阈值 0.25」合并，打印验收所需
 * 的全部数字。重活（抽音频 + diarize）只在产出 dump 时付一次，这里秒级出数。
 *
 * ⚠ 本脚本**不再跑基线对照**。上一轮曾用 `mergeWindows(windows, { threshold: 0.5 })` 冒充
 * "旧行为"——那其实是**新算法喂旧阈值**，不是改动前那套按窗序一遍过贪心；旧实现已被这次改动
 * 整段替换掉，脚本里没有路径能单跑它。拿它当基线量出来的"集中度不低于基线"因此不成立，
 * 教训写进了 docs/superpowers/specs/2026-07-25-voiceprint-global-clustering-design.md §4.1。
 *
 * 真基线只能靠一次性历史事实取得，不在脚本里假装能跑：
 *   git show 8b0bedbb:src/voiceprint/windowed.ts > /tmp/windowed-old.ts   # 改动前的实现
 *   # 把其中的 mergeWindows 单独导出成临时模块，用同一份 dump 跑一遍，手抄数字
 * 取到的数字已经进了 §4.1 的表格，不需要、也不应该在这里复现。
 *
 * 阈值重定规则见 docs/superpowers/specs/2026-07-24-voiceprint-shared-component-removal-design.md §4.4
 * （重叠区 must-link 标定；「同分位点」规则已被证伪废弃，见该节记录）。
 *
 * ⚠ 去共性（①）与 ①b（去共性 + 投影掉最大共享主方向）两条路已在上一轮实证中被证伪并回滚
 * （见 docs/research/voiceprint-clustering.md）。它们对应的 `collectCenteredVectors` /
 * `powerIteration` / `transformForOneB` / `calibrate` 四个函数**保留定义**（研究档说明 ② 假设
 * 还要复用这套体），但不再在下面的主流程里跑，也不再打印它们的诊断输出——留着执行只会让
 * 输出难读，且已被证伪的对照组会误导读表格的人。
 *
 * 用法：node_modules/.bin/tsx scripts/voiceprint-spike.ts <dumpDir> <truthFile.json>
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mergeWindows, type WindowResult } from '../src/voiceprint/windowed.ts'
import type { DiarizedSegment } from '../src/voiceprint/resolve.ts'

/** 验收标注（**只用于判分，绝不进算法**），从 truth 文件读入。
 *  `kind:'split'` = 问1 的 A/B/C（三者必须落进不同簇）；
 *  `kind:'intact'` = 问2 的已认名簇（各自不许被拆烂）。
 *  spans 允许多段不连续——主持人这类人物本就散布全集。 */
interface TruthEntry {
  name: string
  /** `exclude` = 人耳确认的非人声（掌声/笑声）区间，从所有其他条目的 spans 里减掉。
   *  为什么必须有它：真值按「谁的 set」整段划下来时，里面本来就夹着大量掌声。系统**正确地**
   *  不把掌声算给任何人，却会被记成这条真值的失分——E02 上多多因此被低报 63% vs 实际 83%、
   *  林简七 65% vs 74%。少了这一格，指标衡量的就不是「归属对不对」，而是「set 里有多少掌声」。 */
  kind: 'split' | 'intact' | 'exclude'
  spans: [number, number][]
}

/** 从 spans 里挖掉 holes，返回剩下的区间。两边都必须按 start 排好。 */
function subtractSpans(spans: [number, number][], holes: [number, number][]): [number, number][] {
  let cur = spans
  for (const [hs, he] of holes) {
    const next: [number, number][] = []
    for (const [s, e] of cur) {
      if (he <= s || hs >= e) next.push([s, e])
      else {
        if (s < hs) next.push([s, hs])
        if (he < e) next.push([he, e])
      }
    }
    cur = next
  }
  return cur
}

function loadWindows(dir: string): WindowResult[] {
  const out: WindowResult[] = []
  for (const name of readdirSync(dir)) {
    if (!/^window-\d+\.json$/.test(name)) continue
    const w = JSON.parse(readFileSync(join(dir, name), 'utf8')) as WindowResult
    // `speakers`（容器拼接音频重算的干净代表）必须原样带上：`mergeWindows` 有它就用它、
    // 没有才退回段级均值。早期的 dump 里没有这个字段，于是这里也一直没读——结果是本脚本
    // 量的是「退化路径」，与生产实际跑的不是同一条。丢字段比数字错更难发现，因为两边都
    // 跑得出结果。
    out.push({
      index: w.index,
      startS: w.startS,
      durS: w.durS,
      segments: w.segments,
      ...(w.speakers?.length ? { speakers: w.speakers } : {}),
    })
  }
  return out.sort((a, b) => a.index - b.index)
}

function isNonZero(v: number[]): boolean {
  for (const x of v) if (x !== 0) return true
  return false
}

function unitOf(v: number[]): number[] | null {
  let sq = 0
  for (const x of v) sq += x * x
  const n = Math.sqrt(sq)
  return n > 0 ? v.map((x) => x / n) : null
}

/** 全集共享成分：所有「原始向量非零」段嵌入的无权重算术平均。与 windowed.ts 的
 *  `globalMeanEmbedding` 同一定义（该函数未导出，这里镜像一份供 harness 独立复算）。 */
function globalMeanOf(windows: WindowResult[]): number[] | null {
  let sum: number[] | null = null
  let n = 0
  for (const w of windows) {
    for (const s of w.segments) {
      if (!isNonZero(s.embedding)) continue
      if (!sum) sum = new Array<number>(s.embedding.length).fill(0)
      for (let i = 0; i < sum.length; i++) sum[i] += s.embedding[i]
      n += 1
    }
  }
  return sum && n > 0 ? sum.map((x) => x / n) : null
}

/** 某个局部说话人在其窗内**全部**段上的代表向量：时长加权单位均值，centered 模式下
 *  先减 globalMean 再单位化——与 `mergeWindows` 内代表选取逐字节同一公式。 */
function fullWindowRep(segs: DiarizedSegment[], globalMean: number[] | null): number[] | null {
  let sum: number[] | null = null
  let weight = 0
  for (const s of segs) {
    if (!isNonZero(s.embedding)) continue
    const centered = globalMean ? s.embedding.map((x, i) => x - (globalMean[i] ?? 0)) : s.embedding
    const u = unitOf(centered)
    if (!u) continue
    const dur = s.end - s.start
    if (!sum) sum = new Array<number>(u.length).fill(0)
    for (let i = 0; i < u.length; i++) sum[i] += u[i] * dur
    weight += dur
  }
  return sum && weight > 0 ? unitOf(sum.map((x) => x / weight)) : null
}

function groupByLocal(segs: DiarizedSegment[]): Map<string, DiarizedSegment[]> {
  const by = new Map<string, DiarizedSegment[]>()
  for (const s of segs) {
    const l = by.get(s.speaker)
    if (l) l.push(s)
    else by.set(s.speaker, [s])
  }
  return by
}

/** 一个局部说话人落在重叠区内的段（时间已平移到全局，且已裁到重叠区）。 */
interface OverlapSeg {
  start: number
  end: number
}

function segsInOverlap(
  w: WindowResult,
  overlapStart: number,
  overlapEnd: number,
): Map<string, OverlapSeg[]> {
  const out = new Map<string, OverlapSeg[]>()
  for (const s of w.segments) {
    const gStart = w.startS + s.start
    const gEnd = w.startS + s.end
    const ovStart = Math.max(gStart, overlapStart)
    const ovEnd = Math.min(gEnd, overlapEnd)
    if (ovEnd <= ovStart) continue
    const l = out.get(s.speaker)
    const seg = { start: ovStart, end: ovEnd }
    if (l) l.push(seg)
    else out.set(s.speaker, [seg])
  }
  return out
}

function sumIntersection(a: OverlapSeg[], b: OverlapSeg[]): number {
  let total = 0
  for (const x of a)
    for (const y of b) total += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start))
  return total
}

/** 一对 must-link：window i 的局部说话人 X ↔ window i+1 的局部说话人 Y。 */
interface MustLink {
  prevIdx: number
  prevLocal: string
  nextIdx: number
  nextLocal: string
}

/** §4.4：相邻窗重叠区 must-link 标定——按重叠区内段的时间交集配对局部说话人。 */
function findMustLinks(windows: WindowResult[]): MustLink[] {
  const ordered = windows.slice().sort((a, b) => a.index - b.index)
  const links: MustLink[] = []
  for (let i = 0; i < ordered.length - 1; i++) {
    const prev = ordered[i]
    const next = ordered[i + 1]
    const overlapStart = next.startS
    const overlapEnd = prev.startS + prev.durS
    if (overlapEnd <= overlapStart) continue
    const prevCoverage = segsInOverlap(prev, overlapStart, overlapEnd)
    const nextCoverage = segsInOverlap(next, overlapStart, overlapEnd)
    for (const [prevLocal, prevSegs] of prevCoverage) {
      let bestLocal: string | null = null
      let bestSum = 0
      for (const [nextLocal, nextSegs] of nextCoverage) {
        const sum = sumIntersection(prevSegs, nextSegs)
        if (sum > bestSum) {
          bestSum = sum
          bestLocal = nextLocal
        }
      }
      if (bestLocal && bestSum > 0) {
        links.push({ prevIdx: prev.index, prevLocal, nextIdx: next.index, nextLocal: bestLocal })
      }
    }
  }
  return links
}

/**
 * 升序数组的 p95，线性插值法（type-7，Excel/numpy 默认）：rank = 0.95*(n-1)，
 * 在相邻两个样本间按小数部分插值。
 * 之前用最近秩（Math.ceil(0.95*n)-1）在 n<20 时恒等于 max(D)——而 §4.4
 * 选 p95 而非 max 正是为了不被单个坏配对（重叠区误配）挟持，真实每集
 * 5–20 对 must-link 恰好落在这个失效区间，必须换成插值法。
 */
function p95(sorted: number[]): number {
  if (!sorted.length) return NaN
  if (sorted.length === 1) return sorted[0]
  const rank = 0.95 * (sorted.length - 1)
  const lo = Math.floor(rank)
  const frac = rank - lo
  const hi = Math.min(lo + 1, sorted.length - 1)
  return sorted[lo] + frac * (sorted[hi] - sorted[lo])
}

/** 用 must-link 对的全窗代表距离标定阈值：threshold = p95(D) + 0.05，样本 <5 对时告警退回 0.5。 */
function calibrate(
  links: MustLink[],
  windows: WindowResult[],
  globalMean: number[] | null,
  label: string,
): { threshold: number; distances: number[] } {
  const byIndex = new Map<number, WindowResult>()
  for (const w of windows) byIndex.set(w.index, w)
  const distances: number[] = []
  for (const link of links) {
    const prevW = byIndex.get(link.prevIdx)!
    const nextW = byIndex.get(link.nextIdx)!
    const prevSegs = groupByLocal(prevW.segments).get(link.prevLocal) ?? []
    const nextSegs = groupByLocal(nextW.segments).get(link.nextLocal) ?? []
    const repA = fullWindowRep(prevSegs, globalMean)
    const repB = fullWindowRep(nextSegs, globalMean)
    if (!repA || !repB) continue
    const dist = 1 - repA.reduce((s, x, i) => s + x * repB[i], 0)
    distances.push(dist)
  }
  distances.sort((a, b) => a - b)
  if (distances.length < 5) {
    console.warn(
      `[calibrate:${label}] must-link 全窗代表距离样本 |D|=${distances.length} < 5，标定不可信，退回阈值 0.5`,
    )
    return { threshold: 0.5, distances }
  }
  const threshold = p95(distances) + 0.05
  return { threshold, distances }
}

/** ①b：收集全集所有「原始向量非零」段的**居中**向量 {e - globalMean}，
 *  用于估计最大共享主方向。与 globalMeanOf 同一份体（非零判据、遍历顺序）一致，
 *  只是多减一次 globalMean，不加权、不去重。 */
function collectCenteredVectors(windows: WindowResult[], globalMean: number[]): number[][] {
  const out: number[][] = []
  for (const w of windows) {
    for (const s of w.segments) {
      if (!isNonZero(s.embedding)) continue
      out.push(s.embedding.map((x, i) => x - (globalMean[i] ?? 0)))
    }
  }
  return out
}

/** C @ v，C = Σ vec·vecᵀ（协方差，未除样本数——特征向量方向不受标量缩放影响）。
 *  不显式构造 dim×dim 矩阵，直接按「Σ (vec·v) · vec」算，O(n·dim)/次。 */
function covTimes(vectors: number[][], v: number[]): number[] {
  const dim = v.length
  const out = new Array<number>(dim).fill(0)
  for (const vec of vectors) {
    let dot = 0
    for (let i = 0; i < dim; i++) dot += vec[i] * v[i]
    if (dot === 0) continue
    for (let i = 0; i < dim; i++) out[i] += dot * vec[i]
  }
  return out
}

/** 幂迭代求居中向量集合的最大主方向。确定性初始化：范数最大的那个居中向量
 *  （禁用 Math.random，脚本必须可复现）；每步归一化，迭代 `iterations` 次。 */
function powerIteration(vectors: number[][], iterations = 100): number[] {
  if (vectors.length === 0) throw new Error('powerIteration: 空向量集')
  let seed = vectors[0]
  let seedNormSq = -1
  for (const v of vectors) {
    let sq = 0
    for (const x of v) sq += x * x
    if (sq > seedNormSq) {
      seedNormSq = sq
      seed = v
    }
  }
  let u = unitOf(seed)
  if (!u) throw new Error('powerIteration: 种子向量为零向量')
  for (let iter = 0; iter < iterations; iter++) {
    const w = covTimes(vectors, u)
    const un = unitOf(w)
    if (!un) break // 已收敛到不动点（罕见：协方差退化）
    u = un
  }
  return u
}

/** ①b 前置变换：v = (e - globalMean) 再投影掉主方向 u 上的分量，**不单位化**
 *  （mergeWindows 内部会单位化）。原始向量全零的段保持全零，保住零段跳过语义。 */
function transformForOneB(windows: WindowResult[], globalMean: number[], u: number[]): WindowResult[] {
  return windows.map((w) => ({
    ...w,
    segments: w.segments.map((s) => {
      if (!isNonZero(s.embedding)) return { ...s, embedding: s.embedding.slice() }
      const centered = s.embedding.map((x, i) => x - (globalMean[i] ?? 0))
      let dot = 0
      for (let i = 0; i < centered.length; i++) dot += centered[i] * u[i]
      const v = centered.map((x, i) => x - dot * u[i])
      return { ...s, embedding: v }
    }),
  }))
}

/** 一组 spans 覆盖到的各簇各占多少秒，降序。 */
function clustersIn(segs: DiarizedSegment[], spans: [number, number][]): [string, number][] {
  const by = new Map<string, number>()
  for (const s of segs) {
    for (const [start, end] of spans) {
      const ov = Math.max(0, Math.min(s.end, end) - Math.max(s.start, start))
      if (ov > 0) by.set(s.speaker, (by.get(s.speaker) ?? 0) + ov)
    }
  }
  return [...by.entries()].sort((a, b) => b[1] - a[1])
}

/** 一条 truth 的度量：主簇、主簇占比（集中度）、覆盖到的簇数——
 *  分两档：全部 / 在该段内占时 >=5s 的（滤掉一两秒碎渣噪声，是判断
 *  "这个人被拆烂了没有"的有效指标，簇总数会被离所有簇都远的碎片单簇冲高）。 */
function measure(segs: DiarizedSegment[], t: TruthEntry) {
  const cs = clustersIn(segs, t.spans)
  const total = cs.reduce((n, [, sec]) => n + sec, 0)
  const top = cs[0]
  return {
    dominant: top?.[0] ?? '(空)',
    concentration: total > 0 ? (top?.[1] ?? 0) / total : 0,
    clusterCount: cs.length,
    clusterCount5s: cs.filter(([, sec]) => sec >= 5).length,
  }
}

/** 生产可见性的**代理**指标，对齐前端名单门槛（`app/src/hooks/useSpeakerMap.ts` 的
 *  `ROSTER_MIN_SECONDS = 30`，`/clusters` 按簇总时长过滤：`c.seconds >= 30 || c.pending`）——
 *  **不是** 60。`/blocks` 色块另有前端显式传的 `minSeconds: BLOCK_MIN_SECONDS = 30`（同一
 *  文件）；后端端点默认的 60（`src/http/app.ts` 的 `/api/voiceprint/item/:itemId/blocks`）
 *  在生产路径上从未被用到，只是没传 query 时的兜底。
 *
 *  即便门槛对齐到 30，这仍然只是**代理**，不是真实可见性：生产 `/blocks` 跑在**对齐到
 *  diarization 的 ASR 文本段**上，且做了 gap=15s 桥接（`mergePersonSpans`），这份离线
 *  dump 只有 diarize 出的说话人段、没有配套 ASR 文本，复现不了同一条管线。这里量的是
 *  「该簇在全片的发言总时长（全部段 `end-start` 之和，未做 gap 桥接）是否 >=30s」，
 *  用来近似「这个人会不会出现在名单/色块里」，不能当作逐簇可见性的精确复现。 */
function rosterVisibleSpeakers(segs: DiarizedSegment[]): number {
  const totals = new Map<string, number>()
  for (const s of segs) totals.set(s.speaker, (totals.get(s.speaker) ?? 0) + (s.end - s.start))
  let n = 0
  for (const d of totals.values()) if (d >= 30) n++
  return n
}

/** 问1：kind:'split' 的主簇是否两两不同。 */
function verdict1(segs: DiarizedSegment[], truth: TruthEntry[]): boolean {
  const splits = truth.filter((t) => t.kind === 'split')
  const dominants = splits.map((t) => measure(segs, t).dominant)
  return new Set(dominants).size === splits.length
}

/** 问2 的诊断版计分：某次合并结果里，已认名簇（kind:'intact'）相对 refRes（默认阈值 0.25
 *  的那次跑）集中度下降 >0.05 记一个 WORSE——**不是**对比已删掉的假基线，只是看「偏离默认阈值
 *  的其它阈值有没有比默认更差」。只用于诊断扫描逐行打印，不参与阈值选择。 */
function verdict2WorseCount(
  segs: DiarizedSegment[],
  truth: TruthEntry[],
  refRes: Map<string, ReturnType<typeof measure>>,
): number {
  let worse = 0
  for (const t of truth.filter((x) => x.kind === 'intact')) {
    const b = refRes.get(t.name)
    if (!b) continue
    const c = measure(segs, t)
    if (c.concentration < b.concentration - 0.05) worse++
  }
  return worse
}

function report(title: string, segs: DiarizedSegment[], truth: TruthEntry[]) {
  console.log(`\n=== ${title} ===`)
  const total = new Set(segs.map((s) => s.speaker)).size
  const visible30s = rosterVisibleSpeakers(segs)
  console.log(`簇总数: ${total}  (其中 >=30s 的簇: ${visible30s} —— 对齐前端名单门槛的代理指标,非精确复现)`)
  const results = new Map<string, ReturnType<typeof measure>>()
  for (const t of truth) {
    const m = measure(segs, t)
    results.set(t.name, m)
    console.log(
      `  [${t.kind}] ${t.name}: 主簇=${m.dominant} 集中度=${(m.concentration * 100).toFixed(0)}% 覆盖簇数=全部${m.clusterCount}(>=5s:${m.clusterCount5s})`,
    )
  }
  const splits = truth.filter((t) => t.kind === 'split')
  const ok = verdict1(segs, truth)
  console.log(`  → 问1「不同演员分开了没有」: ${ok ? 'YES' : 'NO'} (${new Set(splits.map((t) => results.get(t.name)!.dominant)).size}/${splits.length} 个主簇互不相同)`)
  const agg = attributionRate(segs, truth)
  console.log(
    `  → 归属正确率（按时长加权）: ${(agg.rate * 100).toFixed(1)}%  ` +
      `(${agg.correct.toFixed(0)}s / ${agg.covered.toFixed(0)}s 真值覆盖，真值覆盖全片 ${(agg.coverage * 100).toFixed(0)}%)`,
  )
  return results
}

/** **单一刀口**：真值覆盖的每一秒里，有多少秒落在了该人的主簇上（按时长加权）。
 *
 *  为什么需要它：逐条集中度是一张表，读表的人得自己权衡"这条好了那条差了"，
 *  历史上因此栽过——DFN 那轮先看到"异段相似度中位数改善"就差点判它有效，
 *  而真正管事的上界是变差的（spec 2026-07-27-voiceprint-dfn-preclean §5.3）。
 *  一个改动要么把这个数推上去，要么没有。
 *
 *  ⚠ 它的天花板是真值覆盖率：`truth-e02.json` 只覆盖 6.5% 的时长，那上面的
 *  归属正确率说明不了整集。铺开版见 `truth-e02-full.json`（约 63%），评委点评区
 *  仍是空白——那片区域的判据只有人耳。**报这个数必须同时报覆盖率**，否则
 *  "94% 归属正确"会被读成"整集 94% 对了"，而它可能只测了六分之一。 */
function attributionRate(segs: DiarizedSegment[], truth: TruthEntry[]) {
  let correct = 0
  let covered = 0
  for (const t of truth) {
    const cs = clustersIn(segs, t.spans)
    covered += cs.reduce((n, [, sec]) => n + sec, 0)
    correct += cs[0]?.[1] ?? 0
  }
  const episode = segs.reduce((n, s) => Math.max(n, s.end), 0)
  return { correct, covered, rate: covered > 0 ? correct / covered : 0, coverage: episode > 0 ? covered / episode : 0 }
}

const [dir, truthPath] = process.argv.slice(2)
if (!dir || !truthPath) {
  console.error('用法: node_modules/.bin/tsx scripts/voiceprint-spike.ts <dumpDir> <truthFile.json>')
  process.exit(1)
}
// 真值文件允许夹带以 `_` 开头的说明条目（怎么钉边界、哪片区域故意留空）——
// 那些注解正是判分口径本身，写在文件里比写在别处更不容易脱钩。没有 spans 的一律跳过。
const rawTruth = (JSON.parse(readFileSync(truthPath, 'utf8')) as TruthEntry[]).filter((t) => Array.isArray(t.spans))
const holes = rawTruth
  .filter((t) => t.kind === 'exclude')
  .flatMap((t) => t.spans)
  .sort((a, b) => a[0] - b[0])
const truth = rawTruth
  .filter((t) => t.kind !== 'exclude')
  .map((t) => ({ ...t, spans: subtractSpans(t.spans, holes) }))
if (holes.length) {
  const hs = holes.reduce((n, [a, b]) => n + (b - a), 0)
  console.log(`真值里挖掉 ${holes.length} 段人耳确认的掌声/笑声（${hs.toFixed(0)}s）——它们不属于任何人`)
}
const windows = loadWindows(dir)
console.log(`加载 ${windows.length} 个窗，共 ${windows.reduce((n, w) => n + w.segments.length, 0)} 段`)

const mustLinks = findMustLinks(windows)
console.log(`\n重叠区 must-link 配对数: ${mustLinks.length}`)
for (const l of mustLinks) {
  console.log(`  window${l.prevIdx}:${l.prevLocal} ↔ window${l.nextIdx}:${l.nextLocal}`)
}

/** 诊断旁路：固定阈值扫描，逐行打印簇数 + 问1 + 问2（诊断版，对比 refRes = 默认阈值 0.25
 *  的那次跑，**不是**对比已删掉的假基线）。`mergeAt` 封装了要跑的 mergeWindows 调用方式。
 *  纯诊断：只供人工复核默认阈值没选歪，不参与阈值选择。 */
function diagnosticSweep(
  label: string,
  mergeAt: (threshold: number) => DiarizedSegment[],
  truth: TruthEntry[],
  refRes: Map<string, ReturnType<typeof measure>>,
) {
  console.log(`\n=== 诊断旁路：${label}固定阈值扫描（0.1..0.6，step 0.05，较默认阈值 0.25，不参与选值）===`)
  for (let t = 0.1; t <= 0.6 + 1e-9; t += 0.05) {
    const tt = Math.round(t * 100) / 100
    const swept = mergeAt(tt)
    const clusterCount = new Set(swept.map((s) => s.speaker)).size
    const ok = verdict1(swept, truth)
    const worseCount = verdict2WorseCount(swept, truth, refRes)
    console.log(
      `  threshold=${tt.toFixed(2)}  簇数=${clusterCount}  问1=${ok ? 'YES' : 'NO'}  ${worseCount === 0 ? '问2=ok' : `问2=${worseCount} worse`}`,
    )
  }
}

const now = mergeWindows(windows)
const nowRes = report('新算法 (全局凝聚 @默认阈值 0.25)', now, truth)
console.log('\n→ 问2「已认名的人有没有被拆烂」: 读上面每条 [intact] 的集中度 + 覆盖簇数——')
console.log('  本脚本不再假装有基线可比，判断请对着 spec §4 的四条门读数，不在这里下 YES/NO。')

diagnosticSweep('新算法', (t) => mergeWindows(windows, { threshold: t }), truth, nowRes)
