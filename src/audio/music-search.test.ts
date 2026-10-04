import { describe, it, expect, afterEach } from 'vitest'
import { rsshubItemsToTracks } from './music-search.ts'
import { setLinkDeclarationSource } from '../links/recognize.ts'

const trackRef = (url: string) => {
  const m = url.match(/pkgsite\.com\/song\/(\d+)/)
  return m ? { platform: 'pkg', track_id: m[1] } : null
}

describe('rsshubItemsToTracks', () => {
  afterEach(() => setLinkDeclarationSource(() => []))

  // 其余用例都注入 trackRef，默认实参换成 () => null 也照样绿——而那时音乐搜索会一条不剩地返回空。
  // 这条不注入，钉住真正接在包声明表上的那条缝。
  it('不注入时走默认的 trackRefFromUrl —— 包声明的文法真的接上了', () => {
    setLinkDeclarationSource(() => [{ package: 'p', hosts: [], shortHosts: [], patterns: [{ kind: 'track', platform: 'p', pattern: '^https?://x\\.test/song/(?<id>\\d+)' }] }])
    const [t] = rsshubItemsToTracks([{ title: 'a', link: 'https://x.test/song/77' }])
    expect(t).toMatchObject({ id: 'p:77', platform: 'p', trackId: '77' })
  })

  it('track 引用来自 trackRefFromUrl；id 是 `platform:track_id`，sourceUrl 是 item.link 本身', () => {
    const [t] = rsshubItemsToTracks([{ title: '晴天 - 周杰伦', link: 'https://pkgsite.com/song/1', author: '周杰伦' }], trackRef)
    expect(t).toMatchObject({ id: 'pkg:1', platform: 'pkg', trackId: '1', title: '晴天', artist: '周杰伦', sourceUrl: 'https://pkgsite.com/song/1' })
  })

  it('认不出曲目引用的条目直接丢（源码不再从别的字段兜底猜 id）', () => {
    expect(rsshubItemsToTracks([{ title: 'x', link: 'https://elsewhere.com/a' }, { title: 'y' }], trackRef)).toEqual([])
  })

  it('同一首歌从两个源各来一条 → 按 id 去重，先到的赢', () => {
    const out = rsshubItemsToTracks([
      { title: 'A', link: 'https://pkgsite.com/song/1' },
      { title: 'B', link: 'https://pkgsite.com/song/1' },
    ], trackRef)
    expect(out.map((t) => t.title)).toEqual(['A'])
  })

  it('时长 / 专辑 / 封面照旧', () => {
    const [t] = rsshubItemsToTracks([{ title: 'a', link: 'https://pkgsite.com/song/2', image: 'http://i/x.jpg', itunes_duration: '03:20', description: '专辑：X' }], trackRef)
    expect(t).toMatchObject({ durationS: 200, poster: 'http://i/x.jpg' })
    expect(t.album).toBeTruthy()
  })
})
