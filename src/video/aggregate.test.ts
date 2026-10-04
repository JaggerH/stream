import { describe, it, expect } from 'vitest'
import { aggregate, computeCoverage, seasonTotal, type GroupedRelease } from './aggregate.ts'
import type { Coverage, Quality, Release } from './types.ts'

const rel = (quality: Quality, coverage: Coverage, extra: Partial<Release> = {}): Release => ({
  source: 'btbtla',
  title: 't',
  quality,
  sourceType: 'magnet',
  coverage,
  link: 'magnet:x',
  parsed: true,
  ...extra,
})

describe('computeCoverage', () => {
  it('full pack covers all → no gaps', () => {
    const c = computeCoverage([rel('2160p', { kind: 'pack', from: 1, to: 8, total: 8 })], 8)
    expect(c).toEqual({ total: 8, episodes: [1, 2, 3, 4, 5, 6, 7, 8], missing: [], hasPack: true })
  })
  it('singles short of season total → gaps reported', () => {
    const rels = [rel('2160p', { kind: 'single', episode: 1 }), rel('2160p', { kind: 'range', from: 2, to: 4 })]
    const c = computeCoverage(rels, 8) // season total known from another quality's pack
    expect(c.episodes).toEqual([1, 2, 3, 4])
    expect(c.missing).toEqual([5, 6, 7, 8])
    expect(c.hasPack).toBe(false)
  })
  it('total unknown → no missing claimed', () => {
    const c = computeCoverage([rel('720p', { kind: 'single', episode: 1 })], null)
    expect(c.missing).toEqual([])
    expect(c.total).toBeNull()
  })
})

describe('seasonTotal', () => {
  it('takes the largest 全N集 pack total across qualities', () => {
    expect(
      seasonTotal([
        rel('1080p', { kind: 'pack', from: 1, to: 8, total: 8 }),
        rel('2160p', { kind: 'single', episode: 1 }),
      ])
    ).toBe(8)
  })
})

describe('aggregate — per (source, show, season), season-level denominator', () => {
  it('1080p pack fixes total; 2160p singles show the gap', () => {
    const grouped: GroupedRelease[] = [
      { show: '上载新生', season: 3, release: rel('1080p', { kind: 'pack', from: 1, to: 8, total: 8 }) },
      { show: '上载新生', season: 3, release: rel('2160p', { kind: 'single', episode: 1 }) },
      { show: '上载新生', season: 3, release: rel('2160p', { kind: 'single', episode: 2 }) },
    ]
    const { shows, loose } = aggregate(grouped)
    expect(loose).toHaveLength(0)
    expect(shows).toHaveLength(1)
    const ss = shows[0]
    expect(ss.title).toBe('上载新生 第三季')
    expect(ss.total).toBe(8)
    const q2160 = ss.qualities.find((q) => q.quality === '2160p')!
    expect(q2160.coverage.episodes).toEqual([1, 2])
    expect(q2160.coverage.missing).toEqual([3, 4, 5, 6, 7, 8]) // gap vs season total 8
    const q1080 = ss.qualities.find((q) => q.quality === '1080p')!
    expect(q1080.coverage.missing).toEqual([]) // pack covers all
    // 2160p sorts before 1080p
    expect(ss.qualities.map((q) => q.quality)).toEqual(['2160p', '1080p'])
  })

  it('show=null releases go to loose', () => {
    const grouped: GroupedRelease[] = [{ show: null, season: null, release: rel('1080p', { kind: 'unknown' }) }]
    const { shows, loose } = aggregate(grouped)
    expect(shows).toHaveLength(0)
    expect(loose).toHaveLength(1)
  })
})
