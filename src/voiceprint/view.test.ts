import { describe, expect, it } from 'vitest'
import { speakerViewOf } from './view.ts'
import type { TranscriptSegment } from '../transcribe/client.ts'

const seg = (start: number, end: number, text: string, speaker?: string): TranscriptSegment => ({
  start,
  end,
  text,
  speaker,
})

describe('speakerViewOf', () => {
  it('投影：时间线的名字按重叠贴到文字段上', () => {
    const v = speakerViewOf(
      {
        timeline: () => [
          { start: 0, end: 6, speaker: '张三' },
          { start: 6, end: 12, speaker: 'SPEAKER_01' },
        ],
        segments: () => [seg(1, 5, '早上好'), seg(7, 11, '你好')],
      },
      'a'
    )
    expect(v.hasSpeakers).toBe(true)
    expect(v.segments.map((s) => s.speaker)).toEqual(['张三', 'SPEAKER_01'])
  })

  it('转写段自带的旧 speaker 被投影覆写——抄件里的残留名字不是数据源', () => {
    const v = speakerViewOf(
      {
        timeline: () => [{ start: 0, end: 10, speaker: '李四' }],
        segments: () => [seg(1, 5, 'x', '旧名字'), seg(90, 95, 'y', '旧名字')],
      },
      'a'
    )
    // 第一段落在时间线内 → 换成时间线的名字；第二段与时间线无重叠 → 旧名字也被剥掉。
    expect(v.segments.map((s) => s.speaker)).toEqual(['李四', undefined])
  })

  it('时间线为空 → hasSpeakers:false，文字原样、speaker 全剥（无退档读抄件）', () => {
    const v = speakerViewOf(
      { timeline: () => [], segments: () => [seg(0, 5, 'x', '抄件残留')] },
      'a'
    )
    expect(v.hasSpeakers).toBe(false)
    expect(v.segments).toEqual([seg(0, 5, 'x', undefined)])
  })

  it('时间线有、转写没有 → segments 空但 hasSpeakers:true（纯 diarization 的 item）', () => {
    const v = speakerViewOf(
      { timeline: () => [{ start: 0, end: 5, speaker: 'SPEAKER_00' }], segments: () => [] },
      'a'
    )
    expect(v.hasSpeakers).toBe(true)
    expect(v.segments).toEqual([])
    expect(v.timeline).toHaveLength(1)
  })
})
