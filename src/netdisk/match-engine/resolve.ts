import type { SpecRight } from '../match-spec.ts'
import {
  AUTO_SIM, DURATION_MIN_SIM, MEDIA_EXT, VIDEO_EXT,
  canonName, contentContradicts, reduceByQuality, type RTn,
} from '../match-spec.ts'
import type {
  Ask, AskReason, EdgeOutcome, EvidenceEdge, EvidenceGraph, Fact, Resolution,
  ResolvedAssignment, StripId, StructKeyKind, Trail, TrailEdge, VetoReason,
} from './types.ts'
import { RULES, pickBest, rulesFromSpec, soleTouching, type MatchRule } from './rules.ts'
import { asksDespiteNoSupply } from './live-candidate.ts'
import { pureCutMismatch } from '../pure-cut.ts'
import { collectEvidence } from './collect.ts'
import type { MatchSpec } from '../types.ts'
import type { SpecLeft } from '../match-spec.ts'

/**
 * ② 裁决层：`resolve(graph, rules) → Resolution`（spec §3.2）。
 *
 * **纯函数**：同一张图 + 同一套规则 ⇒ 同一份判决。不吃 IO、不看时钟、不读 `paid`
 * （读了就是第二个判定脑，P7）。**认领判定**因此完全不受供货语义影响：`needsSupply` 只被
 * `note()` 那道"该不该开口问人"的闸读一次，配对结果与它无关（见 `LeftNode.needsSupply`）。
 *
 * 三条**结构不变量**在这里强制（不是靠自觉，是靠 `assertInvariants` 每轮跑）：
 *  - **I1 无痕**：`graph.files` 里每个文件必有 `Trail`；每条可裁决的边要么导向判决、要么带
 *    显式 `vetoReason`。
 *  - **I2 残差最窄**：`residual` 只接受"零边"或"每条可裁决的边都被显式否决"。
 *    **"见过又丢弃"在结构上不存在**——丢弃即否决记录。
 *  - **I3 冲突必浮出**：一个文件的证据指向多个集、又没有任何规则认领它 → 出卡，不是残差。
 *    05/20 案就是这一格（裁决表第 6 格，spec §8）：它们曾被算进残差、计划静默搬下架。
 */

const edgeId = (leftKey: string, path: string) => `${leftKey}\u0000${path}`

/**
 * 一条边**够不够格当候选**：带时长命中、结构键、或名字过 `DURATION_MIN_SIM` 地板的分量。
 * 返回名字最佳分（够格但没有名字事实时是 0），不够格返回 **-1**。
 *
 * **这把尺只有这一把**。三处读它：I3 的冲突卡（本文件）、I3 的不变量断言（`assertInvariants`）、
 * 以及处置层判"这份文件的证据还指着哪几集"（`reconcile/plan.ts` 的活候选）。各写一套阈值就是
 * 第二把尺——量出来不一致时，卡片说的和处置做的会是两回事，而两边单看都正常。
 */
export const candidateWeight = (facts: Fact[]): number => {
  const names = facts.filter((f): f is Extract<Fact, { kind: 'name' }> => f.kind === 'name')
  const best = names.length ? Math.max(...names.map((f) => f.score)) : 0
  const hit = facts.some((f) => f.kind === 'duration' && f.state === 'hit')
  if (hit || facts.some((f) => f.kind === 'struct-key') || best >= DURATION_MIN_SIM) return best
  return -1
}

/** 一个候选：路径 + 本规则那把尺清洗出的串 + 该尺量出的分（分直接取自事实，绝不重算）。 */
interface Cand { path: string; tn: string; score: number; dups?: string[] }

/** 某左项在某规则下的候选包。 */
interface LeftCands {
  tnLeft: string
  cands: Cand[]
  /** 同集的落选副本（`reduceByQuality` 分层后剩的那几档）——不进配对结果，但占住文件。 */
  losers?: string[]
  /** 集号在左侧、右侧无此号文件 → 缺档（`epnum` 专属）。 */
  missingEp?: number
  /** 逐左项覆盖规则的 `autoOnMatch`（时长档区分"唯一命中"与"撞车后靠标题选出来的"）。 */
  autoOnMatch?: boolean
  /** 时长容差内独一份、但名字连地板都不沾的那个。不是候选，只为把证据说出口。 */
  floorRejected?: Cand[]
  /** 本轮被 `reduceByQuality` 丢掉的（既没进 cands 也没进 losers）——I1 要求它们留痕。 */
  dropped?: string[]
  /** R4 零竞争出口判定为"**别的集**的文件"的那几份。与 `dropped` 分开记：理由不同，卡片说法也不同。 */
  zeroLosers?: string[]
}

export function resolve(graph: EvidenceGraph, rules: MatchRule[]): Resolution {
  const assignments = new Map<string, ResolvedAssignment>()
  const used = new Set<string>()
  const asksByLeft = new Map<string, Ask>()
  const fileAsks: Ask[] = []
  const missingByLeft = new Map<string, number>()
  const outcomes = new Map<string, { outcome: EdgeOutcome; vetoReason?: VetoReason; rule?: string }>()
  const thresholdsByFile = new Map<string, Record<string, { got: number; need: number }>>()

  // ── 索引 ──────────────────────────────────────────────────────────────────
  const edgeAt = new Map<string, EvidenceEdge>()
  const edgesByLeft = new Map<string, EvidenceEdge[]>()
  const edgesByFile = new Map<string, EvidenceEdge[]>()
  for (const e of graph.edges) {
    edgeAt.set(edgeId(e.leftKey, e.path), e)
    const a = edgesByLeft.get(e.leftKey) ?? []; a.push(e); edgesByLeft.set(e.leftKey, a)
    const z = edgesByFile.get(e.path) ?? []; z.push(e); edgesByFile.set(e.path, z)
  }
  const leftKeysOf = new Map<string, Map<StructKeyKind, string>>()
  for (const k of graph.leftStructKeys) {
    const m = leftKeysOf.get(k.leftKey) ?? new Map(); m.set(k.key, k.value); leftKeysOf.set(k.leftKey, m)
  }

  const nameFact = (e: EvidenceEdge, stripId: StripId | undefined) =>
    e.facts.find((f): f is Extract<Fact, { kind: 'name' }> => f.kind === 'name' && f.stripId === stripId)
  const hasHit = (e: EvidenceEdge) => e.facts.some((f) => f.kind === 'duration' && f.state === 'hit')
  const hasContradict = (e: EvidenceEdge) => e.facts.some((f) => f.kind === 'duration' && f.state === 'contradict')
  const hasStruct = (e: EvidenceEdge, key: StructKeyKind) => e.facts.some((f) => f.kind === 'struct-key' && f.key === key)
  /** 可裁决 = 带 name / struct-key / duration 事实。只带 `byte-identity` 的边不是候选。 */
  const adjudicable = (e: EvidenceEdge) => e.facts.some((f) => f.kind !== 'byte-identity')
  const rightOf = (path: string): SpecRight => {
    const f = graph.fileMeta.get(path)!
    return { name: path, ...(f.sizeBytes != null ? { size: f.sizeBytes } : {}), ...(f.durationS != null ? { durationS: f.durationS } : {}) }
  }

  const setOutcome = (leftKey: string, path: string, outcome: EdgeOutcome, rule: string, vetoReason?: VetoReason) => {
    const id = edgeId(leftKey, path)
    if (!edgeAt.has(id)) return
    if (outcomes.get(id)?.outcome === 'won') return // 认领是终态，后面的规则不许把它改回否决
    outcomes.set(id, { outcome, rule, ...(vetoReason ? { vetoReason } : {}) })
  }

  // ── 判决动作 ──────────────────────────────────────────────────────────────
  /** 认领：写配对 + 占用右文件 + 撤掉这一集早先记的问句/缺档（不能既配上又挂着问句）。 */
  const claim = (leftKey: string, path: string, sim: number, autoOnMatch: boolean, rule: string, losers: string[] = []) => {
    assignments.set(leftKey, {
      path, confidence: sim,
      status: autoOnMatch || sim >= AUTO_SIM ? 'auto' : 'pending',
      losers, rule,
    })
    used.add(path)
    for (const l of losers) used.add(l)
    asksByLeft.delete(leftKey)
    missingByLeft.delete(leftKey)
    setOutcome(leftKey, path, 'won', rule)
    for (const l of losers) setOutcome(leftKey, l, 'won', rule)
  }

  /**
   * 记一条"没敢配"。同一集可能在好几个规则各留下一次，
   * **必须并进同一条**——后写覆盖先写会把先前那一档的候选整批抹掉，而下游正是靠这份候选名单
   * 认出"这个文件还在被某一集惦记着，别把它当没人要的搬走"（活体 2026-08-01 怡乐）。
   * 保留**先写那一档**的 stage/reason/门槛（规则顺序就是证据强弱），候选取并集。
   *
   * **这里是集侧问句的唯一收口点**，所以"不需供货的集不发问句"这道闸只能长在这里（下同）。
   */
  const note = (rule: MatchRule, leftKey: string, reason: AskReason, scored: { name: string; sim: number }[], verdictRule = rule.id, force = false) => {
    /**
     * **不需供货的集，问了也白问的那些问句一个都不发**（`LeftNode.needsSupply === false`）。
     * 理由不是"这一集不重要"，而是**答案不改变动作**：源站自己放得出这一集，网盘那份文件不论是不是它，
     * 处置都一样（删）——用户点哪个按钮都通向同一步，那就不该占他一次注意力。
     *
     * 裁决层因此仍**不读 `paid`**（读了就是第二个判定脑，P7）：`needsSupply` 是已经压平的处置位，
     * 这里只知道"这一集要不要人供货"，不知道什么叫付费、免费、影视还是播客。
     * 缺席（`undefined`）一律当"要供货"——影视绑定压根没有这个概念，网盘是唯一来源，绝不许被这条闸吞掉。
     *
     * **`duration-contradiction` 是这道闸的例外，因为"处置都一样"在它这里是假的**（裁决表第 3 格）。
     * 处置层那一步删的是**活候选**全都不需供货的文件，而"活候选"剔掉了 `duration-contradict` 这种
     * **事实级**否决的边（`reconcile/plan.ts` 的 `liveCandidateKeys`）——时长矛盾的候选压根走不到
     * 自动删。答案真会改变动作：是这一集 → 换正主；不是 → 挪去下架。闸和删之间的这道缝
     * 一度让活体 2026-08-02 怡楽的 112/116 静默进了下架货架（名字与节目单一字不差、时长差出量级）。
     *
     * 判据只看 `reason`，不重算任何认集判定——这一档的口径由裁决层自己定死：`duration-contradiction`
     * 只从下面那个"有过候选、全被时长否掉"的出口发出，与 `liveCandidateKeys` 剔的是同一批边。
     * 别的理由（`name-floor`/`below-threshold`/`no-margin`）的候选照旧是活候选，闸照旧关得住
     * （`37.申与酉` 那三条时长命中免费集的问句，一张都不许多）。
     *
     * **放行集不写死在这里**：它与处置层剔活候选的口径是同一张表（`live-candidate.ts`），
     * 两侧共读。以前这里写死 `!== 'duration-contradiction'`、那边写死 `=== 'duration-contradict'`，
     * 只靠注释互指——再加一种剔除理由，同一类静默下架会从新理由上原样再长一次。
     */
    if (graph.leftMeta.get(leftKey)?.needsSupply === false && !asksDespiteNoSupply(reason)) return
    if (!rule.markAsk && !force) return
    const prev = asksByLeft.get(leftKey)
    if (!prev) {
      asksByLeft.set(leftKey, {
        leftKey, stage: rule.stage as Ask['stage'], rule: verdictRule, reason,
        candidates: scored, threshold: rule.threshold, margin: rule.margin,
      })
      return
    }
    const seen = new Set(prev.candidates.map((c) => c.name))
    asksByLeft.set(leftKey, { ...prev, candidates: [...prev.candidates, ...scored.filter((c) => !seen.has(c.name))].sort((x, y) => y.sim - x.sim) })
  }

  // ── 产候选 ────────────────────────────────────────────────────────────────
  const toCand = (e: EvidenceEdge, rule: MatchRule): Cand => {
    const f = nameFact(e, rule.stripId)
    return { path: e.path, tn: f?.cleanedRight ?? '', score: f?.score ?? 0 }
  }
  const tnLeftOf = (edges: EvidenceEdge[], rule: MatchRule) =>
    edges.map((e) => nameFact(e, rule.stripId)?.cleanedLeft).find((s) => s != null) ?? ''
  const bucketOf = (edges: EvidenceEdge[], rule: MatchRule): RTn[] =>
    edges.map((e) => ({ r: rightOf(e.path), tn: nameFact(e, rule.stripId)?.cleanedRight ?? '' }))
  /** RTn（`reduceByQuality` 的形状）→ Cand，分数回填自事实。 */
  const rtnToCands = (leftKey: string, rtn: RTn[], rule: MatchRule): Cand[] => rtn.map((c) => {
    const f = nameFact(edgeAt.get(edgeId(leftKey, c.r.name))!, rule.stripId)
    return { path: c.r.name, tn: c.tn, score: f?.score ?? 0, ...(c.dups?.length ? { dups: c.dups } : {}) }
  })

  /**
   * R2–R5 时长档的候选包：两侧任一没时长 → 无信号；容差内没撞上 → 无信号
   * （**永不写缺档**，时长是增强不是替换）。
   */
  const produceDuration = (rule: MatchRule, leftKey: string): LeftCands | null => {
    if (graph.leftMeta.get(leftKey)?.durationS == null) return null
    const edges = (edgesByLeft.get(leftKey) ?? []).filter((e) => hasHit(e) && !used.has(e.path))
    if (edges.length === 0) return null
    // false：桶键是"时长相同"，**不保证同一集**——体量不许在不同标题之间选（活体 530/820）。
    const { cands: kept, losers } = reduceByQuality(bucketOf(edges, rule), false)
    const tnLeft = tnLeftOf(edges, rule)
    const cands = rtnToCands(leftKey, kept, rule)
    const dropped = edges.map((e) => e.path).filter((p) => !cands.some((c) => c.path === p) && !losers.includes(p))
    if (cands.length === 1 && cands[0].score < DURATION_MIN_SIM) return { tnLeft, cands: [], floorRejected: cands, dropped }
    const sole = cands.length > 1 ? soleTouching(cands) : null
    // R4 命中时**不带 losers**：落选的那几份是**别的集**的文件，必须留在池子里给各自那一集去认。
    if (sole) return { tnLeft, cands: [sole], autoOnMatch: true, dropped, zeroLosers: cands.filter((c) => c !== sole).map((c) => c.path) }
    return { tnLeft, cands, autoOnMatch: cands.length === 1, losers, dropped }
  }

  /** R6–R8 结构键档的候选包：两侧读出同一个键值的那些边（"分桶"那一半在证据层已经做完）。 */
  const produceStructKey = (rule: MatchRule, leftKey: string): LeftCands | null => {
    const key = rule.structKey!
    const value = leftKeysOf.get(leftKey)?.get(key)
    if (value == null) return null // 左侧读不出键 → 本档无信号，原样留给后续规则
    const edges = (edgesByLeft.get(leftKey) ?? []).filter((e) => hasStruct(e, key) && !used.has(e.path))
    const { cands: kept, losers } = reduceByQuality(bucketOf(edges, rule), true)
    let cands = rtnToCands(leftKey, kept, rule)
    let losersOut = [...losers]
    let dropped = edges.map((e) => e.path).filter((p) => !cands.some((c) => c.path === p) && !losersOut.includes(p))

    /**
     * **名字全等压过体量**（`reduceByQuality` 步骤 3 之后的一道纠偏，只长在结构键档）：
     * 体量只能在**同一内容**的不同发布之间选；名字全等 vs 名字 0 分说明这两份根本不是同一份内容
     * （纯享版 / 花絮共用了期号+分段键），名字全等的那份才是这一集，体量大的那份是它的同键副本。
     * 活体 2026-09-03 脱口秀 S02E10（`tmdb:261471`）：`第5期中` 这个键下 4.65GB 的正片（名字
     * `identity-exact`）被 5.87GB 的「第5期中下纯享版」按体量挤成 `quality-dedup`，纯享版拿了
     * `auto`、正片成了孤儿——名字证据全程没说上话。
     *
     * 收得很窄，避免动到没有名字信号的桶（`season-episode`/`epnum` 那类）：只在**体量赢家自己
     * 连名字地板都不沾**、且落选/丢弃的那些里**恰好一份**名字全等时才翻案。多份全等 = 真重复，
     * 体量仍是唯一能分的尺，照旧不动。`reduceByQuality` 本身一个字不改。
     *
     * **还有一道闸：体量赢家自己是别的集的名字全等正主时，这一档一个字都不动。** 那说明这个桶里
     * 本来就混了两集（号相同、内容不同），翻案会把**别人的正片**当成本集副本占掉，本集配对反而
     * 更早一格发生。这种桶交给后续规则各归各家——金样 `random#40`（`03.太极…720p` 与
     * `03.现代版枪下留人…2160p` 同号不同集）钉着这一格。
     */
    if (cands.length === 1 && cands[0].score < DURATION_MIN_SIM) {
      const scoreOf = (p: string) => {
        const e = edgeAt.get(edgeId(leftKey, p))
        return e ? nameFact(e, rule.stripId)?.score ?? 0 : 0
      }
      const ownedElsewhere = (path: string) => (edgesByFile.get(path) ?? [])
        .some((e) => e.leftKey !== leftKey && (nameFact(e, rule.stripId)?.score ?? 0) >= 0.99)
      const exact = ownedElsewhere(cands[0].path) ? [] : [...losersOut, ...dropped].filter((p) => scoreOf(p) >= 0.99)
      if (exact.length === 1) {
        const sizeWinner = cands[0]
        const e = edgeAt.get(edgeId(leftKey, exact[0]))!
        const f = nameFact(e, rule.stripId)
        cands = [{ path: exact[0], tn: f?.cleanedRight ?? '', score: f?.score ?? 0 }]
        // 体量赢家（连同它自己的同名重复份）降为同键副本——它仍然是这一集的同键文件，
        // 只是不再是正主；怎么处置由归档器决定。
        losersOut = [...losersOut.filter((p) => p !== exact[0]), sizeWinner.path, ...(sizeWinner.dups ?? [])]
        dropped = dropped.filter((p) => p !== exact[0] && !losersOut.includes(p))
      }
    }

    return {
      tnLeft: tnLeftOf(edges, rule),
      cands,
      losers: losersOut,
      dropped,
      // 缺档口径只归 epnum：号在左侧、右侧无此号文件。别的结构键没有"缺档号"这个概念。
      ...(key === 'epnum' ? { missingEp: Number(value) } : {}),
    }
  }

  /**
   * R9 标题档的候选包：所有还没被占用、且有名字事实的右文件，高阈值防误配。
   * 只看有名字事实的那些——0 分候选对结果不可分辨，理由见 `collect.ts:nameCollector` 头注。
   */
  const produceTitle = (rule: MatchRule, leftKey: string): LeftCands | null => {
    const edges = (edgesByLeft.get(leftKey) ?? []).filter((e) => nameFact(e, rule.stripId) && !used.has(e.path))
    return { tnLeft: tnLeftOf(edges, rule), cands: edges.map((e) => toCand(e, rule)) }
  }

  // ── 规则执行 ──────────────────────────────────────────────────────────────
  /** 跑一条规则的主干。**R11 横向闸在 `pickBest` 之前**——被时长否掉的候选本来就不是候选。 */
  const runMatchRule = (rule: MatchRule, produce: (r: MatchRule, k: string) => LeftCands | null) => {
    for (const leftKey of graph.lefts) {
      if (assignments.has(leftKey)) continue
      const lc = produce(rule, leftKey)
      if (!lc) continue
      for (const p of lc.dropped ?? []) setOutcome(leftKey, p, 'vetoed', rule.id, 'quality-dedup')
      for (const p of lc.zeroLosers ?? []) setOutcome(leftKey, p, 'vetoed', RULES.ZERO_COMPETITION.id, 'zero-competition-loser')

      // R11 横向闸在 pickBest **之前**：被时长否掉的候选本来就不是候选。
      const vetoed = lc.cands.filter((c) => contradicts(leftKey, c.path))
      for (const c of vetoed) setOutcome(leftKey, c.path, 'vetoed', RULES.CONTENT_MISMATCH.id, factVeto(leftKey, c.path)!)
      const cands = lc.cands.filter((c) => !vetoed.includes(c))
      const losers = (lc.losers ?? []).filter((n) => !contradicts(leftKey, n))
      for (const n of lc.losers ?? []) if (contradicts(leftKey, n)) setOutcome(leftKey, n, 'vetoed', RULES.CONTENT_MISMATCH.id, factVeto(leftKey, n)!)

      if (cands.length === 0) {
        if (lc.floorRejected?.length) {
          // R3：不配（这一集照常退回文件名链、文件也留在池子里），但把"它的时长命中过这一集"
          // 这条路由信号说出口——不说出来，下游就只能自己重算一遍（那就是第二个判定脑）。
          for (const c of lc.floorRejected) setOutcome(leftKey, c.path, 'vetoed', RULES.DURATION_NAME_FLOOR.id, 'name-floor')
          note(rule, leftKey, 'name-floor', lc.floorRejected.map((c) => ({ name: c.path, sim: c.score })), RULES.DURATION_NAME_FLOOR.id)
          continue
        }
        // 纯享那种静默否决不出问句：证据本身已经说清"不是"，没有什么可问人的。只有被**时长**否掉的
        // 候选才值得一张卡。
        const durationVetoed = lc.cands.filter((c) => factVeto(leftKey, c.path) === 'duration-contradict')
        if (durationVetoed.length > 0) {
          // 有过候选、全被时长否掉 = 号命中但没敢配 → 记问句不记缺档。
          //
          // R14（裁决表第 3 格）：标题档 `markAsk:false`，上面这条对它是空转。但"名字唯一命中 ×
          // 时长矛盾"是**必须出卡**的一格——判据是被否的候选里有一个本可认领的赢家（过本档
          // `pickBest`），此时 `force` 掀开那道闸。收得这么窄是因为标题档的候选含大量 0.06 分的
          // 噪声边，时长一矛盾就全变成卡的话，问句面板会被淹掉。
          const scored = lc.cands.map((c) => ({ name: c.path, sim: c.score })).sort((x, y) => y.sim - x.sim)
          const nameHit = !rule.markAsk && pickBest(lc.cands, rule.threshold, rule.margin, rule.trustUnique).ok
          note(rule, leftKey, 'duration-contradiction', scored, nameHit ? RULES.NAME_HIT_DURATION_CONTRADICT.id : RULES.CONTENT_MISMATCH.id, nameHit)
          continue
        }
        if (lc.missingEp != null) missingByLeft.set(leftKey, lc.missingEp)
        continue
      }

      const best = pickBest(cands, rule.threshold, rule.margin, rule.trustUnique)
      if (best.ok) {
        const winner = cands.find((c) => c.path === best.path)!
        const dups = (winner.dups ?? []).filter((n) => !contradicts(leftKey, n))
        const ruleId = verdictRuleOf(rule, lc, cands)
        claim(leftKey, best.path, best.sim, lc.autoOnMatch ?? rule.autoOnMatch, ruleId, [...dups, ...losers])
        thresholdsByFile.set(best.path, {
          sim: { got: best.sim, need: rule.trustUnique && cands.length === 1 ? 0 : rule.threshold },
          ...(rule.kind === 'duration' ? { nameFloor: { got: best.sim, need: DURATION_MIN_SIM } } : {}),
        })
      } else {
        for (const c of cands) setOutcome(leftKey, c.path, 'vetoed', rule.id, best.reason)
        note(rule, leftKey, best.reason, best.scored)
      }
    }
  }

  /** 认领落在哪一格：时长档要区分 R2 唯一命中 / R4 零竞争 / R5 撞车消歧（卡片显示的就是它）。 */
  const verdictRuleOf = (rule: MatchRule, lc: LeftCands, cands: Cand[]): string => {
    if (rule.kind !== 'duration') return rule.id
    if (lc.autoOnMatch && cands.length === 1 && (lc.dropped?.length ?? 0) > 0) return RULES.ZERO_COMPETITION.id
    if (cands.length === 1) return RULES.DURATION_UNIQUE.id
    return RULES.DURATION_COLLISION.id
  }

  /** 事实级否决的理由（没有 = 不否决）。两种：时长差出量级；纯享剪辑对期-段体系的正片
   *  （`pureCutMismatch`，引擎/归档器/裁决器共用一份判据）。后者不建边，任何一档都配不上，也不出问句。 */
  const factVeto = (leftKey: string, path: string): VetoReason | null => {
    const e = edgeAt.get(edgeId(leftKey, path))
    const durationVeto = e ? hasContradict(e) : contentContradicts(graph.leftMeta.get(leftKey)?.durationS, graph.fileMeta.get(path)?.durationS)
    // 没有边的对（R10 solo / R12 收尾会碰到）→ 直接用同一个判据，绝不另写一份（P7）。
    if (durationVeto) return 'duration-contradict'
    const title = graph.leftMeta.get(leftKey)?.title
    if (title !== undefined && pureCutMismatch(path, title)) return 'pure-cut-mismatch'
    return null
  }
  const contradicts = (leftKey: string, path: string): boolean => factVeto(leftKey, path) !== null

  /** R1：pin 指向的文件这一轮不在右侧（被删/改名）→ 不占位，按规则照常跑。 */
  const runPin = () => {
    for (const leftKey of graph.lefts) {
      const pinned = graph.leftMeta.get(leftKey)?.pinnedRight
      if (!pinned || !graph.fileMeta.has(pinned)) continue
      claim(leftKey, pinned, 1, true, RULES.PIN.id)
    }
  }

  /** R10：唯一左项 × 目录里的视频文件 → 认领正片。多个视频时按体量取最大（花絮必然小一截）。 */
  const runSolo = () => {
    if (graph.lefts.length !== 1) return
    const leftKey = graph.lefts[0]
    if (assignments.has(leftKey)) return
    const vids = graph.files.filter((p) => VIDEO_EXT.test(p) && !used.has(p) && !contradicts(leftKey, p))
    if (vids.length === 0) return // 片源还没到
    if (vids.length === 1) { claim(leftKey, vids[0], 1, true, RULES.SOLO.id); return }
    const ranked = [...vids].sort((a, b) => (graph.fileMeta.get(b)!.sizeBytes ?? 0) - (graph.fileMeta.get(a)!.sizeBytes ?? 0))
    const topSize = graph.fileMeta.get(ranked[0])!.sizeBytes ?? 0
    if (topSize <= 0 || (graph.fileMeta.get(ranked[1])!.sizeBytes ?? 0) === topSize) return // 分不出正片 → 不猜
    claim(leftKey, ranked[0], 1, true, RULES.SOLO.id)
  }

  /**
   * R12 收尾：把**这一集的其余份**补进已配对那一集
   * 的 losers。两条判据都只在没人认领的文件上跑：① 与正主清洗后同名（`canonName`）；
   * ② 时长落在这一集的容差内 + 过名字地板（地板 = 时长档那把尺，见 `rulesFromSpec` 尾注）。
   */
  const runSweep = (rule: MatchRule) => {
    const leftover = graph.files.filter((p) => !used.has(p) && MEDIA_EXT.test(p))
    if (leftover.length === 0) return
    const byCanon = new Map<string, string[]>()
    for (const p of leftover) { const c = canonName(p); const a = byCanon.get(c) ?? []; a.push(p); byCanon.set(c, a) }
    for (const [leftKey, a] of assignments) {
      const l = graph.leftMeta.get(leftKey)
      if (!l) continue
      const sameName = byCanon.get(canonName(a.path)) ?? []
      const sameDuration = l.durationS == null ? [] : leftover.filter((p) => {
        const d = graph.fileMeta.get(p)?.durationS
        if (d == null || Math.abs(d - l.durationS!) > rule.toleranceS!) return false
        const e = edgeAt.get(edgeId(leftKey, p))
        const f = e ? nameFact(e, rule.stripId) : undefined
        // 名字地板：过地板必然分数 ≥0.3 > 记录地板 0.05，所以必有边、必有分——直接比事实上的分。
        return f != null && f.score >= DURATION_MIN_SIM
      })
      const extra = [...new Set([...sameName, ...sameDuration])].filter((p) => !used.has(p) && !contradicts(leftKey, p))
      if (extra.length === 0) continue
      assignments.set(leftKey, { ...a, losers: [...a.losers, ...extra] })
      for (const p of extra) { used.add(p); setOutcome(leftKey, p, 'won', RULES.SWEEP_COPIES.id) }
    }
  }

  for (const rule of rules) {
    switch (rule.kind) {
      case 'pin': runPin(); break
      case 'duration': runMatchRule(rule, produceDuration); break
      case 'struct-key': runMatchRule(rule, produceStructKey); break
      case 'title': runMatchRule(rule, produceTitle); break
      case 'solo': runSolo(); break
      case 'sweep': runSweep(rule); break
    }
  }

  // ── I3：一个文件的证据指向多个集、又没人认领它 → 出卡，不是残差 ─────────────
  /** 够格参与冲突的边：判据是**共用**的那把尺（`candidateWeight`），别在这里另立一套。 */
  const conflictWeight = (e: EvidenceEdge): number => candidateWeight(e.facts)
  for (const path of graph.files) {
    if (used.has(path)) continue
    const contenders = (edgesByFile.get(path) ?? []).filter((e) => conflictWeight(e) >= 0)
    if (contenders.length < 2) continue
    fileAsks.push({
      path,
      stage: 'conflict',
      rule: RULES.DUAL_EPISODE_CONFLICT.id,
      reason: 'dual-episode-conflict',
      candidates: contenders.map((e) => ({ name: e.leftKey, sim: conflictWeight(e) })).sort((x, y) => y.sim - x.sim),
      threshold: DURATION_MIN_SIM,
      margin: 0,
    })
  }
  const askedFiles = new Set(fileAsks.map((a) => a.path!))

  // ── 轨迹 + 残差 ───────────────────────────────────────────────────────────
  const claimedBy = new Map<string, { leftKey: string; rule: string; primary: boolean }>()
  for (const [leftKey, a] of assignments) {
    claimedBy.set(a.path, { leftKey, rule: a.rule, primary: true })
    for (const l of a.losers) if (!claimedBy.has(l)) claimedBy.set(l, { leftKey, rule: a.rule, primary: false })
  }

  const trails = new Map<string, Trail>()
  const residual: string[] = []
  for (const path of graph.files) {
    const edges: TrailEdge[] = (edgesByFile.get(path) ?? []).map((e) => {
      const st = outcomes.get(edgeId(e.leftKey, e.path))
      if (st) return { leftKey: e.leftKey, facts: e.facts, outcome: st.outcome, ...(st.vetoReason ? { vetoReason: st.vetoReason } : {}), ...(st.rule ? { rule: st.rule } : {}) }
      // 走完全部规则仍没人碰过它 —— I1 要求给出理由，逐条分类（`unevaluated` 是漏洞信号）。
      if (!adjudicable(e)) return { leftKey: e.leftKey, facts: e.facts, outcome: 'informational' as const }
      // 带矛盾事实的边先按矛盾记：那是**事实级**的否决（这个文件永远不可能是这一集），
      // 与"该集刚好被别人先认走了"这种顺序性理由不是一个量级。卡片要说最强的那句真话。
      const reason: VetoReason = hasContradict(e) ? 'duration-contradict'
        : assignments.has(e.leftKey) ? 'left-claimed'
        : claimedBy.has(path) ? 'file-claimed' : 'unevaluated'
      return { leftKey: e.leftKey, facts: e.facts, outcome: 'vetoed' as const, vetoReason: reason }
    })
    const owner = claimedBy.get(path)
    const disposition: Trail['disposition'] = owner ? (owner.primary ? 'claimed' : 'copy') : askedFiles.has(path) ? 'asked' : 'residual'
    if (disposition === 'residual') residual.push(path)
    trails.set(path, {
      path, disposition, edges,
      ...(owner ? { claimedBy: owner.leftKey, rule: owner.rule } : {}),
      ...(disposition === 'asked' ? { rule: RULES.DUAL_EPISODE_CONFLICT.id } : {}),
      ...(owner?.primary && thresholdsByFile.has(path) ? { thresholds: thresholdsByFile.get(path)! } : {}),
    })
  }

  const out: Resolution = { assignments, asks: [...asksByLeft.values(), ...fileAsks], residual, trails, missingByLeft }
  assertInvariants(graph, out)
  return out
}

/**
 * 引擎的**唯一对外入口**：一次调用进、一份结论出（P7：只有一个匹配脑，内部是"先看全、再判"）。
 * 两个消费方经 `adapt.ts` 进来：绑定同步 `sync.ts`（`matchByEvidenceResult`）、
 * 归档器 `reconcile/plan.ts`（还要读 `resolution` 里的残差、文件侧问句与轨迹）。
 */
export function matchByEvidence(spec: MatchSpec, left: SpecLeft[], right: SpecRight[]): Resolution {
  const graph = collectEvidence(spec, left, right)
  return resolve(graph, rulesFromSpec(spec, graph))
}

/**
 * I1–I3 的运行时断言。**每轮都跑**——不变量靠自觉守不住，而这三条正是整次重构的立身之本：
 * 违反了就是"无痕丢弃"又回来了，宁可当场炸也别让它悄悄流进处置层。
 */
export function assertInvariants(graph: EvidenceGraph, r: Resolution): void {
  const bad = (msg: string): never => { throw new Error(`match-engine invariant violated: ${msg}`) }

  // I1：每个文件必有轨迹；被否决的边必带理由。
  for (const path of graph.files) {
    const t = r.trails.get(path)
    if (!t) bad(`I1 ${path} 没有裁决轨迹`)
    for (const e of t!.edges) {
      if (e.outcome === 'vetoed' && !e.vetoReason) bad(`I1 ${path} ↔ ${e.leftKey} 被否决却没给理由`)
      if (e.outcome === 'won' && t!.disposition === 'residual') bad(`I1 ${path} 有胜出的边却算残差`)
    }
  }

  // I2：残差只接受"零边"或"每条可裁决的边都被显式否决"。
  const resid = new Set(r.residual)
  for (const path of resid) {
    for (const e of r.trails.get(path)!.edges) {
      if (e.outcome === 'informational') continue
      if (e.outcome !== 'vetoed') bad(`I2 ${path} 算残差，但它与 ${e.leftKey} 的边结局是 ${e.outcome}`)
    }
  }
  for (const [, a] of r.assignments) {
    if (resid.has(a.path)) bad(`I2 ${a.path} 既被认领又算残差`)
    for (const l of a.losers) if (resid.has(l)) bad(`I2 ${l} 既是同集副本又算残差`)
  }

  // I3：证据指向多个集、又没人认领的文件，必须出卡而不是残差。
  const asked = new Set(r.asks.filter((a) => a.path).map((a) => a.path!))
  for (const path of resid) {
    const t = r.trails.get(path)!
    const lefts = new Set(t.edges.filter((e) => e.outcome !== 'informational').map((e) => e.leftKey))
    if (lefts.size >= 2 && !asked.has(path)) {
      // 多集但全是"够不着任何门槛"的弱边（如两条 0.06 分的名字边）不算冲突——I3 管的是
      // **像样的证据互相打架**，把噪声也算进来只会把问句卡淹掉。
      const strong = t.edges.filter((e) => candidateWeight(e.facts) >= 0)
      if (new Set(strong.map((e) => e.leftKey)).size >= 2) bad(`I3 ${path} 的证据指向 ${lefts.size} 个集却静默变成残差`)
    }
  }
}
