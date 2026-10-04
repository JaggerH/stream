import { describe, it, expect } from 'vitest'
import { detectSubtitleLang, langDisplayName, vttHasCues, isLikelyDanmaku, type SubLangKind } from './subtitle-lang.ts'

// 「字幕最终落地的语言类型」的唯一可靠真相源是内容本身——文件名的简/繁/英标记不可信、中文剧名
// 结果压根没有标记。这些用例喂进 VTT 化的字幕文本，断言从内容判出的语言。

const VTT = (body: string) => `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n${body}\n`

describe('detectSubtitleLang — 从内容判语言', () => {
  it('纯简体中文', () => {
    const t = VTT('你好，这里是简体中文字幕。\n\n00:00:04.000 --> 00:00:06.000\n他们说这个国家会变样。')
    expect(detectSubtitleLang(t)).toBe<SubLangKind>('simp')
  })

  it('纯繁體中文（繁体独有字触发）', () => {
    const t = VTT('你好，這裡是繁體中文字幕。\n\n00:00:04.000 --> 00:00:06.000\n他們說這個國家會變樣。')
    expect(detectSubtitleLang(t)).toBe<SubLangKind>('trad')
  })

  it('纯英文', () => {
    const t = VTT('Hello, this is an English subtitle line.\n\n00:00:04.000 --> 00:00:06.000\nThey said the country would change.')
    expect(detectSubtitleLang(t)).toBe<SubLangKind>('eng')
  })

  it('简体中英双语（两种脚本都大量出现）', () => {
    const t = VTT('你好，这里是简体中文。\nHello, this is English.\n\n00:00:04.000 --> 00:00:06.000\n他们说这个国家会变样。\nThey said the country would change.')
    expect(detectSubtitleLang(t)).toBe<SubLangKind>('simp-eng')
  })

  it('繁體中英双语', () => {
    const t = VTT('你好，這裡是繁體中文。\nHello English here.\n\n00:00:04.000 --> 00:00:06.000\n他們說這個國家會變樣。\nThey said the country changes.')
    expect(detectSubtitleLang(t)).toBe<SubLangKind>('trad-eng')
  })

  it('零星几个 latin 词（片头字体名/OP staff）不算英文', () => {
    // ASS 转出来偶尔混一两个拉丁词，不该把纯中文误判成双语。
    const t = VTT('这一集的字幕。\nOP\n\n00:00:04.000 --> 00:00:06.000\n他们说这个国家会变样，很多很多的中文在这里堆着。')
    expect(detectSubtitleLang(t)).toBe<SubLangKind>('simp')
  })

  it('内容太少/没有可判信号 → unknown', () => {
    expect(detectSubtitleLang('WEBVTT\n\n')).toBe<SubLangKind>('unknown')
    expect(detectSubtitleLang('')).toBe<SubLangKind>('unknown')
  })
})

describe('vttHasCues — VTT 里到底有没有对白', () => {
  it('有 cue（时间轴后跟文本）→ true', () => {
    expect(vttHasCues('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n你好\n')).toBe(true)
  })
  it('只有头、没有 cue → false（迅雷的只含字体空壳 .ass 转出来就是这样）', () => {
    expect(vttHasCues('WEBVTT\n\n')).toBe(false)
    expect(vttHasCues('WEBVTT')).toBe(false)
    expect(vttHasCues('')).toBe(false)
  })
  it('有时间轴但后面没有文本行 → false', () => {
    expect(vttHasCues('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n\n')).toBe(false)
  })
})

// 迅雷会混进「弹幕伪装成 .ass」——B站弹幕导出,每条 Dialogue 用 \move 滚动/\pos 定位在画面上飞。
// assToVtt 剥掉动画标签后只剩满屏评论文本,当字幕显示就是乱码(进击的巨人 S01E02 活体:2974 条
// Dialogue,91% 带 \move,内容全是「求别卡」「没弹幕？？？」「巨人从屁股下蛋繁殖」这种评论)。
describe('isLikelyDanmaku — 弹幕伪装成字幕的识别', () => {
  const danmakuAss = (n: number) => {
    const head = '[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
    const lines = Array.from({ length: n }, (_, i) =>
      `Dialogue: 0,0:00:0${i % 10}.00,0:00:1${i % 10}.00,Default,,0,0,0,,{\\a6\\move(460, ${i}, 0, ${i})\\c&HFFFFFF\\fs25}评论文本${i}`)
    return head + lines.join('\n')
  }
  const subtitleAss = (n: number) => {
    const head = '[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
    const lines = Array.from({ length: n }, (_, i) =>
      `Dialogue: 0,0:0${i % 6}:00.00,0:0${i % 6}:03.00,Default,,0,0,0,,这是第${i}句正常字幕对白。`)
    return head + lines.join('\n')
  }

  it('满屏 \\move 滚动 → 判为弹幕', () => {
    expect(isLikelyDanmaku(danmakuAss(100))).toBe(true)
  })
  it('正常字幕(无动画标签)→ 不是弹幕', () => {
    expect(isLikelyDanmaku(subtitleAss(100))).toBe(false)
  })
  it('偶尔几条定位(OP/ED 特效)不误判整片为弹幕', () => {
    // 200 条正常对白 + 5 条 \pos 特效 → 占比极低,不是弹幕
    const mixed = subtitleAss(200) + '\n' +
      Array.from({ length: 5 }, (_, i) => `Dialogue: 0,0:00:00.00,0:00:03.00,Sign,,0,0,0,,{\\pos(100,${i})}标题特效`).join('\n')
    expect(isLikelyDanmaku(mixed)).toBe(false)
  })
  it('对白太少(短片段)不轻易判弹幕', () => {
    expect(isLikelyDanmaku(danmakuAss(10))).toBe(false)
  })
  it('非 ass(srt 纯文本)→ 不是弹幕', () => {
    expect(isLikelyDanmaku('1\n00:00:01,000 --> 00:00:03,000\n你好\n')).toBe(false)
  })
})

describe('langDisplayName — 语言类型的中文名', () => {
  it('每种 kind 一个明确的中文标签', () => {
    const map: Record<SubLangKind, string> = {
      simp: '简体中文',
      trad: '繁體中文',
      eng: '英文',
      'simp-eng': '简体中英',
      'trad-eng': '繁體中英',
      unknown: '未知',
    }
    for (const [kind, name] of Object.entries(map)) {
      expect(langDisplayName(kind as SubLangKind)).toBe(name)
    }
  })
})
