import { describe, it, expect, vi } from 'vitest'
import { makeDrain } from './drain.ts'
import type { EventFrame } from './protocol.ts'

const ev = (id: string): EventFrame => ({ t: 'event', id, source: 'x', receivedAt: 1, payload: '{}' })

describe('makeDrain', () => {
  it('触发任务成功 → 回 ack 该 id', async () => {
    const sent: string[] = []
    const runTaskNow = vi.fn().mockResolvedValue(true)
    const drain = makeDrain({ mapToTask: () => 'deliver', runTaskNow })
    await drain(ev('o1'), { send: (r) => sent.push(r) })
    expect(runTaskNow).toHaveBeenCalledWith('deliver')
    expect(JSON.parse(sent[0])).toEqual({ t: 'ack', ids: ['o1'] })
  })
  it('映射不到任务 → 仍 ack（别让子进程永远重推）', async () => {
    const sent: string[] = []
    const drain = makeDrain({ mapToTask: () => null, runTaskNow: vi.fn() })
    await drain(ev('o2'), { send: (r) => sent.push(r) })
    expect(JSON.parse(sent[0])).toEqual({ t: 'ack', ids: ['o2'] })
  })
  it('触发失败（runTaskNow=false）→ 不 ack（让子进程重推）', async () => {
    const sent: string[] = []
    const drain = makeDrain({ mapToTask: () => 'deliver', runTaskNow: vi.fn().mockResolvedValue(false) })
    await drain(ev('o3'), { send: (r) => sent.push(r) })
    expect(sent.length).toBe(0)
  })
})
