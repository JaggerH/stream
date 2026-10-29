import { describe, expect, it } from 'vitest'
import { PairingGuard, TokenBucket } from './rate-limit.ts'

/** 可拨的钟 */
function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('TokenBucket', () => {
  it('容量内放行，用完就拒；按时间补充', () => {
    const c = clock()
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 1, now: c.now })
    expect(b.take('a')).toBe(true)
    expect(b.take('a')).toBe(true)
    expect(b.take('a')).toBe(false)
    c.advance(1000)
    expect(b.take('a')).toBe(true)
    expect(b.take('a')).toBe(false)
  })

  it('按来源各自一桶；没有来源的共用一桶', () => {
    const c = clock()
    const b = new TokenBucket({ capacity: 1, refillPerSecond: 0.001, now: c.now })
    expect(b.take('a')).toBe(true)
    expect(b.take('a')).toBe(false)
    expect(b.take('b')).toBe(true)
    expect(b.take(undefined)).toBe(true)
    expect(b.take(undefined)).toBe(false)
  })

  it('键太多时丢掉已经补满的桶，内存不随历史来源无限涨', () => {
    const c = clock()
    const b = new TokenBucket({ capacity: 1, refillPerSecond: 1, now: c.now, maxKeys: 2 })
    b.take('a')
    b.take('b')
    c.advance(2000) // a / b 都补满了
    b.take('c') // 触发清理
    expect(b.size()).toBeLessThanOrEqual(2)
    // 补满的桶被丢掉不改变行为：再打一次照样放行
    expect(b.take('a')).toBe(true)
  })
})

describe('PairingGuard', () => {
  const opts = (c: ReturnType<typeof clock>) => ({
    now: c.now,
    maxFailures: 3,
    failureWindowMs: 60_000,
    cooldownMs: 30_000,
    burst: 10,
    refillPerSecond: 1,
  })

  it('连续失败到阈值 → 冷却；冷却期内正确的码也进不来；冷却结束恢复', () => {
    const c = clock()
    const g = new PairingGuard(opts(c))
    for (let i = 0; i < 3; i++) {
      expect(g.allow('1.2.3.4')).toBe(true)
      g.fail('1.2.3.4')
    }
    expect(g.allow('1.2.3.4')).toBe(false)
    expect(g.retryAfterSeconds('1.2.3.4')).toBe(30)
    // 别的来源不受影响
    expect(g.allow('5.6.7.8')).toBe(true)
    c.advance(30_000)
    expect(g.allow('1.2.3.4')).toBe(true)
  })

  it('窗口外的失败不算数', () => {
    const c = clock()
    const g = new PairingGuard(opts(c))
    g.fail('a')
    g.fail('a')
    c.advance(61_000)
    g.fail('a') // 前两次已出窗，这是新窗口里的第 1 次
    expect(g.allow('a')).toBe(true)
  })

  it('成功一次清掉这个来源的失败计数', () => {
    const c = clock()
    const g = new PairingGuard(opts(c))
    g.fail('a')
    g.fail('a')
    g.succeed('a')
    g.fail('a')
    g.fail('a')
    expect(g.allow('a')).toBe(true) // 没有累计到 3
  })

  it('请求令牌桶：同一来源打太快，还没失败也先拒', () => {
    const c = clock()
    const g = new PairingGuard({ ...opts(c), burst: 2, refillPerSecond: 0.001 })
    expect(g.allow('a')).toBe(true)
    expect(g.allow('a')).toBe(true)
    expect(g.allow('a')).toBe(false)
  })
})
