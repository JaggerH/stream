import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateGraphStore } from './state-graph-store.ts'
import type { StateGraph } from './state-graph.ts'

const origin = { proposalId: 'p1', acceptedAt: '2026-09-11T00:00:00Z' }
const authored: StateGraph = { states: [{ id: 'xhs/home', features: [{ kind: 'url', pattern: 'https://www.xiaohongshu.com/explore*' }] }], transitions: [] }

describe('StateGraphStore', () => {
  it('两层都没有 → undefined；只有包自带 → 原样；加了学到的 → 合成，且来源两格被剥掉', () => {
    const s = new StateGraphStore(mkdtempSync(join(tmpdir(), 'sg-')), (f) => (f === 'xhs' ? authored : undefined))
    expect(s.graphFor('qq')).toBeUndefined()
    expect(s.graphFor('xhs')?.states.map((x) => x.id)).toEqual(['xhs/home'])
    s.addLearnedState('xhs', { id: 'xhs/results', features: [{ kind: 'dom', selector: '.note' }], note: '结果页' }, origin)
    const g = s.graphFor('xhs')!
    expect(g.states.map((x) => x.id)).toEqual(['xhs/home', 'xhs/results'])
    expect((g.states[1] as unknown as Record<string, unknown>).proposalId).toBeUndefined()
    expect(s.learned('xhs')?.states[0]).toMatchObject({ id: 'xhs/results', proposalId: 'p1', acceptedAt: origin.acceptedAt })
  })
  it('学到的和包自带 id 撞车 → 现在写入那一步（addLearnedState）就抛，点名是谁，不等到 graphFor 才炸', () => {
    const s = new StateGraphStore(mkdtempSync(join(tmpdir(), 'sg-')), () => authored)
    expect(() => s.addLearnedState('xhs', { id: 'xhs/home', features: [{ kind: 'dom', selector: '.x' }] }, origin)).toThrow(/xhs\/home/)
  })
  it('put() 校验合成图，与 graphFor 同一判据：撞车在 addLearnedState 这一步就抛，写不进去', () => {
    const s = new StateGraphStore(mkdtempSync(join(tmpdir(), 'sg-')), () => authored)
    expect(() => s.addLearnedState('xhs', { id: 'xhs/home', features: [{ kind: 'dom', selector: '.x' }] }, origin))
      .toThrow(/xhs\/home.*撞车/)
    // 写失败，学到那层里不该留下这条
    expect(s.learned('xhs')).toBeUndefined()
  })
  it('addLearnedTransition 的 from/to 指向包自带状态（不是学到的）现在能通过', () => {
    const s = new StateGraphStore(mkdtempSync(join(tmpdir(), 'sg-')), () => authored)
    expect(() => s.addLearnedTransition('xhs', { from: 'xhs/home', to: 'xhs/home', steps: [] })).not.toThrow()
    expect(s.graphFor('xhs')?.transitions).toHaveLength(1)
  })
  it('学到的层内 id 重复 / 特征为空 / id 不带 facility 前缀 → 拒', () => {
    const s = new StateGraphStore(mkdtempSync(join(tmpdir(), 'sg-')), () => undefined)
    s.addLearnedState('xhs', { id: 'xhs/a', features: [{ kind: 'dom', selector: '.a' }] }, origin)
    expect(() => s.addLearnedState('xhs', { id: 'xhs/a', features: [{ kind: 'dom', selector: '.b' }] }, origin)).toThrow(/重复/)
    expect(() => s.addLearnedState('xhs', { id: 'xhs/b', features: [] }, origin)).toThrow(/特征为空/)
    expect(() => s.addLearnedState('xhs', { id: 'other/b', features: [{ kind: 'dom', selector: '.b' }] }, origin)).toThrow(/前缀/)
  })
  it('replaceLearnedState 只替学到那层里的；不存在的 → 抛；文件重开能读回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-'))
    const s = new StateGraphStore(dir, () => undefined)
    s.addLearnedState('xhs', { id: 'xhs/a', features: [{ kind: 'dom', selector: '.a' }] }, origin)
    s.replaceLearnedState('xhs', { id: 'xhs/a', features: [{ kind: 'dom', selector: '.a' }, { kind: 'dom', selector: '.a2' }] })
    expect(new StateGraphStore(dir, () => undefined).learned('xhs')?.states[0]?.features).toHaveLength(2)
    expect(() => s.replaceLearnedState('xhs', { id: 'xhs/zzz', features: [{ kind: 'dom', selector: '.z' }] })).toThrow(/不存在/)
  })
  it('replace 保住来源两格；addLearnedTransition 落学到那层且 from 必须指得到', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-'))
    const s = new StateGraphStore(dir, () => undefined)
    s.addLearnedState('xhs', { id: 'xhs/a', features: [{ kind: 'dom', selector: '.a' }] }, origin)
    s.replaceLearnedState('xhs', { id: 'xhs/a', features: [{ kind: 'dom', selector: '.a2' }] })
    expect(s.learned('xhs')?.states[0]).toMatchObject(origin)
    s.addLearnedTransition('xhs', { from: 'xhs/a', steps: [] })
    expect(new StateGraphStore(dir, () => undefined).learned('xhs')?.transitions).toHaveLength(1)
    // from 指不到任何状态 → validateStateGraph 当场拒（写坏的转移会让找路静默走空）
    expect(() => s.addLearnedTransition('xhs', { from: 'xhs/nope', steps: [] })).toThrow()
  })
})
