import { describe, it, expect } from 'vitest'
import { pansouNormalizer } from './normalizer.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

const manifest = { id: 'pansou-search' } as unknown as SourceManifest

describe('pansouNormalizer', () => {
  it('一条 SearchResult → link Content：每个网盘分享变成带类型标签 + 提取码的 link 卡', () => {
    const out = pansouNormalizer({
      title: '某剧 全集',
      content: '4K 国语中字',
      links: [
        { type: 'quark', url: 'https://pan.quark.cn/s/abc' },
        { type: 'baidu', url: 'https://pan.baidu.com/s/def', password: 'x1y2' },
        { type: 'weird', url: 'https://example.test/z' },
        { type: 'aliyun' }, // 没 url 的丢掉
      ],
    }, manifest)
    expect(out.archetype).toBe('link')
    expect(out.title).toBe('某剧 全集')
    expect(out.text).toBe('4K 国语中字')
    expect(out.media).toEqual([
      { kind: 'link', url: 'https://pan.quark.cn/s/abc', title: '夸克网盘' },
      { kind: 'link', url: 'https://pan.baidu.com/s/def', title: '百度网盘 · 提取码 x1y2' },
      { kind: 'link', url: 'https://example.test/z', title: 'weird' },
    ])
  })

  it('空壳结果也是合法 Content（不抛）', () => {
    const out = pansouNormalizer({}, manifest)
    expect(out).toEqual({ archetype: 'link', title: undefined, text: undefined, media: [] })
  })
})
