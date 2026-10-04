import { describe, it, expect } from 'vitest'
import { filterRelease, filterReleases } from './resourceFilter.ts'
import type { Release, VideoSourceType } from './types.ts'

const rel = (extra: Partial<Release> = {}): Release => ({
  source: 'pansou',
  title: 't',
  quality: '1080p',
  sourceType: 'magnet',
  coverage: { kind: 'unknown' },
  link: 'magnet:?xt=urn:btih:aaaa',
  parsed: true,
  ...extra,
})

const ONLY_QUARK: Set<VideoSourceType> = new Set(['magnet', 'ed2k', 'quark'])

describe('filterRelease', () => {
  it('单链在允许集内 → 原样留', () => {
    const r = rel()
    expect(filterRelease(r, ONLY_QUARK)).toEqual(r)
  })
  it('单链不在允许集内 → null', () => {
    expect(filterRelease(rel({ sourceType: 'baidu', link: 'https://pan.baidu.com/s/x' }), ONLY_QUARK)).toBeNull()
  })
  it('unknown 类型 → 丢弃', () => {
    expect(filterRelease(rel({ sourceType: 'unknown', link: 'https://who.knows/x' }), ONLY_QUARK)).toBeNull()
  })
  it('needsResolve 的磁力（btbtla 的 /tdown/ 页）→ 留（sourceType 是 magnet）', () => {
    const r = rel({ needsResolve: true, link: 'https://btbtla.com/tdown/123', sourceType: 'magnet' })
    expect(filterRelease(r, ONLY_QUARK)).not.toBeNull()
  })

  it('混合链接：首链是百度但也带夸克 → 整条保留，夸克提到首位', () => {
    const r = rel({
      sourceType: 'baidu',
      link: 'https://pan.baidu.com/s/bbb',
      password: 'bpwd',
      links: [
        { url: 'https://pan.baidu.com/s/bbb', type: 'baidu', password: 'bpwd' },
        { url: 'https://pan.quark.cn/s/qqq', type: 'quark', password: 'qpwd' },
      ],
    })
    const out = filterRelease(r, ONLY_QUARK)!
    expect(out).not.toBeNull()
    expect(out.links).toHaveLength(1)
    expect(out.links![0].type).toBe('quark')
    // 镜像字段重新指向存活的首链 —— 不重新镜像的话 UI 会展示一个被过滤掉的百度链接
    expect(out.link).toBe('https://pan.quark.cn/s/qqq')
    expect(out.sourceType).toBe('quark')
    expect(out.password).toBe('qpwd')
  })

  it('混合链接全部不在允许集内 → 整条丢', () => {
    const r = rel({
      sourceType: 'baidu',
      link: 'https://pan.baidu.com/s/bbb',
      links: [
        { url: 'https://pan.baidu.com/s/bbb', type: 'baidu' },
        { url: 'https://www.alipan.com/s/aaa', type: 'aliyun' },
      ],
    })
    expect(filterRelease(r, ONLY_QUARK)).toBeNull()
  })

  it('存活链无 password → 镜像的 password 清掉，不留上一条的', () => {
    const r = rel({
      sourceType: 'baidu',
      link: 'https://pan.baidu.com/s/bbb',
      password: 'bpwd',
      links: [
        { url: 'https://pan.baidu.com/s/bbb', type: 'baidu', password: 'bpwd' },
        { url: 'https://pan.quark.cn/s/qqq', type: 'quark' },
      ],
    })
    expect(filterRelease(r, ONLY_QUARK)!.password).toBeUndefined()
  })

  it('允许集含百度时 → 混合链接全留，顺序不变', () => {
    const r = rel({
      sourceType: 'baidu',
      link: 'https://pan.baidu.com/s/bbb',
      links: [
        { url: 'https://pan.baidu.com/s/bbb', type: 'baidu' },
        { url: 'https://pan.quark.cn/s/qqq', type: 'quark' },
      ],
    })
    const out = filterRelease(r, new Set<VideoSourceType>(['magnet', 'ed2k', 'quark', 'baidu']))!
    expect(out.links).toHaveLength(2)
    expect(out.link).toBe('https://pan.baidu.com/s/bbb')
  })
})

describe('filterReleases', () => {
  it('丢掉全灭的，留下存活的', () => {
    const out = filterReleases([rel(), rel({ sourceType: 'baidu', link: 'https://pan.baidu.com/s/x' })], ONLY_QUARK)
    expect(out).toHaveLength(1)
    expect(out[0].sourceType).toBe('magnet')
  })
})
