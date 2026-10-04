/**
 * RSSHub 长尾目录（~3900 条路由）的本地缓存。
 *
 * **为什么要缓存**：这份目录以前只跟着开发检出走（`assets/build/routes.json` 是检出的构建产物，
 * **不在 npm tarball 里**），所以发行安装上选源页永远只有 curated + recipe，长尾整段缺席
 * （活体 2026-09-04，win-test：`0 RSSHub catalog sources`）。数据本身是取得到的——RSSHub 的
 * `request('/api/namespace')` 返回的就是同一个对象，实测还更全（1981 ns / 3861 routes，
 * 检出那份 08-25 构建的只有 1670 / 3309）。
 *
 * **为什么不在开机时取**：取它要把 RSSHub worker 拉起来，实测 +168MB RSS、0.65s。worker 一旦
 * 起来就不会自己退，于是每个从不碰 RSSHub 源的用户都白背这 168MB。所以时机选在**一次真的
 * RSSHub 取数之后**：那时 worker 已经热着，代价只剩 67ms 加一次写盘。
 *
 * 缓存过期只是"该再取一次"的信号，**不是"不能用"**：过期的目录照常挂上去，长尾少几条新路由
 * 远好过一个空目录。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 多久之后该重取一次。RSSHub 的路由表是天级变化的，一周足够新。 */
export const CATALOG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function catalogCachePath(dataDir: string): string {
  return join(dataDir, 'rsshub-routes.json')
}

/** 读缓存；没有 / 坏了都返回 null（坏了不该让后端起不来，重取一次就好）。 */
export function readCatalogCache(dataDir: string): { data: Record<string, unknown>; ageMs: number } | null {
  const path = catalogCachePath(dataDir)
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    return { data, ageMs: Date.now() - statSync(path).mtimeMs }
  } catch {
    return null
  }
}

export function writeCatalogCache(dataDir: string, data: unknown): void {
  writeFileSync(catalogCachePath(dataDir), JSON.stringify(data))
}

/** 「现在该重取一次吗」——没缓存、或缓存过期了。 */
export function catalogNeedsRefresh(dataDir: string, ttlMs: number = CATALOG_CACHE_TTL_MS): boolean {
  const cached = readCatalogCache(dataDir)
  return !cached || cached.ageMs > ttlMs
}
