import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeMemberPipeline, missOf, timingOf, type PipelineMember } from './member-pipeline.ts'
import { ContentUnavailableError } from './unavailable.ts'
import type { Outcome } from '../source-health-store.ts'

const noopStats = { record: vi.fn() }
const member = (attempt: () => Promise<unknown | null>, kind: 'source' | 'provider' = 'source'): PipelineMember =>
  ({ name: 'm1', sourceId: 's1', kind, attempt })
const mkDeps = (over: Partial<Parameters<typeof makeMemberPipeline>[0]> = {}) => ({
  stats: noopStats,
  declaredTimeoutMs: () => undefined,
  isCompositionError: (e: unknown) => e instanceof RangeError, // 测试用替身
  ...over,
})

describe('member pipeline', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('win：有值且过 accept', async () => {
    const run = makeMemberPipeline(mkDeps())
    const o = await run('p', member(async () => [{ a: 1 }]), () => true)
    expect(o.kind).toBe('win')
    expect(o.value).toEqual([{ a: 1 }])
  })

  it('miss：null 是 decline，有值但不过 accept 也是 miss', async () => {
    const run = makeMemberPipeline(mkDeps())
    expect((await run('p', member(async () => null), () => true)).kind).toBe('miss')
    expect((await run('p', member(async () => [{ a: 1 }]), () => false)).kind).toBe('miss')
  })

  it('error：普通抛错归 error，reason/stack 带出', async () => {
    const run = makeMemberPipeline(mkDeps())
    const o = await run('p', member(async () => { throw new Error('boom') }), () => true)
    expect(o.kind).toBe('error')
    expect(o.reason).toBe('boom')
    expect(o.stack).toBeTruthy()
  })

  it('timeout 单列：挂着不响的成员被掐掉，归 timeout 不混 error', async () => {
    const run = makeMemberPipeline(mkDeps({ defaultTimeoutMs: 1000 }))
    const p = run('p', member(() => new Promise(() => {})), () => true)
    await vi.advanceTimersByTimeAsync(1001)
    expect((await p).kind).toBe('timeout')
  })

  it('超时读数优先级：manifest 自报 > 默认值', async () => {
    const run = makeMemberPipeline(mkDeps({ defaultTimeoutMs: 1000, declaredTimeoutMs: () => 5000 }))
    let done = false
    const p = run('p', member(() => new Promise((r) => setTimeout(() => { done = true; r([1]) }, 3000))), () => true)
    await vi.advanceTimersByTimeAsync(3001)
    expect((await p).kind).toBe('win')
    expect(done).toBe(true)
  })

  it('opts.timeoutMs 覆盖一切（expand 单钻用）', async () => {
    const run = makeMemberPipeline(mkDeps({ declaredTimeoutMs: () => 60_000 }))
    const p = run('p', member(() => new Promise(() => {})), () => true, { timeoutMs: 500 })
    await vi.advanceTimersByTimeAsync(501)
    expect((await p).kind).toBe('timeout')
  })

  it('组合防护错误原样上抛，不进分类', async () => {
    const run = makeMemberPipeline(mkDeps())
    await expect(run('p', member(async () => { throw new RangeError('cycle') }), () => true)).rejects.toThrow('cycle')
  })

  it('记账：win→ok, miss→empty, error→error, timeout→error(category timeout)', async () => {
    const record = vi.fn()
    const run = makeMemberPipeline(mkDeps({ health: { record }, defaultTimeoutMs: 1000 }))
    await run('p', member(async () => [1]), () => true)
    expect(record).toHaveBeenLastCalledWith('s1', { kind: 'ok', itemCount: 1 })
    await run('p', member(async () => null), () => true)
    expect(record).toHaveBeenLastCalledWith('s1', { kind: 'empty' })
    await run('p', member(async () => { throw new Error('x') }), () => true)
    expect(record).toHaveBeenLastCalledWith('s1', expect.objectContaining({ kind: 'error', message: 'x' }))
    const p = run('p', member(() => new Promise(() => {})), () => true)
    await vi.advanceTimersByTimeAsync(1001)
    await p
    expect(record).toHaveBeenLastCalledWith('s1', expect.objectContaining({ kind: 'error', category: 'timeout' }))
  })

  it('数组 win 记真实条数（lifetimeItemCount 的输入，不能一律记 1）', async () => {
    const record = vi.fn()
    const run = makeMemberPipeline(mkDeps({ health: { record } }))
    await run('p', member(async () => [1, 2, 3]), () => true)
    expect(record).toHaveBeenLastCalledWith('s1', { kind: 'ok', itemCount: 3 })
    await run('p', member(async () => ({ url: 'x' })), () => true) // 单值成员没有条数概念
    expect(record).toHaveBeenLastCalledWith('s1', { kind: 'ok', itemCount: 1 })
  })

  it('可重试 / 缺前置条件的错误不记账，但结构化带出', async () => {
    const record = vi.fn()
    const run = makeMemberPipeline(mkDeps({ health: { record } }))
    const retryableErr = Object.assign(new Error('warming up'), { retryable: true })
    const o = await run('p', member(async () => { throw retryableErr }), () => true)
    expect(o.kind).toBe('error')
    expect(o.retryable).toBe(true)
    expect(record).not.toHaveBeenCalled()
  })

  it('「内容不可用」：结构化带出 unavailable，不记健康账（内容没了 ≠ 解析器坏了）', async () => {
    const record = vi.fn()
    const run = makeMemberPipeline(mkDeps({ health: { record } }))
    const o = await run('p', member(async () => { throw new ContentUnavailableError('作品已被删除') }), () => true)
    expect(o.kind).toBe('error')
    expect(o.unavailable).toBe(true)
    expect(o.reason).toBe('作品已被删除')
    expect(o.retryable).toBeUndefined()
    expect(o.blocked).toBeUndefined()
    expect(record).not.toHaveBeenCalled()
    expect(missOf(o)).toEqual({ member: 'm1', reason: '作品已被删除', stack: expect.any(String), unavailable: true })
  })

  it('普通错误的 miss 不带 unavailable 字段（缺席 = 不适用，不是 false）', async () => {
    const run = makeMemberPipeline(mkDeps())
    const o = await run('p', member(async () => { throw new Error('boom') }), () => true)
    expect('unavailable' in o).toBe(false)
    expect('unavailable' in missOf(o)).toBe(false)
  })

  it('provider 型成员：不记账（子行自己的叶子各自记）', async () => {
    const record = vi.fn()
    const run = makeMemberPipeline(mkDeps({ health: { record } }))
    await run('p', member(async () => [1], 'provider'), () => true)
    expect(record).not.toHaveBeenCalled()
  })

  it('记账失败不连累调用', async () => {
    const run = makeMemberPipeline(mkDeps({ health: { record: () => { throw new Error('disk full') } } }))
    expect((await run('p', member(async () => [1]), () => true)).kind).toBe('win')
  })

  it('派生：missOf / timingOf（timeout 映射成 error）', async () => {
    const run = makeMemberPipeline(mkDeps({ defaultTimeoutMs: 100 }))
    const p = run('p', member(() => new Promise(() => {})), () => true)
    await vi.advanceTimersByTimeAsync(101)
    const o = await p
    expect(timingOf(o)).toEqual({ member: 'm1', source: 's1', ms: expect.any(Number), outcome: 'error' })
    expect(missOf(o).reason).toContain('timed out')
  })
})
