import { describe, it, expect } from 'vitest'
import {
  decideCollectionReplace,
  MemoryCollectionGuard,
  NEAR_EMPTY_MAX_ITEMS,
} from './collection-replace-guard.ts'

describe('decideCollectionReplace', () => {
  const base = { authoritative: true, nextCount: 0, prevCount: 0, armed: false }

  it('非权威 → 一律不替换，理由是"本轮没采"（哪怕带着 items）', () => {
    expect(decideCollectionReplace({ ...base, authoritative: false, prevCount: 10 }))
      .toEqual({ replace: false, reason: 'not-authoritative' })
    expect(decideCollectionReplace({ ...base, authoritative: false, nextCount: 3, prevCount: 10 }))
      .toEqual({ replace: false, reason: 'not-authoritative' })
  })

  it('权威且新快照非空 → 直接替换', () => {
    expect(decideCollectionReplace({ ...base, nextCount: 5, prevCount: 3 })).toEqual({ replace: true })
  })

  it('大幅缩水但不空 → 第一轮就替换（不许有百分比拦截）', () => {
    expect(decideCollectionReplace({ ...base, nextCount: 300, prevCount: 1015 })).toEqual({ replace: true })
    expect(decideCollectionReplace({ ...base, nextCount: 1, prevCount: 1015 })).toEqual({ replace: true })
  })

  it('权威空快照 + 旧分片有货 + 第一轮 → 拦，理由是近乎全空', () => {
    expect(decideCollectionReplace({ ...base, nextCount: 0, prevCount: 3 }))
      .toEqual({ replace: false, reason: 'near-empty' })
  })

  it('权威空快照 + 已 armed（连续第二轮）→ 替换，真清空必须能生效', () => {
    expect(decideCollectionReplace({ ...base, nextCount: 0, prevCount: 3, armed: true }))
      .toEqual({ replace: true })
  })

  it('旧分片本来就空 → 无货可保，直接替换（不平白拖一轮）', () => {
    expect(decideCollectionReplace({ ...base, nextCount: 0, prevCount: 0 })).toEqual({ replace: true })
  })

  it('判据阈值钉死在 0——"近乎全空"不许悄悄放宽成一个拍脑袋的数', () => {
    expect(NEAR_EMPTY_MAX_ITEMS).toBe(0)
  })
})

describe('MemoryCollectionGuard', () => {
  it('armed 位按 (stream, source) 各自独立，clear 只清自己那一格', () => {
    const g = new MemoryCollectionGuard()
    expect(g.isArmed('s1', 'src-a')).toBe(false)
    g.arm('s1', 'src-a')
    expect(g.isArmed('s1', 'src-a')).toBe(true)
    expect(g.isArmed('s1', 'src-b')).toBe(false)
    expect(g.isArmed('s2', 'src-a')).toBe(false)
    g.clear('s1', 'src-a')
    expect(g.isArmed('s1', 'src-a')).toBe(false)
  })
})
