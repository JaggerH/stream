import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import type { Evidence } from './fold.ts'
import type { IndexRow } from './inbox.ts'

/**
 * 归堆的账本：**一张指纹索引 + 一张归属表**。
 *
 * 两张表都是**纯附加**——删光它们，系统回到没有归堆的样子，一条内容都不丢
 * （不变量见 `docs/ARCHITECTURE.md` Invariants 第 5 条 "Folding never prevents insertion into storage"）。所以它落在 `cache.db`
 * 那一侧：可重建的东西，不进需要备份的那份。
 *
 * **为什么要自己的索引表**：找近邻要按「时长 + 时间窗」查。不抠成列，每来一条新 item
 * 就得把窗口内几千条的 JSON 全解一遍——那正是把归堆变成采集热路径上一笔重开销的做法。
 */

/** 一条 item 的归堆结果。`isRep` = 它是这堆的门面。 */
export interface FoldMembership {
  itemId: string
  groupId: string
  isRep: boolean
  why: Evidence[]
}

export class StoryFoldStore {
  private db: Database.Database

  /** 收路径或一个已经开着的库。**后者是给"老库补列"那条测试用的**——它要先造一张缺列的旧表。 */
  constructor(dbPath: string | Database.Database) {
    if (typeof dbPath === 'string') {
      if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
      this.db = new Database(dbPath)
    } else {
      this.db = dbPath
    }
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS story_index (
        item_id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        author TEXT,
        duration_s INTEGER,
        title_fold TEXT NOT NULL,
        title TEXT NOT NULL,
        url_key TEXT,
        ts TEXT NOT NULL,
        -- 内容身份：正文/转写的文本草图。**判据只看它**；上面那些只用来缩候选。
        -- NULL = 还没取到文本 = 判不了（不是"不像"）。
        text_sig TEXT,
        text_source TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_story_index_dur ON story_index(duration_s, ts);
      CREATE INDEX IF NOT EXISTS idx_story_index_url ON story_index(url_key);
      CREATE INDEX IF NOT EXISTS idx_story_index_ts ON story_index(ts);

      CREATE TABLE IF NOT EXISTS story_fold (
        item_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        is_rep INTEGER NOT NULL,
        why TEXT NOT NULL,
        decided_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_story_fold_group ON story_fold(group_id);

      -- 被人工拆开过的两条：**永不再并**。没有它，下一次采集会把用户刚拆的堆原样合回去。
      CREATE TABLE IF NOT EXISTS story_fold_veto (
        a TEXT NOT NULL,
        b TEXT NOT NULL,
        PRIMARY KEY (a, b)
      );

      -- 两个源之间并过多少次 = 它们是不是一对同质源。**攒出来的，不问用户**：
      -- 并过几次之后光凭时长就敢并（标题被平台改写得再多也不影响）。
      CREATE TABLE IF NOT EXISTS story_pair (
        a TEXT NOT NULL,
        b TEXT NOT NULL,
        folds INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (a, b)
      );

      -- 待判队列：入库那一跳只把 item 排进来，**判据在后台跑**（取文本可能要十几秒的转写，
      -- 挂在采集热路径上是不可接受的）。attempts 用来给"取不到文本"的条目封顶，
      -- 免得一条没有可转写媒体的 item 每轮都被重试。
      CREATE TABLE IF NOT EXISTS story_pending (
        item_id TEXT PRIMARY KEY,
        queued_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );

      -- 「谁先发」的账：一堆里首发的那个源记一次领先，并累计领先了多少秒。
      -- 这是「来源」在归堆之后唯一的作用——不参与判断，只回答"谁持续领先"。
      CREATE TABLE IF NOT EXISTS source_lead (
        stream_id TEXT NOT NULL,
        rival_id TEXT NOT NULL,
        leads INTEGER NOT NULL DEFAULT 0,
        behinds INTEGER NOT NULL DEFAULT 0,
        lead_seconds INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (stream_id, rival_id)
      );
    `)
    // **存量库补列。** 上面是 `CREATE TABLE IF NOT EXISTS`——已经存在的表不会跟着长出新列，
    // 于是新加的 `text_sig` 在老库里根本不存在，而 `neighbors` 的 SELECT 点名要它：
    // 每条都抛、每条都被 defer，队列只涨不落，**一条日志都不会有**（异常被 worker 逐条吞掉）。
    // 2026-08-13 活体就是这么卡住 100 条的。加一列就要在这里加一行。
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(story_index)').all() as Array<{ name: string }>).map((c) => c.name),
    )
    if (!cols.has('text_sig')) this.db.exec('ALTER TABLE story_index ADD COLUMN text_sig TEXT')
    if (!cols.has('text_source')) this.db.exec('ALTER TABLE story_index ADD COLUMN text_source TEXT')
  }

  /**
   * 记一条 item 的候选信号。重复调用幂等（重新采集同一条会覆盖）。
   *
   * **不动 text_sig**：文本是后台补的，重新采集一次不该把已经取到的文本抹掉
   * （那等于每轮采集都重新花一次转写的钱）。
   */
  index(row: IndexRow): void {
    this.db
      .prepare(
        `INSERT INTO story_index (item_id, stream_id, author, duration_s, title_fold, title, url_key, ts)
         VALUES (@itemId, @streamId, @author, @durationS, @titleFold, @title, @urlKey, @ts)
         ON CONFLICT(item_id) DO UPDATE SET
           stream_id=excluded.stream_id, author=excluded.author, duration_s=excluded.duration_s,
           title_fold=excluded.title_fold, title=excluded.title, url_key=excluded.url_key, ts=excluded.ts`,
      )
      .run({
        itemId: row.itemId, streamId: row.streamId, author: row.author ?? null,
        durationS: row.durationS ?? null, titleFold: row.titleFold, title: row.title,
        urlKey: row.urlKey ?? null, ts: row.ts,
      })
  }

  /** 记下这条的文本草图（内容身份）。 */
  setText(itemId: string, sig: number[], source: string): void {
    this.db
      .prepare('UPDATE story_index SET text_sig = ?, text_source = ? WHERE item_id = ?')
      .run(JSON.stringify(sig), source, itemId)
  }

  row(itemId: string): IndexRow | undefined {
    const r = this.db.prepare('SELECT * FROM story_index WHERE item_id = ?').get(itemId) as
      | Record<string, unknown>
      | undefined
    return r ? toIndexRow(r) : undefined
  }

  // —— 待判队列 ——

  /** 排进待判。已在队列里就不动（不重置 attempts）。 */
  enqueue(itemId: string, now = new Date().toISOString()): void {
    this.db
      .prepare('INSERT OR IGNORE INTO story_pending (item_id, queued_at) VALUES (?, ?)')
      .run(itemId, now)
  }

  /** 取一批待判的（最多 limit 条）。 */
  pending(limit: number, maxAttempts: number): Array<{ itemId: string; attempts: number }> {
    const rows = this.db
      .prepare('SELECT item_id, attempts FROM story_pending WHERE attempts < ? ORDER BY queued_at LIMIT ?')
      .all(maxAttempts, limit) as Array<{ item_id: string; attempts: number }>
    return rows.map((r) => ({ itemId: r.item_id, attempts: r.attempts }))
  }

  /** 判完了（不管并没并）——出队。 */
  settle(itemId: string): void {
    this.db.prepare('DELETE FROM story_pending WHERE item_id = ?').run(itemId)
  }

  /** 这次没判成（文本还没到位）——记一次尝试，留在队列里等下一轮。 */
  defer(itemId: string): void {
    this.db.prepare('UPDATE story_pending SET attempts = attempts + 1 WHERE item_id = ?').run(itemId)
  }

  pendingCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM story_pending').get() as { c: number }).c
  }

  /**
   * 值得和这条比一比的近邻。**这里只做"缩范围"，一个结论都不下**——下结论的是文本
   * （`sameStoryInbox`），这里只保证真正的同源条目不会在这一步就被漏掉。
   *
   * 三条并集，覆盖三种拿得到的线索：
   * - **链接相同**：硬的，一步到位。
   * - **时长接近**：音视频专用，按索引查，几千条里通常返回个位数。
   * - **发布时间接近**（默认 ±2 天）：**纯文字内容唯一的入口**。同一条内容被转载几乎必然
   *   在同一两天内出现；没有这一条，没有时长也没有同链接的新闻/帖子就永远进不了候选。
   *
   * 时间那条会捞进不少无关条目，靠 `worthChecking` 的标题闸门筛掉——那是纯内存的字符串
   * 比对，便宜；而漏掉一对的代价是它永远不会被再看一眼。
   */
  neighbors(row: IndexRow, windowDays: number, tolS: number, limit = 50, nearDays = 2): IndexRow[] {
    const at = Date.parse(row.ts)
    const since = new Date(at - windowDays * 86400_000).toISOString()
    const nearFrom = new Date(at - nearDays * 86400_000).toISOString()
    const nearTo = new Date(at + nearDays * 86400_000).toISOString()
    const rows = this.db
      .prepare(
        `SELECT item_id, stream_id, author, duration_s, title_fold, title, url_key, ts, text_sig, text_source
           FROM story_index
          WHERE item_id != @itemId AND stream_id != @streamId AND ts >= @since
            AND ( (@durationS IS NOT NULL AND duration_s BETWEEN @lo AND @hi)
                  OR (@urlKey IS NOT NULL AND url_key = @urlKey)
                  OR (ts BETWEEN @nearFrom AND @nearTo) )
          ORDER BY ts DESC LIMIT @limit`,
      )
      .all({
        itemId: row.itemId, streamId: row.streamId, since, nearFrom, nearTo,
        durationS: row.durationS ?? null, lo: (row.durationS ?? 0) - tolS, hi: (row.durationS ?? 0) + tolS,
        urlKey: row.urlKey ?? null, limit,
      }) as Array<Record<string, unknown>>
    return rows.map(toIndexRow)
  }

  /** 这条 item 的归堆结果（没归过 → undefined）。 */
  membership(itemId: string): FoldMembership | undefined {
    const r = this.db.prepare('SELECT * FROM story_fold WHERE item_id = ?').get(itemId) as
      | Record<string, unknown>
      | undefined
    return r ? toMembership(r) : undefined
  }

  /** 批量取——投影层一次拿一屏，**不逐条查**。 */
  membershipsFor(itemIds: string[]): Map<string, FoldMembership> {
    const out = new Map<string, FoldMembership>()
    if (itemIds.length === 0) return out
    const CHUNK = 400
    for (let i = 0; i < itemIds.length; i += CHUNK) {
      const slice = itemIds.slice(i, i + CHUNK)
      const rows = this.db
        .prepare(`SELECT * FROM story_fold WHERE item_id IN (${slice.map(() => '?').join(',')})`)
        .all(...slice) as Array<Record<string, unknown>>
      for (const r of rows) out.set(r.item_id as string, toMembership(r))
    }
    return out
  }

  /** 每个堆有几条。投影层要拿它显示「另有 N 条」，**一次问清全部**，不逐堆查。 */
  sizes(groupIds: string[]): Map<string, number> {
    const out = new Map<string, number>()
    if (groupIds.length === 0) return out
    const uniq = [...new Set(groupIds)]
    const CHUNK = 400
    for (let i = 0; i < uniq.length; i += CHUNK) {
      const slice = uniq.slice(i, i + CHUNK)
      const rows = this.db
        .prepare(
          `SELECT group_id, COUNT(*) as n FROM story_fold
            WHERE group_id IN (${slice.map(() => '?').join(',')}) GROUP BY group_id`,
        )
        .all(...slice) as Array<{ group_id: string; n: number }>
      for (const r of rows) out.set(r.group_id, r.n)
    }
    return out
  }

  /** 一个堆里的全部成员（代表在前）。 */
  group(groupId: string): FoldMembership[] {
    const rows = this.db
      .prepare('SELECT * FROM story_fold WHERE group_id = ? ORDER BY is_rep DESC, item_id')
      .all(groupId) as Array<Record<string, unknown>>
    return rows.map(toMembership)
  }

  /**
   * 把 `itemId` 并进 `intoItemId` 所在的堆。
   *
   * **代表 = 发布时间最早的那条**，每次并完重算一遍。不是"我先采到的那条"——那只反映
   * 我的采集顺序（谁的 cadence 短谁就先被采到），和"谁先发的"没关系。既然这条线要回答
   * 「哪个源持续领先」，门面就该是真正的首发。时间取自 `story_index.ts`；并列时
   * 用 item_id 兜底，保证结果稳定（否则每次采集门面都可能换一个，列表看着在抖）。
   */
  join(itemId: string, intoItemId: string, why: Evidence[], now = new Date().toISOString()): string {
    const existing = this.membership(intoItemId)
    const groupId = existing?.groupId ?? intoItemId
    const tx = this.db.transaction(() => {
      if (!existing) {
        this.db
          .prepare('INSERT OR IGNORE INTO story_fold (item_id, group_id, is_rep, why, decided_at) VALUES (?,?,0,?,?)')
          .run(intoItemId, groupId, '[]', now)
      }
      this.db
        .prepare(
          `INSERT INTO story_fold (item_id, group_id, is_rep, why, decided_at) VALUES (?,?,0,?,?)
           ON CONFLICT(item_id) DO UPDATE SET group_id=excluded.group_id, why=excluded.why, decided_at=excluded.decided_at`,
        )
        .run(itemId, groupId, JSON.stringify(why), now)
      this.reelectRep(groupId)
    })
    tx()
    return groupId
  }

  /** 让发布最早的那条当门面。并入、拆堆之后都要重算——堆变了，首发可能就换人了。 */
  private reelectRep(groupId: string): void {
    const first = this.db
      .prepare(
        `SELECT sf.item_id FROM story_fold sf
           LEFT JOIN story_index si ON si.item_id = sf.item_id
          WHERE sf.group_id = ?
          ORDER BY COALESCE(si.ts, '9999') ASC, sf.item_id ASC LIMIT 1`,
      )
      .get(groupId) as { item_id: string } | undefined
    if (!first) return
    this.db
      .prepare('UPDATE story_fold SET is_rep = CASE WHEN item_id = ? THEN 1 ELSE 0 END WHERE group_id = ?')
      .run(first.item_id, groupId)
  }

  /**
   * 人工拆堆：把这条从堆里摘出来，并**记下它和原代表永不再并**。
   *
   * 只删归属不记否决是个陷阱——下一次采集会照原判据把它合回去，用户会发现自己白拆了。
   */
  unfold(itemId: string): void {
    const m = this.membership(itemId)
    if (!m) return
    const rep = this.group(m.groupId).find((x) => x.isRep)
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM story_fold WHERE item_id = ?').run(itemId)
      if (rep) {
        const [a, b] = [itemId, rep.itemId].sort()
        this.db.prepare('INSERT OR IGNORE INTO story_fold_veto (a, b) VALUES (?, ?)').run(a, b)
      }
      // 堆里只剩一条 → 它自己也没必要再是一个堆。
      const left = this.group(m.groupId)
      if (left.length <= 1) this.db.prepare('DELETE FROM story_fold WHERE group_id = ?').run(m.groupId)
      else this.reelectRep(m.groupId) // 拆掉的正好是门面时，首发要顺位给下一个
    })
    tx()
  }

  /**
   * 这两个源之间已经并过几次。到了门槛就认它们是一对同质源——**观察攒出来的，不问用户**。
   */
  pairFolds(a: string, b: string): number {
    const [x, y] = [a, b].sort()
    const r = this.db.prepare('SELECT folds FROM story_pair WHERE a = ? AND b = ?').get(x, y) as
      | { folds: number }
      | undefined
    return r?.folds ?? 0
  }

  /**
   * 记一次「这两个源又发了同一条内容」：源对计数 +1，并按发布时间记一笔谁领先。
   *
   * **并列不硬分先后**：两边同一秒发出来就只记源对、不记领先——判谁快是编造精度。
   */
  recordPair(
    a: { streamId: string; ts: string },
    b: { streamId: string; ts: string },
  ): void {
    const [x, y] = [a.streamId, b.streamId].sort()
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO story_pair (a, b, folds) VALUES (?, ?, 1)
           ON CONFLICT(a, b) DO UPDATE SET folds = folds + 1`,
        )
        .run(x, y)
      const ta = Date.parse(a.ts)
      const tb = Date.parse(b.ts)
      if (!Number.isFinite(ta) || !Number.isFinite(tb) || ta === tb) return
      const [first, second] = ta < tb ? [a, b] : [b, a]
      const gapS = Math.round(Math.abs(ta - tb) / 1000)
      this.bump(first.streamId, second.streamId, 1, 0, gapS)
      this.bump(second.streamId, first.streamId, 0, 1, 0)
    })
    tx()
  }

  private bump(streamId: string, rivalId: string, leads: number, behinds: number, gapS: number): void {
    this.db
      .prepare(
        `INSERT INTO source_lead (stream_id, rival_id, leads, behinds, lead_seconds) VALUES (?,?,?,?,?)
         ON CONFLICT(stream_id, rival_id) DO UPDATE SET
           leads = leads + excluded.leads,
           behinds = behinds + excluded.behinds,
           lead_seconds = lead_seconds + excluded.lead_seconds`,
      )
      .run(streamId, rivalId, leads, behinds, gapS)
  }

  /**
   * 「谁在同质内容上持续领先」——按源汇总。`avgLeadS` 只除以领先的那些次
   * （落后那几次的领先秒数是 0，一起平均会把数字稀释成看不懂的东西）。
   */
  leaderboard(): Array<{ streamId: string; leads: number; behinds: number; avgLeadS: number; rivals: number }> {
    const rows = this.db
      .prepare(
        `SELECT stream_id, SUM(leads) as leads, SUM(behinds) as behinds,
                SUM(lead_seconds) as secs, COUNT(*) as rivals
           FROM source_lead GROUP BY stream_id`,
      )
      .all() as Array<{ stream_id: string; leads: number; behinds: number; secs: number; rivals: number }>
    return rows
      .map((r) => ({
        streamId: r.stream_id,
        leads: r.leads,
        behinds: r.behinds,
        avgLeadS: r.leads > 0 ? Math.round(r.secs / r.leads) : 0,
        rivals: r.rivals,
      }))
      .sort((p, q) => q.leads - p.leads || p.behinds - q.behinds)
  }

  /** 这两条是不是被人工拆开过。 */
  vetoed(a: string, b: string): boolean {
    const [x, y] = [a, b].sort()
    return this.db.prepare('SELECT 1 FROM story_fold_veto WHERE a = ? AND b = ?').get(x, y) !== undefined
  }

  close(): void {
    this.db.close()
  }
}

function toIndexRow(r: Record<string, unknown>): IndexRow {
  const sig = r.text_sig as string | null
  return {
    itemId: r.item_id as string,
    streamId: r.stream_id as string,
    author: (r.author as string) ?? undefined,
    durationS: (r.duration_s as number) ?? undefined,
    titleFold: r.title_fold as string,
    title: r.title as string,
    urlKey: (r.url_key as string) ?? undefined,
    ts: r.ts as string,
    textSig: sig ? (JSON.parse(sig) as number[]) : undefined,
    textSource: (r.text_source as string) ?? undefined,
  }
}

function toMembership(r: Record<string, unknown>): FoldMembership {
  return {
    itemId: r.item_id as string,
    groupId: r.group_id as string,
    isRep: (r.is_rep as number) === 1,
    why: JSON.parse((r.why as string) || '[]') as Evidence[],
  }
}
