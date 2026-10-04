import type Database from 'better-sqlite3'
import { normalizeLandingDir } from '../save-binding.ts'

/**
 * 待认领分享的保质期。到点还没有哪条绑定来领，就是「用户压根没打算把这个落点建成绑定」——
 * 留着只会让这张表变成只增不减的垃圾。分享本身也早晚会死，领一条陈年分享没有任何价值。
 */
export const PENDING_SHARE_TTL_MS = 14 * 24 * 60 * 60 * 1000

export interface PendingShareRow {
  netdisk: string
  pwdId: string
  passcode?: string
  /** 转存实际落在 AList 上的绝对目录（`landingDirFor` 算出的那个）。认领判据就是它。 */
  dirPath: string
  savedAt: string
}

/**
 * 「转存成功了，但这一刻还没有绑定可挂」的分享暂存处（`binding_shares` 的候诊室）。
 *
 * 为什么需要它：转存和建绑定是**两次独立请求**——用户不带 `bind` 转完一条分享、过几天才
 * 把那个落点建成绑定，中间那点信息（链接 / pwd_id / 提取码）已经过手，追更循环从此看不见
 * 这条分享，同一部剧下次缺集还得把它重新搜一遍。
 *
 * 谁来领：`FollowService.claimPendingShares`——绑定的 `right.path` 命中 `dirPath` 就领走并落进
 * `binding_shares`。**两侧的目录都过 `normalizeLandingDir`**：口径分家的表现是这张表只涨、
 * 永远没人认领，而且不报错、没有一处会喊。
 */
export class PendingShareLedger {
  private readonly up: Database.Statement
  private readonly byDir: Database.Statement
  private readonly del: Database.Statement
  private readonly expire: Database.Statement
  private readonly all: Database.Statement
  constructor(db: Database.Database) {
    this.up = db.prepare(`INSERT OR REPLACE INTO pending_shares
      (netdisk, pwd_id, dir_path, passcode, saved_at) VALUES (?, ?, ?, ?, ?)`)
    this.byDir = db.prepare('SELECT * FROM pending_shares WHERE dir_path = ? ORDER BY saved_at, rowid')
    this.del = db.prepare('DELETE FROM pending_shares WHERE netdisk = ? AND pwd_id = ? AND dir_path = ?')
    this.expire = db.prepare('DELETE FROM pending_shares WHERE saved_at < ?')
    this.all = db.prepare('SELECT * FROM pending_shares ORDER BY saved_at, rowid')
  }

  private row(r: Record<string, unknown>): PendingShareRow {
    return {
      netdisk: String(r.netdisk), pwdId: String(r.pwd_id), dirPath: String(r.dir_path),
      ...(r.passcode ? { passcode: String(r.passcode) } : {}), savedAt: String(r.saved_at),
    }
  }

  /** 记一条（同一分享转进同一目录两次只留一行，后写的时间戳生效）。 */
  record(row: PendingShareRow): void {
    this.up.run(row.netdisk, row.pwdId, normalizeLandingDir(row.dirPath), row.passcode ?? null, row.savedAt)
  }

  /** 领走这个目录下的全部待认领分享（**取出即删**，认领是一次性的）。过期的顺手清掉，不返回。 */
  claim(dirPath: string, now: Date): PendingShareRow[] {
    this.prune(now)
    const dir = normalizeLandingDir(dirPath)
    const rows = (this.byDir.all(dir) as Record<string, unknown>[]).map((r) => this.row(r))
    for (const r of rows) this.del.run(r.netdisk, r.pwdId, r.dirPath)
    return rows
  }

  /** 过期行清场；返回删了几行。 */
  prune(now: Date): number {
    return this.expire.run(new Date(now.getTime() - PENDING_SHARE_TTL_MS).toISOString()).changes
  }

  /** 排查用：此刻还躺着哪些待认领分享。 */
  list(): PendingShareRow[] {
    return (this.all.all() as Record<string, unknown>[]).map((r) => this.row(r))
  }
}
