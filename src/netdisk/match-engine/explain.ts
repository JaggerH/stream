import { DURATION_MIN_SIM } from '../match-spec.ts'
import type { EdgeOutcome, Fact, Resolution, Trail, TrailEdge, VetoReason } from './types.ts'

/**
 * 账本行上的**证据卡数据**（spec §5.1）：裁决层的 `Trail` 序列化成一行 `explain`。
 *
 * **不另造数据源**——卡片说的话必须是裁决真用过的证据。上一次事故的形状就是"文案与判据两张皮"：
 * `no-duration-hit` 那句"时长和名字都对不上节目单任何一集"在 05 案里是**假话**，
 * 而当时那条被否决的名字边根本没被记下来，所以没人能发现它在说谎。
 *
 * 阶段三（hover card）只负责排版，内容全在这里；`counterfactual`（"如果…"那一段）也归阶段三。
 */

export interface ExplainEdge {
  episode: { leftKey: string; title: string; durationS?: number; paid?: boolean }
  /** 原样，不加工——数字要带得出单位与对照，前端不许自算（`docs/API.md` 的"后端为真相源"）。 */
  facts: Fact[]
  outcome: EdgeOutcome
  /** I1：被否决的边**必带**理由。闭集，人话映射按它维护，缺映射 = 露码，不许编话。 */
  vetoReason?: VetoReason
  /** 定这条边结局的规则编号。 */
  rule?: string
}

export interface RowExplain {
  file: { path: string; sizeBytes: number; durationS?: number; kbps?: number }
  /** 按强度降序。入选条件见 `worthShowing`，上限见 `MAX_EXPLAIN_EDGES`。 */
  edges: ExplainEdge[]
  /** 轨迹里**没列进来**的边数（够不着展示门槛的 + 超出上限截掉的）。0 时字段缺席。 */
  truncatedCount?: number
  verdict: {
    /**
     * 命中的裁决规则编号（`R4` 等）。**残差没有规则**（没有任何一条规则认领它），
     * 那时这个字段缺席——硬编一个规则号出来就是在编话。
     */
    rule?: string
    /** `claimed` 正主 / `copy` 同集其余份 / `asked` 出卡 / `residual` 残差。 */
    disposition: Trail['disposition']
    /** 门槛对照：命中值 vs 阈值。 */
    thresholds?: Record<string, { got: number; need: number }>
  }
}

/** 单行最多带几条边。超出记 `truncatedCount`——账本是每轮一条记录，不设上限会把库撑起来。 */
export const MAX_EXPLAIN_EDGES = 8

const nameScore = (facts: Fact[]): number => {
  const scores = facts.filter((f): f is Extract<Fact, { kind: 'name' }> => f.kind === 'name').map((f) => f.score)
  return scores.length ? Math.max(...scores) : 0
}

/**
 * 一条边的展示强度。**先看结局、再看证据**：胜出的那条永远排头（卡片第一眼要回答"凭什么是它"），
 * 其余按证据分量排。时长矛盾也算分量——"这个文件永远不可能是这一集"是句有信息量的话，
 * 把它排到末尾等于把最硬的那条否决藏起来。
 */
function strengthOf(e: { facts: Fact[]; outcome: EdgeOutcome }): number {
  const base = e.outcome === 'won' ? 1000 : e.outcome === 'informational' ? 0 : 100
  const hit = e.facts.some((f) => f.kind === 'duration' && f.state === 'hit') ? 10 : 0
  const contradict = e.facts.some((f) => f.kind === 'duration' && f.state === 'contradict') ? 5 : 0
  const struct = e.facts.some((f) => f.kind === 'struct-key') ? 8 : 0
  return base + hit + contradict + struct + nameScore(e.facts)
}

/**
 * 这条边够不够格进卡片：**胜出的，或带得出可裁决分量的**（时长命中 / 结构键 / 名字过
 * `DURATION_MIN_SIM` 地板）。判据与裁决层认"相争者"的那把尺是同一把——卡片上列的，
 * 正是规则真正会拿来比的那几条。
 *
 * 剩下的是**记录密度的产物**：名字器的记录地板是 0.05，远低于裁决地板 0.3，于是一份文件会与
 * 几十集各连一条 0.06 分的边。它们留在 `Trail` 里（I1 要的是轨迹完整，那份在内存里没动），
 * 但不进卡片——活体实测 2096 条边里有 823 条是这种，**它们把真证据挤出了 8 条的上限**
 * （373 行里 162 行被截断），既让卡片变噪音又让账本涨了 4.5 倍。没列进来的条数由
 * `truncatedCount` 如实交代，不假装没有过。
 *
 * 只带 `byte-identity` 的边（`informational`）同样不进：那条孪生信息**每条边上都挂了一份**
 * （见 `Fact` 的 byte-identity 头注），留下的边里现成就有，不会因此丢。
 */
const worthShowing = (e: TrailEdge): boolean =>
  e.outcome === 'won'
  || e.facts.some((f) => (f.kind === 'duration' && f.state === 'hit') || f.kind === 'struct-key')
  || nameScore(e.facts) >= DURATION_MIN_SIM

export interface ExplainEpisode { title: string; durationS?: number; paid?: boolean }

/**
 * `Trail` + 文件事实 → 一行 `explain`。`episodeOf` 把 leftKey 翻回集标题
 * （裁决层只认 key，标题是展示层的事）。
 */
export function explainFromTrail(
  trail: Trail,
  file: { path: string; size: number; durationS?: number },
  episodeOf: (leftKey: string) => ExplainEpisode | undefined,
  maxEdges = MAX_EXPLAIN_EDGES,
): RowExplain {
  const ranked = trail.edges.filter(worthShowing).sort((a, b) => strengthOf(b) - strengthOf(a) || a.leftKey.localeCompare(b.leftKey))
  const kept = ranked.slice(0, maxEdges)
  const truncatedCount = trail.edges.length - kept.length
  return {
    file: {
      path: file.path,
      sizeBytes: file.size,
      ...(file.durationS != null ? { durationS: file.durationS } : {}),
      // 码率现算（spec §5.1）：size×8÷时长。两者缺一或时长为 0 就没有这个数，别塞个 0 冒充。
      ...(file.durationS ? { kbps: Math.round((file.size * 8) / file.durationS / 1000) } : {}),
    },
    edges: kept.map((e) => {
      const ep = episodeOf(e.leftKey)
      return {
        episode: {
          leftKey: e.leftKey,
          title: ep?.title ?? e.leftKey,
          ...(ep?.durationS != null ? { durationS: ep.durationS } : {}),
          ...(ep?.paid != null ? { paid: ep.paid } : {}),
        },
        facts: e.facts,
        outcome: e.outcome,
        ...(e.vetoReason ? { vetoReason: e.vetoReason } : {}),
        ...(e.rule ? { rule: e.rule } : {}),
      }
    }),
    ...(truncatedCount > 0 ? { truncatedCount } : {}),
    verdict: {
      ...(trail.rule ? { rule: trail.rule } : {}),
      disposition: trail.disposition,
      ...(trail.thresholds ? { thresholds: trail.thresholds } : {}),
    },
  }
}

/**
 * 一次判决里全部文件的 `explain`（path → 行数据）。归档器按路径取，取不到就**不带这个字段**
 * ——豁免/字节全等那两档跑在匹配器之前，压根没进过证据图，没有轨迹是正常的。
 */
export function explainsOf(
  resolution: Resolution,
  fileOf: (path: string) => { path: string; size: number; durationS?: number } | undefined,
  episodeOf: (leftKey: string) => ExplainEpisode | undefined,
): Map<string, RowExplain> {
  const out = new Map<string, RowExplain>()
  for (const [path, trail] of resolution.trails) {
    const f = fileOf(path)
    if (!f) continue
    out.set(path, explainFromTrail(trail, f, episodeOf))
  }
  return out
}
