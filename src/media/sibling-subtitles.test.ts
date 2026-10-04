import { describe, it, expect } from 'vitest'
import {
  matchSiblingSubtitles,
  decodeSubtitleText,
  srtToVtt,
  assToVtt,
  siblingToVtt,
} from './sibling-subtitles.ts'

const f = (name: string, size = 40_000) => ({ name, size })

describe('matchSiblingSubtitles — same-dir external subtitle discovery', () => {
  const video = 'Show.S01E01.2160p.WEB-DL.mkv'

  it('matches stem-prefixed srt/ass siblings and ignores unrelated files', () => {
    const files = [
      f('Show.S01E01.2160p.WEB-DL.mkv', 800_000_000),
      f('Show.S01E01.2160p.WEB-DL.chs.srt'),
      f('Show.S01E01.2160p.WEB-DL.ass'),
      f('Show.S01E02.2160p.WEB-DL.chs.srt'), // other episode
      f('poster.jpg'),
    ]
    const out = matchSiblingSubtitles(files, video)
    expect(out.map((s) => s.id)).toEqual([
      'file:Show.S01E01.2160p.WEB-DL.chs.srt',
      'file:Show.S01E01.2160p.WEB-DL.ass',
    ])
  })

  it('maps language suffixes to display titles (external marker included) and lang codes', () => {
    const out = matchSiblingSubtitles(
      [f('Show.S01E01.2160p.WEB-DL.chs.srt'), f('Show.S01E01.2160p.WEB-DL.CHT.srt'), f('Show.S01E01.2160p.WEB-DL.eng.srt')],
      video,
    )
    expect(out[0]).toMatchObject({ lang: 'chi', title: '简体中文（外挂）' })
    expect(out[1]).toMatchObject({ lang: 'chi', title: '繁體中文（外挂）' })
    expect(out[2]).toMatchObject({ lang: 'eng', title: 'English（外挂）' })
  })

  it('finds subtitles inside a Subs/ subdirectory (recursive listing hands over relative paths)', () => {
    const out = matchSiblingSubtitles([f('Subs/Show.S01E01.2160p.WEB-DL.简体.srt')], video)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('file:Subs/Show.S01E01.2160p.WEB-DL.简体.srt')
    expect(out[0].title).toBe('简体中文（外挂）')
  })

  it('keeps an unknown suffix verbatim as the title and uses a generic label for a bare stem match', () => {
    const out = matchSiblingSubtitles([f('Show.S01E01.2160p.WEB-DL.chs&eng.srt'), f('Show.S01E01.2160p.WEB-DL.srt')], video)
    expect(out[0].title).toBe('chs&eng（外挂）')
    expect(out[1].title).toBe('外挂字幕')
  })

  it('skips oversized files (a mislabeled video is not a subtitle)', () => {
    expect(matchSiblingSubtitles([f('Show.S01E01.2160p.WEB-DL.chs.srt', 50_000_000)], video)).toEqual([])
  })
})

describe('srtToVtt', () => {
  it('prefixes WEBVTT and swaps timestamp commas for dots, leaving cue text commas alone', () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:04,200\r\n你好, 世界\r\n\r\n2\r\n00:00:05,000 --> 00:00:06,000\r\nsecond line\r\n'
    const vtt = srtToVtt(srt)
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true)
    expect(vtt).toContain('00:00:01.000 --> 00:00:04.200')
    expect(vtt).toContain('你好, 世界')
    expect(vtt).not.toContain(',000 -->')
  })
})

describe('assToVtt', () => {
  const ass = [
    '[Script Info]',
    'Title: t',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\pos(320,240)}第一句,带逗号',
    'Dialogue: 0,0:00:04.00,0:00:05.25,Default,,0,0,0,,two\\Nlines',
  ].join('\r\n')

  it('converts Dialogue lines to VTT cues, strips override tags, honors \\N line breaks', () => {
    const vtt = assToVtt(ass)
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true)
    expect(vtt).toContain('00:00:01.500 --> 00:00:03.000')
    expect(vtt).toContain('第一句,带逗号')
    expect(vtt).not.toContain('pos(320,240)')
    expect(vtt).toContain('two\nlines')
    expect(vtt).toContain('00:00:04.000 --> 00:00:05.250')
  })
})

describe('assToVtt — drawing mode (\\p) must not become dialogue text', () => {
  const events = (...dialogues: string[]) =>
    [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      ...dialogues,
    ].join('\r\n')

  it('drops a real-world pure-drawing Sign line (\\p1 … \\p0) instead of emitting the coordinates', () => {
    const vtt = assToVtt(
      events(
        'Dialogue: 0,0:03:03.03,0:03:03.12,Sign,,0,0,0,,{\\p1}m 1475.56 275.56 l 1480 669.33 1405.33 675.56 1405.33 291.56{\\p0}',
      ),
    )
    expect(vtt).not.toContain('1475.56')
    expect(vtt).not.toContain('00:03:03.030')
  })

  it('drops drawing that runs to the end of the Dialogue line without a closing \\p0', () => {
    const vtt = assToVtt(events('Dialogue: 0,0:00:10.00,0:00:11.00,Sign,,0,0,0,,{\\p1}m 0 0 l 100 0 100 50 0 50'))
    expect(vtt).not.toContain('100 50')
    expect(vtt).not.toContain('00:00:10.000')
  })

  it('keeps the real dialogue that follows a drawing on the same line', () => {
    const vtt = assToVtt(events('Dialogue: 0,0:00:20.00,0:00:21.00,Default,,0,0,0,,{\\p1}m 0 0 l 5 5{\\p0}真对白'))
    expect(vtt).toContain('00:00:20.000 --> 00:00:21.000')
    expect(vtt).toContain('真对白')
    expect(vtt).not.toContain('m 0 0')
  })

  it('does not swallow ordinary override tags — \\an8 / \\b1 / \\pos are stripped, their text kept', () => {
    const vtt = assToVtt(
      events(
        'Dialogue: 0,0:00:30.00,0:00:31.00,Default,,0,0,0,,{\\an8}正常文本',
        'Dialogue: 0,0:00:32.00,0:00:33.00,Default,,0,0,0,,{\\b1}粗体{\\b0}尾巴',
        'Dialogue: 0,0:00:34.00,0:00:35.00,Default,,0,0,0,,{\\pos(320,240)\\pbo-10}定位文本',
      ),
    )
    expect(vtt).toContain('正常文本')
    expect(vtt).toContain('粗体尾巴')
    expect(vtt).toContain('定位文本')
    expect(vtt).not.toContain('pos(320,240)')
  })

  it('handles multiple drawing toggles mixed with text on one line, including \\p inside a multi-tag block', () => {
    const vtt = assToVtt(
      events('Dialogue: 0,0:00:40.00,0:00:41.00,Default,,0,0,0,,前{\\an8\\p1}m 1 1 l 2 2{\\p0}中{\\p2}b 3 3 4 4{\\p0}后'),
    )
    expect(vtt).toContain('00:00:40.000 --> 00:00:41.000')
    expect(vtt).toContain('前中后')
    expect(vtt).not.toContain('m 1 1')
    expect(vtt).not.toContain('b 3 3')
  })
})

describe('decodeSubtitleText — encoding fallback', () => {
  it('decodes UTF-8 (BOM stripped)', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好', 'utf8')])
    expect(decodeSubtitleText(bytes)).toBe('你好')
  })

  it('falls back to gb18030 when the bytes are not valid UTF-8 (Chinese scene subs are often GBK)', () => {
    // '你好' in GBK: c4 e3 ba c3 — invalid as UTF-8
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3])
    expect(decodeSubtitleText(gbk)).toBe('你好')
  })
})

describe('siblingToVtt — dispatch by extension', () => {
  it('converts srt bytes', () => {
    const out = siblingToVtt(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhi\n'), 'a.chs.srt')
    expect(out.startsWith('WEBVTT')).toBe(true)
    expect(out).toContain('00:00:01.000 --> 00:00:02.000')
  })

  it('passes an existing vtt through untouched', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n'
    expect(siblingToVtt(Buffer.from(vtt), 'a.vtt')).toBe(vtt)
  })
})
