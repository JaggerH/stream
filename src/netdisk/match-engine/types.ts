import type { MatchStage } from '../types.ts'

/**
 * 匹配引擎三层架构的类型层（spec `2026-08-02-match-engine-evidence-graph-design.md` §3）。
 *
 * 三层的分工：**证据层只吐事实、裁决层只读图、处置层只读判决**。本文件只定义前两层之间的契约
 * （`EvidenceGraph`）与裁决层的产物（`Resolution`）。
 *
 * 两个消费方（`sync.ts` 绑定同步、`reconcile/plan.ts` 归档器）经 `adapt.ts` 进来；
 * 整体行为由 `golden.ts` 的冻结基线守着。
 */

// ─────────────────────────────────────────────────────────────────────────────
// ① 证据层
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一套清洗口径的 id（`S0`/`S1`…）。**为什么 `name` 事实要带它**：各 stage 可以各配一份
 * `titleStrip`（隐式补的时长档取各档并集），同一对「集↔文件」在不同口径下清洗出的串不同、
 * 相似度也不同。裁决层的门槛比的是**本规则那把尺量出来的分**，事实上不写清是哪把尺，
 * hover card 就会显示一个裁决根本没用过的数字——那正是 spec §5.3 禁的"文案与判据两张皮"。
 */
export type StripId = string

/**
 * 一条证据边上的事实。`kind` 是**闭集**：加一种证据 = 加一种 Fact + 注册一个证据器
 * （spec §3.1）。事实只陈述"量到了什么"，一律不含结论。
 */
export type Fact =
  /** 名字：`identity-exact` = 两侧清洗后逐字相同（`score` 恒 1）；`sim` = bigram Dice。 */
  | { kind: 'name'; method: 'identity-exact' | 'sim'; score: number; cleanedLeft: string; cleanedRight: string; stripId: StripId }
  /** 结构键：两侧读出了**同一个**键值才有这条事实（键不同 = 不建边）。 */
  | { kind: 'struct-key'; key: StructKeyKind; value: string }
  /**
   * 时长。两态各有各的判据，别混：
   *  - `hit`：`|Δ| <= toleranceS`（认集主锚，`DURATION_TOLERANCE_S` 默认 1s）。
   *  - `contradict`：相对差 > `CONTENT_MISMATCH_RATIO`（0.1）= 错身文件，横向闸门。
   * 两者中间那一段（差出容差但没差出量级，如 8000s 的集差 5s）**不产事实**——那一段既不算
   * 时长命中、也不拦文件名档，事实层照实不表态。任一侧无时长 → 无事实（unknown 不是事实）。
   */
  | { kind: 'duration'; state: 'hit' | 'contradict'; deltaS: number; toleranceS: number }
  /**
   * 文件↔文件：与 `peerPath` 同字节数且时长相同或同缺 = 同一份内容的另一拷贝，供副本裁决。
   *
   * **为什么挂在集↔文件的边上**：`EvidenceEdge` 的键是 (集, 文件)，而这条事实讲的是文件的另一面。
   * 挂法是「该文件的**每条**边都带上它的全部孪生」——hover card 的一行就是一个文件，
   * 卡片要回答"它和别的文件是不是同一份"时，切片里现成就有（05 案的"与 B 正主字节全等"那句）。
   * 代价：一条边上会出现与本集无关的孪生信息（`outcome: 'informational'`）。
   * **已知边界**：一条边都没有的文件，其孪生关系无处表达——阶段一没有规则读它，故不额外造结构。
   */
  | { kind: 'byte-identity'; peerPath: string }

export type StructKeyKind = 'season-episode' | 'episode-part' | 'epnum'

/** 一对「集↔文件」上量到的全部事实。`facts` 非空——全空的对不建边。 */
export interface EvidenceEdge { leftKey: string; path: string; facts: Fact[] }

/** 右侧文件节点。字段够 `RowExplain.file`（spec §5.1）直渲：kbps 由 size/duration 现算。 */
export interface FileNode { path: string; sizeBytes?: number; durationS?: number }
/**
 * 左侧节目单节点。`paid` 只进展示与处置层，**裁决层不许读**（P7：读了就是第二个判定脑）。
 *
 * `needsSupply` 是裁决层**唯一**能读的那半边语义：「这一集要不要人供货」（缺席 = 要）。
 * 它已经把处置压平成一个布尔量，裁决层不知道什么叫"付费"，只据此决定**该不该开口问人**——
 * 不需供货的集，问句问了也白问（答案不改变任何处置）。语义与来路见 `SpecLeft.needsSupply`。
 */
export interface LeftNode { leftKey: string; title: string; durationS?: number; paid?: boolean; needsSupply?: boolean; pinnedRight?: string }

/**
 * 左侧的**节点级**结构键（不是边）。边只在两侧键值相同时才有，于是"这一集有集号、但右侧
 * 没有任何文件带这个号"这件事在边集里查不出来——而它正是缺档（`missingEpisodes`）的定义。
 */
export interface LeftStructKey { leftKey: string; key: StructKeyKind; value: string }

export interface EvidenceGraph {
  /** 只存有事实的对。 */
  edges: EvidenceEdge[]
  /** 全部入池文件，**含一条边都没有的**——残差判定需要"确认它一条边都没有"（I2）。 */
  files: string[]
  /** 全部权威 leftKey，**保持输入顺序**：裁决层按这个顺序遍历，判决因此对输入顺序确定。 */
  lefts: string[]
  fileMeta: Map<string, FileNode>
  leftMeta: Map<string, LeftNode>
  leftStructKeys: LeftStructKey[]
  /** stripId → 该口径的 titleStrip 正则串。规则按 id 取自己那把尺量出来的 `name` 事实。 */
  strips: Record<StripId, string[]>
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 裁决层
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 被否决的边**必须**给出理由（I1），且理由是闭集——hover card 的人话映射按这个集维护，
 * 缺映射 = 测试红（spec §5.2：宁可露码，不许编话）。
 */
export type VetoReason =
  /** 横向时长矛盾闸：两侧都有时长且差出量级，任何一档都不算配上。 */
  | 'duration-contradict'
  /** 纯享剪辑对期-段体系里的正片：文件名说自己是纯享、清单那一集不是——事实级否决，任何一档都不算配上，也不出问句。 */
  | 'pure-cut-mismatch'
  /** 时长容差内独一份，但名字连 `DURATION_MIN_SIM` 地板都不沾。 */
  | 'name-floor'
  /** 时长撞车里的"零竞争"落选者：名字一个字不沾，它是**别的集**的文件，不是这一集的副本。 */
  | 'zero-competition-loser'
  /** 相似度没到本规则的 threshold。 */
  | 'below-threshold'
  /** 与次佳拉不开 margin。 */
  | 'no-margin'
  /** 该集已被更早的规则认领，这条边**从未被评估**——05 案的第二条断路，必须留痕。 */
  | 'left-claimed'
  /** 该文件已被别的集认领（或作为副本占住）。 */
  | 'file-claimed'
  /** 桶内清晰度/同名去重时被吸收或落选（`reduceByQuality`）。 */
  | 'quality-dedup'
  /** 只带 `byte-identity` 这类不可裁决的事实，本就不是候选。 */
  | 'no-adjudicable-fact'
  /**
   * 兜底：走完全部规则仍没有任何规则碰过它。**活体出现即是规则覆盖的漏洞**（有事实、两端都空闲、
   * 却没人评估），不是正常终态；留在闭集里是为了让漏洞可见而不是让 I1 断言炸掉整轮匹配。
   */
  | 'unevaluated'

/** 边的结局。`informational` 只给不可裁决的事实（如与本集无关的 `byte-identity`）。 */
export type EdgeOutcome = 'won' | 'vetoed' | 'informational'

export interface TrailEdge {
  leftKey: string
  facts: Fact[]
  outcome: EdgeOutcome
  vetoReason?: VetoReason
  /** 定这条边结局的规则编号（`R4` 等）。 */
  rule?: string
}

/**
 * 一个文件的**裁决轨迹** —— I1 的载体，也是 hover card（spec §5.1 `RowExplain`）的直接数据源：
 * `RowExplain.edges[]` = `Trail.edges` 逐条渲染，`RowExplain.verdict` = `{rule, thresholds}`。
 * 阶段一只产出 `Trail`，不做 `RowExplain` 序列化。
 */
export interface Trail {
  path: string
  /** `claimed` 正主 / `copy` 同集其余份 / `asked` 出卡 / `residual` 残差。 */
  disposition: 'claimed' | 'copy' | 'asked' | 'residual'
  claimedBy?: string
  rule?: string
  /** 门槛对照：命中值 vs 阈值（`{ sim: { got: 0.571, need: 0.6 } }`）。 */
  thresholds?: Record<string, { got: number; need: number }>
  edges: TrailEdge[]
}

/**
 * 出卡理由。前四个沿用 `SpecAmbiguity['reason']` 的闭集（前端零迁移），
 * `dual-episode-conflict` 是 I3 新增的**文件侧**卡：一个文件的证据指向多个集且无规则显式裁定。
 */
export type AskReason = 'below-threshold' | 'no-margin' | 'duration-contradiction' | 'name-floor' | 'dual-episode-conflict'

/**
 * 一条问句。`SpecAmbiguity` 的超集：集侧卡带 `leftKey`（形状与字段名逐字沿用），
 * 文件侧卡（I3）带 `path`、`candidates` 装的是相争的那几集。
 */
export interface Ask {
  leftKey?: string
  path?: string
  stage: MatchStage['by'] | 'conflict'
  rule: string
  reason: AskReason
  /** 当时在场的候选，按分数降序。 */
  candidates: { name: string; sim: number }[]
  threshold: number
  margin: number
}

/** 认领。形状对齐 `SpecAssignment`（`path` = `rightFile`），多带一个规则编号。 */
export interface ResolvedAssignment {
  path: string
  confidence: number
  status: 'auto' | 'pending'
  /** 同集的其余份（另一画质 / 水印副本）。只有一份时是空数组。 */
  losers: string[]
  rule: string
}

export interface Resolution {
  assignments: Map<string, ResolvedAssignment>
  asks: Ask[]
  /** 残差：在 `graph.files` 里且【零边 或 全部可裁决的边都被显式否决】（I2）。 */
  residual: string[]
  trails: Map<string, Trail>
  /** 集号在左侧、右侧无此号文件 → 缺档（口径只归 `epnum`，见 R8）。 */
  missingByLeft: Map<string, number>
}
