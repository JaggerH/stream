// src/agent/search/extract.test.ts
import { describe, it, expect } from 'vitest'
import { extractNetdiskLinks, hubFetchUrl } from './extract.ts'

describe('hubFetchUrl', () => {
  it('rewrites a linux.do topic page to its .json endpoint (the JS shell has no links)', () => {
    expect(hubFetchUrl('https://linux.do/t/topic/1166006')).toBe('https://linux.do/t/topic/1166006.json')
    expect(hubFetchUrl('https://linux.do/t/some-slug/999')).toBe('https://linux.do/t/some-slug/999.json')
  })
  it('leaves non-topic urls unchanged', () => {
    expect(hubFetchUrl('https://linux.do/c/resource/14?page=2')).toBe('https://linux.do/c/resource/14?page=2')
    expect(hubFetchUrl('https://t.me/s/fulibas')).toBe('https://t.me/s/fulibas')
    expect(hubFetchUrl('https://fuliba2023.net/bkhj.html')).toBe('https://fuliba2023.net/bkhj.html')
  })
  // spec 2026-09-26-boundary-stage9 §2.6：认的是 Discourse 的 URL 形状，不是某个主机。
  it('rewrites any Discourse-shaped topic url (/t/<slug>/<id>), whatever the host', () => {
    expect(hubFetchUrl('https://meta.discourse.org/t/some-topic/12345')).toBe('https://meta.discourse.org/t/some-topic/12345.json')
    expect(hubFetchUrl('http://forum.example.test/t/x/7')).toBe('http://forum.example.test/t/x/7.json')
  })
  it('a post-number / query suffix is dropped — the topic .json carries the whole thread', () => {
    expect(hubFetchUrl('https://forum.example.test/t/slug/99/12')).toBe('https://forum.example.test/t/slug/99.json')
    expect(hubFetchUrl('https://forum.example.test/t/slug/99?u=bob')).toBe('https://forum.example.test/t/slug/99.json')
  })
  it('leaves an already-.json url and a non-numeric id alone', () => {
    expect(hubFetchUrl('https://forum.example.test/t/slug/99.json')).toBe('https://forum.example.test/t/slug/99.json')
    expect(hubFetchUrl('https://forum.example.test/t/slug/abc')).toBe('https://forum.example.test/t/slug/abc')
    expect(hubFetchUrl('https://forum.example.test/x/t/slug/1')).toBe('https://forum.example.test/x/t/slug/1')
  })
})

describe('extractNetdiskLinks', () => {
  it('pulls a quark link with ?pwd and a baidu link with a 提取码 label', () => {
    const text =
      '怡楽播客合集 夸克：https://pan.quark.cn/s/abc123 提取码 later\n' +
      '备份 https://pan.baidu.com/s/1AbC-dEf 提取码: q2w3 欢迎转存'
    const out = extractNetdiskLinks(text, 'https://linux.do/t/topic/1')
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ netdisk: 'quark', link: 'https://pan.quark.cn/s/abc123', sourceId: 'https://linux.do/t/topic/1' })
    expect(out[1]).toMatchObject({ netdisk: 'baidu', password: 'q2w3' })
  })

  it('captures a context snippet (the title before the link) so the link is judgeable', () => {
    const text = '<p>《怡楽播客 灵异特辑合集》 夸克链接：https://pan.quark.cn/s/ctx123 提取码 ab12</p>'
    const out = extractNetdiskLinks(text, 'hub')
    expect(out[0].snippet).toContain('怡楽播客')
  })

  it('reads ?pwd= from the query window', () => {
    const out = extractNetdiskLinks('link https://pan.quark.cn/s/xy9z?pwd=ab12 done', 'hub')
    expect(out[0]).toMatchObject({ netdisk: 'quark', password: 'ab12' })
  })

  it('dedups a repeated link', () => {
    const out = extractNetdiskLinks('https://pan.quark.cn/s/dup and again https://pan.quark.cn/s/dup', 'hub')
    expect(out).toHaveLength(1)
  })

  it('returns [] when there is no netdisk link (a page-only / login-gated hub)', () => {
    expect(extractNetdiskLinks('回复可见，登录后查看，本站积分下载', 'hub')).toEqual([])
  })
})
