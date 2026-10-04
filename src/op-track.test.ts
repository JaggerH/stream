import { describe, expect, it } from 'vitest'
import { OpTracker } from './op-track.ts'

/** 手拨假时钟:track 的 fn 里 tick() 推进,span 的起止全部确定 */
function clock(start = 1000) {
  let t = start
  return { now: () => t, tick: (ms: number) => { t += ms } }
}

describe('OpTracker', () => {
  it('已结束的 span 与窗口求交(部分重叠,非 contained——span 起点早于窗口起点)', async () => {
    const c = clock(1000)
    const tr = new OpTracker(10, c.now)
    await tr.track('harvest:a', async () => { c.tick(300) })   // span [1000, 1300]
    expect(tr.overlapping(1100, 1300)).toEqual([
      { name: 'harvest:a', overlapMs: 200, opMs: 300, contained: false },
    ])
  })

  it('进行中的 span 以 now 为临时终点参与求交,opMs 也量到 now', async () => {
    const c = clock(1000)
    const tr = new OpTracker(10, c.now)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const p = tr.track('http:GET /x', () => gate)              // 开始于 1000,未结束
    c.tick(500)                                                 // now = 1500
    expect(tr.overlapping(1200)).toEqual([
      { name: 'http:GET /x', overlapMs: 300, opMs: 500, contained: false },
    ])
    release()
    await p
  })

  it('窗口外的 span 不出现;同 tier 内按重叠时长降序', async () => {
    const c = clock(1000)
    const tr = new OpTracker(10, c.now)
    await tr.track('old', async () => { c.tick(100) })          // [1000, 1100]
    await tr.track('mid', async () => { c.tick(200) })          // [1100, 1300]
    await tr.track('big', async () => { c.tick(900) })          // [1300, 2200]
    // 窗口 [1150, 2200]:old 完全在窗前;mid 部分重叠(非 contained,起点 1100 < 1150);
    // big 整段落在窗口内(contained,起点 1300 >= 1150,终点 2200 <= now 2200)。
    expect(tr.overlapping(1150, 2200)).toEqual([
      { name: 'big', overlapMs: 900, opMs: 900, contained: true },
      { name: 'mid', overlapMs: 150, opMs: 200, contained: false },
    ])
  })

  it('环超容量淘汰最老的', async () => {
    const c = clock(1000)
    const tr = new OpTracker(2, c.now)
    await tr.track('a', async () => { c.tick(10) })
    await tr.track('b', async () => { c.tick(10) })
    await tr.track('d', async () => { c.tick(10) })             // 挤掉 a
    const names = tr.overlapping(0).map((o) => o.name).sort()
    expect(names).toEqual(['b', 'd'])
  })

  it('fn 抛错:span 照常收尾进环,错误原样上抛', async () => {
    const c = clock(1000)
    const tr = new OpTracker(10, c.now)
    await expect(
      tr.track('boom', async () => { c.tick(50); throw new Error('x') })
    ).rejects.toThrow('x')
    expect(tr.overlapping(0)).toEqual([
      { name: 'boom', overlapMs: 50, opMs: 50, contained: true },
    ])
  })

  it('同名并发各自独立成条', async () => {
    const c = clock(1000)
    const tr = new OpTracker(10, c.now)
    let r1!: () => void, r2!: () => void
    const p1 = tr.track('dup', () => new Promise<void>((r) => { r1 = r }))
    const p2 = tr.track('dup', () => new Promise<void>((r) => { r2 = r }))
    c.tick(100)
    expect(tr.overlapping(1000)).toEqual([
      { name: 'dup', overlapMs: 100, opMs: 100, contained: true },
      { name: 'dup', overlapMs: 100, opMs: 100, contained: true },
    ])
    r1(); r2(); await p1; await p2
  })

  it('核心修复:contained 的短任务排在 overlapMs 更大的跨窗口长任务之前', async () => {
    const c = clock(900)
    const tr = new OpTracker(10, c.now)
    // 跨窗口长任务:起于窗口前、跨过整个窗口仍未结束——在窗口内的重叠天然拉满,
    // 但它只是"活着跨过了窗口",不代表它挡住了循环。
    const spanning = tr.track('harvest:long', () => new Promise<void>(() => { /* 挂起,直到测试结束不 resolve */ }))
    c.tick(300)                                                  // now = 1200,窗口起点定为 1000(晚于 spanning 的起点)
    // 短任务:整段落在窗口内部,重叠时长远小于跨窗口任务,但它是更强的嫌疑人。
    await tr.track('short:blocker', async () => { c.tick(50) })  // span [1200, 1250]
    // now = 1250,窗口 [1000, 1250]
    const result = tr.overlapping(1000, 1250)
    expect(result).toEqual([
      { name: 'short:blocker', overlapMs: 50, opMs: 50, contained: true },
      { name: 'harvest:long', overlapMs: 250, opMs: 350, contained: false },
    ])
    expect(result[0].overlapMs).toBeLessThan(result[1].overlapMs) // 确认排序不是单纯按 overlapMs
    void spanning // 挂起的 promise 无需 await——tracker 不依赖它 resolve
  })

  it('同 tier(均 contained)内仍按 overlapMs 降序', async () => {
    const c = clock(1000)
    const tr = new OpTracker(10, c.now)
    await tr.track('short', async () => { c.tick(50) })          // [1000, 1050], contained
    await tr.track('long', async () => { c.tick(150) })          // [1050, 1200], contained
    // 窗口 [1000, 1200]:两者都整段落在窗口内(contained),但 long 的重叠更大。
    expect(tr.overlapping(1000, 1200)).toEqual([
      { name: 'long', overlapMs: 150, opMs: 150, contained: true },
      { name: 'short', overlapMs: 50, opMs: 50, contained: true },
    ])
  })

  it('起点早于窗口、终点落在窗口内的 span 不算 contained', async () => {
    const c = clock(1000)
    const tr = new OpTracker(10, c.now)
    await tr.track('straddle', async () => { c.tick(150) })      // span [1000, 1150]
    // 窗口起点 1050——span 起点(1000) < 窗口起点,即便终点(1150) <= now,仍非 contained。
    expect(tr.overlapping(1050, 1150)).toEqual([
      { name: 'straddle', overlapMs: 100, opMs: 150, contained: false },
    ])
  })

  it('trackSync 同步收尾 span,返回值与异常原样穿过', () => {
    const c = clock(1000)
    const tr = new OpTracker(10, c.now)
    const out = tr.trackSync('sync-op', () => { c.tick(120); return 7 })
    expect(out).toBe(7)
    // span 在 fn 返回的同一拍收尾——不是微任务之后(这正是它区别于 track 的全部意义)
    expect(tr.overlapping(1000)).toEqual([{ name: 'sync-op', overlapMs: 120, opMs: 120, contained: true }])
    expect(() => tr.trackSync('boom', () => { c.tick(50); throw new Error('x') })).toThrow('x')
    expect(tr.overlapping(1000).map((o) => o.name)).toEqual(['sync-op', 'boom'])
  })
})
