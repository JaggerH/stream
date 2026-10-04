import { describe, expect, it } from 'vitest'
import { projectTranscribeSample, SEGMENT_TEXT_MAX } from './netdisk-transcribe.ts'
import type { IdentityProbe } from '../netdisk/reconcile/identity-probe.ts'

const timing = { rawUrlMs: 1, fetchMs: 2, transcribeMs: 3, bytes: 4 }
const file = { path: '/quark/来源/116.安特卫普金库案.mp3', sizeBytes: 122_000_000, durationS: 6000 }
const probe = (over?: Partial<IdentityProbe>): IdentityProbe => ({
  head: { text: '这期案件由徐先生带来，说的是安特卫普', startS: 0, endS: 120 },
  tail: { text: '感谢您收听，咱们下期再见', startS: 5880, endS: 6000 },
  timing,
  ...over,
})

describe('projectTranscribeSample', () => {
  it('两段各带位置，并明说中间没听', () => {
    const out = projectTranscribeSample({ file, windowS: 120, probe: probe(), cached: false })
    expect(out.sampledOnly).toBe(true)
    expect(String(out.coverage)).toContain('中间约 96 分钟没有听')
    const segs = out.segments as { part: string; at: string }[]
    expect(segs.map((s) => s.part)).toEqual(['head', 'tail'])
    expect(segs[0]!.at).toBe('0:00–2:00')
    expect(segs[1]!.at).toBe('98:00–100:00')
  })

  /** 短文件只有一段——那时上面就是全部内容，别摆一句「中间没听」吓唬人。 */
  it('短文件只有一段，coverage 说的是「上面就是全部」', () => {
    const out = projectTranscribeSample({
      file: { ...file, durationS: 100 },
      windowS: 120,
      probe: probe({ tail: undefined }),
      cached: true,
    })
    expect((out.segments as unknown[]).length).toBe(1)
    expect(String(out.coverage)).toContain('全部内容')
    expect(out.cached).toBe(true)
  })

  /**
   * 截断**必须自己说出来**。不说的后果和 `inbox_search` 那次一样：模型把半段当全段，
   * 静默答错，没有任何一处会报错。
   */
  it('超长的一段截断，并把截断和原长写进回执', () => {
    const long = '话'.repeat(SEGMENT_TEXT_MAX + 500)
    const out = projectTranscribeSample({
      file, windowS: 120, cached: false,
      probe: probe({ head: { text: long, startS: 0, endS: 120 } }),
    })
    const head = (out.segments as { text: string; truncated?: boolean; textChars?: number }[])[0]!
    expect(head.text.length).toBe(SEGMENT_TEXT_MAX)
    expect(head.truncated).toBe(true)
    expect(head.textChars).toBe(long.length)
  })

  /**
   * 空转写是**证据**不是失败：片尾两分钟纯音乐时 ASR 如实返回空，而「结尾没人说话」正是
   * 判「这份是不是被截断了」的关键。光秃秃一个空串会被读成取数没成。
   */
  it('某一段没人说话 → 带一句人话的 note，不是一个空串', () => {
    const out = projectTranscribeSample({
      file, windowS: 120, cached: false,
      probe: probe({ tail: { text: '', startS: 5880, endS: 6000 } }),
    })
    const tail = (out.segments as { note?: string }[])[1]!
    expect(tail.note).toContain('没有人说话')
    expect(tail.note).toContain('不是取数失败')
  })

  /**
   * 上下文闸门钉在**发出去那份 JSON 文本**上，不是只测纯函数（`docs/AGENT-TOOLING.md` §9）。
   * 把 `text` 改回 `full` 这条就当场红。
   */
  it('回执体积有天花板：一段再长也不会把整集正文糊进上下文', () => {
    const huge = '话'.repeat(200_000)
    const out = projectTranscribeSample({
      file, windowS: 120, cached: false,
      probe: probe({ head: { text: huge, startS: 0, endS: 120 }, tail: { text: huge, startS: 5880, endS: 6000 } }),
    })
    const json = JSON.stringify(out)
    expect(json).not.toContain(huge)
    expect(json.length).toBeLessThan(2 * SEGMENT_TEXT_MAX + 4000)
  })

  /** 判完要干什么写在**返回体**里（指令越靠近决策点越有效）。 */
  it('回执自带下一步：写回 reconcile_decide，且别拿采样概括整集', () => {
    const out = projectTranscribeSample({ file, windowS: 120, probe: probe(), cached: false })
    expect(String(out.next_step)).toContain('reconcile_decide')
    expect(String(out.next_step)).toContain('别拿它概括整集')
  })
})
