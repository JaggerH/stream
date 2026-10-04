import { describe, it, expect } from 'vitest'
import { posterOf } from './item-poster.ts'
import type { Media } from '../content/types.ts'

describe('posterOf', () => {
  it('视频/音频的封面最优先——那本来就是"这条内容长什么样"', () => {
    const media: Media[] = [
      { kind: 'image', url: 'https://x/first.jpg' },
      { kind: 'video', poster: 'https://x/cover.jpg' },
    ]
    expect(posterOf(media)).toBe('https://x/cover.jpg')
    expect(posterOf([{ kind: 'audio', poster: 'https://x/album.jpg' }])).toBe('https://x/album.jpg')
  })

  it('图集退到首图，且 thumb 优先于原图（这里只是个角标，原图可能几 MB）', () => {
    expect(posterOf([{ kind: 'image', url: 'https://x/big.jpg', thumb: 'https://x/small.jpg' }])).toBe('https://x/small.jpg')
    expect(posterOf([{ kind: 'image', url: 'https://x/big.jpg' }])).toBe('https://x/big.jpg')
  })

  it('链接卡的图排最后——它常常是站点 logo，不是内容本身', () => {
    const media: Media[] = [
      { kind: 'link', url: 'https://x/a', image: 'https://x/logo.png' },
      { kind: 'image', url: 'https://x/real.jpg' },
    ]
    expect(posterOf(media)).toBe('https://x/real.jpg')
    expect(posterOf([{ kind: 'link', url: 'https://x/a', image: 'https://x/logo.png' }])).toBe('https://x/logo.png')
  })

  it('取不到就 undefined——卡片据此退回纯文字，不留一个空图框', () => {
    expect(posterOf(undefined)).toBeUndefined()
    expect(posterOf([])).toBeUndefined()
    expect(posterOf([{ kind: 'video' }])).toBeUndefined()
    expect(posterOf([{ kind: 'image', url: '' }])).toBeUndefined()
  })
})
