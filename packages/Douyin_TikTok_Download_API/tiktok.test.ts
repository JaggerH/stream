import { describe, it, expect } from 'vitest'
import { tiktokNormalizer } from './tiktok.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'
import type { RawItem } from '../../src/content/normalize.ts'

const m = {} as SourceManifest

describe('tiktokNormalizer', () => {
  it('video-shaped item (id + video) → video archetype keyed by (provider tiktok, vid = id), no baked play url', () => {
    const c = tiktokNormalizer(
      {
        id: '7339393672959757570',
        desc: 'hi',
        video: { cover: 'https://p.tiktokcdn.com/c.jpg', duration: 15 },
        author: { uniqueId: 'someone' },
      } as unknown as RawItem,
      m
    )
    expect(c.archetype).toBe('video')
    expect(c.title).toBe('hi')
    expect(c.media).toEqual([
      {
        kind: 'video',
        provider: 'tiktok',
        vid: '7339393672959757570',
        poster: 'https://p.tiktokcdn.com/c.jpg',
        duration_s: 15,
        page_url: 'https://www.tiktok.com/@someone/video/7339393672959757570',
      },
    ])
  })

  it('video-shaped item with no author uniqueId falls back to a userless page url, vid unchanged', () => {
    const c = tiktokNormalizer({ id: '123', video: {} } as unknown as RawItem, m)
    const v = c.media?.[0] as { page_url?: string; vid?: string }
    expect(v.page_url).toBe('https://www.tiktok.com/video/123')
    expect(v.vid).toBe('123')
  })

  it('app-shaped aweme_detail (aweme_id, no id) still yields vid', () => {
    const c = tiktokNormalizer({ aweme_id: '456', video: {} } as unknown as RawItem, m)
    expect((c.media?.[0] as { vid?: string }).vid).toBe('456')
  })

  it('video-shaped item without any id degrades to text', () => {
    const c = tiktokNormalizer({ desc: 'x', video: {} } as unknown as RawItem, m)
    expect(c.archetype).toBe('text')
    expect(c.title).toBe('x')
  })

  it('comment-shaped item (text) → text archetype', () => {
    const c = tiktokNormalizer({ text: 'nice', user: { nickname: 'u' } } as unknown as RawItem, m)
    expect(c.archetype).toBe('text')
    expect(c.text).toBe('nice')
  })

  it('profile-shaped item (uniqueId, no video/text) → gallery with avatar', () => {
    const c = tiktokNormalizer({ uniqueId: 'a', nickname: 'A', avatarLarger: 'https://x.jpg', signature: 'bio' } as unknown as RawItem, m)
    expect(c.archetype).toBe('gallery')
    expect(c.title).toBe('A')
    expect(c.media).toEqual([{ kind: 'image', url: 'https://x.jpg' }])
  })

  it('never throws on an empty object', () => {
    expect(() => tiktokNormalizer({} as unknown as RawItem, m)).not.toThrow()
  })
})
