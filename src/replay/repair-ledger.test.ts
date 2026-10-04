import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepairLedger } from './repair-ledger.ts'

describe('RepairLedger', () => {
  let dir: string
  let path: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'repair-')); path = join(dir, 'repair.json') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('quarantines after driftK consecutive drifts', () => {
    const l = new RepairLedger(path, { driftK: 3 })
    l.recordDrift('a', 'no items', 1)
    l.recordDrift('a', 'no items', 1)
    expect(l.shouldRun('a', 1)).toBe(true) // 2 < K
    l.recordDrift('a', 'no items', 1)
    expect(l.shouldRun('a', 1)).toBe(false) // quarantined
    expect(l.pending()).toEqual([{ sourceId: 'a', reason: 'no items', attempts: 0 }])
  })

  it('a success clears the drift streak', () => {
    const l = new RepairLedger(path, { driftK: 2 })
    l.recordDrift('a', 'x', 1)
    l.recordSuccess('a')
    l.recordDrift('a', 'x', 1)
    expect(l.shouldRun('a', 1)).toBe(true) // streak reset, 1 < K
  })

  it('a higher recipe version releases the quarantine', () => {
    const l = new RepairLedger(path, { driftK: 1 })
    l.recordDrift('a', 'x', 1)
    expect(l.shouldRun('a', 1)).toBe(false) // quarantined on v1
    expect(l.shouldRun('a', 2)).toBe(true) // v2 recipe → released
  })

  it('maxAttempts failures mark the source failed (stops appearing as pending)', () => {
    const l = new RepairLedger(path, { driftK: 1, maxAttempts: 2 })
    l.recordDrift('a', 'x', 1) // quarantined
    l.recordRepairAttempt('a', false)
    l.recordRepairAttempt('a', false) // 2nd → failed
    expect(l.get('a')!.status).toBe('failed')
    expect(l.pending()).toEqual([]) // no longer queued
    expect(l.shouldRun('a', 1)).toBe(false)
    expect(l.shouldRun('a', 2)).toBe(true) // a new recipe still gives it another chance
  })

  it('把「这次连累了谁」和记录一起存下来，pending 也带着它', () => {
    const l = new RepairLedger(path, { driftK: 1 })
    const affected = ['@streamapp/xhs/xhs-detail', '@streamapp/xhs/xhs-home', '@streamapp/xhs/xhs-search']
    l.recordDrift('@streamapp/xhs/xhs-detail', 'state path gone', 5, affected)
    expect(l.get('@streamapp/xhs/xhs-detail')!.affectedSources).toEqual(affected)
    expect(l.pending()[0].affectedSources).toEqual(affected)
    // 落盘再读回来还在——账是给事后看的，进程内存里对不算数。
    expect(new RepairLedger(path).get('@streamapp/xhs/xhs-detail')!.affectedSources).toEqual(affected)
  })

  it('没给就保留上一次算出来的那份，不用空数组把「没算」写成「没人」', () => {
    const l = new RepairLedger(path, { driftK: 5 })
    l.recordDrift('a', 'x', 1, ['a', 'b'])
    l.recordDrift('a', 'x', 1) // 接线方这一轮没提供解析器
    expect(l.get('a')!.affectedSources).toEqual(['a', 'b'])
    l.recordDrift('a', 'x', 1, [])
    expect(l.get('a')!.affectedSources).toEqual(['a', 'b'])
  })

  it('snapshot 是整本账的只读拷贝：改拷贝不影响账本', () => {
    const l = new RepairLedger(path, { driftK: 1 })
    l.recordDrift('a', 'r', 1)
    const snap = l.snapshot()
    expect(snap.a?.status).toBe('quarantined')
    delete snap.a
    expect(l.get('a')?.status).toBe('quarantined')
  })
})
