import { describe, it, expect } from 'vitest'
import { transcriptStandsAlone } from './transcript-stands-alone.ts'

/** 60 秒的片子里塞满字 → 语速密度远高于闸门阈值，只能靠指示语命中放行。 */
const dense = (extra = '') => ({
  result: {
    text: '啊'.repeat(600) + extra,
    detail: { media: [{ kind: 'video' as const, url: 'x', duration_s: 60 }], segments: [] },
  },
})

describe('transcriptStandsAlone', () => {
  // 用户 2026-08-30 报的那条：只有背景音乐的抖音新闻，正文整段在画面上。
  it('转写为空 → 站不住（正文本来就在画面上）', () => {
    expect(transcriptStandsAlone({ result: { text: '' } })).toBe(false)
  })

  it('大段没人说话（语速密度低）→ 站不住', () => {
    const row = { result: { text: '山山流水终于穿过了群山一座座', detail: { media: [{ kind: 'video' as const, url: 'x', duration_s: 60 }], segments: [] } } }
    expect(transcriptStandsAlone(row)).toBe(false)
  })

  it('说话人一直在指屏幕 → 站得住：转写完整，画面上的字是补充', () => {
    expect(transcriptStandsAlone(dense('你看这里，再看这里'))).toBe(true)
  })

  // 「没量到」和「验过了」必须分得开：时长不知道就算不出语速密度，按更安全的那一侧走
  // ——宁可少给一份正文，不可让一份零头被当成全文总结掉。
  it('时长不知道 → 站不住（没量到不算通过）', () => {
    expect(transcriptStandsAlone({ result: { text: '你看这里，再看这里' } })).toBe(false)
  })

  it('形状不对 / 没有记录 → 站不住', () => {
    expect(transcriptStandsAlone(undefined)).toBe(false)
    expect(transcriptStandsAlone({})).toBe(false)
  })
})
