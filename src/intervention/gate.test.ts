import { describe, it, expect } from 'vitest'
import { gateStateLike } from './gate.ts'
import type { Feature } from '../replay/state-graph.ts'

const dom = (selector: string): Feature => ({ kind: 'dom', selector })

describe('gateStateLike', () => {
  const known = [{ id: 'a/home', features: [dom('.home')] }, { id: 'a/list', features: [dom('.list')] }]
  it('候选此刻不成立 → not-observed', () => {
    const r = gateStateLike({ id: 'a/new', features: [dom('.gone')] }, known, [], () => false)
    expect(r).toMatchObject({ ok: false, rejection: 'not-observed' })
  })
  it('候选成立、但历史上 a/home 的观测里同样成立 → not-discriminative，点名撞了谁', () => {
    const r = gateStateLike({ id: 'a/new', features: [dom('.nav')] }, known, [{ state: 'a/home', truths: ['dom:.nav', 'dom:.home'] }], () => true)
    expect(r).toMatchObject({ ok: false, rejection: 'not-discriminative' })
    if (!r.ok) expect(r.note).toContain('a/home')
  })
  it('成立且没撞 → ok', () => {
    const r = gateStateLike({ id: 'a/new', features: [dom('.only-here')] }, known, [{ state: 'a/home', truths: ['dom:.home'] }], () => true)
    expect(r).toEqual({ ok: true })
  })
})
