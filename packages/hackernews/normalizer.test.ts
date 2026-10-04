import { describe, expect, it } from 'vitest'
import { hackernewsNormalizer } from './normalizer.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

const mf = { id: 'rsshub:hackernews/best' } as SourceManifest

describe('hackernewsNormalizer', () => {
  it('link-feed item → link archetype + declares where the thread lives', () => {
    const c = hackernewsNormalizer(
      {
        title: 'Show HN: gitdot',
        link: 'https://gitdot.io/',
        description:
          '<a href="https://news.ycombinator.com/item?id=48526661">Comments on Hacker News</a> | <a href="https://gitdot.io/">Source</a>',
      },
      mf,
    )
    expect(c.archetype).toBe('link')
    expect(c.title).toBe('Show HN: gitdot')
    expect(c.media?.map((m) => (m.kind === 'link' ? m.url : ''))).toContain('https://gitdot.io/')
    // 裸 HTTP 取评论，便宜：允许随滚动预取
    expect(c.enrich).toEqual({ source: 'hackernews-comments', params: { id: '48526661' }, prefetch: true })
  })

  it('recovers the id from guid when the description carries no discussion link', () => {
    const c = hackernewsNormalizer({ title: 't', description: '<a href="https://x.dev/">x</a>', guid: '48517377-163' }, mf)
    expect(c.enrich?.params).toEqual({ id: '48517377' })
  })

  it('no recoverable id → no enrich declaration', () => {
    const c = hackernewsNormalizer({ title: 't', description: 'just words that are long enough to be prose here' }, mf)
    expect(c.enrich).toBeUndefined()
    expect(c.archetype).toBe('text')
  })
})
