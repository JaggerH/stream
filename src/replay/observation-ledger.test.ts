import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ObservationLedger, facilityFileName } from './observation-ledger.ts'

describe('ObservationLedger', () => {
  it('按 facility 追加、去重（同 state 同 truths 只留一条）、上限 200 条、重开能读回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-'))
    const l = new ObservationLedger(dir)
    l.record('xhs', { state: 'xhs/home', truths: ['url:https://a/*', 'dom:.home'] })
    l.record('xhs', { state: 'xhs/home', truths: ['dom:.home', 'url:https://a/*'] }) // 同一份，顺序不同
    l.record('xhs', { state: 'xhs/list', truths: ['dom:.list'] })
    expect(l.for('xhs')).toHaveLength(2)
    for (let i = 0; i < 300; i++) l.record('xhs', { state: 'xhs/x', truths: [`dom:.n${i}`] })
    expect(l.for('xhs').length).toBeLessThanOrEqual(200)
    expect(new ObservationLedger(dir).for('xhs').length).toBe(l.for('xhs').length)
    expect(new ObservationLedger(dir).for('never')).toEqual([])
  })

  it('去重键带分隔符，拼接歧义的两组 truths 不会被误判成同一条', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-'))
    const l = new ObservationLedger(dir)
    l.record('xhs', { state: 'xhs/home', truths: ['dom:.ab', 'dom:.c'] })
    l.record('xhs', { state: 'xhs/home', truths: ['dom:.a', 'dom:.bc'] })
    expect(l.for('xhs')).toHaveLength(2)
  })

  it('账本文件被外部改坏成非数组 → 如实回空，不把半成品当观测用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-'))
    const l = new ObservationLedger(dir)
    l.record('xhs', { state: 'xhs/home', truths: ['dom:.home'] })
    writeFileSync(join(dir, `${facilityFileName('xhs')}.json`), JSON.stringify({ not: 'an array' }))
    expect(new ObservationLedger(dir).for('xhs')).toEqual([])
  })

  it('facility 之间互不串台；带斜杠的 facility 换成下划线落一个文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-'))
    const l = new ObservationLedger(dir)
    l.record('xhs', { state: 'xhs/home', truths: ['dom:.home'] })
    l.record('a/b', { state: 'a/b/home', truths: ['dom:.x'] })
    expect(l.for('xhs')).toHaveLength(1)
    expect(l.for('a/b')).toEqual([{ state: 'a/b/home', truths: ['dom:.x'] }])
    expect(facilityFileName('a/b')).toBe('a_b')
  })
})
