import { describe, expect, it } from 'vitest'
import { newTextAt } from './new-text.ts'

const segs = [
  { start: 0, end: 10, text: '今天讲一下缓存的三种失效策略' },
  { start: 10, end: 20, text: '第一种是定时过期' },
  { start: 100, end: 110, text: '接下来看这段代码的实现' },
]

describe('newTextAt', () => {
  it('烧进画面的字幕：与同时刻语音一致 → 丢', () => {
    const r = newTextAt('今天讲一下缓存的三种失效策略', 5, segs)
    expect(r.newText).toBe('')
    expect(r.lines[0]!.kept).toBe(false)
  })

  it('幻灯片上他没念的内容 → 留', () => {
    const r = newTextAt('maxAge = 300\nstaleWhileRevalidate = 60', 5, segs)
    expect(r.newText).toContain('maxAge = 300')
    expect(r.lines.every((l) => l.kept)).toBe(true)
  })

  it('一半字幕一半幻灯片 → 逐行判，只丢字幕那半', () => {
    const r = newTextAt('第一种是定时过期\nTTL 默认 300 秒', 15, segs)
    expect(r.newText).toBe('TTL 默认 300 秒')
  })

  it('按时刻不按全片：别处念到的内容在这一刻仍算新的', () => {
    // 「这段代码的实现」出现在 100s，但这一帧在 5s——那时他还没念到。
    const r = newTextAt('接下来看这段代码的实现', 5, segs)
    expect(r.lines[0]!.kept).toBe(true)
  })

  it('窗内没有转写（那段是静音）→ 全留', () => {
    const r = newTextAt('图表：QPS 12000', 60, segs)
    expect(r.newText).toBe('图表：QPS 12000')
  })

  it('标点与大小写不影响判定', () => {
    const r = newTextAt('今天讲一下，缓存的三种失效策略。', 5, segs)
    expect(r.newText).toBe('')
  })

  it('空帧文字 → 空结果，不抛', () => {
    expect(newTextAt('', 5, segs).newText).toBe('')
  })

  it('没有转写 → 全留（这正是最该抽帧的那类内容）', () => {
    const r = newTextAt('幻灯片标题', 5, [])
    expect(r.newText).toBe('幻灯片标题')
  })

  // 以下两条钉住门槛本身，不只是 1.0/0.0 两个极端——之前 8 条用例算出来的重合度
  // 只落在 1.0 和 0.0 两点，DEFAULT_OVERLAP 从 0.6 改成 0.99 或 0.01 全部照样绿。
  // 重合度都是按本文件的 bigram Jaccard 算法手算/脚本核实过的实数，不是估的。

  it('部分重合、高于门槛（≈0.722）→ 判重复，丢', () => {
    // '今天讲一下缓存的三种失效策略和淘汰算法' vs segs[0]'今天讲一下缓存的三种失效策略'：
    // 归一化后 14 字 vs 13 字，14 个 bigram 对 12 个 bigram，交集 12 → 12/14 ≈ 0.7143——
    // 实际用 Set 算交并（重复 bigram 只计一次）得到 0.7222，明显高于 0.6，理应判重复。
    const r = newTextAt('今天讲一下缓存的三种失效策略和淘汰算法', 5, segs)
    expect(r.lines[0]!.overlap).toBeCloseTo(0.7222, 3)
    expect(r.lines[0]!.kept).toBe(false)
    expect(r.newText).toBe('')
  })

  it('部分重合、低于门槛（=0.5）→ 判新，留', () => {
    // 评审实测过的数：'今天讲一下缓存的失效策略以及淘汰算法' vs segs[0]'今天讲一下缓存的
    // 三种失效策略'，重合度算出来正好 0.500，低于 0.6，理应判新、留下。
    const r = newTextAt('今天讲一下缓存的失效策略以及淘汰算法', 5, segs)
    expect(r.lines[0]!.overlap).toBeCloseTo(0.5, 3)
    expect(r.lines[0]!.kept).toBe(true)
    expect(r.newText).toBe('今天讲一下缓存的失效策略以及淘汰算法')
  })
})
