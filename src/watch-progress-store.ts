import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

export interface WatchProgressRow {
  key: string
  workKey: string
  workTitle: string
  workPoster?: string
  epLabel?: string
  /** 这一条进度属于哪个视频频道 —— 「继续观看」墙按频道分栏的唯一依据。频道的全部意义就是把
   *  内容分开（儿童频道不该出现大人正在追的剧），而作品本身推不出频道：一个 tmdb 收藏根本没有
   *  Stream，一个 Stream 也可以同时挂在两个频道下。所以归属只能在**播放发生的那一刻**由前端
   *  记下"当时人在哪一屏"。缺省 = 归属未知（此列上线前写的老行），读取侧决定它算谁的。 */
  channelId?: string
  position: number
  duration: number
  updatedAt: number
}

/**
 * 「看完」的唯一定义。剩余秒数 OR 百分比:
 * - `position > 0` 守卫极短片(duration<30 时 remaining 从一开始就 <30,没守卫会把"根本没播放过"
 *   的短片在 position=0 时就误判成看完)。
 * - 剩余秒数 < 30s → 看完(不管片子多长)。
 * - 百分比门槛设 0.98 而非 0.95:2 小时电影 95% 时还剩 6 分钟(片尾曲之外还有正片),0.95 会把它
 *   过早移出「继续观看」;0.98 对应约 2.4 分钟剩余,基本落在片尾曲区间。50 分钟以下的内容由
 *   remaining<30 主导,0.98 只在长片场景生效。
 */
export function isFinished(position: number, duration: number): boolean {
  if (duration <= 0 || position <= 0) return false
  const remaining = duration - position
  return remaining < 30 || position / duration > 0.98
}

interface WatchProgressRowSql {
  key: string
  work_key: string
  work_title: string
  work_poster: string | null
  ep_label: string | null
  channel_id: string | null
  position: number
  duration: number
  updated_at: number
}

function fromSql(r: WatchProgressRowSql): WatchProgressRow {
  return {
    key: r.key,
    workKey: r.work_key,
    workTitle: r.work_title,
    workPoster: r.work_poster ?? undefined,
    epLabel: r.ep_label ?? undefined,
    channelId: r.channel_id ?? undefined,
    position: r.position,
    duration: r.duration,
    updatedAt: r.updated_at,
  }
}

/**
 * Server-side video watch progress — moves 「继续观看」 state out of browser localStorage so it
 * survives cache clears and syncs across desktop/web. Display metadata (title/poster/episode
 * label) is stored WITH the progress on purpose: the shelf must render works the user hasn't
 * followed or collected, so there is nothing else to look the metadata up from. Single-user
 * per instance (like the rest of the user db), so there is no user key.
 */
export class WatchProgressStore {
  private db: Database.Database
  private putStmt: Database.Statement
  private getStmt: Database.Statement
  private inProgressStmt: Database.Statement
  private removeStmt: Database.Statement

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watch_progress (
        key         TEXT PRIMARY KEY,
        work_key    TEXT NOT NULL,
        work_title  TEXT NOT NULL,
        work_poster TEXT,
        ep_label    TEXT,
        position    REAL NOT NULL,
        duration    REAL NOT NULL,
        updated_at  INTEGER NOT NULL
      );
    `)
    // 已存在的库不会被上面的 CREATE TABLE IF NOT EXISTS 补列（同 SearchRunStore 的 hubs），
    // 少了它 put 会直接抛。
    const cols = new Set((this.db.prepare('PRAGMA table_info(watch_progress)').all() as { name: string }[]).map((c) => c.name))
    if (!cols.has('channel_id')) this.db.exec('ALTER TABLE watch_progress ADD COLUMN channel_id TEXT')
    this.putStmt = this.db.prepare(`
      INSERT INTO watch_progress (key, work_key, work_title, work_poster, ep_label, channel_id, position, duration, updated_at)
      VALUES (@key, @work_key, @work_title, @work_poster, @ep_label, @channel_id, @position, @duration, @updated_at)
      ON CONFLICT(key) DO UPDATE SET
        work_key = excluded.work_key,
        work_title = excluded.work_title,
        work_poster = excluded.work_poster,
        ep_label = excluded.ep_label,
        -- 归属只增不抹：老客户端(或不知道自己在哪一屏的调用点)不传 channel_id 时，别把已经记下
        -- 的归属清成 NULL——那会让一条已经分好类的进度在下一次心跳后掉回"未知"。
        channel_id = COALESCE(excluded.channel_id, watch_progress.channel_id),
        position = excluded.position,
        duration = excluded.duration,
        updated_at = excluded.updated_at
    `)
    this.getStmt = this.db.prepare('SELECT * FROM watch_progress WHERE key = ?')
    // 只负责「新→旧」这一件事。「看完」的定义(isFinished)、每个 work 只留一条、频道归属，全部在
    // JS 里按顺序做——**筛频道必须发生在按 work 去重之前**，否则一个在两个频道里都播过的作品会被
    // 全局最新的那一条代表，另一个频道的进度整条消失。原来那句 SQL 窗口(MAX(updated_at) per
    // work_key)没法表达"先按频道切分再取最新"，与其把条件塞进 SQL，不如让这张小表(一集一行)
    // 整份出来在 JS 里排——顺序在一处看得见，就不会有第二处再判一次。
    this.inProgressStmt = this.db.prepare('SELECT * FROM watch_progress ORDER BY updated_at DESC, rowid DESC')
    this.removeStmt = this.db.prepare('DELETE FROM watch_progress WHERE key = ?')
  }

  /** `at` is an optional explicit timestamp — only tests should pass it (Date.now() can repeat within a ms). */
  put(row: Omit<WatchProgressRow, 'updatedAt'>, at?: number): WatchProgressRow {
    const updatedAt = at ?? Date.now()
    this.putStmt.run({
      key: row.key,
      work_key: row.workKey,
      work_title: row.workTitle,
      work_poster: row.workPoster ?? null,
      ep_label: row.epLabel ?? null,
      channel_id: row.channelId ?? null,
      position: row.position,
      duration: row.duration,
      updated_at: updatedAt,
    })
    return { ...row, updatedAt }
  }

  get(key: string): WatchProgressRow | null {
    const r = this.getStmt.get(key) as WatchProgressRowSql | undefined
    return r ? fromSql(r) : null
  }

  /**
   * 「继续观看」:排除已看完、每个 workKey 只留最近一条、updatedAt 新→旧。
   *
   * `channels` 给定时只留归属于其中之一的行——这是频道分栏的落点。`unattributed` 单独一格而不是
   * 混进 `channels`:归属未知(此列上线前写的老行)不是一个频道 id,它算谁的是**读取侧的政策**,
   * 由调用方明说，store 不替它猜。
   *
   * 两条顺序是硬的:筛频道在按 work 去重**之前**(否则跨频道播过的作品会在一个频道里凭空消失),
   * 截断(limit)在最后(否则同一个作品的多集会挤掉别的作品)。
   */
  inProgress(opts: { limit?: number; channels?: string[]; unattributed?: boolean } = {}): WatchProgressRow[] {
    const wanted = opts.channels ? new Set(opts.channels) : null
    const seen = new Set<string>()
    const rows = (this.inProgressStmt.all() as WatchProgressRowSql[])
      .map(fromSql)
      .filter((r) => !wanted || (r.channelId ? wanted.has(r.channelId) : opts.unattributed === true))
      .filter((r) => !isFinished(r.position, r.duration))
      .filter((r) => (seen.has(r.workKey) ? false : (seen.add(r.workKey), true)))
    return opts.limit != null ? rows.slice(0, opts.limit) : rows
  }

  remove(key: string): boolean {
    return this.removeStmt.run(key).changes > 0
  }

  close(): void {
    this.db.close()
  }
}
