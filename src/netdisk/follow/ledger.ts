import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { ShareRow, FollowRunRecord } from './types.ts'

export class ShareLedger {
  private readonly up: Database.Statement
  private readonly byId: Database.Statement
  private readonly byKey: Database.Statement
  constructor(db: Database.Database) {
    this.up = db.prepare(`INSERT OR REPLACE INTO binding_shares
      (set_id, netdisk, pwd_id, passcode, origin, added_at, last_check, validity, seen_files, saved_fids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    // 次级键 rowid：同一轮里落的分享 added_at 一模一样，只按 added_at 排序时平局顺序无人保证。
    this.byId = db.prepare('SELECT * FROM binding_shares WHERE set_id = ? ORDER BY added_at, rowid')
    this.byKey = db.prepare('SELECT * FROM binding_shares WHERE set_id = ? AND netdisk = ? AND pwd_id = ?')
  }
  private row(r: Record<string, unknown>): ShareRow {
    return {
      setId: String(r.set_id), netdisk: String(r.netdisk), pwdId: String(r.pwd_id),
      ...(r.passcode ? { passcode: String(r.passcode) } : {}),
      origin: r.origin as ShareRow['origin'], addedAt: String(r.added_at),
      ...(r.last_check ? { lastCheck: String(r.last_check) } : {}),
      ...(r.validity ? { validity: r.validity as ShareRow['validity'] } : {}),
      seenFiles: JSON.parse(String(r.seen_files)), savedFids: JSON.parse(String(r.saved_fids)),
    }
  }
  list(setId: string): ShareRow[] { return (this.byId.all(setId) as Record<string, unknown>[]).map((r) => this.row(r)) }
  get(setId: string, netdisk: string, pwdId: string): ShareRow | undefined {
    const r = this.byKey.get(setId, netdisk, pwdId) as Record<string, unknown> | undefined
    return r ? this.row(r) : undefined
  }
  upsert(row: ShareRow): void {
    this.up.run(row.setId, row.netdisk, row.pwdId, row.passcode ?? null, row.origin, row.addedAt,
      row.lastCheck ?? null, row.validity ?? null, JSON.stringify(row.seenFiles), JSON.stringify(row.savedFids))
  }
}

export class FollowRunLedger {
  private readonly ins: Database.Statement
  private readonly sel: Database.Statement
  constructor(db: Database.Database) {
    this.ins = db.prepare('INSERT INTO follow_runs (id, set_id, at, json) VALUES (?, ?, ?, ?)')
    this.sel = db.prepare('SELECT json FROM follow_runs WHERE set_id = ? ORDER BY at DESC LIMIT ?')
  }
  append(rec: Omit<FollowRunRecord, 'id'>): FollowRunRecord {
    const full: FollowRunRecord = { id: `fr_${randomUUID().slice(0, 8)}`, ...rec }
    this.ins.run(full.id, full.setId, full.at, JSON.stringify(full))
    return full
  }
  recent(setId: string, limit = 10): FollowRunRecord[] {
    return (this.sel.all(setId, limit) as { json: string }[]).map((r) => JSON.parse(r.json) as FollowRunRecord)
  }
}
