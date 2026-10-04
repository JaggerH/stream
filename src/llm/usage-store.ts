import type { DatabaseSync } from 'node:sqlite'

/** cache.db — LLM 用量账本（可再生诊断侧，照 src/providers/stats-store.ts 的建表模式）。
 *  四类 kind 分开计：metered（provider 报了 usage，token 数可信）/
 *  usage_unreported（provider 没报 usage，花没花钱不知道）/
 *  streamed_unmetered（流式路径压根拿不到 usage）/
 *  rejected_unmetered（升级重试里被 validate 否决的那一轮——member 答过、但结果不算数，
 *  没有花没花钱的意义，token 列恒 null）——
 *  三个 un* 计数必须各自可见，"没花钱""没计到""被否决"不能混成一个数字。 */

export type LlmUsageKind = 'metered' | 'usage_unreported' | 'streamed_unmetered' | 'rejected_unmetered'

export interface LlmUsageEvent {
  callsiteId: string
  member: string | null
  promptTokens: number | null
  completionTokens: number | null
  kind: LlmUsageKind
}

export interface LlmUsageAggregateRow {
  callsiteId: string
  day: string
  calls: number
  promptTokens: number
  completionTokens: number
  usageUnreported: number
  streamedUnmetered: number
  rejectedUnmetered: number
}

export class LlmUsageStore {
  private db: DatabaseSync
  private readonly now: () => number

  constructor(db: DatabaseSync, now?: () => number) {
    this.db = db
    this.now = now ?? (() => Date.now())
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS llm_usage (
        at INTEGER NOT NULL,
        callsite TEXT NOT NULL,
        member TEXT,
        kind TEXT NOT NULL,
        prompt_tokens INTEGER,
        completion_tokens INTEGER
      )
    `)
  }

  record(e: LlmUsageEvent): void {
    this.db.prepare(`
      INSERT INTO llm_usage (at, callsite, member, kind, prompt_tokens, completion_tokens)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(this.now(), e.callsiteId, e.member, e.kind, e.promptTokens, e.completionTokens)
  }

  aggregate(): LlmUsageAggregateRow[] {
    const rows = this.db.prepare(`
      SELECT
        callsite,
        date(at / 1000, 'unixepoch') AS day,
        COUNT(*) AS calls,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(CASE WHEN kind = 'usage_unreported' THEN 1 ELSE 0 END), 0) AS usage_unreported,
        COALESCE(SUM(CASE WHEN kind = 'streamed_unmetered' THEN 1 ELSE 0 END), 0) AS streamed_unmetered,
        COALESCE(SUM(CASE WHEN kind = 'rejected_unmetered' THEN 1 ELSE 0 END), 0) AS rejected_unmetered
      FROM llm_usage
      GROUP BY callsite, day
      ORDER BY day, callsite
    `).all() as {
      callsite: string
      day: string
      calls: number
      prompt_tokens: number
      completion_tokens: number
      usage_unreported: number
      streamed_unmetered: number
      rejected_unmetered: number
    }[]

    return rows.map((r) => ({
      callsiteId: r.callsite,
      day: r.day,
      calls: r.calls,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      usageUnreported: r.usage_unreported,
      streamedUnmetered: r.streamed_unmetered,
      rejectedUnmetered: r.rejected_unmetered,
    }))
  }

  close(): void {
    this.db.close()
  }
}
