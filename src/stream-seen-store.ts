import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

/**
 * Per-stream read watermark — "which ItemStore seq has the viewer seen for this stream".
 * Channel-agnostic: any view can ask a stream's unread state. First consumer is the video
 * channel's 正在追的 section (new-episode badge). Single-user per instance (like the rest of
 * the user db), so there is no user key.
 */
export class StreamSeenStore {
  private db: Database.Database
  private getStmt: Database.Statement
  private setStmt: Database.Statement

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stream_seen (
        stream_id TEXT PRIMARY KEY,
        seen_seq  INTEGER NOT NULL
      );
    `)
    this.getStmt = this.db.prepare('SELECT seen_seq FROM stream_seen WHERE stream_id = ?')
    // watermark only advances — max() guards against a stale/lower mark racing a higher one
    this.setStmt = this.db.prepare(`
      INSERT INTO stream_seen (stream_id, seen_seq) VALUES (?, ?)
      ON CONFLICT(stream_id) DO UPDATE SET seen_seq = max(seen_seq, excluded.seen_seq)
    `)
  }

  seenSeq(streamId: string): number | undefined {
    const row = this.getStmt.get(streamId) as { seen_seq: number } | undefined
    return row?.seen_seq
  }

  /** Advance the watermark to `seq` (no-op if already ahead). Returns the resulting watermark. */
  markSeen(streamId: string, seq: number): number {
    this.setStmt.run(streamId, seq)
    return this.seenSeq(streamId) ?? seq
  }

  close(): void {
    this.db.close()
  }
}
