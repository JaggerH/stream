/**
 * 严格输入闸盖在 `app.ts` 写入面上的那一层（第二批）。
 *
 * 钉的是同一件事：**写错一个键名，不许回 200**。这类缺陷在界面上永远撞不到（前端字段名写死），
 * 只有 agent / 脚本 / 手写 curl 撞得到，而它们拿到的是一份看起来完全正常的响应——
 * 形状与三次活体事故见 `http/strict-input.ts` 的头注。
 *
 * 两个方向都要钉，缺一个这道闸就不算装好：
 *  - 写错的键 → 400 + 「不认识的字段」+ 该写哪个 + **副作用一个没发生**；
 *  - 名单本身没写错 → 正常调用照样过得去（错列一个键名会把真调用挡在门外，症状是"这个接口坏了"）。
 *
 * 断言里那句 `不认识的字段` 是必须的：旧的形状校验消息里常常恰好含着那个键名
 * （`shows[] required` 含 "show"），只断言"消息里出现这个词"会假绿。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createHttpApp } from './app.ts'

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

/** 每一个"闸没拦住就会发生"的副作用各挂一个探针；闸生效 = 这张单子始终是空的。 */
let calls: string[] = []
const spy = <T>(name: string, ret: T) => (): T => { calls.push(name); return ret }

function buildApp(): ReturnType<typeof createHttpApp> {
  const deps = {
    service: {
      streamsResource: () => [],
      plugins: () => [],
      previewSource: spy('service.previewSource', Promise.resolve({})),
      pluginSourceDetail: () => ({ runtimeConfig: { ref: 'tmdb', fields: { apiKey: {} } } }),
    },
    itemStore: {
      get: (id: string) => (id === 'i1' ? { id: 'i1', stream_id: 'my-tech' } : undefined),
      setMuted: spy('itemStore.setMuted', undefined),
      recent: () => [],
    },
    health: async () => ({ cookies: { domains: [], updatedAt: null }, manifests: 0, streams: 0 }),
    extRelayAuth: { token: 'ext-token', extId: 'abcdefghijklmnopabcdefghijklmnop' },
    debug: { record: spy('debug.record', undefined) },
    events: { list: () => [], markRead: spy('events.markRead', undefined) },
    // providers 只要求真值（providersReady），行本身由 channelStore 答
    providers: {},
    channelStore: {
      getProvider: () => undefined,
      putProvider: spy('channelStore.putProvider', { id: 'p1' }),
      patchProvider: spy('channelStore.patchProvider', undefined),
      audioStreamIds: () => new Set<string>(),
    },
    providerBindings: { put: spy('providerBindings.put', {}), restore: () => ({}) },
    renormalizeItems: spy('renormalizeItems', { scanned: 0, rewritten: 0 }),
    recipePackageOps: {
      preview: spy('recipePackageOps.preview', Promise.resolve({})),
      install: spy('recipePackageOps.install', Promise.resolve({})),
      uninstall: spy('recipePackageOps.uninstall', Promise.resolve(true)),
    },
    pageLook: spy('pageLook', Promise.resolve({ value: 1 })),
    collections: {
      getCollection: () => ({ id: 'c1', label: '我的喜欢', domain: 'audio' }),
      createCollection: spy('collections.createCollection', { id: 'c2' }),
      renameCollection: spy('collections.renameCollection', { id: 'c1' }),
      addItems: spy('collections.addItems', []),
      addItem: spy('collections.addItem', { key: 'k' }),
      reorder: spy('collections.reorder', undefined),
      itemsOf: () => [],
    },
    watchProgress: { put: spy('watchProgress.put', { key: 'k' }), get: () => null },
    intents: { create: spy('intents.create', Promise.resolve({ id: 'in1' })), get: () => ({ id: 'in1' }), list: () => [] },
    downloadQueue: {
      enqueue: spy('downloadQueue.enqueue', undefined),
      isArchived: () => false,
      drain: async () => {},
      jobs: () => [],
    },
    setPluginEnabled: spy('setPluginEnabled', { id: 'p' }),
    sourceRuntimeConfig: { status: () => ({}), set: spy('sourceRuntimeConfig.set', Promise.resolve()) },
    harvestBrowser: { status: async () => ({}), select: spy('harvestBrowser.select', Promise.resolve({})) },
    summaryPrompt: { status: () => ({}), set: spy('summaryPrompt.set', Promise.resolve({})) },
    videoSources: { status: () => ({}), set: spy('videoSources.set', Promise.resolve({})) },
    audioArchive: {
      info: () => ({ root: '/tmp', tracks: 0 }),
      reconcileFormats: spy('audioArchive.reconcileFormats', Promise.resolve({})),
      orphans: spy('audioArchive.orphans', {}),
    },
    alist: { status: () => ({}), test: spy('alist.test', Promise.resolve({ ok: true })) },
    speakerRegistry: {
      listPersons: () => [],
      createPerson: spy('speakerRegistry.createPerson', { id: 'p1' }),
      getPerson: () => ({ id: 'p1', name: '张三' }),
      enrollFromCluster: spy('speakerRegistry.enrollFromCluster', { id: 'v1' }),
      renameInTimeline: spy('speakerRegistry.renameInTimeline', undefined),
      recomputeItemAppearances: spy('speakerRegistry.recomputeItemAppearances', undefined),
      deletePendingName: spy('speakerRegistry.deletePendingName', undefined),
      getItemTimeline: () => [],
    },
    conversions: { kinds: () => [], transcriptOf: () => undefined, list: () => ({ items: [] }) },
  }
  return createHttpApp(deps as never)
}

type Case = {
  /** 端点（报错时看得出是谁红了） */ what: string
  method: 'POST' | 'PUT' | 'PATCH'
  path: string
  /** 写错了键名的 body */ body: unknown
  /** 写错的那个键 */ wrote: string
  /** 报错必须指出该写哪个 */ meant: string
  headers?: Record<string, string>
}

/** 每条 = 一次"写错名字"的真实形状（下划线/驼峰混写、单复数、拼错一个字母）。 */
const CASES: Case[] = [
  { what: 'POST /api/ext/verify', method: 'POST', path: '/api/ext/verify', headers: { Origin: EXT_ORIGIN }, body: { nonces: 'x'.repeat(20) }, wrote: 'nonces', meant: 'nonce' },
  { what: 'POST /api/ext/debug-log', method: 'POST', path: '/api/ext/debug-log', headers: { Origin: EXT_ORIGIN }, body: { events: 'onStartup' }, wrote: 'events', meant: 'event' },
  { what: 'POST /api/events/read', method: 'POST', path: '/api/events/read', body: { id: [1] }, wrote: 'id', meant: 'ids' },
  { what: 'POST /api/sources/preview', method: 'POST', path: '/api/sources/preview', body: { source_id: 'hn' }, wrote: 'source_id', meant: 'sourceId' },
  { what: 'POST /api/providers', method: 'POST', path: '/api/providers', body: { id: 'p1', category: 'search', member: [] }, wrote: 'member', meant: 'members' },
  { what: 'PATCH /api/providers/:id', method: 'PATCH', path: '/api/providers/p1', body: { member: [] }, wrote: 'member', meant: 'members' },
  { what: 'PUT /api/provider-callsites/:id/binding', method: 'PUT', path: '/api/provider-callsites/search.default/binding', body: { provider_ids: ['a'] }, wrote: 'provider_ids', meant: 'providerIds' },
  { what: 'PATCH /api/items/:id', method: 'PATCH', path: '/api/items/i1', body: { labels: 'ad' }, wrote: 'labels', meant: 'label' },
  { what: 'POST /api/items/renormalize', method: 'POST', path: '/api/items/renormalize', body: { stream_id: 'my-tech' }, wrote: 'stream_id', meant: 'streamId' },
  { what: 'POST /api/recipes/packages/preview', method: 'POST', path: '/api/recipes/packages/preview', body: { names: '@streamapp/x' }, wrote: 'names', meant: 'name' },
  { what: 'POST /api/recipes/packages/install', method: 'POST', path: '/api/recipes/packages/install', body: { name: '@streamapp/x', confirm: 'sha', versions: '1.0.0' }, wrote: 'versions', meant: 'version' },
  { what: 'POST /api/recipes/packages/uninstall', method: 'POST', path: '/api/recipes/packages/uninstall', body: { names: '@streamapp/x' }, wrote: 'names', meant: 'name' },
  { what: 'POST /api/facilities/:id/page/evaluations', method: 'POST', path: '/api/facilities/xhs/page/evaluations', body: { expresion: '1+1' }, wrote: 'expresion', meant: 'expression' },
  { what: 'POST /api/collections', method: 'POST', path: '/api/collections', body: { domain: 'audio', labels: '新歌单' }, wrote: 'labels', meant: 'label' },
  { what: 'PATCH /api/collections/:id', method: 'PATCH', path: '/api/collections/c1', body: { labels: '改个名' }, wrote: 'labels', meant: 'label' },
  { what: 'POST /api/collections/:id/items（顶层）', method: 'POST', path: '/api/collections/c1/items', body: { item: [{ key: 'stream:s1', title: 't' }] }, wrote: 'item', meant: 'items' },
  { what: 'POST /api/collections/:id/items（元素里）', method: 'POST', path: '/api/collections/c1/items', body: { items: [{ key: 'stream:s1', titel: 't' }] }, wrote: 'titel', meant: 'title' },
  { what: 'PUT /api/collections/:id/order', method: 'PUT', path: '/api/collections/c1/order', body: { key: ['stream:s1'] }, wrote: 'key', meant: 'keys' },
  { what: 'PUT /api/collections/:id/items/:key', method: 'PUT', path: '/api/collections/c1/items/stream%3As1', body: { title: 't', duration_s: 30 }, wrote: 'duration_s', meant: 'durationS' },
  { what: 'PUT /api/watch-progress/:key', method: 'PUT', path: '/api/watch-progress/tmdb%3A1%3AS01E01', body: { position: 1, duration: 2, workKey: 'w', workTitle: 't', work_poster: 'p' }, wrote: 'work_poster', meant: 'workPoster' },
  { what: 'POST /api/intents', method: 'POST', path: '/api/intents', body: { goal: '追一部剧', stream_ids: ['s1'] }, wrote: 'stream_ids', meant: 'streamIds' },
  { what: 'POST /api/downloads', method: 'POST', path: '/api/downloads', body: { item_id: 'i1' }, wrote: 'item_id', meant: 'itemId' },
  { what: 'PUT /api/plugins/:pluginId/enabled', method: 'PUT', path: '/api/plugins/xhs/enabled', body: { enable: true }, wrote: 'enable', meant: 'enabled' },
  { what: 'POST /api/source-runtime-config/status', method: 'POST', path: '/api/source-runtime-config/status', body: { pluginId: 'fake', sourceId: 'bili', refs: 'tmdb' }, wrote: 'refs', meant: 'ref' },
  { what: 'PUT /api/source-runtime-config', method: 'PUT', path: '/api/source-runtime-config', body: { pluginId: 'fake', sourceId: 'bili', value: { apiKey: 'k' } }, wrote: 'value', meant: 'values' },
  { what: 'POST /api/source-runtime-config/provision', method: 'POST', path: '/api/source-runtime-config/provision', body: { pluginId: 'fake', sourceId: 'bili', param: { name: 'x' } }, wrote: 'param', meant: 'params' },
  { what: 'PUT /api/settings/harvest-browser', method: 'PUT', path: '/api/settings/harvest-browser', body: { exec: '/usr/bin/chrome' }, wrote: 'exec', meant: 'exe' },
  { what: 'PUT /api/settings/summary-prompt', method: 'PUT', path: '/api/settings/summary-prompt', body: { prompts: '总结一下' }, wrote: 'prompts', meant: 'prompt' },
  { what: 'PUT /api/settings/video-sources', method: 'PUT', path: '/api/settings/video-sources', body: { tmdb_api_key: 'k' }, wrote: 'tmdb_api_key', meant: 'tmdbApiKey' },
  { what: 'POST /api/settings/archive/reconcile-formats', method: 'POST', path: '/api/settings/archive/reconcile-formats', body: { applied: true }, wrote: 'applied', meant: 'apply' },
  { what: 'POST /api/settings/archive/orphans', method: 'POST', path: '/api/settings/archive/orphans', body: { applied: true }, wrote: 'applied', meant: 'apply' },
  { what: 'POST /api/voiceprint/persons', method: 'POST', path: '/api/voiceprint/persons', body: { names: '张三' }, wrote: 'names', meant: 'name' },
  { what: 'POST /api/voiceprint/…/enroll', method: 'POST', path: '/api/voiceprint/item/i1/clusters/SPEAKER_00/enroll', body: { person_id: 'p1' }, wrote: 'person_id', meant: 'personId' },
]

const send = async (app: ReturnType<typeof createHttpApp>, c: Case): Promise<Response> =>
  app.request(c.path, {
    method: c.method,
    headers: { 'content-type': 'application/json', ...(c.headers ?? {}) },
    body: JSON.stringify(c.body),
  })

beforeEach(() => { calls = [] })

describe('严格输入闸 · app.ts 写入面', () => {
  for (const c of CASES) {
    it(`${c.what}：写 \`${c.wrote}\` → 400 并指出该写 \`${c.meant}\``, async () => {
      const res = await send(buildApp(), c)
      expect(res.status).toBe(400)
      const msg = ((await res.json()) as { error: { message: string } }).error.message
      // 「不认识的字段」不能省：旧的形状校验消息里常常恰好也含着那个键名，只断言键名会假绿。
      expect(msg).toContain('不认识的字段')
      expect(msg).toContain(c.wrote)
      expect(msg).toContain(c.meant)
    })
  }

  // 网盘底座是内置托管的，没有可写的配置：写端点不存在，探测也不收临时地址/凭据
  // （以前收 url+token，等于留了一个「拿任意凭据打任意地址」的口）。
  it('PUT /api/settings/alist 不存在；POST …/test 带任何字段 → 400，探测没发生', async () => {
    const app = buildApp()
    const put = await app.request('/api/settings/alist', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://a', token: 't' }),
    })
    expect(put.status).toBe(404)
    const probe = await app.request('/api/settings/alist/test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://a', token: 't' }),
    })
    expect(probe.status).toBe(400)
    expect(((await probe.json()) as { error: { message: string } }).error.message).toContain('不认识的字段')
    expect(calls).toEqual([])
  })

  it('POST /api/settings/alist/test 空体 → 探测现役那一份', async () => {
    const app = buildApp()
    const res = await app.request('/api/settings/alist/test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(res.status).toBe(200)
    expect(calls).toEqual(['alist.test'])
  })

  it('全部写错的请求打完，一个副作用都没发生', async () => {
    const app = buildApp()
    for (const c of CASES) await send(app, c)
    expect(calls).toEqual([])
  })
})

/**
 * 反方向：名单**自己**写错会把真调用挡在门外，症状是"这个接口坏了"，比静默丢弃更响但一样是缺陷。
 * 挑几条键最多、最容易列漏的路走一遍正常 body。
 */
describe('严格输入闸 · 正常调用照样过得去', () => {
  const ok = async (c: Omit<Case, 'wrote' | 'meant'>): Promise<void> => {
    const res = await send(buildApp(), { ...c, wrote: '', meant: '' })
    const text = await res.text()
    expect(`${c.what} → ${res.status} ${text}`).not.toContain('不认识的字段')
  }

  it('PUT /api/watch-progress/:key 七个字段全给', async () => {
    await ok({
      what: 'watch-progress', method: 'PUT', path: '/api/watch-progress/tmdb%3A1%3AS01E01',
      body: { position: 1, duration: 2, workKey: 'w', workTitle: 't', workPoster: 'p', epLabel: 'S01E01', channelId: 'ch' },
    })
    expect(calls).toContain('watchProgress.put')
  })

  it('POST /api/downloads 带 track 子对象', async () => {
    await ok({
      what: 'downloads', method: 'POST', path: '/api/downloads',
      body: { track: { platform: 'netease', trackId: '1', title: 't', artist: 'a', album: 'b' }, skipArchived: true },
    })
    expect(calls).toContain('downloadQueue.enqueue')
  })

  it('POST /api/collections/:id/items 元素带全套元数据', async () => {
    await ok({
      what: 'collections items', method: 'POST', path: '/api/collections/c1/items',
      body: { items: [{ key: 'stream:s1', title: 't', poster: 'p', artist: 'a', album: 'b', durationS: 3, sourceUrl: 'u' }] },
    })
    expect(calls).toContain('collections.addItems')
  })

  it('PATCH /api/providers/:id 带 id（路径段才是身份，body 里的 id 被显式丢弃，不该被闸挡）', async () => {
    const res = await send(buildApp(), {
      what: 'providers', method: 'PATCH', path: '/api/providers/p1',
      body: { id: 'p1', members: [] }, wrote: '', meant: '',
    })
    expect(await res.text()).not.toContain('不认识的字段')
    expect(calls).toContain('channelStore.patchProvider')
  })

  it('POST /api/ext/debug-log 扩展真实发的那份 body', async () => {
    await ok({
      what: 'debug-log', method: 'POST', path: '/api/ext/debug-log', headers: { Origin: EXT_ORIGIN },
      body: { event: 'ledger-cleared', summary: '账本已作废', ok: false, fields: [{ label: 'members', value: 3 }] },
    })
    expect(calls).toContain('debug.record')
  })
})
