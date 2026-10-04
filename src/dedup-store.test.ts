import { describe, it, expect } from 'vitest'
import { DedupStore } from './dedup-store.ts'

describe('DedupStore.addMany', () => {
  it('marks every id in one batch — has() and countForStream see them', () => {
    const d = new DedupStore(':memory:')
    expect(d.has('x')).toBe(false)
    d.addMany([{ id: 'x', streamId: 's' }, { id: 'y', streamId: 's' }])
    expect(d.has('x')).toBe(true)
    expect(d.has('y')).toBe(true)
    expect(d.countForStream('s')).toBe(2)
    d.close()
  })

  it('is a no-op for an empty batch', () => {
    const d = new DedupStore(':memory:')
    d.addMany([])
    expect(d.countForStream('s')).toBe(0)
    d.close()
  })

  it('ignores a duplicate id within the batch (INSERT OR IGNORE)', () => {
    const d = new DedupStore(':memory:')
    d.addMany([{ id: 'x', streamId: 's' }, { id: 'x', streamId: 's' }])
    expect(d.countForStream('s')).toBe(1)
    d.close()
  })
})

describe('DedupStore.countForStreams', () => {
  it('returns a count per stream_id, 0/absent for streams with no rows', () => {
    const d = new DedupStore(':memory:')
    d.addMany([
      { id: 'a1', streamId: 's1' },
      { id: 'a2', streamId: 's1' },
      { id: 'b1', streamId: 's2' },
    ])
    const counts = d.countForStreams(['s1', 's2', 's3'])
    expect(counts.get('s1')).toBe(2)
    expect(counts.get('s2')).toBe(1)
    expect(counts.get('s3') ?? 0).toBe(0)
    d.close()
  })

  it('matches countForStream called individually for the same data', () => {
    const d = new DedupStore(':memory:')
    d.addMany([
      { id: 'a1', streamId: 's1' },
      { id: 'a2', streamId: 's1' },
      { id: 'b1', streamId: 's2' },
      { id: 'c1', streamId: 's3' },
    ])
    const ids = ['s1', 's2', 's3', 's4']
    const batch = d.countForStreams(ids)
    for (const id of ids) {
      expect(batch.get(id) ?? 0).toBe(d.countForStream(id))
    }
    d.close()
  })

  it('is empty for an empty stream id list', () => {
    const d = new DedupStore(':memory:')
    expect(d.countForStreams([]).size).toBe(0)
    d.close()
  })
})
