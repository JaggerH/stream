import { describe, it, expect } from 'vitest'
import { cleanName, cleanUrl, findLinks, isHtml, pairDigest } from './text.ts'

describe('isHtml — distinguishes RSSHub HTML descriptions from plain pansou digests', () => {
  it('flags an <a href> torrent description', () => {
    expect(isHtml('<a href="https://nyaa.si/view/2077734">#2077734</a> | 1.2 GiB')).toBe(true)
  })
  it('does not flag a plain-text pansou digest', () => {
    expect(isHtml('入室抢劫 (2021) 链接：https://cloud.189.cn/t/abc（访问码：1111）')).toBe(false)
  })
})

describe('cleanUrl — never emit a truncated/garbage link', () => {
  it('splits a glued 提取码 off the URL (no paren)', () => {
    expect(cleanUrl('https://www.123684.com/s/oec7Vv-y9wWh提取码:ZY4K')).toEqual({
      url: 'https://www.123684.com/s/oec7Vv-y9wWh',
      password: 'ZY4K',
    })
  })
  it('splits a ?提取码 (fake query string) off the URL', () => {
    expect(cleanUrl('https://www.123pan.com/s/8KriVv-HSOX?提取码：xmhd')).toEqual({
      url: 'https://www.123pan.com/s/8KriVv-HSOX',
      password: 'xmhd',
    })
  })
  it('drops a whitespace-glued junk tail', () => {
    expect(cleanUrl('https://pan.quark.cn/s/d4aa5adc61ab \n\n🏷标签').url).toBe('https://pan.quark.cn/s/d4aa5adc61ab')
  })
})

describe('findLinks', () => {
  it('parenthesized 访问码 after the URL becomes the password, not part of the URL', () => {
    const [l] = findLinks('链接：https://cloud.189.cn/t/niuINfA3EvIj（访问码：5mpm）后续')
    expect(l.url).toBe('https://cloud.189.cn/t/niuINfA3EvIj')
    expect(l.password).toBe('5mpm')
  })
  it('splits URLs concatenated with no separator', () => {
    const ls = findLinks('https://pan.quark.cn/s/aaahttps://drive.uc.cn/s/bbb')
    expect(ls.map((l) => l.url)).toEqual(['https://pan.quark.cn/s/aaa', 'https://drive.uc.cn/s/bbb'])
  })
})

describe('cleanName', () => {
  it('strips {tmdbid} markers', () => {
    expect(cleanName('入侵.Invasion.(2005) {tmdb-2940}')).toBe('入侵.Invasion.(2005)')
  })
  it('cuts the 介绍 blurb — the name precedes it', () => {
    expect(cleanName('奥本海默 2023·📜介绍：当我们为权力……')).toBe('奥本海默 2023')
  })
  it('strips a leading field label', () => {
    expect(cleanName('名称：我的三体 (2014)')).toBe('我的三体 (2014)')
  })
  it('a leading 🎬 is decoration, not a whole-string nuke', () => {
    expect(cleanName('🎬 《奥本海默（2023）》💾夸克网盘')).toBe('《奥本海默（2023）》')
  })
})

describe('pairDigest — deterministic name↔link pairing', () => {
  it('pairs each link with the text segment BEFORE it (offset correctness)', () => {
    const g = pairDigest(
      'A片 (2001)\n链接：https://x.com/s/a（访问码：1111）B片 (2002)\n链接：https://x.com/s/b（访问码：2222）尾部群聊',
    )
    expect(g.map((x) => [x.name, x.links[0].url, x.links[0].password])).toEqual([
      ['A片 (2001)', 'https://x.com/s/a', '1111'],
      ['B片 (2002)', 'https://x.com/s/b', '2222'],
    ])
  })
  it('a link with no title before it is a MIRROR of the open work', () => {
    const g = pairDigest('大主宰 (2026) 链接：https://pan.quark.cn/s/ahttps://drive.uc.cn/s/bhttps://pan.baidu.com/s/c')
    expect(g.length).toBe(1)
    expect(g[0].name).toBe('大主宰 (2026)')
    expect(g[0].links.map((l) => l.url)).toEqual([
      'https://pan.quark.cn/s/a',
      'https://drive.uc.cn/s/b',
      'https://pan.baidu.com/s/c',
    ])
  })
  it('no links → no groups', () => {
    expect(pairDigest('just some text, no links')).toEqual([])
  })
})
