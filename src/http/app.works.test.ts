// 从 app.test.ts 的 describe('HTTP API') 里拆出(2026-07-22):按路由域分文件,
// 理由见 __fixtures__/app-harness.ts 头注。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { createHttpApp, type HealthInfo } from './app.ts'
import { StreamService } from '../mcp/tools.ts'
import { Registry } from '../registry/registry.ts'
import { Scheduler } from '../scheduler.ts'
import { CollectionsStore, SYSTEM_COLLECTIONS } from '../collections/store.ts'
import { StreamSeenStore } from '../stream-seen-store.ts'
import type { Stream } from '../streams/types.ts'
import { UserStore } from '../store/user-store.ts'
import { streamToStreamRecord } from '../store/compat.ts'
import { ProviderStatsStore } from '../providers/stats-store.ts'
import { ProviderExecutor, sourceOf } from '../providers/executor.ts'
import { ProviderDirectory } from '../providers/directory.ts'
import { SYSTEM_IDENTITIES } from '../providers/system/index.ts'
import { ensureSystemRows } from '../providers/seed.ts'
import { DedupStore } from '../dedup-store.ts'
import { ItemStore } from '../item-store.ts'
import { createHttpApiFixture, fake, health, item, manifests, mk, stream, type HttpApiFixture } from './__fixtures__/app-harness.ts'
import { WatchProgressStore } from '../watch-progress-store.ts'
import type { ProviderBindings } from '../providers/bindings.ts'
import { setLinkDeclarationSource } from '../links/recognize.ts'

let fixture: HttpApiFixture
let dir: string, dedup: DedupStore, store: ItemStore, build: HttpApiFixture['build']
// 每个 beforeEach 换一份新夹具;build 闭包绑的就是这一轮的 dir/store,所以从 app.test.ts
// 搬过来的测试体保持原样(裸 dir/store/dedup/build),一个引用都不用改写。
beforeEach(() => { fixture = createHttpApiFixture(); ({ dir, dedup, store, build } = fixture) })
// 曲目 URL 的文法住在包声明里（`stream.trackUrl`），由 sources 域装进 track-url 的表——HTTP 层
// 测试不经那个域，所以要用它的条目就得自己注入一条，并在这里复位（它是模块级的全局）。
afterEach(() => { fixture.close(); setLinkDeclarationSource(() => []) })

describe('GET /api/video/works/:key — 统一作品详情(收敛三端点,2026-07-20 §10)', () => {
  const mkVideoDetails = (calls?: Array<{ force?: boolean }>) => ({
    get: async (identity: unknown, opts: { force?: boolean } = {}) => {
      calls?.push(opts)
      return { cache: opts.force ? 'refreshed' as const : 'hit' as const, detail: { cacheKey: 'k', identity, images: {}, imageCandidates: [], failures: [], fetchedAt: 't', expiresAt: 'u' } }
    },
  })

  it('stream:<id> — 回带 episodes + stream 元信息 + binding(非 work),refresh 走 force,未找到 404', async () => {
    const channelStore = new UserStore(join(dir, 'works-stream.db'))
    channelStore.putStream({ id: 'wv-1', label: 'Example Film', strategy: 'fanout', cadence_seconds: 3600, members: [], options: {} })
    channelStore.putChannel({ id: 'video', label: '影视', present: 'video', stream_ids: ['wv-1'], options: {} })
    store.add({ ...item('wv-ep', 'wv-1') } as any, 'post')
    const calls: Array<{ force?: boolean }> = []
    const app = build(undefined, { channelStore, videoDetails: mkVideoDetails(calls) as never })

    const read = await app.request('/api/video/works/stream:wv-1')
    expect(read.status).toBe(200)
    const body = await read.json()
    expect(body.binding).toBeDefined()
    expect(body.work).toBeUndefined()
    expect(body.stream).toEqual({ id: 'wv-1', label: 'Example Film' })
    expect(Array.isArray(body.episodes)).toBe(true)

    const refresh = await app.request('/api/video/works/stream:wv-1/refresh', { method: 'POST' })
    expect(refresh.status).toBe(200)
    expect(calls).toEqual([{ force: false }, { force: true }])
    expect((await app.request('/api/video/works/stream:nope')).status).toBe(404)
    channelStore.close()
  })

  it('item:<id> — 身份来自条目,binding 出(非 work),未找到 404', async () => {
    store.add({ ...item('wv-film', 'video-tmdb-movie'), title: '挽救计划', url: 'https://www.themoviedb.org/movie/687163', content: { title: '挽救计划', meta: { year: '2026' } } } as any, 'post')
    const app = build(undefined, { videoDetails: mkVideoDetails() as never })
    const res = await app.request('/api/video/works/item:wv-film')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.binding).toBeDefined()
    expect(body.work).toBeUndefined()
    expect(body.item.id).toBe('wv-film')
    expect((await app.request('/api/video/works/item:nope')).status).toBe(404)
  })

  it('tmdb:<media>:<id> — canonical 快速路径,只喂 title/kind/tmdb', async () => {
    const captured: unknown[] = []
    const videoDetails = { get: async (identity: unknown, _opts: { force?: boolean } = {}) => {
      captured.push(identity)
      return { cache: 'miss' as const, detail: { cacheKey: 'x', identity, images: {}, imageCandidates: [], failures: [], fetchedAt: 't', expiresAt: 'u' } }
    } }
    const app = build(undefined, { videoDetails: videoDetails as never })
    const res = await app.request('/api/video/works/tmdb:movie:1368337?title=' + encodeURIComponent('奥德赛'))
    expect(res.status).toBe(200)
    expect(captured).toEqual([{ title: '奥德赛', kind: 'movie', externalIds: { tmdb: '1368337' } }])
    expect((await res.json()).binding).toBeDefined()
  })

  it('未知 key 前缀 / 非法 tmdb media → 400,未配置 → 503', async () => {
    const app = build(undefined, { videoDetails: mkVideoDetails() as never })
    expect((await app.request('/api/video/works/bogus:1')).status).toBe(400)
    expect((await app.request('/api/video/works/tmdb:season:1')).status).toBe(400)
    expect((await build().request('/api/video/works/tmdb:movie:1')).status).toBe(503)
  })
})

it('an unbound tv work lazy-loads the projected episode index once (with stills), then serves from cache', async () => {
  let cached: { fetchedAt: string; entries: Array<{ leftKey: string; title: string; still?: string }> } | undefined
  const videoDetails = {
    get: async (identity: unknown) => ({
      cache: 'hit' as const,
      detail: { cacheKey: 'tmdb:1399', identity, canonical: { status: 'resolved' as const, provider: 'video-canonical', member: 'm', source: 'tmdb', externalIds: { tmdb: '1399' }, kind: 'series' as const, title: '权力的游戏' }, images: {}, imageCandidates: [], failures: [], fetchedAt: 't', expiresAt: 'u', episodeIndex: cached },
    }),
    cacheEpisodeIndex: (_detail: unknown, entries: Array<{ leftKey: string; title: string; still?: string }>) => { cached = { fetchedAt: 'now', entries } },
  }
  let indexCalls = 0
  store.add({ ...item('got2', 'video-tmdb-tv'), title: '权力的游戏', url: 'https://www.themoviedb.org/tv/1399' } as any, 'post')
  const app = build(undefined, {
    videoDetails: videoDetails as never,
    episodeIndex: async () => { indexCalls++; return [{ leftKey: 'tmdb:1399:S01E01', title: 'S1E1', still: 'https://image.tmdb.org/t/p/w300/e1.jpg' }] },
    netdisk: { bindingForTmdb: () => undefined } as never,
  })

  const first = await app.request('/api/video/works/item:got2')
  expect((await first.json()).seasons).toEqual([{ season: 1, episodes: [{ season: 1, episode: 1, title: 'S1E1', leftKey: 'tmdb:1399:S01E01', still: 'https://image.tmdb.org/t/p/w300/e1.jpg', playable: false }] }])
  const second = await app.request('/api/video/works/item:got2')
  expect((await second.json()).seasons?.[0].episodes.length).toBe(1)
  expect(indexCalls).toBe(1) // 第二次命中缓存,不重抓
})

it('a bound tv work: tree + stills come from the TMDb index, playability overlaid from binding entries', async () => {
  const videoDetails = {
    get: async (identity: unknown) => ({
      cache: 'hit' as const,
      detail: { cacheKey: 'tmdb:1399', identity, canonical: { status: 'resolved' as const, provider: 'video-canonical', member: 'm', source: 'tmdb', externalIds: { tmdb: '1399' }, kind: 'series' as const, title: '权力的游戏' }, images: {}, imageCandidates: [], failures: [], fetchedAt: 't', expiresAt: 'u' },
    }),
    cacheEpisodeIndex: () => {},
  }
  store.add({ ...item('got3', 'video-tmdb-tv'), title: '权力的游戏', url: 'https://www.themoviedb.org/tv/1399' } as any, 'post')
  const app = build(undefined, {
    videoDetails: videoDetails as never,
    episodeIndex: async () => [
      { leftKey: 'tmdb:1399:S01E01', title: '凛冬将至', still: 'https://image.tmdb.org/t/p/w300/e1.jpg' },
      { leftKey: 'tmdb:1399:S01E02', title: '国王大道', still: 'https://image.tmdb.org/t/p/w300/e2.jpg' },
    ],
    netdisk: {
      browseUrl: async () => null,
      // 只有 S01E02 配上了文件 → 只有它 playable；两集都来自索引、都带剧照。
      bindingForTmdb: () => ({ id: 'map1', right: { path: '/quark/x' }, entries: [
        { leftKey: 'tmdb:1399:S01E02', leftTitle: '国王大道', rightFile: 'e2.mkv', status: 'auto' },
      ] }),
    } as never,
  })

  const res = await app.request('/api/video/works/item:got3')
  expect((await res.json()).seasons).toEqual([{ season: 1, episodes: [
    { season: 1, episode: 1, title: '凛冬将至', leftKey: 'tmdb:1399:S01E01', still: 'https://image.tmdb.org/t/p/w300/e1.jpg', playable: false },
    { season: 1, episode: 2, title: '国王大道', leftKey: 'tmdb:1399:S01E02', still: 'https://image.tmdb.org/t/p/w300/e2.jpg', playable: true },
  ] }])
})

it('projects cached detail onto a video ranking row without invoking enrichment', async () => {
  const channelStore = new UserStore(join(dir, 'ranking-channel.db'))
  channelStore.putStream({ id: 'video-douban-weekly', label: '豆瓣 · 一周口碑榜', strategy: 'fanout', cadence_seconds: 3600, members: [], options: {} })
  channelStore.putChannel({ id: 'video', label: '影视', present: 'video', stream_ids: ['video-douban-weekly'], options: {} })
  store.add({ ...item('douban-film', 'video-douban-weekly'), title: '某种物质', url: 'https://movie.douban.com/subject/35575567/', content: { meta: { year: '2024', source: 'douban' } } } as any, 'post')
  const get = vi.fn()
  const app = build(undefined, {
    channelStore,
    videoDetails: {
      get,
      peek: () => ({ cacheKey: 'movie:某种物质:2024', identity: { title: '某种物质', year: 2024, kind: 'movie', externalIds: {} }, metadata: { source: 'tmdb-metadata', title: 'The Substance', year: 2024, ratings: [{ source: 'tmdb', value: 7.2, scale: 10 }], externalIds: {} }, images: { poster: { kind: 'poster', url: 'https://image.tmdb.org/p.jpg', source: 'tmdb-images' }, backdrop: { kind: 'backdrop', url: 'https://image.tmdb.org/b.jpg', source: 'tmdb-images' } }, imageCandidates: [], failures: [], fetchedAt: 't', expiresAt: 'u' }),
    } as never,
  })

  const response = await app.request('/api/items?stream=video-douban-weekly')

  expect((await response.json()).find((row: any) => row.id === 'douban-film').videoDetail).toEqual({ title: 'The Substance', year: 2024, rating: 7.2, poster: 'https://image.tmdb.org/p.jpg', backdrop: 'https://image.tmdb.org/b.jpg' })
  expect(get).not.toHaveBeenCalled()
  channelStore.close()
})

it('reads and writes video Source settings without exposing API keys', async () => {
  const calls: unknown[] = []
  const app = build(undefined, {
    videoSources: {
      status: () => ({ hasTmdbApiKey: true, hasOmdbApiKey: false, language: 'zh-CN' }),
      set: async (next) => { calls.push(next); return { hasTmdbApiKey: true, hasOmdbApiKey: true, language: next.language ?? 'zh-CN' } },
    },
  })
  const read = await app.request('/api/settings/video-sources')
  expect(await read.json()).toEqual({ hasTmdbApiKey: true, hasOmdbApiKey: false, language: 'zh-CN' })
  const write = await app.request('/api/settings/video-sources', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tmdbApiKey: 'hidden', omdbApiKey: 'also-hidden', language: 'en-US' }) })
  expect(await write.json()).toEqual({ hasTmdbApiKey: true, hasOmdbApiKey: true, language: 'en-US' })
  expect(calls).toEqual([{ tmdbApiKey: 'hidden', omdbApiKey: 'also-hidden', language: 'en-US' }])
})

it('reads and writes manifest-declared Source runtime config without exposing secrets', async () => {
  const writes: Array<{ ref: string; values: Record<string, unknown> }> = []
  const app = build(undefined, {
    sourceRuntimeConfig: {
      status: () => ({ values: { language: 'zh-CN' }, secrets: { apiKey: { configured: true } } }),
      set: async (ref, values) => { writes.push({ ref, values }) },
    },
  })
  const detail = await app.request('/api/plugins/fake/sources/bili')
  expect((await detail.json()).runtimeConfig).toMatchObject({ ref: 'tmdb', fields: { apiKey: { type: 'secret' } } })

  const status = await app.request('/api/source-runtime-config/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pluginId: 'fake', sourceId: 'bili' }) })
  // provisioner 恒在场（没有就是 null）：前端靠"这一格是不是 null"决定给不给那颗一键按钮，
  // 字段缺席和"没人能帮你"在 JS 里长得一样，但缺席意味着"后端根本没算过"——两者必须分得开。
  // envFallback 同理恒在场（兜不住就是空数组）：面板的必填判据要分得开"没有环境变量兜底"与"后端没算过"。
  expect(await status.json()).toEqual({ values: { language: 'zh-CN' }, secrets: { apiKey: { configured: true } }, provisioner: null, envFallback: [] })

  const write = await app.request('/api/source-runtime-config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pluginId: 'fake', sourceId: 'bili', values: { apiKey: 'never-returned', language: 'en-US' } }) })
  expect(write.status).toBe(200)
  expect(writes).toEqual([{ ref: 'tmdb', values: { apiKey: 'never-returned', language: 'en-US' } }])
})

it('perInstance 源的 key 按实例 ref 读写；非 perInstance / 非法 ref 一律拒', async () => {
  const writes: Array<{ ref: string; values: Record<string, unknown> }> = []
  const reads: string[] = []
  // 两个源:llm-inst 声明 perInstance,bili 是普通共享 ref 源。夹具的 registry 用于别处的
  // 源目录计数断言,所以这条只替换 service 的详情投影,不往共享 manifests 里塞源。
  const detail = (_pluginId: string, sourceId: string) =>
    sourceId === 'llm-inst'
      ? { runtimeConfig: { ref: 'llm-openai', perInstance: true, instanceNamespace: 'llm', fields: { apiKey: { type: 'secret', label: 'k' } } } }
      : sourceId === 'bili'
        ? { runtimeConfig: { ref: 'tmdb', fields: { apiKey: { type: 'secret', label: 'k' } } } }
        : undefined
  const app = build(undefined, {
    service: { pluginSourceDetail: detail, streamsResource: () => [] } as never,
    sourceRuntimeConfig: {
      status: (ref) => { reads.push(ref); return { values: {}, secrets: { apiKey: { configured: true } } } },
      set: async (ref, values) => { writes.push({ ref, values }) },
    },
  })
  const req = (path: string, method: string, body: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  // 写入落点 = 成员的 tokenName（完整 ref），不是 manifest 的 runtime_config.ref
  const write = await req('/api/source-runtime-config', 'PUT', { pluginId: 'fake', sourceId: 'llm-inst', ref: 'llm:kimi', values: { apiKey: 'sek' } })
  expect(write.status).toBe(200)
  expect(writes).toEqual([{ ref: 'llm:kimi', values: { apiKey: 'sek' } }])

  // status 同步：同一个实例 ref（PUT 自己也回读一次状态，所以这里是两条读记录）
  const status = await req('/api/source-runtime-config/status', 'POST', { pluginId: 'fake', sourceId: 'llm-inst', ref: 'llm:kimi' })
  expect(status.status).toBe(200)
  expect(reads).toEqual(['llm:kimi', 'llm:kimi'])

  // 非法 ref（任意写防护）：命名空间之外 / 带路径分隔 / 空实例名一律 400，且没有落盘
  for (const ref of ['tmdb', 'llm:', 'llm:a/b', '../llm:a', 'llm:a b', 'alist']) {
    const bad = await req('/api/source-runtime-config', 'PUT', { pluginId: 'fake', sourceId: 'llm-inst', ref, values: { apiKey: 'x' } })
    expect(bad.status, ref).toBe(400)
  }
  expect(writes).toHaveLength(1)

  // 非 perInstance 源不许带 ref——否则任何源都能改别人的 key。文案与"ref 格式不对"必须分开：
  // 一句话两用会让调用方拿着合法 ref 去查一个不存在的格式问题。
  const denied = await req('/api/source-runtime-config', 'PUT', { pluginId: 'fake', sourceId: 'bili', ref: 'llm:kimi', values: { apiKey: 'x' } })
  expect(denied.status).toBe(400)
  expect((await denied.json()).error).toContain('does not accept a ref')
  const badRef = await req('/api/source-runtime-config', 'PUT', { pluginId: 'fake', sourceId: 'llm-inst', ref: 'tmdb', values: { apiKey: 'x' } })
  expect((await badRef.json()).error).toContain('invalid instance ref')
  expect(writes).toHaveLength(1)
})

// 命名空间**按源声明**，不是写死一档：第二个 perInstance 源（视觉模型 OCR）用 `ocr:`，
// 而它绝不能拿 `llm:` 去写——不按源限定前缀，这个端点就等于"任意 ref 写入"，一个源能改掉
// 别的源（乃至 alist/tmdb）的 key。
it('每个 perInstance 源只认自己声明的命名空间，跨命名空间写入一律拒', async () => {
  const writes: Array<{ ref: string }> = []
  const detail = (_p: string, sourceId: string) =>
    sourceId === 'ocr-vlm'
      ? { runtimeConfig: { ref: 'ocr-vlm', perInstance: true, instanceNamespace: 'ocr', fields: { apiKey: { type: 'secret', label: 'k' } } } }
      : sourceId === 'no-ns' // manifest 漏声明命名空间 = 配置错，不能默默放行
        ? { runtimeConfig: { ref: 'x', perInstance: true, fields: { apiKey: { type: 'secret', label: 'k' } } } }
        : undefined
  const app = build(undefined, {
    service: { pluginSourceDetail: detail, streamsResource: () => [] } as never,
    sourceRuntimeConfig: {
      status: () => ({ values: {}, secrets: {} }),
      set: async (ref: string) => { writes.push({ ref }) },
    },
  })
  const put = (sourceId: string, ref: string) =>
    app.request('/api/source-runtime-config', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pluginId: 'builtin', sourceId, ref, values: { apiKey: 'sek' } }),
    })

  expect((await put('ocr-vlm', 'ocr:zhipu')).status).toBe(200)
  const crossNs = await put('ocr-vlm', 'llm:zhipu') // 借道别人的命名空间
  expect(crossNs.status).toBe(400)
  expect((await crossNs.json()).error).toContain('ocr:<instance>')
  expect((await put('no-ns', 'x:a')).status).toBe(400) // 漏声明 → 拒，不是放行
  expect(writes).toEqual([{ ref: 'ocr:zhipu' }])
})

// 自助申请那条链的 HTTP 面。三条各钉一件事，缺一条那颗按钮就有一种"点了没反馈"的形状。
describe('POST /api/source-runtime-config/provision', () => {
  const PROVISIONER = { sourceId: '@x/x/x-create-key', field: 'apiKey', entryUrl: 'https://x.test/keys', label: 'X', paramsSchema: { name: { type: 'string', required: true } } }
  const buildWith = (over: Partial<{ configuredAfter: boolean; provisioner: unknown; run: (ref: string, params: Record<string, unknown>) => Promise<void> }> = {}) => {
    const runs: Array<{ ref: string; params: Record<string, unknown> }> = []
    let configured = over.configuredAfter ?? true
    const app = build(undefined, {
      sourceRuntimeConfig: {
        status: () => ({ values: {}, secrets: { apiKey: { configured } } }),
        set: async () => {},
        provisioner: () => (over.provisioner === undefined ? PROVISIONER : over.provisioner) as never,
        provision: async (ref: string, params: Record<string, unknown>) => {
          if (over.run) return over.run(ref, params)
          runs.push({ ref, params })
          configured = over.configuredAfter ?? true
        },
      } as never,
    })
    return { app, runs }
  }
  const post = (app: ReturnType<typeof build>, body: unknown) =>
    app.request('/api/source-runtime-config/provision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('反查到的那条 recipe 跟着 status 一起回来——按钮的显隐就是这一格', async () => {
    const { app } = buildWith()
    const status = await app.request('/api/source-runtime-config/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pluginId: 'fake', sourceId: 'bili' }) })
    expect((await status.json()).provisioner).toEqual(PROVISIONER)
  })

  it('跑完那一格真的填上了 → 200 + 刷新过的 status（前端不必再打一发去问结果）', async () => {
    const { app, runs } = buildWith({ configuredAfter: true })
    const res = await post(app, { pluginId: 'fake', sourceId: 'bili', params: { name: 'stream-auto-7f3a' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ secrets: { apiKey: { configured: true } }, provisioner: PROVISIONER })
    // ref 由后端从这张卡的 manifest 解出来（tmdb），params 原样透传给 recipe。
    expect(runs).toEqual([{ ref: 'tmdb', params: { name: 'stream-auto-7f3a' } }])
  })

  it('跑完了没抛、但那一格还是空的 → 502 说人话，不报假成功', async () => {
    // 这条是整个端点存在的理由：这类 recipe `allowEmpty`、不产 item，成功和白跑在
    // runner 的回执里一字不差。照 preview 的 items 判，用户会拿着一格空 key 去查别处。
    const { app } = buildWith({ configuredAfter: false })
    const res = await post(app, { pluginId: 'fake', sourceId: 'bili' })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('failures/')
  })

  it('跑的时候抛了（登录墙 / 人机验证 / 站点改版）→ 502 带原文', async () => {
    const { app } = buildWith({ run: async () => { throw new Error('需要先登录 X') } })
    const res = await post(app, { pluginId: 'fake', sourceId: 'bili' })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('需要先登录 X')
  })

  it('这一格没人能帮忙 → 404，不是静默 200', async () => {
    const { app } = buildWith({ provisioner: null })
    const res = await post(app, { pluginId: 'fake', sourceId: 'bili' })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('no_provisioner')
  })
})

it('GET /api/ext/sync-config —— 只回该同步哪些域，不下发任何密钥', async () => {
  const app = build(undefined, {
    extSyncConfig: () => ({ requiredDomains: ['quark.cn'] }),
  })
  const res = await app.request('/api/ext/sync-config')
  expect(res.status).toBe(200)
  // requiredDomains 必须原样出去：扩展就靠它决定读哪些域的 cookie，路由把它吃掉 = 又回到
  // 「扩展自己猜一份清单」的老路，而漏一个域是静默的（表现和"用户没登录"一模一样）。
  const body = await res.json()
  expect(body).toEqual({ configured: true, requiredDomains: ['quark.cn'] })
  // 这个接口在另一种形状下曾经吐过整个 cookie 库的解密密钥明文。这条钉住"别把它加回来"。
  expect(JSON.stringify(body)).not.toContain('password')
})

it('GET /api/ext/sync-config reports not-configured when unwired', async () => {
  const res = await build(undefined, { extSyncConfig: undefined }).request('/api/ext/sync-config')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ configured: false })
})

it('GET /api/items merged + filtered', async () => {
  const app = build()
  expect((await (await app.request('/api/items')).json())).toHaveLength(2)
  const filtered = await (await app.request('/api/items?stream=my-tech')).json()
  expect(filtered.map((i: { id: string }) => i.id)).toEqual(['i1'])
})

it('all-latest (GET /api/items, no stream filter) excludes a collection stream — including one whose collection-ness comes ONLY from its member manifest, not an explicit stream.mode', async () => {
  // coll-src declares mode:'collection' on the MANIFEST; collStream itself carries no
  // options/mode at all — this is exactly the movie/video ranking-stream shape, where
  // collection-ness is derived solely via scheduler.modeOf()'s registry fallback. If the
  // timeline exclusion regressed to reading the raw (unresolved) stream.mode, this stream
  // would wrongly leak into the all-latest firehose.
  const registry = new Registry([...manifests, mk({ id: 'coll-src', mode: 'collection' })])
  const feedStream: Stream = { id: 'feed-s', description: 'feed', sources: [{ source_id: 'hn', params: {} }], cadence_seconds: 1800, vault_subdir: 'feed-s' }
  const collStream: Stream = { id: 'coll-s', description: 'coll', sources: [{ source_id: 'coll-src', params: {} }], cadence_seconds: 1800, vault_subdir: 'coll-s' }
  const scheduler = new Scheduler({ registry, streams: [feedStream, collStream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
  // manifest-driven, NOT stream-level — proves the authoritative modeOf() path, not the raw spread
  expect(collStream.mode).toBeUndefined()
  expect(scheduler.modeOf('coll-s')).toBe('collection')
  const service = new StreamService({ registry, scheduler, channels: new UserStore(join(dir, `stream-svc-${Math.random()}.db`)) })
  const app = createHttpApp({ service, itemStore: store, health })

  store.add(item('in-feed', 'feed-s'), 'post')
  store.add(item('in-coll', 'coll-s'), 'post')

  const items = (await (await app.request('/api/items')).json()) as Array<{ id: string }>
  const ids = items.map((it) => it.id)
  expect(ids).toContain('in-feed')
  expect(ids).not.toContain('in-coll')
})

it('POST /api/streams/:id/seen advances the watermark to the stream max seq', async () => {
  const seenStore = new StreamSeenStore(join(dir, 'seen.db'))
  const app = build(undefined, { seenStore })

  const res = await app.request('/api/streams/my-tech/seen', { method: 'POST' })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { stream_id: string; seen_seq: number }
  expect(body.seen_seq).toBe(store.maxSeq('my-tech'))
  expect(body.seen_seq).toBeGreaterThan(0)
  expect(seenStore.seenSeq('my-tech')).toBe(body.seen_seq)
})

it('GET /api/sources?q= runs the catalog candidate search', async () => {
  const res = await (await build().request('/api/sources?q=bilibili')).json()
  expect(res[0].id).toBe('bili')
  expect(res[0].adapter).toBe('fake')
})

it('GET /api/search validates scope', async () => {
  const bad = await build().request('/api/search?q=x')
  expect(bad.status).toBe(400)
  expect((await bad.json()).error.code).toBe('validation_error')
})

it('enrich umbrella validates its new sources; absorbed routes are gone', async () => {
  const app = build()
  // new umbrella branches — validation only (upstream calls are network-bound)
  // source=url 已退场（url/link 同义歧义）：现在它就是一个不认识的 source → 400
  expect((await app.request('/api/enrich?source=url')).status).toBe(400)
  expect((await app.request('/api/enrich?source=bilibili-owner')).status).toBe(400)
  expect((await app.request('/api/enrich?source=bilibili-user')).status).toBe(400)
  expect((await app.request('/api/enrich?source=nope')).status).toBe(400)
  // absorbed/deleted routes
  expect((await app.request('/api/fetch-url?url=https://x.com')).status).toBe(404)
  expect((await app.request('/api/bili/comments?bvid=BV1')).status).toBe(404)
  expect((await app.request('/api/bili/owner?bvid=BV1')).status).toBe(404)
  expect((await app.request('/api/bili/upinfo?uid=1')).status).toBe(404)
  expect((await app.request('/api/flows/pansou/channels')).status).toBe(404)
})

// 站点的详情现取全部归包（`packageEnrichers`，见 app.test.ts 那组）；宿主自己不再有按站名分叉的
// enrich 分支。一个不在包表里的站名落到 400，而不是被某条宿主分支静默接走。
it('a site-named enrich source with no package enricher is a 400, not a host branch', async () => {
  const res = await build(undefined, { packageEnrichers: new Map() }).request(
    '/api/enrich?source=xhs&noteId=n1&xsec_token=tok',
  )
  expect(res.status).toBe(400)
})

it('GET /api/plugins returns first-class plugin summaries', async () => {
  const res = await (await build().request('/api/plugins')).json()
  expect(res).toHaveLength(1)
  expect(res[0]).toMatchObject({
    id: 'fake',
    name: 'Fake Plugin',
    tagline: '测试插件副标题',
    description: '新闻和社交媒体测试源。',
    homepage: 'https://example.com',
    repository: 'https://example.com/repo',
    docsUrl: 'https://example.com/docs',
    sourceCount: 3,
    status: 'ready',
    launch: { mode: 'builtin' },
    sourceGrouping: { enabled: true, resolver: 'manifest.facility' },
    topCategories: [
      { key: 'social-media', label: 'social-media', count: 2 },
      { key: 'news', label: 'news', count: 1 },
    ],
  })
  expect(res[0].logo).toBeUndefined()
})

it('GET /api/plugins/:pluginId/sources returns lightweight source summaries', async () => {
  const res = await (await build().request('/api/plugins/fake/sources?query=dynamic')).json()
  expect(res.plugin.id).toBe('fake')
  expect(res.total).toBe(1)
  expect(res.sources[0]).toMatchObject({
    id: 'bili',
    pluginId: 'fake',
    adapterId: 'fake',
    title: 'bilibili dynamic',
    paramCount: 1,
    requiredParamCount: 1,
  })
  expect(res.sources[0].paramsSchema).toBeUndefined()
  expect(res.sources[0].docs).toBeUndefined()
  expect(res.groups).toContainEqual({ key: 'bilibili', label: '哔哩哔哩', count: 1 })
  expect(res.facets.categories).toContainEqual({ key: 'social-media', label: 'social-media', count: 1 })
})

it('GET /api/plugins/:pluginId/sources searches facility key and label', async () => {
  const byKey = await (await build().request('/api/plugins/fake/sources?query=bilibili')).json()
  expect(byKey.total).toBe(2)
  expect(byKey.groups).toContainEqual({ key: 'bilibili', label: '哔哩哔哩', count: 2 })

  const byLabel = await (await build().request('/api/plugins/fake/sources?query=%E5%93%94%E5%93%A9')).json()
  expect(byLabel.total).toBe(2)
  expect(byLabel.sources.map((s: { id: string }) => s.id).sort()).toEqual(['bili', 'bili-following'])
})

it('GET /api/plugins/:pluginId/sources exposes source groups, computed exactly', async () => {
  const res = await (await build().request('/api/plugins/fake/sources')).json()
  expect(res.total).toBe(3)
  expect(res.groups).toContainEqual({ key: 'bilibili', label: '哔哩哔哩', count: 2 })
  expect(res.groups).toContainEqual({ key: '', label: '未分类', count: 1 })
})

it('GET /api/plugins/:pluginId/sources filters by group before pagination', async () => {
  const res = await (await build().request('/api/plugins/fake/sources?group=bilibili')).json()
  expect(res.total).toBe(2)
  expect(res.sources.map((s: { id: string }) => s.id).sort()).toEqual(['bili', 'bili-following'])
  expect(res.groups).toContainEqual({ key: 'bilibili', label: '哔哩哔哩', count: 2 })
  expect(res.groups).toContainEqual({ key: '', label: '未分类', count: 1 })
})

it('GET /api/plugins/:pluginId/sources?group= (empty) returns the unclassified bucket', async () => {
  const res = await (await build().request('/api/plugins/fake/sources?group=')).json()
  expect(res.total).toBe(1)
  expect(res.sources[0].id).toBe('hn')
})

it('GET /api/plugins/:pluginId/sources/:sourceId returns source detail', async () => {
  const res = await (await build().request('/api/plugins/fake/sources/bili')).json()
  expect(res).toMatchObject({
    id: 'bili',
    pluginId: 'fake',
    paramsSchema: { uid: { type: 'string', required: true, description: '用户 id' } },
    docs: { markdown: '## 路由说明\nBilibili dynamic docs' },
  })
})

// music-search members are the RSSHub catalog search routes (zuna + toubiec). The fixture
// returns raw RSSHub feed items keyed by the source id; the fetchSource records the query so
// tests can assert $input reached the route params.
function musicProviders(perSource: Record<string, unknown[]>) {
  const channelStore = new UserStore(join(dir, `music-prov-${Math.random()}.db`))
  const stats = new ProviderStatsStore(join(dir, `music-stats-${Math.random()}.db`))
  const registry = new Registry([
    ...manifests,
    mk({ id: '@streamapp/toubiec/toubiec-search', adapter: 'replay', capabilities: ['search'] }),
    mk({ id: '@streamapp/zuna/zuna-search', adapter: 'replay', capabilities: ['search'] }),
  ])
  ensureSystemRows(channelStore)
  const calls: Array<{ sourceId: string; params?: Record<string, unknown> }> = []
  const executor = new ProviderExecutor({
    directory: new ProviderDirectory(channelStore, SYSTEM_IDENTITIES), registry, stats,
    fetchSource: async (sourceId, _input, params) => {
      calls.push({ sourceId, params })
      return perSource[sourceId] ?? []
    },
  })
  return { executor, stats, calls }
}

it('GET /api/search?scope=music maps recipe items to track shape and dedups by song id', async () => {
  setLinkDeclarationSource(() => [{ package: '@streamapp/netease', hosts: [], shortHosts: [], patterns: [{ kind: 'track', platform: 'netease', pattern: '^https?://music\\.163\\.com/(?:#/)?song\\?id=(?<id>\\d+)' }] }])
  const scheduler = new Scheduler({ registry: new Registry(manifests), streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
  const service = new StreamService({ registry: new Registry(manifests), scheduler, channels: new UserStore(join(dir, `stream-svc-${Math.random()}.db`)) })
  const { executor, stats, calls } = musicProviders({
    '@streamapp/toubiec/toubiec-search': [
      { title: '晴天 - 周杰伦', link: 'https://music.163.com/song?id=186016', author: '周杰伦', image: 'https://img/1.jpg', description: '歌手：周杰伦<br>专辑：叶惠美', _extra: { songId: 186016 } },
    ],
    '@streamapp/zuna/zuna-search': [
      // same song id from the other source → deduped away
      { title: '晴天 - 周杰伦', link: 'https://music.163.com/song?id=186016', author: '周杰伦', image: 'https://img/1b.jpg' },
      { title: '稻香 - 周杰伦', link: 'https://music.163.com/song?id=185868', author: '周杰伦', image: 'https://img/2.jpg', itunes_duration: '3:43', description: '专辑：魔杰座' },
    ],
  })
  const app = createHttpApp({ service, itemStore: store, health, providers: { executor, stats } })

  const res = await app.request('/api/search?scope=music&q=%E5%91%A8%E6%9D%B0%E4%BC%A6')
  expect(res.status).toBe(200)
  const body = await res.json()
  // 精确断言保留（多出意外字段要红）；timings 单独认领——它是每成员耗时，值随机器变，
  // 只锁「两个成员各有一条」这个结构。
  expect(body).toEqual({
    items: [
      { id: 'netease:186016', platform: 'netease', trackId: '186016', title: '晴天', artist: '周杰伦', album: '叶惠美', poster: 'https://img/1.jpg', sourceUrl: 'https://music.163.com/song?id=186016' },
      { id: 'netease:185868', platform: 'netease', trackId: '185868', title: '稻香', artist: '周杰伦', album: '魔杰座', poster: 'https://img/2.jpg', durationS: 223, sourceUrl: 'https://music.163.com/song?id=185868' },
    ],
    warnings: [],
    timings: expect.any(Array),
  })
  expect((body.timings as Array<{ source: string }>).map((t) => t.source).sort())
    .toEqual(['@streamapp/toubiec/toubiec-search', '@streamapp/zuna/zuna-search'])
  // both recipe sources ran with the query threaded into their keyword param ($input filled)
  expect(calls.map((c) => c.sourceId).sort()).toEqual(['@streamapp/toubiec/toubiec-search', '@streamapp/zuna/zuna-search'])
  expect(calls.find((c) => c.sourceId === '@streamapp/zuna/zuna-search')!.params).toEqual({ keyword: '周杰伦' })
  expect(stats.of('music-search').total).toBe(2) // 两个成员各打点一次
})

it('GET /api/search?scope=music returns {items:[]} for empty q and 503 without provider', async () => {
  const app = build()
  const scheduler = new Scheduler({ registry: new Registry(manifests), streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
  const service = new StreamService({ registry: new Registry(manifests), scheduler, channels: new UserStore(join(dir, `stream-svc-${Math.random()}.db`)) })
  const { executor, stats } = musicProviders({})
  const withMusic = createHttpApp({ service, itemStore: store, health, providers: { executor, stats } })
  expect(await (await withMusic.request('/api/search?scope=music')).json()).toEqual({ items: [] })
  expect((await app.request('/api/search?scope=music&q=hello')).status).toBe(503)
  // old paths are gone
  expect((await app.request('/api/music/search?q=x')).status).toBe(404)
  expect((await app.request('/api/content/search?q=x')).status).toBe(404)
  expect((await app.request('/api/video/search?q=x')).status).toBe(404)
  expect((await app.request('/api/video/search/stream?q=x')).status).toBe(404)
})

it('GET /api/search?scope=content fans out over search-content members and presents each item by its source', async () => {
  const channelStore = new UserStore(join(dir, `content-prov-${Math.random()}.db`))
  const stats = new ProviderStatsStore(join(dir, `content-stats-${Math.random()}.db`))
  // 两个 provides=search-content 的源：内容搜索行没有点名成员，谁申报了 provides 谁进扇出
  //（一家站的搜索源是随它的包来的，不是宿主行里写死的一条）。
  const registry = new Registry([
    ...manifests,
    mk({ id: 'douyin-search', provides: ['search-content'], capabilities: ['search'] }),
    mk({ id: 'other-search', provides: ['search-content'], capabilities: ['search'] }),
  ])
  ensureSystemRows(channelStore)
  const seen: Array<{ sourceId: string; params?: Record<string, unknown> }> = []
  const executor = new ProviderExecutor({
    directory: new ProviderDirectory(channelStore, SYSTEM_IDENTITIES), registry, stats,
    fetchSource: async (sourceId, _input, params) => {
      seen.push({ sourceId, params })
      return sourceId === 'douyin-search' ? [{ title: 'camping note', link: 'https://d/1' }] : []
    },
  })
  const scheduler = new Scheduler({ registry, streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
  const service = new StreamService({ registry, scheduler, channels: channelStore })
  // normalize stub echoes the producing source, proving provenance reached the call site per-item
  const app = createHttpApp({
    service, itemStore: store, health, providers: { executor, stats },
    normalizeSearchItem: (sourceId, raw) => ({ ...(raw as object), normalizedBy: sourceId, type: 'post', raw: { archived: 'payload' } } as any),
  })
  const res = await app.request('/api/search?scope=content&q=camping')
  expect(res.status).toBe(200)
  const body = await res.json()
  // fanned out to every provides=search-content source (the row's only member is the auto segment),
  // each with the row's params and $input filled.
  expect(seen).toEqual([
    { sourceId: 'douyin-search', params: { mode: 'search', keyword: 'camping', count: 20 } },
    { sourceId: 'other-search', params: { mode: 'search', keyword: 'camping', count: 20 } },
  ])
  // each item presented via ITS source (provenance-driven), not returned raw
  expect(body.items).toEqual([{ title: 'camping note', link: 'https://d/1', normalizedBy: 'douyin-search', type: 'post' }])
  for (const it of body.items) expect('raw' in it).toBe(false)
  channelStore.close()
  stats.close()
})

// 纯接线测：facetResources 被桩掉了，这条只钉 http/app.ts 的 resourceProviderId 透传本身
// （槽位覆盖时传给 invoke 的行 id 和传给 facetResources 的行 id 必须是同一个），不覆盖
// "拿到 providerId 之后映射对不对"——那部分由 search/seeds.test.ts 的 missTimings 测试
// （真 UserStore + 真 ProviderExecutor + 真 miss，不桩任何一环）单独钉住。
it('接线：search.resources 被槽位覆盖时,app.ts 传给 facetResources 的 providerId 与传给 invoke 的是同一个覆盖行', async () => {
  const channelStore = new UserStore(join(dir, `res-prov-alt-${Math.random()}.db`))
  const stats = new ProviderStatsStore(join(dir, `res-stats-alt-${Math.random()}.db`))
  const registry = new Registry([...manifests, mk({ id: 'pansou-search', provides: ['search-download'], capabilities: ['search'] })])
  ensureSystemRows(channelStore)
  // 覆盖行：不是默认的 resource-search，member 带自己的成员表——只要 providerId 传对了，
  // executor 就该按这一行（而不是默认行）扇出。
  channelStore.putProvider({
    id: 'resource-search-alt', label: '资源搜索（覆盖）', description: '', category: 'search', serves: ['resources'],
    strategy: 'concurrent', members: [{ source: 'pansou-search', params: { keyword: '$input' } }],
    contract: null, options: {}, system: false,
  })
  const executor = new ProviderExecutor({
    directory: new ProviderDirectory(channelStore, SYSTEM_IDENTITIES), registry, stats,
    fetchSource: async (sourceId) => (sourceId === 'pansou-search' ? [{ title: 'alt' }] : []),
  })
  const scheduler = new Scheduler({ registry, streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
  const service = new StreamService({ registry, scheduler, channels: channelStore })
  let seenProviderId: string | undefined
  const app = createHttpApp({
    service, itemStore: store, health, providers: { executor, stats },
    // 槽位覆盖的桩：不建一整套真实 UserStore 槽位/频道数据——只要 fixed('search.resources', …)
    // 返回覆盖行 id，就足以钉住 app.ts 那条"同一个 providerId 既喂 invoke 又喂 facetResources"的线。
    providerBindings: { fixed: (callsiteId: string) => (callsiteId === 'search.resources' ? 'resource-search-alt' : null) } as unknown as ProviderBindings,
    facetResources: (_q, _items, _misses, providerId) => {
      seenProviderId = providerId
      return { shows: [], loose: [], sources: [] }
    },
  })
  const res = await app.request('/api/search?scope=resources&q=show')
  expect(res.status).toBe(200)
  expect(seenProviderId).toBe('resource-search-alt')
  channelStore.close()
  stats.close()
})

it('GET /api/search?scope=resources fans out raw over search-download and facets at the call site', async () => {
  const channelStore = new UserStore(join(dir, `res-prov-${Math.random()}.db`))
  const stats = new ProviderStatsStore(join(dir, `res-stats-${Math.random()}.db`))
  const registry = new Registry([...manifests, mk({ id: 'pansou-search', provides: ['search-download'], capabilities: ['search'] })])
  ensureSystemRows(channelStore)
  const seen: Array<{ sourceId: string; params?: Record<string, unknown> }> = []
  const executor = new ProviderExecutor({
    directory: new ProviderDirectory(channelStore, SYSTEM_IDENTITIES), registry, stats,
    fetchSource: async (sourceId, _input, params) => {
      seen.push({ sourceId, params })
      return sourceId === 'pansou-search' ? [{ title: 'r1' }, { title: 'r2' }] : []
    },
  })
  const scheduler = new Scheduler({ registry, streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
  const service = new StreamService({ registry, scheduler, channels: channelStore })
  // facet stub captures what the call site handed it — proving raw items + per-item provenance
  let facetArgs: { q: string; provenance: (string | undefined)[] } | null = null
  const app = createHttpApp({
    service, itemStore: store, health, providers: { executor, stats },
    facetResources: (q, items) => {
      facetArgs = { q, provenance: items.map((it) => sourceOf(it)) }
      return { shows: [], loose: items, sources: [{ key: 'pansou', label: '盘搜', ms: 1, count: items.length, status: 'ok' }] }
    },
  })
  const res = await app.request('/api/search?scope=resources&q=show')
  expect(res.status).toBe(200)
  const body = await res.json()
  // fanned out to the search-download member with {keyword:$input} filled from the BARE q (not an
  // object). The row also carries explicit per-source members (btbtla/nyaa/comicat/bangumi.moe),
  // each fanned out with its own param name; they return nothing under this stub. Assert the
  // search-download fan-out specifically so adding sources doesn't churn this expectation.
  expect(seen).toContainEqual({ sourceId: 'pansou-search', params: { keyword: 'show' } })
  // the call site handed facetResources the bare q + raw items each carrying provenance
  expect(facetArgs!.q).toBe('show')
  expect(facetArgs!.provenance).toEqual(['pansou-search', 'pansou-search'])
  // faceted shape returned to the client (provenance tag is non-enumerable → gone from JSON)
  expect(body).toEqual({ shows: [], loose: [{ title: 'r1' }, { title: 'r2' }], sources: [{ key: 'pansou', label: '盘搜', ms: 1, count: 2, status: 'ok' }] })
  channelStore.close()
  stats.close()
})

it('GET /api/search?scope=video fans out over video-search and dedups hits into candidates', async () => {
  const channelStore = new UserStore(join(dir, `video-prov-${Math.random()}.db`))
  const stats = new ProviderStatsStore(join(dir, `video-stats-${Math.random()}.db`))
  const registry = new Registry(manifests)
  ensureSystemRows(channelStore)
  const seen: Array<{ sourceId: string; params?: Record<string, unknown> }> = []
  const executor = new ProviderExecutor({
    directory: new ProviderDirectory(channelStore, SYSTEM_IDENTITIES), registry, stats,
    fetchSource: async (sourceId, _input, params) => {
      seen.push({ sourceId, params })
      return sourceId === '@streamapp/builtin/tmdb-title-search' ? [
        { title: '沙丘', kind: 'movie', year: 2021, externalIds: { tmdb: '438631' }, rating: 8, overview: 'o1' },
        { title: '沙丘', kind: 'movie', year: 2021, externalIds: { tmdb: '438631' } }, // 同 tmdb id → 去重合并
        { title: '权力的游戏', kind: 'series', year: 2011, externalIds: { tmdb: '1399' } },
      ] : []
    },
  })
  const scheduler = new Scheduler({ registry, streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
  const service = new StreamService({ registry, scheduler, channels: channelStore })
  const app = createHttpApp({ service, itemStore: store, health, providers: { executor, stats } })

  const res = await app.request('/api/search?scope=video&q=' + encodeURIComponent('沙丘'))
  expect(res.status).toBe(200)
  const body = await res.json()
  // 行成员 tmdb-title-search 的 {keyword:'$input'} 洞被裸 q 填上
  expect(seen).toContainEqual({ sourceId: '@streamapp/builtin/tmdb-title-search', params: { keyword: '沙丘' } })
  // 两条同 tmdb id 的「沙丘」→ 合成一张卡；权力的游戏另立；候选带 sources/rating/overview 投影
  expect(body.candidates).toHaveLength(2)
  const dune = body.candidates.find((cand: { externalIds?: { tmdb?: string } }) => cand.externalIds?.tmdb === '438631')
  expect(dune).toMatchObject({ title: '沙丘', kind: 'movie', year: 2021, rating: 8, overview: 'o1', sources: ['@streamapp/builtin/tmdb-title-search'] })
  channelStore.close()
  stats.close()
})

it('scope=video edge cases: empty q → [], no providers → 503, bad scope → 400', async () => {
  const scheduler = new Scheduler({ registry: new Registry(manifests), streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
  const service = new StreamService({ registry: new Registry(manifests), scheduler, channels: new UserStore(join(dir, `video-edge-${Math.random()}.db`)) })
  const app = createHttpApp({ service, itemStore: store, health })
  expect(await (await app.request('/api/search?scope=video&q=')).json()).toEqual({ candidates: [] })
  expect((await app.request('/api/search?scope=video&q=x')).status).toBe(503)
  expect((await app.request('/api/search?scope=bogus&q=x')).status).toBe(400)
})

it('persists liked tracks through the unified collections endpoints (audio domain, 2026-07-20)', async () => {
  const scheduler = new Scheduler({ registry: new Registry(manifests), streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
  const service = new StreamService({ registry: new Registry(manifests), scheduler, channels: new UserStore(join(dir, `stream-svc-${Math.random()}.db`)) })
  const collections = new CollectionsStore(join(dir, `collections-liked-${Math.random()}.db`))
  const app = createHttpApp({ service, itemStore: store, health, collections })
  const trackKey = encodeURIComponent('track:netease:123')
  try {
    const put = await app.request(`/api/collections/${SYSTEM_COLLECTIONS.audioLiked}/items/${trackKey}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '晴天', artist: '周杰伦', album: '叶惠美', poster: 'https://img/1.jpg', durationS: 269 }),
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toMatchObject({ kind: 'track', platform: 'netease', trackId: '123', title: '晴天', artist: '周杰伦' })
    expect(await (await app.request(`/api/collections/${SYSTEM_COLLECTIONS.audioLiked}/items`)).json()).toMatchObject([{ platform: 'netease', trackId: '123', title: '晴天' }])

    const del = await app.request(`/api/collections/${SYSTEM_COLLECTIONS.audioLiked}/items/${trackKey}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await (await app.request(`/api/collections/${SYSTEM_COLLECTIONS.audioLiked}/items`)).json()).toEqual([])

    // old paths are gone
    expect((await app.request('/api/likes')).status).toBe(404)
    expect((await app.request('/api/likes/keys')).status).toBe(404)
    expect((await app.request('/api/likes/netease/123', { method: 'PUT' })).status).toBe(404)
    expect((await app.request('/api/music/liked')).status).toBe(404)
  } finally {
    collections.close()
  }
})

it('episode keys + anchored collections + batch add (2026-07-24)', async () => {
  const tdir = mkdtempSync(join(tmpdir(), 'col-http-'))
  const collections = new CollectionsStore(join(tdir, 'c.db'))
  const scheduler = new Scheduler({ registry: new Registry(manifests), streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
  const service = new StreamService({ registry: new Registry(manifests), scheduler, channels: new UserStore(join(dir, `stream-svc-${Math.random()}.db`)) })
  const app = createHttpApp({ service, itemStore: store, health, collections })
  try {
    // 建锚定播单(video 带锚报 400)
    const bad = await app.request('/api/collections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'video', label: 'X', anchorStreamId: 's1' }) })
    expect(bad.status).toBe(400)
    const created = await (await app.request('/api/collections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'audio', label: '某系列', anchorStreamId: 'pod-a' }) })).json()
    expect(created.anchorStreamId).toBe('pod-a')
    // anchor 过滤
    const anchored = await (await app.request('/api/collections?domain=audio&anchor=pod-a')).json()
    expect(anchored.map((c: any) => c.id)).toEqual([created.id])
    // 批量加入(episode key,itemId 带冒号)
    const batch = await app.request(`/api/collections/${created.id}/items`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [
        { key: 'episode:pod-a:ep:1', title: '第1期', durationS: 3600 },
        { key: 'episode:pod-b:ep:2', title: '第2期' },
      ] }),
    })
    expect(batch.status).toBe(200)
    expect((await batch.json()).map((s: any) => s.itemId)).toEqual(['ep:1', 'ep:2'])
    // 坏 key 整批拒
    const badBatch = await app.request(`/api/collections/${created.id}/items`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ key: 'episode:onlystream', title: 'X' }] }),
    })
    expect(badBatch.status).toBe(400)
    // whereCollected 走 episode key
    const where = await (await app.request(`/api/collected/${encodeURIComponent('episode:pod-a:ep:1')}`)).json()
    expect(where.collectionIds).toEqual([created.id])
    // 单条 DELETE 也通
    expect((await app.request(`/api/collections/${created.id}/items/${encodeURIComponent('episode:pod-a:ep:1')}`, { method: 'DELETE' })).status).toBe(200)
  } finally { collections.close() }
})

it('PUT /api/collections/:id/order 整份名单重排;名单不全就 400 且一行都不写', async () => {
  const tdir = mkdtempSync(join(tmpdir(), 'col-order-http-'))
  const collections = new CollectionsStore(join(tdir, 'c.db'))
  const scheduler = new Scheduler({ registry: new Registry(manifests), streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
  const service = new StreamService({ registry: new Registry(manifests), scheduler, channels: new UserStore(join(dir, `stream-svc-${Math.random()}.db`)) })
  const app = createHttpApp({ service, itemStore: store, health, collections })
  try {
    const col = await (await app.request('/api/collections', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'audio', label: '播单' }),
    })).json()
    await app.request(`/api/collections/${col.id}/items`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ key: 'episode:p:e1', title: 'E1' }, { key: 'episode:p:e2', title: 'E2' }, { key: 'episode:p:e3', title: 'E3' }] }),
    })
    // 未排过：最近加入的在最前
    const initial = await (await app.request(`/api/collections/${col.id}/items`)).json()
    expect(initial.map((i: any) => i.itemId)).toEqual(['e3', 'e2', 'e1'])

    const ok = await app.request(`/api/collections/${col.id}/order`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: ['episode:p:e2', 'episode:p:e3', 'episode:p:e1'] }),
    })
    expect(ok.status).toBe(200)
    // 回执直接就是重排后的名单——前端不必再拉一次
    expect((await ok.json()).map((i: any) => i.itemId)).toEqual(['e2', 'e3', 'e1'])

    // 半份名单：拒绝，且顺序保持刚才那一版（不是"部分写入"的第三种样子）
    const short = await app.request(`/api/collections/${col.id}/order`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys: ['episode:p:e1'] }),
    })
    expect(short.status).toBe(400)
    expect((await (await app.request(`/api/collections/${col.id}/items`)).json()).map((i: any) => i.itemId)).toEqual(['e2', 'e3', 'e1'])

    expect((await app.request(`/api/collections/${col.id}/order`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: 'nope' }),
    })).status).toBe(400)
    expect((await app.request('/api/collections/col_nope/order', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: [] }),
    })).status).toBe(404)
  } finally { collections.close() }
})

it('GET /api/status', async () => {
  const app = build()
  const r = await app.request('/api/status')
  expect(r.status).toBe(200)
  const s = await r.json()
  expect(s).toEqual({
    ok: true,
    cookies: { domains: ['bilibili.com'], updatedAt: 1 },
    manifests: 2,
    streams: [
      { id: 'my-tech', last_tick: null, item_count: 0 }
    ]
  })
})

it('GET /api/status 把"还没取回过登录态"如实报出来（其余字段照常）', async () => {
  const empty: () => Promise<HealthInfo> = async () => ({
    cookies: { domains: [], updatedAt: null },
    manifests: 2,
    streams: 1,
  })
  const r = await build(undefined, { health: empty }).request('/api/status')
  expect(r.status).toBe(200)
  const s = await r.json()
  // 登录态还没取回来不该让调用方连"哪些部分是好的"都拿不到
  expect(s.ok).toBe(true)
  expect(s.manifests).toBe(2)
  expect(s.streams).toEqual([{ id: 'my-tech', last_tick: null, item_count: 0 }])
  // `updatedAt` 必须透传：空 domains 单看说不出"从没取过" vs "取过了但一个域都没有"
  expect(s.cookies).toEqual({ domains: [], updatedAt: null })
})

/**
 * 这一口只准回这几个键。**别把断言放宽成"包含 ok:true"就算完**——API.md 给它的契约是
 * "carries no system detail"，而那条只有靠"键集合是封闭的"才钉得住：往 health 里泄一个
 * 系统细节字段，这个列表就会当场变红，逼下一个人显式回答"它该不该出现在免鉴权的口上"。
 * commit / started_at / dirty_since_start 是 build-identity 那三个（值由它自己的测试钉）。
 */
const HEALTH_KEYS = ['ok', 'commit', 'started_at', 'dirty_since_start', 'last_harvest_at']

it('GET /api/health is an unauthenticated liveness probe (app-backend-sidecar D3)', async () => {
  const r = await build().request('/api/health')
  expect(r.status).toBe(200)
  const body = (await r.json()) as Record<string, unknown>
  expect(body.ok).toBe(true)
  expect(Object.keys(body).filter((k) => !HEALTH_KEYS.includes(k))).toEqual([])
})

it('GET /api/health surfaces last_harvest_at from the dedicated lastHarvestAt() dep (tray recency tooltip)', async () => {
  const r = await build(undefined, { lastHarvestAt: () => '2026-07-20T10:00:00.000Z' }).request('/api/health')
  expect(r.status).toBe(200)
  const body = (await r.json()) as Record<string, unknown>
  expect(body).toMatchObject({ ok: true, last_harvest_at: '2026-07-20T10:00:00.000Z' })
  expect(Object.keys(body).filter((k) => !HEALTH_KEYS.includes(k))).toEqual([])
})

it('GET /api/health stays 200 {ok:true} even when health() rejects — liveness must not depend on anything else', async () => {
  const failingHealth: () => Promise<HealthInfo> = async () => { throw new Error('health blew up') }
  const r = await build(undefined, { health: failingHealth }).request('/api/health')
  expect(r.status).toBe(200)
  const body = (await r.json()) as Record<string, unknown>
  expect(body.ok).toBe(true)
  expect(body.last_harvest_at).toBeUndefined()
})

it('verb endpoints /api/subscribe and /api/unsubscribe are gone (404)', async () => {
  const app = build()
  const sub = await app.request('/api/subscribe', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
  expect(sub.status).toBe(404)
  const unsub = await app.request('/api/unsubscribe', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
  expect(unsub.status).toBe(404)
})

it('PATCH /api/items/:id label mutes manually as ad/lottery and clears on not-ad', async () => {
  const negatives: string[] = []
  const scheduler = new Scheduler({ registry: new Registry(manifests), streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
  const service = new StreamService({ registry: new Registry(manifests), scheduler, channels: new UserStore(join(dir, `stream-svc-${Math.random()}.db`)) })
  const app = createHttpApp({ service, itemStore: store, health, recordNegative: (it) => negatives.push(it.id) })

  const lot = await app.request('/api/items/i1', { method: 'PATCH', body: JSON.stringify({ label: 'lottery' }), headers: { 'content-type': 'application/json' } })
  expect(lot.status).toBe(200)
  expect(store.get('i1')?.muted).toEqual({ reason: 'lottery', rule: 'manual', manual: true })

  await app.request('/api/items/i1', { method: 'PATCH', body: JSON.stringify({ label: 'not-ad' }), headers: { 'content-type': 'application/json' } })
  expect(store.get('i1')?.muted).toBeUndefined()
  expect(negatives).toContain('i1') // false positive captured as a negative fixture

  const missing = await app.request('/api/items/zzz', { method: 'PATCH', body: JSON.stringify({ label: 'ad' }), headers: { 'content-type': 'application/json' } })
  expect(missing.status).toBe(404)

  const bad = await app.request('/api/items/i1', { method: 'PATCH', body: JSON.stringify({ label: 'nope' }), headers: { 'content-type': 'application/json' } })
  expect(bad.status).toBe(400)
})

it('PATCH /api/channels/:channelId/streams/:streamId/ad-filter sets and clears a per-stream rule', async () => {
  const scheduler = new Scheduler({ registry: new Registry(manifests), streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
  const service = new StreamService({ registry: new Registry(manifests), scheduler, channels: new UserStore(join(dir, `stream-svc-${Math.random()}.db`)) })
  const ts = new UserStore(join(dir, 'stream.db'))
  ts.putStream(streamToStreamRecord(stream))
  ts.putChannel({ id: 't1', label: 'T1', present: 'timeline', stream_ids: [stream.id], options: {} })
  const app = createHttpApp({ service, itemStore: store, health, channelStore: ts })

  const set = await app.request('/api/channels/t1/streams/my-tech/ad-filter', {
    method: 'PATCH',
    body: JSON.stringify({ keywords: ['内部专享'] }),
    headers: { 'content-type': 'application/json' },
  })
  expect(set.status).toBe(200)
  expect((await set.json()).ad_filter).toEqual({ keywords: ['内部专享'] })

  const cleared = await app.request('/api/channels/t1/streams/my-tech/ad-filter', {
    method: 'PATCH',
    body: JSON.stringify(null),
    headers: { 'content-type': 'application/json' },
  })
  expect(cleared.status).toBe(200)
  expect((await cleared.json()).ad_filter).toBeUndefined()

  const missingTarget = await app.request('/api/channels/zzz/streams/my-tech/ad-filter', {
    method: 'PATCH',
    body: JSON.stringify({ keywords: ['x'] }),
    headers: { 'content-type': 'application/json' },
  })
  expect(missingTarget.status).toBe(404)

  const badBody = await app.request('/api/channels/t1/streams/my-tech/ad-filter', {
    method: 'PATCH',
    body: JSON.stringify({ keywords: [123] }),
    headers: { 'content-type': 'application/json' },
  })
  expect(badBody.status).toBe(400)
})

it('POST /api/channels/:channelId/streams/:streamId/ad-filter/reclassify updates matching non-manual items, skips manually-labeled ones', async () => {
  store.add({ id: 'auto1', stream_id: 'my-tech', source_type: 'rsshub-bridge', source_route: '/x', fetched_at: 't', timestamp: 't', title: '内部专享福利', raw: {} }, 'post')
  store.add({ id: 'manual1', stream_id: 'my-tech', source_type: 'rsshub-bridge', source_route: '/x', fetched_at: 't', timestamp: 't', title: '内部专享福利', raw: {} }, 'post')
  store.setMuted('manual1', { reason: 'ad', rule: 'manual', manual: true })

  const scheduler = new Scheduler({ registry: new Registry(manifests), streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
  const service = new StreamService({ registry: new Registry(manifests), scheduler, channels: new UserStore(join(dir, `stream-svc-${Math.random()}.db`)) })
  const ts = new UserStore(join(dir, 'stream2.db'))
  ts.putStream(streamToStreamRecord({ ...stream, ad_filter: { keywords: ['内部专享'] } }))
  ts.putChannel({ id: 't1', label: 'T1', present: 'timeline', stream_ids: [stream.id], options: {} })
  const app = createHttpApp({ service, itemStore: store, health, channelStore: ts })

  const res = await app.request('/api/channels/t1/streams/my-tech/ad-filter/reclassify', { method: 'POST' })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ changed: 1 })
  expect(store.get('auto1')?.muted?.rule).toBe('内部专享')
  expect(store.get('manual1')?.muted).toEqual({ reason: 'ad', rule: 'manual', manual: true })

  const missing = await app.request('/api/channels/t1/streams/zzz/ad-filter/reclassify', { method: 'POST' })
  expect(missing.status).toBe(404)
})

it('watch progress: 上报/续播/继续观看/移除 (2026-07-24)', async () => {
  const wpDir = mkdtempSync(join(tmpdir(), 'wp-'))
  const watchProgress = new WatchProgressStore(join(wpDir, 'wp.db'))
  const app = build(undefined, { watchProgress })
  try {
    const key = 'tmdb:261391:S03E02'
    const put = await app.request(`/api/watch-progress/${encodeURIComponent(key)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ position: 754, duration: 3000, workKey: 'tmdb:261391', workTitle: '喜剧之王单口季', workPoster: '/p.jpg', epLabel: 'S03E02' }),
    })
    expect(put.status).toBe(200)

    const got = await (await app.request(`/api/watch-progress/${encodeURIComponent(key)}`)).json()
    expect(got).toMatchObject({ position: 754, duration: 3000 })

    const list = await (await app.request('/api/watch-progress')).json()
    expect(list.map((r: any) => r.key)).toEqual([key])
    expect(list[0]).toMatchObject({ workTitle: '喜剧之王单口季', epLabel: 'S03E02' })

    // 看完 → 不再出现在墙上,但仍可续播
    await app.request(`/api/watch-progress/${encodeURIComponent(key)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ position: 2990, duration: 3000, workKey: 'tmdb:261391', workTitle: '喜剧之王单口季' }),
    })
    expect(await (await app.request('/api/watch-progress')).json()).toEqual([])
    expect((await (await app.request(`/api/watch-progress/${encodeURIComponent(key)}`)).json()).position).toBe(2990)

    // 未知 key → null(不是 404,续播路径不该把"没看过"当错误)
    expect(await (await app.request('/api/watch-progress/never-seen')).json()).toBeNull()

    // 坏 body → 400
    const bad = await app.request(`/api/watch-progress/${encodeURIComponent(key)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ position: 1 }),
    })
    expect(bad.status).toBe(400)

    expect((await app.request(`/api/watch-progress/${encodeURIComponent(key)}`, { method: 'DELETE' })).status).toBe(200)
  } finally { watchProgress.close() }
})
