import { describe, it, expect } from 'vitest'
import { planStreamMove } from './move-stream.ts'
import type { ChannelStream } from './types.ts'

const stream = (id: string, description: string, sources: Array<{ id: string; params: Record<string, unknown> }>) =>
  ({
    id,
    description,
    sources: sources.map((s) => ({ source: { id: s.id } as never, params: s.params })),
    cadence_seconds: 1800,
    vault_subdir: id,
  }) as unknown as ChannelStream

const lizhi = stream('lizhi-user-656044', '日谈物语', [{ id: 'lizhi-user', params: { id: '5085652731438656044' } }])

describe('planStreamMove', () => {
  it('目标频道里没有这条流、也没有同来源的 → 正常移动', () => {
    const plan = planStreamMove(lizhi, { label: '时间线' }, { label: '音乐/播客', streams: [] })
    expect(plan.kind).toBe('move')
  })

  // 流可以被多个频道共享，所以"目标里已经有它"是常态而不是异常。原来的实现照样跑完两步
  // patch：目标没变、源那边被摘掉——用户看不出变化，以为没移动，而数据已经变了。
  it('目标频道已经有这条流 → 说清这一下等于"从源频道移除"', () => {
    const plan = planStreamMove(lizhi, { label: '时间线' }, { label: '音乐/播客', streams: [lizhi] })
    expect(plan.kind).toBe('already-there')
    expect(plan.kind === 'already-there' && plan.message).toContain('日谈物语')
    expect(plan.kind === 'already-there' && plan.message).toContain('音乐/播客')
    expect(plan.kind === 'already-there' && plan.message).toContain('时间线') // 源频道那边发生了什么也要说
  })

  // 同一个 source + 同一份参数 = 同一个来源。移过去就是一个频道里两条一模一样的采集。
  it('目标频道有另一条流但来源完全相同 → 不移动，指名是哪条挡着', () => {
    const twin = stream('lizhi-user-x', '同一个播客的另一条', [
      { id: 'lizhi-user', params: { id: '5085652731438656044' } },
    ])
    const plan = planStreamMove(lizhi, { label: '时间线' }, { label: '音乐/播客', streams: [twin] })
    expect(plan.kind).toBe('duplicate-source')
    expect(plan.kind === 'duplicate-source' && plan.clashWith).toBe('lizhi-user-x')
    expect(plan.kind === 'duplicate-source' && plan.message).toContain('同一个播客的另一条')
  })

  // 参数不同就是不同的来源（不同的主播/歌单），不能拦——拦了用户就没法把两个节目放一起。
  it('同一个 source 但参数不同 → 照常移动', () => {
    const other = stream('lizhi-user-999', '别的播客', [{ id: 'lizhi-user', params: { id: '999' } }])
    const plan = planStreamMove(lizhi, { label: '时间线' }, { label: '音乐/播客', streams: [other] })
    expect(plan.kind).toBe('move')
  })

  // 多来源的流：只要有任意一个来源撞上就算重复（那条来源会被采两遍）。
  it('多来源流里只要有一个来源撞上就算重复', () => {
    const multi = stream('multi', '混合流', [
      { id: 'rsshub:foo/bar', params: { id: '1' } },
      { id: 'lizhi-user', params: { id: '5085652731438656044' } },
    ])
    const plan = planStreamMove(multi, { label: '时间线' }, { label: '音乐/播客', streams: [lizhi] })
    expect(plan.kind).toBe('duplicate-source')
  })
})
