import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserStore } from '../store/user-store.ts'
import type { ProviderRecord } from '../store/types.ts'
import { ProviderDirectory } from './directory.ts'
import { ensureSystemRows } from './seed.ts'
import { SYSTEM_IDENTITIES } from './system/index.ts'

/** 用户自建行的骨架：身份**在行上**（没有代码给它身份），所以 `serves` 是它的真相。 */
function userRow(partial: Partial<ProviderRecord> & { id: string }): ProviderRecord {
  return {
    label: partial.id, description: partial.id, category: 'resolve', serves: [],
    strategy: 'sequential', members: [], contract: null, options: {}, ...partial,
  }
}

describe('ProviderDirectory', () => {
  let dir: string
  let store: UserStore
  let directory: ProviderDirectory

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'provider-directory-'))
    store = new UserStore(join(dir, 'stream.db'))
    ensureSystemRows(store) // 23 条系统行落库，身份原样进列（'*' 照旧进 serves 列）
    directory = new ProviderDirectory(store, SYSTEM_IDENTITIES)
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('match', () => {
    it('returns the specific rows and never mixes the fallback row in', () => {
      // transform category 里 article-extract 认具名键 'article'、fetch-url 是兜底行。
      const hit = directory.match('transform', 'article', { fallback: true })
      expect(hit.map((m) => m.row.id)).toEqual(['article-extract'])
      expect(hit.every((m) => m.viaFallback === false)).toBe(true)
    })

    it('falls back only when nothing specific matched — and says so', () => {
      const hit = directory.match('transform', 'no-such-key', { fallback: true })
      expect(hit.map((m) => m.row.id)).toEqual(['fetch-url'])
      expect(hit.every((m) => m.viaFallback === true)).toBe(true)
    })

    it('returns nothing when the caller refuses the fallback', () => {
      // netdisk 三个守门要的就是这一档：宁可无人应答，也不要一个「什么都服务」的行冒名顶替。
      expect(directory.match('transform', 'no-such-key', { fallback: false })).toEqual([])
      // 具名命中不受影响。
      expect(directory.match('transform', 'article', { fallback: false }).map((m) => m.row.id))
        .toEqual(['article-extract'])
    })

    it('never crosses categories — same key under another category does not match', () => {
      // 'article' 是 transform 的键；resolve 下同名键无人应答，兜底也只找 resolve 自己的兜底行
      // （今天 resolve 一条兜底行都没有）。
      expect(directory.match('resolve', 'article', { fallback: true })).toEqual([])
    })

    it('excludes parked rows from both active() and match()', () => {
      store.putProvider(userRow({ id: 'zz-parked', serves: ['download'], options: { parked: true } }))
      expect(directory.catalog().map((p) => p.id)).toContain('zz-parked')
      expect(directory.active().map((p) => p.id)).not.toContain('zz-parked')
      expect(directory.match('resolve', 'download', { fallback: false }).map((m) => m.row.id))
        .toEqual(['download-resolve'])
    })

    it('counts a mixed `serves:[key, "*"]` user row in both lanes', () => {
      store.putProvider(userRow({ id: 'zz-mixed', category: 'resolve', serves: ['zz-key', '*'] }))
      const specific = directory.match('resolve', 'zz-key', { fallback: false })
      expect(specific.map((m) => m.row.id)).toEqual(['zz-mixed'])
      expect(specific[0].viaFallback).toBe(false)
      const viaFallback = directory.match('resolve', 'other-key', { fallback: true })
      expect(viaFallback.map((m) => m.row.id)).toEqual(['zz-mixed'])
      expect(viaFallback[0].viaFallback).toBe(true)
    })

    it('keeps listProviders order (ORDER BY id), not an order of its own', () => {
      store.putProvider(userRow({ id: 'aaa-video', category: 'search', serves: ['video'] }))
      store.putProvider(userRow({ id: 'zzz-video', category: 'search', serves: ['video'] }))
      expect(directory.match('search', 'video', { fallback: false }).map((m) => m.row.id))
        .toEqual(['aaa-video', 'video-search', 'zzz-video'])
    })
  })

  describe('identity', () => {
    it('reads system rows from code and user rows from the row', () => {
      expect(directory.serveKeysOf('download-resolve')).toEqual(['download'])
      // 兜底行的具名键是空的——'*' 不是一个键。
      expect(directory.serveKeysOf('fetch-url')).toEqual([])
      store.putProvider(userRow({ id: 'zz-user', serves: ['zz-key', '*'] }))
      expect(directory.serveKeysOf('zz-user')).toEqual(['zz-key'])
    })

    it('isFallback reads the same identity — code for system rows, the row for user rows', () => {
      expect(directory.isFallback(directory.get('fetch-url')!)).toBe(true)
      expect(directory.isFallback(directory.get('article-extract')!)).toBe(false)
      store.putProvider(userRow({ id: 'zz-fallback', serves: ['zz-key', '*'] }))
      expect(directory.isFallback(directory.get('zz-fallback')!)).toBe(true)
    })

    it('knows a system identity even when no row exists yet', () => {
      // transcribe 今天不在 seed 里，库里没有它的行——身份不依赖行存在。
      expect(directory.get('transcribe')).toBeNull()
      expect(directory.isSystem('transcribe')).toBe(true)
      expect(directory.serveKeysOf('transcribe')).toEqual([])
      expect(directory.isSystem('zz-nobody')).toBe(false)
      expect(directory.serveKeysOf('zz-nobody')).toEqual([])
    })

    it('code wins over a stale identity stored on a system row', () => {
      store.patchProvider('article-extract', { serves: ['stale-key', '*'] })
      expect(directory.serveKeysOf('article-extract')).toEqual(['article'])
      expect(directory.match('transform', 'stale-key', { fallback: true }).map((m) => m.row.id))
        .toEqual(['fetch-url']) // 陈旧键无人认领 → 落兜底，而不是被那行冒领
      expect(directory.servesKey(directory.get('article-extract')!, 'article', { fallback: false })).toBe(true)
    })

    it('servesKey answers per row, with the fallback lane gated by opts', () => {
      const fetchUrl = directory.get('fetch-url')!
      expect(directory.servesKey(fetchUrl, 'anything', { fallback: true })).toBe(true)
      expect(directory.servesKey(fetchUrl, 'anything', { fallback: false })).toBe(false)
      const articleExtract = directory.get('article-extract')!
      expect(directory.servesKey(articleExtract, 'article', { fallback: false })).toBe(true)
      expect(directory.servesKey(articleExtract, 'anything', { fallback: true })).toBe(false)
    })
  })

  describe('wireServes', () => {
    it('re-synthesises every seeded row byte-for-byte', () => {
      // 「线上形状不变」的证据：拆成 serveKeys+fallback 再合回去，与库里落的那一份逐字相同。
      for (const row of store.listProviders()) {
        expect(directory.wireServes(directory.get(row.id)!), row.id).toEqual(row.serves)
      }
    })

    it('appends the fallback key at the end for a user row', () => {
      store.putProvider(userRow({ id: 'zz-mixed', serves: ['zz-key', '*'] }))
      expect(directory.wireServes(directory.get('zz-mixed')!)).toEqual(['zz-key', '*'])
      store.putProvider(userRow({ id: 'zz-plain', serves: ['zz-key'] }))
      expect(directory.wireServes(directory.get('zz-plain')!)).toEqual(['zz-key'])
    })
  })
})
