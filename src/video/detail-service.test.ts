import { describe, expect, it, vi } from 'vitest'
import { mergeVideoDetail, VideoDetailService } from './detail-service.ts'
import type { VideoLookupIdentity } from './types.ts'

const identity: VideoLookupIdentity = { title: 'Example', year: 2024, kind: 'movie', externalIds: { tmdb: '1' } }

describe('mergeVideoDetail', () => {
  it('keeps earlier scalar values, fills blanks, deduplicates collections, and selects first images by kind', () => {
    const detail = mergeVideoDetail(identity, [
      { member: 'tmdb-metadata', value: [{ source: 'tmdb-metadata', title: 'TMDb title', overview: '', genres: ['Action'], people: [{ name: 'A', role: 'actor' }], externalIds: { tmdb: '1' } }] },
      { member: 'omdb-metadata', value: [{ source: 'omdb-metadata', title: 'OMDb title', overview: 'Filled', genres: ['Action', 'Comedy'], people: [{ name: 'A', role: 'actor' }, { name: 'B', role: 'director' }], externalIds: { imdb: 'tt1' } }] },
      { member: 'tmdb-images', value: [{ source: 'tmdb-images', images: [{ kind: 'poster', url: 'tmdb-poster' }, { kind: 'backdrop', url: 'tmdb-backdrop' }] }] },
      { member: 'omdb-images', value: [{ source: 'omdb-images', images: [{ kind: 'poster', url: 'omdb-poster' }] }] },
    ], [], '2026-07-14T00:00:00.000Z', '2026-07-15T00:00:00.000Z')

    expect(detail.metadata).toMatchObject({ title: 'TMDb title', overview: 'Filled', genres: ['Action', 'Comedy'], externalIds: { tmdb: '1', imdb: 'tt1' } })
    expect(detail.metadata?.people).toEqual([{ name: 'A', role: 'actor' }, { name: 'B', role: 'director' }])
    expect(detail.images).toEqual({ poster: { kind: 'poster', url: 'tmdb-poster', source: 'tmdb-images' }, backdrop: { kind: 'backdrop', url: 'tmdb-backdrop', source: 'tmdb-images' } })
  })
})

describe('VideoDetailService cache', () => {
  it('resolves canonical identity before enriching metadata and images', async () => {
    const calls: Array<{ provider: string; identity: VideoLookupIdentity }> = []
    const executor = {
      collect: async (provider: string, lookup: VideoLookupIdentity) => {
        calls.push({ provider, identity: lookup })
        if (provider === 'video-canonical') return {
          strategy: 'concurrent' as const, provider, results: [{ member: 'tmdb-canonical', value: [{ source: 'tmdb-canonical', externalIds: { tmdb: '42' }, kind: 'movie', title: 'Canonical Example', year: 2024 }] }], misses: [], timings: [],
        }
        if (provider === 'video-metadata') return {
          strategy: 'concurrent' as const, provider, results: [{ member: 'tmdb-metadata', value: [{ source: 'tmdb-metadata', title: 'Canonical Example', externalIds: { tmdb: '42', imdb: 'tt42' } }] }], misses: [], timings: [],
        }
        return {
          strategy: 'concurrent' as const, provider, results: [{ member: 'tmdb-images', value: [{ source: 'tmdb-images', images: [{ kind: 'poster', url: 'poster' }] }] }], misses: [], timings: [],
        }
      },
    }
    const service = new VideoDetailService({
      store: { getVideoDetail: () => null, putVideoDetail: (value) => value }, executor,
      now: () => '2026-07-14T12:00:00.000Z', ttlMs: 60_000,
    })

    const result = await service.get({ title: 'Discovery title', year: 2024, kind: 'movie', externalIds: {} })

    expect(calls.map((call) => call.provider)).toEqual(['video-canonical', 'video-metadata', 'video-images'])
    expect(calls[1]?.identity.externalIds).toEqual({ tmdb: '42' })
    expect(calls[2]?.identity.externalIds).toEqual({ tmdb: '42', imdb: 'tt42' })
    expect(result.detail.canonical).toMatchObject({ status: 'resolved', externalIds: { tmdb: '42' } })
  })

  it('persists a canonical miss and skips downstream enrichment', async () => {
    const collect = vi.fn(async () => ({
      strategy: 'concurrent' as const, provider: 'video-canonical', results: [], misses: [{ member: 'tmdb-canonical', reason: 'no verified match' }], timings: [],
    }))
    const entries = new Map<string, ReturnType<typeof mergeVideoDetail>>()
    const service = new VideoDetailService({
      store: { getVideoDetail: (key) => entries.get(key) ?? null, putVideoDetail: (value) => { entries.set(value.cacheKey, value); return value } }, executor: { collect },
      now: () => '2026-07-14T12:00:00.000Z', ttlMs: 60_000,
    })

    const result = await service.get({ title: 'Ambiguous', kind: 'movie', externalIds: {} })

    expect(collect).toHaveBeenCalledTimes(1)
    expect(collect).toHaveBeenCalledWith('video-canonical', expect.any(Object))
    expect(result.detail.canonical).toMatchObject({ status: 'miss', provider: 'video-canonical' })
    expect(result.detail.failures).toEqual([expect.objectContaining({ provider: 'video-canonical', member: 'tmdb-canonical' })])
    expect(entries.get(result.detail.cacheKey)).toEqual(result.detail)
  })

  it('replaces a cached detail with the verified empty result on an explicit refresh', async () => {
    const cached = mergeVideoDetail(identity, [], [], '2026-07-14T00:00:00.000Z', '2026-07-15T00:00:00.000Z')
    const entries = new Map([[cached.cacheKey, cached]])
    const executor = { collect: async () => ({ strategy: 'concurrent' as const, provider: 'video-metadata', results: [], misses: [{ member: 'tmdb-metadata', reason: 'offline' }], timings: [] }) }
    const service = new VideoDetailService({
      store: { getVideoDetail: (key: string) => entries.get(key) ?? null, putVideoDetail: (value) => { entries.set(value.cacheKey, value); return value } },
      executor,
      now: () => '2026-07-14T12:00:00.000Z', ttlMs: 60_000,
    })

    await expect(service.get(identity)).resolves.toEqual({ detail: cached, cache: 'hit' })
    const refreshed = await service.get(identity, { force: true })
    expect(refreshed.cache).toBe('refreshed')
    expect(refreshed.detail.metadata).toBeUndefined()
    expect(refreshed.detail.failures).toEqual(expect.arrayContaining([expect.objectContaining({ member: 'tmdb-metadata' })]))
    expect(entries.get(cached.cacheKey)).toEqual(refreshed.detail)
  })

  // 旧版 id 快速路径把调用方回显的 title（tmdb:<id> 详情路径没带提示时就是 id 本身）当官方名写进了
  // 缓存——「55157 (1993) [tmdbid-55157]」这个网盘目录就是它起的名。这类行不能再被 TTL 说了算。
  describe('tainted canonical self-heal', () => {
    const freshExecutor = () => ({
      collect: vi.fn(async (provider: string) => {
        if (provider === 'video-canonical') return {
          strategy: 'concurrent' as const, provider, results: [{ member: 'tmdb-canonical', value: [{ source: 'tmdb-canonical', externalIds: { tmdb: '55157' }, kind: 'movie' as const, title: 'Kika', year: 1993, matchedBy: 'id' as const }] }], misses: [], timings: [],
        }
        return { strategy: 'concurrent' as const, provider, results: [{ member: 'm', value: [{ source: 'm', title: 'Kika', externalIds: { tmdb: '55157' } }] }], misses: [], timings: [] }
      }),
    })
    const storeOf = (cached: ReturnType<typeof mergeVideoDetail>) => {
      const entries = new Map([[cached.cacheKey, cached]])
      return { entries, store: { getVideoDetail: (key: string) => entries.get(key) ?? null, putVideoDetail: (value: ReturnType<typeof mergeVideoDetail>) => { entries.set(value.cacheKey, value); return value } } }
    }
    const poisonedIdentity: VideoLookupIdentity = { title: '55157', kind: 'movie', externalIds: { tmdb: '55157' } }

    it('refetches a cached resolved canonical whose title is the tmdb id echoed back', async () => {
      const cached = mergeVideoDetail(poisonedIdentity, [], [], '2026-07-14T00:00:00.000Z', '2026-07-15T00:00:00.000Z', undefined,
        { status: 'resolved', provider: 'video-canonical', member: 'tmdb-canonical', source: 'tmdb-canonical', externalIds: { tmdb: '55157' }, kind: 'movie', title: '55157', matchedBy: 'id' })
      const { entries, store } = storeOf(cached)
      const executor = freshExecutor()
      const service = new VideoDetailService({ store, executor, now: () => '2026-07-14T12:00:00.000Z', ttlMs: 60_000 })

      const result = await service.get(poisonedIdentity)

      expect(executor.collect).toHaveBeenCalled()
      expect(result.cache).toBe('refreshed')
      expect(result.detail.canonical).toMatchObject({ status: 'resolved', title: 'Kika' })
      expect(entries.get(cached.cacheKey)?.canonical).toMatchObject({ title: 'Kika' })
    })

    it('refetches a cached canonical miss when the identity already carries the tmdb id', async () => {
      const cached = mergeVideoDetail(poisonedIdentity, [], [], '2026-07-14T00:00:00.000Z', '2026-07-15T00:00:00.000Z', undefined,
        { status: 'miss', provider: 'video-canonical' })
      const { store } = storeOf(cached)
      const executor = freshExecutor()
      const service = new VideoDetailService({ store, executor, now: () => '2026-07-14T12:00:00.000Z', ttlMs: 60_000 })

      const result = await service.get(poisonedIdentity)

      expect(executor.collect).toHaveBeenCalled()
      expect(result.detail.canonical).toMatchObject({ status: 'resolved', title: 'Kika' })
    })

    it('keeps serving a cached resolved canonical with a real title as a plain hit', async () => {
      const cached = mergeVideoDetail(poisonedIdentity, [], [], '2026-07-14T00:00:00.000Z', '2026-07-15T00:00:00.000Z', undefined,
        { status: 'resolved', provider: 'video-canonical', member: 'tmdb-canonical', source: 'tmdb-canonical', externalIds: { tmdb: '55157' }, kind: 'movie', title: 'Kika', matchedBy: 'id' })
      const { store } = storeOf(cached)
      const executor = freshExecutor()
      const service = new VideoDetailService({ store, executor, now: () => '2026-07-14T12:00:00.000Z', ttlMs: 60_000 })

      await expect(service.get(poisonedIdentity)).resolves.toEqual({ detail: cached, cache: 'hit' })
      expect(executor.collect).not.toHaveBeenCalled()
    })
  })
})
