import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { StreamService, pluginLaunchMode } from './tools.ts'
import { Registry } from '../registry/registry.ts'
import { Scheduler } from '../scheduler.ts'
import { DedupStore } from '../dedup-store.ts'
import type { Adapter } from '../adapters/types.ts'
import type { SourceManifest } from '../manifest/types.ts'
import type { Stream } from '../streams/types.ts'
import { UserStore } from '../store/user-store.ts'
import type { PluginDescriptor } from '../plugins/types.ts'

function mk(partial: Partial<SourceManifest> & { id: string }): SourceManifest {
  return {
    schema_version: 1,
    adapter: 'fake',
    type: 'post',
    description: partial.id,
    topics: [],
    example_queries: [],
    capabilities: ['timeline'],
    auth: { type: 'none' },
    params_schema: {},
    cadence_hint_seconds: 1800,
    discoverable: true,
    ...partial,
  }
}

let fetchCalls = 0
const fake: Adapter = {
  id: 'fake',
  init: async () => {},
  fetch: async () => {
    fetchCalls++
    return [{ guid: '1', title: 't' }]
  },
}

const manifests: SourceManifest[] = [
  mk({ id: 'hn-best', pluginId: 'hackernews', description: 'hacker news tech stories', topics: ['tech'], categories: ['news'] }),
  mk({
    id: 'bili', pluginId: 'rsshub', description: 'bilibili dynamic', topics: ['bilibili'], categories: ['social-media'],
    route: '/b/{uid}', params_schema: { uid: { type: 'string', required: true } },
  }),
  mk({ id: 'bili-search', pluginId: 'rsshub', description: 'bilibili keyword search', topics: ['bilibili'], categories: ['social-media'], capabilities: ['search'] }),
]

const myTech: Stream = {
  id: 'my-tech',
  description: 'my tech feed',
  sources: [{ source_id: 'hn-best', params: {} }],
  cadence_seconds: 1800,
  vault_subdir: 'tech',
}

describe('StreamService', () => {
  let dir: string
  let dedup: DedupStore
  let userStore: UserStore
  let svc: StreamService

  beforeEach(() => {
    fetchCalls = 0
    dir = mkdtempSync(join(tmpdir(), 'svc-'))
    dedup = new DedupStore(join(dir, 'dedup.db'))
    userStore = new UserStore(join(dir, 'stream.db'))
    const scheduler = new Scheduler({
      registry: new Registry(manifests),
      streams: [myTech],
      adapters: new Map([['fake', fake]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
    })
    svc = new StreamService({ registry: new Registry(manifests), scheduler, channels: userStore })
  })
  afterEach(() => {
    dedup.close()
    userStore.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('list returns named streams', () => {
    expect(svc.list()).toEqual([{ id: 'my-tech', description: 'my tech feed' }])
  })

  it('search returns ranked candidates with schema', () => {
    const res = svc.search('bilibili')
    expect(res[0].id).toBe('bili')
    expect(res[0].params_schema).toHaveProperty('uid')
  })

  it('read a named stream returns items', async () => {
    const items = await svc.read('my-tech')
    expect(items).toHaveLength(1)
  })

  it('read a source by id returns items', async () => {
    const items = await svc.read('bili', { uid: '42' })
    expect(items).toHaveLength(1)
  })

  it('read a source by id returns NORMALIZED items (StoredItem shape, like content_search)', async () => {
    const items = await svc.read('bili', { uid: '42' })
    expect(items).toHaveLength(1)
    // normalizeRaw produces the StoredItem envelope: id + content, not the raw {guid,title}
    const it = items[0] as { id?: unknown; content?: unknown; title?: unknown }
    expect(it.id).toBeTruthy()
    expect(it.content).toBeTruthy()
  })

  it('read with invalid params throws before any fetch', async () => {
    await expect(svc.read('bili', {})).rejects.toThrow(/uid/)
    expect(fetchCalls).toBe(0)
  })

  it('subscribe persists + schedules; unsubscribe removes', () => {
    const s: Stream = { ...myTech, id: 'extra', vault_subdir: 'extra' }
    svc.subscribe(s)
    expect(userStore.getStream('extra')).toBeTruthy()
    expect(svc.list().map((x) => x.id)).toContain('extra')
    expect(svc.unsubscribe('extra')).toBe(true)
    expect(userStore.getStream('extra')).toBeNull()
    expect(svc.list().map((x) => x.id)).not.toContain('extra')
  })

  it('subscribe normalizes bare source_id into plugin/source members', () => {
    // the frontend subscribe path sends only source_id — must not persist plugin: ''
    svc.subscribe({ ...myTech, id: 'bare', vault_subdir: 'bare' })
    const rec = userStore.getStream('bare')!
    expect(rec.members[0].plugin).not.toBe('')
    expect(rec.members[0].source).toBe('hn-best')
    // implicit attach: lands in the default timeline channel (invariant 1)
    expect(userStore.getChannel('default-timeline')?.stream_ids).toContain('bare')
  })

  it('attaches into an explicit channelId when given (e.g. a caller placing a stream into an audio channel)', () => {
    // Stream carries no kind/audio signal of its own (consumption mode is Channel membership,
    // not a stream property) — a caller that wants audio placement must pass channelId explicitly.
    userStore.putChannel({ id: 'default-audio', label: '音乐与播客', present: 'audio', stream_ids: [], options: {} })
    svc.subscribe({ ...myTech, id: 'song', vault_subdir: 'song' }, 'default-audio')
    expect(userStore.getChannel('default-audio')?.stream_ids).toContain('song')
  })

  // subscribe 一度无条件 `scheduler.add` + 立刻 tick。channelId 是调用方给的任意值，
  // research 频道是合法值——于是一条「现读不落库」的流从 MCP 这条路被排进采集。
  // 判据必须在 attach **之后**问：attach 之前这条流还不属于任何频道，isCollected 会答「采」。
  it('subscribe 到 research 频道：入库存档但不进调度', () => {
    userStore.putChannel({ id: 'rc', label: '研究', present: 'research', stream_ids: [], options: {} })
    svc.subscribe({ ...myTech, id: 'runs', vault_subdir: 'runs' }, 'rc')
    expect(userStore.getStream('runs')).toBeTruthy()
    expect(userStore.getChannel('rc')?.stream_ids).toContain('runs')
    expect(svc.list().map((x) => x.id)).not.toContain('runs')
  })

  it('status returns per-stream last_tick + item_count', () => {
    const st = svc.status()
    expect(st[0]).toMatchObject({ id: 'my-tech', last_tick: null })
    expect(typeof st[0].item_count).toBe('number')
  })

  it('topics facet returns aggregate topics, not sources', () => {
    expect(svc.topics()).toEqual(['bilibili', 'tech'])
  })

  it('searchAllPluginSources spans every plugin and groups by plugin', () => {
    const res = svc.searchAllPluginSources({ query: 'bilibili' })
    expect(res.sources.map((s) => s.id).sort()).toEqual(['bili', 'bili-search'])
    // both matches live under the rsshub plugin
    expect(res.plugins).toEqual([{ id: 'rsshub', name: 'rsshub', count: 2 }])
    expect(res.total).toBe(2)
  })

  it('searchAllPluginSources with empty query browses all plugins', () => {
    const res = svc.searchAllPluginSources({})
    expect(res.plugins.map((p) => p.id).sort()).toEqual(['hackernews', 'rsshub'])
    expect(res.total).toBe(3)
  })

  it('searchAllPluginSources capability=search narrows the set', () => {
    const res = svc.searchAllPluginSources({ capability: 'search' })
    expect(res.sources.map((s) => s.id)).toEqual(['bili-search'])
  })

  it('searchAllPluginSources exposes capability + category facets over the full match set', () => {
    const res = svc.searchAllPluginSources({})
    expect(res.facets.capabilities.find((f) => f.key === 'search')?.count).toBe(1)
    expect(res.facets.categories.find((f) => f.key === 'social-media')?.count).toBe(2)
  })

  it('searchAllPluginSources paginates via cursor', () => {
    const page1 = svc.searchAllPluginSources({ limit: 2 })
    expect(page1.sources).toHaveLength(2)
    expect(page1.nextCursor).toBe('2')
    const page2 = svc.searchAllPluginSources({ limit: 2, cursor: page1.nextCursor })
    expect(page2.sources).toHaveLength(1)
    expect(page2.nextCursor).toBeUndefined()
  })

  // 一条已经在调度里的流再被 scheduleResourceStream 一次，不许再「立刻抓一次」。
  // 调用方接线出错时（POST /api/streams 曾经无条件排班 + 判据又排一次），
  // 重复的那一次注册本身是幂等的（Scheduler 按 id 存），真正被做了两遍的是这句立刻 tick。
  it('scheduleResourceStream: 已在调度里的流不再重复立刻抓一次', async () => {
    const scheduler = new Scheduler({
      registry: new Registry(manifests),
      streams: [],
      adapters: new Map([['fake', fake]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault2'),
      dedup,
    })
    const tick = vi.spyOn(scheduler, 'tick')
    const svc2 = new StreamService({ registry: new Registry(manifests), scheduler, channels: userStore })
    svc2.scheduleResourceStream(myTech)
    svc2.scheduleResourceStream(myTech)
    await vi.waitFor(() => expect(tick).toHaveBeenCalled())
    expect(scheduler.list().filter((s) => s.id === myTech.id)).toHaveLength(1)
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('plugins() lists a descriptor-only plugin (zero registered sources) as needs_config', () => {
    // 目录诚实性：有 descriptor 但未接线（registry 里零 source）的插件不得静默消失。
    const withGhost = new StreamService({
      registry: new Registry(manifests),
      scheduler: {} as unknown as Scheduler,
      channels: userStore,
      plugins: [{ id: 'ghost', name: 'Ghost' } as unknown as PluginDescriptor],
    })
    const ghost = withGhost.plugins().find((p) => p.id === 'ghost')
    expect(ghost).toBeDefined()
    expect(ghost!.sourceCount).toBe(0)
    expect(ghost!.status).toBe('needs_config')
    expect(ghost!.enabled).toBe(true) // no predicate → default enabled
    expect(ghost!.required).toBe(false)
  })

  it('plugins() reports enabled/required and marks a disabled plugin (disabled wins over needs_config)', () => {
    const svc2 = new StreamService({
      registry: new Registry(manifests),
      scheduler: {} as unknown as Scheduler,
      channels: userStore,
      plugins: [
        { id: 'rsshub', name: 'RSSHub', required: true } as unknown as PluginDescriptor,
        { id: 'pansou', name: 'PanSou' } as unknown as PluginDescriptor, // optional, zero registered sources
      ],
      // pansou turned off by the user; rsshub is required so the predicate is ignored for it
      pluginEnabled: (id) => id !== 'pansou',
    })
    const byId = Object.fromEntries(svc2.plugins().map((p) => [p.id, p]))
    // rsshub: required → always enabled, has registered sources → ready
    expect(byId.rsshub.required).toBe(true)
    expect(byId.rsshub.enabled).toBe(true)
    expect(byId.rsshub.status).toBe('ready')
    // pansou: optional + disabled → status 'disabled' (NOT 'needs_config' despite zero sources)
    expect(byId.pansou.required).toBe(false)
    expect(byId.pansou.enabled).toBe(false)
    expect(byId.pansou.status).toBe('disabled')
  })
})

describe('pluginLaunchMode', () => {
  const descriptors = [
    { id: 'rsshub', name: 'RSSHub' },
    { id: 'pansou', name: '盘搜', backend: { image: 'x', port: 80, service: 'pansou' } },
    { id: 'xhs', name: '小红书' },
  ]

  it('is descriptor-driven: backend declared → container, none → builtin, rsshub → external', () => {
    expect(pluginLaunchMode('rsshub', descriptors)).toBe('external')
    expect(pluginLaunchMode('pansou', descriptors)).toBe('container')
    expect(pluginLaunchMode('xhs', descriptors)).toBe('builtin')
  })

  it('a plugin without a descriptor is builtin — the host keeps no hardcoded container list', () => {
    expect(pluginLaunchMode('nobody', descriptors)).toBe('builtin')
    expect(pluginLaunchMode('pansou', [])).toBe('builtin')
  })
})
