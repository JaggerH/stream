import { describe, it, expect } from 'vitest'
import { computeTier } from './quality.ts'

describe('computeTier', () => {
  it('returns 0 for unknown', () => {
    expect(computeTier({})).toBe(0)
    expect(computeTier({ format: 'mp3' })).toBe(0)
  })
  it('grades lossy mp3 by bitrate', () => {
    expect(computeTier({ format: 'mp3', bitrate: 128 })).toBe(1)
    expect(computeTier({ format: 'mp3', bitrate: 192 })).toBe(2)
    expect(computeTier({ format: 'mp3', bitrate: 256 })).toBe(2)
    expect(computeTier({ format: 'mp3', bitrate: 320 })).toBe(3)
  })
  it('treats AAC/m4a 256 as tier 3', () => {
    expect(computeTier({ format: 'm4a', bitrate: 256 })).toBe(3)
    expect(computeTier({ format: 'aac', bitrate: 256 })).toBe(3)
  })
  it('grades lossless as 4, hi-res as 5', () => {
    expect(computeTier({ format: 'flac', bitrate: 900, sampleRate: 44100, bitDepth: 16 })).toBe(4)
    expect(computeTier({ format: 'flac', sampleRate: 48000, bitDepth: 16 })).toBe(4)
    expect(computeTier({ format: 'flac', sampleRate: 96000, bitDepth: 24 })).toBe(5)
    expect(computeTier({ format: 'alac', sampleRate: 96000, bitDepth: 24 })).toBe(5)
  })
})
