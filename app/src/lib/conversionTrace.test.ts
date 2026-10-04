import { describe, expect, it } from 'vitest'
import { formatMs, ladderSummary, rungLine } from './conversionTrace.ts'
import type { LadderRung } from './types.ts'

const rung = (over: Partial<LadderRung> = {}): LadderRung => ({
  member: 'zhipu', source: 'ocr-vlm', ms: 4701, outcome: 'win', ...over,
})

describe('rungLine', () => {
  // 起了实例名的成员，寻址键（zhipu）答不出"用的哪个 source"——两个都得念出来，
  // 这正是「具体是 Provider 里哪个 source 处理的」这个问题要的东西。
  it('实例名和源 id 都念出来', () => {
    expect(rungLine(rung())).toBe('zhipu · ocr-vlm · 4.7s · 出的结果')
  })

  it('没起实例名时不把同一个名字念两遍', () => {
    expect(rungLine(rung({ member: 'ocr-mineru', source: 'ocr-mineru', ms: 900 }))).toBe('ocr-mineru · 900ms · 出的结果')
  })

  // 这条是整个功能的重点：「它弃权了」和「它试了但失败」下一步完全不同——前者去配置，
  // 后者去查故障。混成一句"没成功"，等于把最费时间的那类误诊重新造一遍。
  it('弃权和失败是两个词，不是同一句「没成功」', () => {
    expect(rungLine(rung({ outcome: 'miss', ms: 3 }))).toContain('弃权')
    expect(rungLine(rung({ outcome: 'error', ms: 3 }))).toContain('失败')
    expect(rungLine(rung({ outcome: 'miss', ms: 3 }))).not.toBe(rungLine(rung({ outcome: 'error', ms: 3 })))
  })
})

describe('ladderSummary', () => {
  it('有赢家：台面报实例名，标题报它背后的 source', () => {
    const s = ladderSummary({ via: 'zhipu', rungs: [rung()] })!
    expect(s.label).toBe('zhipu')
    expect(s.won?.source).toBe('ocr-vlm')
    expect(s.title).toBe('由「ocr-vlm」产出')
  })

  it('全员没产出：台面直说，不假装有人干了活', () => {
    const s = ladderSummary({
      via: null,
      rungs: [rung({ outcome: 'miss', reason: '未配置' }), rung({ member: 'ocr-mineru', source: 'ocr-mineru', outcome: 'error', reason: '502' })],
    })!
    expect(s.label).toBe('无人产出')
    expect(s.won).toBeUndefined()
    expect(s.title).toBe('梯子上没有成员产出结果')
  })

  // 老记录跑的时候还没记走法。画一个"未知"图标会让每一条历史记录都看着像出了事——
  // 什么都不画才是诚实的（和 timing 的现行做法一致）。
  it('老记录（没有走法）→ null，调用方什么都不画', () => {
    expect(ladderSummary(undefined)).toBeNull()
    expect(ladderSummary({ via: null, rungs: [] })).toBeNull()
  })
})

describe('formatMs', () => {
  it('按量级换单位', () => {
    expect(formatMs(900)).toBe('900ms')
    expect(formatMs(4701)).toBe('4.7s')
    expect(formatMs(95_000)).toBe('1m35s')
  })
})
