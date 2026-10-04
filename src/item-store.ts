import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import type { StreamItem } from './types.ts'
import type { SourceType } from './manifest/types.ts'

/**
 * **存储形状**：库里到底存了什么。`__shape` 是纯类型品牌（没有运行时字段，也永远不必赋值——
 * 它是可选的，所有构造点原样通过），唯一作用是给「存储」与「播放投影」之间划一道**单向**闸门：
 * 存储形状可以喂进投影（`PresentedItem`，见 `content/presented-item.ts`），投影的产物**不可**
 * 赋值回存储形状。于是任何"库里存了什么"的判断（网盘整理的权威清单是头一个）在编译期就够不着
 * 投影过的数据——投影会把付费集的音频整个换成封面图，时长、track_id 全没了。
 */
export type StoredItem = StreamItem & { type: SourceType; readonly __shape?: 'stored' }

/** Escape the three characters SQLite's LIKE treats specially, so user text is matched literally
 *  (every LIKE below declares `ESCAPE '\'`). Without this, a query containing `%` matches
 *  everything and one containing `_` silently matches a wider set — a wrong answer, not an error. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * Bounded, rebuildable read model of recent StreamItems — powers the inbox.
 * NOT the corpus source of truth (the vault decision is deferred). `seq` gives a
 * stable insertion order so "latest" is well-defined regardless of item.timestamp.
 */
export class ItemStore {
  private db: Database.Database
  private addStmt: Database.Statement
  private evictStmt: Database.Statement
  private recentByStreamAscStmt: Database.Statement
  private recentByStreamDescStmt: Database.Statement

  constructor(
    dbPath: string,
    private readonly capPerStream = 5000
  ) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        stream_id TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_items_stream_seq ON items(stream_id, seq);
    `)
    this.addStmt = this.db.prepare(
      `INSERT OR IGNORE INTO items (id, stream_id, type, timestamp, created_at, json)
       VALUES (@id, @stream_id, @type, @timestamp, @created_at, @json)`
    )
    // keep only the newest capPerStream rows per stream
    this.evictStmt = this.db.prepare(
      `DELETE FROM items WHERE stream_id = ? AND seq NOT IN (
         SELECT seq FROM items WHERE stream_id = ? ORDER BY seq DESC LIMIT ?
       )`
    )
    this.recentByStreamAscStmt = this.db.prepare(
      `SELECT json, type FROM items WHERE stream_id = ? ORDER BY seq ASC LIMIT ?`
    )
    this.recentByStreamDescStmt = this.db.prepare(
      `SELECT json, type FROM items WHERE stream_id = ? ORDER BY seq DESC LIMIT ?`
    )
  }

  /** Insert one item + evict overflow. Caller frames the transaction (none for add(), one shared
   *  BEGIN/COMMIT for addMany()). */
  private insertOne(item: StreamItem, type: SourceType): void {
    const info = this.addStmt.run({
      id: item.id,
      stream_id: item.stream_id,
      type,
      timestamp: item.timestamp ?? null,
      created_at: new Date().toISOString(),
      json: JSON.stringify(item),
    })
    if (info.changes > 0) {
      this.evictStmt.run(item.stream_id, item.stream_id, this.capPerStream)
    }
  }

  add(item: StreamItem, type: SourceType): void {
    this.insertOne(item, type)
  }

  /** Batch-insert a harvest's new items in ONE transaction — one WAL commit/fsync instead of one
   *  per item. better-sqlite3 writes are synchronous, so the per-item path blocked the event loop
   *  ~1.5s on a large first harvest (see src/loop-lag.ts); batching collapses that to a single
   *  commit. Per-item errors are isolated (logged) so one bad row can't roll back the whole batch. */
  addMany(items: StreamItem[], type: SourceType): void {
    if (items.length === 0) return
    const run = this.db.transaction((rows: StreamItem[]) => {
      for (const item of rows) {
        try {
          this.insertOne(item, type)
        } catch (e) {
          console.error(`[item-store] add failed for ${item.id}:`, (e as Error).message)
        }
      }
    })
    run(items)
  }

  /** Replace a stream's rows with `items`, in order, so that `items[0]` ends up
   *  newest (top under `seq DESC`). Preserves any `muted` flag by id across the swap.
   *  For collection sources (e.g. douyin 收藏) whose upstream returns the full list
   *  in a meaningful order every harvest, so the inbox reflects that order instead of
   *  first-seen `seq` accretion. Runs in a single transaction.
   *
   *  `sourceId` 给定时只替换**该 source 的分片**——多成员 collection 流(RSS+网盘目录)各成员
   *  各自快照,整流替换会让后写者抹掉先写者(2026-07-24 活体事故:alist-audio 的 10 条把 RSS 的
   *  1015 条清了)。分片判定:行的 source_id 相同,或 id 出现在本批(兼容缺 source_id 的存量行,
   *  同时防同 id 重插成双行)。省略 sourceId = 旧语义(整流替换)。 */
  replaceStream(streamId: string, items: StreamItem[], type: SourceType, sourceId?: string): void {
    const swap = this.db.transaction((rows: StreamItem[]) => {
      const prev = this.db
        .prepare('SELECT id, json FROM items WHERE stream_id = ?')
        .all(streamId) as Array<{ id: string; json: string }>
      const preservedById = new Map<string, Pick<StreamItem, 'muted'>>()
      const incomingIds = new Set(rows.map((it) => it.id))
      const deleteOne = this.db.prepare('DELETE FROM items WHERE stream_id = ? AND id = ?')
      for (const r of prev) {
        const previous = JSON.parse(r.json) as StreamItem
        if (previous.muted) preservedById.set(r.id, { muted: previous.muted })
        if (sourceId !== undefined && (previous.source_id === sourceId || incomingIds.has(r.id))) {
          deleteOne.run(streamId, r.id)
        }
      }
      if (sourceId === undefined) this.db.prepare('DELETE FROM items WHERE stream_id = ?').run(streamId)
      // insert oldest-first (reverse) so rows[0] receives the highest seq → top of seq DESC
      for (let i = rows.length - 1; i >= 0; i--) {
        const it = rows[i]
        const preserved = preservedById.get(it.id)
        const stored = preserved ? { ...it, ...preserved } : it
        this.addStmt.run({
          id: it.id,
          stream_id: streamId,
          type,
          timestamp: it.timestamp ?? null,
          created_at: new Date().toISOString(),
          json: JSON.stringify(stored),
        })
      }
    })
    swap(items)
    // No eviction: a collection harvest is the upstream's full current list (replaced each
    // harvest, not accreted), so its size is bounded by the source — a 1000+ track 歌单 must
    // keep every track, not just the newest capPerStream.
  }

  /** 某个 source 分片当前在库多少条 —— 判据与 `replaceStream(…, sourceId)` 的分片判据同源
   *  (`json.source_id`)，所以它数的正是"这次替换会删掉的那一批"。collection 替换前的
   *  近乎全空防线用它当"旧分片还有没有货"（见 src/collection-replace-guard.ts）。
   *  缺 source_id 的存量老行不计入 —— 它们在分片替换里也确实不会被删。 */
  countBySource(streamId: string, sourceId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM items WHERE stream_id = ? AND json_extract(json, '$.source_id') = ?`)
      .get(streamId, sourceId) as { n: number }
    return row.n
  }

  /** Set or clear (null) the `muted` flag on a stored item by id. Rewrites the
   *  JSON blob in place; no-op if the id is absent. Used by manual labeling. */
  setMuted(id: string, muted: StreamItem['muted'] | null): void {
    const row = this.db.prepare('SELECT json FROM items WHERE id = ?').get(id) as
      | { json: string }
      | undefined
    if (!row) return
    const item = JSON.parse(row.json) as StreamItem
    if (muted) item.muted = muted
    else delete item.muted
    this.db.prepare('UPDATE items SET json = ? WHERE id = ?').run(JSON.stringify(item), id)
  }

  /** Maintenance sweep: walk rows (optionally scoped to one stream via the indexed stream_id
   *  column), hand each parsed item (with its source `type`) to `patch`, rewrite the JSON in place
   *  when it returns a NEW object; `null`/the same reference leaves the row untouched. Corrupt
   *  json rows are counted in `parseErrors` and skipped instead of aborting the transaction — a
   *  sweep must survive one bad row. Single transaction. ItemStore stays source-agnostic — all
   *  source knowledge lives in the caller's `patch` (see src/content/renormalize.ts). */
  rewriteItems(
    where: { streamId?: string },
    patch: (item: StoredItem) => StreamItem | null
  ): { scanned: number; updated: number; parseErrors: number } {
    const run = this.db.transaction(() => {
      const rows = (
        where.streamId
          ? this.db.prepare('SELECT id, json, type FROM items WHERE stream_id = ?').all(where.streamId)
          : this.db.prepare('SELECT id, json, type FROM items').all()
      ) as Array<{ id: string; json: string; type: SourceType }>
      const update = this.db.prepare('UPDATE items SET json = ? WHERE id = ?')
      let updated = 0
      let parseErrors = 0
      for (const r of rows) {
        let item: StreamItem
        try {
          item = JSON.parse(r.json) as StreamItem
        } catch {
          parseErrors++
          continue
        }
        const next = patch({ ...item, type: r.type })
        if (!next || (next as StreamItem) === item) continue
        // strip the injected `type` (a column, not part of the stored blob) before persisting
        const { type: _t, ...blob } = next as StoredItem
        update.run(JSON.stringify(blob), r.id)
        updated++
      }
      return { scanned: rows.length, updated, parseErrors }
    })
    return run()
  }

  /** Fetch a single stored item by id (with its source type), or undefined. */
  get(id: string): StoredItem | undefined {
    const row = this.db.prepare('SELECT json, type FROM items WHERE id = ?').get(id) as
      | { json: string; type: SourceType }
      | undefined
    return row ? { ...(JSON.parse(row.json) as StreamItem), type: row.type } : undefined
  }

  /** All muted items across streams, newest-first — the ad-fixture corpus source. */
  allMuted(): StoredItem[] {
    const rows = this.db
      .prepare('SELECT json, type FROM items ORDER BY seq DESC')
      .all() as Array<{ json: string; type: SourceType }>
    return rows
      .map((r) => ({ ...(JSON.parse(r.json) as StreamItem), type: r.type }))
      .filter((it) => it.muted)
  }

  /** Recent items, merged across streams or filtered to one.
   *
   *  - single stream: that stream's own order — `seq DESC`, which for collection streams
   *    (e.g. douyin 收藏) is the upstream collect order, and for feed streams is
   *    first-seen order.
   *  - all-latest (no stream): chronological by publish time (`timestamp`, falling back
   *    to `created_at`), and EXCLUDING `excludeStreams` — collection/channel-only streams
   *    don't belong in the timeline and their full-replace re-inserts would otherwise flood it. */
  recent(opts: { stream?: string; limit?: number; excludeStreams?: string[]; order?: 'asc' | 'desc' } = {}): StoredItem[] {
    const limit = opts.limit ?? 100
    let rows: Array<{ json: string; type: SourceType }>
    if (opts.stream) {
      // default newest-first (seq DESC); order:'asc' returns insertion order — for a
      // playlist/歌单 that's the curated top-to-bottom track order (seq = ingest order).
      const stmt = opts.order === 'asc' ? this.recentByStreamAscStmt : this.recentByStreamDescStmt
      rows = stmt.all(opts.stream, limit) as Array<{ json: string; type: SourceType }>
    } else {
      const exclude = opts.excludeStreams ?? []
      const placeholders = exclude.map(() => '?').join(',')
      const where = exclude.length ? `WHERE stream_id NOT IN (${placeholders})` : ''
      rows = this.db
        .prepare(
          `SELECT json, type FROM items ${where}
           ORDER BY COALESCE(timestamp, created_at) DESC, seq DESC LIMIT ?`
        )
        .all(...exclude, limit) as Array<{ json: string; type: SourceType }>
    }
    return rows.map((r) => ({ ...(JSON.parse(r.json) as StreamItem), type: r.type }))
  }

  /** Batch counterpart to `recent({stream, limit})` across multiple streams — one windowed query
   *  instead of N round-trips + JS-side flatMap/sort. Used by GET /api/channels/:id/items, whose
   *  per-member-stream loop was a measured event-loop stall source (see src/loop-lag.ts). Each
   *  group's Top-N is computed by SQLite itself via ROW_NUMBER() OVER (PARTITION BY stream_id
   *  ORDER BY ...) — a plain `IN(...) LIMIT` can't do "top N per group" (one stream could consume
   *  the whole LIMIT). Confirmed supported: better-sqlite3 11.10.0 / SQLite 3.49.2 (window
   *  functions since 3.25). Missing/empty streams are simply absent from the returned Map.
   *
   *  `cursor` selects one of three modes (default = legacy, unchanged for existing callers):
   *   - omitted: legacy seq-window — top N by `seq DESC` (insertion order). This is what every
   *     caller got before keyset pagination existed; left untouched so it stays correct for
   *     non-paginated call sites and the tests that pin this behavior.
   *   - `true`: key-window, no predicate — top N by the route's sort key (`timestamp` falling
   *     back to the JSON `fetched_at`), id DESC tie-break, but no lower bound. Used for an
   *     unpaginated / first page: unlike the seq-window, this can't miss a row whose `seq` is old
   *     but whose sort key is newest (out-of-order backfill, dedup re-insert, or — the case that
   *     motivated this — a >capPerStream collection stream where seq-window silently truncates
   *     what a >pageLimit page needs).
   *   - `{ sortKey, id }`: key-window + keyset predicate `(k, id) < (cursor.sortKey, cursor.id)`
   *     — same ordering as `true`, restricted to rows strictly after the cursor. Powers page 2+.
   *
   *  The key expression MUST match the route's JS sort key (`sortKeyOf` in client-item.ts,
   *  `it.timestamp || it.fetched_at`) byte-for-byte, including the empty-string edge: JS `||`
   *  falls through on `''`, so `NULLIF(timestamp, '')` is required — plain `COALESCE` would stop
   *  at `''` instead of falling back to fetched_at like the JS does. */
  recentForStreams(
    streamIds: string[],
    limitPerStream: number,
    cursor?: { sortKey: string; id: string } | true
  ): Map<string, StoredItem[]> {
    if (streamIds.length === 0) return new Map()
    const placeholders = streamIds.map(() => '?').join(',')
    let rows: Array<{ json: string; type: SourceType; stream_id: string }>
    if (cursor) {
      // sort key must byte-for-byte match sortKeyOf() in src/http/client-item.ts
      const K = `COALESCE(NULLIF(timestamp, ''), json_extract(json, '$.fetched_at'))`
      const predicate = cursor === true ? '' : `AND (${K} < ? OR (${K} = ? AND id < ?))`
      const params: Array<string | number> = [...streamIds]
      if (cursor !== true) params.push(cursor.sortKey, cursor.sortKey, cursor.id)
      params.push(limitPerStream)
      rows = this.db
        .prepare(
          `SELECT json, type, stream_id FROM (
             SELECT json, type, stream_id, id, ${K} as k,
               ROW_NUMBER() OVER (PARTITION BY stream_id ORDER BY ${K} DESC, id DESC) as rn
             FROM items WHERE stream_id IN (${placeholders}) ${predicate}
           ) WHERE rn <= ?
           ORDER BY stream_id, k DESC, id DESC`
        )
        .all(...params) as Array<{ json: string; type: SourceType; stream_id: string }>
    } else {
      rows = this.db
        .prepare(
          `SELECT json, type, stream_id FROM (
             SELECT json, type, stream_id, seq,
               ROW_NUMBER() OVER (PARTITION BY stream_id ORDER BY seq DESC) as rn
             FROM items WHERE stream_id IN (${placeholders})
           ) WHERE rn <= ?
           ORDER BY stream_id, seq DESC`
        )
        .all(...streamIds, limitPerStream) as Array<{ json: string; type: SourceType; stream_id: string }>
    }
    const byStream = new Map<string, StoredItem[]>()
    for (const r of rows) {
      const list = byStream.get(r.stream_id) ?? []
      list.push({ ...(JSON.parse(r.json) as StreamItem), type: r.type })
      byStream.set(r.stream_id, list)
    }
    return byStream
  }

  /** Filtered read over what is ALREADY stored — the "search my inbox" query (MCP `inbox_search`,
   *  see src/mcp/tool-catalog.ts). Every filter is optional and they AND together; the result is
   *  ordered by publish time (`timestamp`, falling back to `created_at`), newest-first by default.
   *
   *  `matched` is the FULL hit count before `limit` — the caller needs it to tell the reader
   *  "there are 140 of these, here are 20", which a truncated array alone cannot say.
   *
   *  **Plain SQLite LIKE, deliberately no FTS5.** Measured on the live 13k-row / 190MB cache.db:
   *  an author LIKE scan is ~140ms, a body LIKE scan ~93ms — cheap enough that an FTS5 index
   *  (schema migration + keeping it in sync with add/addMany/replaceStream/rewriteItems, four
   *  write paths whose drift would be SILENT) is not worth its risk. **Re-evaluate FTS5 when this
   *  query passes ~500ms or the table passes ~100k rows** — those are the numbers, not a feeling.
   *
   *  `q` matches title / body_text / content.text (NOT the whole json blob: that would hit urls,
   *  ids and the untouched `raw` payload and return junk). LIKE wildcards in user input are
   *  escaped, so a query containing `%` searches for a literal percent sign. */
  search(query: {
    streams?: string[]
    author?: string
    q?: string
    /** ISO timestamps, inclusive lower / upper bound on publish time */
    since?: string
    until?: string
    limit?: number
    order?: 'asc' | 'desc'
  }): { items: StoredItem[]; matched: number } {
    const limit = Math.max(1, query.limit ?? 50)
    const where: string[] = []
    const params: Array<string | number> = []
    // publish time, same expression the timeline sorts by (see recent()'s all-latest branch)
    const K = `COALESCE(NULLIF(timestamp, ''), created_at)`
    if (query.streams?.length) {
      where.push(`stream_id IN (${query.streams.map(() => '?').join(',')})`)
      params.push(...query.streams)
    }
    if (query.author) {
      where.push(`json_extract(json, '$.author') LIKE ? ESCAPE '\\'`)
      params.push(`%${likeEscape(query.author)}%`)
    }
    if (query.q) {
      const needle = `%${likeEscape(query.q)}%`
      where.push(
        `(json_extract(json, '$.title') LIKE ? ESCAPE '\\'` +
        ` OR json_extract(json, '$.body_text') LIKE ? ESCAPE '\\'` +
        ` OR json_extract(json, '$.content.text') LIKE ? ESCAPE '\\')`
      )
      params.push(needle, needle, needle)
    }
    if (query.since) { where.push(`${K} >= ?`); params.push(query.since) }
    if (query.until) { where.push(`${K} <= ?`); params.push(query.until) }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const matched = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM items ${clause}`).get(...params) as { n: number }
    ).n
    const dir = query.order === 'asc' ? 'ASC' : 'DESC'
    const rows = this.db
      .prepare(`SELECT json, type FROM items ${clause} ORDER BY ${K} ${dir}, seq ${dir} LIMIT ?`)
      .all(...params, limit) as Array<{ json: string; type: SourceType }>
    return { items: rows.map((r) => ({ ...(JSON.parse(r.json) as StreamItem), type: r.type })), matched }
  }

  /** Highest seq currently stored for a stream (0 if none). The read-watermark target:
   *  marking a stream "seen" advances the viewer's watermark to this. */
  maxSeq(streamId: string): number {
    const row = this.db
      .prepare('SELECT MAX(seq) AS m FROM items WHERE stream_id = ?')
      .get(streamId) as { m: number | null }
    return row.m ?? 0
  }

  /** How many of this stream's VISIBLE items were inserted after `seq` (i.e. are newer than the
   *  viewer's watermark). Folded items (muted — ads or title-include filtered) are excluded so an
   *  unread badge counts only what the reader would actually see. Parses the small newer-than-
   *  watermark slice (consistent with allMuted); followed streams are tiny so this stays cheap. */
  newCountSince(streamId: string, seq: number): number {
    const rows = this.db
      .prepare('SELECT json FROM items WHERE stream_id = ? AND seq > ?')
      .all(streamId, seq) as Array<{ json: string }>
    return rows.filter((r) => !(JSON.parse(r.json) as StreamItem).muted).length
  }

  close(): void {
    this.db.close()
  }
}
