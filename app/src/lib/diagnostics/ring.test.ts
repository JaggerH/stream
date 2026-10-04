import { describe, expect, it } from 'vitest'
import { SAMPLE_CAP, EVENT_CAP, SESSION_CAP, sessionsToDrop, trimToCapacity } from './ring.ts'
import type { DiagnosticSession } from './types.ts'

const session = (
  id: string,
  startedAt: number,
  status: DiagnosticSession['status'],
  lastWriteAt = startedAt,
): DiagnosticSession => ({
  id, startedAt, lastWriteAt, appVersion: 'test', ua: 'test', status,
})

describe('trimToCapacity', () => {
  it('保留最新的样本，丢最旧的', () => {
    expect(trimToCapacity([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5])
  })

  it('未超上限时原样返回', () => {
    expect(trimToCapacity([1, 2], 3)).toEqual([1, 2])
  })

  it('恰好等于上限时不裁', () => {
    expect(trimToCapacity([1, 2, 3], 3)).toEqual([1, 2, 3])
  })

  it('空数组安全', () => {
    expect(trimToCapacity([], 3)).toEqual([])
  })
})

describe('sessionsToDrop', () => {
  it('保留最近的 N 个，丢更旧的', () => {
    const all = [session('a', 1, 'ended'), session('b', 2, 'ended'), session('c', 3, 'running'), session('d', 4, 'ended')]
    expect(sessionsToDrop(all, 3)).toEqual(['a'])
  })

  it('绝不丢 running 会话 —— 那是当前正在写的这一个', () => {
    const all = [session('cur', 1, 'running'), session('b', 2, 'ended'), session('c', 3, 'ended'), session('d', 4, 'ended')]
    expect(sessionsToDrop(all, 2)).not.toContain('cur')
  })

  it('未超上限时不丢', () => {
    expect(sessionsToDrop([session('a', 1, 'ended')], 3)).toEqual([])
  })

  // 下面三条是真机测出来的:崩溃会话被当成「最老的」清掉了 —— 正好毁掉本功能的意义。
  it('播了很久才崩的会话不因 startedAt 最早就被当成最旧', () => {
    // 崩溃会话 70 分钟前开始、1 分钟前还在写;之后又开过两个短会话。
    const crashed = session('crashed', 0, 'suspected-abnormal', 4200_000)
    const all = [
      crashed,
      session('short1', 4300_000, 'ended'),
      session('short2', 4400_000, 'ended'),
      session('cur', 4500_000, 'running'),
    ]
    // 该丢的是最早"停止活动"的那个短会话,不是 startedAt 最早的崩溃会话
    expect(sessionsToDrop(all, 3)).not.toContain('crashed')
  })

  it('宁可丢例行的 ended，也不丢 suspected-abnormal —— 那是唯一的证据', () => {
    const all = [
      session('crashed', 0, 'suspected-abnormal', 100),
      session('e1', 200, 'ended'),
      session('e2', 300, 'ended'),
      session('cur', 400, 'running'),
    ]
    expect(sessionsToDrop(all, 2)).toEqual(['e1', 'e2'])
  })

  it('多次重开页面也冲不掉崩溃记录（用户点导出前可能先刷几次）', () => {
    const all = [
      session('crashed', 0, 'suspected-abnormal', 100),
      session('r1', 200, 'ended'),
      session('r2', 300, 'ended'),
      session('r3', 400, 'ended'),
      session('cur', 500, 'running'),
    ]
    expect(sessionsToDrop(all, 3)).not.toContain('crashed')
  })
})

describe('容量常量守住 spec 的预算', () => {
  it('360 条样本 = 10 秒一条 × 60 分钟', () => {
    expect(SAMPLE_CAP).toBe(360)
    expect(EVENT_CAP).toBe(200)
    expect(SESSION_CAP).toBe(3)
  })
})
