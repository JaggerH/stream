import { describe, it, expect } from 'vitest'
import { itemSummary, mediaPreviews, postSummary, quotedPost } from './feedPresent.ts'
import type { Item } from './types.ts'

function videoItem(media: unknown): Item {
  return { content: { archetype: 'video', media } } as unknown as Item
}

function forwardItem(text: string, quoted: Record<string, unknown>): Item {
  return { content: { archetype: 'forward', text, quoted } } as unknown as Item
}

describe('mediaPreviews video dimensions', () => {
  it('carries a video media entry’s source w/h onto the preview (so MediaBox snaps orientation up front)', () => {
    const previews = mediaPreviews(videoItem([{ kind: 'video', poster: 'https://p/c.jpg', w: 1080, h: 1920 }]))
    expect(previews).toHaveLength(1)
    expect(previews[0]).toMatchObject({ w: 1080, h: 1920 })
    expect(previews[0].src).toContain(encodeURIComponent('https://p/c.jpg'))
  })

  it('leaves w/h undefined when the video media reports no dims (old items → poster measured on load)', () => {
    const previews = mediaPreviews(videoItem([{ kind: 'video', poster: 'https://p/c.jpg' }]))
    expect(previews[0].w).toBeUndefined()
    expect(previews[0].h).toBeUndefined()
  })
})

// 转发帖的两半：本帖自己说的话 vs 被转发的原帖。卡片/列表行把后者画成引用块，
// 所以派生层必须先把它拆开——尤其是"转发语为空"那一档，itemSummary 会把原帖正文
// 顶上来当摘要，同一段字就会在一张卡上出现两遍（估高器还会按两份记账）。
describe('quotedPost / postSummary', () => {
  it('拆出原帖的作者和正文；不是转发的条目返回 null', () => {
    const item = forwardItem('我的评论', { author: '原作者', text: '原帖正文' })
    expect(quotedPost(item)).toEqual({ author: '原作者', text: '原帖正文' })
    expect(quotedPost({ content: { archetype: 'text', text: 'x' } } as unknown as Item)).toBeNull()
  })

  it('引用里既没作者也没正文（只剩一个空壳）时返回 null——没什么可画的', () => {
    expect(quotedPost(forwardItem('我的评论', { media: [] }))).toBeNull()
  })

  it('有转发语时摘要照旧是本帖自己的话', () => {
    const item = forwardItem('我的评论', { author: '原作者', text: '原帖正文' })
    expect(postSummary(item)).toBe('我的评论')
  })

  it('转发语为空时摘要让位给引用块（itemSummary 仍会回落到原帖正文，两者必须分叉）', () => {
    const item = forwardItem('', { author: '原作者', text: '原帖正文' })
    expect(itemSummary(item)).toBe('原帖正文')   // 回落还在——别的调用方（全局搜索）靠它
    expect(postSummary(item)).toBe('')
  })
})
