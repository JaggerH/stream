import { describe, expect, it, vi } from 'vitest'
import {
  makeTmdbImagesFn,
  makeTmdbMetadataFn,
} from './video-metadata.ts'

const identity = { title: 'The Fall Guy', year: 2024, kind: 'movie' as const, externalIds: {} }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('video metadata builtin sources', () => {
  it('sends a configured v3 API key as the api_key query parameter', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => json({ id: 42, title: 'Example' }))
    const source = makeTmdbMetadataFn({ getSettings: () => ({ tmdbApiKey: 'v3-secret' }), fetch })

    await source({ title: 'Example', kind: 'movie', externalIds: { tmdb: '42' } }, {})

    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toContain('api_key=v3-secret')
    expect(init?.headers).not.toHaveProperty('Authorization')
  })

  it('normalizes TMDb movie details without exposing its key', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => json({
      id: 746036, title: 'The Fall Guy', original_title: 'The Fall Guy', release_date: '2024-05-03',
      runtime: 126, overview: 'A stuntman.', tagline: 'Action!', genres: [{ name: 'Action' }],
      vote_average: 7.1, vote_count: 100, external_ids: { imdb_id: 'tt1684562' },
      credits: { cast: [{ name: 'Ryan Gosling', character: 'Colt', profile_path: '/gosling.jpg' }], crew: [{ name: 'David Leitch', job: 'Director' }] },
    }))
    const source = makeTmdbMetadataFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch })

    // A headshot is a tile, not a full-bleed image: `original` costs ~5x h632 apiece and a whole
    // cast is dozens of them, so profiles must not follow the poster/backdrop base.
    await expect(source({ ...identity, externalIds: { tmdb: '746036' } }, {})).resolves.toEqual([{
      source: 'tmdb-metadata', title: 'The Fall Guy', originalTitle: 'The Fall Guy', releaseDate: '2024-05-03',
      year: 2024, runtimeMinutes: 126, overview: 'A stuntman.', tagline: 'Action!', genres: ['Action'],
      people: [{ name: 'Ryan Gosling', role: 'actor', character: 'Colt', image: 'https://image.tmdb.org/t/p/h632/gosling.jpg' }, { name: 'David Leitch', role: 'director' }],
      ratings: [{ source: 'tmdb', value: 7.1, scale: 10, votes: 100 }], externalIds: { tmdb: '746036', imdb: 'tt1684562' },
    }])
    expect(String(fetch.mock.calls[0]?.[0])).toContain('api_key=secret')
  })

  it('normalizes TMDb image candidates and declines when unconfigured', async () => {
    const fetch = vi.fn(async () => json({
      poster_path: '/poster.jpg', backdrop_path: '/backdrop.jpg',
      images: { logos: [{ file_path: '/logo.png', iso_639_1: 'en', width: 400, height: 100 }] },
    }))
    const source = makeTmdbImagesFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch })

    await expect(source({ ...identity, externalIds: { tmdb: '746036' } }, {})).resolves.toEqual([{
      source: 'tmdb-images', images: [
        { kind: 'poster', url: 'https://image.tmdb.org/t/p/original/poster.jpg', source: 'tmdb-images' },
        { kind: 'backdrop', url: 'https://image.tmdb.org/t/p/original/backdrop.jpg', source: 'tmdb-images' },
        { kind: 'logo', url: 'https://image.tmdb.org/t/p/original/logo.png', language: 'en', width: 400, height: 100, source: 'tmdb-images' },
      ],
    }])
    await expect(makeTmdbImagesFn({ getSettings: () => ({}) })({ ...identity, externalIds: { tmdb: '746036' } }, {})).resolves.toEqual([])
  })

  // OMDb 那两个源搬进了 packages/omdb（第九批 §2.4），它们的用例在 packages/omdb/adapter.test.ts。

  it('maps a strict TMDb candidate while resolving metadata', async () => {
    const source = makeTmdbMetadataFn({
      getSettings: () => ({ tmdbApiKey: 'secret' }),
      fetch: async (input: string) => input.includes('/search/tv')
        ? json({ results: [{ id: 42, name: '喜剧之王单口季 第3季', first_air_date: '2026-01-01' }] })
        : json({ id: 42, name: '喜剧之王单口季 第3季', first_air_date: '2026-01-01', external_ids: {} }),
    })
    await expect(source({ title: '喜剧之王单口季第3季', year: 2026, kind: 'series', externalIds: {} }, {})).resolves.toEqual([
      expect.objectContaining({ source: 'tmdb-metadata', externalIds: { tmdb: '42' } }),
    ])
  })

  it('verifies a localized title through TMDb alternative titles without fetching the discovery site', async () => {
    const fetch = vi.fn(async (input: string) => {
      if (input.includes('/search/movie')) return json({ results: [{ id: 1084244, title: 'Toy Story 5', release_date: '2026-06-19' }] })
      if (input.includes('/movie/1084244')) return json({ id: 1084244, release_date: '2026-06-19', alternative_titles: { titles: [{ title: '玩具总动员5' }] } })
      throw new Error(`unexpected request ${input}`)
    })
    const source = makeTmdbMetadataFn({ getSettings: () => ({ tmdbApiKey: 'secret' }), fetch })

    await expect(source({ title: '玩具总动员5', year: 2026, kind: 'movie', sourceUrl: 'https://movie.douban.com/subject/example', externalIds: {} }, {})).resolves.toEqual([
      expect.objectContaining({ source: 'tmdb-metadata', externalIds: { tmdb: '1084244' } }),
    ])
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('douban.com'))).toBe(true)
  })

})
