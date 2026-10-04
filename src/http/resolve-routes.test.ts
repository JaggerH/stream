import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registerResolveRoutes } from './resolve-routes.ts'
import { Registry } from '../registry/registry.ts'
import { sealManifests } from '../registry/seal.ts'
import { ResolveEngine } from '../resolve/engine.ts'
import { IntentResolver, DEFAULT_RULES } from '../resolve/intent.ts'
import { RadarMatcher } from '../resolve/radar.ts'
import { SourceHealthStore } from '../source-health-store.ts'
import type { Adapter } from '../adapters/types.ts'
import type { SourceManifest } from '../manifest/types.ts'
import type { Stream } from '../streams/types.ts'

function mk(id: string, provides: string[], priority = 1, opts?: Partial<SourceManifest>): SourceManifest {
  return {
    schema_version: 1, id, adapter: 'fake', type: 'post', description: id,
    topics: [], example_queries: [], capabilities: ['timeline'],
    auth: { type: 'none' }, params_schema: {}, cadence_hint_seconds: 1800, discoverable: true,
    provides, priority, key_param: 'url',
    ...opts,
  }
}
const fake: Adapter = { id: 'fake', init: async () => {}, fetch: async () => [{ ok: 1 }] }

function stream(id: string, sources: Array<{ source_id: string; params: Record<string, unknown> }>, opts?: Partial<Stream>): Stream {
  return {
    id, description: id, sources, cadence_seconds: 3600, vault_subdir: id,
    ...opts,
  }
}

describe('resolve routes', () => {
  let dir: string, app: Hono
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rr-'))
    const registry = new Registry(sealManifests(
      [mk('browser-page', ['generic-url'], 99), mk('rsshub-xhs', ['xhs-author'], 1, { radar: [{ source: ['xiaohongshu.com/user/profile/:user_id'] }], params_schema: { user_id: { required: true } } })],
      [{ id: 'fake', name: 'Fake Plugin' }]
    ))
    const health = new SourceHealthStore(join(dir, 'h.json'))
    app = new Hono()
    registerResolveRoutes(app, {
      registry,
      resolveEngine: new ResolveEngine({ registry, adapters: new Map([['fake', fake]]), health, resolveCreds: async () => ({}), buildParams: (_m, key) => ({ url: key }) }),
      intentResolver: new IntentResolver(registry, DEFAULT_RULES),
      radarMatcher: new RadarMatcher(registry),
      sourceHealth: health,
      streams: () => [],
    })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('GET /api/radar resolves a URL to candidate sources via radar', async () => {
    const r = await app.request('/api/radar?input=https://www.xiaohongshu.com/user/profile/peng')
    expect(r.status).toBe(200)
    const body = await r.json()
    const m = body.matches.find((x: any) => x.sourceId === 'rsshub-xhs')
    expect(m).toBeDefined()
    expect(m.params).toEqual({ user_id: 'peng' })

    const rErr = await app.request('/api/radar')
    expect(rErr.status).toBe(400)
    expect(await rErr.json()).toEqual({ error: { code: 'validation_error', message: 'input required' } })
  })

  it('GET /api/sources lists providers with health', async () => {
    const r = await app.request('/api/resolve/sources?targetType=generic-url')
    const list = await r.json()
    expect(list[0]).toMatchObject({ id: 'browser-page', health: 'healthy', priority: 99 })
  })

  it('GET /api/resolve/sources carries display fields from the sealed manifest', async () => {
    const r = await app.request('/api/resolve/sources?targetType=generic-url')
    const list = await r.json()
    expect(list[0]).toMatchObject({
      id: 'browser-page', title: 'browser-page',
      pluginId: 'fake', pluginName: 'Fake Plugin',
      health: 'healthy', priority: 99, provides: ['generic-url'],
    })
  })

  it('GET /api/resolve/targets: stream sources carry display fields; unknown ids get a fallback', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'rr2-'))
    try {
      const registry2 = new Registry(sealManifests([mk('rsshub-xhs', ['xhs-author'], 1)], [{ id: 'fake', name: 'Fake Plugin' }]))
      const health2 = new SourceHealthStore(join(dir2, 'h.json'))
      const app2 = new Hono()
      registerResolveRoutes(app2, {
        registry: registry2,
        resolveEngine: new ResolveEngine({ registry: registry2, adapters: new Map([['fake', fake]]), health: health2, resolveCreds: async () => ({}), buildParams: (_m, key) => ({ url: key }) }),
        intentResolver: new IntentResolver(registry2, DEFAULT_RULES),
        radarMatcher: new RadarMatcher(registry2),
        sourceHealth: health2,
        streams: () => [stream('s1', [{ source_id: 'rsshub-xhs', params: {} }, { source_id: 'ghost', params: {} }])],
      })
      const targets = await (await app2.request('/api/resolve/targets')).json()
      const all = targets[0].resolvers.flatMap((r: any) => r.sources)
      const known = all.find((s: any) => s.id === 'rsshub-xhs')
      const orphan = all.find((s: any) => s.id === 'ghost')
      expect(known).toMatchObject({ title: 'rsshub-xhs', pluginName: 'Fake Plugin' })
      expect(orphan).toMatchObject({ id: 'ghost', title: 'ghost', pluginId: 'custom', pluginName: 'custom' })
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })

  it('GET /api/resolve/sources surfaces the Provider row ladder (matches-catalog sources without provides)', async () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'rr3-'))
    try {
      // catalog download sources declare no `provides` — reachable only via the Provider row's members
      const registry3 = new Registry(sealManifests([mk('zuna-dl', [], 1), mk('toubiec-dl', [], 2)], [{ id: 'fake', name: 'Fake Plugin' }]))
      const health3 = new SourceHealthStore(join(dir3, 'h.json'))
      const engine3 = new ResolveEngine({
        registry: registry3, adapters: new Map([['fake', fake]]), health: health3,
        resolveCreds: async () => ({}), buildParams: (_m, key) => ({ url: key }),
        providerRows: {
          order: (tt) => (tt === 'netease-track' ? [{ name: 'zuna-dl', params: { id: '$input' } }, { name: 'toubiec-dl' }] : null),
          count: () => {},
        },
      })
      const app3 = new Hono()
      registerResolveRoutes(app3, {
        registry: registry3, resolveEngine: engine3,
        intentResolver: new IntentResolver(registry3, DEFAULT_RULES, (tt) => engine3.resolveLadder(tt).map((m) => m.id)),
        radarMatcher: new RadarMatcher(registry3),
        sourceHealth: health3, streams: () => [],
      })
      const list = await (await app3.request('/api/resolve/sources?targetType=netease-track')).json()
      expect(list.map((x: any) => x.id)).toEqual(['zuna-dl', 'toubiec-dl'])
      // (the targetType→ladder classifier is covered by intent.test.ts; radar 现在是 /api/radar，别和意图跟踪的 /api/intents 混）
    } finally {
      rmSync(dir3, { recursive: true, force: true })
    }
  })

  it('GET /api/resolutions resolves a Target via the ladder', async () => {
    // via input query param
    const r = await app.request('/api/resolutions?input=https://example.com/x')
    const body = await r.json()
    expect(body.targetType).toBe('generic-url')
    expect(body.result.source).toBe('browser-page')

    // via type + key query params
    const r2 = await app.request('/api/resolutions?type=generic-url&key=https://example.com/x')
    const body2 = await r2.json()
    expect(body2.targetType).toBe('generic-url')
    expect(body2.result.source).toBe('browser-page')

    // validation error
    const rErr = await app.request('/api/resolutions')
    expect(rErr.status).toBe(400)
    expect(await rErr.json()).toEqual({ error: { code: 'validation_error', message: 'type and key, or input required' } })
  })

  describe('GET /api/resolutions?type=lyrics —— 缓存住在调用方', () => {
    const entry = { matched: true, songId: '1', lrc: '[00:00.00]x' }
    const makeCache = () => {
      const store = new Map<string, typeof entry>()
      return { store, getLyricsCache: (k: string) => store.get(k) ?? null, putLyricsCache: (k: string, v: typeof entry) => { store.set(k, v) } }
    }
    const baseDeps = () => {
      const registry = new Registry(sealManifests([mk('browser-page', ['generic-url'], 99)], [{ id: 'fake', name: 'Fake Plugin' }]))
      const health = new SourceHealthStore(join(dir, 'lyrics-h.json'))
      return {
        registry,
        resolveEngine: new ResolveEngine({ registry, adapters: new Map([['fake', fake]]), health, resolveCreds: async () => ({}), buildParams: (_m: unknown, key: string) => ({ url: key }) }),
        intentResolver: new IntentResolver(registry, DEFAULT_RULES),
        radarMatcher: new RadarMatcher(registry),
        sourceHealth: health,
        streams: () => [] as Stream[],
      }
    }

    it('命中缓存 → 不跑梯子，回执与正常解析同形', async () => {
      const cache = makeCache()
      cache.store.set('pkg:1', entry)
      let ran = false
      const app2 = new Hono()
      registerResolveRoutes(app2, { ...baseDeps(), lyricsCache: cache, resolveEngine: { resolve: async () => { ran = true; return null } } as never })
      const r = await app2.request('/api/resolutions?type=lyrics&key=pkg%3A1')
      expect(ran).toBe(false)
      expect(await r.json()).toEqual({ targetType: 'lyrics', key: 'pkg:1', result: { source: 'lyrics-cache', items: [entry] } })
    })

    it('未命中 → 跑梯子并把结果写进缓存', async () => {
      const cache = makeCache()
      const app2 = new Hono()
      registerResolveRoutes(app2, { ...baseDeps(), lyricsCache: cache, resolveEngine: { resolve: async () => ({ source: 's', items: [entry] }) } as never })
      await app2.request('/api/resolutions?type=lyrics&key=pkg%3A1')
      expect(cache.store.get('pkg:1')).toEqual(entry)
    })

    it('梯子一条都没答上（result=null）→ 不写缓存（那是"没配源"，不是"这首歌没歌词"）', async () => {
      const cache = makeCache()
      const app2 = new Hono()
      registerResolveRoutes(app2, { ...baseDeps(), lyricsCache: cache, resolveEngine: { resolve: async () => null } as never })
      await app2.request('/api/resolutions?type=lyrics&key=pkg%3A1')
      expect(cache.store.size).toBe(0)
    })

    it('非 lyrics 的 targetType 完全不碰缓存', async () => {
      const cache = makeCache()
      const app2 = new Hono()
      registerResolveRoutes(app2, { ...baseDeps(), lyricsCache: cache, resolveEngine: { resolve: async () => ({ source: 's', items: [1] }) } as never })
      await app2.request('/api/resolutions?type=other&key=k')
      expect(cache.store.size).toBe(0)
    })
  })

  it('old POST routes are 404', async () => {
    const r1 = await app.request('/api/resolve/intent', { method: 'POST', body: JSON.stringify({ input: 'https://example.com' }), headers: { 'content-type': 'application/json' } })
    expect(r1.status).toBe(404)
    const r2 = await app.request('/api/resolve/once', { method: 'POST', body: JSON.stringify({ input: 'https://example.com' }), headers: { 'content-type': 'application/json' } })
    expect(r2.status).toBe(404)
  })

  it('GET /api/resolve/targets expands streams into provider chains', async () => {
    const app2 = new Hono()
    const dir2 = mkdtempSync(join(tmpdir(), 'rr2-'))
    const registry2 = new Registry([
      mk('xhs-user', ['xhs-author'], 1, { key_param: 'user_id' }),
      mk('lizhi-user', ['podcast-timeline'], 1, { key_param: 'id' }),
      mk('xy-podcast', ['podcast-timeline'], 2, { key_param: 'id' }),
      mk('163-playlist', [], 1, { key_param: 'id' }),
    ])
    const health2 = new SourceHealthStore(join(dir2, 'h.json'))
    registerResolveRoutes(app2, {
      registry: registry2,
      resolveEngine: new ResolveEngine({ registry: registry2, adapters: new Map([['fake', fake]]), health: health2, resolveCreds: async () => ({}), buildParams: (_m, key) => ({ url: key }) }),
      intentResolver: new IntentResolver(registry2, DEFAULT_RULES),
      radarMatcher: new RadarMatcher(registry2),
      sourceHealth: health2,
      streams: () => [
        stream('yile', [
          { source_id: 'lizhi-user', params: { id: '251381' } },
          { source_id: 'xy-podcast', params: { id: '5e80c' } },
        ], { strategy: 'exclusive' }),
        stream('163-pl', [
          { source_id: '163-playlist', params: { id: '60168357' } },
        ]),
      ],
    })
    try {
      const r = await app2.request('/api/resolve/targets')
      const list = await r.json()
      expect(r.status).toBe(200)

      // failover stream: both sources in one provider group
      const yile = list.find((t: any) => t.id === 'yile')
      expect(yile).toBeDefined()
      expect(yile.targetType).toBe('podcast-timeline')
      expect(yile.key).toBe('251381')
      expect(yile.resolvers).toHaveLength(1)
      const yp = yile.resolvers[0]
      expect(yp.id).toBe('podcast-timeline')
      expect(yp.sources).toHaveLength(2)
      // lizhi-user first → active in failover
      expect(yp.sources[0]).toMatchObject({ id: 'lizhi-user', active: true })
      expect(yp.sources[1]).toMatchObject({ id: 'xy-podcast', active: false })

      // single-source stream (no provides → solo provider)
      const pl = list.find((t: any) => t.id === '163-pl')
      expect(pl).toBeDefined()
      expect(pl.key).toBe('60168357')
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })
})
