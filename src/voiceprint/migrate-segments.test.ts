import { describe, expect, it } from 'vitest'
import { SpeakerRegistryStore } from './store.ts'
import { MIGRATION_KEY, migrateSegmentsToTimeline } from './migrate-segments.ts'
import type { TranscriptSegment } from '../transcribe/client.ts'

// 用真库（:memory:）而不是手搓 fake：迁移的价值全在「写进库里的东西下游读得回来」，
// fake 只能证明 fake 自己。
const mk = () => new SpeakerRegistryStore(':memory:')

const seg = (start: number, end: number, speaker?: string): TranscriptSegment => ({
  start,
  end,
  text: 'x',
  speaker,
})

describe('migrateSegmentsToTimeline', () => {
  it('抄件带 speaker 且时间线为空 → 迁出时间线（无 speaker 的段丢掉）', () => {
    const registry = mk()
    const r = migrateSegmentsToTimeline({
      registry,
      allTranscripts: () => [{ itemId: 'a', segments: [seg(0, 5, '张三'), seg(5, 8), seg(8, 12, 'SPEAKER_01')] }],
    })
    expect(r).toEqual({ skipped: false, candidates: 1, migrated: 1 })
    expect(registry.getItemTimeline('a')).toEqual([
      { start: 0, end: 5, speaker: '张三' },
      { start: 8, end: 12, speaker: 'SPEAKER_01' },
    ])
  })

  it('已有时间线的 item 不动——identify 的一等产物比抄件反推的准', () => {
    const registry = mk()
    registry.putItemTimeline('a', [{ start: 0, end: 99, speaker: 'SPEAKER_00' }])
    const r = migrateSegmentsToTimeline({
      registry,
      allTranscripts: () => [{ itemId: 'a', segments: [seg(0, 5, '张三')] }],
    })
    expect(r.candidates).toBe(0)
    expect(registry.getItemTimeline('a')).toEqual([{ start: 0, end: 99, speaker: 'SPEAKER_00' }])
  })

  it('段全无 speaker（没识别过）→ 不算 candidate、不写时间线', () => {
    const registry = mk()
    const r = migrateSegmentsToTimeline({
      registry,
      allTranscripts: () => [{ itemId: 'a', segments: [seg(0, 5), seg(5, 8)] }],
    })
    expect(r).toEqual({ skipped: false, candidates: 0, migrated: 0 })
    expect(registry.getItemTimeline('a')).toEqual([])
  })

  it('零时长/负时长的段不进时间线（probe 同款判据：那不是发言）', () => {
    const registry = mk()
    migrateSegmentsToTimeline({
      registry,
      allTranscripts: () => [{ itemId: 'a', segments: [seg(3, 3, '张三'), seg(0, 2, '张三')] }],
    })
    expect(registry.getItemTimeline('a')).toEqual([{ start: 0, end: 2, speaker: '张三' }])
  })

  it('幂等：跑过一次落标记，第二次连扫都不扫', () => {
    const registry = mk()
    let scans = 0
    const deps = {
      registry,
      allTranscripts: () => {
        scans += 1
        return [{ itemId: 'a', segments: [seg(0, 5, '张三')] }]
      },
    }
    migrateSegmentsToTimeline(deps)
    expect(registry.getMeta(MIGRATION_KEY)).toBeTruthy()
    const second = migrateSegmentsToTimeline(deps)
    expect(second.skipped).toBe(true)
    expect(scans).toBe(1)
  })
})
