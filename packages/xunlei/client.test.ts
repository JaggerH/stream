import { describe, it, expect } from 'vitest'
import { classifySubtitleName, fetchXunleiSubtitle, filterXunlei, isAllowedXunleiHost, parseSeasonEpisode, searchXunlei, type XunleiEntry } from './client.ts'
import { XunleiSubtitleAdapter } from './adapter.ts'

// 搬家等价：以下用例搬自宿主 src/media/subtitle-scrape.test.ts（迅雷那一半），行为不变；
// 只有两处换了形状——候选 id 是直链本身（宿主再编进 scrape: 命名空间），排序归宿主。

// ---- spike-recorded xunlei response shape (Rick and Morty S08E01, 2026-07-24) ----
const XL_ENTRY = (name: string, ext = 'srt'): XunleiEntry => ({
  gcid: 'ABC',
  url: `https://subtitle.v.geilijiasu.com/AB/CD/ABC.${ext}`,
  ext,
  name,
  duration: 0,
  languages: [''],
  score: 0,
})

describe('parseSeasonEpisode', () => {
  it('extracts SxxExx numerically, tolerating separators and E-width', () => {
    expect(parseSeasonEpisode('Rick.and.Morty.S08E01.1080p.mkv')).toEqual({ s: 8, e: 1 })
    expect(parseSeasonEpisode('Show S01E08 720p')).toEqual({ s: 1, e: 8 })
    expect(parseSeasonEpisode('foo.s10.e123.bar')).toEqual({ s: 10, e: 123 })
  })
  it('returns null when there is no SxxExx (movie)', () => {
    expect(parseSeasonEpisode('Dune.Part.Two.2024.2160p.mkv')).toBeNull()
  })
})

describe('filterXunlei — strict SxxExx filter (必串台防护)', () => {
  it('drops digit-flipped episodes: query S08E01 must exclude S01E08', () => {
    const entries = [
      XL_ENTRY('rick.and.morty.s08e01.简体&英文.srt'),
      XL_ENTRY('rick.and.morty.s01e08.简体&英文.srt'), // flipped — must be excluded
    ]
    const out = filterXunlei(entries, 'Rick.and.Morty.S08E01.1080p.mkv')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(entries[0].url)
  })

  it('drops entries with no extractable SxxExx when target has one', () => {
    const out = filterXunlei([XL_ENTRY('rick.and.morty.s08e01.简体.srt'), XL_ENTRY('some.random.subtitle.简体.srt')], 'Rick.and.Morty.S08E01.1080p.mkv')
    expect(out).toHaveLength(1)
  })

  it('movie path (target has no SxxExx): keeps all, no episode filtering', () => {
    const out = filterXunlei([XL_ENTRY('Dune.Part.Two.简体&英文.srt'), XL_ENTRY('Dune.Part.Two.英文.srt')], 'Dune.Part.Two.2024.2160p.mkv')
    expect(out).toHaveLength(2)
  })

  it('文件名给出语言线索（nameHint），来源标签是「迅雷」', () => {
    const out = filterXunlei([XL_ENTRY('x.s08e01.英文.srt'), XL_ENTRY('x.s08e01.简体&英文.srt')], 'x.S08E01.mkv')
    expect(out.map((t) => t.nameHint)).toEqual(['eng', 'simp-eng'])
    expect(out.every((t) => t.label === '迅雷')).toBe(true)
  })

  it('完全重名（迅雷同名返回多遍）折叠成一条候选', () => {
    const dup = (tail: string): XunleiEntry => ({ url: `https://subtitle.v.geilijiasu.com/${tail}.ass`, name: '进击的巨人 (01).ass', ext: 'ass' })
    const out = filterXunlei([dup('a'), dup('b'), dup('c')], '进击的巨人.mkv')
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('进击的巨人 (01)')
  })

  it('不在字幕主机白名单上的直链直接丢掉', () => {
    expect(filterXunlei([{ url: 'https://evil.example.com/x.srt', name: 'x.srt' }], 'x.mkv')).toEqual([])
  })
})

describe('classifySubtitleName — 文件名线索（仅兜底）', () => {
  it('detects zh-cn.eng bilingual form', () => {
    expect(classifySubtitleName('foo.zh-cn.eng.ass')).toBe('simp-eng')
  })
  it('繁体&英文 / 简体&英文 分得开', () => {
    expect(classifySubtitleName('foo.繁体&英文.ass')).toBe('trad-eng')
    expect(classifySubtitleName('foo.简体&英文.srt')).toBe('simp-eng')
  })
  it('无语言标记的中文名 → unknown（进击的巨人这类）', () => {
    expect(classifySubtitleName('进击的巨人 (01).ass')).toBe('unknown')
  })
})

describe('searchXunlei', () => {
  it('parses data[] and applies strict filter; empty/error → []', async () => {
    const body = { code: 0, result: 'ok', data: [XL_ENTRY('r.s08e01.简体&英文.srt'), XL_ENTRY('r.s01e08.简体.srt')] }
    const fakeFetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch
    expect(await searchXunlei('Rick.S08E01.mkv', fakeFetch)).toHaveLength(1)
    const boom = (async () => { throw new Error('net') }) as typeof fetch
    expect(await searchXunlei('x', boom)).toEqual([])
  })
})

describe('主机白名单 + 取字节（SSRF 边界住包里）', () => {
  it('allows only xunlei subtitle hosts', () => {
    expect(isAllowedXunleiHost('https://subtitle.v.geilijiasu.com/x.srt')).toBe(true)
    expect(isAllowedXunleiHost('https://evil.example.com/x.srt')).toBe(false)
    expect(isAllowedXunleiHost('https://evil-geilijiasu.com/x.srt')).toBe(false)
    expect(isAllowedXunleiHost('file:///etc/passwd')).toBe(false)
    expect(isAllowedXunleiHost('not a url')).toBe(false)
  })
  it('伪造的 id 指向别的主机 → 抛，不发请求', async () => {
    let called = 0
    const f = (async () => { called++; return new Response('x') }) as typeof fetch
    await expect(fetchXunleiSubtitle('http://127.0.0.1:8900/api/x', f)).rejects.toThrow(/拒绝/)
    expect(called).toBe(0)
  })
  it('合法 id → 字节', async () => {
    const f = (async () => new Response('1\n00:00:01,000 --> 00:00:02,000\nhi\n')) as typeof fetch
    const bytes = await fetchXunleiSubtitle('https://subtitle.v.geilijiasu.com/a.srt', f)
    expect(Buffer.from(bytes).toString('utf8')).toContain('hi')
  })
})

describe('XunleiSubtitleAdapter — 两个操作', () => {
  it('op:search → 候选；op:fetch → [{bytes}]；别的 → []', async () => {
    const f = (async (u: string) => (String(u).includes('oracle')
      ? new Response(JSON.stringify({ data: [XL_ENTRY('m.简体.srt')] }))
      : new Response('abc'))) as unknown as typeof fetch
    const a = new XunleiSubtitleAdapter(f)
    const hits = await a.fetch({ op: 'search', name: 'm.mkv' }) as Array<{ id: string }>
    expect(hits).toHaveLength(1)
    const got = await a.fetch({ op: 'fetch', id: hits[0].id }) as Array<{ bytes: Uint8Array }>
    expect(Buffer.from(got[0].bytes).toString()).toBe('abc')
    expect(await a.fetch({ keyword: 'x' })).toEqual([])
  })
})
