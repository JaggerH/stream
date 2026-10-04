import { describe, it, expect } from 'vitest'
import { Deduper } from './dedupe.ts'
import type { GroupedRelease } from './aggregate.ts'
import type { Release, SourceType } from './types.ts'

const MAG_A = 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=A'
const MAG_A2 = 'magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&tr=udp://z'
const MAG_B = 'magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&dn=B'

const rel = (source: string, link: string, extra: Partial<Release> = {}): Release => ({
  source,
  title: 't',
  quality: '1080p',
  sourceType: 'magnet',
  coverage: { kind: 'unknown' },
  link,
  parsed: true,
  ...extra,
})

const g = (release: Release, show: string | null = null): GroupedRelease => ({ show, season: null, release })

describe('Deduper — 跨源、整条丢弃', () => {
  it('同 infohash 跨源出现两次 → 第二次整条丢，dropped 计数', () => {
    const d = new Deduper()
    const first = d.admit([g(rel('nyaa', MAG_A))])
    expect(first.kept).toHaveLength(1)
    expect(first.dropped).toBe(0)

    const second = d.admit([g(rel('u3c3', MAG_A2))]) // 同 btih，大小写与 tracker 不同
    expect(second.kept).toHaveLength(0)
    expect(second.dropped).toBe(1)
  })

  it('不同 infohash → 都留', () => {
    const d = new Deduper()
    const r = d.admit([g(rel('nyaa', MAG_A)), g(rel('nyaa', MAG_B))])
    expect(r.kept).toHaveLength(2)
    expect(r.dropped).toBe(0)
  })

  it('links[] 全部见过 → 整条丢', () => {
    const d = new Deduper()
    d.admit([g(rel('pansou', 'https://pan.quark.cn/s/aaa', {
      sourceType: 'quark',
      links: [{ url: 'https://pan.quark.cn/s/aaa', type: 'quark' as SourceType }],
    }))])
    const r = d.admit([g(rel('pansou', 'https://pan.quark.cn/s/aaa?entry=tg', {
      sourceType: 'quark',
      links: [{ url: 'https://pan.quark.cn/s/aaa?entry=tg', type: 'quark' as SourceType }],
    }))])
    expect(r.kept).toHaveLength(0)
    expect(r.dropped).toBe(1)
  })

  it('links[] 里有一个新链接 → 整条留，且不改动链接类型构成（过滤是前端的事）', () => {
    const d = new Deduper()
    d.admit([g(rel('pansou', 'https://pan.quark.cn/s/seen', {
      sourceType: 'quark',
      links: [{ url: 'https://pan.quark.cn/s/seen', type: 'quark' as SourceType }],
    }))])
    const r = d.admit([g(rel('pansou', 'https://pan.quark.cn/s/seen', {
      sourceType: 'quark',
      links: [
        { url: 'https://pan.quark.cn/s/seen', type: 'quark' as SourceType },
        { url: 'https://pan.baidu.com/s/fresh', type: 'baidu' as SourceType },
      ],
    }))])
    expect(r.kept).toHaveLength(1)
    expect(r.dropped).toBe(0)
    // 已见过的 quark 链接仍在——Deduper 不做类型收窄
    expect(r.kept[0].release.links).toHaveLength(2)
  })

  it('links[] 内部同键重复 → 去掉，镜像字段仍指向第一条', () => {
    const d = new Deduper()
    const r = d.admit([g(rel('pansou', 'https://pan.quark.cn/s/dup', {
      sourceType: 'quark',
      links: [
        { url: 'https://pan.quark.cn/s/dup', type: 'quark' as SourceType, password: 'p1' },
        { url: 'https://pan.quark.cn/s/dup?entry=tg', type: 'quark' as SourceType },
        { url: 'https://pan.baidu.com/s/other', type: 'baidu' as SourceType },
      ],
    }))])
    expect(r.kept[0].release.links).toHaveLength(2)
    expect(r.kept[0].release.links![0].url).toBe('https://pan.quark.cn/s/dup')
    expect(r.kept[0].release.link).toBe('https://pan.quark.cn/s/dup')
    expect(r.kept[0].release.sourceType).toBe('quark')
  })

  it('没有 links[] 的 release 按单个 link 判身份', () => {
    const d = new Deduper()
    expect(d.admit([g(rel('nyaa', MAG_A))]).kept).toHaveLength(1)
    expect(d.admit([g(rel('btbtla', MAG_A))]).dropped).toBe(1)
  })

  it('保留分组身份（show/season 原样透传）', () => {
    const d = new Deduper()
    const r = d.admit([{ show: '上载新生', season: 3, release: rel('btbtla', MAG_A) }])
    expect(r.kept[0].show).toBe('上载新生')
    expect(r.kept[0].season).toBe(3)
  })

  it('先来的赢：喂入顺序决定谁活', () => {
    const d = new Deduper()
    d.admit([g(rel('slowsource', MAG_A))])
    const r = d.admit([g(rel('fastsource', MAG_A2))])
    expect(r.kept).toHaveLength(0)
  })
})
