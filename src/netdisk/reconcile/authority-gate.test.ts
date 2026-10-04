import { describe, it, expect } from 'vitest'
import { gateAuthority } from './authority-gate.ts'

const stats = (entries: number, needsSupply = 0) => ({ entries, paid: 0, withDuration: 0, needsSupply })

describe('gateAuthority', () => {
  it('没有上一轮 → 不比、放行', () => {
    expect(gateAuthority(undefined, stats(100), false)).toBeNull()
  })
  // 绝对地板：空清单是"每一份库内文件都会被判'清单里没有它'"，整库一次搬空。它不需要基线——
  // 上一轮本来就是 0（首轮、或上一轮也塌了）时，相对比较看不出任何异常，正是最危险的那一格。
  it('清单塌成 0 条 → 闸，与上一轮无关', () => {
    expect(gateAuthority(undefined, stats(0), false)?.reason).toBe('authority-empty')
    expect(gateAuthority(stats(0), stats(0), false)?.reason).toBe('authority-empty')
    expect(gateAuthority(stats(100), stats(0), false)?.reason).toBe('authority-empty')
  })
  it('清单不全（truncated）→ 闸，与上一轮无关', () => {
    expect(gateAuthority(undefined, stats(5000), true)?.reason).toBe('authority-truncated')
  })
  it('缩水 ≥10% → 闸；detail 写上一轮→本轮', () => {
    const v = gateAuthority(stats(100), stats(89), false)
    expect(v?.reason).toBe('authority-shrink')
    expect(v?.detail).toContain('100')
    expect(v?.detail).toContain('89')
  })
  it('缩水 ≥5 条也闸（大清单按绝对数）', () => {
    expect(gateAuthority(stats(1000), stats(995), false)?.reason).toBe('authority-shrink')
    expect(gateAuthority(stats(1000), stats(996), false)).toBeNull()
  })
  it('小清单少 1 条（10%）→ 闸；少 0 条 → 放行', () => {
    expect(gateAuthority(stats(10), stats(9), false)?.reason).toBe('authority-shrink')
    expect(gateAuthority(stats(10), stats(10), false)).toBeNull()
  })
  it('清单变多不闸（新集是常态）', () => {
    expect(gateAuthority(stats(100), stats(140), false)).toBeNull()
  })
  it('needsSupply 掉 ≥3 条或 ≥10% → authority-flip', () => {
    expect(gateAuthority(stats(100, 30), stats(100, 27), false)?.reason).toBe('authority-flip')
    expect(gateAuthority(stats(100, 10), stats(100, 9), false)?.reason).toBe('authority-flip')
    expect(gateAuthority(stats(100, 30), stats(100, 28), false)).toBeNull()
  })
  it('上一轮账本没有 needsSupply（老记录）→ 翻面这条不比', () => {
    const old = { entries: 100, paid: 0, withDuration: 0 } as never
    expect(gateAuthority(old, stats(100, 0), false)).toBeNull()
  })
  it('缩水与翻面同时命中 → 报缩水（更根本的那条）', () => {
    expect(gateAuthority(stats(100, 30), stats(80, 20), false)?.reason).toBe('authority-shrink')
  })
})
