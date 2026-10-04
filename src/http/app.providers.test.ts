// 从 app.test.ts 的 describe('HTTP API') 里拆出(2026-07-22):按路由域分文件,
// 理由见 __fixtures__/app-harness.ts 头注。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { createHttpApp, type HealthInfo } from './app.ts'
import { StreamService } from '../mcp/tools.ts'
import { Registry } from '../registry/registry.ts'
import { Scheduler } from '../scheduler.ts'
import { UserStore } from '../store/user-store.ts'
import { SourceHealthStore } from '../source-health-store.ts'
import { ProviderStatsStore } from '../providers/stats-store.ts'
import { ProviderExecutor, sourceOf } from '../providers/executor.ts'
import { ensureSystemRows } from '../providers/seed.ts'
import { ProviderBindings } from '../providers/bindings.ts'
import { ProviderDirectory } from '../providers/directory.ts'
// 合并表（宿主静态表 + 包声明的行），与 provider 域装配时读的是同一个函数。
import { allIdentities, setPackageIdentities } from '../providers/identities.ts'
import { PROVIDER_CALLSITES, callsiteDefaultsFor } from '../providers/callsites.ts'
import { DedupStore } from '../dedup-store.ts'
import { ItemStore } from '../item-store.ts'
import { EventStore } from '../events/store.ts'
import { EventsService } from '../events/service.ts'
import { createHttpApiFixture, fake, health, item, manifests, mk, stream, type HttpApiFixture } from './__fixtures__/app-harness.ts'

let fixture: HttpApiFixture
let dir: string, dedup: DedupStore, store: ItemStore, build: HttpApiFixture['build']
// 每个 beforeEach 换一份新夹具;build 闭包绑的就是这一轮的 dir/store,所以从 app.test.ts
// 搬过来的测试体保持原样(裸 dir/store/dedup/build),一个引用都不用改写。
beforeEach(() => { fixture = createHttpApiFixture(); ({ dir, dedup, store, build } = fixture) })
afterEach(() => { fixture.close() })

/** 取歌那条行现在是**包声明**的（`packages/netease/package.json#stream.providers`），不在宿主
 *  静态表里。这里照原样挂一份，好让「auto 段按 matches 展开」那条覆盖仍然跑得到——它今天只有
 *  包行会用（宿主静态表里已经没有 matches 段了）。 */
const NETEASE_TRACK_ROW = {
  facility: 'netease',
  declaration: {
    id: 'netease-track',
    category: 'resolve' as const,
    serveKeys: ['netease', 'music.163.com', 'netease-track'],
    strategy: 'sequential' as const,
    label: '网易云取歌',
    description: 'song id → 可播放/可下载地址',
    members: [{ mode: 'auto' as const, matches: 'music.163.com/song', params: { id: '$input', level: 'lossless' } }],
    callsites: ['music.track.resolve', 'music.track.download'],
  },
}

describe('provider CRUD endpoints (row model)', () => {
  // 包行是进程级的全局表；跑完摘掉，别让它漏进同进程里别的用例。
  afterEach(() => { setPackageIdentities([]) })

  function providersApp(extra: Partial<Parameters<typeof createHttpApp>[0]> = {}) {
    setPackageIdentities([NETEASE_TRACK_ROW])
    const registry = new Registry([
      ...manifests,
      mk({ id: 'cs-primary', matchers: ['music.163.com/song'], priority: 1 }),
      mk({ id: 'cs-mirror', matchers: ['music.163.com/song'], priority: 2 }),
      mk({ id: 'douyin-search', provides: ['search-content'], title: '抖音搜索' }),
      mk({ id: '@streamapp/toubiec/toubiec-search', title: '投币次元 关键词搜索', pluginId: 'replay', adapter: 'replay' }),
      mk({ id: '@streamapp/zuna/zuna-search', title: 'Zuna 歌曲搜索', pluginId: 'replay', adapter: 'replay' }),
    ])
    const scheduler = new Scheduler({ registry, streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
    const channelStore = new UserStore(join(dir, `stream-${Math.random()}.db`))
    const sourceHealth = new SourceHealthStore(join(dir, `health-${Math.random()}.json`))
    sourceHealth.record('cs-mirror', { kind: 'error', message: 'down' })
    const stats = new ProviderStatsStore(join(dir, `cache-${Math.random()}.db`))
    const executor = new ProviderExecutor({
      directory: new ProviderDirectory(channelStore, allIdentities()), registry, stats,
      fetchSource: async (sourceId) => (sourceId === '@streamapp/toubiec/toubiec-search' ? [{ id: 1 }] : []),
    })
    ensureSystemRows(channelStore)
    const providerBindings = new ProviderBindings(channelStore, new ProviderDirectory(channelStore, allIdentities()))
    providerBindings.ensureDefaults(PROVIDER_CALLSITES)
    const service = new StreamService({ registry, scheduler, channels: channelStore })
    const events = new EventsService(new EventStore(join(dir, `events-${Math.random()}.json`)), () => {})
    const app = createHttpApp({
      service, itemStore: store, health, channelStore,
      providers: { executor, stats },
      providerBindings,
      events,
      resolve: { registry, sourceHealth, resolveEngine: {} as never, intentResolver: {} as never, radarMatcher: {} as never, streams: () => scheduler.list() },
      ...extra,
    })
    return { app, channelStore, stats }
  }

  it('GET /api/providers lists live rows with resolved members + planned annotations', async () => {
    const { app, channelStore, stats } = providersApp()
    try {
      stats.record('music-search', 'znnu-search')
      const res = await (await app.request('/api/providers')).json()
      const byId = new Map(res.items.map((p: { id: string }) => [p.id, p]))
      expect(byId.has('track-play')).toBe(false) // 已并入 netease-track
      expect(byId.has('track-download')).toBe(false)
      const nt = byId.get('netease-track') as any
      expect(nt.status).toBe('live')
      // auto 段按 provides 声明展开（failover 优先级序），source 成员带 health
      expect(nt.resolvedMembers.map((m: any) => m.name)).toEqual(['cs-primary', 'cs-mirror'])
      expect(nt.resolvedMembers[1].health).toBe('degraded')
      // the unhealthy member carries the failure reason (category + message + time) for the
      // hover card; the healthy one carries nothing (no empty card).
      expect(nt.resolvedMembers[1].healthError).toMatchObject({ category: 'unknown', message: 'down' })
      expect(nt.resolvedMembers[1].healthError.at).toBeTruthy()
      expect(nt.resolvedMembers[0].healthError).toBeUndefined()
      const cs = byId.get('content-search') as any
      // content-search 只有 auto 段，扇出所有 provides=search-content 的目录源（这份 fixture 里只有 douyin）
      expect(cs.resolvedMembers.map((m: any) => m.name)).toEqual(['douyin-search'])
      expect(cs.callSites).toContain('GET /api/search?scope=content')
      const ms = byId.get('music-search') as any
      expect(ms.calls.total).toBe(1)
      // music-search 成员是 recipe 搜索源；人读名从 manifest 标题
      expect(ms.resolvedMembers.map((m: any) => m.name)).toEqual(['@streamapp/toubiec/toubiec-search', '@streamapp/zuna/zuna-search'])
      expect(ms.resolvedMembers[0].source.title).toBe('投币次元 关键词搜索') // manifest 是元数据唯一的家
      expect(ms.resolvedMembers[0].source.pluginId).toBe('replay')
      expect(nt.resolvedMembers[0].source.title).toBe('cs-primary')
      // parse 已经是 live 行（成员：视觉模型在前吃白嫖额度，ocr-mineru 兜底），不再是 planned 标注
      const parse = byId.get('parse') as any
      expect(parse.status).toBe('live')
      // 调用点标签是给人看的，必须指向真实存在的端点：/api/parses 这一族已随 conversions 收敛删除
      expect(parse.callSites).toEqual(['POST /api/conversions kind:extract（ocr 分支：图片/PDF → Markdown）'])
      const stillPlanned = byId.get('summarize') as any
      expect(stillPlanned.status).toBe('planned')
      // timeline 不是 Provider
      expect(byId.has('timeline')).toBe(false)
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  // llm / parse 这两行的成员永远是同一个源的又一个实例（一份端点+模型+key）。让人去几百个源的
  // 目录里翻出唯一那个候选纯属折磨——所以这行自报默认来源，前端「添加来源」直接开它的配置面。
  // 声明在 PROVIDER_DEFAULT_SOURCE（代码知识，不进 store），这里 join 成完整投影：前端要 pluginId
  // 才取得到 detail，只给一个 id 它照样得先去目录里找。
  it('GET /api/providers 带出这行的默认来源（完整投影，不是光秃秃一个 id）', async () => {
    const registry = new Registry([...manifests, mk({ id: 'llm-openai', title: 'OpenAI 兼容 LLM', pluginId: 'builtin' })])
    const { app, channelStore, stats } = providersApp({
      resolve: { registry, sourceHealth: undefined, resolveEngine: {} as never, intentResolver: {} as never, radarMatcher: {} as never, streams: () => [] } as never,
    })
    try {
      const res = await (await app.request('/api/providers')).json()
      const llm = res.items.find((p: { id: string }) => p.id === 'llm') as any
      expect(llm.defaultSource).toMatchObject({ id: 'llm-openai', title: 'OpenAI 兼容 LLM', pluginId: 'builtin' })
      // 没声明默认来源的行不带这个字段——前端靠它是否在场决定开配置面还是开目录。
      const search = res.items.find((p: { id: string }) => p.id === 'music-search') as any
      expect('defaultSource' in search).toBe(false)
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  // 声明了、但这台机器上没装那个源 → 字段缺席，退回目录。宁可多点几下，也不给一个点了会 404 的按钮。
  it('默认来源在 registry 里不存在时字段缺席，不硬造一个投影', async () => {
    const { app, channelStore, stats } = providersApp() // 这份 registry 里没有 llm-openai
    try {
      const res = await (await app.request('/api/providers')).json()
      const llm = res.items.find((p: { id: string }) => p.id === 'llm') as any
      expect('defaultSource' in llm).toBe(false)
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  it('GET /api/providers surfaces member keyState — missing key stays visible, no-secret members carry no field', async () => {
    // deps.keyState 内部才判"这个源有没有 secret 声明"(bootstrap 接线用 registry+TokenProvider.layer)；
    // providerView 只负责原样转发/按 null 省略字段——这里注入一个假 keyState 单测转发逻辑。
    const { app, channelStore, stats } = providersApp({
      keyState: (sourceId: string) => (sourceId === 'cs-primary' ? 'missing' : null),
    })
    try {
      const res = await (await app.request('/api/providers')).json()
      const nt = res.items.find((p: { id: string }) => p.id === 'netease-track') as any
      const byName = new Map<string, any>(nt.resolvedMembers.map((m: any) => [m.name, m]))
      expect(byName.get('cs-primary').keyState).toBe('missing')
      expect(byName.get('cs-mirror').keyState).toBeUndefined()
      expect('keyState' in byName.get('cs-mirror')).toBe(false)
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  it('keyState 拿得到成员自己的 params——perInstance 源才能按实例分别报层', async () => {
    // perInstance 源（llm-openai）的 key 存在成员 params.tokenName 那一层,不在 manifest ref 上。
    // providerView 必须把成员 params 一并交给 keyState,否则同一个源的每个实例只能得到同一个
    // （而且恒 missing 的）读数。
    const seen: Array<{ sourceId: string; params?: Record<string, unknown> }> = []
    const { app, channelStore, stats } = providersApp({
      keyState: (sourceId: string, params?: Record<string, unknown>) => {
        seen.push({ sourceId, params })
        return params?.tokenName === 'llm:kimi' ? 'stored' : 'missing'
      },
    })
    try {
      const created = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'llm-keys', category: 'llm', serves: ['*'], strategy: 'sequential',
          members: [
            { source: 'cs-mirror', name: 'kimi', params: { tokenName: 'llm:kimi' } },
            { source: 'cs-mirror', name: 'nokey', params: { tokenName: 'llm:nokey' } },
          ],
        }),
      })
      expect(created.status).toBe(201)
      const view = await (await app.request('/api/providers/llm-keys')).json()
      expect(view.resolvedMembers.map((m: any) => m.keyState)).toEqual(['stored', 'missing'])
      expect(seen.some((s) => s.params?.tokenName === 'llm:kimi')).toBe(true)
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  it('GET /api/providers?variant=&key= previews declaration matching (specific beats *)', async () => {
    const { app, channelStore, stats } = providersApp()
    try {
      const hit = await (await app.request('/api/providers?variant=transform&key=unknown.com')).json()
      expect(hit.items.map((p: { id: string }) => p.id)).toEqual(['fetch-url'])
      const none = await (await app.request('/api/providers?variant=download&key=zzz')).json()
      expect(none.items).toEqual([])
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  it('GET /api/provider-callsites exposes each capability entry surface', async () => {
    const { app, channelStore, stats } = providersApp()
    try {
      const body = await (await app.request('/api/provider-callsites')).json() as { items: Array<{ id: string; entries?: unknown }> }
      const byId = new Map(body.items.map((item) => [item.id, item]))
      expect(byId.get('video.resolve')?.entries).toEqual([
        { id: 'video', label: '视频', presenter: 'Video Present' },
      ])
      expect(byId.get('search.content')?.entries).toEqual([
        { id: 'default-timeline', label: '默认时间线', presenter: 'Post Present' },
      ])
      // 取歌两条改成按平台 dispatch 之后，宿主自己不带默认行——默认由取歌平台的**包**声明填
      // （`stream.providers[].callsites`）。这个环境挂了 netease 那条包行，所以两条的默认
      // 绑定就是它。
      for (const id of ['music.track.resolve', 'music.track.download']) {
        expect(byId.get(id)).toMatchObject({
          mode: 'dispatch',
          entries: [{ id: 'music', label: '音乐', presenter: 'Music Present' }],
          binding: { providerIds: ['netease-track'] },
        })
      }
      // 反面：一个包都没装时这两条的默认是**空**，于是 `ensureDefaults` 跳过、不写空绑定
      // ——页面上就是一格待用户/包填的槽，而不是一条指向不存在的行的绑定。
      setPackageIdentities([])
      expect(callsiteDefaultsFor('music.track.resolve')).toEqual([])
      expect(callsiteDefaultsFor('music.track.download')).toEqual([])
      setPackageIdentities([NETEASE_TRACK_ROW])
      // Task 8：llm 调用点目录条目存在，默认绑定指向唯一的系统 llm 行，未设 params
      expect(byId.get('llm.chat')).toMatchObject({ binding: { providerIds: ['llm'] } })
      expect((byId.get('llm.chat') as any)?.binding.params).toBeUndefined()
      expect(byId.get('netdisk.spec.suggest')).toMatchObject({ binding: { providerIds: ['llm'] } })
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  // Task 8（llm-provider-unification）：调用点绑定带可选 params——per-任务 model 覆盖的落点。
  // 本任务只做存取 + 目录，不改任何调用方行为（Task 9 才会真正拿 params 覆盖调用）。
  it('PUT /api/provider-callsites/:id/binding accepts optional params object and round-trips it', async () => {
    const { app, channelStore, stats } = providersApp()
    try {
      const put = await app.request('/api/provider-callsites/llm.chat/binding', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerIds: ['llm'], params: { model: 'gpt-4o-mini' } }),
      })
      expect(put.status).toBe(200)
      const putBody = await put.json() as { params?: unknown }
      expect(putBody.params).toEqual({ model: 'gpt-4o-mini' })

      const list = await (await app.request('/api/provider-callsites')).json() as { items: Array<{ id: string; binding?: { params?: unknown } }> }
      expect(list.items.find((i) => i.id === 'llm.chat')?.binding?.params).toEqual({ model: 'gpt-4o-mini' })
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  it('PUT /api/provider-callsites/:id/binding rejects a non-object params (400)', async () => {
    const { app, channelStore, stats } = providersApp()
    try {
      const res = await app.request('/api/provider-callsites/llm.chat/binding', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerIds: ['llm'], params: 'nope' }),
      })
      expect(res.status).toBe(400)
      const arrayRes = await app.request('/api/provider-callsites/llm.chat/binding', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerIds: ['llm'], params: ['nope'] }),
      })
      expect(arrayRes.status).toBe(400)
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  it('GET /api/presents exposes the official present registry with slots', async () => {
    const { app, channelStore, stats } = providersApp()
    try {
      const body = await (await app.request('/api/presents')).json() as { items: Array<{ id: string; slots: Array<{ callsiteId: string }> }> }
      expect(body.items.map((p) => p.id).sort()).toEqual(['audio', 'embed', 'research', 'search', 'tasks', 'timeline', 'video'])
      expect(body.items.find((p) => p.id === 'video')!.slots.map((s) => s.callsiteId)).toContain('search.video')
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  it('POST → GET → PATCH → DELETE full round-trip with validation and conflict', async () => {
    const { app, channelStore, stats } = providersApp()
    try {
      const created = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'enrich-bili', label: 'B站富化', category: 'transform', serves: ['bilibili.com'], members: [{ source: 'x' }] }),
      })
      expect(created.status).toBe(201)
      expect((await created.json()).strategy).toBe('sequential') // 默认 strategy 随 variant

      const conflict = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'enrich-bili', category: 'transform' }),
      })
      expect(conflict.status).toBe(409)

      const badVariant = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'x', category: 'timeline' }),
      })
      expect(badVariant.status).toBe(400)
      expect((await badVariant.json()).error.code).toBe('validation_error')

      const badMember = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'y', category: 'search', members: [{ nope: 1 }] }),
      })
      expect(badMember.status).toBe(400)

      const got = await (await app.request('/api/providers/enrich-bili')).json()
      expect(got.serves).toEqual(['bilibili.com'])

      const patched = await app.request('/api/providers/enrich-bili', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serves: ['bilibili.com', 'b23.tv'], options: { exclude: ['x'] } }),
      })
      expect(patched.status).toBe(200)
      const pv = await patched.json()
      expect(pv.serves).toEqual(['bilibili.com', 'b23.tv'])
      expect(pv.resolvedMembers).toEqual([]) // exclude 后现役成员为空

      expect((await app.request('/api/providers/enrich-bili', { method: 'DELETE' })).status).toBe(200)
      expect((await app.request('/api/providers/enrich-bili')).status).toBe(404)
      expect((await app.request('/api/providers/enrich-bili', { method: 'DELETE' })).status).toBe(404)
      expect((await app.request('/api/providers/nope', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404)
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  // 系统行的身份住代码（`src/providers/system/`），行上那几列是死数据——改它不会生效。
  // 所以门口就响亮拒掉：静默收下会让用户以为改成了，而这类误解不会有任何症状提醒他。
  describe('PATCH 系统行：身份字段拒改，编排字段照改', () => {
    const patch = (app: ReturnType<typeof createHttpApp>, id: string, body: unknown) =>
      app.request(`/api/providers/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })

    it('改 serves / category / strategy → 400，且库里那一行没动', async () => {
      const { app, channelStore, stats } = providersApp()
      try {
        const before = channelStore.getProvider('music-search')!
        for (const body of [
          { serves: ['music', '我加的'] },
          { category: 'resolve' },
          { strategy: 'sequential' },
          { contract: { members: '随便写点什么' } },
        ]) {
          const res = await patch(app, 'music-search', body)
          expect(res.status, JSON.stringify(body)).toBe(400)
          expect((await res.json()).error.message).toContain('由代码定义')
        }
        expect(channelStore.getProvider('music-search')).toEqual(before)
      } finally {
        channelStore.close()
        stats.close()
      }
    })

    it('members / options / label 照常可改（200）', async () => {
      const { app, channelStore, stats } = providersApp()
      try {
        const res = await patch(app, 'music-search', {
          members: [{ source: '@streamapp/zuna/zuna-search', params: { keyword: '$input' } }],
          options: { note: 'mine' }, label: '我的音乐搜索',
        })
        expect(res.status).toBe(200)
        const row = channelStore.getProvider('music-search')!
        expect(row.members).toHaveLength(1)
        expect(row.options).toEqual({ note: 'mine' })
        expect(row.label).toBe('我的音乐搜索')
      } finally {
        channelStore.close()
        stats.close()
      }
    })

    // 前端把整行读回来再 PATCH 回去是常态，那份 body 里必然带着身份字段的**原值**——
    // 把「传了」本身当冲突，会把正常编辑一起拒掉。
    it('原样回传身份字段不算冲突（整行 round-trip 仍然 200）', async () => {
      const { app, channelStore, stats } = providersApp()
      try {
        const current = await (await app.request('/api/providers/music-search')).json()
        const res = await patch(app, 'music-search', {
          category: current.category, serves: current.serves, strategy: current.strategy,
          contract: current.contract, members: current.members, options: { touched: true },
        })
        expect(res.status).toBe(200)
        expect(channelStore.getProvider('music-search')!.options).toEqual({ touched: true })
      } finally {
        channelStore.close()
        stats.close()
      }
    })

    it('用户自建行不受这道门管——身份就在它自己的行上', async () => {
      const { app, channelStore, stats } = providersApp()
      try {
        await app.request('/api/providers', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'mine', category: 'transform', serves: ['x'], members: [] }),
        })
        expect((await patch(app, 'mine', { serves: ['x', 'y'], strategy: 'concurrent' })).status).toBe(200)
        expect(channelStore.getProvider('mine')!.serves).toEqual(['x', 'y'])
      } finally {
        channelStore.close()
        stats.close()
      }
    })
  })

  it('accepts a {mode:auto, matches} member through POST validation', async () => {
    const { app, channelStore, stats } = providersApp()
    try {
      const created = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'nt-clone', category: 'resolve', serves: ['music.163.com'], members: [{ mode: 'auto', matches: 'music.163.com/song', params: { id: '$input' } }] }),
      })
      expect(created.status).toBe(201)
      const view = await (await app.request('/api/providers/nt-clone')).json()
      expect(view.members).toEqual([{ mode: 'auto', matches: 'music.163.com/song', params: { id: '$input' } }])
      expect(view.resolvedMembers.map((m: any) => m.name)).toEqual(['cs-primary', 'cs-mirror'])
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  it('同源双实例：视图按实例名寻址、按真源 id 查 manifest/health/keyState;实例名撞车被拒', async () => {
    const { app, channelStore, stats } = providersApp({
      keyState: (sourceId: string) => (sourceId === 'cs-mirror' ? 'stored' : null),
    })
    try {
      const created = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'llm-row', category: 'llm', serves: ['*'], strategy: 'sequential',
          members: [
            { source: 'cs-mirror', name: 'deepseek', params: { model: 'v3' } },
            { source: 'cs-mirror', name: 'kimi', params: { model: 'k2' } },
          ],
        }),
      })
      expect(created.status).toBe(201)
      const view = await (await app.request('/api/providers/llm-row')).json()
      // 两个实例都在（旧的 sourceId 去重会把第二条吞掉），寻址键 = 实例名
      expect(view.resolvedMembers.map((m: any) => m.name)).toEqual(['deepseek', 'kimi'])
      // manifest / health / keyState 三样都按真源 id 查——两个实例共享同一份
      expect(view.resolvedMembers.map((m: any) => m.source.id)).toEqual(['cs-mirror', 'cs-mirror'])
      expect(view.resolvedMembers.map((m: any) => m.health)).toEqual(['degraded', 'degraded'])
      expect(view.resolvedMembers[0].healthError).toMatchObject({ message: 'down' })
      expect(view.resolvedMembers.map((m: any) => m.keyState)).toEqual(['stored', 'stored'])

      // 同一行里两个成员的寻址键撞车 = 配置错，写入即拒（静默丢一档梯子是查不出来的坏）
      const dup = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'llm-dup', category: 'llm',
          members: [{ source: 'cs-mirror', name: 'same' }, { source: 'cs-primary', name: 'same' }],
        }),
      })
      expect(dup.status).toBe(400)
      expect((await dup.json()).error.message).toContain('duplicate member name')
      // 实例名撞上另一个成员的裸 source id 同样拒
      const dupBare = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'llm-dup2', category: 'llm',
          members: [{ source: 'cs-primary' }, { source: 'cs-mirror', name: 'cs-primary' }],
        }),
      })
      expect(dupBare.status).toBe(400)
      // {provider} 组合成员与 {source} 实例名共用同一个寻址命名空间（executor 用同一个 seen 去重），
      // 撞了同样要拒——否则过了校验再被 executor 静默吞掉一档
      const dupProvider = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'llm-dup3', category: 'llm',
          members: [{ provider: 'child-row' }, { source: 'cs-mirror', name: 'child-row' }],
        }),
      })
      expect(dupProvider.status).toBe(400)
      expect((await dupProvider.json()).error.message).toContain('duplicate member name')

      // 但两个都不带 name 的同源成员仍按旧语义接受（executor 静默去重，行为逐字节不变）
      const legacy = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'llm-legacy', category: 'llm', members: [{ source: 'cs-primary' }, { source: 'cs-primary' }] }),
      })
      expect(legacy.status).toBe(201)
      expect((await legacy.json()).resolvedMembers.map((m: any) => m.name)).toEqual(['cs-primary'])
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  it('实例名遮蔽真实源 → 422;name 等于自己的 source → 放行', async () => {
    const { app, channelStore, stats } = providersApp()
    try {
      // 实例名撞上另一个**已注册源**的 id：真的 cs-primary 会被这个实例从梯子里挤掉且看不出来
      const shadow = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'shadowy', category: 'llm', members: [{ source: 'cs-mirror', name: 'cs-primary' }] }),
      })
      expect(shadow.status).toBe(422)
      const shadowBody = await shadow.json()
      // 独立 code：调用方要能和普通 validation_error 区分开（422 + 文案匹配不是契约）
      expect(shadowBody.error.code).toBe('name_shadows_source')
      expect(shadowBody.error.message).toContain('already a registered source id')

      // name 恰好 = 自己的 source:等价于不写 name,寻址键没变,放行
      const selfNamed = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'self-named', category: 'llm', members: [{ source: 'cs-mirror', name: 'cs-mirror' }] }),
      })
      expect(selfNamed.status).toBe(201)
      expect((await selfNamed.json()).resolvedMembers.map((m: any) => m.name)).toEqual(['cs-mirror'])

      // 未注册的自由实例名照常放行
      const ok = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'free-named', category: 'llm', members: [{ source: 'cs-mirror', name: 'deepseek' }] }),
      })
      expect(ok.status).toBe(201)

      // PATCH 同样把关（改成员是最常见的入口）
      const patched = await app.request('/api/providers/free-named', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ members: [{ source: 'cs-mirror', name: 'cs-primary' }] }),
      })
      expect(patched.status).toBe(422)
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  it('实例名只对 {source} 成员有意义：auto 段 / {provider} / {fn} 成员带 name → 400', async () => {
    // 这些成员的寻址键不是实例名（auto 段展开出的成员按 source id,组合成员按子行 id）——
    // 收下一个永远不会被读的 name,等于让用户以为自己给它起了名字。
    const { app, channelStore, stats } = providersApp()
    try {
      for (const member of [
        { mode: 'auto', provides: 'search', name: 'nope' },
        { provider: 'child-row', name: 'nope' },
        { fn: 'some-fn', name: 'nope' },
      ]) {
        const res = await app.request('/api/providers', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: `named-${Math.random().toString(36).slice(2, 7)}`, category: 'llm', members: [member] }),
        })
        expect(res.status).toBe(400)
      }
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  it('registry 不可达时跳过遮蔽校验,不炸', async () => {
    // deps.resolve 缺席（未接线/精简注入）→ shadowedSourceName 拿不到 registry，放行而不是 500
    const channelStore = new UserStore(join(dir, `stream-noreg-${Math.random()}.db`))
    const stats = new ProviderStatsStore(join(dir, `cache-noreg-${Math.random()}.db`))
    try {
      const registry = new Registry(manifests)
      const scheduler = new Scheduler({ registry, streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
      const executor = new ProviderExecutor({ directory: new ProviderDirectory(channelStore, allIdentities()), registry, stats, fetchSource: async () => [] })
      ensureSystemRows(channelStore)
      const app = createHttpApp({
        service: new StreamService({ registry, scheduler, channels: channelStore }),
        itemStore: store, health, channelStore,
        providers: { executor, stats },
      })
      const res = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'noreg', category: 'llm', members: [{ source: 'a', name: 'b' }] }),
      })
      expect(res.status).toBe(201)
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  it('DELETE on a bound provider is rejected (409), with the callsite reference', async () => {
    const { app, channelStore, stats } = providersApp()
    try {
      const del = await app.request('/api/providers/music-search', { method: 'DELETE' })
      expect(del.status).toBe(409)
      expect((await del.json()).error.details.callsites).toContain('search.music')
      expect(channelStore.getProvider('music-search')).not.toBeNull()
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  it('DELETE 被 {provider} 成员引用的 provider → 409(标出引用方);引用移除后可删', async () => {
    const { app, channelStore, stats } = providersApp()
    try {
      const mk = (id: string, members: unknown[]) => app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, category: 'search', serves: [id], strategy: 'concurrent', members }),
      })
      await mk('child2', [{ mode: 'auto', matches: 'music.163.com/song' }])
      await mk('parent2', [{ provider: 'child2' }])
      const res = await app.request('/api/providers/child2', { method: 'DELETE' })
      expect(res.status).toBe(409)
      expect((await res.json()).error.details.providers).toContain('parent2')
      // 引用移除后可删
      await app.request('/api/providers/parent2', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ members: [{ mode: 'auto', matches: 'music.163.com/song' }] }) })
      expect((await app.request('/api/providers/child2', { method: 'DELETE' })).status).toBe(200)
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  it('rejects deleting a provider referenced by a channel slot', async () => {
    const { app, channelStore, stats } = providersApp()
    try {
      const created = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'p-slot', category: 'search', serves: ['p-slot'], members: [{ mode: 'auto', matches: 'music.163.com/song' }] }),
      })
      expect(created.status).toBe(201)
      channelStore.putChannel({ id: 'c-slot', label: '槽位频道', present: 'timeline', stream_ids: [], options: { slots: { 'search.resources': ['p-slot'] } } })
      const del = await app.request('/api/providers/p-slot', { method: 'DELETE' })
      expect(del.status).toBe(409)
      expect((await del.json()).error.details.channels).toEqual([{ channelId: 'c-slot', callsiteId: 'search.resources' }])
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  // spec §8 逐字验收：NSFW 频道（video Present）在「资源搜索」槽填一个 search variant 的
  // Provider 行 → 该频道内搜索走槽位指定行；其他 video 频道（未带 channelId，即回落全局
  // 默认 binding）搜索逐字不变（resource-search 计数增长、槽位行不再增长）。
  // 命名对齐 spec：Provider = nsfw-search，频道 = nsfw。
  it('NSFW acceptance (spec §8): video-present channel with a search-slot override routes to nsfw-search; default channel untouched', async () => {
    const { app, channelStore, stats } = providersApp()
    try {
      const created = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'nsfw-search', category: 'search', serves: ['nsfw-search'], members: [{ mode: 'auto', matches: 'music.163.com/song' }] }),
      })
      expect(created.status).toBe(201)
      channelStore.putChannel({ id: 'nsfw', label: 'NSFW 频道', present: 'video', stream_ids: [], options: { slots: { 'search.resources': ['nsfw-search'] } } })

      const withChannel = await app.request('/api/search?scope=resources&q=xx&channelId=nsfw')
      expect(withChannel.status).toBe(200)

      // 断言点：既有的 calls.total 计数先例（见上面 music-search 用例）——带 channelId 命中槽位行
      // nsfw-search（并发扇出 cs-primary+cs-mirror 两成员，total 计的是成员调用数非行调用数），
      // 全局默认 resource-search 一次都没走。
      const afterChannel = await (await app.request('/api/providers')).json()
      const byIdAfterChannel = new Map(afterChannel.items.map((p: { id: string }) => [p.id, p]))
      const nsfwAfterChannel = byIdAfterChannel.get('nsfw-search') as any
      expect(nsfwAfterChannel.calls.total).toBeGreaterThan(0)
      expect((byIdAfterChannel.get('resource-search') as any).calls.total).toBe(0)

      // 无 channelId（等同其他 video 频道，如 default-video）→ 回落全局默认 resource-search，
      // 槽位行 nsfw-search 逐字不变（调用数不再增长）。
      const withoutChannel = await app.request('/api/search?scope=resources&q=xx')
      expect(withoutChannel.status).toBe(200)

      const afterDefault = await (await app.request('/api/providers')).json()
      const byIdAfterDefault = new Map(afterDefault.items.map((p: { id: string }) => [p.id, p]))
      expect((byIdAfterDefault.get('resource-search') as any).calls.total).toBeGreaterThan(0)
      expect((byIdAfterDefault.get('nsfw-search') as any).calls.total).toBe(nsfwAfterChannel.calls.total)
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  // §5.1:槽位填了、但槽里挑不出可用 Provider(全 parked)→ 显式 422 + Bell 事件,不回落全局。
  // 用 putChannel 直接绕过写路径校验模拟历史脏数据(该 provider 是写入槽位之后才被 park 的)。
  it('§5.1: channel slot pointing only at a parked provider → 422 slot_broken + provider.slot_broken event', async () => {
    const { app, channelStore, stats } = providersApp()
    try {
      const parked = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'slot-parked', category: 'search', serves: ['slot-parked'], members: [{ mode: 'auto', matches: 'music.163.com/song' }] }),
      })
      expect(parked.status).toBe(201)
      channelStore.putChannel({ id: 'c-broken-slot', label: '', present: 'video', stream_ids: [], options: { slots: { 'search.resources': ['slot-parked'] } } })
      // park 之后再写入(putProvider 补 options.parked,绕过 PATCH 的校验只是模拟途径,不是本用例断言点)
      const cur = channelStore.getProvider('slot-parked')!
      channelStore.putProvider({ ...cur, options: { ...cur.options, parked: true } })

      // GET /api/providers 列表要把 parked 顶层投影出来——前端槽位候选靠它过滤,不下钻 options。
      const list = await (await app.request('/api/providers')).json()
      const row = list.items.find((p: any) => p.id === 'slot-parked')
      expect(row.parked).toBe(true)

      const res = await app.request('/api/search?scope=resources&q=x&channelId=c-broken-slot')
      expect(res.status).toBe(422)
      const body = await res.json()
      expect(body.error.code).toBe('slot_broken')

      const events = await (await app.request('/api/events')).json()
      const evt = events.find((e: any) => e.type === 'provider.slot_broken')
      expect(evt).toBeTruthy()
      expect(evt.severity).toBe('warn')
      expect(evt.dedupeKey).toBe('slot:c-broken-slot:search.resources')

      // 修复后恢复:PATCH 频道清空该槽位(等同用户在频道设置里点"清除") → 同一搜索回落全局
      // 默认 binding、200 正常路由,不再是坏槽状态。
      const fixed = await app.request('/api/channels/c-broken-slot', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ options: {} }),
      })
      expect(fixed.status).toBe(200)
      expect((await fixed.json()).options).toEqual({})

      const resAfterFix = await app.request('/api/search?scope=resources&q=x&channelId=c-broken-slot')
      expect(resAfterFix.status).toBe(200)
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  // 流式分支（?stream=1，NDJSON）曾经根本不解析槽位——就地换 Provider 写入成功、结果一模一样。
  // 这两条把「换了行真的换扇出」和「坏槽在流式路也是 422 而不是静默回落」钉住。
  it('streaming resource search resolves the search.resources slot: channel override changes the fan-out row', async () => {
    const seen: Array<string | undefined> = []
    async function* fakeStream(_q: string, opts: { providerId?: string } = {}) {
      seen.push(opts.providerId)
      yield { type: 'done' }
    }
    const { app, channelStore, stats } = providersApp({ videoSearchStream: fakeStream })
    try {
      const created = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'nsfw-search', category: 'search', serves: ['nsfw-search'], members: [{ mode: 'auto', matches: 'music.163.com/song' }] }),
      })
      expect(created.status).toBe(201)
      channelStore.putChannel({ id: 'nsfw', label: 'NSFW 频道', present: 'video', stream_ids: [], options: { slots: { 'search.resources': ['nsfw-search'] } } })

      const withChannel = await app.request('/api/search?scope=resources&stream=1&q=xx&channelId=nsfw')
      expect(withChannel.status).toBe(200)
      await withChannel.text()
      expect(seen).toEqual(['nsfw-search'])

      // 无 channelId → 回落全局默认行
      const withoutChannel = await app.request('/api/search?scope=resources&stream=1&q=xx')
      expect(withoutChannel.status).toBe(200)
      await withoutChannel.text()
      expect(seen).toEqual(['nsfw-search', 'resource-search'])

      // 打点记的是实际用的那一行，不是写死的 resource-search
      const after = await (await app.request('/api/providers')).json()
      const byId = new Map(after.items.map((p: { id: string }) => [p.id, p]))
      expect((byId.get('nsfw-search') as any).calls.total).toBe(1)
      expect((byId.get('resource-search') as any).calls.total).toBe(1)
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  it('streaming resource search with a broken slot → 422 slot_broken (not a silent fallback)', async () => {
    let called = 0
    async function* fakeStream() { called++; yield { type: 'done' } }
    const { app, channelStore, stats } = providersApp({ videoSearchStream: fakeStream })
    try {
      const parked = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'slot-parked', category: 'search', serves: ['slot-parked'], members: [{ mode: 'auto', matches: 'music.163.com/song' }] }),
      })
      expect(parked.status).toBe(201)
      channelStore.putChannel({ id: 'c-broken-stream', label: '', present: 'video', stream_ids: [], options: { slots: { 'search.resources': ['slot-parked'] } } })
      const cur = channelStore.getProvider('slot-parked')!
      channelStore.putProvider({ ...cur, options: { ...cur.options, parked: true } })

      const res = await app.request('/api/search?scope=resources&stream=1&q=x&channelId=c-broken-stream')
      expect(res.status).toBe(422)
      expect((await res.json()).error.code).toBe('slot_broken')
      expect(called).toBe(0) // 解析发生在开流之前，流根本没起
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  it('rejects channel slots with unknown callsite or variant-mismatched provider', async () => {
    const { app, channelStore, stats } = providersApp()
    try {
      const unknownCallsite = await app.request('/api/channels/default-timeline', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ options: { slots: { 'no.such.callsite': ['x'] } } }),
      })
      expect(unknownCallsite.status).toBe(400)
      expect((await unknownCallsite.json()).error.code).toBe('validation_error')

      // netease-track 是 resolve variant，search.resources 要求 search variant → 校验失败
      const wrongVariant = await app.request('/api/channels/default-timeline', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ options: { slots: { 'search.resources': ['netease-track'] } } }),
      })
      expect(wrongVariant.status).toBe(400)
      expect((await wrongVariant.json()).error.code).toBe('validation_error')
      expect(channelStore.getChannel('default-timeline')?.options).toEqual({})
    } finally {
      channelStore.close()
      stats.close()
    }
  })

  // §5.1 写路径预防:parked 行不能被写进槽位(全局 binding put()/validateSelection 共用规则不动,
  // 这条只加在槽位写入)。
  it('rejects channel slots pointing at a parked provider (§5.1 write-path prevention)', async () => {
    const { app, channelStore, stats } = providersApp()
    try {
      const created = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'p-parked-write', category: 'search', serves: ['p-parked-write'], members: [{ mode: 'auto', matches: 'music.163.com/song' }] }),
      })
      expect(created.status).toBe(201)
      const parkedPatch = await app.request('/api/providers/p-parked-write', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ options: { parked: true } }),
      })
      expect(parkedPatch.status).toBe(200)

      const res = await app.request('/api/channels/default-timeline', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ options: { slots: { 'search.resources': ['p-parked-write'] } } }),
      })
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('validation_error')
      expect(channelStore.getChannel('default-timeline')?.options).toEqual({})
    } finally {
      channelStore.close()
      stats.close()
    }
  })
})

it('token gate: 401 without, 200 with', async () => {
  // 门的完整判据与边界在 access-guard.test.ts / access-guard.app.test.ts；这里只钉住
  // "配了 token 的实例上，没凭证的请求进不来"。Host 得显式给——真实请求必然带，
  // 进程内 app.request 不带，而缺 Host 是 fail-closed 的 403（防 DNS rebinding）。
  const app = build('secret')
  const headers = { Host: '127.0.0.1:8900' }
  expect((await app.request('/api/streams', { headers })).status).toBe(401)
  const ok = await app.request('/api/streams', { headers: { ...headers, Authorization: 'Bearer secret' } })
  expect(ok.status).toBe(200)
})

// ── blocked：成员缺的是**前置条件**，不是坏了 ──────────────────────────────────────────
//
// 端到端锁这条链：adapter 抛 NeedsLoginError → executor 的 catch 经 blockedOf 结构化 →
// /api/search 的 warning 带上 blocked。前端要靠它画按钮，所以中间任何一环把它压成字符串，
// 这条就红。
describe('GET /api/search — blocked 前置条件随 warning 结构化带出', () => {
  function searchApp(fetchSource: (sourceId: string) => Promise<unknown>) {
    const registry = new Registry([
      ...manifests,
      mk({ id: 'douyin-search', provides: ['search-content'], title: '抖音搜索' }),
    ])
    const scheduler = new Scheduler({ registry, streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
    const channelStore = new UserStore(join(dir, `stream-${Math.random()}.db`))
    const sourceHealth = new SourceHealthStore(join(dir, `health-${Math.random()}.json`))
    const stats = new ProviderStatsStore(join(dir, `cache-${Math.random()}.db`))
    const executor = new ProviderExecutor({
      directory: new ProviderDirectory(channelStore, allIdentities()), registry, stats,
      fetchSource: async (sourceId) => (await fetchSource(sourceId)) as never,
    })
    ensureSystemRows(channelStore)
    const providerBindings = new ProviderBindings(channelStore, new ProviderDirectory(channelStore, allIdentities()))
    providerBindings.ensureDefaults(PROVIDER_CALLSITES)
    const service = new StreamService({ registry, scheduler, channels: channelStore })
    const events = new EventsService(new EventStore(join(dir, `events-${Math.random()}.json`)), () => {})
    return createHttpApp({
      service, itemStore: store, health, channelStore,
      providers: { executor, stats },
      providerBindings, events,
      resolve: { registry, sourceHealth, resolveEngine: {} as never, intentResolver: {} as never, radarMatcher: {} as never, streams: () => scheduler.list() },
    })
  }

  it('登录掉了的成员 → warning 带 {kind:"login", facility, label}，其余源照常返回', async () => {
    const { NeedsLoginError } = await import('../adapters/replay/adapter.ts')
    const app = searchApp(async (sourceId) => {
      if (sourceId === 'douyin-search') throw new NeedsLoginError('douyin-search', 'douyin', '抖音')
      return []
    })
    const res = await (await app.request('/api/search?scope=content&q=%E9%9C%B2%E8%90%A5')).json()
    const w = (res.warnings as Array<{ source: string; blocked?: unknown }>).find((x) => x.source === 'douyin-search')
    expect(w?.blocked).toEqual({ kind: 'login', facility: 'douyin', label: '抖音' })
    // 承重：整次搜索仍然是 200、items 字段在——一个源要登录不该把别的源的结果一起拖没
    expect(Array.isArray(res.items)).toBe(true)
  })

  it('扩展没连 → warning 带 {kind:"extension"}', async () => {
    const { EnvironmentUnavailableError } = await import('../failure.ts')
    const app = searchApp(async (sourceId) => {
      if (sourceId === 'douyin-search') throw new EnvironmentUnavailableError('ext relay disconnected')
      return []
    })
    const res = await (await app.request('/api/search?scope=content&q=x')).json()
    const w = (res.warnings as Array<{ source: string; blocked?: unknown }>).find((x) => x.source === 'douyin-search')
    expect(w?.blocked).toEqual({ kind: 'extension' })
  })

  it('普通失败没有 blocked —— 不靠 message 里有没有 "login" 来猜', async () => {
    const app = searchApp(async (sourceId) => {
      if (sourceId === 'douyin-search') throw new Error('login rate limited, try again later')
      return []
    })
    const res = await (await app.request('/api/search?scope=content&q=x')).json()
    const w = (res.warnings as Array<{ source: string; blocked?: unknown }>).find((x) => x.source === 'douyin-search')
    expect(w).toBeTruthy()
    expect(w?.blocked).toBeUndefined()
  })
})

// 分源耗时：搜索是并发扇出，总耗时只等于**最慢那个成员**，所以"到底谁慢"只有分源明细能答
// （骑真浏览器滚页面的成员和纯 HTTP 的成员差一个数量级）。执行器本来就在算，别丢掉。
describe('GET /api/search — 每个成员跑了多久', () => {
  function searchApp(fetchSource: (sourceId: string) => Promise<unknown>) {
    const registry = new Registry([
      ...manifests,
      mk({ id: 'douyin-search', provides: ['search-content'], title: '抖音搜索' }),
    ])
    const scheduler = new Scheduler({ registry, streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
    const channelStore = new UserStore(join(dir, `stream-${Math.random()}.db`))
    const sourceHealth = new SourceHealthStore(join(dir, `health-${Math.random()}.json`))
    const stats = new ProviderStatsStore(join(dir, `cache-${Math.random()}.db`))
    const executor = new ProviderExecutor({
      directory: new ProviderDirectory(channelStore, allIdentities()), registry, stats,
      fetchSource: async (sourceId) => (await fetchSource(sourceId)) as never,
    })
    ensureSystemRows(channelStore)
    const providerBindings = new ProviderBindings(channelStore, new ProviderDirectory(channelStore, allIdentities()))
    providerBindings.ensureDefaults(PROVIDER_CALLSITES)
    const service = new StreamService({ registry, scheduler, channels: channelStore })
    const events = new EventsService(new EventStore(join(dir, `events-${Math.random()}.json`)), () => {})
    return createHttpApp({
      service, itemStore: store, health, channelStore,
      providers: { executor, stats }, providerBindings, events,
      resolve: { registry, sourceHealth, resolveEngine: {} as never, intentResolver: {} as never, radarMatcher: {} as never, streams: () => scheduler.list() },
    })
  }

  it('每个尝试过的成员都有一条 —— 成功的和失败的都要在', async () => {
    // 只报成功的没用：一个慢到超时的成员正是你想看见的那个。
    const app = searchApp(async (sourceId) => {
      if (sourceId === 'douyin-search') throw new Error('upstream 500')
      return []
    })
    const res = await (await app.request('/api/search?scope=content&q=x')).json()
    const t = (res.timings as Array<{ source: string; ms: number; outcome: string }>)
      .find((x) => x.source === 'douyin-search')
    expect(t).toBeTruthy()
    expect(t!.outcome).toBe('error')
    expect(typeof t!.ms).toBe('number')
  })

  it('拿到结果的成员记成 win', async () => {
    const app = searchApp(async () => [{ title: 'A', link: 'https://a.test/1' }])
    const res = await (await app.request('/api/search?scope=content&q=x')).json()
    const timings = res.timings as Array<{ source: string; outcome: string }>
    expect(timings.length).toBeGreaterThan(0)
    expect(timings.some((t) => t.outcome === 'win')).toBe(true)
  })
})
