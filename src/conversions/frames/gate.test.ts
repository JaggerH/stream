import { describe, expect, it } from 'vitest'
import { framesGate, DEFAULT_SPARSE_CPM, DEICTIC_WORDS } from './gate.ts'

/** 造一段「说得很密」的转写：n 分钟、每分钟 cpm 个字。 */
const dense = (minutes: number, cpm: number) => '啊'.repeat(Math.round(minutes * cpm))

describe('framesGate', () => {
  it('没有转写 → 抽。信息可能全在画面上，这是最该抽的一类', () => {
    const v = framesGate({ text: '', durationS: 600 })
    expect(v.go).toBe(true)
    expect(v.reason).toBe('no_transcript')
  })

  it('说得密、没有指示语 → 不抽（纯口播）', () => {
    const v = framesGate({ text: dense(10, 400), durationS: 600 })
    expect(v.go).toBe(false)
    expect(v.reason).toBe('dense_speech')
    expect(v.charsPerMinute).toBeGreaterThan(DEFAULT_SPARSE_CPM)
  })

  it('大段没人说话 → 抽', () => {
    const v = framesGate({ text: dense(10, 60), durationS: 600 })
    expect(v.go).toBe(true)
    expect(v.reason).toBe('sparse_speech')
  })

  it('说得密但一直在指屏幕 → 抽（转写必然缺一半）', () => {
    const v = framesGate({ text: `${dense(10, 400)}你看这里，我点一下，如图`, durationS: 600 })
    expect(v.go).toBe(true)
    expect(v.reason).toBe('deictic')
    expect(v.deicticHits).toBeGreaterThanOrEqual(2)
  })

  // 阈值本身要有一条钉着它的测试。上一版没有：把 2 改成 1，237 条测试**一条都没红**——
  // 一个没人守的阈值，改对改错都无声。这条钉的是边界（恰好 1 次就放行），阈值一动就红。
  it('高语速、指示语只命中 1 次 → 仍然抽（量出来的边界，见 DEFAULT_DEICTIC_HITS）', () => {
    const v = framesGate({ text: `${dense(10, 400)}这个时候看直方图`, durationS: 600 })
    expect(v.deicticHits).toBe(1)
    expect(v.go).toBe(true)
    expect(v.reason).toBe('deictic')
  })

  it('时长不知道（0）→ 抽，理由是 unknown_duration 不是 sparse_speech（不能编个假理由）', () => {
    const v = framesGate({ text: dense(10, 400), durationS: 0 })
    expect(v.go).toBe(true)
    expect(v.reason).toBe('unknown_duration')
    // 没量到就是没量到，不能记成 0——0 是「真的没人说话」的读数，两者混了会污染
    // 将来拿这批账定阈值的量法。
    expect(v.charsPerMinute).toBeNull()
  })

  it('没有转写 → charsPerMinute 也是 null，不是 0（同样是「没量到」不是「真的 0」）', () => {
    const v = framesGate({ text: '', durationS: 600 })
    expect(v.charsPerMinute).toBeNull()
  })

  it('读数照记，即使判为不抽——账要能回答「为什么没抽」', () => {
    const v = framesGate({ text: dense(10, 400), durationS: 600 })
    expect(v.charsPerMinute).toBeCloseTo(400, 0)
    expect(v.deicticHits).toBe(0)
  })

  it('词表是导出的具名常量，加词的人找得到', () => {
    expect(DEICTIC_WORDS.length).toBeGreaterThan(5)
    expect(DEICTIC_WORDS).toContain('如图')
  })
})
