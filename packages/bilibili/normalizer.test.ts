import { describe, it, expect } from 'vitest'
import { bilibiliNormalizer } from './normalizer.ts'
import type { RawItem } from '../../src/content/normalize.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

const bili: SourceManifest = {
  schema_version: 1, id: 'rsshub:bilibili/user/dynamic/:uid', adapter: 'rsshub', type: 'post',
  description: 'b', topics: [], example_queries: [], capabilities: ['timeline'],
  auth: { type: 'cookie', domain: 'bilibili.com', inject: { kind: 'transform', ref: 'bilibili' } }, params_schema: {}, cadence_hint_seconds: 1800,
  discoverable: true, normalizer: 'bilibili',
}

describe('bilibili normalizer', () => {
  it('video → player.bilibili embed, duration, cleaned text', () => {
    const raw: RawItem = {
      title: '【对马岛之魂】支线',
      description: '简介文字<br><img src="http://i1.hdslb.com/cover.jpg" referrerpolicy="no-referrer"><br>视频地址：<a href="https://www.bilibili.com/video/BV1Hrb5eVEe1">link</a>',
      link: 'https://t.bilibili.com/953880930441756691',
      attachments: [{ url: 'https://www.bilibili.com/blackboard/newplayer.html?bvid=BV1Hrb5eVEe1', mime_type: 'text/html', duration_in_seconds: 1177 }],
    }
    const c = bilibiliNormalizer(raw, bili)
    expect(c.archetype).toBe('video')
    expect(c.media?.[0]).toMatchObject({ kind: 'video', provider: 'bilibili', vid: 'BV1Hrb5eVEe1', duration_s: 1177 })
    expect((c.media?.[0] as { embed: string }).embed).toContain('player.bilibili.com/player.html?bvid=BV1Hrb5eVEe1')
    expect(c.text).not.toContain('视频地址')
    expect(c.text).toContain('简介文字')
  })

  it('an aid-only html5 iframe (followings/dynamic) yields an av<number> vid, never a bvid', () => {
    const raw: RawItem = {
      title: 'x',
      description: '<iframe src="https://www.bilibili.com/blackboard/html5mobileplayer.html?aid=116830928705054&page=1"></iframe>',
    }
    const c = bilibiliNormalizer(raw, bili)
    expect(c.archetype).toBe('video')
    expect(c.media?.[0]).toMatchObject({ kind: 'video', vid: 'av116830928705054' })
    expect((c.media?.[0] as { embed: string }).embed).toContain('aid=116830928705054')
  })

  it('forward → quoted author + images, own comment', () => {
    const raw: RawItem = {
      title: '转发动态',
      description: '我的评论<br>//转发自: @野生的装机宅: <br>互动抽奖 关注+转发<br><img src="a.jpg"><img src="b.jpg">',
    }
    const c = bilibiliNormalizer(raw, bili)
    expect(c.archetype).toBe('forward')
    expect(c.text).toContain('我的评论')
    expect(c.quoted?.author).toBe('野生的装机宅')
    expect(c.quoted?.text).toContain('互动抽奖')
    expect(c.quoted?.media).toHaveLength(2)
  })

  it('article → opus link + cleaned text', () => {
    const raw: RawItem = {
      title: '白嫖 Cloudflare',
      description: '正文内容很长<br>专栏地址：<a href="https://www.bilibili.com/opus/1175995177033007107">link</a>',
    }
    const c = bilibiliNormalizer(raw, bili)
    expect(c.archetype).toBe('article')
    expect(c.media?.[0]).toMatchObject({ kind: 'link', url: 'https://www.bilibili.com/opus/1175995177033007107' })
    expect(c.text).not.toContain('专栏地址')
  })

  it('gallery → images', () => {
    const c = bilibiliNormalizer({ title: '图文', description: '看图<br><img src="x.jpg"><img src="y.jpg">' }, bili)
    expect(c.archetype).toBe('gallery')
    expect(c.media).toHaveLength(2)
  })

  it('text → plain', () => {
    const c = bilibiliNormalizer({ title: 't', description: '今天天气不错' }, bili)
    expect(c.archetype).toBe('text')
    expect(c.text).toBe('今天天气不错')
  })
})
