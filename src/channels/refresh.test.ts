import { describe, expect, it, vi } from 'vitest'
import { refreshStreams } from './refresh.ts'

const ok = (fetched: number, written: number) => async () => ({ fetched, written })

describe('refreshStreams (频道级重新抓取的扇出)', () => {
  it('refreshes every member stream and totals the counts', async () => {
    const refresh = vi.fn(async (id: string) => ({ fetched: id === 'a' ? 3 : 5, written: id === 'a' ? 1 : 2 }))
    const r = await refreshStreams(['a', 'b'], refresh)
    expect(refresh.mock.calls.map((c) => c[0])).toEqual(['a', 'b'])
    expect(r.fetched).toBe(8)
    expect(r.written).toBe(3)
    expect(r.failed).toBe(0)
    expect(r.streams).toEqual([
      { streamId: 'a', fetched: 3, written: 1 },
      { streamId: 'b', fetched: 5, written: 2 },
    ])
  })

  it('一个流失败不拖垮其余——部分失败是常态,不是整体失败', async () => {
    const refresh = vi.fn(async (id: string) => {
      if (id === 'b') throw new Error('facility 未登录')
      return { fetched: 2, written: 1 }
    })
    const r = await refreshStreams(['a', 'b', 'c'], refresh)
    expect(r.failed).toBe(1)
    expect(r.fetched).toBe(4) // 成功的两条照常计入
    expect(r.written).toBe(2)
    expect(r.streams.find((s) => s.streamId === 'b')).toEqual({ streamId: 'b', error: 'facility 未登录' })
    expect(r.streams.filter((s) => s.error === undefined)).toHaveLength(2)
  })

  it('全部失败也如实汇总,不抛', async () => {
    const r = await refreshStreams(['a', 'b'], async () => { throw new Error('boom') })
    expect(r.failed).toBe(2)
    expect(r.fetched).toBe(0)
    expect(r.streams.every((s) => s.error === 'boom')).toBe(true)
  })

  it('保持成员顺序,与并发完成先后无关（结果要能对着频道列表读）', async () => {
    const delays: Record<string, number> = { a: 30, b: 0, c: 15 }
    const refresh = async (id: string) => {
      await new Promise((r) => setTimeout(r, delays[id]))
      return { fetched: 1, written: 0 }
    }
    const r = await refreshStreams(['a', 'b', 'c'], refresh, { concurrency: 3 })
    expect(r.streams.map((s) => s.streamId)).toEqual(['a', 'b', 'c'])
  })

  it('并发有上限——采集是重活,7 个流一起冲会把浏览器和内存打穿', async () => {
    let inflight = 0
    let peak = 0
    const refresh = async () => {
      inflight += 1
      peak = Math.max(peak, inflight)
      await new Promise((r) => setTimeout(r, 5))
      inflight -= 1
      return { fetched: 1, written: 1 }
    }
    await refreshStreams(['a', 'b', 'c', 'd', 'e', 'f', 'g'], refresh, { concurrency: 2 })
    expect(peak).toBe(2)
  })

  it('默认并发是保守的（不是无上限）', async () => {
    let inflight = 0
    let peak = 0
    const refresh = async () => {
      inflight += 1
      peak = Math.max(peak, inflight)
      await new Promise((r) => setTimeout(r, 5))
      inflight -= 1
      return { fetched: 0, written: 0 }
    }
    await refreshStreams(['a', 'b', 'c', 'd', 'e', 'f', 'g'], refresh)
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('空成员列表 = 空结果,不调用任何刷新', async () => {
    const refresh = vi.fn(ok(1, 1))
    const r = await refreshStreams([], refresh)
    expect(refresh).not.toHaveBeenCalled()
    expect(r).toEqual({ streams: [], fetched: 0, written: 0, failed: 0 })
  })

  it('去重成员 id——同一个流出现两次不该抓两遍', async () => {
    const refresh = vi.fn(ok(1, 1))
    const r = await refreshStreams(['a', 'b', 'a'], refresh)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(r.streams.map((s) => s.streamId)).toEqual(['a', 'b'])
  })
})
