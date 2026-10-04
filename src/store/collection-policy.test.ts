import { describe, it, expect } from 'vitest'
import { applyCollectionPolicy } from './collection-policy.ts'
import type { StreamRecord } from './types.ts'
import type { Stream } from '../streams/types.ts'

const rec = (id: string): StreamRecord => ({
  id, label: id, strategy: 'fanout', cadence_seconds: 60,
  members: [{ plugin: 'fake', source: 'hn', params: {} }], options: {},
})

/** 一个假调度面：只记「谁在表里」和每个动作被调用的次数。 */
function fakeService(initial: string[] = []) {
  const scheduled = new Set(initial)
  const calls: string[] = []
  return {
    scheduled,
    calls,
    streamsResource: (): Stream[] => [...scheduled].map((id) => ({ id, sources: [], cadence_seconds: 60 } as unknown as Stream)),
    scheduleResourceStream: (s: Stream) => { calls.push(`schedule:${s.id}`); scheduled.add(s.id) },
    rescheduleResourceStream: (s: Stream) => { calls.push(`reschedule:${s.id}`); scheduled.add(s.id) },
    unscheduleResourceStream: (id: string) => { calls.push(`unschedule:${id}`); scheduled.delete(id) },
  }
}

function fakeStore(collected: Set<string>, known: string[]) {
  const rows = new Map(known.map((id) => [id, rec(id)]))
  return {
    isCollected: (id: string) => collected.has(id),
    getStream: (id: string) => rows.get(id) ?? null,
  }
}

describe('applyCollectionPolicy — 采集判据的唯一施加点', () => {
  it('该采、还没排班 → 排班', () => {
    const svc = fakeService()
    applyCollectionPolicy(fakeStore(new Set(['a']), ['a']), svc, ['a'])
    expect(svc.calls).toEqual(['schedule:a'])
  })

  it('该采、已经在表里 → 什么都不做（别把改个频道名变成一次全量重抓）', () => {
    const svc = fakeService(['a'])
    applyCollectionPolicy(fakeStore(new Set(['a']), ['a']), svc, ['a'])
    expect(svc.calls).toEqual([])
  })

  it('不该采、在表里 → 撤出调度', () => {
    const svc = fakeService(['a'])
    applyCollectionPolicy(fakeStore(new Set(), ['a']), svc, ['a'])
    expect(svc.calls).toEqual(['unschedule:a'])
  })

  it('不该采、本来就不在表里 → 什么都不做', () => {
    const svc = fakeService()
    applyCollectionPolicy(fakeStore(new Set(), ['a']), svc, ['a'])
    expect(svc.calls).toEqual([])
  })

  // reschedule 档：成员表/cadence 变了的写入路径要 remove+add 让调度器认新的那份。
  it('reschedule 档：该采且在表里 → 重排班', () => {
    const svc = fakeService(['a'])
    applyCollectionPolicy(fakeStore(new Set(['a']), ['a']), svc, ['a'], { reschedule: true })
    expect(svc.calls).toEqual(['reschedule:a'])
  })

  // 这一条是本次补上的缺口：openReconcile 给一条 research 流补了下架来源之后，
  // 无条件重排班等于把一条「现读不落库」的流放回采集队列，且一直采到重启。
  it('reschedule 档：不该采的流不会被重排班回来，而是被撤出', () => {
    const svc = fakeService(['a'])
    applyCollectionPolicy(fakeStore(new Set(), ['a']), svc, ['a'], { reschedule: true })
    expect(svc.calls).toEqual(['unschedule:a'])
    expect(svc.scheduled.has('a')).toBe(false)
  })

  it('库里没有这条流 → 不排班（判据说该采也一样，没有记录就没得排）', () => {
    const svc = fakeService()
    applyCollectionPolicy(fakeStore(new Set(['ghost']), []), svc, ['ghost'])
    expect(svc.calls).toEqual([])
  })

  it('store 缺席（没配频道库）→ 整体空操作', () => {
    const svc = fakeService()
    applyCollectionPolicy(undefined, svc, ['a'])
    expect(svc.calls).toEqual([])
  })

  it('同一个 id 重复出现只处理一次', () => {
    const svc = fakeService()
    applyCollectionPolicy(fakeStore(new Set(['a']), ['a']), svc, ['a', 'a', 'a'])
    expect(svc.calls).toEqual(['schedule:a'])
  })
})
