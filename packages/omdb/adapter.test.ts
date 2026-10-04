import { describe, it, expect, vi, afterEach } from 'vitest'
import { OmdbAdapter } from './adapter.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

afterEach(() => vi.unstubAllGlobals())

const metadataRow = { id: '@streamapp/omdb/omdb-metadata', fixed_params: { mode: 'omdb-metadata' } } as unknown as SourceManifest
const imagesRow = { id: '@streamapp/omdb/omdb-images', fixed_params: { mode: 'omdb-images' } } as unknown as SourceManifest
const keys = { runtimeConfig: { apiKey: 'secret' } }
const identity = { title: 'The Fall Guy', year: 2024, kind: 'movie' as const, externalIds: {} }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 执行器怎么喂非 builtin 成员：对象输入整袋摊进 params，fixed_params 在前（`buildParams` + `memberCallArgs`）。 */
const call = (row: SourceManifest, input: Record<string, unknown>, ctx: { runtimeConfig: Record<string, unknown> } = keys) =>
  new OmdbAdapter().fetch({ ...(row.fixed_params ?? {}), url: '', ...input }, row, ctx)

// 搬家等价：下面三组是搬前 src/adapters/builtin/video-metadata.test.ts 里 makeOmdb*Fn 的同一组用例，
// 只是钥匙从宿主 getSettings 换成了 context.runtimeConfig、输入从 builtin 的整对象换成摊进 params。
describe('OmdbAdapter', () => {
  it('uses OMDb title/year lookup and turns its poster into an image candidate', async () => {
    const fetch = vi.fn(async (_url: string) => json({
      Response: 'True', Title: 'The Fall Guy', Year: '2024', imdbID: 'tt1684562', Runtime: '126 min',
      Genre: 'Action, Comedy', Plot: 'A stuntman.', Director: 'David Leitch', Actors: 'Ryan Gosling',
      imdbRating: '7.0', imdbVotes: '100,000', Poster: 'https://example.test/poster.jpg',
    }))
    vi.stubGlobal('fetch', fetch)

    await expect(call(metadataRow, { ...identity, externalIds: { imdb: 'tt1684562' } })).resolves.toEqual([expect.objectContaining({
      source: 'omdb-metadata', title: 'The Fall Guy', year: 2024, runtimeMinutes: 126,
      genres: ['Action', 'Comedy'], externalIds: { imdb: 'tt1684562' },
      ratings: [{ source: 'imdb', value: 7, scale: 10, votes: 100000 }],
    })])
    await expect(call(imagesRow, { ...identity, externalIds: { imdb: 'tt1684562' } })).resolves.toEqual([{
      source: 'omdb-images', images: [{ kind: 'poster', url: 'https://example.test/poster.jpg', source: 'omdb-images' }],
    }])
    const url = new URL(String(fetch.mock.calls[0][0]))
    expect(url.searchParams.get('apikey')).toBe('secret')
    expect(url.searchParams.get('i')).toBe('tt1684562')
  })

  it('without an imdb id it queries by title / year / type', async () => {
    const fetch = vi.fn(async (_url: string) => json({ Response: 'True', Title: 'The Fall Guy', Year: '2024' }))
    vi.stubGlobal('fetch', fetch)
    await call(metadataRow, identity)
    const url = new URL(String(fetch.mock.calls[0][0]))
    expect(url.searchParams.get('t')).toBe('The Fall Guy')
    expect(url.searchParams.get('y')).toBe('2024')
    expect(url.searchParams.get('type')).toBe('movie')
  })

  it('does not let OMDb turn a title into an identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ Response: 'True', Title: 'Taming My Bullies 3', Year: '2026', imdbID: 'tt42718395' })))
    await expect(call(metadataRow, { title: '喜剧之王单口季第3季', year: 2026, kind: 'series', externalIds: {} })).resolves.toEqual([])
  })

  it('returns a safe error for provider HTTP failures and declines malformed/no-match payloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    await expect(call(metadataRow, { ...identity, externalIds: { imdb: 'tt1684562' } })).rejects.toThrow('OMDb request failed (503)')
    vi.stubGlobal('fetch', vi.fn(async () => json({ Response: 'False' })))
    await expect(call(metadataRow, identity)).resolves.toEqual([])
  })

  it('declines (→[]) without calling OMDb when no key is configured or the input has no title', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(call(metadataRow, identity, { runtimeConfig: {} })).resolves.toEqual([])
    await expect(call(imagesRow, { externalIds: {} })).resolves.toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('an unknown mode is a wiring bug → throws', async () => {
    const row = { id: 'x', fixed_params: { mode: 'nope' } } as unknown as SourceManifest
    await expect(call(row, identity)).rejects.toThrow(/mode/)
  })
})
