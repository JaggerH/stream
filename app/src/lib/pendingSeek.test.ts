// 「先记下要落到哪一刻，等这条轨真的加载好了再落过去」这条判据的钉子。
// 最要命的那条不是"能不能落"，是**过期的落点会不会落到别人身上**：用户点了 A 的某一段、
// A 还没加载好就换播了 B，这条 pending 若不丢，写下去的是 B 的进度（而且不报错）。
import { describe, expect, it } from 'vitest'

import { applyPendingSeek, createPendingSeek } from './pendingSeek.ts'

describe('pendingSeek', () => {
  it('目标轨成了当前轨、加载好了 → 交出落点', () => {
    const s = createPendingSeek()
    s.arm('a', 120)
    expect(s.redeem('a')).toBe(120)
  })

  it('换轨（retarget）把过期的那条丢掉——不会落到后来那条轨上', () => {
    const s = createPendingSeek()
    s.arm('a', 120)
    s.retarget('b')
    expect(s.redeem('b')).toBeNull()
  })

  // 这一条是 retarget 自己的钉子（上一条被 redeem 的 id 检查兜住了，去掉 retarget 也过）：
  // 换播了别的之后**用户后来又回头播 A**——那条早就过期的落点不该在这时冒出来跳一次。
  it('换轨之后即便回头再播目标轨，也不再落点（retarget 当场丢掉，不是留着等）', () => {
    const s = createPendingSeek()
    s.arm('a', 120)
    s.retarget('b')
    expect(s.redeem('a')).toBeNull()
  })

  it('retarget 到目标轨自己不丢（它就是我们在等的那条）', () => {
    const s = createPendingSeek()
    s.arm('a', 120)
    s.retarget('a')
    expect(s.redeem('a')).toBe(120)
  })

  it('第二道闸：redeem 自己也比 id——loadedmetadata 来自别的轨时不落点且丢掉', () => {
    const s = createPendingSeek()
    s.arm('a', 120)
    expect(s.redeem('b')).toBeNull()
    // 丢了就是丢了：a 后来真的加载好也不再落点（不然会在用户回头播 A 时冒出一次意外跳转）
    expect(s.redeem('a')).toBeNull()
  })

  it('一条 pending 只兑现一次', () => {
    const s = createPendingSeek()
    s.arm('a', 120)
    expect(s.redeem('a')).toBe(120)
    expect(s.redeem('a')).toBeNull()
  })

  it('同一轨连点两段：后者覆盖前者，只落一次', () => {
    const s = createPendingSeek()
    s.arm('a', 120)
    s.arm('a', 300)
    expect(s.redeem('a')).toBe(300)
    expect(s.redeem('a')).toBeNull()
  })

  it('clear（加载失败 / stop）之后不再落点', () => {
    const s = createPendingSeek()
    s.arm('a', 120)
    s.clear()
    expect(s.redeem('a')).toBeNull()
  })

  it('没有 pending 时 redeem 是 null（当前轨是谁都一样）', () => {
    const s = createPendingSeek()
    expect(s.redeem('a')).toBeNull()
    expect(s.redeem(undefined)).toBeNull()
  })

  it('当前轨为空（stop 之后）时不落点', () => {
    const s = createPendingSeek()
    s.arm('a', 120)
    expect(s.redeem(undefined)).toBeNull()
  })
})

describe('applyPendingSeek', () => {
  it('落点写进元素的 currentTime，并回报落了', () => {
    const s = createPendingSeek()
    s.arm('a', 120)
    const el = { currentTime: 0 }
    expect(applyPendingSeek(s, el, 'a')).toBe(true)
    expect(el.currentTime).toBe(120)
  })

  it('过期的 pending 不碰元素——这是"不搓别人进度"那条不变量的落地处', () => {
    const s = createPendingSeek()
    s.arm('a', 120)
    s.retarget('b')
    const el = { currentTime: 7 }
    expect(applyPendingSeek(s, el, 'b')).toBe(false)
    expect(el.currentTime).toBe(7)
  })

  it('没有元素时不炸，也不把 pending 兑掉（元素还没挂上，落点还得等）', () => {
    const s = createPendingSeek()
    s.arm('a', 120)
    expect(applyPendingSeek(s, null, 'a')).toBe(false)
    const el = { currentTime: 0 }
    expect(applyPendingSeek(s, el, 'a')).toBe(true)
    expect(el.currentTime).toBe(120)
  })
})
