import { describe, it, expect, vi } from 'vitest'
import { sequentialStrategy } from './sequential.ts'
import type { StrategyContext, StrategyMemberView } from './types.ts'
import type { MemberOutcome } from '../member-pipeline.ts'

const m = (name: string): StrategyMemberView => ({ name, sourceId: name, kind: 'source' })
const win = (name: string, value: unknown): MemberOutcome => ({ member: name, sourceId: name, kind: 'win', value, ms: 1 })
const miss = (name: string): MemberOutcome => ({ member: name, sourceId: name, kind: 'miss', reason: 'declined (no result)', ms: 1 })

function ctx(over: Partial<StrategyContext>): StrategyContext {
  return {
    record: { id: 'row', label: '', description: '', category: 'resolve', serves: ['x'], strategy: 'sequential', members: [], options: {} },
    members: [], input: 'k', accept: () => true,
    run: vi.fn(), admit: () => ({ allow: true }),
    ...over,
  }
}

describe('sequential strategy', () => {
  it('第一个合格结果赢，后面的成员不再执行', async () => {
    const run = vi.fn(async (mm: StrategyMemberView) => (mm.name === 'a' ? win('a', [1]) : win('b', [2])))
    const r = await sequentialStrategy.invoke(ctx({ members: [m('a'), m('b')], run }))
    expect(r).toMatchObject({ strategy: 'sequential', value: [1], via: 'a' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('全 miss：value null，misses/timings 逐成员', async () => {
    const run = vi.fn(async (mm: StrategyMemberView) => miss(mm.name))
    const r = await sequentialStrategy.invoke(ctx({ members: [m('a'), m('b')], run }))
    expect(r).toMatchObject({ value: null, via: null })
    expect((r as { misses: unknown[] }).misses).toHaveLength(2)
    expect((r as { timings: unknown[] }).timings).toHaveLength(2)
  })

  it('熔断跳过：冷却中的成员不执行，记"熔断冷却中" miss，顺序不重排', async () => {
    const run = vi.fn(async (mm: StrategyMemberView) => win(mm.name, [1]))
    const r = await sequentialStrategy.invoke(ctx({
      members: [m('dead'), m('live')],
      admit: (mm) => (mm.name === 'dead' ? { allow: false, retryInMs: 25_000 } : { allow: true }),
      run,
    }))
    expect(r).toMatchObject({ via: 'live' })
    expect(run).toHaveBeenCalledTimes(1)
    const misses = (r as { misses: Array<{ member: string; reason: string }> }).misses
    expect(misses).toEqual([{ member: 'dead', reason: expect.stringContaining('熔断冷却中') }])
  })

  it('不变量：全员冷却时强行试冷却剩余最短的那个——绝不空手而归', async () => {
    const run = vi.fn(async (mm: StrategyMemberView) => win(mm.name, ['probed']))
    const r = await sequentialStrategy.invoke(ctx({
      members: [m('a'), m('b'), m('c')],
      admit: (mm) => ({ allow: false, retryInMs: mm.name === 'b' ? 5_000 : 60_000 }),
      run,
    }))
    expect(run).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ via: 'b', value: ['probed'] })
  })

  it('无 collect 语义：首胜即停与"全收"自相矛盾', () => {
    expect(sequentialStrategy.collect).toBeUndefined()
  })
})
