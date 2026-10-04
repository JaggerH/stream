import { describe, expect, it } from 'vitest'
import type { LyricsCacheEntry } from './archive.ts'
import { withLyricsCache, type LyricsCache } from './lyrics-cache.ts'

function fakeCache(): LyricsCache & { store: Map<string, LyricsCacheEntry> } {
  const store = new Map<string, LyricsCacheEntry>()
  return {
    store,
    getLyricsCache: (key) => store.get(key) ?? null,
    putLyricsCache: (key, entry) => { store.set(key, entry) },
  }
}

describe('withLyricsCache', () => {
  it('命中 → 不跑梯子，回执 source 是 lyrics-cache', async () => {
    const cache = fakeCache()
    const entry = { matched: true, songId: '1', lrc: '[00:00.00]x' }
    cache.store.set('pkg:1', entry)
    let ran = false
    const out = await withLyricsCache(cache, 'pkg:1', async () => { ran = true; return null })
    expect(ran).toBe(false)
    expect(out).toEqual({ source: 'lyrics-cache', items: [entry] })
  })

  it('未命中 → 跑梯子并写回', async () => {
    const cache = fakeCache()
    const entry = { matched: true, songId: '1', lrc: 'x' }
    const out = await withLyricsCache(cache, 'pkg:1', async () => ({ source: 's', items: [entry] }))
    expect(out).toEqual({ source: 's', items: [entry] })
    expect(cache.store.get('pkg:1')).toEqual(entry)
  })

  // miss 是**源给出的判决**（"这首歌查不到歌词"），不是"没人回答"——它必须写回，
  // 否则每一次播放都会把同一首查不到的歌再问一遍上游，而 7 天 TTL 那一格形同虚设。
  it('miss（matched:false）也写回', async () => {
    const cache = fakeCache()
    await withLyricsCache(cache, 'nosong::noartist', async () => ({ source: 's', items: [{ matched: false }] }))
    expect(cache.store.get('nosong::noartist')).toEqual({ matched: false })
  })

  it('梯子一条都没答上（null）→ 不写（那是"没配源"，不是"这首歌没歌词"）', async () => {
    const cache = fakeCache()
    const out = await withLyricsCache(cache, 'pkg:1', async () => null)
    expect(out).toBeNull()
    expect(cache.store.size).toBe(0)
  })

  it('源没给判决（items[0] 里没有 matched）→ 不写', async () => {
    const cache = fakeCache()
    await withLyricsCache(cache, 'pkg:1', async () => ({ source: 's', items: [{ lrc: 'x' }] }))
    expect(cache.store.size).toBe(0)
  })

  it('key 两侧空白被归一化——两侧不一致就永远命不中', async () => {
    const cache = fakeCache()
    cache.store.set('pkg:1', { matched: true, songId: '1', lrc: 'x' })
    const out = await withLyricsCache(cache, '  pkg:1  ', async () => null)
    expect(out).toEqual({ source: 'lyrics-cache', items: [{ matched: true, songId: '1', lrc: 'x' }] })
  })

  // 缓存和梯子必须拿到**同一个** key。分家的话写回用的键不是源真查的那个字符串，
  // `" x"` 和 `"x"` 各占一格、互相命不中，而两条路单看都正常。
  it('归一化后的 key 也是递给梯子的那个', async () => {
    const cache = fakeCache()
    const seen: string[] = []
    await withLyricsCache(cache, '  pkg:1  ', async (k) => { seen.push(k); return { source: 's', items: [{ matched: false }] } })
    expect(seen).toEqual(['pkg:1'])
    expect(cache.store.get('pkg:1')).toEqual({ matched: false })
  })

  it('没有缓存 → 直接跑梯子', async () => {
    const out = await withLyricsCache(undefined, 'pkg:1', async () => ({ source: 's', items: [{ matched: true }] }))
    expect(out).toEqual({ source: 's', items: [{ matched: true }] })
  })
})
