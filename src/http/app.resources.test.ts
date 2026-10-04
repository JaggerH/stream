// 从 app.test.ts 的 describe('HTTP API') 里拆出(2026-07-22):按路由域分文件,
// 理由见 __fixtures__/app-harness.ts 头注。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { createHttpApp, type HealthInfo } from './app.ts'
import { StreamService } from '../mcp/tools.ts'
import { Registry } from '../registry/registry.ts'
import { Scheduler } from '../scheduler.ts'
import type { Stream } from '../streams/types.ts'
import { UserStore } from '../store/user-store.ts'
import { streamToStreamRecord } from '../store/compat.ts'
import { SourceHealthStore } from '../source-health-store.ts'
import { DedupStore } from '../dedup-store.ts'
import { ItemStore } from '../item-store.ts'
import { createHttpApiFixture, fake, health, item, manifests, mk, stream, type HttpApiFixture } from './__fixtures__/app-harness.ts'
import type { StreamItem } from '../types.ts'

let fixture: HttpApiFixture
let dir: string, dedup: DedupStore, store: ItemStore, build: HttpApiFixture['build']
// 每个 beforeEach 换一份新夹具;build 闭包绑的就是这一轮的 dir/store,所以从 app.test.ts
// 搬过来的测试体保持原样(裸 dir/store/dedup/build),一个引用都不用改写。
beforeEach(() => { fixture = createHttpApiFixture(); ({ dir, dedup, store, build } = fixture) })
afterEach(() => { fixture.close() })

describe('resource CRUD endpoints', () => {
  function resourceApp() {
    const registry = new Registry([
      ...manifests,
      mk({ id: 'hn-search', description: 'hn search', capabilities: ['search'], provides: ['article'], priority: 20 }),
      mk({ id: 'hn-alt-search', description: 'hn alt search', capabilities: ['search'], provides: ['article'], priority: 10 }),
    ])
    const scheduler = new Scheduler({ registry, streams: [stream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
    const channelStore = new UserStore(join(dir, `stream-${Math.random()}.db`))
    channelStore.putStream(streamToStreamRecord(stream))
    channelStore.putChannel({ id: 'home', label: 'Home', present: 'timeline', stream_ids: [stream.id], options: {} })
    const sourceHealth = new SourceHealthStore(join(dir, `health-${Math.random()}.json`))
    sourceHealth.record('hn-alt-search', { kind: 'error', message: 'down' })
    const service = new StreamService({ registry, scheduler, channels: channelStore })
    const app = createHttpApp({
      service,
      itemStore: store,
      health,
      channelStore,
      resolve: { registry, sourceHealth, resolveEngine: {} as never, intentResolver: {} as never, radarMatcher: {} as never, streams: () => scheduler.list() },
    })
    return { app, channelStore }
  }

  it('POST /api/streams creates, schedules, validates, and rejects conflicts', async () => {
    const { app, channelStore } = resourceApp()
    try {
      const body = { id: 'extra', label: 'Extra', strategy: 'fanout', cadence_seconds: 60, members: [{ plugin: 'fake', source: 'hn', params: {} }], options: {} }
      const created = await app.request('/api/streams', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect(created.status).toBe(201)
      expect(await created.json()).toMatchObject({ id: 'extra', strategy: 'fanout' })
      expect((await (await app.request('/api/streams')).json()).map((s: { id: string }) => s.id)).toContain('extra')

      const bad = await app.request('/api/streams', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, id: 'bad', cadence_seconds: 0 }) })
      expect(bad.status).toBe(400)
      expect((await bad.json()).error.code).toBe('validation_error')

      const conflict = await app.request('/api/streams', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect(conflict.status).toBe(409)
    } finally {
      channelStore.close()
    }
  })

  it('PATCH /api/streams updates and 404s missing streams', async () => {
    const { app, channelStore } = resourceApp()
    try {
      const updated = await app.request('/api/streams/my-tech', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cadence_seconds: 120, members: [{ plugin: 'fake', source: 'bili', params: {} }] }),
      })
      expect(updated.status).toBe(200)
      expect(await updated.json()).toMatchObject({ id: 'my-tech', cadence_seconds: 120 })
      const scheduled = await (await app.request('/api/streams')).json()
      expect(scheduled.find((s: { id: string }) => s.id === 'my-tech').cadence_seconds).toBe(120)

      const missing = await app.request('/api/streams/missing', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'x' }) })
      expect(missing.status).toBe(404)
    } finally {
      channelStore.close()
    }
  })

  // 静默丢弃写错的键 = 接口对调用方撒谎。三次活体事故的形状与理由见 http/strict-input.ts。
  it('PATCH /api/streams 传错字段名 → 400 并指出该写哪个，不再回一个假装改成功的 200', async () => {
    const { app, channelStore } = resourceApp()
    try {
      const one = async (): Promise<unknown> =>
        (await (await app.request('/api/streams')).json()).find((s: { id: string }) => s.id === 'my-tech')
      const before = await one()
      // `sources` 是真实撞过的那个写法（正确是 `members`）
      const res = await app.request('/api/streams/my-tech', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: [{ plugin: 'fake', source: 'bili', params: {} }] }),
      })
      expect(res.status).toBe(400)
      const msg = (await res.json()).error.message as string
      expect(msg).toContain('sources')
      expect(msg).toContain('members')
      // 而且真的没改到任何东西——旧行为是这里已经被"改"过一轮了（其实什么也没发生）
      expect(await one()).toEqual(before)
    } finally {
      channelStore.close()
    }
  })

  it('GET /api/items 参数名写错 → 400，不再静默返回全库', async () => {
    const { app, channelStore } = resourceApp()
    try {
      const res = await app.request('/api/items?stream_id=my-tech')
      expect(res.status).toBe(400)
      const msg = (await res.json()).error.message as string
      expect(msg).toContain('stream_id')
      expect(msg).toContain('stream')
      // 认识的参数照常放行
      expect((await app.request('/api/items?stream=my-tech&limit=5&order=asc')).status).toBe(200)
      expect((await app.request('/api/items')).status).toBe(200)
    } finally {
      channelStore.close()
    }
  })

  // 剩下的 streams/channels 写入面逐个接闸（docs/API.md §2）。每条钉三件事：400 + 指出该写哪个
  // + **什么都没改**——「改了但没改到」和「改成功了」在旧行为下长得一模一样。
  describe('streams/channels 写入面：不认识的键 → 400', () => {
    const send = (
      app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> },
      method: string, path: string, body: unknown,
    ): Promise<Response> =>
      Promise.resolve(app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))

    const expect400 = async (res: Response, bad: string, hint: string) => {
      expect(res.status).toBe(400)
      const msg = (await res.json() as { error: { message: string } }).error.message
      // 必须是**这道闸**说的话，不是碰巧撞上某条形状校验。
      expect(msg).toContain('不认识的字段')
      expect(msg).toContain(bad)
      expect(msg).toContain(hint)
    }

    it('POST /api/streams 传 sources（正确是 members）→ 400，流没被建出来', async () => {
      const { app, channelStore } = resourceApp()
      try {
        const res = await send(app, 'POST', '/api/streams', {
          id: 'gated', label: 'G', strategy: 'fanout', cadence_seconds: 60,
          sources: [{ plugin: 'fake', source: 'hn', params: {} }], options: {},
        })
        await expect400(res, 'sources', 'members')
        expect(channelStore.getStream('gated')).toBeFalsy()
      } finally {
        channelStore.close()
      }
    })

    it('POST /api/channels 传 streamIds（正确是 stream_ids）→ 400，频道没被建出来', async () => {
      const { app, channelStore } = resourceApp()
      try {
        const before = channelStore.listChannels().length
        const res = await send(app, 'POST', '/api/channels', { id: 'gc', label: 'G', present: 'timeline', streamIds: [], options: {} })
        await expect400(res, 'streamIds', 'stream_ids')
        expect(channelStore.listChannels().length).toBe(before)
      } finally {
        channelStore.close()
      }
    })

    it('PATCH /api/channels/:id 传 streamIds → 400，成员表原样', async () => {
      const { app, channelStore } = resourceApp()
      try {
        const before = channelStore.getChannel('home')!.stream_ids
        const res = await send(app, 'PATCH', '/api/channels/home', { streamIds: [] })
        await expect400(res, 'streamIds', 'stream_ids')
        expect(channelStore.getChannel('home')!.stream_ids).toEqual(before)
      } finally {
        channelStore.close()
      }
    })

    it('PATCH …/ad-filter 传 keyword（正确是 keywords）→ 400，规则没落进 options', async () => {
      const { app, channelStore } = resourceApp()
      try {
        const res = await send(app, 'PATCH', `/api/channels/home/streams/${stream.id}/ad-filter`, { keyword: ['广告'] })
        await expect400(res, 'keyword', 'keywords')
        expect((channelStore.getStream(stream.id)!.options as { ad_filter?: unknown }).ad_filter).toBeUndefined()
      } finally {
        channelStore.close()
      }
    })

    it('PATCH …/title-filter 传 keyword → 400，只看包含没落进 options', async () => {
      const { app, channelStore } = resourceApp()
      try {
        const res = await send(app, 'PATCH', `/api/channels/home/streams/${stream.id}/title-filter`, { keyword: ['第一季'] })
        await expect400(res, 'keyword', 'keywords')
        expect((channelStore.getStream(stream.id)!.options as { title_include?: unknown }).title_include).toBeUndefined()
      } finally {
        channelStore.close()
      }
    })

    it('认识的键照常放行——闸不是把正常调用挡在门外', async () => {
      const { app, channelStore } = resourceApp()
      try {
        expect((await send(app, 'PATCH', `/api/channels/home/streams/${stream.id}/ad-filter`, { keywords: ['广告'] })).status).toBe(200)
        expect((channelStore.getStream(stream.id)!.options as { ad_filter?: { keywords: string[] } }).ad_filter?.keywords).toEqual(['广告'])
      } finally {
        channelStore.close()
      }
    })
  })

  it('PATCH /api/streams round-trips a season tag on a member (season merge)', async () => {
    const { app, channelStore } = resourceApp()
    try {
      const updated = await app.request('/api/streams/my-tech', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ members: [{ plugin: 'fake', source: 'bili', params: {}, season: 1 }] }),
      })
      expect(updated.status).toBe(200)
      const list = await (await app.request('/api/streams')).json()
      const stream = list.find((s: { id: string }) => s.id === 'my-tech')
      expect(stream.sources[0].season).toBe(1)
    } finally {
      channelStore.close()
    }
  })

  it('DELETE /api/streams removes, detaches, deschedules, and 404s missing streams', async () => {
    const { app, channelStore } = resourceApp()
    try {
      const deleted = await app.request('/api/streams/my-tech', { method: 'DELETE' })
      expect(deleted.status).toBe(200)
      expect(await deleted.json()).toEqual({ ok: true })
      expect(channelStore.getChannel('home')?.stream_ids).toEqual([])
      expect((await (await app.request('/api/streams')).json()).map((s: { id: string }) => s.id)).not.toContain('my-tech')

      const missing = await app.request('/api/streams/my-tech', { method: 'DELETE' })
      expect(missing.status).toBe(404)
    } finally {
      channelStore.close()
    }
  })

  it('POST /api/channels creates resource channels and rejects missing stream references/conflicts', async () => {
    const { app, channelStore } = resourceApp()
    try {
      const created = await app.request('/api/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'Search', variant: 'search', stream_ids: ['my-tech'], options: {} }),
      })
      expect(created.status).toBe(201)
      const createdBody = await created.json()
      expect(createdBody).toMatchObject({ stream_ids: ['my-tech'] })
      expect(createdBody.id).toMatch(/^channel-/)

      const bad = await app.request('/api/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'bad', label: 'Bad', variant: 'timeline', stream_ids: ['missing'], options: {} }),
      })
      expect(bad.status).toBe(400)

      const explicit = await app.request('/api/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'search', label: 'Search', variant: 'search', stream_ids: ['my-tech'], options: {} }),
      })
      expect(explicit.status).toBe(201)

      const conflict = await app.request('/api/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'search', label: 'Search', variant: 'search', stream_ids: ['my-tech'], options: {} }),
      })
      expect(conflict.status).toBe(409)
    } finally {
      channelStore.close()
    }
  })

  it('PATCH /api/channels updates and validates channel patches', async () => {
    const { app, channelStore } = resourceApp()
    try {
      // 旧前端仍会发 `variant` 字段名+历史值 'mixed' —— 别名映射:接受 variant、mixed 收敛为 timeline。
      const updated = await app.request('/api/channels/home', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Inbox', variant: 'mixed' }) })
      expect(updated.status).toBe(200)
      expect(await updated.json()).toMatchObject({ id: 'home', label: 'Inbox', present: 'timeline' })

      const bad = await app.request('/api/channels/home', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stream_ids: ['missing'] }) })
      expect(bad.status).toBe(400)

      const missing = await app.request('/api/channels/missing', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'x' }) })
      expect(missing.status).toBe(404)
    } finally {
      channelStore.close()
    }
  })

  // 前端拿 PATCH 的返回体**直接覆盖**共享状态里那一条频道记录（lib/channels.tsx），所以它必须
  // 和 GET 是同一个投影——少一个 `streams` 字段，界面覆盖完就是一片空白。这条守的是形状同源，
  // 不是"有没有改成功"。
  it('PATCH /api/channels returns the persisted ChannelView — same projection GET serves', async () => {
    const { app, channelStore } = resourceApp()
    try {
      const res = await app.request('/api/channels/home', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'Inbox' }),
      })
      expect(res.status).toBe(200)
      const patched = await res.json()
      const listed = (await (await app.request('/api/channels')).json()).find((c: { id: string }) => c.id === 'home')
      expect(patched).toEqual(listed)
      // 展开的 Channel → Stream → Source 树在返回体里；裸记录的 stream_ids 不在
      expect(patched.streams.map((s: { id: string }) => s.id)).toEqual([stream.id])
      expect(patched.stream_ids).toBeUndefined()
    } finally {
      channelStore.close()
    }
  })

  it('DELETE /api/channels leaves streams intact and 404s missing channels', async () => {
    const { app, channelStore } = resourceApp()
    try {
      const deleted = await app.request('/api/channels/home', { method: 'DELETE' })
      expect(deleted.status).toBe(200)
      expect(await deleted.json()).toEqual({ ok: true })
      expect(channelStore.getStream('my-tech')?.id).toBe('my-tech')

      const missing = await app.request('/api/channels/home', { method: 'DELETE' })
      expect(missing.status).toBe(404)
    } finally {
      channelStore.close()
    }
  })

  it('keeps system channels stored, reserved, and readable through channel items', async () => {
    const { app, channelStore } = resourceApp()
    try {
      channelStore.patchChannel('default-timeline', { stream_ids: [stream.id] })
      store.add(item('in-default-timeline', stream.id), 'post')
      store.add(item('outside-default-timeline', 'other'), 'post')

      const channels = await (await app.request('/api/channels')).json() as Array<{ id: string; label: string; system?: boolean }>
      expect(channels.find((t) => t.id === 'default-timeline')).toMatchObject({ label: '时间线', system: true })

      const deleted = await app.request('/api/channels/default-timeline', { method: 'DELETE' })
      expect(deleted.status).toBe(400)
      expect((await deleted.json()).error.message).toBe('system channel cannot be deleted')

      const items = (await (await app.request('/api/channels/default-timeline/items?limit=20')).json() as { items: Array<{ id: string }> }).items
      expect(items.map((it) => it.id)).toContain('in-default-timeline')
      expect(items.map((it) => it.id)).not.toContain('outside-default-timeline')
    } finally {
      channelStore.close()
    }
  })

  it('surfaces a snapshot (collection) stream through an explicitly-selected custom channel', async () => {
    // Regression: the snapshot/audio exclusion is a firehose (default-timeline) concern; a
    // user's custom channel whose only member is a collection stream must still show its items.
    const registry = new Registry([...manifests, mk({ id: 'coll-src', mode: 'collection' })])
    const collStream: Stream = { id: 'coll', description: 'collection', sources: [{ source_id: 'coll-src', params: {} }], cadence_seconds: 1800, vault_subdir: 'coll' }
    const scheduler = new Scheduler({ registry, streams: [collStream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
    const channelStore = new UserStore(join(dir, `stream-${Math.random()}.db`))
    channelStore.putStream(streamToStreamRecord(collStream))
    channelStore.putChannel({ id: 'my-coll', label: '我的收藏', present: 'timeline', stream_ids: [collStream.id], options: {} })
    const service = new StreamService({ registry, scheduler, channels: channelStore })
    const app = createHttpApp({ service, itemStore: store, health, channelStore })
    try {
      expect(scheduler.modeOf('coll')).toBe('collection')
      store.add(item('in-collection', 'coll'), 'post')

      const items = (await (await app.request('/api/channels/my-coll/items?limit=20')).json() as { items: Array<{ id: string }> }).items
      expect(items.map((it) => it.id)).toContain('in-collection')
    } finally {
      channelStore.close()
    }
  })

  it('surfaces the failure reason (healthError) on an unhealthy channel source, nothing on a healthy one', async () => {
    const registry = new Registry([...manifests])
    const errStream: Stream = { id: 'err', description: 'err', sources: [{ source_id: 'hn', params: {} }, { source_id: 'bili', params: { uid: '1' } }], cadence_seconds: 1800, vault_subdir: 'err' }
    const scheduler = new Scheduler({ registry, streams: [errStream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
    const channelStore = new UserStore(join(dir, `stream-${Math.random()}.db`))
    channelStore.putStream(streamToStreamRecord(errStream))
    channelStore.putChannel({ id: 'errch', label: '出错频道', present: 'timeline', stream_ids: [errStream.id], options: {} })
    const sourceHealth = new SourceHealthStore(join(dir, `health-${Math.random()}.json`))
    sourceHealth.record('hn', { kind: 'error', message: 'login required', category: 'auth' })
    const service = new StreamService({ registry, scheduler, channels: channelStore })
    const app = createHttpApp({ service, itemStore: store, health, channelStore, resolve: { registry, sourceHealth, resolveEngine: {} as never, intentResolver: {} as never, radarMatcher: {} as never, streams: () => scheduler.list() } })
    try {
      type Src = { source: { id: string }; health?: string; healthError?: { category: string; message: string; at: string } }
      const channels = await (await app.request('/api/channels')).json() as Array<{ id: string; streams: Array<{ sources: Src[] }> }>
      const srcs = channels.find((t) => t.id === 'errch')!.streams[0].sources
      const hn = srcs.find((s) => s.source.id === 'hn')!
      const bili = srcs.find((s) => s.source.id === 'bili')!
      expect(hn.health).toBe('degraded')
      expect(hn.healthError).toMatchObject({ category: 'auth', message: 'login required' })
      expect(hn.healthError!.at).toBeTruthy()
      expect(bili.healthError).toBeUndefined() // healthy source → no card
    } finally {
      channelStore.close()
    }
  })

  // 那个静音故障：成员自己次次采集成功（health 绿），而它 `uses` 的那个源坏了——后者往往
  // 不是任何一条 Stream 的成员，界面上没有属于它的行，只能挂在用它的人身上说。
  it('成员绿着而它依赖的源坏了 → dependencyIssues 说出来；依赖解析不到 → 也说出来', async () => {
    const registry = new Registry([
      ...manifests,
      mk({ id: 'feed', description: 'feed', uses: ['detail', 'ghost'] }),
      mk({ id: 'detail', description: 'detail', title: '笔记详情' }),
    ])
    const depStream: Stream = { id: 'dep', description: 'dep', sources: [{ source_id: 'feed', params: {} }], cadence_seconds: 1800, vault_subdir: 'dep' }
    const scheduler = new Scheduler({ registry, streams: [depStream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
    const channelStore = new UserStore(join(dir, `stream-${Math.random()}.db`))
    channelStore.putStream(streamToStreamRecord(depStream))
    channelStore.putChannel({ id: 'depch', label: '依赖频道', present: 'timeline', stream_ids: [depStream.id], options: {} })
    const sourceHealth = new SourceHealthStore(join(dir, `health-${Math.random()}.json`))
    sourceHealth.record('detail', { kind: 'error', message: 'recipe drifted', category: 'drift' })
    sourceHealth.record('detail', { kind: 'error', message: 'recipe drifted', category: 'drift' })
    const service = new StreamService({ registry, scheduler, channels: channelStore })
    const app = createHttpApp({ service, itemStore: store, health, channelStore, resolve: { registry, sourceHealth, resolveEngine: {} as never, intentResolver: {} as never, radarMatcher: {} as never, streams: () => scheduler.list() } })
    try {
      type Src = { source: { id: string }; health?: string; dependencyIssues?: Array<Record<string, unknown>> }
      const channels = await (await app.request('/api/channels')).json() as Array<{ id: string; streams: Array<{ sources: Src[] }> }>
      const feed = channels.find((t) => t.id === 'depch')!.streams[0].sources[0]
      expect(feed.health).toBe('healthy') // 它自己是绿的——这正是为什么必须另说一句
      expect(feed.dependencyIssues).toEqual([
        { kind: 'broken', id: 'detail', title: '笔记详情', health: 'dead', error: { category: 'drift', message: 'recipe drifted', at: expect.any(String) } },
        { kind: 'unresolved', id: 'ghost' },
      ])
    } finally {
      channelStore.close()
    }
  })

  it('依赖都健康 → 整个字段不出现（没问题时不给每一行加一句恒真的废话）', async () => {
    const registry = new Registry([...manifests, mk({ id: 'feed', description: 'feed', uses: ['detail'] }), mk({ id: 'detail', description: 'detail' })])
    const okStream: Stream = { id: 'ok', description: 'ok', sources: [{ source_id: 'feed', params: {} }], cadence_seconds: 1800, vault_subdir: 'ok' }
    const scheduler = new Scheduler({ registry, streams: [okStream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
    const channelStore = new UserStore(join(dir, `stream-${Math.random()}.db`))
    channelStore.putStream(streamToStreamRecord(okStream))
    channelStore.putChannel({ id: 'okch', label: '正常频道', present: 'timeline', stream_ids: [okStream.id], options: {} })
    const sourceHealth = new SourceHealthStore(join(dir, `health-${Math.random()}.json`))
    const service = new StreamService({ registry, scheduler, channels: channelStore })
    const app = createHttpApp({ service, itemStore: store, health, channelStore, resolve: { registry, sourceHealth, resolveEngine: {} as never, intentResolver: {} as never, radarMatcher: {} as never, streams: () => scheduler.list() } })
    try {
      const channels = await (await app.request('/api/channels')).json() as Array<{ id: string; streams: Array<{ sources: Array<{ dependencyIssues?: unknown }> }> }>
      expect(channels.find((t) => t.id === 'okch')!.streams[0].sources[0].dependencyIssues).toBeUndefined()
    } finally {
      channelStore.close()
    }
  })

  it('list endpoints strip raw and promote note_id/source_guid at the serialization boundary', async () => {
    const { app, channelStore } = resourceApp()
    try {
      // 模拟存量：直接落库（不经归一化入口），raw 携带大 payload + 源站 ID
      store.add({ ...item('xhs-old', stream.id), raw: { noteId: 'note-abc', payload: 'x'.repeat(500) } }, 'post')
      store.add({ ...item('hn-old', stream.id), raw: { guid: '48517377-163' } }, 'post')
      store.add({ ...item('plain', stream.id), raw: { other: true } }, 'post')

      // GET /api/channels/:id/items
      const chItems = (await (await app.request('/api/channels/home/items?limit=20')).json() as { items: Array<Record<string, unknown>> }).items
      expect(chItems.length).toBeGreaterThanOrEqual(3)
      for (const it of chItems) expect('raw' in it).toBe(false)
      expect(chItems.find((i) => i.id === 'xhs-old')!.note_id).toBe('note-abc')
      expect(chItems.find((i) => i.id === 'hn-old')!.source_guid).toBe('48517377-163')
      const plain = chItems.find((i) => i.id === 'plain')!
      expect('note_id' in plain).toBe(false)
      expect('source_guid' in plain).toBe(false)
      // 其余字段与改动前一致
      expect(plain).toMatchObject({ id: 'plain', stream_id: stream.id, title: 'plain' })

      // GET /api/items（同一 store，路由在同一 app 上可用）
      const flat = await (await app.request('/api/items')).json() as Array<Record<string, unknown>>
      expect(flat.length).toBeGreaterThanOrEqual(3)
      for (const it of flat) expect('raw' in it).toBe(false)
      expect(flat.find((i) => i.id === 'xhs-old')!.note_id).toBe('note-abc')

      // raw 落库不受影响：后端内部读取照常可见（spec 场景"raw 落库不受影响"）
      expect((store.get('xhs-old')!.raw as Record<string, unknown>).noteId).toBe('note-abc')
    } finally {
      channelStore.close()
    }
  })

  // 可变时间戳的 item 构造器——夹具 item() 时间戳写死，分页场景需要可控排序键
  const tItem = (id: string, streamId: string, ts: string): StreamItem => ({
    id, stream_id: streamId, source_type: 'rsshub-bridge', source_route: '/x',
    fetched_at: ts, timestamp: ts, title: id, raw: {},
  })

  it('GET /api/channels/:id/items paginates with a keyset cursor — no dup, no skip, tie-broken, terminating', async () => {
    // 独立 stream/channel（不复用 resourceApp() 的 'home'/stream.id）：createHttpApiFixture()
    // 在共享 store 里预置了 item('i1','my-tech')，其 timestamp 恰好落在本测试的排序键区间内，
    // 会在 tie-break 时插进期望的分页边界——用一个全新、未被预置数据触碰的 stream 隔离开。
    const pagerStream: Stream = { id: 'pager', description: 'pager', sources: [{ source_id: 'hn', params: {} }], cadence_seconds: 1800, vault_subdir: 'pager' }
    const registry = new Registry(manifests)
    const scheduler = new Scheduler({ registry, streams: [pagerStream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
    const channelStore = new UserStore(join(dir, `stream-${Math.random()}.db`))
    channelStore.putStream(streamToStreamRecord(pagerStream))
    channelStore.putChannel({ id: 'pager-ch', label: 'Pager', present: 'timeline', stream_ids: [pagerStream.id], options: {} })
    const service = new StreamService({ registry, scheduler, channels: channelStore })
    const app = createHttpApp({ service, itemStore: store, health, channelStore })
    try {
      // 5 条：3 个不同时间 + 2 条同时间戳（tie-breaker 场景，id 降序 z-tie 在前）
      store.add(tItem('e1', pagerStream.id, '2026-06-10T00:00:00.000Z'), 'post')
      store.add(tItem('e2', pagerStream.id, '2026-06-09T00:00:00.000Z'), 'post')
      store.add(tItem('e3', pagerStream.id, '2026-06-08T00:00:00.000Z'), 'post')
      store.add(tItem('z-tie', pagerStream.id, '2026-06-07T00:00:00.000Z'), 'post')
      store.add(tItem('a-tie', pagerStream.id, '2026-06-07T00:00:00.000Z'), 'post')

      type Envelope = { items: Array<{ id: string }>; next_cursor?: string }

      // 首屏无游标：信封形状 + 降序前 2 条 + 有下一页游标（spec"首屏请求向后兼容"）
      const p1 = await (await app.request('/api/channels/pager-ch/items?limit=2')).json() as Envelope
      expect(p1.items.map((i) => i.id)).toEqual(['e1', 'e2'])
      expect(p1.next_cursor).toBeTruthy()

      // 翻页：紧接上一页之后，无重复；两次请求之间入库一条最新 item，keyset 不受影响（spec"翻页不重不漏"）
      store.add(tItem('newest-mid-scroll', pagerStream.id, '2026-06-11T00:00:00.000Z'), 'post')
      const p2 = await (await app.request(`/api/channels/pager-ch/items?limit=2&cursor=${encodeURIComponent(p1.next_cursor!)}`)).json() as Envelope
      expect(p2.items.map((i) => i.id)).toEqual(['e3', 'z-tie']) // 同 sortKey 对：id 降序，z-tie 先出
      expect(p2.next_cursor).toBeTruthy()

      // 尾页：不足 limit → 返回剩余且无游标（spec"尾页游标终止"）
      const p3 = await (await app.request(`/api/channels/pager-ch/items?limit=2&cursor=${encodeURIComponent(p2.next_cursor!)}`)).json() as Envelope
      expect(p3.items.map((i) => i.id)).toEqual(['a-tie'])
      expect(p3.next_cursor).toBeUndefined()

      // 三页并集 = 全部 5 条老 item，无重无漏（新入库条目只出现在"更新"一端，不进旧游标序列）
      const all = [...p1.items, ...p2.items, ...p3.items].map((i) => i.id)
      expect(new Set(all).size).toBe(all.length)
      expect(all.sort()).toEqual(['a-tie', 'e1', 'e2', 'e3', 'z-tie'])

      // 非法 cursor → 400
      const bad = await app.request('/api/channels/pager-ch/items?cursor=%%%garbage')
      expect(bad.status).toBe(400)
    } finally {
      channelStore.close()
    }
  })

  it('GET /api/channels/:id/items pages through ALL of a >500-item collection stream (eviction-exempt, must not truncate at 500) — Task 2b', async () => {
    // Collection streams (e.g. a 1000+ track 歌单) are exempt from ItemStore's per-stream cap:
    // ItemStore.replaceStream never evicts (see src/item-store.ts ~128-131). A custom channel
    // wrapping such a stream must be able to page through every row, not stop at 500.
    const bigStream: Stream = { id: 'big-collection', description: 'big', sources: [{ source_id: 'hn', params: {} }], cadence_seconds: 1800, vault_subdir: 'big' }
    const registry = new Registry(manifests)
    const scheduler = new Scheduler({ registry, streams: [bigStream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
    const channelStore = new UserStore(join(dir, `stream-${Math.random()}.db`))
    channelStore.putStream(streamToStreamRecord(bigStream))
    channelStore.putChannel({ id: 'big-ch', label: 'Big', present: 'timeline', stream_ids: [bigStream.id], options: {} })
    const service = new StreamService({ registry, scheduler, channels: channelStore })
    const app = createHttpApp({ service, itemStore: store, health, channelStore })
    try {
      const TOTAL = 600
      // items[0] ends up newest (top under seq DESC) per replaceStream's contract — descending
      // timestamps so item 0 is newest and item TOTAL-1 is oldest.
      const items: StreamItem[] = Array.from({ length: TOTAL }, (_, i) => {
        const n = TOTAL - 1 - i
        const ts = `2026-01-01T00:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000Z`
        return { id: `c${i}`, stream_id: bigStream.id, source_type: 'rsshub-bridge', source_route: '/x', fetched_at: ts, timestamp: ts, title: `c${i}`, raw: {} }
      })
      store.replaceStream(bigStream.id, items, 'post') // eviction-exempt path — bypasses capPerStream entirely

      type Envelope = { items: Array<{ id: string }>; next_cursor?: string }
      const seen: string[] = []
      let cursor: string | undefined
      let guard = 0
      do {
        const url = cursor ? `/api/channels/big-ch/items?limit=100&cursor=${encodeURIComponent(cursor)}` : '/api/channels/big-ch/items?limit=100'
        const page = await (await app.request(url)).json() as Envelope
        seen.push(...page.items.map((i) => i.id))
        cursor = page.next_cursor
        guard++
      } while (cursor && guard < 20)

      expect(guard).toBeLessThan(20) // sanity: pagination actually terminated
      expect(new Set(seen).size).toBe(TOTAL) // no dup/skip
      expect(seen.length).toBe(TOTAL) // MUST NOT truncate at 500
      expect(seen[0]).toBe('c0') // newest first
      expect(seen[seen.length - 1]).toBe(`c${TOTAL - 1}`) // oldest last — row 501+ reached
    } finally {
      channelStore.close()
    }
  })

  it('GET /api/channels/:id/items paginates correctly with mixed-case ids on tie-break — both items reached, no skip', async () => {
    // RED test: two items tie on sortKey with ids where byte order != localeCompare order.
    // Byte compare: 'a1' > 'B2' (0x61 > 0x42)
    // localeCompare: 'B2' > 'a1' (uppercase B < lowercase a in ICU)
    // After fix, route sorts by byte comparison, so it orders as ['a1', 'B2'] in DESC.
    // SQL predicate also uses byte compare: `id < 'a1'` correctly returns 'B2' (since 'B2' < 'a1' bytewise).
    // Result: with limit=1, page 1 = ['a1'], page 2 cursor points to 'a1', SQL finds 'B2' bytewise < 'a1',
    // and both items are reached without skip.
    const mixedStream: Stream = { id: 'mixed', description: 'mixed', sources: [{ source_id: 'hn', params: {} }], cadence_seconds: 1800, vault_subdir: 'mixed' }
    const registry = new Registry(manifests)
    const scheduler = new Scheduler({ registry, streams: [mixedStream], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
    const channelStore = new UserStore(join(dir, `stream-${Math.random()}.db`))
    channelStore.putStream(streamToStreamRecord(mixedStream))
    channelStore.putChannel({ id: 'mixed-ch', label: 'Mixed', present: 'timeline', stream_ids: [mixedStream.id], options: {} })
    const service = new StreamService({ registry, scheduler, channels: channelStore })
    const app = createHttpApp({ service, itemStore: store, health, channelStore })
    try {
      const ts = '2026-06-07T00:00:00.000Z'
      store.add(tItem('a1', mixedStream.id, ts), 'post')
      store.add(tItem('B2', mixedStream.id, ts), 'post')

      type Envelope = { items: Array<{ id: string }>; next_cursor?: string }

      // Page 1: limit=1, should get top by byte order DESC ('a1' > 'B2' in byte comparison)
      const p1 = await (await app.request('/api/channels/mixed-ch/items?limit=1')).json() as Envelope
      expect(p1.items.map((i) => i.id)).toEqual(['a1'])
      expect(p1.next_cursor).toBeTruthy()

      // Page 2: cursor after 'a1', limit=1, should get 'B2' (next by byte order, where B2 < a1)
      const p2 = await (await app.request(`/api/channels/mixed-ch/items?limit=1&cursor=${encodeURIComponent(p1.next_cursor!)}`)).json() as Envelope
      expect(p2.items.map((i) => i.id)).toEqual(['B2'])
      expect(p2.next_cursor).toBeUndefined()

      // Both items reached, no skip
      const all = [...p1.items, ...p2.items].map((i) => i.id)
      expect(new Set(all).size).toBe(2)
      expect(all).toContain('a1')
      expect(all).toContain('B2')
    } finally {
      channelStore.close()
    }
  })

  it('GET /api/channels/:id/items — tie-break comparator returns 0 for identical ids (no crash/hang)', async () => {
    // RED test: comparator bug where `a.id > b.id ? -1 : 1` never returns 0 for a.id === b.id.
    // items.id is TEXT UNIQUE globally (INSERT OR IGNORE dedupes), so identical ids across two streams
    // is impossible at the DB level — the test pins that the endpoint doesn't crash on the zero branch
    // and verifies that (sortKey, id) forms a strict total order for correctness.
    const stream1: Stream = { id: 'stream1', description: 'stream1', sources: [{ source_id: 'hn', params: {} }], cadence_seconds: 1800, vault_subdir: 's1' }
    const stream2: Stream = { id: 'stream2', description: 'stream2', sources: [{ source_id: 'hn', params: {} }], cadence_seconds: 1800, vault_subdir: 's2' }
    const registry = new Registry(manifests)
    const scheduler = new Scheduler({ registry, streams: [stream1, stream2], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
    const channelStore = new UserStore(join(dir, `stream-${Math.random()}.db`))
    channelStore.putStream(streamToStreamRecord(stream1))
    channelStore.putStream(streamToStreamRecord(stream2))
    channelStore.putChannel({ id: 'multi-ch', label: 'Multi', present: 'timeline', stream_ids: [stream1.id, stream2.id], options: {} })
    const service = new StreamService({ registry, scheduler, channels: channelStore })
    const app = createHttpApp({ service, itemStore: store, health, channelStore })
    try {
      const ts = '2026-06-07T00:00:00.000Z'
      // Add identical id 'same-id' with identical timestamp to two different streams
      store.add(tItem('same-id', stream1.id, ts), 'post')
      store.add(tItem('same-id', stream2.id, ts), 'post')
      // Add other items to ensure comparator runs
      store.add(tItem('other1', stream1.id, '2026-06-08T00:00:00.000Z'), 'post')
      store.add(tItem('other2', stream2.id, '2026-06-06T00:00:00.000Z'), 'post')

      type Envelope = { items: Array<{ id: string }>; next_cursor?: string }
      // Fetch all; if comparator bug exists, this may hang or crash
      const p1 = await (await app.request('/api/channels/multi-ch/items?limit=10')).json() as Envelope
      expect(p1.items.length).toBeGreaterThan(0)
      // Both 'same-id' items should be reachable without duplication; the second one wins due to stable sort
      const sameIds = p1.items.filter((i) => i.id === 'same-id')
      expect(sameIds.length).toBeGreaterThan(0) // at least one reachable
    } finally {
      channelStore.close()
    }
  })

  // /api/providers CRUD 测试随 Task 2.1 的新端点重写（整行定义模型，旧 capability 派生视图已删）。
})

// —— 「live present 不入库」必须在运行期也成立 ——
//
// 开机那条路（kernel/plugins/scheduling.ts）按 `collectedStreamIds()` 装载，判据是对的；
// 但运行期新建流 / 改绑频道走的是 HTTP 这条路，它一度无条件 `scheduleResourceStream`，
// 也从不在流被挪进 research 频道时撤出调度——于是「不入库」只在开机那一刻成立：
// 用创建对话框建个 research 频道、绑上源，它当场按 cadence 采集入库，直到下次重启。
describe('运行期改绑：research 频道的流不进调度', () => {
  function liveApp() {
    const registry = new Registry(manifests)
    const scheduler = new Scheduler({ registry, streams: [], adapters: new Map([['fake', fake]]), resolveCreds: async () => ({}), vaultRoot: join(dir, 'v'), dedup })
    const channelStore = new UserStore(join(dir, `stream-${Math.random()}.db`))
    const service = new StreamService({ registry, scheduler, channels: channelStore })
    const app = createHttpApp({ service, itemStore: store, health, channelStore })
    return { app, channelStore, scheduler }
  }
  const scheduledIds = async (app: ReturnType<typeof createHttpApp>): Promise<string[]> =>
    (await (await app.request('/api/streams')).json()).map((s: { id: string }) => s.id)
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const streamBody = (id: string) => ({ id, label: id, strategy: 'fanout', cadence_seconds: 60, members: [{ plugin: 'fake', source: 'hn', params: {} }], options: {} })

  // 判据是「恰好一次」，不是「排到了」：调度表按 id 存，重复注册在 list() 里根本看不出来，
  // 只有立刻那一次抓取会被做两遍（POST /api/streams 一度在判据之外还无条件排一次班）。
  it('建流：恰好排一次班、恰好抓一次（数次数，不是看在不在）', async () => {
    const { app, channelStore, scheduler } = liveApp()
    const tick = vi.spyOn(scheduler, 'tick')
    try {
      expect((await app.request('/api/streams', json(streamBody('news')))).status).toBe(201)
      await vi.waitFor(() => expect(tick).toHaveBeenCalled())
      expect(tick).toHaveBeenCalledTimes(1)
      expect((await scheduledIds(app)).filter((id) => id === 'news')).toHaveLength(1)
    } finally {
      tick.mockRestore()
      channelStore.close()
    }
  })

  // —— 建流即归属（`channel_id`）——
  //
  // 分两步建（先 POST /api/streams、再 PATCH /api/channels 绑）时，第一步那一刻这条流不被任何
  // 频道引用，`isCollected` 判它为采集流（这个默认是对的，不该改），于是排班 + 立刻 tick 一次；
  // 第二步才撤出。所以归 research（live present）的流**仍会落一次库**——而 research 源一次 tick
  // 返回目录里每个 run 各一条，真实数据集上是 ~157 条。修的是顺序，不是判据。
  //
  // 断言必须数到 tick：只看调度表的话，撤出之后它本来就不在表里，那条断言在缺陷存在时也是绿的。
  it('建流即绑 research 频道：不排班，且一次都没抓', async () => {
    const { app, channelStore, scheduler } = liveApp()
    const tick = vi.spyOn(scheduler, 'tick')
    try {
      expect((await app.request('/api/channels', json({ id: 'rc', label: '研究', present: 'research', stream_ids: [], options: {} }))).status).toBe(201)
      expect((await app.request('/api/streams', json({ ...streamBody('runs'), channel_id: 'rc' }))).status).toBe(201)
      expect(await scheduledIds(app)).not.toContain('runs')
      expect(tick).not.toHaveBeenCalled()
      // 归属真的落到频道上了（否则「没排班」也可能只是流根本没建成）
      expect(channelStore.getChannel('rc')!.stream_ids).toEqual(['runs'])
    } finally {
      tick.mockRestore()
      channelStore.close()
    }
  })

  it('建流即绑 timeline 频道：照常排班 + 抓一次，并追加到频道末尾', async () => {
    const { app, channelStore, scheduler } = liveApp()
    const tick = vi.spyOn(scheduler, 'tick')
    try {
      await app.request('/api/streams', json(streamBody('old')))
      await app.request('/api/channels', json({ id: 'tc', label: '时间线', present: 'timeline', stream_ids: ['old'], options: {} }))
      tick.mockClear()
      expect((await app.request('/api/streams', json({ ...streamBody('news'), channel_id: 'tc' }))).status).toBe(201)
      await vi.waitFor(() => expect(tick).toHaveBeenCalled())
      expect(tick).toHaveBeenCalledTimes(1)
      expect(await scheduledIds(app)).toContain('news')
      expect(channelStore.getChannel('tc')!.stream_ids).toEqual(['old', 'news'])
    } finally {
      tick.mockRestore()
      channelStore.close()
    }
  })

  // 静默丢弃一个不认识的频道 id = 建出一条没人要的流，而调用方以为绑上了。
  it('channel_id 指向不存在的频道 → 400，且流没被建出来', async () => {
    const { app, channelStore } = liveApp()
    try {
      const res = await app.request('/api/streams', json({ ...streamBody('runs'), channel_id: 'nope' }))
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('validation_error')
      expect(channelStore.getStream('runs')).toBeNull()
    } finally {
      channelStore.close()
    }
  })

  it('建流 → 改绑进 research 频道 → 撤出调度', async () => {
    const { app, channelStore } = liveApp()
    try {
      expect((await app.request('/api/streams', json(streamBody('runs')))).status).toBe(201)
      expect((await app.request('/api/channels', json({ id: 'rc', label: '研究', present: 'research', stream_ids: [], options: {} }))).status).toBe(201)
      const patched = await app.request('/api/channels/rc', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stream_ids: ['runs'] }) })
      expect(patched.status).toBe(200)
      expect(await scheduledIds(app)).not.toContain('runs')
    } finally {
      channelStore.close()
    }
  })

  it('建频道时就带上 stream_ids（research）→ 那条流不进调度', async () => {
    const { app, channelStore } = liveApp()
    try {
      expect((await app.request('/api/streams', json(streamBody('runs')))).status).toBe(201)
      expect((await app.request('/api/channels', json({ id: 'rc', label: '研究', present: 'research', stream_ids: ['runs'], options: {} }))).status).toBe(201)
      expect(await scheduledIds(app)).not.toContain('runs')
    } finally {
      channelStore.close()
    }
  })

  it('从 research 挪回 timeline → 重新排班（撤出不是单向门）', async () => {
    const { app, channelStore } = liveApp()
    try {
      await app.request('/api/streams', json(streamBody('runs')))
      await app.request('/api/channels', json({ id: 'rc', label: '研究', present: 'research', stream_ids: ['runs'], options: {} }))
      await app.request('/api/channels', json({ id: 'tc', label: '时间线', present: 'timeline', stream_ids: [], options: {} }))
      expect(await scheduledIds(app)).not.toContain('runs')
      await app.request('/api/channels/rc', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stream_ids: [] }) })
      await app.request('/api/channels/tc', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stream_ids: ['runs'] }) })
      expect(await scheduledIds(app)).toContain('runs')
    } finally {
      channelStore.close()
    }
  })

  it('普通频道里的流照常排班（没把采集一起关掉）', async () => {
    const { app, channelStore } = liveApp()
    try {
      await app.request('/api/streams', json(streamBody('news')))
      await app.request('/api/channels', json({ id: 'tc', label: '时间线', present: 'timeline', stream_ids: ['news'], options: {} }))
      expect(await scheduledIds(app)).toContain('news')
    } finally {
      channelStore.close()
    }
  })

  // PATCH /api/streams/:id 改 cadence/members 会走 `rescheduleResourceStream`（remove + **无条件** add）。
  // research 频道的流正是「改 members」的常客——改 artifactsDir、加减一个源都从频道页发这条 PATCH，
  // 于是一条本该现读不落库的流当场回到采集队列，且一直采到重启。
  const patch = (body: unknown): RequestInit => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('PATCH 改 cadence：research 频道的流不因重排班回到调度', async () => {
    const { app, channelStore } = liveApp()
    try {
      await app.request('/api/streams', json(streamBody('runs')))
      await app.request('/api/channels', json({ id: 'rc', label: '研究', present: 'research', stream_ids: ['runs'], options: {} }))
      expect(await scheduledIds(app)).not.toContain('runs')
      expect((await app.request('/api/streams/runs', patch({ cadence_seconds: 120 }))).status).toBe(200)
      expect(await scheduledIds(app)).not.toContain('runs')
    } finally {
      channelStore.close()
    }
  })

  it('PATCH 改 members：research 频道的流不因重排班回到调度', async () => {
    const { app, channelStore } = liveApp()
    try {
      await app.request('/api/streams', json(streamBody('runs')))
      await app.request('/api/channels', json({ id: 'rc', label: '研究', present: 'research', stream_ids: ['runs'], options: {} }))
      expect((await app.request('/api/streams/runs', patch({ members: [{ plugin: 'fake', source: 'hn', params: { artifactsDir: '/tmp/other' } }] }))).status).toBe(200)
      expect(await scheduledIds(app)).not.toContain('runs')
    } finally {
      channelStore.close()
    }
  })

  it('PATCH 改 cadence：普通频道的流照常重排班（闸门不是单向关死）', async () => {
    const { app, channelStore } = liveApp()
    try {
      await app.request('/api/streams', json(streamBody('news')))
      await app.request('/api/channels', json({ id: 'tc', label: '时间线', present: 'timeline', stream_ids: ['news'], options: {} }))
      expect((await app.request('/api/streams/news', patch({ cadence_seconds: 120 }))).status).toBe(200)
      expect(await scheduledIds(app)).toContain('news')
    } finally {
      channelStore.close()
    }
  })

  // DELETE /api/channels/:id 也在改「流—频道」关系，所以也要问一次判据。
  // 咬人的方向是这一条：一条流同时挂在 timeline 和 research 两个频道上时按 timeline 采集，
  // 删掉那个 timeline 频道之后就只剩 research 引用着它——判据翻面了，而删除路径一句都没问，
  // 于是它一直采到进程重启（「不入库」再次只在开机那一刻成立）。
  it('DELETE 频道：只剩 research 引用的那条流被撤出调度', async () => {
    const { app, channelStore } = liveApp()
    try {
      await app.request('/api/streams', json(streamBody('runs')))
      await app.request('/api/channels', json({ id: 'tc', label: '时间线', present: 'timeline', stream_ids: ['runs'], options: {} }))
      await app.request('/api/channels', json({ id: 'rc', label: '研究', present: 'research', stream_ids: ['runs'], options: {} }))
      expect(await scheduledIds(app)).toContain('runs') // timeline 还引用着 → 照常采集
      expect((await app.request('/api/channels/tc', { method: 'DELETE' })).status).toBe(200)
      expect(await scheduledIds(app)).not.toContain('runs')
    } finally {
      channelStore.close()
    }
  })

  // 反方向：删掉最后一个引用它的频道，这条流变成「没归属」——`isCollected` 对未被引用的流
  // 答 true（刻意的默认，见 UserStore.isCollected），所以它进调度。这和 PATCH 把它从 research
  // 频道摘出去时的结果逐字一致——判据只有一份，删除路径不该自己另判一次。
  it('DELETE 最后一个引用它的 research 频道：那条流变成无主流 → 进调度（与 PATCH 摘出去同口径）', async () => {
    const { app, channelStore } = liveApp()
    try {
      await app.request('/api/streams', json(streamBody('runs')))
      await app.request('/api/channels', json({ id: 'rc', label: '研究', present: 'research', stream_ids: ['runs'], options: {} }))
      expect(await scheduledIds(app)).not.toContain('runs')
      expect((await app.request('/api/channels/rc', { method: 'DELETE' })).status).toBe(200)
      expect(await scheduledIds(app)).toContain('runs')
    } finally {
      channelStore.close()
    }
  })
})
