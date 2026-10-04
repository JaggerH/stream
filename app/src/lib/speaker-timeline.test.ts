import { describe, it, expect } from 'vitest'
import { skipTarget, speakerColor, timelineStrips, blockLabels, speakingAt, speakerSegments, segmentSeekPoints, TAIL_PREROLL, nameableMarks } from './speaker-timeline'

const B = [
  { start: 0, end: 10, label: 'A' },
  { start: 10, end: 20, label: 'B' },
  { start: 20, end: 30, label: 'A' },
]

describe('skipTarget', () => {
  it('returns null when active is null (no filtering)', () => {
    expect(skipTarget(B, null, 15)).toBeNull()
  })
  it('returns null when t is inside an active block', () => {
    expect(skipTarget(B, new Set(['A']), 5)).toBeNull()
  })
  it('seeks to the next active block when t is in an inactive block', () => {
    expect(skipTarget(B, new Set(['A']), 15)).toEqual({ seek: 20 })
  })
  it('pauses when no active block remains ahead', () => {
    expect(skipTarget(B, new Set(['B']), 25)).toEqual({ pause: true })
  })
})

describe('speakingAt', () => {
  it('returns the label of the block covering t', () => {
    expect(speakingAt(B, 5)).toBe('A')
    expect(speakingAt(B, 15)).toBe('B')
    expect(speakingAt(B, 25)).toBe('A')
  })
  it('treats a block as [start, end) — the end instant belongs to the next block', () => {
    expect(speakingAt(B, 10)).toBe('B')
  })
  it('returns null in a gap and past the last block', () => {
    expect(speakingAt([{ start: 0, end: 10, label: 'A' }], 15)).toBeNull()
    expect(speakingAt(B, 30)).toBeNull()
  })
  it('returns null when there are no blocks', () => {
    expect(speakingAt([], 5)).toBeNull()
  })
})

describe('speakerSegments', () => {
  it('is empty until duration is known', () => {
    expect(speakerSegments(B, 0)).toEqual([])
  })
  it('maps blocks to percentage offsets of the runtime, in time order', () => {
    const segs = speakerSegments([{ start: 30, end: 60, label: 'A' }, { start: 0, end: 25, label: 'A' }], 100)
    expect(segs.map((s) => s.start)).toEqual([0, 30])
    expect(segs[0]).toMatchObject({ leftPct: 0, widthPct: 25 })
    expect(segs[1]).toMatchObject({ leftPct: 30, widthPct: 30 })
  })
  it('floors a very short block to a still-clickable width', () => {
    expect(speakerSegments([{ start: 0, end: 0.1, label: 'A' }], 1000)[0].widthPct).toBe(0.6)
  })
})

describe('segmentSeekPoints', () => {
  const seg = { start: 100, end: 500 } // 一段 400 秒的长发言
  it('段尾带提前量:落在 end 上只听得到静音/下一个人,那正是要判断的东西', () => {
    expect(segmentSeekPoints(seg)).toEqual({ start: 100, tail: 500 - TAIL_PREROLL })
  })
  it('段尾落点仍在段内——落在 end 上会被「只看」判成出段、当场弹去下一段', () => {
    const { tail } = segmentSeekPoints(seg)
    expect(skipTarget([{ ...seg, label: 'A' }], new Set(['A']), tail!)).toBeNull()
  })
  it('短段不给第二个落点:从头听就听完了,分半只会挤出两个点不准的热区', () => {
    expect(segmentSeekPoints({ start: 10, end: 15 }).tail).toBeNull()
    expect(segmentSeekPoints({ start: 10, end: 10 + 2 * TAIL_PREROLL }).tail).toBeNull()
  })
})

describe('nameableMarks', () => {
  const show = (ms: { leftPct: number; label: string }[]) =>
    nameableMarks(ms).filter((m) => m.showName).map((m) => [m.label, m.leftPct])

  it('names a speaker once, not at every one of their marks', () => {
    expect(show([
      { leftPct: 0, label: 'A' },
      { leftPct: 30, label: 'A' },
      { leftPct: 60, label: 'A' },
    ])).toEqual([['A', 0]])
  })
  it('names each distinct speaker when they are far enough apart', () => {
    expect(show([
      { leftPct: 0, label: 'A' },
      { leftPct: 40, label: 'B' },
      { leftPct: 80, label: 'C' },
    ])).toEqual([['A', 0], ['B', 40], ['C', 80]])
  })
  it('suppresses a label that would collide with the previous one', () => {
    expect(show([{ leftPct: 0, label: 'A' }, { leftPct: 3, label: 'B' }])).toEqual([['A', 0]])
  })
  it('carries a crowded-out speaker\'s name to their next mark instead of dropping it', () => {
    // B is crowded at 3, but gets named at 50 — it must not be lost entirely
    expect(show([
      { leftPct: 0, label: 'A' },
      { leftPct: 3, label: 'B' },
      { leftPct: 50, label: 'B' },
    ])).toEqual([['A', 0], ['B', 50]])
  })
  it('walks in time order regardless of input order, and keeps every mark', () => {
    const out = nameableMarks([{ leftPct: 50, label: 'B' }, { leftPct: 0, label: 'A' }])
    expect(out.map((m) => m.leftPct)).toEqual([0, 50])
    expect(out).toHaveLength(2)
  })
  it('handles an empty list', () => {
    expect(nameableMarks([])).toEqual([])
  })
})

describe('speakerColor', () => {
  it('is deterministic per label', () => {
    expect(speakerColor('庞博')).toBe(speakerColor('庞博'))
    expect(speakerColor('庞博')).not.toBe(speakerColor('徐志胜'))
  })
})

describe('timelineStrips', () => {
  it('maps blocks to percentage positions', () => {
    const strips = timelineStrips(B, 30)
    expect(strips[0]).toMatchObject({ leftPct: 0, widthPct: (10 / 30) * 100, label: 'A' })
    expect(strips[1].leftPct).toBeCloseTo((10 / 30) * 100)
  })
  it('returns [] for non-positive duration', () => {
    expect(timelineStrips(B, 0)).toEqual([])
  })
})

describe('blockLabels', () => {
  it('aggregates seconds per label, longest first', () => {
    expect(blockLabels(B)).toEqual([
      { label: 'A', seconds: 20 },
      { label: 'B', seconds: 10 },
    ])
  })
})
