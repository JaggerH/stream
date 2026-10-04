import { describe, it, expect } from 'vitest'
import { allowsAutomaticEnrichment, enrichParamsFor, hasCommentThread } from '../lib/enrich.ts'
import type { Item } from '../lib/types.ts'

const base = (over: Partial<Item>): Item => ({
  id: 'i', stream_id: 's', type: 'post', title: 't', timestamp: '', fetched_at: '', ...over,
})

describe('enrichParamsFor', () => {
  it('content.enrich 在场 → 原样交出 { source, params }，前端不再猜站名', () => {
    const item = base({
      stream_id: 'whatever',
      content: { archetype: 'gallery', enrich: { source: 'demo-detail', params: { id: 'n1', token: 'T' } } },
    })
    expect(enrichParamsFor(item)).toEqual({ source: 'demo-detail', params: { id: 'n1', token: 'T' } })
    expect(hasCommentThread(item)).toBe(true)
  })

  it('content.enrich 优先于宿主判据（provider 视频 / link 原型都让路）', () => {
    const item = base({
      stream_id: 'whatever',
      url: 'https://example.com/a',
      content: {
        archetype: 'link',
        media: [{ kind: 'video', provider: 'bilibili', vid: 'BV1x' }],
        enrich: { source: 'demo-detail', params: { id: 'n1' } },
      },
    })
    expect(enrichParamsFor(item)).toEqual({ source: 'demo-detail', params: { id: 'n1' } })
  })

  it('带 provider+vid 的视频 → `${provider}-comments`', () => {
    const item = base({ stream_id: 'whatever', content: { archetype: 'video', media: [{ kind: 'video', provider: 'bilibili', vid: 'BV1x' }] } })
    expect(enrichParamsFor(item)).toEqual({ source: 'bilibili-comments', vid: 'BV1x' })
  })

  it('provider 是别的平台也一样拼', () => {
    const item = base({ stream_id: 'whatever', content: { archetype: 'video', media: [{ kind: 'video', provider: 'somesite', vid: 'ID1' }] } })
    expect(enrichParamsFor(item)).toEqual({ source: 'somesite-comments', vid: 'ID1' })
  })

  // 包声明的现取多半骑着用户的采集会话开标签页、花那个 facility 的访问预算——只在用户点开时跑，
  // 绝不随列表滚动预取。判据是 `content.enrich` 在场，不看站名。
  it('content.enrich 在场的条目只在显式打开时现取，不进视口预取', () => {
    const it = base({
      stream_id: 'whatever',
      content: { archetype: 'gallery', enrich: { source: 'demo-detail', params: { id: 'n1' } } },
    })
    expect(allowsAutomaticEnrichment(it)).toBe(false)
    expect(allowsAutomaticEnrichment(base({ stream_id: 'whatever', content: { archetype: 'gallery' } }))).toBe(true)
  })

  // 包自报 `prefetch: true`（站外裸 HTTP 的讨论串，如论坛的回复）→ 随滚动预取，卡片的摘要 / 评论数
  // 靠这一步暖出来。判据仍只看形状，不看站名。
  it('content.enrich 带 prefetch → 可以预取，是讨论串，参数里带着 prefetch 供传输层判', () => {
    const it = base({
      stream_id: 'rsshub-anything',
      url: 'https://example.org/t/1',
      content: { archetype: 'link', enrich: { source: 'demo-comments', params: { id: '1' }, prefetch: true } },
    })
    expect(enrichParamsFor(it)).toEqual({ source: 'demo-comments', params: { id: '1' }, prefetch: true })
    expect(allowsAutomaticEnrichment(it)).toBe(true)
    expect(hasCommentThread(it)).toBe(true)
  })

  it('generic external link → article only, no comment thread', () => {
    const it = base({ stream_id: 'phoronix', url: 'https://www.phoronix.com/news/x', content: { archetype: 'link' } })
    expect(enrichParamsFor(it)).toEqual({ source: 'link', url: 'https://www.phoronix.com/news/x' })
    expect(hasCommentThread(it)).toBe(false)
  })

  // 站名不再是判据：stream_id / url 长得像哪个论坛都不会凭空长出讨论串。
  it('没有 content.enrich 的论坛样条目 → 按形状走（text 不可现取），不按站名猜', () => {
    const it = base({ stream_id: 'forum-hot', url: 'https://forum.example/t/1098765', content: { archetype: 'text', text: 'topic body' } })
    expect(enrichParamsFor(it)).toBeNull()
  })

  it('plain text item → not enrichable', () => {
    const it = base({ stream_id: 'rss', content: { archetype: 'text', text: 'hi' } })
    expect(enrichParamsFor(it)).toBeNull()
  })

  // 转发帖的「打开时补全被截断原帖」由包的 normalizer 写进 content.enrich（截不截断是包判的）；
  // 前端只认形状：带 enrich 的转发帖 → 照 enrich 现取、不预取、不是讨论串。
  it('转发帖带 content.enrich → 原样现取，不预取，没有评论串', () => {
    const it = base({
      stream_id: 'any-stream',
      content: {
        archetype: 'forward',
        text: '回复@x',
        quoted: { author: 'a', text: '由此我在...', permalink: 'https://example.com/1/2' },
        enrich: { source: 'demo-detail', params: { permalink: 'https://example.com/1/2' } },
      },
    })
    expect(enrichParamsFor(it)).toEqual({ source: 'demo-detail', params: { permalink: 'https://example.com/1/2' } })
    expect(hasCommentThread(it)).toBe(false)
    expect(allowsAutomaticEnrichment(it)).toBe(false)
  })

  it('转发帖没有 content.enrich → 宿主不按站名猜，不可现取', () => {
    const it = base({
      stream_id: 'xueqiu-user-19gkk',
      content: { archetype: 'forward', quoted: { text: '被截断...', permalink: 'https://example.com/1/999' } },
    })
    expect(enrichParamsFor(it)).toBeNull()
    expect(allowsAutomaticEnrichment(it)).toBe(true)
  })
})
