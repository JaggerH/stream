import { describe, it, expect } from 'vitest'
import { cardIdFromHref } from './card-id.ts'

const NOTE = '65f0a1b2c3d4e5f60718293a'

describe('cardIdFromHref', () => {
  it('认 homefeed 的 /explore/<id>', () => {
    expect(cardIdFromHref(`/explore/${NOTE}?xsec_token=ABC-_1&xsec_source=pc_feed`)).toBe(NOTE)
  })

  it('也认搜索结果页的 /search_result/<id> —— 账本来源换成 search 之后卡片可能挂在这儿', () => {
    expect(cardIdFromHref(`/search_result/${NOTE}?xsec_token=ABC&xsec_source=pc_search`)).toBe(NOTE)
  })

  it('绝对 URL 与相对路径同样处理', () => {
    expect(cardIdFromHref(`https://www.xiaohongshu.com/explore/${NOTE}`)).toBe(NOTE)
  })

  it('query 先切掉再匹配 —— token 是不定形长串，让它参与匹配就是给自己埋一个偶发错 id', () => {
    expect(cardIdFromHref(`/explore/${NOTE}?token=abcdef0123456789abcdef0123456789`)).toBe(NOTE)
  })

  it('不像 id 的链接一律 null（导航条、话题页）', () => {
    expect(cardIdFromHref('/explore')).toBeNull()
    expect(cardIdFromHref('/search_result?keyword=x')).toBeNull()
    expect(cardIdFromHref('')).toBeNull()
  })
})
