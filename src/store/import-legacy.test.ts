import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { adoptLegacyDb, cleanOrphanDbs, migrateCacheDb } from './import-legacy.ts'

describe('legacy store migrations', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'import-'))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('migrateCacheDb renames items.db and rewrites legacy media urls once', () => {
    const itemsPath = join(dir, 'items.db')
    const cachePath = join(dir, 'cache.db')
    const legacyDb = new Database(itemsPath)
    legacyDb.exec(`CREATE TABLE items (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      stream_id TEXT NOT NULL, type TEXT NOT NULL, timestamp TEXT, created_at TEXT NOT NULL, json TEXT NOT NULL);`)
    legacyDb.prepare(`INSERT INTO items (id, stream_id, type, timestamp, created_at, json) VALUES (?,?,?,?,?,?)`)
      .run('a', 's', 'post', 't', 't', JSON.stringify({ media: [{ url: '/api/img?u=x' }] }))
    legacyDb.close()

    expect(migrateCacheDb(itemsPath, cachePath)).toBe(true)
    expect(existsSync(itemsPath)).toBe(false)
    const cache = new Database(cachePath)
    const row = cache.prepare('SELECT json FROM items WHERE id = ?').get('a') as { json: string }
    cache.close()
    expect(row.json).toContain('/api/media/image?u=x')
    // idempotent: cache exists now → no-op
    expect(migrateCacheDb(itemsPath, cachePath)).toBe(false)
  })

  it('DedupStore adopts a legacy dedup file into cache.db', async () => {
    const { DedupStore } = await import('../dedup-store.ts')
    const legacyDedup = join(dir, 'dogfood-dedup.db')
    const seed = new Database(legacyDedup)
    seed.exec(`CREATE TABLE seen_items (id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, seen_at TEXT NOT NULL);`)
    seed.prepare('INSERT INTO seen_items VALUES (?,?,?)').run('x1', 's', 't')
    seed.close()
    const dedup = new DedupStore(join(dir, 'cache.db'), legacyDedup)
    expect(dedup.has('x1')).toBe(true)
    dedup.close()
    expect(existsSync(`${legacyDedup}.imported`)).toBe(true)
  })

  it('cleanOrphanDbs removes only the known corpses', () => {
    writeFileSync(join(dir, 'flows.db'), 'x')
    writeFileSync(join(dir, 'dedup.db'), '')
    writeFileSync(join(dir, 'subscriptions.json'), '[]')
    writeFileSync(join(dir, 'targets.json.imported'), '{}')
    writeFileSync(join(dir, 'keep.db'), 'x')
    const removed = cleanOrphanDbs(dir)
    expect(removed.sort()).toEqual(['dedup.db', 'flows.db', 'subscriptions.json', 'targets.json.imported'])
    expect(existsSync(join(dir, 'keep.db'))).toBe(true)
  })
})

describe('adoptLegacyDb store constructors', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adopt-db-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // adoptLegacyDb 本身：把某个独立库里的表搬进主库、只搬一次、搬完把旧文件改名。
  // （以前这两条用 ParseStore / TranscriptStore 当载体，那两个类已随 conversions 收敛退役——
  // 载体没了不代表机制没了，所以直接对着机制测，反而少一层间接。）
  it('adopts a legacy db into the main db once, then renames the legacy file', () => {
    const streamDb = join(dir, 'stream.db')
    const legacyDb = join(dir, 'parse_results.db')
    const legacy = new Database(legacyDb)
    legacy.exec(`
      CREATE TABLE parse_results (
        item_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        markdown TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO parse_results (item_id, status, markdown, updated_at)
      VALUES ('item-1', 'done', '# Parsed', '2026-07-02T00:00:00.000Z');
    `)
    legacy.close()

    const main = new Database(streamDb)
    main.exec('CREATE TABLE IF NOT EXISTS parses (item_id TEXT PRIMARY KEY, status TEXT NOT NULL, markdown TEXT, updated_at TEXT NOT NULL)')
    adoptLegacyDb(main, legacyDb, [{ from: 'parse_results', to: 'parses' }])
    expect(main.prepare('SELECT markdown FROM parses WHERE item_id = ?').get('item-1')).toEqual({ markdown: '# Parsed' })
    expect(existsSync(`${legacyDb}.imported`)).toBe(true) // 搬完改名 = 下次不再搬
    main.close()

    // 第二次开：旧文件已改名，什么都不该发生（尤其不该把已搬的行搬第二遍）
    const again = new Database(streamDb)
    adoptLegacyDb(again, legacyDb, [{ from: 'parse_results', to: 'parses' }])
    expect(again.prepare('SELECT COUNT(*) AS n FROM parses').get()).toEqual({ n: 1 })
    again.close()
  })

  it('leaves the main db alone when there is no legacy file at all (fresh install)', () => {
    const streamDb = join(dir, 'stream.db')
    const main = new Database(streamDb)
    main.exec('CREATE TABLE parses (item_id TEXT PRIMARY KEY, status TEXT NOT NULL)')
    expect(() => adoptLegacyDb(main, join(dir, 'nope.db'), [{ from: 'parse_results', to: 'parses' }])).not.toThrow()
    expect(main.prepare('SELECT COUNT(*) AS n FROM parses').get()).toEqual({ n: 0 })
    main.close()
  })
})
