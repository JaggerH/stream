import { describe, it, expect } from 'vitest'
import { cosineSimilarity } from './cosine.ts'

describe('cosineSimilarity', () => {
  it('identical vectors → 1', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6)
  })
  it('orthogonal → 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6)
  })
  it('opposite → -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6)
  })
  it('scale-invariant', () => {
    expect(cosineSimilarity([2, 0], [5, 0])).toBeCloseTo(1, 6)
  })
  it('throws on dimension mismatch', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow()
  })
  it('zero vector → 0 (no NaN)', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})
