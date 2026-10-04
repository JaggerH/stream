import { existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import type Database from 'better-sqlite3'

/** 删除已被移除子系统留下的孤儿文件（flow/binding 系统已删；targets.json 一次性导入与
 *  standing-subscription 引擎已删——subscriptions.json/targets.json* 是它们的遗骸；
 *  dedup.db 是 0 字节默认路径残留）。 */
export function cleanOrphanDbs(dataDir: string): string[] {
  const removed: string[] = []
  const corpses = [
    'flows.db', 'flows.db-wal', 'flows.db-shm', 'audio-archive.db.premusi',
    'subscriptions.json', 'targets.json.imported',
  ]
  for (const f of corpses) {
    const p = join(dataDir, f)
    if (existsSync(p)) { rmSync(p, { force: true }); removed.push(f) }
  }
  const dedup = join(dataDir, 'dedup.db')
  if (existsSync(dedup) && statSync(dedup).size === 0) { rmSync(dedup, { force: true }); removed.push('dedup.db') }
  if (removed.length) console.info(`[import-legacy] removed orphan dbs: ${removed.join(', ')}`)
  return removed
}

function qid(id: string): string {
  return `"${id.replace(/"/g, '""')}"`
}

function tableColumns(db: Database.Database, table: string, schema?: string): string[] {
  const pragma = schema ? `PRAGMA ${qid(schema)}.table_info(${qid(table)})` : `PRAGMA table_info(${qid(table)})`
  return (db.prepare(pragma).all() as { name: string }[]).map((c) => c.name)
}

function importedPath(path: string): string {
  return `${path}.imported`
}

/** Adopt rows from a retired sqlite file into the current database, then mark it imported. */
export function adoptLegacyDb(
  db: Database.Database,
  legacyPath: string,
  copies: { from: string; to: string }[]
): boolean {
  if (!existsSync(legacyPath)) return false
  for (const copy of copies) {
    const count = db.prepare(`SELECT COUNT(*) AS n FROM ${qid(copy.to)}`).get() as { n: number }
    if (count.n > 0) return false
  }

  db.prepare('ATTACH DATABASE ? AS legacy').run(legacyPath)
  try {
    const tx = db.transaction(() => {
      for (const copy of copies) {
        const fromCols = tableColumns(db, copy.from, 'legacy')
        const toCols = tableColumns(db, copy.to)
        if (fromCols.length === toCols.length && fromCols.every((col, i) => col === toCols[i])) {
          db.prepare(`INSERT INTO ${qid(copy.to)} SELECT * FROM legacy.${qid(copy.from)}`).run()
          continue
        }
        const shared = toCols.filter((col) => fromCols.includes(col))
        const cols = shared.map(qid).join(', ')
        db.prepare(`INSERT INTO ${qid(copy.to)} (${cols}) SELECT ${cols} FROM legacy.${qid(copy.from)}`).run()
      }
    })
    tx()
  } finally {
    db.exec('DETACH DATABASE legacy')
  }

  for (const path of [legacyPath, `${legacyPath}-wal`, `${legacyPath}-shm`]) {
    if (existsSync(path)) renameSync(path, importedPath(path))
  }
  return true
}

/** Phase-3 media-fence renames — 存量条目 json 里烘着旧代理路径。一次性，在 items.db 变成
 *  cache.db 的那一刻做。
 *
 *  这张表只收**存量 URL 会被读**的那几条（音频解析、图片代理）。视频不在其中：带
 *  `(provider, vid)` 的视频在播放时**现拼**地址（前端 `videoPlan.ts`），json 里烘着的旧视频
 *  URL 没有任何读者，给它加一行迁移只是替一条没人走的路背书。 */
const MEDIA_URL_REWRITES: [string, string][] = [
  ['/api/audio/resolve', '/api/media/tracks/resolve'],
  ['/api/img?', '/api/media/image?'],
]

/** items.db (105MB, regenerable) becomes data/cache.db by FILE RENAME — no row copying.
 *  One-time on the same boot: rewrite legacy media-proxy paths inside stored item json.
 *  Idempotent: no-op when cache.db already exists or the legacy file is gone. */
export function migrateCacheDb(legacyItemsPath: string, cachePath: string): boolean {
  if (existsSync(cachePath) || !existsSync(legacyItemsPath) || legacyItemsPath === cachePath) return false
  for (const [suffix, target] of [['', cachePath], ['-wal', `${cachePath}-wal`], ['-shm', `${cachePath}-shm`]] as const) {
    const src = `${legacyItemsPath}${suffix}`
    if (existsSync(src)) renameSync(src, target)
  }
  const db = new BetterSqlite3(cachePath)
  try {
    db.pragma('journal_mode = WAL')
    const expr = MEDIA_URL_REWRITES.reduce((acc, [from, to]) => `replace(${acc}, '${from}', '${to}')`, 'json')
    const like = MEDIA_URL_REWRITES.map(([from]) => `json LIKE '%${from}%'`).join(' OR ')
    const changed = db.prepare(`UPDATE items SET json = ${expr} WHERE ${like}`).run().changes
    console.info(`[import-legacy] items.db → cache.db (renamed); rewrote legacy media urls in ${changed} items`)
  } finally {
    db.close()
  }
  return true
}
