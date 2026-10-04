import type { MatchSpec, MatchStage } from '../types.ts'
import { specStages, DURATION_MIN_SIM, DEFAULT_TITLE_STRIP, DURATION_TOLERANCE_S } from '../match-spec.ts'
import type { EvidenceGraph, StripId, StructKeyKind } from './types.ts'

/**
 * ② 裁决层的**规则表**（spec §3.2）。
 *
 * **优先级就是这张表的顺序**，不是控制流的副产品——"什么时候谁生效"在这里是能读、能单测、
 * 能引用的一条条规则，编号与拍板台账互引（hover card 的"裁决"段显示的就是它）。
 *
 * 规则表实现的是**裁决表**（spec §8 定稿 / 台账 P13，八格全文在那里）。八格的结论钉在
 * `decision-table.test.ts`：改这里的顺序/门槛/增删一档都不许改变那些结论。整体行为另有
 * 104 组金样冻结基线守着（`golden.test.ts`），有意的变更要连基线一起重录。
 */

export const RULES = {
  /** R1 人工订正预置：人裁过的机器不许翻案。跑任何别的规则之前先占位。 */
  PIN: { id: 'R1', name: '人工订正预置' },
  /** R2 时长唯一命中免检（`trustUnique`）：容差内独一份就是锚级证据，不检 threshold/margin。 */
  DURATION_UNIQUE: { id: 'R2', name: '时长唯一命中免检' },
  /** R3 名字地板：R2 的免检还要过 `DURATION_MIN_SIM`；不过就不配，并记一条 `name-floor` 问句。 */
  DURATION_NAME_FLOOR: { id: 'R3', name: '时长唯一命中 × 名字地板不过' },
  /** R4 零竞争出口（P10）：撞进容差的几份里只有一个名字沾得上边 → 那不是撞车，见 `soleTouching`。 */
  ZERO_COMPETITION: { id: 'R4', name: '时长桶零竞争出口' },
  /** R5 时长撞车靠标题消歧：真撞车（多份都沾边）交给 `pickBest` 的 threshold/margin。 */
  DURATION_COLLISION: { id: 'R5', name: '时长撞车 × 标题消歧' },
  /** R6 季集结构键：唯一候选免检、命中即 auto（键本身就是消歧证据，不设名字地板）。 */
  SEASON_EPISODE: { id: 'R6', name: '季集结构键' },
  /** R7 期号+上/下复合键：同 R6 的口径（唯一免检、命中即 auto）。 */
  EPISODE_PART: { id: 'R7', name: '期号分段复合键' },
  /** R8 集号分桶 + 标题消歧：**不**免检、**不**恒 auto——"号一样"不是消歧证据。缺档口径只归它。 */
  EPNUM: { id: 'R8', name: '集号分桶 × 标题消歧' },
  /** R9 纯标题相似度兜底：高阈值防误配，且 `markAsk:false`——没够到就当没信号，不记问句。 */
  TITLE: { id: 'R9', name: '标题相似度兜底' },
  /** R10 电影独苗：唯一左项 × 目录里的视频文件 → 认领正片（这一档没有"标题相似度"这个语义）。 */
  SOLO: { id: 'R10', name: '电影唯一视频文件' },
  /** R11 横向时长矛盾闸（判据 `contentContradicts`）——它管住**所有**档，包括 R10。 */
  CONTENT_MISMATCH: { id: 'R11', name: '横向时长矛盾闸' },
  /** R12 同集其余份收尾：把这一集的其余拷贝补进 `losers`（收尾规则，恒在最后）。 */
  SWEEP_COPIES: { id: 'R12', name: '同集其余份收尾' },
  /**
   * R13 双集冲突出卡 —— I3 的落实（spec §3.2）。一个文件的证据指向多个集、又没被任何规则
   * 认领时**必须出卡**：默认值是"问人"，不是"挑一个"，更不是"当没看见"（当没看见就是 05 案）。
   */
  DUAL_EPISODE_CONFLICT: { id: 'R13', name: '双集冲突' },
  /**
   * R14 名字命中 × 时长矛盾 —— **裁决表第 3 格**（spec §8 定稿表）。
   *
   * 第 3 格的判决是"出卡"：名字唯一命中给了它"不许静默"的豁免，时长矛盾剥夺了"免检认领"的
   * 资格，两个证据打架就该人裁。带 `markAsk` 的四档（R6/R7/R8 + 时长档）本来就把这一格记成
   * 问句了；**只有 R9 标题档是个洞**——它 `markAsk:false`（"仅高阈相似，没到就当没信号"），
   * 于是"清洗后全等 + 时长差出量级"这种最该问人的形状会连一张卡都不出，文件直接算残差 → 下架。
   *
   * 本规则只补那个洞，且判据收得比 R11 窄：**被时长否掉的候选里得有一个本可认领的赢家**
   * （过本档 `pickBest`）。不这么收的话，标题档那一堆 0.06 分的噪声边会在时长一矛盾时全变成卡。
   */
  NAME_HIT_DURATION_CONTRADICT: { id: 'R14', name: '名字命中 × 时长矛盾' },
} as const

/** 一条可执行的匹配规则（R2–R9 的槽位由 `matchSpec.stages` 装载，顺序即优先序）。 */
export interface MatchRule {
  id: string
  name: string
  kind: 'pin' | 'duration' | 'struct-key' | 'title' | 'solo' | 'sweep'
  stage: MatchStage['by'] | 'pin' | 'sweep'
  /** 本规则那把清洗尺（见 `StripId`）。`pin` 无。 */
  stripId?: StripId
  threshold: number
  margin: number
  /** 唯一候选免检 threshold/margin。只有桶键本身就是消歧证据时才敢开。 */
  trustUnique: boolean
  /** 命中即 `auto`（不看相似度）。 */
  autoOnMatch: boolean
  /** 有像样候选却没敢配 → 记一条问句（`title` 档不记：仅高阈相似，没到就当没信号）。 */
  markAsk: boolean
  structKey?: StructKeyKind
  toleranceS?: number
}

/**
 * 挑最像的一个：过阈值且（唯一或明显领先次佳）才算数。
 * 门槛判定是规则的正身，所以它长在裁决层里、不在证据层。
 *
 * `score` 直接取自 `name` 事实，不重算：卡片显示的分和规则用的分必须是同一个数（§5.3）。
 */
export type PickResult =
  | { ok: true; path: string; sim: number }
  | { ok: false; reason: 'below-threshold' | 'no-margin'; scored: { name: string; sim: number }[] }

export function pickBest(
  cands: { path: string; score: number }[],
  threshold: number,
  margin: number,
  trustUnique: boolean,
): PickResult {
  const scored = cands.map((c) => ({ name: c.path, sim: c.score })).sort((x, y) => y.sim - x.sim)
  const best = scored[0]
  if (trustUnique && scored.length === 1) return { ok: true, path: best.name, sim: best.sim }
  const exactUnique = best.sim === 1 && (scored.length === 1 || scored[1].sim < 1)
  if (best.sim < threshold) return { ok: false, reason: 'below-threshold', scored }
  if (scored.length === 1 || exactUnique || best.sim - scored[1].sim > margin) return { ok: true, path: best.name, sim: best.sim }
  return { ok: false, reason: 'no-margin', scored }
}

/**
 * R4 零竞争出口：撞进容差的几份里只有一个名字沾得上边（`score > 0`）、其余恰好 0 时，
 * 返回那个唯一沾边的。两道边界不许放宽：
 * 赢家仍要过名字地板；落选的那些**绝不算 losers**（它们是别的集的文件）。
 */
export function soleTouching<T extends { tn: string; score: number }>(cands: T[]): T | null {
  const touching = cands.filter((c) => c.score > 0)
  if (touching.length !== 1) return null
  // 地板直接比事实上的分——它就是同一把尺量出的 titleSim，重算一遍除了违反"分只算一次"什么也得不到。
  return touching[0].score >= DURATION_MIN_SIM ? touching[0] : null
}

/** 在图里找一套 `titleStrip` 对应的 stripId（证据器登记过的那一份）。 */
export function stripIdOf(graph: EvidenceGraph, titleStrip: string[]): StripId {
  const sig = JSON.stringify(titleStrip)
  for (const [id, patterns] of Object.entries(graph.strips)) if (JSON.stringify(patterns) === sig) return id
  return Object.keys(graph.strips)[0] ?? 'S0'
}

/**
 * 把存量 `matchSpec` 装载成有序规则表。**顺序 = `specStages(spec)` 的顺序**（隐式时长锚排最前），
 * 顺序即优先序：谱里 stage 的排列决定谁先生效，隐式时长锚恒在最前、收尾规则恒在最后。
 *
 * 首尾两条与 stage 无关，恒在：R1 预置（跑任何规则之前）、R12 收尾（跑完所有规则之后）。
 */
export function rulesFromSpec(spec: MatchSpec, graph: EvidenceGraph): MatchRule[] {
  const base = { threshold: 0, margin: 0, trustUnique: false, autoOnMatch: false, markAsk: false } as const
  const out: MatchRule[] = [{ ...RULES.PIN, kind: 'pin', stage: 'pin', ...base }]
  let toleranceS = DURATION_TOLERANCE_S
  let durationStrip: string[] = DEFAULT_TITLE_STRIP

  for (const stage of specStages(spec)) {
    if (stage.by === 'solo') {
      out.push({ ...RULES.SOLO, kind: 'solo', stage: 'solo', ...base, trustUnique: true, autoOnMatch: true })
      continue
    }
    const common = {
      stripId: stripIdOf(graph, stage.titleStrip),
      threshold: stage.threshold,
      margin: stage.margin,
    }
    switch (stage.by) {
      case 'duration':
        toleranceS = stage.toleranceS
        durationStrip = stage.titleStrip
        // trustUnique 开、autoOnMatch 关：唯一命中的 auto 由 R2 逐左项给（撞车后靠标题选出来的
        // 那种不算锚级证据，状态按相似度定）。
        out.push({ ...RULES.DURATION_UNIQUE, kind: 'duration', stage: 'duration', ...common, trustUnique: true, autoOnMatch: false, markAsk: true, toleranceS: stage.toleranceS })
        break
      case 'season-episode':
        out.push({ ...RULES.SEASON_EPISODE, kind: 'struct-key', stage: 'season-episode', structKey: 'season-episode', ...common, trustUnique: true, autoOnMatch: true, markAsk: true })
        break
      case 'episode-part':
        out.push({ ...RULES.EPISODE_PART, kind: 'struct-key', stage: 'episode-part', structKey: 'episode-part', ...common, trustUnique: true, autoOnMatch: true, markAsk: true })
        break
      case 'epnum':
        out.push({ ...RULES.EPNUM, kind: 'struct-key', stage: 'epnum', structKey: 'epnum', ...common, trustUnique: false, autoOnMatch: false, markAsk: true })
        break
      case 'title':
        out.push({ ...RULES.TITLE, kind: 'title', stage: 'title', ...common, trustUnique: false, autoOnMatch: false, markAsk: false })
        break
    }
  }

  // R12 用的是**时长档那把尺**（那一档的 titleStrip + `DURATION_MIN_SIM`）。归档器一度自己
  // 有一套更松的判据，37 案就是那么来的——见 `DURATION_MIN_SIM` 头注。
  out.push({ ...RULES.SWEEP_COPIES, kind: 'sweep', stage: 'sweep', ...base, stripId: stripIdOf(graph, durationStrip), toleranceS })
  return out
}
