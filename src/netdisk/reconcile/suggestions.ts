/**
 * 「AI 建议 vs 人最终选择」的对照账本。
 *
 * **为什么要有它**：待决卡上的判读带引文，那只保证"这话它真说过"，保证不了"引对了话、判对了
 * 集"——ASR 把专有名词听错时，一句真实引文照样能支撑一个错结论。人看卡时能识破，自动采纳没人
 * 看。所以放开自动采纳的门槛不是"撤不撤得回来"（两种结论都只写决定账本、都撤得回来），是
 * **准确率没有底数**。这张表就是那个底数的原始数据。
 *
 * **为什么落库、而不是等人点采纳时由前端把建议带上来**：判读的结果只活在做判读那一刻，等到人
 * 做决定那一刻再回头找建议，找不着的那些会静默变成"没建议"，而它们恰恰包含最有价值的一类——
 * **AI 建议了、人看完压根没采纳**。建议一出来就落一行，人答不答都留痕。
 *
 * **AI 那半截有两个生产写入方**：对话裁决（模型自己用 `netdisk_transcribe` 听、自己判、经决定
 * 端点落账，`record` 由调用方顺手写一行）；以及轮末裁决器（`adjudicate/service.ts` 的
 * `AdjudicationService`，每条模型结论——含被拒收的、`unsure` 的——都写一行，见
 * `docs/MATCHING.md` "End-of-round adjudication" 一节）。人那半截（`answer`）照旧有活的调用方，存量里还没答的
 * 行仍答得上。
 *
 * **只存原始事实，一致与否读时算**（`agreementOf`）。判据将来会调（比如 `none-of-these` 要不要
 * 计入），存的是结论就得回头重算历史；存原始的，改判据只改一个函数。
 */
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

/** AI 那一侧的结论。`failed` = 判读整个没出来（没配 LLM / 模型的话没法用）——**它不是"拿不准"**，
 *  两者的下一步不一样，混成一格就再也分不开了。 */
export type SuggestionVerdict = 'is-episode' | 'none-of-these' | 'unsure' | 'failed'
/** 人那一侧只有这两种答案会进来。撤回（`verdict: null`）不写——账本问的是"他当时选了什么"，
 *  后来撤掉不改变当时那一次的选择。 */
export type HumanVerdict = 'is-episode' | 'not-episode'

export interface SuggestionRow {
  id: string
  at: number
  path: string
  verdict: SuggestionVerdict
  /** `is-episode` 时 AI 指的是哪一集。 */
  leftKey?: string
  /** 引文条数。**0 = 整条作废**，不进分母（没有引文的判决在 `parseVerdict` 那层就该废了，
   *  这里再记一次是因为它决定这一行算不算数）。 */
  quotes: number
  /** 当时摆在这张卡上的候选（leftKey 列表）。人选了一个候选外的集时靠它看得出来。 */
  candidates: string[]
  answeredAt?: number
  humanVerdict?: HumanVerdict
  humanLeftKey?: string
}

/** 一行的一致性。**`null` 不是"不一致"**：它是"这一行没法比"（AI 没给可比的结论、人还没答、
 *  或人答的是另一集的否定——那与 AI 说的既不冲突也不印证）。三者混一起，分母就是假的。 */
export type Agreement = 'agree' | 'disagree' | null

/**
 * 这一行到底算一致还是分歧。
 *
 * 只有两种 AI 结论进得了分母（与「全部采纳」的 `confidentOf` 同一套判据，理由也同一个）：
 *  · `is-episode` 且带 leftKey ——人也认领了同一集 = 一致；认领了别的集、或直接在这一集上答
 *    「不是」= 分歧。**分歧这一格才是关键数据**：它是 AI 判错的实证。
 *  · `none-of-these` ——人答「不是这一集」= 一致；人反而认领了某一集 = 分歧。
 *
 * `unsure` / `failed` / 无引文一律出局：它们本来就不在自动采纳的射程里，算进分母只会把
 * 一致率稀释成一个谁也不敢用的数。
 */
export function agreementOf(row: SuggestionRow): Agreement {
  if (!row.quotes || !row.humanVerdict) return null
  if (row.verdict === 'is-episode') {
    if (!row.leftKey) return null
    if (row.humanVerdict === 'is-episode') return row.humanLeftKey === row.leftKey ? 'agree' : 'disagree'
    // 「不是这一集」只有落在 **AI 指的那一集**上才是对它的否定；落在别的集上说的是另一件事。
    return row.humanLeftKey === row.leftKey ? 'disagree' : null
  }
  if (row.verdict === 'none-of-these') return row.humanVerdict === 'not-episode' ? 'agree' : 'disagree'
  return null
}

/** 四格**互斥且穷尽**（相加 = `countable`）：少一格就会有一类结局静默消失，而消失的那类
 *  往往正是该看的（「人答了但没法比」尤其）。 */
export interface AgreementCounts {
  countable: number
  agreed: number
  disagreed: number
  /** 人答了，但答的是与这条建议无关的另一件事。 */
  inconclusive: number
  /** 还没人答。 */
  open: number
}

export interface SuggestionSummary extends AgreementCounts {
  /** 记下来的建议总数，**含** unsure / 判读失败 / 无引文那些（它们不进 `countable`）。 */
  total: number
  byKind: Record<'is-episode' | 'none-of-these', AgreementCounts>
}

const empty = (): AgreementCounts => ({ countable: 0, agreed: 0, disagreed: 0, inconclusive: 0, open: 0 })

function tally(into: AgreementCounts, row: SuggestionRow): void {
  into.countable++
  const a = agreementOf(row)
  if (a === 'agree') into.agreed++
  else if (a === 'disagree') into.disagreed++
  else if (row.humanVerdict) into.inconclusive++
  else into.open++
}

/** 进得了分母的两种结论（与 `agreementOf` 同源，别在别处再判一次）。 */
const countableKind = (row: SuggestionRow): 'is-episode' | 'none-of-these' | null => {
  if (!row.quotes) return null
  if (row.verdict === 'is-episode' && row.leftKey) return 'is-episode'
  if (row.verdict === 'none-of-these') return 'none-of-these'
  return null
}

export function summarize(rows: SuggestionRow[]): SuggestionSummary {
  const out: SuggestionSummary = {
    total: rows.length, ...empty(),
    byKind: { 'is-episode': empty(), 'none-of-these': empty() },
  }
  for (const row of rows) {
    const kind = countableKind(row)
    if (!kind) continue
    tally(out, row)
    tally(out.byKind[kind], row)
  }
  return out
}

export interface SuggestionQuery {
  /** 只要还没人答的 / 只要已经答过的。 */
  state?: 'open' | 'answered'
  /** 只要一致的 / 只要分歧的 / 只要答了但没法比的。**看反例就用 `disagree`**。 */
  agreement?: 'agree' | 'disagree' | 'inconclusive'
  limit?: number
  /** 上一页最后一行的 `cursor`（内部 rowid），取更早的。 */
  cursor?: number
}

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

interface Row {
  rowid: number; id: string; at: number; path: string; verdict: string; left_key: string | null
  quotes: number; candidates: string; answered_at: number | null
  human_verdict: string | null; human_left_key: string | null
}

const fromRow = (r: Row): SuggestionRow => ({
  id: r.id, at: r.at, path: r.path,
  verdict: r.verdict as SuggestionVerdict,
  ...(r.left_key !== null ? { leftKey: r.left_key } : {}),
  quotes: r.quotes,
  candidates: JSON.parse(r.candidates) as string[],
  ...(r.answered_at !== null ? { answeredAt: r.answered_at } : {}),
  ...(r.human_verdict !== null ? { humanVerdict: r.human_verdict as HumanVerdict } : {}),
  ...(r.human_left_key !== null ? { humanLeftKey: r.human_left_key } : {}),
})

export class SuggestionLog {
  private readonly ins: Database.Statement
  private readonly all: Database.Statement
  private readonly openest: Database.Statement
  private readonly latest: Database.Statement
  private readonly setAnswer: Database.Statement

  constructor(db: Database.Database) {
    this.ins = db.prepare(
      'INSERT INTO ai_suggestions (id, at, path, verdict, left_key, quotes, candidates) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    this.all = db.prepare('SELECT rowid, * FROM ai_suggestions ORDER BY rowid DESC')
    // 人答的是**此刻摆在他面前**的那一条建议 = 这份文件最近一条还没答过的。同一份文件被听过
    // 两轮时，把答案记到旧那条上就是把两轮的账串了。
    this.openest = db.prepare(
      'SELECT rowid FROM ai_suggestions WHERE path = ? AND answered_at IS NULL ORDER BY rowid DESC LIMIT 1',
    )
    this.latest = db.prepare(
      'SELECT rowid, * FROM ai_suggestions WHERE path = ? ORDER BY rowid DESC LIMIT 1',
    )
    this.setAnswer = db.prepare(
      'UPDATE ai_suggestions SET answered_at = ?, human_verdict = ?, human_left_key = ? WHERE rowid = ?',
    )
  }

  record(e: { path: string; verdict: SuggestionVerdict; leftKey?: string; quotes: number; candidates: string[] }): string {
    const id = randomUUID()
    this.ins.run(id, Date.now(), e.path, e.verdict, e.leftKey ?? null, e.quotes, JSON.stringify(e.candidates))
    return id
  }

  /**
   * 人对这份文件下了判断。**没有对应的开放建议就什么都不做**——那说明这张卡他没让 AI 听过
   * （或听过的那轮已经答完），凭空补一行会造出一条"AI 建议"根本不存在的记录。
   *
   * 一个例外，是 `evidence-conflict` 那类卡逼出来的：那张卡的「都不是」会**对每一个候选各写
   * 一条**「不是这一集」，于是同一份文件连着来好几发。先到的那一发把行占了，AI 指的那一集
   * 恰好排在后面时，一次真实的分歧就会被记成"没法比"。所以多发否定里，**落在 AI 自己那一集
   * 上的那一发说了算**——它是唯一一发真正在否定这条建议。
   */
  answer(path: string, verdict: HumanVerdict, leftKey: string): void {
    const open = this.openest.get(path) as { rowid: number } | undefined
    if (open) { this.setAnswer.run(Date.now(), verdict, leftKey, open.rowid); return }
    if (verdict !== 'not-episode') return
    const last = this.latest.get(path) as Row | undefined
    if (!last || last.human_verdict !== 'not-episode' || last.left_key !== leftKey) return
    this.setAnswer.run(Date.now(), verdict, leftKey, last.rowid)
  }

  list(q: SuggestionQuery = {}): { items: SuggestionRow[]; nextCursor?: number; summary: SuggestionSummary } {
    const rows = (this.all.all() as Row[]).map((r) => ({ rowid: r.rowid, row: fromRow(r) }))
    // **汇总永远统计全表，不受筛选与分页影响**：一个跟着当前页变的一致率，读的人会当成总体。
    const summary = summarize(rows.map((r) => r.row))
    const limit = Math.min(Math.max(1, q.limit ?? DEFAULT_LIMIT), MAX_LIMIT)
    const filtered = rows.filter(({ rowid, row }) => {
      if (q.cursor != null && rowid >= q.cursor) return false
      if (q.state === 'open' && row.answeredAt != null) return false
      if (q.state === 'answered' && row.answeredAt == null) return false
      if (q.agreement) {
        if (!countableKind(row)) return false
        const a = agreementOf(row)
        const bucket = a ?? (row.humanVerdict ? 'inconclusive' : null)
        if (bucket !== q.agreement) return false
      }
      return true
    })
    const page = filtered.slice(0, limit)
    return {
      items: page.map((p) => p.row),
      ...(filtered.length > limit ? { nextCursor: page[page.length - 1]!.rowid } : {}),
      summary,
    }
  }
}
