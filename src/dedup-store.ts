import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { adoptLegacyDb } from './store/import-legacy.ts'

/**
 * Persistent dedup store, keyed by StreamItem.id (deterministic hash).
 * SQLite for durability + crash safety + simple bootstrap. Lives in data/cache.db
 * (the regenerable side of the two-file model) alongside the items table.
 */
export class DedupStore {
  private db: Database.Database
  private hasStmt: Database.Statement<[string]>
  private addStmt: Database.Statement<[string, string, string]>
  private countForStreamStmt: Database.Statement<[string]>

  constructor(dbPath: string, legacyPath?: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen_items (
        id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_stream_seen ON seen_items(stream_id, seen_at);
    `)
    if (legacyPath && legacyPath !== dbPath) adoptLegacyDb(this.db, legacyPath, [{ from: 'seen_items', to: 'seen_items' }])
    this.hasStmt = this.db.prepare('SELECT 1 FROM seen_items WHERE id = ?')
    this.addStmt = this.db.prepare(
      'INSERT OR IGNORE INTO seen_items (id, stream_id, seen_at) VALUES (?, ?, ?)'
    )
    this.countForStreamStmt = this.db.prepare('SELECT COUNT(*) as c FROM seen_items WHERE stream_id = ?')
  }

  has(id: string): boolean {
    return this.hasStmt.get(id) !== undefined
  }

  add(id: string, streamId: string): void {
    this.addStmt.run(id, streamId, new Date().toISOString())
  }

  /** Batch-mark a harvest's new ids in ONE transaction — one commit/fsync instead of one per id
   *  (the per-item write is synchronous and, across a big harvest, stalls the event loop; see
   *  src/loop-lag.ts). Per-id errors are isolated so one bad row can't roll back the batch. */
  addMany(entries: { id: string; streamId: string }[]): void {
    if (entries.length === 0) return
    const now = new Date().toISOString()
    const run = this.db.transaction((rows: { id: string; streamId: string }[]) => {
      for (const e of rows) {
        try {
          this.addStmt.run(e.id, e.streamId, now)
        } catch (err) {
          console.error(`[dedup] add failed for ${e.id}:`, (err as Error).message)
        }
      }
    })
    run(entries)
  }

  countForStream(streamId: string): number {
    const row = this.countForStreamStmt.get(streamId) as { c: number }
    return row.c
  }

  /** Batch counterpart to `countForStream` — one `GROUP BY` query instead of N prepared-statement
   *  round-trips. Used by StreamService.status() so /api/status doesn't loop synchronously over
   *  every scheduled stream (see src/loop-lag.ts — this loop was a measured 350ms stall source).
   *  Missing stream_ids (zero seen items) are simply absent from the returned Map — callers must
   *  read via `map.get(id) ?? 0`. */
  countForStreams(streamIds: string[]): Map<string, number> {
    if (streamIds.length === 0) return new Map()
    const placeholders = streamIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT stream_id, COUNT(*) as c FROM seen_items WHERE stream_id IN (${placeholders}) GROUP BY stream_id`)
      .all(...streamIds) as Array<{ stream_id: string; c: number }>
    return new Map(rows.map((r) => [r.stream_id, r.c]))
  }

  close(): void {
    this.db.close()
  }
}
