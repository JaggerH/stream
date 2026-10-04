import { describe, it, expect } from 'vitest'
import { bilibiliWebNormalizer } from './bilibili-web.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

const m = {} as SourceManifest

describe('bilibiliWebNormalizer', () => {
  it('video-shaped item (bvid + pic) → video archetype, provider bilibili', () => {
    const c = bilibiliWebNormalizer(
      { bvid: 'BV1x', title: 'hi', pic: 'https://i0.hdslb.com/c.jpg', duration: 120, owner: { name: 'up' } },
      m
    )
    expect(c.archetype).toBe('video')
    expect(c.title).toBe('hi')
    expect(c.media).toEqual([
      {
        kind: 'video',
        provider: 'bilibili',
        vid: 'BV1x',
        poster: 'https://i0.hdslb.com/c.jpg',
        duration_s: 120,
        page_url: 'https://www.bilibili.com/video/BV1x',
      },
    ])
  })

  it('comment-shaped item (content.message) → text archetype', () => {
    const c = bilibiliWebNormalizer({ content: { message: 'nice video' }, member: { uname: 'u' } }, m)
    expect(c.archetype).toBe('text')
    expect(c.text).toBe('nice video')
  })

  it('danmaku-shaped item (time + text) → text archetype', () => {
    const c = bilibiliWebNormalizer({ time: 3.5, text: '弹幕' }, m)
    expect(c.archetype).toBe('text')
    expect(c.text).toBe('弹幕')
  })

  it('profile-shaped item (mid + name, no bvid) → text archetype with a gallery avatar', () => {
    const c = bilibiliWebNormalizer({ mid: 1, name: 'up', face: 'https://a.jpg', sign: 'bio' }, m)
    expect(c.archetype).toBe('gallery')
    expect(c.title).toBe('up')
    expect(c.media).toEqual([{ kind: 'image', url: 'https://a.jpg' }])
  })

  it('never throws on an empty object', () => {
    expect(() => bilibiliWebNormalizer({}, m)).not.toThrow()
  })
})
