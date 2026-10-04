import { describe, it, expect } from 'vitest'
import { shareLinkKindOf, shareIdOf, SHARE_LINK_PATTERNS } from './share-link.ts'

describe('shareLinkKindOf —— 按主机判是哪家网盘', () => {
  it.each([
    ['https://pan.quark.cn/s/abc', 'quark'],
    ['https://pan.baidu.com/s/1abc', 'baidu'],
    ['https://yun.baidu.com/s/1abc', 'baidu'],
    ['https://www.alipan.com/s/abc', 'aliyun'],
    ['https://www.aliyundrive.com/s/abc', 'aliyun'],
    ['https://cloud.189.cn/t/abc', 'tianyi'],
    ['https://drive.uc.cn/s/abc', 'uc'],
    ['https://pan.xunlei.com/s/abc', 'xunlei'],
    ['https://www.123pan.com/s/abc', '123'],
    ['https://www.123912.com/s/abc', '123'],
    ['https://115.com/s/abc', '115'],
    ['https://115cdn.com/s/abc', '115'],
    ['https://anxia.com/s/abc', '115'],
    ['https://caiyun.139.com/m/i?abc', 'mobile'],
    ['https://mypikpak.com/s/abc', 'pikpak'],
  ])('%s → %s', (url, kind) => {
    expect(shareLinkKindOf(url)).toBe(kind)
  })

  it('不按子串判：主机不是网盘就不是（贴吧、查询串里提到网盘主机都不算）', () => {
    expect(shareLinkKindOf('https://tieba.baidu.com/p/1')).toBeNull()
    expect(shareLinkKindOf('https://evil.com/?u=pan.quark.cn')).toBeNull()
    expect(shareLinkKindOf('https://aliyun.com/product')).toBeNull()
  })

  it('非 URL / magnet → null', () => {
    expect(shareLinkKindOf('magnet:?xt=urn:btih:abc')).toBeNull()
    expect(shareLinkKindOf('not a url')).toBeNull()
  })
})

describe('shareIdOf —— 抠分享 id', () => {
  it.each([
    ['https://pan.quark.cn/s/a1B2?pwd=1', 'quark', 'a1B2'],
    ['https://pan.baidu.com/s/1a_b-c?pwd=abcd', 'baidu', '1a_b-c'],
    ['https://www.alipan.com/s/x_y-Z', 'aliyun', 'x_y-Z'],
    ['https://www.123pan.com/s/ab-c', '123', 'ab-c'],
  ])('%s → %s:%s', (url, kind, id) => {
    expect(shareIdOf(url)).toEqual({ kind, id })
  })

  it('没有分享路径 → null', () => {
    expect(shareIdOf('https://pan.quark.cn/list')).toBeNull()
    expect(shareIdOf('https://115.com/s/abc')).toBeNull() // 没有任何一份副本给过 115 的抽取路径
  })
})

describe('SHARE_LINK_PATTERNS —— 从一段文本里抽链接', () => {
  it('抽出混在正文里的多家链接', () => {
    const text = '资源 https://pan.quark.cn/s/aaa 提取码 1234，备用 https://www.123684.com/s/bbb-c 完'
    const found: Array<[string, string]> = []
    for (const { kind, pattern } of SHARE_LINK_PATTERNS) for (const m of text.matchAll(pattern)) found.push([kind, m[0]])
    expect(found).toEqual([
      ['quark', 'https://pan.quark.cn/s/aaa'],
      ['123', 'https://www.123684.com/s/bbb-c'],
    ])
  })

  it('每一条都是全局正则（matchAll 要求）', () => {
    for (const { pattern } of SHARE_LINK_PATTERNS) expect(pattern.flags).toContain('g')
  })
})
