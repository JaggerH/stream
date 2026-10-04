import { describe, it, expect } from 'vitest'
import { overlayBlurb } from './blurb.ts'
import type { Item } from './types.ts'

const base: Item = {
  id: 'i1',
  stream_id: 's1',
  type: 'post',
  title: '标题',
  timestamp: '2026-08-11T00:00:00.000Z',
  fetched_at: '2026-08-11T00:00:00.000Z',
}

describe('overlayBlurb — 简介浮层里放什么', () => {
  it('纯文本正文进浮层', () => {
    expect(overlayBlurb({ ...base, content: { archetype: 'video', text: '一段简介' } })).toBe('一段简介')
  })

  it('富化拿回来的文本优先于存储的（它是更全的那一份）', () => {
    expect(overlayBlurb({ ...base, content: { archetype: 'video', text: '截断的' } }, '完整的')).toBe('完整的')
  })

  // 文章 HTML 铺在播放器上既读不了也不该读——它留在右面板。
  it('文章 HTML 不进浮层', () => {
    expect(overlayBlurb({ ...base, content: { archetype: 'link', text: '摘要' } }, undefined, '<p>正文</p>')).toBe('')
  })

  it('转发引用不进浮层', () => {
    expect(
      overlayBlurb({ ...base, content: { archetype: 'text', text: '我的评论', quoted: { text: '原帖' } } })
    ).toBe('')
  })

  it('artText 是空串时回落到存储的那份（空串与缺席同义，都当不可用）', () => {
    expect(overlayBlurb({ ...base, content: { archetype: 'video', text: '存储的旧简介' } }, '')).toBe('存储的旧简介')
  })

  it('没有正文就不画', () => {
    expect(overlayBlurb({ ...base, content: { archetype: 'video' } })).toBe('')
    expect(overlayBlurb({ ...base, content: { archetype: 'video', text: '   ' } })).toBe('')
  })
})
