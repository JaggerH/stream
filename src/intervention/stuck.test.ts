import { describe, it, expect } from 'vitest'
import { StuckDetector } from './stuck.ts'

describe('StuckDetector', () => {
  it('同工具同参数连续 3 次 → 卡住，sinceSeq 是循环起点', () => {
    const d = new StuckDetector()
    expect(d.noteToolCall(1, 'cdp_look', { js: 'a' }).stuck).toBe(false)
    expect(d.noteToolCall(2, 'cdp_look', { js: 'a' }).stuck).toBe(false)
    const v = d.noteToolCall(3, 'cdp_look', { js: 'a' })
    expect(v).toMatchObject({ stuck: true, sinceSeq: 1 })
  })
  it('参数不同不算；键顺序不同算同一参数', () => {
    const d = new StuckDetector()
    d.noteToolCall(1, 'x', { a: 1, b: 2 }); d.noteToolCall(2, 'x', { b: 2, a: 1 })
    expect(d.noteToolCall(3, 'x', { a: 1, b: 3 }).stuck).toBe(false)
    expect(d.noteToolCall(4, 'x', { b: 2, a: 1 }).stuck).toBe(false) // 中间被打断，重新计
  })
  it('ABAB 三个周期 → 卡住', () => {
    const d = new StuckDetector()
    let v = d.noteToolCall(0, 'a', {})
    for (let s = 1; s <= 5; s++) v = d.noteToolCall(s, s % 2 ? 'b' : 'a', {})
    expect(v).toMatchObject({ stuck: true, sinceSeq: 0 })
  })
  it('校验连续失败 3 轮 → 卡住；中间一次过就清零', () => {
    const d = new StuckDetector()
    d.noteValidationFail(1); d.noteValidationFail(2); d.noteValidationOk(); d.noteValidationFail(3); d.noteValidationFail(4)
    expect(d.noteValidationFail(5)).toMatchObject({ stuck: true, sinceSeq: 3 })
  })
  it('连续失败 10 次不无界增长；第 10 次的 sinceSeq 等于第 8 次的 seq', () => {
    const d = new StuckDetector()
    let v: ReturnType<StuckDetector['noteValidationFail']> = { stuck: false }
    for (let seq = 1; seq <= 10; seq++) v = d.noteValidationFail(seq)
    expect(v).toMatchObject({ stuck: true, sinceSeq: 8 })
  })
})
