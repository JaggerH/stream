import { describe, it, expect } from 'vitest'
import { splitChannelLabel } from './channelLabel.ts'

describe('splitChannelLabel', () => {
  it('splits "标题（说明）。" into a primary title and a secondary subtitle', () => {
    expect(
      splitChannelLabel('抖音 — 我的收藏（你账号登录态下收藏的作品，登录态 cookie 由 host 注入）。')
    ).toEqual({
      title: '抖音 — 我的收藏',
      subtitle: '你账号登录态下收藏的作品，登录态 cookie 由 host 注入',
    })
  })

  it('keeps the em-dash inside the title', () => {
    expect(splitChannelLabel('B站 — 动态（关注的 UP 主更新）').title).toBe('B站 — 动态')
  })

  it('handles ASCII parens too', () => {
    expect(splitChannelLabel('Hacker News (front page)')).toEqual({ title: 'Hacker News', subtitle: 'front page' })
  })

  it('returns no subtitle when there are no parens (and strips a trailing period)', () => {
    expect(splitChannelLabel('Timeline')).toEqual({ title: 'Timeline', subtitle: '' })
    expect(splitChannelLabel('全部最新。')).toEqual({ title: '全部最新', subtitle: '' })
  })

  it('leaves a search-style label intact', () => {
    expect(splitChannelLabel('搜索 “猫”')).toEqual({ title: '搜索 “猫”', subtitle: '' })
  })

  it('trims surrounding whitespace', () => {
    expect(splitChannelLabel('  X  （  y  ）  ')).toEqual({ title: 'X', subtitle: 'y' })
  })
})
