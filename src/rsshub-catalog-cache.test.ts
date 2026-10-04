import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CATALOG_CACHE_TTL_MS,
  catalogCachePath,
  catalogNeedsRefresh,
  readCatalogCache,
  writeCatalogCache,
} from './rsshub-catalog-cache.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rsshub-catalog-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const ageFile = (path: string, ms: number) => {
  const t = (Date.now() - ms) / 1000
  utimesSync(path, t, t)
}

describe('RSSHub 长尾目录缓存', () => {
  it('没缓存 → 读到 null，且该重取', () => {
    expect(readCatalogCache(dir)).toBeNull()
    expect(catalogNeedsRefresh(dir)).toBe(true)
  })

  it('写了就读得回来，且新写的不该重取', () => {
    writeCatalogCache(dir, { bilibili: { routes: {} } })
    expect(readCatalogCache(dir)?.data).toEqual({ bilibili: { routes: {} } })
    expect(catalogNeedsRefresh(dir)).toBe(false)
  })

  it('过了 TTL → 该重取（但缓存仍然读得出来，旧目录照挂）', () => {
    writeCatalogCache(dir, { bilibili: { routes: {} } })
    ageFile(catalogCachePath(dir), CATALOG_CACHE_TTL_MS + 60_000)
    expect(catalogNeedsRefresh(dir)).toBe(true)
    expect(readCatalogCache(dir)?.data).toEqual({ bilibili: { routes: {} } })
  })

  it('缓存坏了 → null + 该重取，而不是抛（它在启动路径上，抛就是后端起不来）', () => {
    writeFileSync(catalogCachePath(dir), '{ not json')
    expect(readCatalogCache(dir)).toBeNull()
    expect(catalogNeedsRefresh(dir)).toBe(true)
  })

  it('缓存是个数组 / 非对象 → 当没有（RSSHub 的目录一定是个命名空间字典）', () => {
    writeFileSync(catalogCachePath(dir), '[1,2,3]')
    expect(readCatalogCache(dir)).toBeNull()
  })

  it('落盘的是原样那份，不是解析后的 manifest（下次开机还得能解析它）', () => {
    const raw = { bilibili: { name: 'bilibili', routes: { '/user/:uid': { path: '/user/:uid', name: '用户' } } } }
    writeCatalogCache(dir, raw)
    expect(JSON.parse(readFileSync(catalogCachePath(dir), 'utf8'))).toEqual(raw)
  })
})
