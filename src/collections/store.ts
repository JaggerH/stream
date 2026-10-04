import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 「收藏」——统一的、多列表的收藏系统,横跨 video/audio 两个域。真因(2026-07-20):video 这边先建了
 * 一张 stream-only 的收藏表,用户随即指出——(1) 音频那边早就有一个几乎同构的独立实现
 * (audio/liked.ts 的 LikedSongsStore,「我的喜欢」),两套系统同一个概念没道理分裂;(2) 用户可能要
 * 不止一个列表(「正在追的」/「想看」/自定义),不是一个开关。这个模块把两者都收进来、退役掉。
 *
 * 三张表,「东西是什么」和「在哪个列表里」分开:
 *  - collected_item:每个被收藏过的东西只存一份快照(不管它在几个列表里,元数据不重复)。
 *  - collection:命名列表本身——两个系统默认列表(正在追的/我的喜欢,不可删)+ 用户自建的任意多个。
 *  - collection_item:纯粹的多对多归属(collection_id, item_key)。
 *
 * 键判别式(`kind`)同构 netdisk 的 `MappingLeft`:
 *  - stream:用户关注的 Stream(自定义/RSSHub follow)
 *  - tmdb:纯榜单作品,没有 Stream 撑腰(如「奥德赛」「躲在超市后门抽烟的两人」这类只靠 TMDb
 *    权威分集索引绑网盘的条目),也是「TMDB 搜索」功能的收藏落点。
 *  - track:音乐单曲,取代 LikedSongsStore 的 (platform, track_id)。
 *  - episode:播客分集——一个音频 stream 里的单个 item(detail 子列表/播单的成员)。快照只做展示
 *    兜底(title/poster/时长),播放一律从 live item 构建(见 2026-07-24 podcast-episode-collections spec §3)。
 */
export type CollectedItemKey =
  | { kind: 'stream'; streamId: string }
  | { kind: 'tmdb'; id: string; media: 'movie' | 'tv' }
  | { kind: 'track'; platform: string; trackId: string }
  /** 播客分集——一个音频 stream 里的单个 item。itemId 从 guid/link 派生、可能含 ':'。 */
  | { kind: 'episode'; streamId: string; itemId: string }

export type Domain = 'video' | 'audio'

const DOMAIN_OF: Record<CollectedItemKey['kind'], Domain> = { stream: 'video', tmdb: 'video', track: 'audio', episode: 'audio' }

export interface CollectedItemMeta {
  title: string
  poster?: string
  /** track 专属;其余 kind 不填。 */
  artist?: string
  album?: string
  durationS?: number
  sourceUrl?: string
}

export interface CollectedItemSnapshot {
  key: string
  kind: CollectedItemKey['kind']
  domain: Domain
  streamId?: string
  tmdbId?: string
  media?: 'movie' | 'tv'
  platform?: string
  trackId?: string
  itemId?: string
  title: string
  poster?: string
  artist?: string
  album?: string
  durationS?: number
  sourceUrl?: string
  firstCollectedAt: number
}

export interface CollectionRecord {
  id: string
  domain: Domain
  label: string
  /** 系统默认列表的身份标记;存在即不可删、不可改域。用户自建列表这里是 undefined。 */
  system?: 'following' | 'liked'
  /** 锚定的 stream——该播单作为子列表出现在这个 stream 的 detail 里(spec §2.2)。undefined = 全局播单。 */
  anchorStreamId?: string
  createdAt: string
  updatedAt: string
}

export const SYSTEM_COLLECTIONS = { videoFollowing: 'col_video_following', audioLiked: 'col_audio_liked' } as const

function keyOf(k: CollectedItemKey): string {
  if (k.kind === 'stream') return `stream:${k.streamId}`
  if (k.kind === 'tmdb') return `tmdb:${k.media}:${k.id}`
  if (k.kind === 'episode') return `episode:${k.streamId}:${k.itemId}`
  return `track:${k.platform}:${k.trackId}`
}

function newCollectionId(): string {
  return `col_${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`
}

export class CollectionsStore {
  private db: Database.Database
  /** 建表前新 schema 是否已存在——供上层判断这是不是这台机器第一次跑统一收藏(用于日志/诊断;
   *  迁移本身在构造函数里无条件跑,不依赖调用方)。 */
  readonly isFreshInstall: boolean

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.isFreshInstall = !this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='collection'`).get()
    this.ensureTables()
    this.migrateEpisodeSchema()
    this.ensureSystemCollections()
    this.migrateLegacyCollectedWork()
    this.migrateLegacyLikedTrack()
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collected_item (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('stream','tmdb','track','episode')),
        domain TEXT NOT NULL CHECK (domain IN ('video','audio')),
        stream_id TEXT,
        tmdb_id TEXT,
        media TEXT,
        platform TEXT,
        track_id TEXT,
        item_id TEXT,
        title TEXT NOT NULL,
        poster TEXT,
        artist TEXT,
        album TEXT,
        duration_s REAL,
        source_url TEXT,
        first_collected_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collection (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL CHECK (domain IN ('video','audio')),
        label TEXT NOT NULL,
        system TEXT CHECK (system IS NULL OR system IN ('following','liked')),
        anchor_stream_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collection_item (
        collection_id TEXT NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
        item_key TEXT NOT NULL REFERENCES collected_item(key),
        added_at INTEGER NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (collection_id, item_key)
      );
      CREATE INDEX IF NOT EXISTS idx_collection_item_key ON collection_item(item_key);
      CREATE INDEX IF NOT EXISTS idx_collected_item_domain ON collected_item(domain);
    `)
  }

  /** 两个系统列表任何时候都在——新装机也一样,免得上层到处判空。 */
  private ensureSystemCollections(): void {
    const now = new Date().toISOString()
    const upsert = this.db.prepare(
      `INSERT INTO collection (id, domain, label, system, created_at, updated_at) VALUES (@id, @domain, @label, @system, @now, @now)
       ON CONFLICT(id) DO NOTHING`,
    )
    upsert.run({ id: SYSTEM_COLLECTIONS.videoFollowing, domain: 'video', label: '正在追的', system: 'following', now })
    upsert.run({ id: SYSTEM_COLLECTIONS.audioLiked, domain: 'audio', label: '我的喜欢', system: 'liked', now })
  }

  /** collected_item 的 kind CHECK 写死在建表 SQL 里,SQLite 改不了约束——探测到旧 CHECK(不含
   *  'episode')就重建表搬数据(spec §2.3)。幂等:新装机/已迁移库探测即通过,不动。 */
  private migrateEpisodeSchema(): void {
    const row = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='collected_item'`).get() as { sql: string } | undefined
    if (row && !row.sql.includes("'episode'")) {
      // collection_item.item_key 外键指向 collected_item(key);better-sqlite3 默认 foreign_keys=ON,
      // 期间必须先关掉,否则 DROP TABLE 被引用中的 collected_item 会报 FOREIGN KEY constraint failed
      // (SQLite 官方表重建配方的一步,见 https://www.sqlite.org/lang_altertable.html #7)。PRAGMA 在
      // 事务内是 no-op,必须留在事务外;用 try/finally 保证重建抛错也不会把连接永久锁在 OFF。
      this.db.pragma('foreign_keys = OFF')
      try {
        this.db.transaction(() => {
          this.db.exec(`
            CREATE TABLE collected_item_new (
              key TEXT PRIMARY KEY,
              kind TEXT NOT NULL CHECK (kind IN ('stream','tmdb','track','episode')),
              domain TEXT NOT NULL CHECK (domain IN ('video','audio')),
              stream_id TEXT, tmdb_id TEXT, media TEXT, platform TEXT, track_id TEXT, item_id TEXT,
              title TEXT NOT NULL, poster TEXT, artist TEXT, album TEXT,
              duration_s REAL, source_url TEXT, first_collected_at INTEGER NOT NULL
            );
            INSERT INTO collected_item_new (key, kind, domain, stream_id, tmdb_id, media, platform, track_id, item_id, title, poster, artist, album, duration_s, source_url, first_collected_at)
              SELECT key, kind, domain, stream_id, tmdb_id, media, platform, track_id, NULL, title, poster, artist, album, duration_s, source_url, first_collected_at FROM collected_item;
            DROP TABLE collected_item;
            ALTER TABLE collected_item_new RENAME TO collected_item;
            CREATE INDEX IF NOT EXISTS idx_collected_item_domain ON collected_item(domain);
          `)
        })()
      } finally {
        this.db.pragma('foreign_keys = ON')
      }
    }
    // 老库的 collection 表没有 anchor_stream_id 列——ADD COLUMN 是 SQLite 支持的轻量迁移(不像上面
    // 的 CHECK 约束重建),不需要表重建那一套。幂等:新装机/已迁移库探测即通过。
    const cols = this.db.prepare('PRAGMA table_info(collection)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'anchor_stream_id')) this.db.exec('ALTER TABLE collection ADD COLUMN anchor_stream_id TEXT')
    this.migrateItemPosition()
  }

  /**
   * 手动排序的落点：`collection_item.position`（升序 = 展示顺序）。老库没有这一列。
   *
   * **迁移必须让每个列表的顺序一条不差地保持原样**——用户看到的次序是他记住的东西，一次升级
   * 把它洗牌，比没有手动排序这个功能糟得多。所以回填用的就是从前那条 ORDER BY 本身
   * （`added_at DESC, item_key DESC`），而不是另写一个"应该差不多"的排序。
   *
   * 幂等：探测到列已在就整段跳过（新装机走建表 SQL，本来就带这一列）。
   */
  private migrateItemPosition(): void {
    const cols = this.db.prepare('PRAGMA table_info(collection_item)').all() as Array<{ name: string }>
    if (cols.some((c) => c.name === 'position')) return
    // ADD COLUMN 不能直接带 NOT NULL 而无默认值；先给个默认值把列加上，回填之后它就再没有意义了。
    this.db.exec('ALTER TABLE collection_item ADD COLUMN position INTEGER NOT NULL DEFAULT 0')
    this.db.exec(`
      WITH ranked AS (
        SELECT collection_id, item_key,
               ROW_NUMBER() OVER (PARTITION BY collection_id ORDER BY added_at DESC, item_key DESC) - 1 AS rn
        FROM collection_item
      )
      UPDATE collection_item SET position = (
        SELECT rn FROM ranked r WHERE r.collection_id = collection_item.collection_id AND r.item_key = collection_item.item_key
      )
    `)
  }

  /** 老的 v1 收藏表(stream_id 单主键,2026-07-20 早些时候上线过、已有真实数据)迁进「正在追的」
   *  系统列表,然后整表丢弃——这是这台机器唯一会跑到的一次(表不存在则直接跳过)。 */
  private migrateLegacyCollectedWork(): void {
    const exists = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='collected_work'`).get()
    if (!exists) return
    const rows = this.db.prepare('SELECT stream_id, title, poster, collected_at FROM collected_work').all() as Array<{
      stream_id: string; title: string; poster: string | null; collected_at: number
    }>
    for (const r of rows) {
      this.addItem(SYSTEM_COLLECTIONS.videoFollowing, { kind: 'stream', streamId: r.stream_id }, { title: r.title, poster: r.poster ?? undefined }, r.collected_at)
    }
    this.db.exec('DROP TABLE collected_work')
  }

  /** 老的 audio/liked.ts LikedSongsStore 表(真实音乐库数据)迁进「我的喜欢」系统列表,然后丢弃。 */
  private migrateLegacyLikedTrack(): void {
    const exists = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='liked_track'`).get()
    if (!exists) return
    const rows = this.db.prepare(
      'SELECT platform, track_id, title, artist, album, poster, duration_s, source_url, liked_at FROM liked_track',
    ).all() as Array<{
      platform: string; track_id: string; title: string; artist: string | null; album: string | null
      poster: string | null; duration_s: number | null; source_url: string | null; liked_at: number
    }>
    for (const r of rows) {
      this.addItem(
        SYSTEM_COLLECTIONS.audioLiked,
        { kind: 'track', platform: r.platform, trackId: r.track_id },
        {
          title: r.title,
          poster: r.poster ?? undefined,
          artist: r.artist ?? undefined,
          album: r.album ?? undefined,
          durationS: r.duration_s ?? undefined,
          sourceUrl: r.source_url ?? undefined,
        },
        r.liked_at,
      )
    }
    this.db.exec('DROP TABLE liked_track')
  }

  // ---- collections ----

  listCollections(domain?: Domain, anchor?: string): Array<CollectionRecord & { itemCount: number }> {
    const conditions: string[] = []
    if (domain) conditions.push('c.domain = @domain')
    if (anchor) conditions.push('c.anchor_stream_id = @anchor')
    const rows = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM collection_item ci WHERE ci.collection_id = c.id) AS item_count
         FROM collection c
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY c.system IS NULL, c.created_at ASC`, // 系统列表(system 非空)排前面
      )
      .all({ ...(domain ? { domain } : {}), ...(anchor ? { anchor } : {}) }) as any[]
    return rows.map((r) => ({ ...this.rowToCollection(r), itemCount: r.item_count }))
  }

  getCollection(id: string): CollectionRecord | null {
    const r = this.db.prepare('SELECT * FROM collection WHERE id = ?').get(id) as any
    return r ? this.rowToCollection(r) : null
  }

  createCollection(domain: Domain, label: string, anchorStreamId?: string): CollectionRecord {
    const id = newCollectionId()
    const now = new Date().toISOString()
    this.db.prepare('INSERT INTO collection (id, domain, label, system, anchor_stream_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)')
      .run(id, domain, label, anchorStreamId ?? null, now, now)
    return this.getCollection(id)!
  }

  renameCollection(id: string, label: string): CollectionRecord | null {
    const now = new Date().toISOString()
    const changed = this.db.prepare('UPDATE collection SET label = ?, updated_at = ? WHERE id = ?').run(label, now, id).changes > 0
    return changed ? this.getCollection(id) : null
  }

  /** 系统列表(正在追的/我的喜欢)拒删;返回 false 表示没删成(不存在或是系统列表)。 */
  deleteCollection(id: string): boolean {
    const c = this.getCollection(id)
    if (!c || c.system) return false
    this.db.prepare('DELETE FROM collection_item WHERE collection_id = ?').run(id)
    this.db.prepare('DELETE FROM collection WHERE id = ?').run(id)
    return true
  }

  // ---- items ----

  /**
   * 展示顺序 = `position` 升序。没排过的列表里 position 是按"加入这个列表的时间倒序"回填/递减的
   * （不是全局首次收藏时间——同一东西可能先进了别的列表），所以**没人排过的列表看起来和从前一样**。
   * 后两个次序键只是并列时的定盘星，正常情况下 position 在一个列表内唯一。
   */
  itemsOf(collectionId: string): CollectedItemSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT i.* FROM collection_item ci JOIN collected_item i ON i.key = ci.item_key
         WHERE ci.collection_id = ?
         ORDER BY ci.position ASC, ci.added_at DESC, i.key DESC`,
      )
      .all(collectionId) as any[]
    return rows.map((r) => this.rowToItem(r))
  }

  /**
   * 把一个列表重排成 `keys` 给的顺序。**只收整份名单**：`keys` 必须是这个列表当前成员的一个
   * 全排列，缺一个、多一个、有重复都拒绝。
   *
   * 为什么不接受局部名单：局部写下去的话，没被列出的那些成员位置全凭旧值，结果既不是用户拖出来
   * 的样子、也不是原来的样子，而调用方会以为"我只动了两条"。整份名单让"发出去的就是将看到的"，
   * 前端也不必自己算增量。
   *
   * 一个事务：校验不过就抛，一行都不写。
   */
  reorder(collectionId: string, keys: string[]): void {
    const current = this.db
      .prepare('SELECT item_key FROM collection_item WHERE collection_id = ?')
      .all(collectionId)
      .map((r: any) => r.item_key as string)
    const given = new Set(keys)
    if (given.size !== keys.length) throw new Error(`reorder: 名单里有重复的成员`)
    if (keys.length !== current.length || current.some((k) => !given.has(k))) {
      throw new Error(`reorder: 名单不完整——需要 ${collectionId} 的全部 ${current.length} 个成员，收到 ${keys.length} 个`)
    }
    const set = this.db.prepare('UPDATE collection_item SET position = ? WHERE collection_id = ? AND item_key = ?')
    this.db.transaction(() => keys.forEach((k, i) => set.run(i, collectionId, k)))()
  }

  /** 这个东西现在被收进了哪些列表(收藏面板的复选框状态)。 */
  collectionsFor(k: CollectedItemKey): CollectionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM collection_item ci JOIN collection c ON c.id = ci.collection_id
         WHERE ci.item_key = ? ORDER BY c.system IS NULL, c.created_at ASC`,
      )
      .all(keyOf(k)) as any[]
    return rows.map((r) => this.rowToCollection(r))
  }

  isIn(collectionId: string, k: CollectedItemKey): boolean {
    return !!this.db.prepare('SELECT 1 FROM collection_item WHERE collection_id = ? AND item_key = ?').get(collectionId, keyOf(k))
  }

  getItem(k: CollectedItemKey): CollectedItemSnapshot | null {
    const r = this.db.prepare('SELECT * FROM collected_item WHERE key = ?').get(keyOf(k)) as any
    return r ? this.rowToItem(r) : null
  }

  /** 加入一个列表(幂等)——快照表按 key 幂等 upsert(刷新 title/poster,不刷新已有元数据的收藏时间),
   *  归属关系按 (collection_id, item_key) 幂等插入。`at` 仅供迁移传入原始时间戳,常规调用不传。 */
  addItem(collectionId: string, k: CollectedItemKey, meta: CollectedItemMeta, at?: number): CollectedItemSnapshot {
    const key = keyOf(k)
    const now = at ?? Date.now()
    this.db
      .prepare(
        `INSERT INTO collected_item (key, kind, domain, stream_id, tmdb_id, media, platform, track_id, item_id, title, poster, artist, album, duration_s, source_url, first_collected_at)
         VALUES (@key, @kind, @domain, @streamId, @tmdbId, @media, @platform, @trackId, @itemId, @title, @poster, @artist, @album, @durationS, @sourceUrl, @now)
         ON CONFLICT(key) DO UPDATE SET title=@title, poster=@poster, artist=@artist, album=@album, duration_s=@durationS, source_url=@sourceUrl`,
      )
      .run({
        key, kind: k.kind, domain: DOMAIN_OF[k.kind],
        streamId: k.kind === 'stream' || k.kind === 'episode' ? k.streamId : null,
        tmdbId: k.kind === 'tmdb' ? k.id : null,
        media: k.kind === 'tmdb' ? k.media : null,
        platform: k.kind === 'track' ? k.platform : null,
        trackId: k.kind === 'track' ? k.trackId : null,
        itemId: k.kind === 'episode' ? k.itemId : null,
        title: meta.title, poster: meta.poster ?? null, artist: meta.artist ?? null, album: meta.album ?? null,
        durationS: meta.durationS ?? null, sourceUrl: meta.sourceUrl ?? null, now,
      })
    // 新成员落在**最前**（position = 当前最小值 - 1）。这既是手动排序之前的行为（最近加入的在
    // 上面），也是排过之后唯一说得通的落点：用户编排的是他见过的那些，新东西塞进看不见的队尾
    // 等于加了个他不知道的成员。用"减一"而不是"把别人整体加一"，是为了加一个成员只写一行。
    this.db
      .prepare(
        `INSERT INTO collection_item (collection_id, item_key, added_at, position)
         VALUES (?, ?, ?, COALESCE((SELECT MIN(position) FROM collection_item WHERE collection_id = ?), 0) - 1)
         ON CONFLICT(collection_id, item_key) DO NOTHING`,
      )
      .run(collectionId, key, now, collectionId)
    return this.getItem(k)!
  }

  /** 多选批量加入——单事务,逐条幂等(spec §4)。 */
  addItems(collectionId: string, items: Array<{ key: CollectedItemKey; meta: CollectedItemMeta }>): CollectedItemSnapshot[] {
    const tx = this.db.transaction((batch: typeof items) => batch.map(({ key, meta }) => this.addItem(collectionId, key, meta)))
    return tx(items)
  }

  /** 从一个列表移出——只删归属关系,快照留着(可能还在别的列表里);
   *  真孤儿(哪个列表都不在了)顺手清掉,不留垃圾行。 */
  removeItem(collectionId: string, k: CollectedItemKey): boolean {
    const key = keyOf(k)
    const removed = this.db.prepare('DELETE FROM collection_item WHERE collection_id = ? AND item_key = ?').run(collectionId, key).changes > 0
    if (removed) {
      const stillUsed = this.db.prepare('SELECT 1 FROM collection_item WHERE item_key = ?').get(key)
      if (!stillUsed) this.db.prepare('DELETE FROM collected_item WHERE key = ?').run(key)
    }
    return removed
  }

  close(): void {
    this.db.close()
  }

  private rowToCollection(r: any): CollectionRecord {
    return {
      id: r.id, domain: r.domain, label: r.label, system: r.system ?? undefined,
      anchorStreamId: r.anchor_stream_id ?? undefined,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }
  }

  private rowToItem(r: any): CollectedItemSnapshot {
    return {
      key: r.key, kind: r.kind, domain: r.domain,
      ...(r.stream_id ? { streamId: r.stream_id } : {}),
      ...(r.tmdb_id ? { tmdbId: r.tmdb_id } : {}),
      ...(r.media ? { media: r.media } : {}),
      ...(r.platform ? { platform: r.platform } : {}),
      ...(r.track_id ? { trackId: r.track_id } : {}),
      ...(r.item_id ? { itemId: r.item_id } : {}),
      title: r.title,
      poster: r.poster ?? undefined,
      artist: r.artist ?? undefined,
      album: r.album ?? undefined,
      durationS: r.duration_s ?? undefined,
      sourceUrl: r.source_url ?? undefined,
      firstCollectedAt: r.first_collected_at,
    }
  }
}
