import { describe, it, expect } from 'vitest'
import { extractTrackRef } from './ref.ts'
import type { Item } from '../content/types.ts'

const item = (media: any): Item => ({ id: 'x', title: 'Song', author: 'Artist', content: { media } } as unknown as Item)

describe('extractTrackRef', () => {
  it('没有结构化引用、也不是旧 resolve 路由的直链 → null（源码不再从 URL 猜播客 id）', () => {
    expect(extractTrackRef(item([{ kind: 'audio', url: 'http://cdn5.x.fm/audio/1_hd.mp3', page_url: 'https://www.x.fm/vod/1' }]))).toBeNull()
  })

  it('reads structured fields off audio media', () => {
    const r = extractTrackRef(item([{ kind: 'audio', url: '/x', platform: 'netease', track_id: '42' }]))
    expect(r).toEqual({ platform: 'netease', id: '42', title: 'Song', artist: 'Artist', pageUrl: undefined })
  })
  it('reads structured fields off link media (VIP rows)', () => {
    const r = extractTrackRef(item([{ kind: 'link', url: 'https://p', platform: 'netease', track_id: '7' }]))
    expect(r?.id).toBe('7')
  })
  it('falls back to parsing a resolve url', () => {
    const r = extractTrackRef(item([{ kind: 'audio', url: '/api/media/tracks/resolve?platform=netease&id=99' }]))
    expect(r).toMatchObject({ platform: 'netease', id: '99' })
  })
  it('returns null when there is no track ref', () => {
    expect(extractTrackRef(item([{ kind: 'image', url: 'x' }]))).toBeNull()
  })
})

/** 专辑名（数据模型里没有结构化字段，只在 `content.text` 的「专辑：X」里）。
 *  下载整单走的是这条路——不在这里带上，那一批的 ID3 专辑就全是空的。 */
describe('extractTrackRef — 专辑名', () => {
  const withText = (text: string): Item => ({
    id: 'x', title: 'Song', author: 'Artist',
    content: { text, media: [{ kind: 'audio', platform: 'netease', track_id: '1' }] },
  } as unknown as Item)

  it('从 content.text 的「专辑：X」解析出来', () => {
    expect(extractTrackRef(withText('专辑：青春的喝彩\n发行时间：1997'))?.album).toBe('青春的喝彩')
  })
  it('紧跟「发行」而没有换行时也切得干净', () => {
    expect(extractTrackRef(withText('专辑：青春的喝彩 发行时间：1997'))?.album).toBe('青春的喝彩')
  })
  it('没有这一段时是 undefined，不编一个空串出来', () => {
    expect(extractTrackRef(withText('歌手：Artist'))?.album).toBeUndefined()
  })
})
