import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Scheduler } from './scheduler.ts'
import { Registry } from './registry/registry.ts'
import { DedupStore } from './dedup-store.ts'
import { ItemStore } from './item-store.ts'
import type { Adapter } from './adapters/types.ts'
import type { SourceManifest } from './manifest/types.ts'
import type { Stream } from './streams/types.ts'

function mkAudio(id: string): SourceManifest {
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

// fake adapter returns two audio items for src-audio
const fakeAudioAdapter: Adapter = {
  id: 'fake',
  init: async () => {},
  fetch: async (_params, manifest) => {
    if (manifest.id === 'src-audio')
      return [
        { guid: 'track-1', title: 'Track One' },
        { guid: 'track-2', title: 'Track Two' },
      ]
    return []
  },
}

// adapter that honors the injected `limit` — returns exactly `limit` distinct items, so a test
// can observe which harvest depth the scheduler bound for the tick.
const limitEchoAdapter: Adapter = {
  id: 'fake',
  init: async () => {},
  fetch: async (params: Record<string, unknown>, manifest) => {
    if (manifest.id !== 'src-audio') return []
    const n = Number(params.limit ?? 0)
    return Array.from({ length: n }, (_, i) => ({ guid: `track-${i}`, title: `Track ${i}` }))
  },
}

const audioStream: Stream = {
  id: 'playlist-1',
  description: 'test audio playlist',
  mode: 'collection',
  sources: [{ source_id: 'src-audio', params: {} }],
  cadence_seconds: 1800,
  vault_subdir: 'audio',
}

describe('Scheduler.onAudioHarvest', () => {
  let dir: string
  let dedup: DedupStore
  let store: ItemStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sched-audio-'))
    dedup = new DedupStore(join(dir, 'dedup.db'))
    store = new ItemStore(join(dir, 'items.db'))
  })

  afterEach(() => {
    store.close()
    dedup.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('fires onAudioHarvest after an audio stream tick with the right id and items', async () => {
    const calls: Array<{ id: string; n: number }> = []

    const sched = new Scheduler({
      registry: new Registry([mkAudio('src-audio')]),
      streams: [audioStream],
      adapters: new Map([['fake', fakeAudioAdapter]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
      itemStore: store,
      onAudioHarvest: (id, items) => calls.push({ id, n: items.length }),
    })

    await sched.tick('playlist-1')

    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe('playlist-1')
    expect(calls[0].n).toBe(store.recent({ stream: 'playlist-1' }).length)
    expect(calls[0].n).toBeGreaterThan(0)
  })

  it('a snapshot stream always fetches backfill depth — a later tick does not shrink it', async () => {
    // A snapshot stream's persist path (replaceStream) is not evict-gated, so harvesting the
    // smaller incremental window on a subsequent tick would shrink the store. The scheduler must
    // keep fetching backfill depth for snapshot streams regardless of how many items already exist.
    const snapshotStream: Stream = {
      id: 'playlist-1',
      description: 'snapshot catalog',
      mode: 'collection',
      sources: [{ source_id: 'src-audio', params: {} }],
      cadence_seconds: 1800,
      vault_subdir: 'audio',
      harvest: { backfillLimit: 5, incrementalLimit: 1 },
    }
    const sched = new Scheduler({
      registry: new Registry([mkAudio('src-audio')]),
      streams: [snapshotStream],
      adapters: new Map([['fake', limitEchoAdapter]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
      itemStore: store,
    })

    await sched.tick('playlist-1')
    expect(store.recent({ stream: 'playlist-1' }).length).toBe(5) // backfill depth

    // Second tick: itemCount is now > 0. A non-snapshot stream would drop to incrementalLimit (1)
    // and replaceStream would shrink the store to 1. Snapshot must stay at backfill depth.
    await sched.tick('playlist-1')
    expect(store.recent({ stream: 'playlist-1' }).length).toBe(5)
  })
})
