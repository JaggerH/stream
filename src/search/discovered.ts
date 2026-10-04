import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { adoptLegacyDb } from '../store/import-legacy.ts'

export interface DiscoveredChannel {
  channel: string
  count: number
  first_seen: string
}

/**
 * The "discovered pool" — Telegram channels seen in a meta-source's search results
 * (pansou tags each hit with its `channel`). Accreting these makes a black-box
 * meta-source legible: a user can list what's actually out there and one-click a
 * channel into its own flow. Keyed by (source_id, channel); count tracks frequency.
 */
export class DiscoveredChannels {
  private db: Database.Database
  private writesEnabled = true

  constructor(dbPath: string, legacyPath?: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS discovered_channel (
        source_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        first_seen TEXT NOT NULL,
        PRIMARY KEY (source_id, channel)
      );
    `)
    if (legacyPath) adoptLegacyDb(this.db, legacyPath, [{ from: 'discovered_channel', to: 'discovered_channel' }])
  }

  /** Neutralize every future record() on THIS instance in place — used by disk-service to
   *  guarantee a disk-mode stdio process can never write discovered_channel into discovered.db,
   *  while video_search (facetOneSource's recordChannels callback, which closes over this exact
   *  instance in bootstrap.ts) keeps serving live reads (D4/D6: the disk-only process must never
   *  write the data dir). A mutate-in-place flag, not an object swap, because bootstrap.ts's
   *  searchOneGroup/facetResources closures capture this instance directly (not through a
   *  reassignable field) — disabling it here neutralizes both call sites with no extra wiring. */
  disableWrites(): void {
    this.writesEnabled = false
  }

  /** Record channels observed in one source's results (dedups within the batch;
   *  increments per occurrence across calls). Blank channels are ignored. */
  record(sourceId: string, channels: string[], now = new Date().toISOString()): void {
    if (!this.writesEnabled) return
    const stmt = this.db.prepare(
      `INSERT INTO discovered_channel (source_id, channel, count, first_seen)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(source_id, channel) DO UPDATE SET count = count + 1`
    )
    const seen = new Set<string>()
    const tx = this.db.transaction((list: string[]) => {
      for (const ch of list) {
        const c = ch.trim()
        if (!c || seen.has(c)) continue
        seen.add(c)
        stmt.run(sourceId, c, now)
      }
    })
    tx(channels)
  }

  /** Discovered channels for a source, most-frequent first. */
  list(sourceId: string): DiscoveredChannel[] {
    return this.db
      .prepare('SELECT channel, count, first_seen FROM discovered_channel WHERE source_id = ? ORDER BY count DESC, channel')
      .all(sourceId) as DiscoveredChannel[]
  }

  close(): void {
    this.db.close()
  }
}
