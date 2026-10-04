import { describe, it, expect, vi } from 'vitest'
import { concurrentStrategy } from './concurrent.ts'
import type { StrategyContext, StrategyMemberView } from './types.ts'
import type { MemberOutcome } from '../member-pipeline.ts'
import { sourceOf } from '../invoke-types.ts'

const m = (name: string): StrategyMemberView => ({ name, sourceId: name, kind: 'source' })
const win = (name: string, value: unknown): MemberOutcome => ({ member: name, sourceId: name, kind: 'win', value, ms: 1 })
const miss = (name: string): MemberOutcome => ({ member: name, sourceId: name, kind: 'miss', reason: 'declined (no result)', ms: 1 })
const err = (name: string): MemberOutcome => ({ member: name, sourceId: name, kind: 'error', reason: 'boom', ms: 1 })

function ctx(over: Partial<StrategyContext>): StrategyContext {
  return {
    record: { id: 'row', label: '', description: '', category: 'resolve', serves: ['x'], strategy: 'concurrent', members: [], options: {} },
    members: [], input: 'k', accept: () => true,
    run: vi.fn(), admit: () => ({ allow: true }),
    ...over,
  }
}

describe('concurrent strategy', () => {
  it('全成员并发合并;items 按真源 id 打溯源标(sourceOf 读回)', async () => {
    const run = vi.fn(async (mm: StrategyMemberView) => (mm.name === 'a' ? win('a', [{ x: 1 }]) : win('b', [{ x: 2 }])))
    const r = await concurrentStrategy.invoke(ctx({ members: [m('a'), m('b')], run }))
    expect(r.strategy).toBe('concurrent')
    if (r.strategy !== 'concurrent') throw new Error('unreachable')
    expect(r.items).toHaveLength(2)
    expect(r.sources).toEqual(['a', 'b'])
    expect(sourceOf(r.items[0])).toBe('a')
    expect(sourceOf(r.items[1])).toBe('b')
  })

  it('miss/error 的成员不并入,misses/timings 逐成员', async () => {
    const run = vi.fn(async (mm: StrategyMemberView) => {
      if (mm.name === 'a') return win('a', [{ x: 1 }])
      if (mm.name === 'b') return miss('b')
      return err('c')
    })
    const r = await concurrentStrategy.invoke(ctx({ members: [m('a'), m('b'), m('c')], run }))
    expect(r.strategy).toBe('concurrent')
    if (r.strategy !== 'concurrent') throw new Error('unreachable')
    expect(r.items).toHaveLength(1)
    expect(r.sources).toEqual(['a'])
    expect(r.misses).toHaveLength(2)
    expect(r.misses.map((x) => x.member)).toEqual(['b', 'c'])
    expect(r.timings).toHaveLength(3)
  })

  it('不接熔断:admit 全拒也全员真实执行(第一期并发面无跳过)', async () => {
    const run = vi.fn(async (mm: StrategyMemberView) => win(mm.name, [1]))
    const r = await concurrentStrategy.invoke(ctx({
      members: [m('a'), m('b')],
      admit: () => ({ allow: false, retryInMs: 1 }),
      run,
    }))
    expect(run).toHaveBeenCalledTimes(2)
    expect(r.strategy).toBe('concurrent')
  })

  it('collect:结果逐成员成对,不合并 items', async () => {
    const run = vi.fn(async (mm: StrategyMemberView) => (mm.name === 'b' ? miss('b') : win(mm.name, [mm.name])))
    const r = await concurrentStrategy.collect!(ctx({ members: [m('a'), m('b'), m('c')], run }))
    expect(r.results).toEqual([{ member: 'a', value: ['a'] }, { member: 'c', value: ['c'] }])
    expect(r.misses.map((x) => x.member)).toEqual(['b'])
    expect(r.timings).toHaveLength(3)
  })
})
