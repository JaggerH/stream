import { describe, expect, it } from 'vitest'
import { makeSearchSnapshot, SEARCH_SNAPSHOT_CAP, SEARCH_SNAPSHOT_TTL_MS } from './search-snapshot.ts'
import type { StoredItem } from '../item-store.ts'

const item = (id: string): StoredItem => ({ id, stream_id: 's', title: id, fetched_at: 'x' }) as StoredItem

describe('search snapshot', () => {
  it('命中返回原件,TTL 过期返回 undefined 并清掉', () => {
    let t = 0
    const s = makeSearchSnapshot(() => t)
    s.put([item('a')])
    expect(s.get('a')?.id).toBe('a')
    t = SEARCH_SNAPSHOT_TTL_MS + 1
    expect(s.get('a')).toBeUndefined()
    expect(s.size()).toBe(0)
  })

  it('超容量逐出最老的;重复 put 刷新到队尾', () => {
    const s = makeSearchSnapshot(() => 0)
    for (let i = 0; i < SEARCH_SNAPSHOT_CAP; i++) s.put([item(`i${i}`)])
    s.put([item('i0')]) // 刷新 i0——它不该是下一个被逐出的
    s.put([item('overflow')])
    expect(s.size()).toBe(SEARCH_SNAPSHOT_CAP)
    expect(s.get('i0')?.id).toBe('i0')
    expect(s.get('i1')).toBeUndefined() // 被逐出的是 i1
  })

  it('无 id 的条目不进快照', () => {
    const s = makeSearchSnapshot(() => 0)
    s.put([{ id: '', stream_id: 's', title: 't', fetched_at: 'x' } as StoredItem])
    expect(s.size()).toBe(0)
  })
})
