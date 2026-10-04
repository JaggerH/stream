import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Scheduler, computeFirstFire, CATCHUP_MAX_JITTER_MS } from './scheduler.ts'
import { Registry } from './registry/registry.ts'
import { DedupStore } from './dedup-store.ts'
import type { Adapter } from './adapters/types.ts'
import type { SourceManifest } from './manifest/types.ts'
import type { Stream } from './streams/types.ts'

function mk(id: string): SourceManifest {
  return {
    schema_version: 1,
    id,
    adapter: 'fake',
    type: 'post',
    description: id,
    topics: [],
    example_queries: [],
    capabilities: ['timeline'],
    auth: { type: 'none' },
    params_schema: {},
    cadence_hint_seconds: 1800,
    discoverable: true,
  }
}

const fakeAdapter: Adapter = {
  id: 'fake',
  init: async () => {},
  fetch: async () => [],
}

/** Scheduler wired with two 60s-cadence streams (`overdue`/`fresh`, each one `src-a`
 *  member) plus injected clock/rng/persistence closures — the fixture Step 1 of the
 *  task-1.3 brief calls out (mirrors scheduler.test.ts's makeScheduler). */
function makeCatchupScheduler(args: { nowMs: number; last: Map<string, number>; saved: Array<[string, number]> }): Scheduler {
  const { nowMs, last, saved } = args
  const dir = mkdtempSync(join(tmpdir(), 'sched-catchup-'))
  const dedup = new DedupStore(join(dir, 'dedup.db'))
  const streams: Stream[] = [
    { id: 'overdue', description: 'overdue', sources: [{ source_id: 'src-a', params: {} }], cadence_seconds: 60, vault_subdir: 'overdue' },
    { id: 'fresh', description: 'fresh', sources: [{ source_id: 'src-a', params: {} }], cadence_seconds: 60, vault_subdir: 'fresh' },
  ]
  return new Scheduler({
    registry: new Registry([mk('src-a')]),
    streams,
    adapters: new Map([['fake', fakeAdapter]]),
    resolveCreds: async () => ({}),
    vaultRoot: join(dir, 'vault'),
    dedup,
    rng: () => 0,
    now: () => nowMs,
    loadLastHarvest: (id) => last.get(id),
    saveLastHarvest: (id, at) => saved.push([id, at]),
  })
}

describe('Scheduler startup catch-up', () => {
  it('start() catches up an overdue stream promptly and skips a non-overdue one', async () => {
    vi.useFakeTimers()
    const saved: Array<[string, number]> = []
    const nowMs = 1_000_000
    const last = new Map<string, number>([
      ['overdue', nowMs - 120_000], // > cadence 60s → overdue
      ['fresh', nowMs - 10_000],    // < cadence → not overdue
    ])
    const sched = makeCatchupScheduler({ nowMs, last, saved })
    const tickSpy = vi.spyOn(sched, 'tick')
    sched.start()
    await vi.advanceTimersByTimeAsync(CATCHUP_MAX_JITTER_MS + 100)
    const ticked = tickSpy.mock.calls.map((c) => c[0])
    expect(ticked).toContain('overdue')
    expect(ticked).not.toContain('fresh') // fresh waits ~30s+, not fired yet
    vi.useRealTimers()
  })

  it('advances persisted lastHarvestAt after a successful tick', async () => {
    const saved: Array<[string, number]> = []
    const sched = makeCatchupScheduler({ nowMs: 5_000, last: new Map(), saved })
    await sched.tick('overdue')
    expect(saved.some(([id]) => id === 'overdue')).toBe(true)
  })
})

describe('computeFirstFire', () => {
  const cadenceMs = 60_000
  it('overdue: harvests promptly with small jitter, not a full cadence wait', () => {
    const r = computeFirstFire({ nowMs: 200_000, lastHarvestMs: 100_000, cadenceMs, rng: () => 0.5 })
    expect(r.overdue).toBe(true)
    expect(r.delayMs).toBeLessThanOrEqual(CATCHUP_MAX_JITTER_MS)
  })
  it('not overdue: keeps [0.5,1) x cadence jittered first fire', () => {
    const r = computeFirstFire({ nowMs: 130_000, lastHarvestMs: 100_000, cadenceMs, rng: () => 0 })
    expect(r.overdue).toBe(false)
    expect(r.delayMs).toBe(30_000) // 0.5 x cadence at rng=0
  })
  it('missing lastHarvestAt is treated as not-overdue (no mass catch-up on upgrade)', () => {
    const r = computeFirstFire({ nowMs: 999_999_999, lastHarvestMs: undefined, cadenceMs, rng: () => 0 })
    expect(r.overdue).toBe(false)
    expect(r.delayMs).toBe(30_000)
  })
})
