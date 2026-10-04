import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Scheduler } from './scheduler.ts'
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

/** Fake adapter that records the effective params of every fetch. */
function makeFake(behavior: Record<string, (params: Record<string, unknown>) => unknown[]>, calls: Array<{ id: string; params: Record<string, unknown> }>): Adapter {
  return {
    id: 'fake',
    init: async () => {},
    fetch: async (params, manifest) => {
      calls.push({ id: manifest.id, params: { ...params } })
      const b = behavior[manifest.id]
      if (!b) return []
      return b(params)
    },
  }
}

const HARVEST = { backfillLimit: 1000, incrementalLimit: 50 }

function stream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: 'pod',
    description: 'harvest policy stream',
    sources: [{ source_id: 'src-a', params: { id: '251381' } }],
    cadence_seconds: 3600,
    vault_subdir: 'pod',
    strategy: 'exclusive',
    harvest: HARVEST,
    ...overrides,
  }
}

describe('Scheduler harvest policy (backfill/incremental limit injection)', () => {
  let dir: string
  let dedup: DedupStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sched-hp-'))
    dedup = new DedupStore(join(dir, 'dedup.db'))
  })
  afterEach(() => {
    dedup.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeScheduler(s: Stream, adapter: Adapter) {
    return new Scheduler({
      registry: new Registry([mk('src-a')]),
      streams: [s],
      adapters: new Map([['fake', adapter]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
    })
  }

  it('first harvest backfills the archive (limit = backfillLimit)', async () => {
    const calls: Array<{ id: string; params: Record<string, unknown> }> = []
    const sched = makeScheduler(stream(), makeFake({ 'src-a': () => [{ guid: 'a1' }] }, calls))
    await sched.tick('pod')
    expect(calls[0].params.limit).toBe(1000)
    expect(calls[0].params.id).toBe('251381') // member bindings survive injection
  })

  it('subsequent harvests are incremental (limit = incrementalLimit)', async () => {
    const calls: Array<{ id: string; params: Record<string, unknown> }> = []
    let n = 0
    const sched = makeScheduler(stream(), makeFake({ 'src-a': () => [{ guid: `a${++n}` }] }, calls))
    await sched.tick('pod') // backfill persists a1
    await sched.tick('pod')
    expect(calls[1].params.limit).toBe(50)
  })

  it('an explicit member binding wins over the policy', async () => {
    const calls: Array<{ id: string; params: Record<string, unknown> }> = []
    const s = stream({ sources: [{ source_id: 'src-a', params: { id: '251381', limit: 200 } }] })
    const sched = makeScheduler(s, makeFake({ 'src-a': () => [{ guid: 'a1' }] }, calls))
    await sched.tick('pod')
    expect(calls[0].params.limit).toBe(200)
  })

  it('streams without options.harvest are untouched', async () => {
    const calls: Array<{ id: string; params: Record<string, unknown> }> = []
    const s = stream({ harvest: undefined, strategy: 'fanout' })
    const sched = makeScheduler(s, makeFake({ 'src-a': () => [{ guid: 'a1' }] }, calls))
    await sched.tick('pod')
    expect(calls[0].params).toEqual({ id: '251381' }) // exactly the member's own params
  })

  it('a failed first harvest retries the backfill next tick', async () => {
    const calls: Array<{ id: string; params: Record<string, unknown> }> = []
    let fail = true
    const sched = makeScheduler(
      stream({ strategy: 'fanout' }),
      makeFake(
        {
          'src-a': () => {
            if (fail) throw new Error('boom')
            return [{ guid: 'a1' }]
          },
        },
        calls
      )
    )
    await expect(sched.tick('pod')).rejects.toThrow('boom')
    fail = false
    await sched.tick('pod') // nothing was persisted → still the never-harvested state
    expect(calls[1].params.limit).toBe(1000)
  })
})
