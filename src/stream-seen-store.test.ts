import { describe, it, expect } from 'vitest'
import { StreamSeenStore } from './stream-seen-store.ts'

describe('StreamSeenStore', () => {
  it('returns undefined for an unseen stream', () => {
    const s = new StreamSeenStore(':memory:')
    expect(s.seenSeq('x')).toBeUndefined()
  })

  it('records then reads a watermark', () => {
    const s = new StreamSeenStore(':memory:')
    s.markSeen('x', 5)
    expect(s.seenSeq('x')).toBe(5)
  })

  it('advances but never retreats', () => {
    const s = new StreamSeenStore(':memory:')
    s.markSeen('x', 5)
    s.markSeen('x', 3) // lower — ignored
    expect(s.seenSeq('x')).toBe(5)
    s.markSeen('x', 9) // higher — advances
    expect(s.seenSeq('x')).toBe(9)
  })

  it('keeps streams independent', () => {
    const s = new StreamSeenStore(':memory:')
    s.markSeen('a', 4)
    expect(s.seenSeq('b')).toBeUndefined()
  })
})
