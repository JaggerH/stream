import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { CollectionsStore, SYSTEM_COLLECTIONS } from './store.ts'

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

describe('CollectionsStore', () => {
  it('a fresh install has both system collections, empty, and cannot delete them', () => {
    const dir = tmp('collections-')
    const store = new CollectionsStore(join(dir, 'stream.db'))
    try {
      expect(store.isFreshInstall).toBe(true)
      const all = store.listCollections()
      expect(all).toEqual([
        expect.objectContaining({ id: SYSTEM_COLLECTIONS.videoFollowing, domain: 'video', label: '正在追的', system: 'following', itemCount: 0 }),
        expect.objectContaining({ id: SYSTEM_COLLECTIONS.audioLiked, domain: 'audio', label: '我的喜欢', system: 'liked', itemCount: 0 }),
      ])
      expect(store.deleteCollection(SYSTEM_COLLECTIONS.videoFollowing)).toBe(false)
      expect(store.getCollection(SYSTEM_COLLECTIONS.videoFollowing)).not.toBeNull() // still there
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('adds/removes items across all three kinds, and collectionsFor reflects membership', () => {
    const dir = tmp('collections-')
    const store = new CollectionsStore(join(dir, 'stream.db'))
    try {
      store.addItem(SYSTEM_COLLECTIONS.videoFollowing, { kind: 'stream', streamId: 'show-a' }, { title: 'Show A' })
      store.addItem(SYSTEM_COLLECTIONS.videoFollowing, { kind: 'tmdb', id: '1368337', media: 'movie' }, { title: '奥德赛', poster: '/o.jpg' })
      store.addItem(SYSTEM_COLLECTIONS.audioLiked, { kind: 'track', platform: 'netease', trackId: '1' }, { title: 'Song A', artist: 'Artist A', durationS: 210 })

      expect(store.isIn(SYSTEM_COLLECTIONS.videoFollowing, { kind: 'stream', streamId: 'show-a' })).toBe(true)
      expect(store.isIn(SYSTEM_COLLECTIONS.videoFollowing, { kind: 'stream', streamId: 'show-b' })).toBe(false)

      const items = store.itemsOf(SYSTEM_COLLECTIONS.videoFollowing)
      expect(items).toHaveLength(2)
      expect(items.find((i) => i.kind === 'tmdb')).toMatchObject({ tmdbId: '1368337', media: 'movie', title: '奥德赛', poster: '/o.jpg' })

      const track = store.getItem({ kind: 'track', platform: 'netease', trackId: '1' })
      expect(track).toMatchObject({ kind: 'track', domain: 'audio', platform: 'netease', trackId: '1', title: 'Song A', artist: 'Artist A', durationS: 210 })

      expect(store.collectionsFor({ kind: 'stream', streamId: 'show-a' })).toEqual([
        expect.objectContaining({ id: SYSTEM_COLLECTIONS.videoFollowing }),
      ])

      expect(store.removeItem(SYSTEM_COLLECTIONS.videoFollowing, { kind: 'stream', streamId: 'show-a' })).toBe(true)
      expect(store.isIn(SYSTEM_COLLECTIONS.videoFollowing, { kind: 'stream', streamId: 'show-a' })).toBe(false)
      expect(store.getItem({ kind: 'stream', streamId: 'show-a' })).toBeNull() // orphaned snapshot GC'd
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the same item in two lists keeps one snapshot; removing from one list leaves it in the other', () => {
    const dir = tmp('collections-')
    const store = new CollectionsStore(join(dir, 'stream.db'))
    try {
      const custom = store.createCollection('video', '奥斯卡入围')
      const key = { kind: 'tmdb' as const, id: '1368337', media: 'movie' as const }
      store.addItem(SYSTEM_COLLECTIONS.videoFollowing, key, { title: '奥德赛' })
      store.addItem(custom.id, key, { title: '奥德赛' })

      expect(store.collectionsFor(key).map((c) => c.id).sort()).toEqual([SYSTEM_COLLECTIONS.videoFollowing, custom.id].sort())

      store.removeItem(custom.id, key)
      expect(store.getItem(key)).not.toBeNull() // still referenced by 正在追的
      expect(store.isIn(SYSTEM_COLLECTIONS.videoFollowing, key)).toBe(true)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('re-adding (idempotent) refreshes metadata but keeps the original firstCollectedAt', () => {
    const dir = tmp('collections-')
    const store = new CollectionsStore(join(dir, 'stream.db'))
    try {
      const key = { kind: 'stream' as const, streamId: 'show-a' }
      const first = store.addItem(SYSTEM_COLLECTIONS.videoFollowing, key, { title: 'Old' })
      const second = store.addItem(SYSTEM_COLLECTIONS.videoFollowing, key, { title: 'New', poster: '/new.jpg' })
      expect(second.title).toBe('New')
      expect(second.poster).toBe('/new.jpg')
      expect(second.firstCollectedAt).toBe(first.firstCollectedAt)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('createCollection/renameCollection/deleteCollection manage user lists', () => {
    const dir = tmp('collections-')
    const store = new CollectionsStore(join(dir, 'stream.db'))
    try {
      const custom = store.createCollection('video', '想看')
      expect(custom).toMatchObject({ domain: 'video', label: '想看', system: undefined })
      expect(store.renameCollection(custom.id, '已看完')).toMatchObject({ label: '已看完' })
      expect(store.deleteCollection(custom.id)).toBe(true)
      expect(store.getCollection(custom.id)).toBeNull()
      expect(store.renameCollection('col_missing', 'x')).toBeNull()
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('migrates the live v1 video collected_work table into 正在追的, and drops the old table', () => {
    const dir = tmp('collections-migrate-video-')
    const dbPath = join(dir, 'stream.db')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE collected_work (stream_id TEXT PRIMARY KEY, title TEXT NOT NULL, poster TEXT, collected_at INTEGER NOT NULL);
      INSERT INTO collected_work (stream_id, title, poster, collected_at) VALUES
        ('tencent-talkshow-friends-season3', '脱口秀和Ta的朋友们 第三季', 'https://poster', 1000),
        ('iqiyi-xjzw3-v6', '喜剧之王单口季第3季', NULL, 2000);
    `)
    db.close()

    const store = new CollectionsStore(dbPath)
    try {
      const items = store.itemsOf(SYSTEM_COLLECTIONS.videoFollowing)
      expect(items).toHaveLength(2)
      expect(items.find((i) => i.streamId === 'tencent-talkshow-friends-season3')).toMatchObject({
        kind: 'stream', domain: 'video', title: '脱口秀和Ta的朋友们 第三季', poster: 'https://poster',
      })
      const raw = new Database(dbPath)
      expect(raw.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='collected_work'`).get()).toBeUndefined()
      raw.close()
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('migrates the live audio liked_track table into 我的喜欢, and drops the old table', () => {
    const dir = tmp('collections-migrate-audio-')
    const dbPath = join(dir, 'stream.db')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE liked_track (
        platform TEXT NOT NULL, track_id TEXT NOT NULL, title TEXT NOT NULL, artist TEXT, album TEXT,
        poster TEXT, duration_s REAL, source_url TEXT, liked_at INTEGER NOT NULL, PRIMARY KEY (platform, track_id)
      );
      INSERT INTO liked_track (platform, track_id, title, artist, album, duration_s, liked_at)
      VALUES ('netease', '1', 'Song A', 'Artist A', 'Album A', 210, 1000);
    `)
    db.close()

    const store = new CollectionsStore(dbPath)
    try {
      const items = store.itemsOf(SYSTEM_COLLECTIONS.audioLiked)
      expect(items).toEqual([
        expect.objectContaining({ kind: 'track', domain: 'audio', platform: 'netease', trackId: '1', title: 'Song A', artist: 'Artist A', album: 'Album A', durationS: 210 }),
      ])
      const raw = new Database(dbPath)
      expect(raw.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='liked_track'`).get()).toBeUndefined()
      raw.close()
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('migrates both legacy tables in one boot when both are present', () => {
    const dir = tmp('collections-migrate-both-')
    const dbPath = join(dir, 'stream.db')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE collected_work (stream_id TEXT PRIMARY KEY, title TEXT NOT NULL, poster TEXT, collected_at INTEGER NOT NULL);
      INSERT INTO collected_work (stream_id, title, collected_at) VALUES ('show-a', 'Show A', 1000);
      CREATE TABLE liked_track (
        platform TEXT NOT NULL, track_id TEXT NOT NULL, title TEXT NOT NULL, artist TEXT, album TEXT,
        poster TEXT, duration_s REAL, source_url TEXT, liked_at INTEGER NOT NULL, PRIMARY KEY (platform, track_id)
      );
      INSERT INTO liked_track (platform, track_id, title, liked_at) VALUES ('netease', '1', 'Song A', 1000);
    `)
    db.close()

    const store = new CollectionsStore(dbPath)
    try {
      expect(store.itemsOf(SYSTEM_COLLECTIONS.videoFollowing)).toHaveLength(1)
      expect(store.itemsOf(SYSTEM_COLLECTIONS.audioLiked)).toHaveLength(1)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('episode kind (播客分集, 2026-07-24)', () => {
  it('adds an episode item, round-trips itemId containing colons', () => {
    const store = new CollectionsStore(':memory:')
    try {
      const col = store.createCollection('audio', '某系列')
      const key = { kind: 'episode' as const, streamId: 'pod-a', itemId: 'ep:with:colons' }
      store.addItem(col.id, key, { title: '第1期', poster: '/p.jpg', durationS: 3600, sourceUrl: 'https://x/1' })
      const item = store.getItem(key)
      expect(item).toMatchObject({ kind: 'episode', domain: 'audio', streamId: 'pod-a', itemId: 'ep:with:colons', title: '第1期' })
      expect(item!.key).toBe('episode:pod-a:ep:with:colons')
      expect(store.isIn(col.id, key)).toBe(true)
      expect(store.collectionsFor(key).map((c) => c.id)).toEqual([col.id])
    } finally { store.close() }
  })

  it('migrates a pre-episode schema DB in place (CHECK 约束重建, spec §2.3)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-mig-'))
    const dbPath = join(dir, 'c.db')
    // 手工建旧 schema(无 episode、无 item_id)并灌一行真实数据
    const raw = new Database(dbPath)
    raw.exec(`
      CREATE TABLE collected_item (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('stream','tmdb','track')),
        domain TEXT NOT NULL CHECK (domain IN ('video','audio')),
        stream_id TEXT, tmdb_id TEXT, media TEXT, platform TEXT, track_id TEXT,
        title TEXT NOT NULL, poster TEXT, artist TEXT, album TEXT,
        duration_s REAL, source_url TEXT, first_collected_at INTEGER NOT NULL
      );
      CREATE TABLE collection (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL CHECK (domain IN ('video','audio')),
        label TEXT NOT NULL,
        system TEXT CHECK (system IS NULL OR system IN ('following','liked')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE collection_item (
        collection_id TEXT NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
        item_key TEXT NOT NULL REFERENCES collected_item(key),
        added_at INTEGER NOT NULL,
        PRIMARY KEY (collection_id, item_key)
      );
      INSERT INTO collection VALUES ('col_audio_liked','audio','我的喜欢','liked','2026-07-20','2026-07-20');
      INSERT INTO collected_item (key,kind,domain,platform,track_id,title,first_collected_at)
        VALUES ('track:netease:1','track','audio','netease','1','老歌',1721400000000);
      INSERT INTO collection_item VALUES ('col_audio_liked','track:netease:1',1721400000000);
    `)
    raw.close()
    const store = new CollectionsStore(dbPath)
    try {
      // 老数据原样活着
      expect(store.getItem({ kind: 'track', platform: 'netease', trackId: '1' })).toMatchObject({ title: '老歌', firstCollectedAt: 1721400000000 })
      expect(store.isIn('col_audio_liked', { kind: 'track', platform: 'netease', trackId: '1' })).toBe(true)
      // 新 kind 插得进去(旧 CHECK 会拒)
      const col = store.createCollection('audio', 'S')
      store.addItem(col.id, { kind: 'episode', streamId: 'p', itemId: 'e1' }, { title: 'E1' })
      expect(store.getItem({ kind: 'episode', streamId: 'p', itemId: 'e1' })).not.toBeNull()
    } finally { store.close() }
  })

  it('reopening an already-migrated on-disk DB is idempotent (guard short-circuits)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-mig-'))
    const dbPath = join(dir, 'c.db')
    const raw = new Database(dbPath)
    raw.exec(`
      CREATE TABLE collected_item (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('stream','tmdb','track')),
        domain TEXT NOT NULL CHECK (domain IN ('video','audio')),
        stream_id TEXT, tmdb_id TEXT, media TEXT, platform TEXT, track_id TEXT,
        title TEXT NOT NULL, poster TEXT, artist TEXT, album TEXT,
        duration_s REAL, source_url TEXT, first_collected_at INTEGER NOT NULL
      );
      CREATE TABLE collection (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL CHECK (domain IN ('video','audio')),
        label TEXT NOT NULL,
        system TEXT CHECK (system IS NULL OR system IN ('following','liked')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE collection_item (
        collection_id TEXT NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
        item_key TEXT NOT NULL REFERENCES collected_item(key),
        added_at INTEGER NOT NULL,
        PRIMARY KEY (collection_id, item_key)
      );
      INSERT INTO collection VALUES ('col_audio_liked','audio','我的喜欢','liked','2026-07-20','2026-07-20');
      INSERT INTO collected_item (key,kind,domain,platform,track_id,title,first_collected_at)
        VALUES ('track:netease:1','track','audio','netease','1','老歌',1721400000000);
      INSERT INTO collection_item VALUES ('col_audio_liked','track:netease:1',1721400000000);
    `)
    raw.close()

    // 第一次打开:触发迁移
    const store1 = new CollectionsStore(dbPath)
    const col = store1.createCollection('audio', 'S')
    store1.addItem(col.id, { kind: 'episode', streamId: 'p', itemId: 'e1' }, { title: 'E1' })
    store1.close()

    // 第二次打开同一份已迁移文件:guard 应短路,不重建、不炸,老数据和刚插的 episode 都还在
    const store2 = new CollectionsStore(dbPath)
    try {
      expect(store2.getItem({ kind: 'track', platform: 'netease', trackId: '1' })).toMatchObject({ title: '老歌', firstCollectedAt: 1721400000000 })
      expect(store2.isIn('col_audio_liked', { kind: 'track', platform: 'netease', trackId: '1' })).toBe(true)
      expect(store2.getItem({ kind: 'episode', streamId: 'p', itemId: 'e1' })).toMatchObject({ title: 'E1' })
      expect(store2.isIn(col.id, { kind: 'episode', streamId: 'p', itemId: 'e1' })).toBe(true)
      // 迁移后的 DB 仍能正常插入新 episode
      store2.addItem(col.id, { kind: 'episode', streamId: 'p', itemId: 'e2' }, { title: 'E2' })
      expect(store2.getItem({ kind: 'episode', streamId: 'p', itemId: 'e2' })).not.toBeNull()
    } finally { store2.close() }
  })
})

describe('anchored collections + batch addItems (2026-07-24)', () => {
  it('creates an anchored collection and filters by anchor', () => {
    const store = new CollectionsStore(':memory:')
    try {
      const a = store.createCollection('audio', '系列A', 'pod-a')
      store.createCollection('audio', '全局单')
      expect(a.anchorStreamId).toBe('pod-a')
      expect(store.listCollections('audio', 'pod-a').map((c) => c.id)).toEqual([a.id])
      expect(store.listCollections('audio').map((c) => c.id)).toContain(a.id) // 全局列表照旧返回(双入口后路)
      expect(store.listCollections('audio', 'pod-nope')).toEqual([])
    } finally { store.close() }
  })

  // ---- 手动排序 ----
  //
  // 位置只落在 collection_item 上：手动序是**用户自己编排**这件事的属性,只有用户建的列表和
  // 「我的喜欢」这类系统列表有它。节目源自带的集列表按其固有顺序,不经过这张表,自然拿不到。

  it('迁移一个没有 position 列的老库：每个列表的顺序与迁移前逐条相同', () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-pos-mig-'))
    const dbPath = join(dir, 'c.db')
    const raw = new Database(dbPath)
    // 老 schema：collection_item 没有 position 列
    raw.exec(`
      CREATE TABLE collected_item (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('stream','tmdb','track','episode')),
        domain TEXT NOT NULL CHECK (domain IN ('video','audio')),
        stream_id TEXT, tmdb_id TEXT, media TEXT, platform TEXT, track_id TEXT, item_id TEXT,
        title TEXT NOT NULL, poster TEXT, artist TEXT, album TEXT,
        duration_s REAL, source_url TEXT, first_collected_at INTEGER NOT NULL
      );
      CREATE TABLE collection (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL CHECK (domain IN ('video','audio')),
        label TEXT NOT NULL,
        system TEXT CHECK (system IS NULL OR system IN ('following','liked')),
        anchor_stream_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE collection_item (
        collection_id TEXT NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
        item_key TEXT NOT NULL REFERENCES collected_item(key),
        added_at INTEGER NOT NULL,
        PRIMARY KEY (collection_id, item_key)
      );
      INSERT INTO collection VALUES ('c1','audio','单甲',NULL,NULL,'2026-07-20','2026-07-20');
      INSERT INTO collection VALUES ('c2','audio','单乙',NULL,NULL,'2026-07-20','2026-07-20');
    `)
    // 两个列表各灌几条,故意让 added_at 有重复(逼出 key 这个次序 tiebreaker)
    const seed: Array<[string, string, number]> = [
      ['c1', 'episode:p:a', 300], ['c1', 'episode:p:b', 100], ['c1', 'episode:p:c', 200],
      ['c1', 'episode:p:d', 300], // 与 a 同 added_at → 只能靠 key 决定
      ['c2', 'episode:q:x', 500], ['c2', 'episode:q:y', 400],
    ]
    for (const [, key] of seed.map((s) => [s[0], s[1]] as const)) {
      raw.prepare(`INSERT OR IGNORE INTO collected_item (key,kind,domain,stream_id,item_id,title,first_collected_at)
                   VALUES (?, 'episode','audio','p', ?, ?, 0)`).run(key, key, key)
    }
    for (const [cid, key, at] of seed) raw.prepare('INSERT INTO collection_item VALUES (?,?,?)').run(cid, key, at)

    // 迁移前的真值：**用老查询自己算一遍**,而不是手写一份期望(手写的那份可能恰好抄错)
    const expected = (cid: string) =>
      raw.prepare(`SELECT i.key FROM collection_item ci JOIN collected_item i ON i.key = ci.item_key
                   WHERE ci.collection_id = ? ORDER BY ci.added_at DESC, i.key DESC`).all(cid).map((r: any) => r.key)
    const before = { c1: expected('c1'), c2: expected('c2') }
    raw.close()

    const store = new CollectionsStore(dbPath)
    try {
      expect(store.itemsOf('c1').map((i) => i.key)).toEqual(before.c1)
      expect(store.itemsOf('c2').map((i) => i.key)).toEqual(before.c2)
      // 幂等：再开一次不该把顺序搅乱(迁移探测到列已在就跳过)
      store.close()
      const again = new CollectionsStore(dbPath)
      expect(again.itemsOf('c1').map((i) => i.key)).toEqual(before.c1)
      again.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('新加入的成员排在最前——和手动排序之前的行为一致(最近加入的在上面)', () => {
    const store = new CollectionsStore(':memory:')
    try {
      const col = store.createCollection('audio', 'S')
      store.addItem(col.id, { kind: 'episode', streamId: 'p', itemId: 'e1' }, { title: 'E1' })
      store.addItem(col.id, { kind: 'episode', streamId: 'p', itemId: 'e2' }, { title: 'E2' })
      expect(store.itemsOf(col.id).map((i) => i.itemId)).toEqual(['e2', 'e1'])

      // 手动排过之后,新成员**仍然**落在最前——用户排的是已有那些,新东西不该被塞到看不见的队尾
      store.reorder(col.id, ['episode:p:e1', 'episode:p:e2'])
      store.addItem(col.id, { kind: 'episode', streamId: 'p', itemId: 'e3' }, { title: 'E3' })
      expect(store.itemsOf(col.id).map((i) => i.itemId)).toEqual(['e3', 'e1', 'e2'])
    } finally { store.close() }
  })

  it('reorder 按给定顺序落库,重开一次仍然是它(位置是存下来的,不是算出来的)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-pos-'))
    const dbPath = join(dir, 'c.db')
    const store = new CollectionsStore(dbPath)
    let colId = ''
    try {
      const col = store.createCollection('audio', 'S')
      colId = col.id
      for (const n of ['e1', 'e2', 'e3']) store.addItem(col.id, { kind: 'episode', streamId: 'p', itemId: n }, { title: n })
      store.reorder(col.id, ['episode:p:e2', 'episode:p:e3', 'episode:p:e1'])
      expect(store.itemsOf(col.id).map((i) => i.itemId)).toEqual(['e2', 'e3', 'e1'])
    } finally { store.close() }
    const reopened = new CollectionsStore(dbPath)
    try {
      expect(reopened.itemsOf(colId).map((i) => i.itemId)).toEqual(['e2', 'e3', 'e1'])
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reorder 只接受完整的一份名单——缺一个/多一个/有重复都拒绝,且一个字节都不写', () => {
    const store = new CollectionsStore(':memory:')
    try {
      const col = store.createCollection('audio', 'S')
      for (const n of ['e1', 'e2', 'e3']) store.addItem(col.id, { kind: 'episode', streamId: 'p', itemId: n }, { title: n })
      const original = store.itemsOf(col.id).map((i) => i.key)

      // 半份名单最危险：真按它写下去,没列出的那些位置就成了垃圾,而调用方以为自己只动了两条
      expect(() => store.reorder(col.id, ['episode:p:e2', 'episode:p:e1'])).toThrow(/incomplete|完整/i)
      expect(() => store.reorder(col.id, ['episode:p:e1', 'episode:p:e2', 'episode:p:e3', 'episode:p:e9'])).toThrow()
      expect(() => store.reorder(col.id, ['episode:p:e1', 'episode:p:e1', 'episode:p:e2'])).toThrow()
      expect(store.itemsOf(col.id).map((i) => i.key)).toEqual(original) // 三次拒绝之后原样未动
    } finally { store.close() }
  })

  it('系统列表(「我的喜欢」)同样能排——它和自建播单是同一种东西,没有"系统列表不给排"这条规矩', () => {
    const store = new CollectionsStore(':memory:')
    try {
      const liked = SYSTEM_COLLECTIONS.audioLiked
      for (const n of ['1', '2', '3']) store.addItem(liked, { kind: 'track', platform: 'netease', trackId: n }, { title: `歌${n}` })
      expect(store.itemsOf(liked).map((i) => i.trackId)).toEqual(['3', '2', '1'])
      store.reorder(liked, ['track:netease:1', 'track:netease:3', 'track:netease:2'])
      expect(store.itemsOf(liked).map((i) => i.trackId)).toEqual(['1', '3', '2'])
    } finally { store.close() }
  })

  it('两个列表各排各的——同一个东西在别的列表里的位置不受影响', () => {
    const store = new CollectionsStore(':memory:')
    try {
      const a = store.createCollection('audio', 'A')
      const b = store.createCollection('audio', 'B')
      for (const n of ['e1', 'e2']) {
        store.addItem(a.id, { kind: 'episode', streamId: 'p', itemId: n }, { title: n })
        store.addItem(b.id, { kind: 'episode', streamId: 'p', itemId: n }, { title: n })
      }
      store.reorder(a.id, ['episode:p:e1', 'episode:p:e2'])
      expect(store.itemsOf(a.id).map((i) => i.itemId)).toEqual(['e1', 'e2'])
      expect(store.itemsOf(b.id).map((i) => i.itemId)).toEqual(['e2', 'e1']) // B 还是"最近加入在前"
    } finally { store.close() }
  })

  it('移出一个成员之后,余下的顺序不变(不需要重排,也不留空洞)', () => {
    const store = new CollectionsStore(':memory:')
    try {
      const col = store.createCollection('audio', 'S')
      for (const n of ['e1', 'e2', 'e3']) store.addItem(col.id, { kind: 'episode', streamId: 'p', itemId: n }, { title: n })
      store.reorder(col.id, ['episode:p:e3', 'episode:p:e1', 'episode:p:e2'])
      store.removeItem(col.id, { kind: 'episode', streamId: 'p', itemId: 'e1' })
      expect(store.itemsOf(col.id).map((i) => i.itemId)).toEqual(['e3', 'e2'])
    } finally { store.close() }
  })

  it('addItems is transactional and idempotent', () => {
    const store = new CollectionsStore(':memory:')
    try {
      const col = store.createCollection('audio', 'S', 'pod-a')
      const items = [
        { key: { kind: 'episode' as const, streamId: 'pod-a', itemId: 'e1' }, meta: { title: 'E1' } },
        { key: { kind: 'episode' as const, streamId: 'pod-b', itemId: 'e2' }, meta: { title: 'E2' } }, // 跨 stream 成员合法
      ]
      const saved = store.addItems(col.id, items)
      expect(saved.map((s) => s.key)).toEqual(['episode:pod-a:e1', 'episode:pod-b:e2'])
      store.addItems(col.id, items) // 重复整批 → 幂等
      expect(store.itemsOf(col.id)).toHaveLength(2)
    } finally { store.close() }
  })
})
