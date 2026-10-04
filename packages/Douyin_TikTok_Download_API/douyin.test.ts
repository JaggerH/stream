import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { douyinNormalizer } from './douyin.ts'
import type { RawItem } from '../../src/content/normalize.ts'

// 脱敏的 API 响应夹具；只保留 normalizer 需要的字段形状。
const fixtureAweme = JSON.parse(
  readFileSync(join(import.meta.dirname, 'adapter/__fixtures__/aweme.json'), 'utf8')
) as RawItem

describe('douyinNormalizer', () => {
  it('maps a video aweme fixture → video archetype keyed by (provider, vid), no baked play url', () => {
    const c = douyinNormalizer(fixtureAweme, {} as never)
    expect(c.archetype).toBe('video')
    const m = c.media?.[0] as { provider?: string; vid?: string; embed?: string; url?: string; page_url?: string; poster?: string; duration_s?: number }
    expect(m.provider).toBe('douyin')
    // 身份是 aweme_id 的字符串形；播放地址在播放时按 (provider, vid) 现解，这里一律不带
    expect(m.vid).toBe(String(fixtureAweme.aweme_id))
    expect(m.embed).toBeUndefined()
    expect(m.url).toBeUndefined()
    expect(m.page_url).toBe(fixtureAweme.share_url)
    expect(m.poster).toContain('douyinpic.com')
    // fixture duration is 11029ms → 11s
    expect(m.duration_s).toBe(11)
  })

  it('carries the source video dimensions (video.width/height) so the frame snaps orientation up front', () => {
    // fixture video is 1080×1920 (portrait) — the frame must know this before the poster loads.
    const c = douyinNormalizer(fixtureAweme, {} as never)
    const m = c.media?.[0] as { w?: number; h?: number }
    expect(m.w).toBe(1080)
    expect(m.h).toBe(1920)
  })

  it('omits w/h when the aweme reports no (or zero) video dimensions', () => {
    const noDims = { ...fixtureAweme, video: { ...(fixtureAweme as { video?: object }).video, width: 0, height: 0 } } as unknown as RawItem
    const c = douyinNormalizer(noDims, {} as never)
    const m = c.media?.[0] as { w?: number; h?: number }
    expect(m.w).toBeUndefined()
    expect(m.h).toBeUndefined()
  })

  it('title comes from desc (empty desc → undefined)', () => {
    const c = douyinNormalizer({ ...fixtureAweme, desc: '露营好去处' } as RawItem, {} as never)
    expect(c.title).toBe('露营好去处')
    const c2 = douyinNormalizer({ ...fixtureAweme, desc: '' } as RawItem, {} as never)
    expect(c2.title).toBeUndefined()
  })

  it('photo-mode 图集 (no play_addr, images[]) → gallery', () => {
    const album = {
      aweme_id: '1',
      desc: '九图',
      media_type: 2,
      images: [
        { url_list: ['https://p/a.jpg'] },
        { url_list: ['https://p/b.jpg'] },
      ],
    } as unknown as RawItem
    const c = douyinNormalizer(album, {} as never)
    expect(c.archetype).toBe('gallery')
    expect(c.media?.map((m) => (m as { url: string }).url)).toEqual(['https://p/a.jpg', 'https://p/b.jpg'])
  })

  it('图集 with a synthesized slideshow video.play_addr → still gallery (images win)', () => {
    // douyin attaches a slideshow video (play_addr + cover) to photo posts; the images
    // must win so the album is not mis-routed to the failing video player.
    const album = {
      aweme_id: '1',
      desc: '图文',
      media_type: 2,
      images: [{ url_list: ['https://p/a.jpg'] }, { url_list: ['https://p/b.jpg'] }],
      video: { play_addr: { url_list: ['https://slideshow/v.mp4'] }, cover: { url_list: ['https://p/cover.jpg'] } },
      share_url: 'https://www.douyin.com/note/1',
    } as unknown as RawItem
    const c = douyinNormalizer(album, {} as never)
    expect(c.archetype).toBe('gallery')
    expect(c.media?.map((m) => (m as { url: string }).url)).toEqual(['https://p/a.jpg', 'https://p/b.jpg'])
  })

  it('image-mode post (media_type 2) with no images[] → text, not a broken video', () => {
    const c = douyinNormalizer(
      { aweme_id: '1', desc: '图文', media_type: 2, video: { play_addr: { url_list: ['u'] } }, share_url: 'https://www.douyin.com/note/1' } as unknown as RawItem,
      {} as never
    )
    expect(c.archetype).toBe('text')
    expect(c.title).toBe('图文')
  })

  it('image-mode post (aweme_type 68) with no images[] and media_type != 2 → text', () => {
    // defense-in-depth: aweme_type 68 is the canonical douyin image-mode marker;
    // catch it even when media_type is absent or set to something other than 2.
    const c = douyinNormalizer(
      { aweme_id: '1', desc: 'aweme_type 图文', aweme_type: 68, video: { play_addr: { url_list: ['u'] } }, share_url: 'https://www.douyin.com/note/1' } as unknown as RawItem,
      {} as never
    )
    expect(c.archetype).toBe('text')
    expect(c.title).toBe('aweme_type 图文')
  })

  it('video with no share_url synthesizes the /video/<id> page url from aweme_id and keeps vid', () => {
    const c = douyinNormalizer({ aweme_id: '1', desc: 'x', video: { play_addr: { url_list: ['u'] } } } as unknown as RawItem, {} as never)
    expect(c.archetype).toBe('video')
    const v = c.media?.[0] as { vid?: string; page_url?: string }
    expect(v.vid).toBe('1')
    expect(v.page_url).toBe('https://www.douyin.com/video/1')
  })

  it('numeric aweme_id is stringified into vid', () => {
    const c = douyinNormalizer({ aweme_id: 7339393672959757570n.toString(), desc: 'x', video: {} } as unknown as RawItem, {} as never)
    expect((c.media?.[0] as { vid?: string }).vid).toBe('7339393672959757570')
    const c2 = douyinNormalizer({ aweme_id: 42, desc: 'x', video: {} } as unknown as RawItem, {} as never)
    expect((c2.media?.[0] as { vid?: string }).vid).toBe('42')
  })

  it('video with share_url but no aweme_id degrades to text (no id → nothing to resolve)', () => {
    const c = douyinNormalizer({ desc: 'x', share_url: 'https://www.douyin.com/video/1', video: { play_addr: { url_list: ['u'] } } } as unknown as RawItem, {} as never)
    expect(c.archetype).toBe('text')
    expect(c.title).toBe('x')
  })

  it('video with neither share_url nor aweme_id degrades to text', () => {
    const c = douyinNormalizer({ desc: 'x', video: { play_addr: { url_list: ['u'] } } } as unknown as RawItem, {} as never)
    expect(c.archetype).toBe('text')
    expect(c.title).toBe('x')
  })

  it('never throws on a garbage item', () => {
    expect(() => douyinNormalizer({} as RawItem, {} as never)).not.toThrow()
    const c = douyinNormalizer({} as RawItem, {} as never)
    expect(c.archetype).toBe('text')
  })
})
