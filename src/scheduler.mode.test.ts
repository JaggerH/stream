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

// A plain feed-mode source manifest (no mode:'collection') — so a stream using it defaults to
// 'feed' unless another rule (stored mode, audio membership) lifts it to 'collection'.
function mkFeed(id: string): SourceManifest {
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

const noopAdapter: Adapter = { id: 'fake', init: async () => {}, fetch: async () => [] }

// A stream with NO explicit `mode` — the case a freshly-subscribed 歌单 hits before any restart
// has written mode back.
const unmodedStream: Stream = {
  id: 'playlist-1',
  description: 'audio playlist',
  sources: [{ source_id: 'src-feed', params: {} }],
  cadence_seconds: 1800,
  vault_subdir: 'audio',
}

describe('Scheduler.modeOf audio-membership rule', () => {
  let dir: string
  let dedup: DedupStore
  const mk = (isAudioStream?: (id: string) => boolean) =>
    new Scheduler({
      registry: new Registry([mkFeed('src-feed')]),
      streams: [unmodedStream],
      adapters: new Map([['fake', noopAdapter]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
      isAudioStream,
    })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sched-mode-'))
    dedup = new DedupStore(join(dir, 'dedup.db'))
  })
  afterEach(() => {
    dedup.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('an unmoded stream in an audio Channel resolves to collection (order-preserving)', () => {
    expect(mk((id) => id === 'playlist-1').modeOf('playlist-1')).toBe('collection')
  })

  it('the same unmoded stream, NOT audio, stays feed', () => {
    expect(mk((id) => id === 'something-else').modeOf('playlist-1')).toBe('feed')
    expect(mk(undefined).modeOf('playlist-1')).toBe('feed') // no predicate wired (tests) → skipped
  })

  it('an explicit stored mode always wins over the audio rule', () => {
    const sched = new Scheduler({
      registry: new Registry([mkFeed('src-feed')]),
      streams: [{ ...unmodedStream, mode: 'feed' }],
      adapters: new Map([['fake', noopAdapter]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
      isAudioStream: () => true,
    })
    expect(sched.modeOf('playlist-1')).toBe('feed')
  })
})
