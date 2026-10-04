import type DatabaseType from 'better-sqlite3'

export interface OutboxEvent {
  /** 事件键；幂等靠它（闲鱼＝order_id，测试源自造）。 */
  id: string
  source: string
  receivedAt: number
  /** JSON 字符串，原样透传给下游，本层不解释。 */
  payload: string
}

export class Outbox {
  private db: DatabaseType.Database
  constructor(dbPath: string, DatabaseCtor: typeof DatabaseType) {
    this.db = new DatabaseCtor(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS outbox (
           id TEXT PRIMARY KEY,
           source TEXT NOT NULL,
           received_at INTEGER NOT NULL,
           payload TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'pending',
           done_at INTEGER
         )`,
      )
      .run()
  }

  /** 收到即落盘。重复 id（同单重推）忽略——幂等第一道闸。返回是否新插入。 */
  append(e: OutboxEvent): boolean {
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO outbox (id, source, received_at, payload) VALUES (?,?,?,?)`)
      .run(e.id, e.source, e.receivedAt, e.payload)
    return r.changes > 0
  }

  /** 按到达顺序取未 ack 的。 */
  pending(limit = 100): OutboxEvent[] {
    return this.db
      .prepare(
        `SELECT id, source, received_at AS receivedAt, payload FROM outbox
         WHERE status='pending' ORDER BY received_at ASC LIMIT ?`,
      )
      .all(limit) as OutboxEvent[]
  }

  /** 主进程 ack 后标 done。 */
  ackDone(ids: string[], now: number): void {
    const stmt = this.db.prepare(`UPDATE outbox SET status='done', done_at=? WHERE id=?`)
    const tx = this.db.transaction((xs: string[]) => {
      for (const id of xs) stmt.run(now, id)
    })
    tx(ids)
  }

  /** done 行留短 TTL 供排查，过期清。返回清掉几行。 */
  prune(olderThan: number): number {
    return this.db.prepare(`DELETE FROM outbox WHERE status='done' AND done_at < ?`).run(olderThan).changes
  }

  close(): void {
    this.db.close()
  }
}
