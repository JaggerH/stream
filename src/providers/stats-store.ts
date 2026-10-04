import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** data/cache.db — 统计与诊断存储（ARCHITECTURE.md 两文件模型的缓存/可再生诊断侧）。
 *  WAL + prepared statements，照 user-store.ts 的既有范式。 */

export interface CallStats {
  total: number
  byMember: Record<string, number>
  lastCalledAt: string | null
}

export class ProviderStatsStore {
  private db: Database.Database
  private readonly now: () => string
  private writesEnabled = true

  constructor(dbPath: string, now?: () => string) {
    this.now = now ?? (() => new Date().toISOString())
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_calls (
        provider TEXT NOT NULL,
        member TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        last_called_at TEXT NOT NULL,
        PRIMARY KEY (provider, member)
      )
    `)
  }

  /** Neutralize every future record() on THIS instance in place — used by disk-service to
   *  guarantee a disk-mode stdio process can never write provider_calls into cache.db, while
   *  content_search/video_search (and resolve_target, which counts through the same store via
   *  ResolveEngine's providerRows.count) keep serving live reads (D4/D6: the disk-only process
   *  must never write the data dir). A mutate-in-place flag, not an object swap, because
   *  ProviderExecutor and ResolveEngine both capture this exact store by reference at
   *  construction time — disabling it here neutralizes every invoke()/resolve() call that
   *  reaches it, with no extra wiring at those call sites. */
  disableWrites(): void {
    this.writesEnabled = false
  }

  record(provider: string, member: string): void {
    if (!this.writesEnabled) return
    const nowStr = this.now()
    this.db.prepare(`
      INSERT INTO provider_calls (provider, member, count, last_called_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(provider, member) DO UPDATE SET
        count = count + 1,
        last_called_at = excluded.last_called_at
    `).run(provider, member, nowStr)
  }

  of(provider: string): CallStats {
    const rows = this.db.prepare(`
      SELECT member, count, last_called_at
      FROM provider_calls
      WHERE provider = ?
    `).all(provider) as { member: string; count: number; last_called_at: string }[]

    if (rows.length === 0) {
      return { total: 0, byMember: {}, lastCalledAt: null }
    }

    let total = 0
    const byMember: Record<string, number> = {}
    let lastCalledAt: string | null = null

    for (const row of rows) {
      total += row.count
      byMember[row.member] = row.count
      if (lastCalledAt === null || row.last_called_at > lastCalledAt) {
        lastCalledAt = row.last_called_at
      }
    }

    return { total, byMember, lastCalledAt }
  }

  all(): Record<string, CallStats> {
    const rows = this.db.prepare(`
      SELECT provider, member, count, last_called_at
      FROM provider_calls
    `).all() as { provider: string; member: string; count: number; last_called_at: string }[]

    const result: Record<string, CallStats> = {}

    for (const row of rows) {
      if (!result[row.provider]) {
        result[row.provider] = { total: 0, byMember: {}, lastCalledAt: null }
      }
      const stats = result[row.provider]
      stats.total += row.count
      stats.byMember[row.member] = row.count
      if (stats.lastCalledAt === null || row.last_called_at > stats.lastCalledAt) {
        stats.lastCalledAt = row.last_called_at
      }
    }

    return result
  }

  close(): void {
    this.db.close()
  }
}
