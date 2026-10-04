import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHttpApp, type HealthInfo } from './app.ts'
import { StreamService } from '../mcp/tools.ts'
import { Registry } from '../registry/registry.ts'
import { sealManifests } from '../registry/seal.ts'
import type { PluginDescriptor } from '../plugins/types.ts'
import { Scheduler } from '../scheduler.ts'
import { DedupStore } from '../dedup-store.ts'
import { ItemStore } from '../item-store.ts'
import { CollectionsStore, SYSTEM_COLLECTIONS } from '../collections/store.ts'
import { StreamSeenStore } from '../stream-seen-store.ts'
import type { Adapter } from '../adapters/types.ts'
import type { SourceManifest } from '../manifest/types.ts'
import type { Stream } from '../streams/types.ts'
import type { StreamItem } from '../types.ts'
import { UserStore } from '../store/user-store.ts'
import { streamToStreamRecord } from '../store/compat.ts'
import { SourceHealthStore } from '../source-health-store.ts'
import { ProviderStatsStore } from '../providers/stats-store.ts'
import { ProviderExecutor, sourceOf } from '../providers/executor.ts'
import { ProviderBindings } from '../providers/bindings.ts'
import { PROVIDER_CALLSITES } from '../providers/callsites.ts'
import { SpeakerRegistryStore } from '../voiceprint/store.ts'
import { ValidationError } from '../packages/activate.ts'

vi.mock('../media/extract.ts', () => ({
  probeStreams: vi.fn(),
  extractStream: vi.fn(),
}))
import { probeStreams, extractStream } from '../media/extract.ts'

function mk(partial: Partial<SourceManifest> & { id: string }): SourceManifest {
  return {
    schema_version: 1, adapter: 'fake', type: 'post', description: partial.id,
    topics: [], example_queries: [], capabilities: ['timeline'], auth: { type: 'none' },
    params_schema: {}, cadence_hint_seconds: 1800, discoverable: true, ...partial,
  }
}
function item(id: string, stream: string): StreamItem {
  return { id, stream_id: stream, source_type: 'rsshub-bridge', source_route: '/x',
    fetched_at: '2026-06-08T00:00:00.000Z', timestamp: '2026-06-08T00:00:00.000Z', title: id, raw: {} }
}
const fake: Adapter = { id: 'fake', init: async () => {}, fetch: async () => [] }
const manifests = [
  mk({ id: 'hn', description: 'hacker news', topics: ['tech'], categories: ['news'] }),
  mk({
    id: 'bili',
    description: 'bilibili dynamic',
    topics: ['bilibili'],
    categories: ['social-media'],
    facility: { key: 'bilibili', label: '哔哩哔哩' },
    params_schema: { uid: { type: 'string', required: true, description: '用户 id' } },
    runtime_config: {
      ref: 'tmdb', fields: {
        apiKey: { type: 'secret', label: 'TMDb API Key', required: true },
        language: { type: 'string', label: '语言', default: 'zh-CN' },
      },
    },
    notes: 'Bilibili dynamic docs',
    docsMarkdown: '## 路由说明\nBilibili dynamic docs',
  }),
  mk({
    id: 'bili-following',
    description: 'bilibili following',
    topics: ['bilibili'],
    categories: ['social-media'],
    facility: { key: 'bilibili', label: '哔哩哔哩' },
  }),
]
const stream: Stream = { id: 'my-tech', description: 'tech', sources: [{ source_id: 'hn', params: {} }], cadence_seconds: 1800, vault_subdir: 'tech' }
const health: () => Promise<HealthInfo> = async () => ({ cookies: { domains: ['bilibili.com'], updatedAt: 1 }, manifests: 2, streams: 1 })

describe('HTTP API', () => {
  let dir: string, dedup: DedupStore, store: ItemStore
  function build(token?: string, extra: Partial<Parameters<typeof createHttpApp>[0]> = {}) {
    const descriptors: PluginDescriptor[] = [{
      id: 'fake',
      name: 'Fake Plugin',
      tagline: '测试插件副标题',
      description: '新闻和社交媒体测试源。',
      homepage: 'https://example.com',
      repository: 'https://example.com/repo',
      docsUrl: 'https://example.com/docs',
      sourceGrouping: { enabled: true, resolver: 'manifest.facility' },
    }]
    const scheduler = new Scheduler({ registry: new Registry(manifests), streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
    const service = new StreamService({
      registry: new Registry(sealManifests(manifests, descriptors)),
      scheduler,
      channels: new UserStore(join(dir, `stream-svc-${Math.random()}.db`)),
      plugins: descriptors,
    })
    return createHttpApp({ service, itemStore: store, health, accessGuard: token ? { token } : undefined, ...extra })
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'http-'))
    dedup = new DedupStore(join(dir, 'd.db'))
    store = new ItemStore(join(dir, 'i.db'))
    store.add(item('i1', 'my-tech'), 'post')
    store.add(item('i2', 'other'), 'post')
  })
  afterEach(() => { dedup.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })

  it('GET /api/streams', async () => {
    const r = await build().request('/api/streams')
    expect(r.status).toBe(200)
    expect((await r.json()).map((s: { id: string }) => s.id)).toContain('my-tech')
  })

  it('GET /api/streams no longer stamps a stream-level `kind`, even for a stream in an audio channel (Channel.present owns consumption-mode routing)', async () => {
    // my-tech is deliberately put in an audio-present channel: this is exactly the case that
    // used to make the /api/streams handler attach `kind: 'audio'` to the raw stream (app.ts:705)
    // — the case that must prove the attach is gone, not merely absent by construction.
    const channelStore = new UserStore(join(dir, `stream-nokind-${Math.random()}.db`))
    channelStore.putStream(streamToStreamRecord(stream))
    channelStore.putChannel({ id: 'my-audio', label: '我的音频', present: 'audio', stream_ids: [stream.id], options: {} })
    try {
      const app = build(undefined, { channelStore })
      const r = await app.request('/api/streams')
      const streams = (await r.json()) as Array<Record<string, unknown>>
      expect(streams.length).toBeGreaterThan(0)
      expect(streams.every((s) => !('kind' in s))).toBe(true)
    } finally {
      channelStore.close()
    }
  })

  describe('正在追的 via 系统收藏列表, independent of Channel membership (2026-07-20)', () => {
    it('a collected non-ranking video stream gets newCount; an un-collected one does not', async () => {
      const channelStore = new UserStore(join(dir, `channels-collect-${Math.random()}.db`))
      const seenStore = new StreamSeenStore(join(dir, `seen-collect-${Math.random()}.db`))
      const collections = new CollectionsStore(join(dir, `collections-${Math.random()}.db`))
      channelStore.putStream({ id: 'show-a', label: 'Show A', strategy: 'fanout', cadence_seconds: 3600, members: [], options: {} })
      channelStore.putStream({ id: 'show-b', label: 'Show B', strategy: 'fanout', cadence_seconds: 3600, members: [], options: {} })
      channelStore.putChannel({ id: 'video', label: '影视', present: 'video', stream_ids: ['show-a', 'show-b'], options: {} })
      collections.addItem(SYSTEM_COLLECTIONS.videoFollowing, { kind: 'stream', streamId: 'show-a' }, { title: 'Show A' }) // only show-a is collected
      try {
        const app = build(undefined, { channelStore, seenStore, collections })
        const r = await app.request('/api/channels?kind=video')
        // UserStore auto-seeds a system `default-video` channel (also kind=video) with the 5
        // ranking streams — find OUR custom channel, not just take the first result.
        const channels = (await r.json()) as Array<{ id: string; streams: Array<{ id: string; newCount?: number }> }>
        const channel = channels.find((c) => c.id === 'video')!
        const byId = Object.fromEntries(channel.streams.map((s) => [s.id, s]))
        expect(typeof byId['show-a'].newCount).toBe('number') // collected → surfaced as 正在追的
        expect(byId['show-b'].newCount).toBeUndefined() // channel member but never collected → not
      } finally {
        channelStore.close()
        seenStore.close()
        collections.close()
      }
    })

    it('a hardcoded ranking stream never gets newCount, even if someone collected its id', async () => {
      const channelStore = new UserStore(join(dir, `channels-collect-rank-${Math.random()}.db`))
      const seenStore = new StreamSeenStore(join(dir, `seen-collect-rank-${Math.random()}.db`))
      const collections = new CollectionsStore(join(dir, `collections-rank-${Math.random()}.db`))
      channelStore.putStream({ id: 'video-tmdb-movie', label: 'TMDB Trend', strategy: 'fanout', cadence_seconds: 3600, members: [], options: {} })
      channelStore.putChannel({ id: 'video', label: '影视', present: 'video', stream_ids: ['video-tmdb-movie'], options: {} })
      collections.addItem(SYSTEM_COLLECTIONS.videoFollowing, { kind: 'stream', streamId: 'video-tmdb-movie' }, { title: 'TMDB Trend' })
      try {
        const app = build(undefined, { channelStore, seenStore, collections })
        const r = await app.request('/api/channels?kind=video')
        const channels = (await r.json()) as Array<{ id: string; streams: Array<{ id: string; newCount?: number }> }>
        const channel = channels.find((c) => c.id === 'video')!
        expect(channel.streams.find((s) => s.id === 'video-tmdb-movie')!.newCount).toBeUndefined()
      } finally {
        channelStore.close()
        seenStore.close()
        collections.close()
      }
    })
  })

  describe('/api/collections — 统一多列表收藏(video + audio, 2026-07-20)', () => {
    it('503 when no collections dep is wired', async () => {
      expect((await build().request('/api/collections')).status).toBe(503)
      expect((await build().request('/api/collections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'video', label: 'x' }) })).status).toBe(503)
      expect((await build().request(`/api/collections/${SYSTEM_COLLECTIONS.videoFollowing}/items/${encodeURIComponent('stream:show-a')}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }) })).status).toBe(503)
    })

    it('lists collections (optionally filtered by domain) with item counts', async () => {
      const collections = new CollectionsStore(join(dir, `collections-list-${Math.random()}.db`))
      try {
        const app = build(undefined, { collections })
        const all = await (await app.request('/api/collections')).json()
        expect(all).toEqual([
          expect.objectContaining({ id: SYSTEM_COLLECTIONS.videoFollowing, domain: 'video', itemCount: 0 }),
          expect.objectContaining({ id: SYSTEM_COLLECTIONS.audioLiked, domain: 'audio', itemCount: 0 }),
        ])
        const videoOnly = await (await app.request('/api/collections?domain=video')).json()
        expect(videoOnly).toEqual([expect.objectContaining({ id: SYSTEM_COLLECTIONS.videoFollowing })])
        expect((await app.request('/api/collections?domain=bogus')).status).toBe(400)
      } finally {
        collections.close()
      }
    })

    it('creates, renames, and deletes a custom list; system lists reject delete', async () => {
      const collections = new CollectionsStore(join(dir, `collections-crud-${Math.random()}.db`))
      try {
        const app = build(undefined, { collections })
        const created = await (await app.request('/api/collections', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'video', label: '想看' }),
        })).json()
        expect(created).toMatchObject({ domain: 'video', label: '想看' })

        const renamed = await (await app.request(`/api/collections/${created.id}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: '已看完' }),
        })).json()
        expect(renamed).toMatchObject({ label: '已看完' })

        expect((await app.request(`/api/collections/${SYSTEM_COLLECTIONS.videoFollowing}`, { method: 'DELETE' })).status).toBe(400)
        expect((await app.request(`/api/collections/${created.id}`, { method: 'DELETE' })).status).toBe(200)
        expect((await app.request(`/api/collections/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'x' }) })).status).toBe(404)
      } finally {
        collections.close()
      }
    })

    it('adds/lists/removes a stream-backed item, and a tmdb (no-Stream) item, in a list', async () => {
      const collections = new CollectionsStore(join(dir, `collections-items-${Math.random()}.db`))
      try {
        const app = build(undefined, { collections })
        const streamKey = encodeURIComponent('stream:show-a')
        const put1 = await app.request(`/api/collections/${SYSTEM_COLLECTIONS.videoFollowing}/items/${streamKey}`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '示例作品', poster: '/p.jpg' }),
        })
        expect(put1.status).toBe(200)
        expect(await put1.json()).toMatchObject({ kind: 'stream', streamId: 'show-a', title: '示例作品', poster: '/p.jpg' })

        const tmdbKey = encodeURIComponent('tmdb:movie:1368337')
        const put2 = await app.request(`/api/collections/${SYSTEM_COLLECTIONS.videoFollowing}/items/${tmdbKey}`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '奥德赛', poster: '/o.jpg' }),
        })
        expect(await put2.json()).toMatchObject({ kind: 'tmdb', tmdbId: '1368337', media: 'movie', title: '奥德赛' })

        const items = await (await app.request(`/api/collections/${SYSTEM_COLLECTIONS.videoFollowing}/items`)).json()
        expect(items).toHaveLength(2)

        const collected = await (await app.request(`/api/collected/${tmdbKey}`)).json()
        expect(collected).toEqual({ item: expect.objectContaining({ tmdbId: '1368337' }), collectionIds: [SYSTEM_COLLECTIONS.videoFollowing] })

        expect((await app.request(`/api/collections/${SYSTEM_COLLECTIONS.videoFollowing}/items/${tmdbKey}`, { method: 'DELETE' })).status).toBe(200)
        expect(await (await app.request(`/api/collections/${SYSTEM_COLLECTIONS.videoFollowing}/items`)).json()).toHaveLength(1)
      } finally {
        collections.close()
      }
    })

    it('400 on a missing title, an invalid item key, or an unknown collection id', async () => {
      const collections = new CollectionsStore(join(dir, `collections-badreq-${Math.random()}.db`))
      try {
        const app = build(undefined, { collections })
        const streamKey = encodeURIComponent('stream:show-a')
        expect((await app.request(`/api/collections/${SYSTEM_COLLECTIONS.videoFollowing}/items/${streamKey}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400)
        expect((await app.request(`/api/collections/${SYSTEM_COLLECTIONS.videoFollowing}/items/${encodeURIComponent('bogus:x')}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }) })).status).toBe(400)
        expect((await app.request(`/api/collections/col_missing/items/${streamKey}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }) })).status).toBe(404)
        expect((await app.request('/api/collections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'bogus', label: 'x' }) })).status).toBe(400)
      } finally {
        collections.close()
      }
    })
  })

  it('reads and refreshes an enriched video detail without making availability provider-owned', async () => {
    const channelStore = new UserStore(join(dir, 'video-detail.db'))
    channelStore.putStream({ id: 'video-1', label: 'Example Film', strategy: 'fanout', cadence_seconds: 3600, members: [], options: { kind: 'movie', year: 2024 } })
    channelStore.putChannel({ id: 'video', label: '影视', present: 'video', stream_ids: ['video-1'], options: {} })
    store.add({ ...item('video-episode', 'video-1'), content: { media: [{ kind: 'image', url: 'https://cover.test/episode.jpg' }] } } as any, 'post')
    store.add({ ...item('filtered-episode', 'video-1'), muted: { reason: 'filtered', rule: '纯享' } }, 'post')
    const calls: Array<{ force?: boolean }> = []
    const videoDetails = {
      get: async (_identity: unknown, opts: { force?: boolean } = {}) => {
        calls.push(opts)
        return { cache: opts.force ? 'refreshed' : 'hit', detail: { cacheKey: 'movie:example film:2024', identity: { title: 'Example Film', externalIds: {} }, images: {}, imageCandidates: [], failures: [], fetchedAt: 't', expiresAt: 'u' } }
      },
    }
    const app = build(undefined, {
      channelStore,
      videoDetails: videoDetails as never,
      netdisk: {
        lookup: (key: string) => key === 'item:video-episode' ? { setId: 'map-video', rightFile: 'episode.mkv' } : undefined,
        hasBindingForStream: (streamId: string) => streamId === 'video-1',
      } as never,
    })

    const read = await app.request('/api/video/works/stream:video-1')
    expect(read.status).toBe(200)
    expect((await read.json()).episodes).toEqual([expect.objectContaining({
      id: 'video-episode',
      content: { media: [expect.objectContaining({ kind: 'video', resolveOnly: true, url: '/api/media/videos/resolve?id=video-episode' })] },
    })])
    const refresh = await app.request('/api/video/works/stream:video-1/refresh', { method: 'POST' })
    expect(refresh.status).toBe(200)
    expect(calls).toEqual([{ force: false }, { force: true }])
    const missing = await app.request('/api/video/works/stream:unknown')
    expect(missing.status).toBe(404)
    channelStore.close()
  })

  it('derives a followed show identity from its title and first episode date, not unverified raw IDs', async () => {
    const channelStore = new UserStore(join(dir, 'followed-show.db'))
    channelStore.putStream({ id: 'show-1', label: '喜剧之王单口季第3季', strategy: 'fanout', cadence_seconds: 3600, members: [], options: {} })
    const captured: unknown[] = []
    const videoDetails = { get: async (identity: unknown) => {
      captured.push(identity)
      return { cache: 'miss' as const, detail: { cacheKey: 'show', identity, images: {}, imageCandidates: [], failures: [], fetchedAt: 't', expiresAt: 'u' } }
    } }
    store.add({ ...item('show-episode', 'show-1'), raw: { pubDate: 'Sat, 11 Jul 2026 00:00:00 GMT', imdb: 'tt1300854' } } as any, 'post')
    store.add({ ...item('show-episode-2', 'show-1'), raw: { pubDate: 'Sun, 12 Jul 2026 00:00:00 GMT' } } as any, 'post')
    const app = build(undefined, { channelStore, videoDetails: videoDetails as never })

    await app.request('/api/video/works/stream:show-1')

    expect(captured).toEqual([{
      title: '喜剧之王单口季第3季', year: 2026, kind: 'series', externalIds: {},
    }])
    channelStore.close()
  })

  it('surfaces a stream binding on a non-TMDB followed show (ref null but binding present)', async () => {
    // 综艺无 canonical → tmdbWorkRef 为 null；但用户已按 streamId 绑了网盘目录，work.binding 必须出来，
    // 否则前端只会显示「还不能绑」——即便它明明绑了、还配上了集。
    const channelStore = new UserStore(join(dir, 'stream-binding.db'))
    channelStore.putStream({ id: 'show-1', label: '喜剧之王单口季第3季', strategy: 'fanout', cadence_seconds: 3600, members: [], options: {} })
    const videoDetails = { get: async (identity: unknown) => ({
      cache: 'miss' as const, detail: { cacheKey: 'show', identity, images: {}, imageCandidates: [], failures: [], fetchedAt: 't', expiresAt: 'u' },
    }) }
    store.add({ ...item('ep-a', 'show-1') } as any, 'post')
    const app = build(undefined, {
      channelStore,
      videoDetails: videoDetails as never,
      netdisk: {
        hasBindingForStream: (streamId: string) => streamId === 'show-1',
        bindingForTmdb: () => undefined,
        bindingForStream: (streamId: string) => streamId === 'show-1' ? {
          id: 'map_b2eb0d', right: { path: '/quark/来自：分享/王.中.王/S03 纯享' }, lastSyncAt: 't',
          entries: [
            { leftKey: 'item:9af4d9c2', leftTitle: '第1期纯享上集', rightFile: '2026-07-03 第1期纯享上集.mkv', status: 'auto' },
            // 已播出（airDate 在过去）却没拿到 → 算进分母，是真的缺一集。
            { leftKey: 'item:58d8c8d6', leftTitle: '第1期纯享下集', rightFile: null, status: 'unmatched', airDate: '2026-07-03' },
            // 没 airDate 又没文件 → 当未播（`progressOf` 的口径：宁可少报进度，不可把未定档
            // 占位报成缺货）。它不进分母，只进 unaired。
            { leftKey: 'item:0000zzzz', leftTitle: '第2期纯享上集', rightFile: null, status: 'unmatched' },
          ],
        } : undefined,
        browseUrl: async () => 'https://pan.quark.cn/list#/list/all/FID',
        lookup: () => undefined,
      } as never,
    })

    const res = await app.request('/api/video/works/stream:show-1')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.binding.ref).toBeNull() // 无 TMDb 坐标
    expect(body.binding.binding).toMatchObject({
      // 分母只数已播出的集（`progressOf`）：三条 entry，其中一条没 airDate 也没文件 → 未播，
      // 不进分母。所以是 1/2 而不是 1/3。
      id: 'map_b2eb0d', dirPath: '/quark/来自：分享/王.中.王/S03 纯享', total: 2, matched: 1, unaired: 1,
      netdiskUrl: 'https://pan.quark.cn/list#/list/all/FID',
    })
    channelStore.close()
  })

  it('enriches a ranking item from its own TMDb URL, title, type, and release year', async () => {
    const captured: unknown[] = []
    const videoDetails = { get: async (identity: unknown) => {
      captured.push(identity)
      return { cache: 'miss' as const, detail: { cacheKey: 'movie:687163', identity, canonical: { status: 'resolved' as const, provider: 'video-canonical', member: 'tmdb-canonical', source: 'tmdb-canonical', externalIds: { tmdb: '687163' }, kind: 'movie' as const }, images: {}, imageCandidates: [], failures: [], fetchedAt: 't', expiresAt: 'u' } }
    } }
    store.add({
      ...item('ranking-film', 'video-tmdb-movie'), title: '挽救计划', url: 'https://www.themoviedb.org/movie/687163',
      raw: { pubDate: 'Sun, 15 Mar 2026 00:00:00 GMT' },
      content: { title: '挽救计划', meta: { year: '2026' } },
    } as any, 'post')
    const app = build(undefined, { videoDetails: videoDetails as never })

    const response = await app.request('/api/video/works/item:ranking-film')

    expect(response.status).toBe(200)
    expect(captured).toEqual([{
      title: '挽救计划', year: 2026, kind: 'movie', sourceUrl: 'https://www.themoviedb.org/movie/687163', externalIds: { tmdb: '687163' },
    }])
    expect((await response.json()).detail.canonical).toMatchObject({ status: 'resolved', provider: 'video-canonical', externalIds: { tmdb: '687163' } })
  })

  it('a bound tv work returns a season/episode tree with per-episode playability', async () => {
    const videoDetails = { get: async (identity: unknown) => ({
      cache: 'hit' as const,
      detail: { cacheKey: 'tmdb:1399', identity, canonical: { status: 'resolved' as const, provider: 'video-canonical', member: 'm', source: 'tmdb', externalIds: { tmdb: '1399' }, kind: 'series' as const, title: '权力的游戏' }, images: {}, imageCandidates: [], failures: [], fetchedAt: 't', expiresAt: 'u' },
    }) }
    store.add({ ...item('got', 'video-tmdb-tv'), title: '权力的游戏', url: 'https://www.themoviedb.org/tv/1399', raw: { pubDate: 'Sun, 17 Apr 2011 00:00:00 GMT' } } as any, 'post')
    const app = build(undefined, {
      videoDetails: videoDetails as never,
      netdisk: {
        browseUrl: async () => 'https://pan.quark.cn/list#/list/all/FID',
        bindingForTmdb: (id: string, media: string) => id === '1399' && media === 'tv' ? {
          id: 'map1', right: { path: '/quark/x' }, lastSyncAt: 't',
          entries: [
            { leftKey: 'tmdb:1399:S01E02', leftTitle: 'S1E2', rightFile: 'e2.mkv', status: 'auto' },
            { leftKey: 'tmdb:1399:S01E01', leftTitle: 'S1E1', rightFile: null, status: 'unmatched' },
          ],
        } : undefined,
      } as never,
    })

    const res = await app.request('/api/video/works/item:got')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.seasons).toEqual([{ season: 1, episodes: [
      { season: 1, episode: 1, title: 'S1E1', leftKey: 'tmdb:1399:S01E01', playable: false },
      { season: 1, episode: 2, title: 'S1E2', leftKey: 'tmdb:1399:S01E02', playable: true },
    ] }])
    // 「跳转网盘」URL 透传到 work.binding（前端拿它做目录名链接的 href）
    expect(body.binding.binding.netdiskUrl).toBe('https://pan.quark.cn/list#/list/all/FID')
  })

  describe('GET /api/video/works/tmdb:<media>:<id> — 已知 tmdb id 详情(收敛后,原 /api/tmdb 端点)', () => {
    it('resolves directly from a known tmdb id via the canonical fast-path — no title search', async () => {
      const captured: unknown[] = []
      const videoDetails = { get: async (identity: unknown) => {
        captured.push(identity)
        return {
          cache: 'miss' as const,
          detail: { cacheKey: 'movie:1368337', identity, canonical: { status: 'resolved' as const, provider: 'video-canonical', member: 'm', source: 'tmdb-canonical', externalIds: { tmdb: '1368337' }, kind: 'movie' as const, title: '奥德赛' }, images: {}, imageCandidates: [], failures: [], fetchedAt: 't', expiresAt: 'u' },
        }
      } }
      const app = build(undefined, { videoDetails: videoDetails as never })

      const res = await app.request('/api/video/works/tmdb:movie:1368337?title=' + encodeURIComponent('奥德赛'))
      expect(res.status).toBe(200)
      // videoTmdbLookupIdentity 只喂 title/kind/externalIds.tmdb——video-canonical.ts 见到已知 tmdb id
      // 直接返回,不打 TMDb 搜索。
      expect(captured).toEqual([{ title: '奥德赛', kind: 'movie', externalIds: { tmdb: '1368337' } }])
      const body = await res.json()
      expect(body.detail.canonical).toMatchObject({ status: 'resolved', externalIds: { tmdb: '1368337' } })
    })

    it('title query param is optional — falls back to the id as a pre-fetch placeholder', async () => {
      const captured: unknown[] = []
      const videoDetails = { get: async (identity: unknown) => {
        captured.push(identity)
        return { cache: 'miss' as const, detail: { cacheKey: 'x', identity, images: {}, imageCandidates: [], failures: [], fetchedAt: 't', expiresAt: 'u' } }
      } }
      const app = build(undefined, { videoDetails: videoDetails as never })

      await app.request('/api/video/works/tmdb:tv:1399')
      expect(captured).toEqual([{ title: '1399', kind: 'series', externalIds: { tmdb: '1399' } }])
    })

    it('400 when media is neither movie nor tv', async () => {
      const app = build(undefined, { videoDetails: { get: async () => ({}) } as never })
      expect((await app.request('/api/video/works/tmdb:season:1')).status).toBe(400)
    })

    it('503 when videoDetails is not configured', async () => {
      expect((await build().request('/api/video/works/tmdb:movie:1')).status).toBe(503)
    })
  })

  describe('POST /api/netdisk/share/save — 转存→自动绑定的强一致命名检查点', () => {
    // 目录名/绑定左侧的 title 只从服务端核实的详情出——前端快照曾把 tmdb id 当 title 传来，
    // 网盘目录因此永久叫了「55157 (1993) [tmdbid-55157]」。
    const save = (over: Partial<{ saved: boolean; stage: string; message: string; dest: string }> = {}) =>
      vi.fn(async () => ({ saved: true, stage: 'done', message: 'ok', dest: 'From Stream/movie-55157', ...over }))
    const netdisk = () => ({
      bindingForTmdb: () => undefined,
      waitDirReady: async () => true,
      bind: vi.fn(async (input: { left: unknown; dirPath: string }) => ({ id: 'map_new', right: { path: input.dirPath }, entries: [] })),
    })
    const detailOf = (canonical?: Record<string, unknown>) => ({
      get: async (identity: unknown) => ({
        cache: 'hit' as const,
        detail: { cacheKey: 'tmdb:55157', identity, ...(canonical ? { canonical } : {}), images: {}, imageCandidates: [], failures: [], fetchedAt: 't', expiresAt: 'u' },
      }),
    })
    const resolvedKika = { status: 'resolved', provider: 'p', member: 'm', source: 'tmdb-canonical', externalIds: { tmdb: '55157' }, kind: 'movie', title: 'Kika', year: 1993 }
    const body = (bind: Record<string, unknown>) => ({
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ link: 'https://pan.quark.cn/s/abc123', bind }),
    })

    // 落点子目录是不透明的 `<media>-<tmdbId>`（网盘上不出现明文作品名）；绑定左侧的 title 仍必须
    // 是服务端核实出的官方名——那是用户在界面里看到的东西，前端快照的 id 回显不能收。
    it('落点子目录不含明文；绑定左侧用服务端核实的官方名，不用前端快照的 title', async () => {
      const shareSave = save()
      const nd = netdisk()
      const app = build(undefined, { netdiskShare: { save: shareSave } as never, netdisk: nd as never, videoDetails: detailOf(resolvedKika) as never })

      // 前端把 id 回显当 title 传来（历史 bug 的输入形状）
      const res = await app.request('/api/netdisk/share/save', body({ id: '55157', media: 'movie', title: '55157' }))

      expect(res.status).toBe(200)
      expect(shareSave).toHaveBeenCalledWith('quark', 'abc123', { dest: undefined, subdir: 'movie-55157', passcode: undefined })
      expect(nd.bind).toHaveBeenCalledWith({ left: { kind: 'tmdb', id: '55157', media: 'movie', title: 'Kika', year: 1993 }, dirPath: '/quark/From Stream/movie-55157' })
      expect((await res.json()).binding).toMatchObject({ id: 'map_new' })
    })

    // 落点名已不取自 title，但这个拒绝仍必须留着：title 是绑定左侧的作品名，放它过去界面上
    // 就会出现一部叫「55157」的作品。别因为"目录名不再依赖它"就把这个检查清理掉。
    it('官方名核实不出 → bind-not-ready，且不转存（绑定左侧的作品名不可信）', async () => {
      const shareSave = save()
      const app = build(undefined, { netdiskShare: { save: shareSave } as never, netdisk: netdisk() as never, videoDetails: detailOf() as never })

      const res = await app.request('/api/netdisk/share/save', body({ id: '55157', media: 'movie', title: '55157' }))

      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ saved: false, stage: 'bind-not-ready' })
      expect(shareSave).not.toHaveBeenCalled()
    })

    it('videoDetails 未配置的降级：前端 title 不是 id 回显才收', async () => {
      const shareSave = save({ dest: 'From Stream/tv-1399' })
      const nd = netdisk()
      const app = build(undefined, { netdiskShare: { save: shareSave } as never, netdisk: nd as never })

      const ok = await app.request('/api/netdisk/share/save', body({ id: '1399', media: 'tv', title: '权力的游戏' }))
      expect(ok.status).toBe(200)
      expect(shareSave).toHaveBeenCalledWith('quark', 'abc123', { dest: undefined, subdir: 'tv-1399', passcode: undefined })

      const refused = await app.request('/api/netdisk/share/save', body({ id: '1399', media: 'tv', title: '1399' }))
      expect(await refused.json()).toMatchObject({ saved: false, stage: 'bind-not-ready' })
    })

    // 转存和建绑定是两次独立请求：不带 bind 的那一路，分享链接过完手就没了。记一条待认领分享
    // （落点 + 坐标），之后哪条绑定的落地目录命中它就把它领走——不记就等于每次缺集都重搜同一条。
    it('不带 bind 的转存也记一条待认领分享，目录是 AList 绝对落点', async () => {
      const recordPendingShare = vi.fn()
      const shareSave = save({ dest: 'From Stream' })
      const app = build(undefined, {
        netdiskShare: { save: shareSave } as never,
        netdiskRoutes: { follow: { recordPendingShare } } as never,
      })

      const res = await app.request('/api/netdisk/share/save', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ link: 'https://pan.quark.cn/s/abc123', passcode: 'xyz' }),
      })

      expect(res.status).toBe(200)
      expect(recordPendingShare).toHaveBeenCalledWith('quark', 'abc123', 'xyz', '/quark/From Stream')
    })

    it('转存失败 → 不记待认领分享（什么都没落地，没有可认领的落点）', async () => {
      const recordPendingShare = vi.fn()
      const shareSave = save({ saved: false, stage: 'token' })
      const app = build(undefined, {
        netdiskShare: { save: shareSave } as never,
        netdiskRoutes: { follow: { recordPendingShare } } as never,
      })
      await app.request('/api/netdisk/share/save', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ link: 'https://pan.quark.cn/s/abc123' }),
      })
      expect(recordPendingShare).not.toHaveBeenCalled()
    })

    // 严格输入闸（docs/API.md §2）：转存是不可逆的写入面，字段名写错必须响亮——静默丢弃
    // 一个 `passcode` 或 `bind` 意味着"转存成了，只是没按你说的做"。
    it('不认识的键 → 400 并指向该写的那个，且一个字节都没转存', async () => {
      const shareSave = save()
      const verify = vi.fn(async () => ({ validity: 'alive', files: [] }))
      const app = build(undefined, { netdiskShare: { save: shareSave, verify } as never, netdisk: netdisk() as never })
      const send = (path: string, b: unknown) =>
        app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })

      const saved = await send('/api/netdisk/share/save', { link: 'https://pan.quark.cn/s/abc123', pwdId: 'abc123' })
      expect(saved.status).toBe(400)
      const savedMsg = (await saved.json() as { error: { message: string } }).error.message
      // 必须是**这道闸**说的话——`link, or netdisk + pwd_id, required` 里也含 "pwd_id"。
      expect(savedMsg).toContain('不认识的字段')
      expect(savedMsg).toContain('pwdId')
      expect(savedMsg).toContain('pwd_id')
      expect(shareSave).not.toHaveBeenCalled()

      const verified = await send('/api/netdisk/share/verify', { netdisk: 'quark', pwdId: 'abc123' })
      expect(verified.status).toBe(400)
      const verifyMsg = (await verified.json() as { error: { message: string } }).error.message
      expect(verifyMsg).toContain('不认识的字段')
      expect(verifyMsg).toContain('pwd_id')
      expect(verify).not.toHaveBeenCalled()

      // 认识的键照常放行
      expect((await send('/api/netdisk/share/verify', { netdisk: 'quark', pwd_id: 'abc123', passcode: 'x' })).status).toBe(200)
      expect(verify).toHaveBeenCalled()
    })
  })



  describe('live preview endpoints', () => {
    function previewApp() {
      const previewAdapter: Adapter = { id: 'fake', init: async () => {}, fetch: async () => [{ guid: 'p1', title: 'Preview One' }] }
      const registry = new Registry(manifests)
      const pv: Stream = { id: 'pv', description: 'pv', sources: [{ source_id: 'hn', params: {} }], cadence_seconds: 1800, vault_subdir: 'pv' }
      const scheduler = new Scheduler({ registry, streams: [pv], adapters: new Map([['fake', previewAdapter]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
      const service = new StreamService({ registry, scheduler, channels: new UserStore(join(dir, `pv-${Math.random()}.db`)) })
      return createHttpApp({ service, itemStore: store, health })
    }

    it('GET /api/streams/:id/preview presents live (no store); 404 on unknown stream', async () => {
      const app = previewApp()
      const res = await (await app.request('/api/streams/pv/preview')).json() as { items: Array<{ title: string; content?: unknown }>; errors: unknown[] }
      expect(res.items.map((i) => i.title)).toEqual(['Preview One'])
      expect(res.items[0].content).toBeDefined() // presented like the timeline
      expect(res.errors).toEqual([])
      expect((await app.request('/api/streams/nope/preview')).status).toBe(404)
    })

    it('POST /api/sources/preview previews one source with ad-hoc params; 400 without sourceId', async () => {
      const app = previewApp()
      const ok = await app.request('/api/sources/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: 'hn', params: {} }) })
      expect((await ok.json() as { items: Array<{ title: string }> }).items.map((i) => i.title)).toEqual(['Preview One'])
      const bad = await app.request('/api/sources/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(bad.status).toBe(400)
    })
  })


  // 这里曾经有一整套 credential broker 的测试（`GET /api/credential`：按包 token、403 没申报 /
  // 404 没登录 / 503 没接线…）。那条路已经撤销——**方向是反的**：宿主是唯一调度方，包不向宿主
  // 要凭证。留下这一条守着它别回来。
  //
  // 为什么要一条测试而不是"记得别加"：这个端点在下面的全局 Bearer 中间件**之前**注册、自带
  // 一套鉴权，谁再加一次不会被任何既有测试碰到——它会静默地重新长出来。
  describe('credential broker 已撤销', () => {
    it('GET /api/credential 不存在（包不向宿主要凭证，凭证由宿主随请求递下去）', async () => {
      const scheduler = new Scheduler({ registry: new Registry(manifests), streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
      const service = new StreamService({ registry: new Registry(manifests), scheduler, channels: new UserStore(join(dir, `stream-svc-${Math.random()}.db`)) })
      const app = createHttpApp({
        service, itemStore: store, health,
        credentialProvider: { cookieString: async () => 'a=1; b=2' },
      })
      expect((await app.request('/api/credential?domain=douyin.com')).status).toBe(404)
    })
  })

  describe('GET /api/media/image', () => {
    it('fails with 400 when neither url nor site is provided', async () => {
      const app = build()
      const r = await app.request('/api/media/image')
      expect(r.status).toBe(400)
      const body = await r.json()
      expect(body).toEqual({ error: { code: 'validation_error', message: 'url or site required' } })
    })

    it('returns 404 for deleted endpoints /api/img and /api/favicon', async () => {
      const app = build()
      const r1 = await app.request('/api/img?url=https://example.com/logo.png')
      expect(r1.status).toBe(404)
      const r2 = await app.request('/api/favicon?url=https://example.com')
      expect(r2.status).toBe(404)
    })

    it('proxies image url successfully (mimicking /api/img)', async () => {
      const app = build()
      // The handler fetches via getImageNoReferer (native node http(s), NOT global fetch) so it can
      // send NO Referer — RSSHub's request-rewriter patches global fetch to inject a self-origin
      // Referer that xhs's CDN 403s. Spy on that module boundary (node builtins aren't spyable).
      const imageFetch = await import('./image-fetch.ts')
      const body = Readable.from([Buffer.from('image-bytes')])
      const getSpy = vi
        .spyOn(imageFetch, 'getImageNoReferer')
        .mockResolvedValue({ status: 200, contentType: 'image/png', body })

      const r = await app.request('/api/media/image?url=https://example.com/pic.png')
      expect(r.status).toBe(200)
      expect(await r.text()).toBe('image-bytes')
      expect(r.headers.get('content-type')).toBe('image/png')
      expect(getSpy).toHaveBeenCalledWith('https://example.com/pic.png', expect.any(AbortSignal))
      getSpy.mockRestore()
    })

    it('resolves site favicon successfully (mimicking /api/favicon)', async () => {
      const app = build()
      const faviconModule = await import('../adapters/favicon.ts')
      const resolveSpy = vi.spyOn(faviconModule, 'resolveFavicon').mockResolvedValue({
        body: new TextEncoder().encode('icon-bytes').buffer,
        contentType: 'image/x-icon',
      })

      const r = await app.request('/api/media/image?site=https://example.com')
      expect(r.status).toBe(200)
      expect(await r.text()).toBe('icon-bytes')
      expect(r.headers.get('content-type')).toBe('image/x-icon')
      expect(resolveSpy).toHaveBeenCalledWith('https://example.com')
      resolveSpy.mockRestore()
    })

    it('rejects a relative-path site with 400 (not 404) so it is distinguishable from "no favicon"', async () => {
      const app = build()
      // 相对路径（部分源产出的 item.url 形态）解析不出站点——显式 400，不混进 404 里。
      const r = await app.request(`/api/media/image?site=${encodeURIComponent('/1247347556/404054602')}`)
      expect(r.status).toBe(400)
      const body = await r.json()
      expect(body).toEqual({ error: { code: 'validation_error', message: 'site must be an absolute url' } })
    })

    it('rejects a non-http(s) site with 400', async () => {
      const app = build()
      const r = await app.request(`/api/media/image?site=${encodeURIComponent('ftp://example.com')}`)
      expect(r.status).toBe(400)
    })
  })

  describe('POST /api/credentials/:domain/connect', () => {
    it('unknown domain, not in the package table either -> 404', async () => {
      const app = build()
      const unknownRes = await app.request('/api/credentials/unknown.com/connect', { method: 'POST' })
      expect(unknownRes.status).toBe(404)
      expect(await unknownRes.json()).toEqual({ error: { code: 'not_found', message: 'unknown credential domain' } })
    })

    it('douyin.com 走包表：命中 douyin 包的 connect → 一键订阅「我的抖音关注」', async () => {
      const subscribe = vi.fn()
      const app = build(undefined, {
        service: { subscribe } as never,
        packageConnect: new Map([
          [
            'douyin.com',
            async () => ({
              stream: {
                id: 'douyin-follow',
                description: '我的抖音关注',
                sources: [{ source_id: 'douyin-follow', params: { mode: 'follow' } }],
                cadence_seconds: 172800,
                vault_subdir: 'douyin-follow',
              },
            }),
          ],
        ]),
      })
      const douyinRes = await app.request('/api/credentials/douyin.com/connect', { method: 'POST' })
      expect(douyinRes.status).toBe(200)
      expect(await douyinRes.json()).toEqual({ ok: true, id: 'douyin-follow' })
      expect(subscribe).toHaveBeenCalled()
    })

    it('先查包表：命中 → 订阅它给的流，extra 并进回执', async () => {
      const subscribe = vi.fn()
      const app = build(undefined, {
        service: { subscribe } as never,
        packageConnect: new Map([
          ['x.com', async () => ({ stream: { id: 's1', description: 'd', sources: [], cadence_seconds: 1, vault_subdir: 'v' }, extra: { uid: '42' } })],
        ]),
      })
      const r = await app.request('/api/credentials/x.com/connect', { method: 'POST' })
      expect(subscribe).toHaveBeenCalled()
      expect(await r.json()).toEqual({ ok: true, id: 's1', uid: '42' })
    })

    it('域名大小写不敏感', async () => {
      const app = build(undefined, {
        service: { subscribe: vi.fn() } as never,
        packageConnect: new Map([
          ['x.com', async () => ({ stream: { id: 's1', description: 'd', sources: [], cadence_seconds: 1, vault_subdir: 'v' } })],
        ]),
      })
      const r = await app.request('/api/credentials/X.COM/connect', { method: 'POST' })
      expect(r.status).toBe(200)
    })

    it('抛 ValidationError → 400', async () => {
      const app = build(undefined, {
        packageConnect: new Map([['x.com', async () => { throw new ValidationError('no login') }]]),
      })
      const r = await app.request('/api/credentials/x.com/connect', { method: 'POST' })
      expect(r.status).toBe(400)
    })
  })

  describe('netdisk subtitle extraction', () => {
    let subCacheDir: string

    beforeEach(async () => {
      subCacheDir = await mkdtemp(join(tmpdir(), 'sub-cache-'))
      vi.mocked(probeStreams).mockReset()
      vi.mocked(extractStream).mockReset()
    })
    afterEach(async () => {
      await rm(subCacheDir, { recursive: true, force: true })
    })

    it('probes tracks by key and returns an empty list when there is no netdisk hit', async () => {
      const app = build(undefined, { netdisk: { lookup: () => undefined } as never })
      const res = await app.request('/api/media/netdisk-subtitle-list?key=tmdb:1:S01E01')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ tracks: [] })
    })

    it('probes embedded tracks AND lists sibling subtitle files, merged under prefixed track ids', async () => {
      vi.mocked(probeStreams).mockResolvedValue({ video: [], audio: [], subtitle: [{ index: 2, codec: 'subrip', lang: 'chi', title: '简体中文' }] })
      const app = build(undefined, {
        netdisk: {
          lookup: (k: string) => (k === 'tmdb:1:S01E01' ? { setId: 's1', dirPath: '/quark/show', rightFile: 'e1.mkv' } : undefined),
          rawUrl: async (p: string) => `http://fake${p}`,
          listDir: async (dir: string) => (dir === '/quark/show' ? [
            { name: 'e1.mkv', size: 800_000_000 },
            { name: 'e1.chs.srt', size: 40_000 },
            { name: 'notes.txt', size: 10 },
          ] : []),
        } as never,
      })
      const res = await app.request('/api/media/netdisk-subtitle-list?key=tmdb:1:S01E01')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ tracks: [
        { id: 'embed:2', index: 2, codec: 'subrip', lang: 'chi', title: '简体中文' },
        { id: 'file:e1.chs.srt', lang: 'chi', title: '简体中文（外挂）' },
      ] })
      expect(probeStreams).toHaveBeenCalledWith('http://fake/quark/show/e1.mkv')
    })

    it('still lists sibling files when the embedded-track probe throws (and vice-versa neither leg is fatal)', async () => {
      vi.mocked(probeStreams).mockRejectedValue(new Error('ffprobe missing'))
      const app = build(undefined, {
        netdisk: {
          lookup: () => ({ setId: 's1', dirPath: '/quark/show', rightFile: 'e1.mkv' }),
          rawUrl: async (p: string) => `http://fake${p}`,
          listDir: async () => [{ name: 'e1.ass', size: 60_000 }],
        } as never,
      })
      const res = await app.request('/api/media/netdisk-subtitle-list?key=tmdb:1:S01E01')
      expect(await res.json()).toEqual({ tracks: [{ id: 'file:e1.ass', title: '外挂字幕' }] })
    })

    it('extracts and serves an embedded track (track=embed:N) as text/vtt, then serves the cached copy', async () => {
      vi.mocked(extractStream).mockResolvedValue({ bytes: Buffer.from('WEBVTT\n\nhello'), mime: 'text/vtt' })
      const app = build(undefined, {
        subtitleCacheDir: subCacheDir,
        netdisk: {
          lookup: () => ({ setId: 's1', dirPath: '/quark/show', rightFile: 'e1.mkv' }),
          rawUrl: async () => 'http://fake/e1.mkv',
        } as never,
      })
      const first = await app.request('/api/media/netdisk-subtitle?key=tmdb:1:S01E01&track=embed:2')
      expect(first.status).toBe(200)
      expect(first.headers.get('content-type')).toContain('text/vtt')
      expect(await first.text()).toBe('WEBVTT\n\nhello')
      expect(extractStream).toHaveBeenCalledWith('http://fake/e1.mkv', { index: 2, kind: 'subtitle' })

      const second = await app.request('/api/media/netdisk-subtitle?key=tmdb:1:S01E01&track=embed:2')
      expect(await second.text()).toBe('WEBVTT\n\nhello')
      expect(extractStream).toHaveBeenCalledTimes(1) // second request hit the disk cache
    })

    it('fetches a sibling file track (track=file:<rel>), converts it to vtt, and caches the conversion', async () => {
      const srt = '1\n00:00:01,000 --> 00:00:02,000\n你好\n'
      const fetchSpy = vi.fn(async () => new Response(Buffer.from(srt), { status: 200 }))
      vi.stubGlobal('fetch', fetchSpy)
      try {
        const app = build(undefined, {
          subtitleCacheDir: subCacheDir,
          netdisk: {
            lookup: () => ({ setId: 's1', dirPath: '/quark/show', rightFile: 'e1.mkv' }),
            rawUrl: async (p: string) => `http://fake${p}`,
          } as never,
        })
        const first = await app.request(`/api/media/netdisk-subtitle?key=tmdb:1:S01E01&track=${encodeURIComponent('file:Subs/e1.chs.srt')}`)
        expect(first.status).toBe(200)
        expect(first.headers.get('content-type')).toContain('text/vtt')
        const body = await first.text()
        expect(body.startsWith('WEBVTT')).toBe(true)
        expect(body).toContain('00:00:01.000 --> 00:00:02.000')
        expect(fetchSpy).toHaveBeenCalledWith('http://fake/quark/show/Subs/e1.chs.srt')

        const second = await app.request(`/api/media/netdisk-subtitle?key=tmdb:1:S01E01&track=${encodeURIComponent('file:Subs/e1.chs.srt')}`)
        expect((await second.text()).startsWith('WEBVTT')).toBe(true)
        expect(fetchSpy).toHaveBeenCalledTimes(1) // cached
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('rejects a file track that tries to escape the binding directory', async () => {
      const app = build(undefined, {
        subtitleCacheDir: subCacheDir,
        netdisk: { lookup: () => ({ setId: 's1', dirPath: '/q', rightFile: 'e.mkv' }) } as never,
      })
      const res = await app.request(`/api/media/netdisk-subtitle?key=tmdb:1:S01E01&track=${encodeURIComponent('file:../secret.srt')}`)
      expect(res.status).toBe(400)
    })

    // 在线搜刮：宿主只经 `subtitle-search` 行的执行器调包，不 fetch 任何字幕站 URL。
    describe('scrape: tracks（经 subtitle-search 行的包成员）', () => {
      const SRC = '@t/subs/a-subtitle'
      const srt = '1\n00:00:01,000 --> 00:00:02,000\n他们说这个国家会变样，很多很多中文堆在这里。\n'
      const fakeExecutor = (members: string[], onFetch = vi.fn(async (_id: string) => Buffer.from(srt))) => ({
        onFetch,
        executor: {
          resolvedMembersOf: () => members.map((name) => ({ name, sourceId: name, kind: 'source' as const })),
          collect: vi.fn(async (_ref: string, input: { op: string; id?: string }, opts?: { excludeMembers?: string[] }) => {
            const live = members.filter((m) => !(opts?.excludeMembers ?? []).includes(m))
            if (input.op === 'search') {
              return { strategy: 'concurrent', provider: 'subtitle-search', misses: [], timings: [],
                results: live.map((member) => ({ member, value: [{ id: 'https://cdn.example/s1.srt', name: 's1', nameHint: 'unknown', label: '甲' }] })) }
            }
            return { strategy: 'concurrent', provider: 'subtitle-search', misses: [], timings: [],
              results: await Promise.all(live.map(async (member) => ({ member, value: [{ bytes: new Uint8Array(await onFetch(input.id!)) }] }))) }
          }),
        },
      })
      const netdisk = {
        lookup: () => ({ setId: 's1', dirPath: '/quark/show', rightFile: 'e1.mkv' }),
        rawUrl: async (p: string) => `http://fake${p}`,
        listDir: async () => [],
        fileSize: async () => 40_000,
      }

      it('本地两条腿全空 → 列出搜刮候选，id = scrape:<源全名>:…，语言从内容判', async () => {
        vi.mocked(probeStreams).mockResolvedValue({ video: [], audio: [], subtitle: [] })
        const { executor } = fakeExecutor([SRC])
        const app = build(undefined, { subtitleCacheDir: subCacheDir, netdisk: netdisk as never, providers: { executor } as never })
        const res = await app.request('/api/media/netdisk-subtitle-list?key=tmdb:1:S01E01')
        const { tracks } = await res.json() as { tracks: Array<{ id: string; title: string }> }
        expect(tracks).toHaveLength(1)
        expect(tracks[0].title).toBe('简体中文 · 甲')
        expect(tracks[0].id.startsWith(`scrape:${SRC}:`)).toBe(true)
      })

      it('取一条 scrape track：只调那个源的 op:fetch，转 VTT 并缓存', async () => {
        const { executor, onFetch } = fakeExecutor([SRC])
        const app = build(undefined, { subtitleCacheDir: subCacheDir, netdisk: netdisk as never, providers: { executor } as never })
        const track = `scrape:${SRC}:${Buffer.from('https://cdn.example/s1.srt').toString('base64url')}`
        const first = await app.request(`/api/media/netdisk-subtitle?key=tmdb:1:S01E01&track=${encodeURIComponent(track)}`)
        expect(first.status).toBe(200)
        expect((await first.text())).toContain('00:00:01.000 --> 00:00:02.000')
        expect(onFetch).toHaveBeenCalledWith('https://cdn.example/s1.srt')
        await app.request(`/api/media/netdisk-subtitle?key=tmdb:1:S01E01&track=${encodeURIComponent(track)}`)
        expect(onFetch).toHaveBeenCalledTimes(1) // cached
      })

      it('那个源的包已不在（关了 / 卸了）→ 404 subtitle_source_gone，不是静默空', async () => {
        const { executor, onFetch } = fakeExecutor(['@t/other/b-subtitle'])
        const app = build(undefined, { subtitleCacheDir: subCacheDir, netdisk: netdisk as never, providers: { executor } as never })
        const track = `scrape:${SRC}:${Buffer.from('https://cdn.example/s1.srt').toString('base64url')}`
        const res = await app.request(`/api/media/netdisk-subtitle?key=tmdb:1:S01E01&track=${encodeURIComponent(track)}`)
        expect(res.status).toBe(404)
        expect((await res.json() as { error: string }).error).toBe('subtitle_source_gone')
        expect(onFetch).not.toHaveBeenCalled()
      })
    })

    it('400s when track is missing or malformed', async () => {
      const app = build(undefined, {
        subtitleCacheDir: subCacheDir,
        netdisk: { lookup: () => ({ setId: 's1', dirPath: '/q', rightFile: 'e.mkv' }) } as never,
      })
      expect((await app.request('/api/media/netdisk-subtitle?key=tmdb:1:S01E01')).status).toBe(400)
      expect((await app.request('/api/media/netdisk-subtitle?key=tmdb:1:S01E01&track=bogus')).status).toBe(400)
    })
  })

  describe('netdisk audio extraction (debug endpoint)', () => {
    it('serves extracted audio bytes with the right content-type', async () => {
      vi.mocked(extractStream).mockResolvedValue({ bytes: Buffer.from('audio-bytes'), mime: 'audio/x-matroska' })
      vi.mocked(probeStreams).mockResolvedValue({ video: [], subtitle: [], audio: [{ index: 1, codec: 'aac' }] })
      const app = build(undefined, {
        netdisk: {
          lookup: () => ({ setId: 's1', dirPath: '/quark/show', rightFile: 'e1.mkv' }),
          rawUrl: async () => 'http://fake/e1.mkv',
        } as never,
      })
      const res = await app.request('/api/media/_debug/netdisk-audio?key=tmdb:1:S01E01')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('audio/x-matroska')
      expect(await res.text()).toBe('audio-bytes')
    })

    it('404s when there is no netdisk hit for the given key', async () => {
      const app = build(undefined, { netdisk: { lookup: () => undefined } as never })
      const res = await app.request('/api/media/_debug/netdisk-audio?key=unknown')
      expect(res.status).toBe(400)
    })
  })

  describe('events (notification center)', () => {
    const fakeEvents = () => {
      const reads: unknown[] = []
      return {
        reads,
        events: {
          list: (opts?: { since?: number; types?: string[] }) =>
            [{ id: 2, type: 'transcribe.done', at: 1, title: 'B', severity: 'info' },
             { id: 1, type: 'auth.needed', at: 0, title: 'A', severity: 'warn' }]
              .filter((e) => (opts?.since === undefined || e.id > opts.since) &&
                             (!opts?.types?.length || opts.types.includes(e.type))),
          markRead: (sel: unknown) => { reads.push(sel) },
        },
      }
    }

    it('GET /api/events returns the log; since + types filter', async () => {
      const app = build(undefined, { events: fakeEvents().events })
      const all = await (await app.request('/api/events')).json()
      expect(all.map((e: { id: number }) => e.id)).toEqual([2, 1])
      const since = await (await app.request('/api/events?since=1')).json()
      expect(since.map((e: { id: number }) => e.id)).toEqual([2])
      const typed = await (await app.request('/api/events?types=auth.needed')).json()
      expect(typed.map((e: { id: number }) => e.id)).toEqual([1])
    })

    it('POST /api/events/read forwards the selector', async () => {
      const f = fakeEvents()
      const app = build(undefined, { events: f.events })
      const r = await app.request('/api/events/read', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }),
      })
      expect(r.status).toBe(200)
      expect(f.reads).toEqual([{ all: true }])
    })

    it('routes absent without the dep', async () => {
      const r = await build().request('/api/events')
      expect(r.status).toBe(404)
    })
  })

  // 对话里一条引用要画成带封面的卡片，靠的就是这条路由。它**故意不进任何工具回执**：
  // 封面 URL 动辄几百字符（带签名），塞进 inbox_search 那类瘦身投影就是拿模型上下文换像素。
  describe('GET /api/items/refs', () => {
    async function refsOf(query: string) {
      const app = build()
      const res = await app.request(`/api/items/refs${query}`)
      return { status: res.status, body: await res.json() as { refs?: Record<string, Record<string, unknown>> } }
    }

    it('按 id 给出标题/来源/原文链接/封面', async () => {
      store.add({
        ...item('vid-1', 'my-tech'),
        title: '一条视频',
        url: 'https://example.com/v/1',
        content: { archetype: 'video', media: [{ kind: 'video', url: 'https://cdn/x.mp4', poster: 'https://cdn/cover.jpg' }] },
      } as never, 'post')
      const { status, body } = await refsOf('?ids=vid-1')
      expect(status).toBe(200)
      expect(body.refs!['vid-1']).toEqual({
        title: '一条视频', source: 'my-tech', url: 'https://example.com/v/1', poster: 'https://cdn/cover.jpg',
      })
    })

    // 引用可能指着一条已经被清掉的内容。那时前端该退回纯文字，而不是把整条消息渲染成错误
    // ——所以缺席由「键不在」表达，既不报错也不编一个空壳。
    it('查不到的 id 不进结果，也不报错', async () => {
      store.add(item('here', 'my-tech'), 'post')
      const { status, body } = await refsOf('?ids=here,gone')
      expect(status).toBe(200)
      expect(Object.keys(body.refs!)).toEqual(['here'])
    })

    it('空 ids / 没有 ids → 空结果，不是 400', async () => {
      expect((await refsOf('')).body.refs).toEqual({})
      expect((await refsOf('?ids=')).body.refs).toEqual({})
    })

    it('超过上限 → 400（这条路由按 id 直查，不设限等于开放任意长度批量读）', async () => {
      const { status } = await refsOf(`?ids=${Array.from({ length: 51 }, (_, i) => `i${i}`).join(',')}`)
      expect(status).toBe(400)
    })

    it('写错参数名不静默返回空（同 /api/items 的口径）', async () => {
      const { status } = await refsOf('?id=abc')
      expect(status).toBe(400)
    })
  })

  describe('POST /api/items/renormalize', () => {
    it('503 when the dep is absent', async () => {
      const app = build()
      const res = await app.request('/api/items/renormalize', { method: 'POST', body: '{}' })
      expect(res.status).toBe(503)
    })

    it('400 on unparseable JSON body', async () => {
      const app = build(undefined, { renormalizeItems: () => { throw new Error('unreachable') } })
      const res = await app.request('/api/items/renormalize', {
        method: 'POST', body: '{"streamId": "s1"',
      })
      expect(res.status).toBe(400)
    })

    it('400 when streamId has the wrong type', async () => {
      const app = build(undefined, { renormalizeItems: () => { throw new Error('unreachable') } })
      const res = await app.request('/api/items/renormalize', {
        method: 'POST', body: JSON.stringify({ streamId: 123 }),
      })
      expect(res.status).toBe(400)
    })

    it('200 on empty body, forwarding an empty filter', async () => {
      const calls: unknown[] = []
      const app = build(undefined, {
        renormalizeItems: (f: unknown) => {
          calls.push(f)
          return { scanned: 0, updated: 0, skipped: { noSourceId: 0, manifestGone: 0, parseError: 0 } }
        },
      })
      const res = await app.request('/api/items/renormalize', { method: 'POST', body: '' })
      expect(res.status).toBe(200)
      expect(calls).toEqual([{ streamId: undefined, sourceId: undefined }])
    })

    it('400 when streamId and sourceId are both present', async () => {
      const app = build(undefined, { renormalizeItems: () => { throw new Error('unreachable') } })
      const res = await app.request('/api/items/renormalize', {
        method: 'POST', body: JSON.stringify({ streamId: 's1', sourceId: 'hn' }),
      })
      expect(res.status).toBe(400)
    })

    it('404 when the scope does not exist', async () => {
      const { RenormalizeNotFoundError } = await import('../content/renormalize.ts')
      const app = build(undefined, {
        renormalizeItems: () => { throw new RenormalizeNotFoundError('stream', 'no stored items for stream nope') },
      })
      const res = await app.request('/api/items/renormalize', {
        method: 'POST', body: JSON.stringify({ streamId: 'nope' }),
      })
      expect(res.status).toBe(404)
    })

    it('200 with counts, forwarding the parsed filter', async () => {
      const calls: unknown[] = []
      const app = build(undefined, {
        renormalizeItems: (f: unknown) => {
          calls.push(f)
          return { scanned: 3, updated: 2, skipped: { noSourceId: 1, manifestGone: 0, parseError: 0 } }
        },
      })
      const res = await app.request('/api/items/renormalize', {
        method: 'POST', body: JSON.stringify({ streamId: 's1' }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ scanned: 3, updated: 2, skipped: { noSourceId: 1, manifestGone: 0, parseError: 0 } })
      expect(calls).toEqual([{ streamId: 's1', sourceId: undefined }])
    })
  })

  describe('/api/enrich 先查包交出来的处理器', () => {
    it('命中 → 整袋 query 交过去，返回值原样发', async () => {
      const enricher = vi.fn().mockResolvedValue({ ok: 1 })
      const app = build(undefined, { packageEnrichers: new Map([['x-comments', enricher]]) })
      const r = await app.request('/api/enrich?source=x-comments&vid=ID1&page=2')
      expect(r.status).toBe(200)
      expect(enricher).toHaveBeenCalledWith({ source: 'x-comments', vid: 'ID1', page: '2' })
      expect(await r.json()).toEqual({ ok: 1 })
    })
    it('处理器抛 ValidationError → 400', async () => {
      const app = build(undefined, { packageEnrichers: new Map([['x', async () => { throw new ValidationError('bad') }]]) })
      const r = await app.request('/api/enrich?source=x')
      expect(r.status).toBe(400)
      expect(await r.json()).toEqual({ error: { code: 'validation_error', message: 'bad' } })
    })
    // 用户层的包是自包含 bundle，带着自己那份 ValidationError 类——宿主拿 instanceof 判不出。
    // 这条用一个和宿主类无关、只带 validation:true 鸭子标记的错误钉住「宿主按鸭子判」。
    it('处理器抛另一份带 validation:true 标记的错误（跨 bundle）→ 仍 400', async () => {
      class ForeignValidationError extends Error { readonly validation = true as const }
      const thrown = new ForeignValidationError('bad params')
      expect(thrown).not.toBeInstanceOf(ValidationError)
      const app = build(undefined, { packageEnrichers: new Map([['x', async () => { throw thrown }]]) })
      const r = await app.request('/api/enrich?source=x')
      expect(r.status).toBe(400)
      expect(await r.json()).toEqual({ error: { code: 'validation_error', message: 'bad params' } })
    })
    it('处理器抛别的 → 502', async () => {
      const app = build(undefined, { packageEnrichers: new Map([['x', async () => { throw new Error('upstream') }]]) })
      expect((await app.request('/api/enrich?source=x')).status).toBe(502)
    })
    it('没命中 → 照旧走宿主自己的分支', async () => {
      const app = build(undefined, { packageEnrichers: new Map() })
      expect((await app.request('/api/enrich?source=nonsense')).status).toBe(400)
    })
    it('没配包表（packageEnrichers 缺席）→ 宿主分支照常', async () => {
      expect((await build().request('/api/enrich?source=nonsense')).status).toBe(400)
    })
  })

})






