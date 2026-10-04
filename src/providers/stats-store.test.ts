import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderStatsStore } from './stats-store.ts'

describe('ProviderStatsStore', () => {
  it('implements stats recording and recovery behavior', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stats-store-'))
    const dbPath = join(dir, 'cache.db')

    let mockTime = '2026-07-02T22:30:00.000Z'
    const now = () => mockTime

    const store = new ProviderStatsStore(dbPath, now)

    // (b) unknown provider -> zero shape
    expect(store.of('nonexistent')).toEqual({
      total: 0,
      byMember: {},
      lastCalledAt: null,
    })

    // (a) record x3 across two members
    mockTime = '2026-07-02T22:31:00.000Z'
    store.record('prov-1', 'memb-a')

    mockTime = '2026-07-02T22:32:00.000Z'
    store.record('prov-1', 'memb-b')

    mockTime = '2026-07-02T22:33:00.000Z'
    store.record('prov-1', 'memb-a')

    const stats1 = store.of('prov-1')
    expect(stats1.total).toBe(3)
    expect(stats1.byMember).toEqual({
      'memb-a': 2,
      'memb-b': 1,
    })
    expect(stats1.lastCalledAt).toBe('2026-07-02T22:33:00.000Z')

    // (c) all() returns both providers when two recorded
    mockTime = '2026-07-02T22:34:00.000Z'
    store.record('prov-2', 'memb-x')

    const allStats = store.all()
    expect(allStats['prov-1']).toEqual({
      total: 3,
      byMember: { 'memb-a': 2, 'memb-b': 1 },
      lastCalledAt: '2026-07-02T22:33:00.000Z',
    })
    expect(allStats['prov-2']).toEqual({
      total: 1,
      byMember: { 'memb-x': 1 },
      lastCalledAt: '2026-07-02T22:34:00.000Z',
    })

    // (d) close() then new instance on same path still reads counts.
    store.close()

    const store2 = new ProviderStatsStore(dbPath, now)
    const statsRecovered = store2.of('prov-1')
    expect(statsRecovered.total).toBe(3)
    expect(statsRecovered.byMember).toEqual({
      'memb-a': 2,
      'memb-b': 1,
    })
    expect(statsRecovered.lastCalledAt).toBe('2026-07-02T22:33:00.000Z')

    store2.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
