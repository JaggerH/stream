import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Scheduler } from './scheduler.ts'
import { Registry } from './registry/registry.ts'
import { DedupStore } from './dedup-store.ts'
import { SourceHealthStore } from './source-health-store.ts'
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

/** Fake adapter whose per-source behavior is set per test. Records which ids were fetched. */
function makeFake(behavior: Record<string, () => unknown[]>, fetched: string[]): Adapter {
  return {
    id: 'fake',
    init: async () => {},
    fetch: async (_params, manifest) => {
      fetched.push(manifest.id)
      const b = behavior[manifest.id]
      if (!b) return []
      return b()
    },
  }
}

const failoverStream: Stream = {
  id: 'feed',
  description: 'failover',
  sources: [
    { source_id: 'src-a', params: {} },
    { source_id: 'src-b', params: {} },
  ],
  cadence_seconds: 1800,
  vault_subdir: 'feed',
  strategy: 'exclusive',
}

describe('Scheduler failover', () => {
  let dir: string
  let dedup: DedupStore
  let health: SourceHealthStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sched-fo-'))
    dedup = new DedupStore(join(dir, 'dedup.db'))
    health = new SourceHealthStore(join(dir, 'health.json'), { errK: 2 })
  })
  afterEach(() => {
    dedup.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeScheduler(adapter: Adapter, opts?: { reprobeCadence?: number; saveLastHarvest?: (id: string, at: number) => void }) {
    return new Scheduler({
      registry: new Registry([mk('src-a'), mk('src-b')]),
      streams: [failoverStream],
      adapters: new Map([['fake', adapter]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
      health,
      reprobeCadence: opts?.reprobeCadence ?? 6,
      saveLastHarvest: opts?.saveLastHarvest,
    })
  }

  it('fetches only the first healthy source', async () => {
    const fetched: string[] = []
    const sched = makeScheduler(makeFake({ 'src-a': () => [{ guid: 'a1' }], 'src-b': () => [{ guid: 'b1' }] }, fetched))
    await sched.tick('feed')
    expect(fetched).toEqual(['src-a']) // src-b never touched
  })

  it('falls to the next source when the primary is dead', async () => {
    // pre-mark src-a dead
    health.record('src-a', { kind: 'error', message: 'x' })
    health.record('src-a', { kind: 'error', message: 'x' })
    expect(health.stateOf('src-a')).toBe('dead')
    const fetched: string[] = []
    const sched = makeScheduler(makeFake({ 'src-a': () => [{ guid: 'a1' }], 'src-b': () => [{ guid: 'b1' }] }, fetched))
    await sched.tick('feed')
    expect(fetched).toEqual(['src-b'])
  })

  it('records a hard error and falls through within the same tick', async () => {
    const fetched: string[] = []
    const adapter = makeFake(
      {
        'src-a': () => {
          throw new Error('boom')
        },
        'src-b': () => [{ guid: 'b1' }],
      },
      fetched
    )
    const sched = makeScheduler(adapter)
    const res = await sched.tick('feed')
    expect(fetched).toEqual(['src-a', 'src-b']) // tried a, fell to b
    expect(health.get('src-a')?.lastOutcome).toBe('error')
    expect(res.written).toBe(1) // got b's item
  })

  it('re-probes and promotes a recovered primary', async () => {
    health.record('src-a', { kind: 'error', message: 'x' })
    health.record('src-a', { kind: 'error', message: 'x' }) // dead
    const fetched: string[] = []
    // src-a now behaves healthy again
    const sched = makeScheduler(
      makeFake({ 'src-a': () => [{ guid: 'a1' }], 'src-b': () => [{ guid: 'b1' }] }, fetched),
      { reprobeCadence: 1 }
    )
    await sched.tick('feed') // reprobe fires (cadence 1): re-attempts src-a, promotes it
    expect(health.stateOf('src-a')).toBe('healthy')
    expect(fetched).toContain('src-a')
  })

  it('throws when every rung fails, without advancing lastHarvestAt (catch-up stays sensitive)', async () => {
    const fetched: string[] = []
    const saved: string[] = []
    const adapter = makeFake(
      {
        'src-a': () => {
          throw new Error('a down')
        },
        'src-b': () => {
          throw new Error('b down')
        },
      },
      fetched
    )
    const sched = makeScheduler(adapter, { saveLastHarvest: (id) => saved.push(id) })
    await expect(sched.tick('feed')).rejects.toThrow('b down') // last rung's error surfaces
    expect(fetched).toEqual(['src-a', 'src-b']) // every rung was attempted
    expect(saved).toEqual([]) // lastHarvestAt NOT advanced — restart catch-up must still see it overdue
    expect(sched.lastTickAt('feed')).toBeDefined() // but "just tried" stays visible to backoff/UI
  })

  it('a succeeding rung after a failed one still advances lastHarvestAt', async () => {
    const saved: string[] = []
    const adapter = makeFake(
      {
        'src-a': () => {
          throw new Error('a down')
        },
        'src-b': () => [{ guid: 'b1' }],
      },
      []
    )
    const sched = makeScheduler(adapter, { saveLastHarvest: (id) => saved.push(id) })
    const res = await sched.tick('feed')
    expect(res.written).toBe(1)
    expect(saved).toEqual(['feed'])
  })

  it('fanout strategy still fans out (regression)', async () => {
    const fetched: string[] = []
    const fanoutStream: Stream = { ...failoverStream, id: 'm', strategy: 'fanout', vault_subdir: 'm' }
    const sched = new Scheduler({
      registry: new Registry([mk('src-a'), mk('src-b')]),
      streams: [fanoutStream],
      adapters: new Map([['fake', makeFake({ 'src-a': () => [{ guid: 'a1' }], 'src-b': () => [{ guid: 'b1' }] }, fetched)]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
      health,
    })
    await sched.tick('m')
    expect(fetched.sort()).toEqual(['src-a', 'src-b'])
  })
})
