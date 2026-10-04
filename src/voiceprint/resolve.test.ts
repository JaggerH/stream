import { describe, it, expect } from 'vitest'
import { alignTextToClusters, mergePersonSpans, filterBlocksByDuration, type DiarizedSegment } from './resolve.ts'
import type { TranscriptSegment } from '../transcribe/client.ts'

const diar: DiarizedSegment[] = [
  { start: 0, end: 10, speaker: 'SPEAKER_00', embedding: [1, 0] },
  { start: 10, end: 20, speaker: 'SPEAKER_01', embedding: [0, 1] },
]

describe('alignTextToClusters', () => {
  it('assigns each text seg to the max-overlap cluster', () => {
    const text: TranscriptSegment[] = [
      { start: 1, end: 4, text: 'a' }, // fully in SPEAKER_00
      { start: 12, end: 18, text: 'b' }, // fully in SPEAKER_01
    ]
    const out = alignTextToClusters(text, diar)
    expect(out.map((s) => s.speaker)).toEqual(['SPEAKER_00', 'SPEAKER_01'])
  })
  it('straddling seg goes to the cluster it overlaps most', () => {
    const text: TranscriptSegment[] = [{ start: 8, end: 13, text: 'x' }] // 2s in 00, 3s in 01
    expect(alignTextToClusters(text, diar)[0].speaker).toBe('SPEAKER_01')
  })
  it('no overlap → speaker stays undefined', () => {
    const text: TranscriptSegment[] = [{ start: 30, end: 35, text: 'z' }]
    expect(alignTextToClusters(text, diar)[0].speaker).toBeUndefined()
  })
  it('does not mutate input text or preserve stale speaker', () => {
    const text: TranscriptSegment[] = [{ start: 1, end: 4, text: 'a', speaker: 'OLD' }]
    expect(alignTextToClusters(text, diar)[0].speaker).toBe('SPEAKER_00')
  })
})

describe('mergePersonSpans', () => {
  it("merges a person's own segments even when someone else speaks in between", () => {
    // 综艺实况：演员说两句、观众/主持插一句、演员继续。按「不被任何人打断」算会碎成两块。
    const segs = [
      { start: 0, end: 5, text: 'a', speaker: 'S0' },
      { start: 6, end: 9, text: '(laugh)', speaker: 'S1' },
      { start: 10, end: 20, text: 'b', speaker: 'S0' },
    ]
    const spans = mergePersonSpans(segs, { gapSeconds: 15 })
    const s0 = spans.filter((x) => x.speaker === 'S0')
    expect(s0).toHaveLength(1)
    expect(s0[0]).toMatchObject({ start: 0, end: 20, text: 'a b' })
  })

  it('still breaks when the person themself is away longer than the gap', () => {
    const segs = [
      { start: 0, end: 5, text: 'a', speaker: 'S0' },
      { start: 40, end: 45, text: 'b', speaker: 'S0' }, // 35s > 15
    ]
    expect(mergePersonSpans(segs, { gapSeconds: 15 }).filter((x) => x.speaker === 'S0')).toHaveLength(2)
  })

  it('keeps every speaker and returns spans in time order', () => {
    const segs = [
      { start: 0, end: 5, text: 'a', speaker: 'S0' },
      { start: 6, end: 12, text: 'b', speaker: 'S1' }, // 插话:S0 自己的间隔 5→14 只有 9s
      { start: 14, end: 40, text: 'c', speaker: 'S0' },
    ]
    const spans = mergePersonSpans(segs, { gapSeconds: 15 })
    expect(spans.map((s) => s.speaker)).toEqual(['S0', 'S1'])
    expect(spans[0]).toMatchObject({ speaker: 'S0', start: 0, end: 40 })
  })

  it('drops segments with no speaker', () => {
    expect(mergePersonSpans([{ start: 0, end: 5, text: 'a' }])).toEqual([])
  })
})
describe('filterBlocksByDuration', () => {
  it('keeps blocks >= minSeconds, drops shorter (60s boundary)', () => {
    const blocks = [
      { speaker: 'S0', start: 0, end: 60, text: 'keep' }, // exactly 60 → keep
      { speaker: 'S1', start: 0, end: 59.9, text: 'drop' },
    ]
    const out = filterBlocksByDuration(blocks, 60)
    expect(out.map((b) => b.text)).toEqual(['keep'])
  })
})
