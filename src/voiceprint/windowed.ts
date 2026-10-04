import { cosineSimilarity } from './cosine'
import { cleanRepsOf, representativeOf, weightedUnitMean } from './representative.ts'
import type { WindowSpeakerRep } from './engine-client.ts'
import type { DiarizedSegment } from './resolve'

/** 锚点门槛：累计时长低于它的「窗内说话人」不参与聚类、也不许开新簇。
 *  真实数据里容器会把一个人连续讲满一窗判成「主说话人 + 三五秒碎片」，
 *  碎片的代表向量由极短音频算出、噪声大，让它开簇等于往结果里撒沙子。 */
const MIN_ANCHOR_S = 3

/**
 * 跨窗合并的默认距离阈值。
 *
 * ⚠ **它绑定「代表 = 该 local 全部段的时长加权单位均值」这个定义**。代表的定义一变，
 * 距离的尺度就变，这个常数必须重定。上一次就栽在这里：代表从「最长单段」换成加权均值后
 * 尺度缩了三倍多，阈值仍留在 0.5，正好落在「全部跨窗配对」距离的中位数上——
 * 等于无差别地并掉一半，一个人的簇里混进别人整段发言。
 *
 * 0.25 的来历（`docs/superpowers/specs/2026-07-25-voiceprint-global-clustering-design.md` §2.1）：
 * 三份真实窗 dump（脱口秀两集 + 单人财经解说）上 0.15–0.30 整段都过验收，取宽带中点；
 * 同人跨窗的 must-link 距离 p95 实测 0.07–0.15，0.25 约等于它的两倍。
 */
const DEFAULT_THRESHOLD = 0.25

/** 代表数上限：超过它退回按窗序的贪心（`assignGlobalSpeakers`）并告警。
 *  全局凝聚是 O(n³) 上界，n = 窗内说话人总数（47 分钟一集实测 443）。 */
const MAX_REPS = 2000

/** 一个分窗 diarize 的结果：容器只看见这一窗音频，segments 时间为窗内相对、
 *  speaker 为窗内局部 label（SPEAKER_NN 从 0 重编）。 */
export interface WindowResult {
  index: number
  startS: number
  durS: number
  segments: DiarizedSegment[]
  /** 容器给的**每人一份干净代表**（拼接 ≤20s 音频重算，见 `WindowSpeakerRep` 头注）。
   *  缺省 = 老容器 / 断点续跑存下来的老窗 → 退回段级时长加权均值。 */
  speakers?: WindowSpeakerRep[]
}

/** 全局说话人质心：并入向量（单位化后）的累加和 + 计数，均值即质心（增量更新）。 */
interface Centroid {
  sum: number[]
  n: number
}

function normalizeToUnit(v: number[]): number[] | null {
  let sq = 0
  for (const x of v) sq += x * x
  const n = Math.sqrt(sq)
  if (!(n > 0)) return null
  return v.map((x) => x / n)
}

/** 原始向量是否非零。判零必须用它、且必须在 centering 之前调用：
 *  减完全局均值后，一个原本全零的段会变成 `-globalMean`（非零），
 *  于是原来被正确丢弃的垃圾段会混进来。 */
function isNonZero(v: number[]): boolean {
  for (const x of v) if (x !== 0) return true
  return false
}

/**
 * 全集共享成分 = 所有「原始向量非零」的段嵌入的**无权重**算术平均。
 *
 * 为什么不按时长加权：这里估的是「贯穿全集的共享成分」（罐头笑声垫底声、录音通道），
 * 不是「谁说得多」；不加权也少一个可调旋钮。重叠区的段会被计两次，量级上无实质影响。
 * 注意与代表向量那一步的区别——那一步**仍按时长加权**，要的是「这个人主要长什么样」。
 */
function globalMeanEmbedding(windows: WindowResult[]): number[] | null {
  let sum: number[] | null = null
  let n = 0
  for (const w of windows) {
    for (const s of w.segments) {
      if (!isNonZero(s.embedding)) continue
      if (!sum) sum = new Array<number>(s.embedding.length).fill(0)
      for (let i = 0; i < sum.length && i < s.embedding.length; i++) sum[i] += s.embedding[i]
      n += 1
    }
  }
  return sum && n > 0 ? sum.map((x) => x / n) : null
}

function centroidMean(c: Centroid): number[] {
  return c.sum.map((x) => x / c.n)
}

/**
 * 把一窗的局部说话人映射到全局说话人 id——移植 stream-packages/voiceprint/app.py
 * `_assign_global_speakers` 的贪心逻辑：
 * - 枚举 (局部代表向量, 已有全局质心) 的全部配对，按 cosine 距离升序贪心取；
 * - 距离 > threshold 的配对不并；已配过的 local、已被本窗占用的全局 id 跳过——
 *   **同一窗内两个 local 永不并到同一全局**（窗内聚类已经把他们分开了，这是硬约束不是巧合）；
 * - 剩下没配上的 local 各自新开一个全局说话人。
 * 并入时质心增量更新（sum += 单位化代表向量，n += 1）。
 * 排序比较器在距离相等时按 (local 出场序, 全局 id) 决胜，保证结果确定性
 * （app.py 靠 Python 稳定排序 + 生成顺序达到同样效果）。
 */
function assignGlobalSpeakers(
  windowSpeakers: Array<{ local: string; emb: number[] }>,
  centroids: Centroid[],
  threshold: number,
): Map<string, number> {
  const mapping = new Map<string, number>()
  if (windowSpeakers.length === 0) return mapping
  const pairs: Array<{ dist: number; localIdx: number; gid: number }> = []
  for (let li = 0; li < windowSpeakers.length; li++) {
    for (let gid = 0; gid < centroids.length; gid++) {
      const dist = 1 - cosineSimilarity(windowSpeakers[li].emb, centroidMean(centroids[gid]))
      pairs.push({ dist, localIdx: li, gid })
    }
  }
  pairs.sort((a, b) => a.dist - b.dist || a.localIdx - b.localIdx || a.gid - b.gid)
  const taken = new Set<number>()
  for (const { dist, localIdx, gid } of pairs) {
    const { local, emb } = windowSpeakers[localIdx]
    if (dist > threshold || mapping.has(local) || taken.has(gid)) continue
    mapping.set(local, gid)
    taken.add(gid)
    const c = centroids[gid]
    for (let i = 0; i < c.sum.length; i++) c.sum[i] += emb[i]
    c.n += 1
  }
  for (const { local, emb } of windowSpeakers) {
    if (mapping.has(local)) continue
    centroids.push({ sum: emb.slice(), n: 1 })
    mapping.set(local, centroids.length - 1)
  }
  return mapping
}

/** 一个「窗内说话人」的代表：单位向量 + 累计时长 + 首次出现的全局时间。 */
interface Rep {
  wi: number
  local: string
  emb: number[]
  dur: number
  firstStart: number
  /**
   * 能不能当锚点（= 参与决定"有哪些人"、并进簇质心）。
   * `false` 只有一个来源：容器的帧级门控判它**弃权**（本窗攒不够 8s 干净人声）。
   * 弃权者仍带着一个（脏的）代表往下走，但只用来**问路**——按最近簇质心找个归宿或
   * 自成一组。问路不是贡献指纹：碎片本来就不进质心（见 `assignClusters`），
   * 所以它影响不了任何别人的身份，只决定自己这堆段挂在谁名下。
   * 时间线一秒不动是硬约束——所以不能简单地把它整个丢掉。
   */
  anchorEligible: boolean
  /**
   * `emb` 是不是容器门控后的**干净代表**（`false` = 退回了段级时长加权均值）。
   * 只有 `true` 的代表才有资格聚进 `clusterReps`（进声纹库的那份），见 `mergeWindowsDetailed`。
   */
  clean: boolean
}

/**
 * 全局平均连接凝聚：把所有代表两两算 cosine 距离，最近的一对先并，
 * 簇间距离取跨簇全部配对的均值，并到最近簇间距离 > threshold 为止。
 *
 * 为什么不是按窗序的贪心（`assignGlobalSpeakers`，仍保留作规模保护的退路）：
 * 贪心里每个窗只有一次匹配已有质心的机会，匹不上就永久新开一个全局 id，
 * 质心还随并入漂移——并错一次就把中心拽偏。于是「过合并」与「过碎」是同一个
 * 形状的两头，调阈值只是在两头之间搬运痛苦。全局凝聚没有顺序，也没有"一次机会"。
 *
 * ⚠ 与 app.py 的又一处有意偏离：**放弃「同窗两个 local 永不并到同一全局」的硬约束**。
 * 那条约束只有在「窗内 diarize 可信」时才成立，而实测不成立——真实数据里
 * 一个人连续讲满一窗，容器会判出 6 个窗内说话人（主 62s + 15/10/5/3s 四个碎片）。
 * 保留约束就等于把这种碎片永久钉死在不同的全局说话人上，正是要治的病。
 *
 * 距离并列时按 (簇号小者优先) 决胜——簇号即代表在 `reps` 里的下标，
 * 而 `reps` 按 (窗 index, 窗内出场序) 生成，所以结果对同一输入完全确定。
 *
 * 复杂度：每次合并扫一遍活簇两两，总体 O(n³) 上界但 n 是"窗内说话人总数"
 * （47 分钟一集实测 443），距离用 Float64Array 平铺，实测毫秒级。
 * 超过 MAX_REPS 由调用方拦下走贪心。
 */
function clusterAverageLinkage(reps: Rep[], threshold: number): number[] {
  const n = reps.length
  const label = new Array<number>(n)
  for (let i = 0; i < n; i++) label[i] = i
  if (n <= 1) return label

  // 簇间距离以 (和, 配对数) 增量维护，均值 = 和/配对数
  const sum = new Float64Array(n * n)
  const cnt = new Float64Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = 1 - cosineSimilarity(reps[i].emb, reps[j].emb)
      sum[i * n + j] = d
      cnt[i * n + j] = 1
    }
  }
  const alive: number[] = []
  for (let i = 0; i < n; i++) alive.push(i)
  const members = new Map<number, number[]>()
  for (let i = 0; i < n; i++) members.set(i, [i])

  for (;;) {
    let bestA = -1
    let bestB = -1
    let bestD = Infinity
    for (let x = 0; x < alive.length; x++) {
      for (let y = x + 1; y < alive.length; y++) {
        const a = alive[x]
        const b = alive[y]
        const k = a * n + b
        const d = sum[k] / cnt[k]
        if (d < bestD) {
          bestD = d
          bestA = a
          bestB = b
        }
      }
    }
    if (bestA < 0 || bestD > threshold) break
    // 把 bestB 并进 bestA：与其余活簇的 (和, 配对数) 相加
    for (const o of alive) {
      if (o === bestA || o === bestB) continue
      const ka = bestA < o ? bestA * n + o : o * n + bestA
      const kb = bestB < o ? bestB * n + o : o * n + bestB
      sum[ka] += sum[kb]
      cnt[ka] += cnt[kb]
    }
    members.set(bestA, members.get(bestA)!.concat(members.get(bestB)!))
    members.delete(bestB)
    alive.splice(alive.indexOf(bestB), 1)
  }

  let ci = 0
  for (const [, group] of members) {
    for (const m of group) label[m] = ci
    ci += 1
  }
  return label
}

/**
 * 跨窗说话人合并：把各窗独立 diarize 出的「窗内局部 SPEAKER_NN」并成全局说话人。
 * 语义准绳是 stream-packages/voiceprint/app.py 的 `_diarize_windowed` /
 * `_assign_global_speakers` / `_representative_embedding`（那套参数与行为拿真实
 * OOM 案例活体验证过）。算法四步：
 *
 * 1. **代表选取**：每窗每个局部说话人取一个代表 embedding，单位化后参与聚类。
 *    ⚠ 与 app.py 的有意偏离：app.py 手里有音频和模型，把该说话人最长的若干段
 *    音频 concat 起来（至多 REP_CLIP_S=20s）重算一个代表 embedding；TS 侧没有模型，
 *    容器返回的段级 embedding 是唯一材料，所以这里取「该窗该说话人全部段的
 *    **时长加权单位均值**」当代表——均值把单段采样偏差平均掉，是 concat 重算的
 *    embedding 空间近似。曾用「最长单段」：真实数据（脱口秀 E19，47min）实测同人
 *    跨话语单段距离 p95≈0.5，一次采样偏了整窗领新号，一集并出 69 个"全局说话人"；
 *    换均值后同阈值降到 55 且跨窗 must-link 一致率更高（评估方法见 git log 本改动）。
 * 2. **全局聚类**（`assignClusters`）：先按累计时长把窗内说话人分成锚点（≥ MIN_ANCHOR_S）
 *    与碎片，只让锚点参与**全局平均连接凝聚**（`clusterAverageLinkage`）——簇间距离取
 *    跨簇全部配对的均值，最近簇间距离 ≤ threshold（默认 0.25，见 `DEFAULT_THRESHOLD`
 *    头注）就并、直到并不动为止；**不是**对齐 app.py 的 `MERGE_THRESHOLD` /
 *    `FastClusteringConfig`——那两个常数没动，是 TS 侧代表定义换成「时长加权单位均值」
 *    后距离尺度整体收窄，这层换算重定的值，能对上的只是「阈值卡在同人跨窗距离 p95 的
 *    两倍」这条相对关系。聚完后碎片按最近簇质心就近归附，离所有簇都超过阈值才各自
 *    单独成簇（不互相吸附，避免顺序敏感）。全局凝聚不再有"先到的窗定义全局 label
 *    空间"这种顺序敏感性，也不再有"同一窗内两个 local 永不并到同一全局"的硬约束
 *    （放弃理由见 `clusterAverageLinkage` 头注）。旧的窗序贪心（`assignGlobalSpeakers`）
 *    仍保留在文件里，作为代表数超过 `MAX_REPS` 时的规模保护退路（`greedyFallback`），
 *    本函数不再直接调用它。
 * 3. **时间平移**：窗内相对时间 + startS → 全局时间。
 * 4. **重叠去重**：相邻窗的重叠区（下一窗起点到上一窗终点）两窗都会出 segment，
 *    按 segment 中点对重叠区中点归属——中点落在分界（重叠区正中）之前归前窗、
 *    之后归后窗（app.py 同款 prev_boundary ≤ mid < next_boundary 判据）。
 *
 * 容错（对齐 app.py）：无 segments 的窗贡献 0 个说话人但正常推进分界；代表取不出
 * （该 local 全部段都是空/零向量）的说话人，其 segments 整体丢弃（app.py 中
 * `_representative_embedding` 返回 None → local 不进 mapping → 段被跳过）。
 * ⚠ 有意偏离：**零向量段**在 app.py 走「不归一化、仍参与配对」支（`v/n if n>0
 * else v`），TS 选择不让它进均值——零向量与任何质心的 cosine 无意义，参与只会
 * 产生随机归并；只要该 local 还有有效段，代表照常从有效段均值得出，段本身
 * （含零向量段）仍随 local 输出。
 *
 * 纯函数、输入不被修改；唯一副作用是可选的 `warn` 旁路日志（默认 console.warn），
 * 只在下面这条「有痕丢弃」路径上打一行、不改任何返回值。
 *
 * ⚠ 假想敌日志（2026-07-24 拍板，尚未在活体数据复现）：加权均值代表选取后，`weight`
 * 是段时长之和；若某 local 在窗内的**全部段都是零时长**（`start === end`，但 embedding
 * 非零 → `sum` 能算出），`weight` 恒为 0，代表落 `null` 分支、该 local 整窗被丢弃。这是
 * 「结论对（无有效时长确实取不出可信代表）、但静默」——加一行 warn 让它有痕，行为不变。
 * 哪天日志响了再决定救法（注意 `sum` 此时是零时长段的单位向量和，仍是有意义的方向，
 * 但要救得对原始 embedding 等权重新累加，不能靠这个已按 dur=0 加权的 sum 重缩放）。
 *
 * 实现在 `mergeWindowsDetailed`——它多返回一份**库用簇代表**（`clusterReps`）。只要
 * segments 的调用方（多数）用这个薄壳即可。
 */
export function mergeWindows(windows: WindowResult[], opts?: MergeOptions): DiarizedSegment[] {
  return mergeWindowsDetailed(windows, opts).segments
}

export interface MergeOptions {
  threshold?: number
  itemId?: string
  warn?: (msg: string) => void
  /** 算窗代表前先减掉全集共享成分（罐头笑声垫底声那类"所有人共用"的分量）。
   *  缺省 false = 行为与历史逐字节一致。 */
  removeSharedComponent?: boolean
}

export interface MergeResult {
  /** 全局时间、全局 label 的 segments —— `mergeWindows` 返回的就是它。 */
  segments: DiarizedSegment[]
  /**
   * 全局簇 label → **库用簇代表**：该簇名下各「窗内说话人」的**干净代表**（容器帧级门控后
   * 拼接重算的那一份）按各自实际发言秒数加权的单位均值。
   *
   * 为什么要单独给一份、而不是让调用方拿 `segments` 自己算：段级 embedding 是**门控之前**
   * 算的，脏帧照进。声纹库存的、自动认名比的、手动 enroll 登记的全是这份代表——门控只接进
   * 跨窗合并的话，等于前门装了闸、后门还敞着（frame-gate spec §8 记的那条尾巴）。
   *
   * **两条边界**：
   * 1. 弃权者与没有干净代表的老窗**都不参与**——一个簇的代表要么整份由干净代表聚出，
   *    要么（缺省时）由调用方整份退回段级均值，绝不半干净半脏地拌在一起。混口径量出来的
   *    距离量的是「两种口径的差」不是「是不是同一个人」，这条栽过一次
   *    （`docs/research/voiceprint-clustering.md`「量这个数的坑」）。
   * 2. 一个成员都拿不出干净代表的簇**不在这个 Map 里**（不编一个出来）。调用方据此退回
   *    段级均值——那是「没人算过」时唯一还拿得出的东西，手动 enroll 的兜底权利不能没收。
   */
  clusterReps: Map<string, number[]>
}

/** 跨窗合并的完整出口：segments（同 `mergeWindows`）+ 库用簇代表（见 `MergeResult`）。
 *  合并本身只用 `segments` 的调用方走 `mergeWindows` 那个薄壳就行。 */
export function mergeWindowsDetailed(windows: WindowResult[], opts?: MergeOptions): MergeResult {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD
  const warn = opts?.warn ?? ((m: string) => console.warn(m))
  const itemLabel = opts?.itemId ?? 'unknown'
  // Pass 1：共享成分只算一次，覆盖全部窗（mergeWindows 本就拿得到全集视图）
  const globalMean = opts?.removeSharedComponent ? globalMeanEmbedding(windows) : null
  const ordered = windows.slice().sort((a, b) => a.index - b.index)

  // ---- 第一遍：收集每个「窗内说话人」的代表 ----
  const reps: Rep[] = []
  const groupsPerWindow: Array<Map<string, DiarizedSegment[]>> = []
  for (let i = 0; i < ordered.length; i++) {
    const w = ordered[i]
    const segsSorted = w.segments.slice().sort((a, b) => a.start - b.start || a.end - b.end)
    const byLocal = new Map<string, DiarizedSegment[]>()
    for (const s of segsSorted) {
      const list = byLocal.get(s.speaker)
      if (list) list.push(s)
      else byLocal.set(s.speaker, [s])
    }
    groupsPerWindow.push(byLocal)
    // 容器给的干净代表（拼接 ≤20s 音频重算）优先——段级 embedding 各自只摊到两三秒，
    // 求平均降的是采样方差、不是每个样本自身的信息量（块长实测：8s 才首次出现可用刀口，
    // 见 docs/research/voiceprint-clustering.md）。缺省则退回段级时长加权均值。
    // ⚠ 开了 removeSharedComponent（研究用的去共性通道）时不能用它——那要在**原始**向量上
    // 减全集均值，而容器给的代表已经归一化过，减了没有意义。
    // 弃权名单：容器看过音频后说「这段回答不了『这是谁』」。与「没给代表」是两回事——
    // 后者退回段级均值是对的，前者退回去等于把刚拦下的脏音频又放进来（见 `WindowSpeakerRep.abstained`）。
    const abstained = new Set<string>()
    for (const sp of w.speakers ?? []) if (sp.abstained) abstained.add(sp.speaker)
    const cleanRep = globalMean ? new Map<string, number[]>() : cleanRepsOf(w.speakers)
    for (const [local, segs] of byLocal) {
      // 代表口径与声纹库那一侧同源（`representative.ts`）——此前两处各写一遍，
      // 只改了这一处，声纹库那份没跟着改，真实数据上兑现成了 bug（见该模块头注）。
      const { emb: meanEmb, durationS, usableSegments } = representativeOf(segs, globalMean)
      // 时长仍按**实际发言秒数**算（容器的 clip_seconds 封顶 20s，拿它当锚点门槛会误伤长发言）
      const clean = cleanRep.get(local)
      const emb = clean ?? meanEmb
      if (emb) {
        reps.push({
          wi: i,
          local,
          emb,
          dur: durationS,
          firstStart: w.startS + segs[0].start,
          anchorEligible: !abstained.has(local),
          clean: clean !== undefined,
        })
      } else if (usableSegments > 0 && durationS === 0) {
        warn(
          `[voiceprint/windowed] item=${itemLabel} window=${w.index} local=${local} segs=${segs.length}: ` +
            '全部段零时长(weight=0)，取不出代表，该 local 整窗被丢弃',
        )
      }
    }
  }

  // ---- 第二遍：全局聚类，得到 (wi, local) → 簇号 ----
  const clusterOf = assignClusters(reps, threshold, ordered, itemLabel, warn)

  // ---- 第三遍：按簇号回填 segment（时间平移 + 重叠区去重，逻辑不变）----
  const labelOf = new Map<string, string>()
  for (const [k, gid] of clusterOf) labelOf.set(k, `SPEAKER_${String(gid).padStart(2, '0')}`)
  const merged: DiarizedSegment[] = []
  let prevBoundary = -Infinity
  for (let i = 0; i < ordered.length; i++) {
    const w = ordered[i]
    let nextBoundary = Infinity
    if (i < ordered.length - 1) {
      const nextStart = ordered[i + 1].startS
      const overlap = Math.max(0, w.startS + w.durS - nextStart)
      nextBoundary = nextStart + overlap / 2
    }
    for (const [local, segs] of groupsPerWindow[i]) {
      const speaker = labelOf.get(`${i}|${local}`)
      if (speaker === undefined) continue // 取不出代表的说话人整体丢弃（对齐 app.py）
      for (const s of segs) {
        const start = w.startS + s.start
        const end = w.startS + s.end
        const mid = (start + end) / 2
        if (mid >= prevBoundary && mid < nextBoundary) {
          merged.push({ start, end, speaker, embedding: s.embedding })
        }
      }
    }
    prevBoundary = nextBoundary
  }
  merged.sort((a, b) => a.start - b.start || a.end - b.end)

  // ---- 库用簇代表：只由干净代表聚出（见 `MergeResult.clusterReps` 头注）----
  // 权重取**实际发言秒数** `dur`，与 `assignClusters` 算簇质心、`representativeOf` 算段级代表
  // 同一口径（"这个人主要长什么样"，说得多的那份更算数）。不用容器的 `clipSeconds`：它封顶
  // 20s，拿它加权会把讲了 100 秒的人和讲了 20 秒的人拉平。
  const byCluster = new Map<string, Array<{ vec: number[]; weight: number }>>()
  for (const r of reps) {
    if (!r.clean) continue
    const label = labelOf.get(`${r.wi}|${r.local}`)
    if (label === undefined) continue
    const list = byCluster.get(label)
    if (list) list.push({ vec: r.emb, weight: r.dur })
    else byCluster.set(label, [{ vec: r.emb, weight: r.dur }])
  }
  const clusterReps = new Map<string, number[]>()
  for (const [label, items] of byCluster) {
    const { emb } = weightedUnitMean(items)
    if (emb) clusterReps.set(label, emb)
  }

  return { segments: merged, clusterReps }
}

/**
 * 代表 → 全局说话人号。锚点（时长 ≥ MIN_ANCHOR_S）参与聚类；碎片不参与聚类、
 * 聚完后按最近簇质心归附（离所有簇都超阈值才各自单独成簇，彼此不互相吸附，
 * 避免顺序敏感）。规模保护见 Task 3。
 */
function assignClusters(
  reps: Rep[],
  threshold: number,
  ordered: WindowResult[],
  itemLabel: string,
  warn: (msg: string) => void,
): Map<string, number> {
  const out = new Map<string, number>()
  if (reps.length === 0) return out
  // 尺度告警必须在规模保护的早退之前跑：超长 item（代表数最容易超 MAX_REPS 的那类）
  // 恰恰也最可能出现录音条件异常，退到贪心分支不能顺带把这条告警也跳过。
  const scaleP95 = mustLinkP95(reps, ordered)
  if (scaleP95 !== null && scaleP95 > threshold / 2) {
    warn(
      `[voiceprint/windowed] item=${itemLabel} 重叠区同人距离 p95=${scaleP95.toFixed(3)} ` +
        `已超过阈值(${threshold})的一半——这一集的距离尺度反常（录音条件特殊 / 声纹模型换版？），` +
        '合并结果可能偏碎。行为未改变，仅告警。',
    )
  }
  if (reps.length > MAX_REPS) {
    warn(
      `[voiceprint/windowed] item=${itemLabel} 代表数=${reps.length} 超过上限 ${MAX_REPS}，` +
        '退回按窗序贪心合并（结果会更碎/更容易并错，但不会卡死）',
    )
    return greedyFallback(reps, threshold)
  }
  // 两条排除线，理由不同：`dur < MIN_ANCHOR_S` 是「音频太少、代表噪声大」，
  // `!anchorEligible` 是「容器的帧级门控判它弃权、音频本身不干净」（见 `Rep.anchorEligible`）。
  const anchors = reps.filter((r) => r.anchorEligible && r.dur >= MIN_ANCHOR_S)
  const scraps = reps.filter((r) => !(r.anchorEligible && r.dur >= MIN_ANCHOR_S))
  // 全是碎片（极短 item / 全片都被门控判弃权）时退化为「碎片也当锚点」，否则一个人都出不来。
  // 这条退路会让脏代表重新参与决策，但那是「要么脏、要么整个 item 一个人都认不出」之间的
  // 取舍——留脏的，并且它只在整份 item 无一人达标时才触发。
  const base = anchors.length > 0 ? anchors : reps
  const raw = clusterAverageLinkage(base, threshold)

  // 簇质心 = 成员单位向量的时长加权均值（与代表同一口径）
  const dim = base[0].emb.length
  const centroidSum = new Map<number, number[]>()
  for (let i = 0; i < base.length; i++) {
    const c = raw[i]
    let acc = centroidSum.get(c)
    if (!acc) {
      acc = new Array<number>(dim).fill(0)
      centroidSum.set(c, acc)
    }
    for (let k = 0; k < dim; k++) acc[k] += base[i].emb[k] * base[i].dur
  }
  const centroids = new Map<number, number[]>()
  for (const [c, acc] of centroidSum) {
    const u = normalizeToUnit(acc)
    if (u) centroids.set(c, u)
  }

  const assigned = new Map<string, number>()
  for (let i = 0; i < base.length; i++) assigned.set(`${base[i].wi}|${base[i].local}`, raw[i])
  // 碎片：就近归附；离所有簇都超过阈值就各自单独成簇（不互相吸附，避免顺序敏感）
  let nextCluster = Math.max(-1, ...raw) + 1
  if (anchors.length > 0) {
    for (const s of scraps) {
      let bestC = -1
      let bestD = Infinity
      // 并列决胜：先遇到的赢（`centroids` 按插入序 = `base` 下标序遍历，`<` 不 `<=`
      // 就是让第一个达到 bestD 的簇号占住，之后同距离的候选不会顶替它——确定性来自
      // 这个遍历顺序，不是簇号大小本身）。
      for (const [c, v] of centroids) {
        const d = 1 - cosineSimilarity(s.emb, v)
        if (d < bestD) {
          bestD = d
          bestC = c
        }
      }
      if (bestC >= 0 && bestD <= threshold) assigned.set(`${s.wi}|${s.local}`, bestC)
      else {
        assigned.set(`${s.wi}|${s.local}`, nextCluster)
        nextCluster += 1
      }
    }
  }

  // 按簇内最早出现时间重排编号，让 SPEAKER_00 是全集第一个开口的人
  const firstOf = new Map<number, number>()
  for (const r of reps) {
    const c = assigned.get(`${r.wi}|${r.local}`)
    if (c === undefined) continue
    const prev = firstOf.get(c)
    if (prev === undefined || r.firstStart < prev) firstOf.set(c, r.firstStart)
  }
  const order = [...firstOf.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])
  const renumber = new Map<number, number>()
  order.forEach(([c], idx) => renumber.set(c, idx))
  for (const [k, c] of assigned) out.set(k, renumber.get(c)!)

  return out
}

/** 规模保护退路：把代表按窗分组，逐窗喂给历史的贪心实现。 */
function greedyFallback(reps: Rep[], threshold: number): Map<string, number> {
  const out = new Map<string, number>()
  const centroids: Centroid[] = []
  const byWindow = new Map<number, Rep[]>()
  for (const r of reps) {
    const list = byWindow.get(r.wi)
    if (list) list.push(r)
    else byWindow.set(r.wi, [r])
  }
  for (const [wi, group] of [...byWindow.entries()].sort((a, b) => a[0] - b[0])) {
    const mapping = assignGlobalSpeakers(
      group.map((r) => ({ local: r.local, emb: r.emb })),
      centroids,
      threshold,
    )
    for (const [local, gid] of mapping) out.set(`${wi}|${local}`, gid)
  }
  return out
}

/**
 * 相邻窗重叠区的「同人」距离 p95。重叠区的同一段音频被两窗各 diarize 一次，
 * 两边在重叠区占时最多的那个 local 必是同一个人——免费真值，不需要任何标注。
 * 只用于告警（尺度反常检测），不参与任何判定。占时第二名超过第一名一半时
 * 视为归属含糊，跳过该窗对。配对不足 5 对返回 null（样本太少，说不出话）。
 */
function mustLinkP95(reps: Rep[], ordered: WindowResult[]): number | null {
  const repAt = new Map<string, Rep>()
  for (const r of reps) repAt.set(`${r.wi}|${r.local}`, r)
  const dists: number[] = []
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i]
    const b = ordered[i + 1]
    const lo = b.startS
    const hi = a.startS + a.durS
    if (hi - lo <= 1) continue
    const dominant = (w: WindowResult, wi: number): string | null => {
      const t = new Map<string, number>()
      for (const s of w.segments) {
        const g0 = w.startS + s.start
        const g1 = w.startS + s.end
        const ov = Math.min(g1, hi) - Math.max(g0, lo)
        if (ov > 0) t.set(s.speaker, (t.get(s.speaker) ?? 0) + ov)
      }
      const sorted = [...t.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      if (sorted.length === 0 || sorted[0][1] < 2) return null
      if (sorted.length > 1 && sorted[1][1] > 0.5 * sorted[0][1]) return null
      return `${wi}|${sorted[0][0]}`
    }
    const ka = dominant(a, i)
    const kb = dominant(b, i + 1)
    if (!ka || !kb) continue
    const ra = repAt.get(ka)
    const rb = repAt.get(kb)
    if (!ra || !rb) continue
    dists.push(1 - cosineSimilarity(ra.emb, rb.emb))
  }
  if (dists.length < 5) return null
  dists.sort((x, y) => x - y)
  return dists[Math.floor(0.95 * (dists.length - 1))]
}
