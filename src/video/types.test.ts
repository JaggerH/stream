import { describe, expect, it } from 'vitest'
import type { ProviderCategory } from '../store/types.ts'
import type {
  Release,
  VideoDetail,
  VideoImageResult,
  VideoLookupIdentity,
  VideoMetadataResult,
  VideoProviderFailure,
} from './types.ts'

describe('video detail contracts', () => {
  it('Release.links 元素接受可选 desc（超集，pansou 安全）', () => {
    const r: Release = {
      source: 'btbtla', title: 't', quality: 'unknown', sourceType: 'magnet',
      coverage: { kind: 'unknown' }, link: 'magnet:x', parsed: true,
      links: [{ url: 'magnet:x', type: 'magnet', desc: '第01集 1080p' }],
    }
    expect(r.links?.[0].desc).toBe('第01集 1080p')
  })

  it('models a lookup, normalized provider results, and a merged detail', () => {
    const metadataVariant: ProviderCategory = 'metadata'
    const imageVariant: ProviderCategory = 'images'
    const identity: VideoLookupIdentity = {
      title: 'The Fall Guy',
      year: 2024,
      kind: 'movie',
      externalIds: { tmdb: '746036' },
    }
    const metadata: VideoMetadataResult = {
      source: 'tmdb-metadata',
      title: 'The Fall Guy',
      releaseDate: '2024-05-03',
      genres: ['Action'],
      people: [{ name: 'Ryan Gosling', role: 'actor' }],
      externalIds: { tmdb: '746036', imdb: 'tt1684562' },
    }
    const images: VideoImageResult = {
      source: 'tmdb-images',
      images: [{ kind: 'poster', url: 'https://image.tmdb.org/poster.jpg' }],
    }
    const failure: VideoProviderFailure = {
      provider: 'video-images',
      member: 'omdb-images',
      phase: 'lookup',
      message: 'provider unavailable',
    }
    const detail: VideoDetail = {
      cacheKey: 'tmdb:746036',
      identity,
      metadata,
      images: { poster: images.images[0] },
      imageCandidates: images.images,
      failures: [failure],
      fetchedAt: '2026-07-14T00:00:00.000Z',
      expiresAt: '2026-07-15T00:00:00.000Z',
    }

    expect([metadataVariant, imageVariant]).toEqual(['metadata', 'images'])
    expect(detail.metadata?.externalIds.imdb).toBe('tt1684562')
    expect(detail.images.poster?.kind).toBe('poster')
    expect(detail.failures[0]?.member).toBe('omdb-images')
  })
})
