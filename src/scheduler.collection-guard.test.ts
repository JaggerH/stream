import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Scheduler, CacheLayer } from './scheduler.ts'
import { Registry } from './registry/registry.ts'
import { DedupStore } from './dedup-store.ts'
import { ItemStore } from './item-store.ts'
import { MemoryCollectionGuard } from './collection-replace-guard.ts'
import { SourceHealthStore } from './source-health-store.ts'
import type { Adapter, AdapterFetchResult } from './adapters/types.ts'
import type { SourceManifest } from './manifest/types.ts'
import type { Stream } from './streams/types.ts'

/**
 * 2026-07-24 怡乐活体事故的回归面：collection 流的某个成员一次采到空，就把它自己的分片
 * 全部替换掉。两层防线（采集侧成功指针 + 替换侧近乎全空）都在这里过。
 */

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

const collectionStream: Stream = {
  id: 'playlist-1',
  description: 'collection',
  mode: 'collection',
  sources: [{ source_id: 'src-a', params: {} }],
  cadence_seconds: 1800,
  vault_subdir: 'coll',
}

const items = (n: number, tag = 'x') =>
  Array.from({ length: n }, (_, i) => ({ guid: `${tag}-${i}`, title: `${tag} ${i}` }))

describe('collection 分片替换的两层防线', () => {
  let dir: string
  let dedup: DedupStore
  let store: ItemStore
  let guard: MemoryCollectionGuard
  /** adapter 下一轮返回什么 + 被真调用了几次（用来证明结果有没有进缓存） */
  let next: unknown[] | AdapterFetchResult
  let calls: number
  let clock: number
  let cache: CacheLayer
  let held: Array<{ streamId: string; sourceId: string; reason: string; kept: number }>
  let skipped: Array<[string, string]>

  const adapter: Adapter = {
    id: 'fake',
    init: async () => {},
    fetch: async () => { calls++; return next },
  }

  function mkSched(extra: Record<string, unknown> = {}) {
    return new Scheduler({
      registry: new Registry([mk('src-a')]),
      streams: [collectionStream],
      adapters: new Map([['fake', adapter]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      vaultEnabled: false,
      dedup,
      itemStore: store,
      cacheLayer: cache,
      collectionGuard: guard,
      onCollectionReplaceHeld: (info: { streamId: string; sourceId: string; reason: string; kept: number }) =>
        held.push(info),
      onHarvestSkipped: (sourceId: string, reason: string) => skipped.push([sourceId, reason]),
      ...extra,
    } as ConstructorParameters<typeof Scheduler>[0])
  }

  /** 让下一轮真的去采（而不是命中缓存）——把注入的时钟推过 TTL */
  const expireCache = () => { clock += 24 * 3600_000 }
  const shard = () => store.recent({ stream: 'playlist-1' }).length

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sched-guard-'))
    dedup = new DedupStore(join(dir, 'dedup.db'))
    store = new ItemStore(join(dir, 'items.db'))
    guard = new MemoryCollectionGuard()
    calls = 0
    clock = 0
    cache = new CacheLayer({ now: () => clock })
    held = []
    skipped = []
    next = []
  })

  afterEach(() => {
    store.close()
    dedup.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // ── 第 1 层：采集侧的成功指针 ──

  it('非权威的空（本轮没采）不替换分片，且出声', async () => {
    next = items(3)
    await mkSched().tick('playlist-1')
    expect(shard()).toBe(3)

    expireCache()
    next = { items: [], authoritative: false }
    await mkSched().tick('playlist-1')

    expect(shard()).toBe(3) // 一条不少
    expect(held).toEqual([
      { streamId: 'playlist-1', sourceId: 'src-a', reason: 'not-authoritative', kept: 3 },
    ])
    expect(skipped).toHaveLength(1)
  })

  it('非权威结果不进缓存——下一轮必须再去真采一次', async () => {
    next = { items: [], authoritative: false }
    const sched = mkSched()
    await sched.tick('playlist-1')
    await sched.tick('playlist-1') // 时钟没动：若进了缓存，这一轮就命中而不会再调 adapter
    expect(calls).toBe(2)
  })

  it('非权威结果不写 health（既不记 ok 也不记 empty）', async () => {
    const health = new SourceHealthStore(join(dir, 'health.json'))
    next = { items: [], authoritative: false }
    await mkSched({ health }).tick('playlist-1')
    expect(health.stateOf('src-a')).toBe('healthy') // 从未被记过 → 保持初值
    expect(health.snapshot()['src-a']).toBeUndefined()
  })

  // ── 第 2 层：近乎全空，连续两轮才认 ──

  it('权威空快照第一轮拦下（保住旧分片 + 告警），第二轮才真清空', async () => {
    next = items(3)
    await mkSched().tick('playlist-1')
    expect(shard()).toBe(3)

    expireCache()
    next = []
    await mkSched().tick('playlist-1')
    expect(shard()).toBe(3) // 第一轮：保住
    expect(held).toEqual([
      { streamId: 'playlist-1', sourceId: 'src-a', reason: 'near-empty', kept: 3 },
    ])

    expireCache()
    next = []
    await mkSched().tick('playlist-1')
    expect(shard()).toBe(0) // 第二轮：真清空生效，只晚一轮
    expect(held).toHaveLength(1)
  })

  it('拦下后来了一轮正常快照 → 正常替换且 armed 清掉（下次空又要重新攒两轮）', async () => {
    next = items(3)
    await mkSched().tick('playlist-1')

    expireCache()
    next = []
    await mkSched().tick('playlist-1')
    expect(shard()).toBe(3)

    expireCache()
    next = items(5, 'y')
    await mkSched().tick('playlist-1')
    expect(shard()).toBe(5)
    expect(guard.isArmed('playlist-1', 'src-a')).toBe(false)

    expireCache()
    next = []
    await mkSched().tick('playlist-1')
    expect(shard()).toBe(5) // 又是第一轮，重新拦
  })

  it('非权威的空不给"连续两轮"攒数', async () => {
    next = items(3)
    await mkSched().tick('playlist-1')

    expireCache()
    next = { items: [], authoritative: false }
    await mkSched().tick('playlist-1')
    expect(guard.isArmed('playlist-1', 'src-a')).toBe(false)

    expireCache()
    next = []
    await mkSched().tick('playlist-1')
    expect(shard()).toBe(3) // 这才是第一轮权威空 → 仍然保住
  })

  it('大幅缩水但不空 → 第一轮就生效，不拦', async () => {
    next = items(10)
    await mkSched().tick('playlist-1')
    expect(shard()).toBe(10)

    expireCache()
    next = items(2, 'z')
    await mkSched().tick('playlist-1')
    expect(shard()).toBe(2)
    expect(held).toEqual([])
  })

  it('分片本来就空 → 权威空快照照常替换，不拦不告警', async () => {
    next = []
    await mkSched().tick('playlist-1')
    expect(shard()).toBe(0)
    expect(held).toEqual([])
  })

  it('被拦下时不触发 onAudioHarvest（否则会拿空歌单去撤下载）', async () => {
    const harvests: number[] = []
    next = items(3)
    await mkSched({ onAudioHarvest: (_id: string, its: unknown[]) => harvests.push(its.length) }).tick('playlist-1')

    expireCache()
    next = []
    await mkSched({ onAudioHarvest: (_id: string, its: unknown[]) => harvests.push(its.length) }).tick('playlist-1')
    expect(harvests).toEqual([3])
  })
})
