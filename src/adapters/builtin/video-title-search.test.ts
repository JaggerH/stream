import { describe, expect, it } from 'vitest'
import { makeTmdbTitleSearchFn, tmdbSearchHit } from './video-title-search.ts'

describe('tmdbSearchHit', () => {
  it('maps a movie hit to a work reference with year/poster/tmdb id + projections', () => {
    expect(tmdbSearchHit({
      media_type: 'movie', id: 693134, title: '沙丘2', release_date: '2024-02-27',
      poster_path: '/abc.jpg', vote_average: 8.1, overview: '保罗的复仇。',
    })).toEqual({
      title: '沙丘2', kind: 'movie', year: 2024, poster: 'https://image.tmdb.org/t/p/original/abc.jpg',
      externalIds: { tmdb: '693134' }, rating: 8.1, overview: '保罗的复仇。',
    })
  })

  it('maps a tv hit to kind:series using name + first_air_date', () => {
    expect(tmdbSearchHit({ media_type: 'tv', id: 1399, name: '权力的游戏', first_air_date: '2011-04-17' }))
      .toEqual({ title: '权力的游戏', kind: 'series', year: 2011, externalIds: { tmdb: '1399' } })
  })

  it('drops person hits and titleless rows', () => {
    expect(tmdbSearchHit({ media_type: 'person', id: 1, name: '基努' })).toBeNull()
    expect(tmdbSearchHit({ media_type: 'movie', id: 2 })).toBeNull()
    expect(tmdbSearchHit({ media_type: 'movie', title: 'A' })).toBeNull() // no id
  })
})

describe('makeTmdbTitleSearchFn', () => {
  const context = { runtimeConfig: { apiKey: 'k', language: 'zh-CN' } }

  it('queries /search/multi and returns mapped hits (person filtered)', async () => {
    let calledUrl = ''
    const fetch = (async (url: string) => {
      calledUrl = url
      return { ok: true, json: async () => ({ results: [
        { media_type: 'movie', id: 1, title: 'A', release_date: '2020-01-01' },
        { media_type: 'person', id: 2, name: 'x' },
        { media_type: 'tv', id: 3, name: 'B', first_air_date: '2019-05-05' },
      ] }) }
    }) as unknown as (u: string) => Promise<Response>
    const fn = makeTmdbTitleSearchFn({ fetch })
    const out = await fn('沙丘', { keyword: '沙丘' }, context)
    expect(calledUrl).toContain('/search/multi?query=' + encodeURIComponent('沙丘'))
    expect(calledUrl).toContain('api_key=k')
    expect(out).toEqual([
      { title: 'A', kind: 'movie', year: 2020, externalIds: { tmdb: '1' } },
      { title: 'B', kind: 'series', year: 2019, externalIds: { tmdb: '3' } },
    ])
  })

  it('declines (returns []) on blank keyword or unconfigured TMDb key — never fetches', async () => {
    const fn = makeTmdbTitleSearchFn({ fetch: (async () => { throw new Error('should not fetch') }) as unknown as (u: string) => Promise<Response> })
    expect(await fn('', { keyword: '' }, context)).toEqual([])
    expect(await fn('x', { keyword: 'x' }, { runtimeConfig: {} })).toEqual([])
  })
})
