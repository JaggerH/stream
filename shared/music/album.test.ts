import { describe, it, expect } from 'vitest'
import { albumFromText } from './album.ts'

describe('albumFromText', () => {
  it('reads the album out of RSSHub 的 <br> 拼接 description', () => {
    expect(albumFromText('歌手：周杰伦<br>专辑：叶惠美<br>发行时间：2003-07-31')).toBe('叶惠美')
  })

  it('reads the album out of 入库归一化后的纯文本 content.text', () => {
    expect(albumFromText('歌手：周杰伦\n专辑：叶惠美\n发行时间：2003-07-31')).toBe('叶惠美')
  })

  it('stops at a closing tag other than <br>', () => {
    expect(albumFromText('<p>专辑：叶惠美</p>')).toBe('叶惠美')
  })

  it('stops at 发行 even without any separator before it', () => {
    expect(albumFromText('专辑：叶惠美 发行时间：2003-07-31')).toBe('叶惠美')
  })

  it('takes the rest of the string when nothing terminates it', () => {
    expect(albumFromText('专辑：叶惠美')).toBe('叶惠美')
  })

  it('accepts the ASCII colon too', () => {
    expect(albumFromText('专辑: 叶惠美')).toBe('叶惠美')
  })

  it('returns undefined when there is no 专辑 field', () => {
    expect(albumFromText('歌手：周杰伦')).toBeUndefined()
  })

  it('returns undefined for empty / absent text and for an empty album value', () => {
    expect(albumFromText(undefined)).toBeUndefined()
    expect(albumFromText('')).toBeUndefined()
    expect(albumFromText('歌手：周杰伦\n专辑：')).toBeUndefined()
  })
})
