import { describe, it, expect } from 'vitest'
import { normalize, defaultNormalizer, registerNormalizer, hasNormalizer, type RawItem } from './normalize.ts'
import type { SourceManifest } from '../manifest/types.ts'

// 各站自己的 normalizer 测试住各自的包里（如 packages/bilibili/normalizer.test.ts）；这里只测宿主的
// 默认 normalizer 与注册表本身。宿主静态表是空的——所有具名 normalizer 都由包的 activate 交出。
const named: SourceManifest = {
  schema_version: 1, id: 'rsshub:demo/list', adapter: 'rsshub', type: 'post',
  description: 't', topics: [], example_queries: [], capabilities: ['timeline'],
  auth: { type: 'none' }, params_schema: {}, cadence_hint_seconds: 1800,
  discoverable: true, normalizer: 'named-sample',
}
const generic: SourceManifest = { ...named, id: 'x', normalizer: undefined }
const lizhiLike: SourceManifest = { ...generic, id: 'pkg/user-audio', facility: { key: 'lizhi', label: '荔枝 FM' } }

describe('default normalizer', () => {
  it('video from attachments', () => {
    const c = defaultNormalizer({ description: 'x<img src="p.jpg">', attachments: [{ url: 'https://h/player.html', mime_type: 'text/html' }] }, generic)
    expect(c.archetype).toBe('video')
    expect((c.media?.[0] as { poster?: string }).poster).toBe('p.jpg')
  })
  it('gallery from imgs', () => {
    expect(defaultNormalizer({ description: '<img src="a.jpg">' }, generic).archetype).toBe('gallery')
  })
  it('text otherwise', () => {
    expect(defaultNormalizer({ description: 'hello' }, generic).archetype).toBe('text')
  })
  it("surfaces RSSHub's top-level image (no inline <img>) as gallery cover", () => {
    const c = defaultNormalizer({ title: '第1期', image: 'https://pic/cover.jpg' }, generic)
    expect(c.archetype).toBe('gallery')
    expect(c.media).toEqual([{ kind: 'image', url: 'https://pic/cover.jpg' }])
  })
  it('inline <img> still wins over top-level image (no duplicate cover)', () => {
    const c = defaultNormalizer({ description: '<img src="a.jpg">', image: 'https://pic/cover.jpg' }, generic)
    expect(c.media).toHaveLength(1)
    expect((c.media?.[0] as { url: string }).url).toBe('a.jpg')
  })
  it('link-feed (HN) → link archetype with link cards, no dead text', () => {
    const c = defaultNormalizer(
      {
        title: 'Show HN: Gitdot',
        description:
          '<a href="https://news.ycombinator.com/item?id=1">Comments on Hacker News</a> | <a href="https://gitdot.io/">Source</a>',
      },
      generic
    )
    expect(c.archetype).toBe('link')
    expect(c.media).toHaveLength(2)
    expect((c.media?.[1] as { url: string }).url).toBe('https://gitdot.io/')
  })
  it('normalize() falls back to default when no normalizer', () => {
    expect(normalize({ description: 'hi' }, generic).archetype).toBe('text')
  })
  it('a manifest declaring only the legacy `presenter` key still resolves the right normalizer', () => {
    // e.g. user-owned manifests outside this repo still say `presenter: <key>` — the alias is
    // what keeps them resolving after the rename. 判据要能区分"走了具名的"和"落到默认了"，
    // 所以用一个产出和默认不同的注册项。
    registerNormalizer('legacy-alias-demo', (raw) => ({ archetype: 'text', title: String(raw.title ?? ''), text: 'via alias' }))
    const legacy: SourceManifest = { ...generic, id: 'legacy', presenter: 'legacy-alias-demo' }
    const raw: RawItem = { title: 't', description: '看图<br><img src="x.jpg">' }
    expect(normalize(raw, legacy).text).toBe('via alias')
    expect(normalize(raw, generic).archetype).toBe('gallery')
  })
})

describe('torrent/magnet normalizer', () => {
  it('magnet enclosure → link archetype with magnet media + size', () => {
    const c = defaultNormalizer(
      {
        title: '[DBD-Raws] 鬼灭之刃 无限列车篇',
        description: '简介文字',
        enclosure_url: 'magnet:?xt=urn:btih:abcdef',
        enclosure_type: 'application/x-bittorrent',
        enclosure_length: 1610612736, // 1.5 GiB
      },
      generic
    )
    expect(c.archetype).toBe('link')
    expect(c.media).toHaveLength(1)
    expect(c.media?.[0]).toMatchObject({ kind: 'link', url: 'magnet:?xt=urn:btih:abcdef' })
    expect((c.media?.[0] as { title: string }).title).toBe('magnet · 1.5 GB')
    expect(c.text).toBe('简介文字')
  })
  it('ed2k enclosure (no size) → magnet link, plain label', () => {
    const c = defaultNormalizer(
      { title: 'x', enclosure_url: 'ed2k://|file|x|123|', enclosure_type: 'application/x-bittorrent' },
      generic
    )
    expect(c.archetype).toBe('link')
    expect((c.media?.[0] as { title: string }).title).toBe('magnet')
  })
  it('non-torrent enclosure is ignored (falls through to html branches)', () => {
    const c = defaultNormalizer(
      { title: 'x', description: '<img src="a.jpg">', enclosure_url: 'https://x/cover.jpg', enclosure_type: 'image/jpeg' },
      generic
    )
    expect(c.archetype).toBe('gallery')
  })
})

describe('podcast/audio normalizer', () => {
  it('audio enclosure → audio archetype with playable media + cover + duration', () => {
    const c = defaultNormalizer(
      {
        title: '第 42 期 · 聊聊播客',
        description: '<p>本期 shownotes</p>',
        link: 'https://www.xiaoyuzhoufm.com/episode/abc',
        enclosure_url: 'https://media.xyzcdn.net/abc.m4a',
        enclosure_type: 'audio/x-m4a',
        itunes_duration: 3725, // plain seconds
        itunes_item_image: 'https://img/cover.jpg',
      },
      generic
    )
    expect(c.archetype).toBe('audio')
    expect(c.media).toHaveLength(1)
    expect(c.media?.[0]).toMatchObject({
      kind: 'audio',
      url: 'https://media.xyzcdn.net/abc.m4a',
      poster: 'https://img/cover.jpg',
      duration_s: 3725,
      page_url: 'https://www.xiaoyuzhoufm.com/episode/abc',
    })
    expect(c.text).toBe('本期 shownotes')
  })

  it('mapping 给了 track_id → 存原始 enclosure + (platform=包的 facility, track_id)，绝不存 resolve 路由', () => {
    const c = defaultNormalizer(
      {
        title: '014.六月新闻大盘点',
        description: '<p>x</p>',
        link: 'https://www.lizhi.fm/vod/2543504329178871814',
        enclosure_url: 'http://cdn5.lizhi.fm/audio/2016/07/04/2543504329178871814_hd.mp3',
        enclosure_type: 'audio/mpeg',
        track_id: '2543504329178871814',
      },
      lizhiLike
    )
    expect(c.archetype).toBe('audio')
    expect(c.media?.[0]).toMatchObject({
      kind: 'audio',
      url: 'http://cdn5.lizhi.fm/audio/2016/07/04/2543504329178871814_hd.mp3',
      platform: 'lizhi',
      track_id: '2543504329178871814',
      page_url: 'https://www.lizhi.fm/vod/2543504329178871814',
    })
    expect((c.media?.[0] as { url: string }).url).not.toContain('/api/')
  })

  it('没有 track_id 的直链播客不带 platform/track_id（源码不再从 URL 猜 id）', () => {
    const c = defaultNormalizer(
      { title: 'ep', link: 'https://www.lizhi.fm/vod/1', enclosure_url: 'http://cdn5.lizhi.fm/audio/1_hd.mp3', enclosure_type: 'audio/mpeg' },
      lizhiLike
    )
    expect(c.media?.[0]).not.toHaveProperty('platform')
    expect(c.media?.[0]).not.toHaveProperty('track_id')
  })

  it('recipe 自报的 platform 被忽略——platform 恒等于包的 facility', () => {
    const c = defaultNormalizer(
      { title: 'ep', enclosure_url: 'http://x/a.mp3', enclosure_type: 'audio/mpeg', track_id: '7', platform: 'netease' },
      lizhiLike
    )
    expect(c.media?.[0]).toMatchObject({ platform: 'lizhi', track_id: '7' })
  })

  it('有 track_id 但 manifest 没有 facility → 不组 (platform, track_id)（没有归属就没有键）', () => {
    const c = defaultNormalizer({ title: 'ep', enclosure_url: 'http://x/a.mp3', enclosure_type: 'audio/mpeg', track_id: '7' }, generic)
    expect(c.media?.[0]).not.toHaveProperty('platform')
  })

  it('有 track_id、没有 enclosure → 付费/独家集：无 url + resolveOnly + (platform, track_id)', () => {
    const c = defaultNormalizer(
      {
        title: '938.五十三谈身边灵异事',
        description: '<p>x</p>',
        link: 'https://www.lizhi.fm/vod/3219807993531654150',
        itunes_item_image: 'https://img/paid-cover.jpg',
        track_id: '3219807993531654150',
      },
      lizhiLike
    )
    expect(c.archetype).toBe('audio')
    expect(c.media?.[0]).toMatchObject({
      kind: 'audio', platform: 'lizhi', track_id: '3219807993531654150',
      poster: 'https://img/paid-cover.jpg', resolveOnly: true,
    })
    expect((c.media?.[0] as { url?: string }).url).toBeUndefined()
  })

  it('parses "HH:MM:SS" itunes_duration and falls back to a description image for the cover', () => {
    const c = defaultNormalizer(
      {
        title: 'ep',
        description: '<img src="https://img/show.jpg">',
        enclosure_url: 'https://cdn/ep.mp3',
        enclosure_type: 'audio/mpeg',
        itunes_duration: '01:02:05',
      },
      generic
    )
    expect(c.archetype).toBe('audio')
    expect(c.media?.[0]).toMatchObject({ kind: 'audio', poster: 'https://img/show.jpg', duration_s: 3725 })
  })
})

describe('registerNormalizer', () => {
  it('makes a newly registered normalizer reachable through normalize()', () => {
    registerNormalizer('p2-demo', (raw) => ({ archetype: 'text', title: String(raw.title ?? ''), text: 'from p2-demo' }))
    const p2demo: SourceManifest = { ...named, id: 'p2-demo-manifest', normalizer: 'p2-demo' }
    const out = normalize({ title: 'hi' }, p2demo)
    expect(out.text).toBe('from p2-demo')
  })

  it('refuses to overwrite an existing key', () => {
    registerNormalizer('p2-dupe', (raw) => ({ archetype: 'text', title: '', text: 'first' }))
    expect(() => registerNormalizer('p2-dupe', (raw) => ({ archetype: 'text', title: '', text: 'second' }))).toThrow(
      /p2-dupe/,
    )
  })

  it('passes a normalizer-declared `enrich` through normalize() untouched', () => {
    registerNormalizer('p2-enrich', () => ({
      archetype: 'gallery',
      text: 'card',
      enrich: { source: 'demo-detail', params: { id: 'n1', token: 'T' } },
    }))
    const m: SourceManifest = { ...named, id: 'p2-enrich-manifest', normalizer: 'p2-enrich' }
    expect(normalize({ title: 'x' }, m).enrich).toEqual({ source: 'demo-detail', params: { id: 'n1', token: 'T' } })
    // withPaid 重建对象那条路也得带着它
    const paid = normalize({ title: 'x', price: 9 }, m)
    expect(paid.paid).toBe(true)
    expect(paid.enrich).toEqual({ source: 'demo-detail', params: { id: 'n1', token: 'T' } })
  })

  it('refuses to overwrite an already-registered key', () => {
    registerNormalizer('owned-once', () => ({ archetype: 'text', title: '', text: 'first' }))
    expect(() => registerNormalizer('owned-once', () => ({ archetype: 'text', title: '', text: 'hijacked' }))).toThrow(
      /owned-once/,
    )
  })

  it('the host registers no named normalizer of its own (they all come from packages)', () => {
    expect(hasNormalizer('movie')).toBe(false)
  })
})
