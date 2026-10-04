import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { backendToolNames, createMcpServer, type McpExtras } from './server.ts'
import { StreamService, type StreamServiceLike } from './tools.ts'
import { Registry } from '../registry/registry.ts'
import { Scheduler } from '../scheduler.ts'
import { DedupStore } from '../dedup-store.ts'
import type { Adapter } from '../adapters/types.ts'
import type { SourceManifest } from '../manifest/types.ts'
import type { Stream } from '../streams/types.ts'
import { UserStore } from '../store/user-store.ts'
import type { ToolDef } from '../../shared/capability/types.ts'
import { createCapabilityHost } from '../capabilities/host.ts'

/** `isCommunitySource` 是 McpExtras 上唯一的必填格（搜索分档谓词）。本文件没有一条用例碰
 *  content_search 的排序，统一给恒 false；要验分档去 content-search-slim.test.ts。 */
const noTier: McpExtras = { isCommunitySource: () => false }

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

const fake: Adapter = { id: 'fake', init: async () => {}, fetch: async () => [{ guid: '1', title: 't' }] }

const manifests: SourceManifest[] = [
  mk({ id: 'hn-best', description: 'hacker news tech', topics: ['tech'] }),
  mk({ id: 'bili', pluginId: 'rsshub', description: 'bilibili dynamic', topics: ['bilibili'] }),
]

const stream: Stream = {
  id: 'my-tech',
  description: 'my tech feed',
  sources: [{ source_id: 'hn-best', params: {} }],
  cadence_seconds: 1800,
  vault_subdir: 'tech',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const text = (r: any) => (r.content as Array<{ text: string }>)[0].text

describe('MCP server (real client over InMemoryTransport)', () => {
  let dir: string
  let dedup: DedupStore
  let client: Client

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-'))
    dedup = new DedupStore(join(dir, 'dedup.db'))
    const scheduler = new Scheduler({
      registry: new Registry(manifests),
      streams: [stream],
      adapters: new Map([['fake', fake]]),
      resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'),
      dedup,
    })
    const service = new StreamService({
      registry: new Registry(manifests),
      scheduler,
      channels: new UserStore(join(dir, 'stream.db')),
    })
    const server = createMcpServer(service, noTier)
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)
  })
  afterEach(async () => {
    await client.close()
    dedup.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('advertises exactly the fixed tool surface', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'stream_categories',
      'stream_fetch_url',
      'stream_list',
      'stream_read',
      'stream_search',
      'stream_sources',
      'stream_status',
      'stream_subscribe',
      'stream_unsubscribe',
      // 由 source id 建流的便捷版（bespoke）。和 stream_subscribe 不是重复：那个要调用方
      // 自己造整个 Stream，这个把 id/占位名/采集策略交给 shared/subscribe 那份唯一判据。
      'subscribe_source',
    ])
  })

  // 两个建订阅的工具摆在一起，低层那个（stream_subscribe）没有 channel 参数，模型选中它就
  // **没有任何办法**把流放进用户点名的频道。活体撞过：模型第一次调用就传了 `channel`，被
  // schema 打回，它把 channel 删掉重试，于是流无归属地建了出来、落进默认位置。
  // 描述里那段指路是唯一的补救（工具本身不该重叠能力），所以钉住它别被静默删掉。
  // 注意这只证明「我们指了路」，证明不了「模型照做了」——后者只能活体看副作用（AGENT-TOOLING.md）。
  it('stream_subscribe 的描述指向 subscribe_source，并说明自己不管频道', async () => {
    const tools = (await client.listTools()).tools
    const d = tools.find((t) => t.name === 'stream_subscribe')!.description!
    expect(d).toContain('subscribe_source')
    expect(d).toMatch(/no `channel` parameter|NO `channel`/i)
    // 反向：便捷版自己得确实收 channel，否则这段指路把人指到一个同样做不到的地方去。
    expect(Object.keys(tools.find((t) => t.name === 'subscribe_source')!.inputSchema.properties ?? {})).toContain('channel')
  })

  it('stream_list returns named streams', async () => {
    const r = await client.callTool({ name: 'stream_list', arguments: {} })
    expect(text(r)).toContain('my-tech')
  })

  it('stream_search returns ranked candidates with schema', async () => {
    const r = await client.callTool({ name: 'stream_search', arguments: { intent: 'bilibili' } })
    expect(text(r)).toContain('bili')
  })

  it('stream_sources searches sources across all plugins, grouped by plugin', async () => {
    const r = await client.callTool({ name: 'stream_sources', arguments: { query: 'bilibili' } })
    const body = JSON.parse(text(r))
    expect(body.sources.map((s: { id: string }) => s.id)).toContain('bili')
    expect(body.plugins.some((p: { id: string }) => p.id === 'rsshub')).toBe(true)
  })

  it('stream_read returns items', async () => {
    const r = await client.callTool({ name: 'stream_read', arguments: { id: 'my-tech' } })
    expect(text(r)).toContain('"title"')
  })

  it('exposes streams + topics resources', async () => {
    const uris = (await client.listResources()).resources.map((r) => r.uri).sort()
    expect(uris).toEqual(['stream://streams', 'stream://topics'])
    const topics = await client.readResource({ uri: 'stream://topics' })
    expect((topics.contents[0] as { text: string }).text).toContain('tech')
  })

  it('createMcpServer accepts any object matching the StreamService public shape, not just an instance', async () => {
    // A hand-written object literal — NOT `new StreamService(...)`. Before Task 1.2, this
    // fails to typecheck: `StreamService` is a concrete class with a private `deps` field,
    // so TS structural assignability doesn't apply and object literals are rejected.
    const readOnly: StreamServiceLike = {
      resolvePluginAndSource: (id) => ({ pluginId: 'custom', sourceId: id }),
      list: () => [{ id: 'my-tech', description: 'my tech feed' }],
      categories: () => [],
      plugins: () => [],
      pluginSources: () => ({ plugin: {} as never, sources: [], groups: [], facets: { categories: [], capabilities: [], facilities: [] } }),
      searchAllPluginSources: () => ({ sources: [], plugins: [], facets: { categories: [], capabilities: [] } }),
      pluginSourceDetail: () => undefined,
      search: () => [],
      read: async () => [{ guid: '1', title: 't' }],
      previewStream: async () => ({ items: [], errors: [] }) as never,
      readStreamInSourceOrder: async () => ({ items: [], errors: [] }) as never,
      previewSource: async () => ({ items: [], errors: [] }) as never,
      refreshStream: async () => ({ fetched: 0, written: 0 }) as never,
      sources: () => [],
      subscribe: () => {},
      ensureChannel: () => {},
      listChannels: () => [],
      scheduleFlowStream: () => {},
      scheduleResourceStream: () => {},
      updateResourceStream: () => {},
      rescheduleResourceStream: () => {},
      unscheduleResourceStream: () => {},
      unsubscribe: () => true,
      status: () => [],
      streamsResource: () => [],
      topics: () => [],
    }
    const server = createMcpServer(readOnly, noTier)
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const c = new Client({ name: 'test2', version: '0' })
    await c.connect(clientT)
    const names = (await c.listTools()).tools.map((t) => t.name)
    expect(names).toContain('stream_list')
    const result = await c.callTool({ name: 'stream_list', arguments: {} })
    expect(text(result)).toContain('my-tech')
    await c.close()
  })
})

describe('MCP parse extra', () => {
  it('exposes an extract tool that serves the conversion cache when wired', async () => {
    const extract = (item: string) => ({ itemId: item, status: 'done', result: { text: '# 研报\n\n净利润 42', format: 'markdown', branch: 'ocr' } })
    // the extract tool path never touches the service, so a minimal cast is sufficient
    const server = createMcpServer({} as unknown as StreamService, { ...noTier, extract })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)

    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('extract')
    const r = await client.callTool({ name: 'extract', arguments: { item: 'i1' } })
    expect(text(r)).toContain('净利润 42')
    await client.close()
  })

  it('omits the extract tool when not wired', async () => {
    const server = createMcpServer({} as unknown as StreamService, noTier)
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('extract')
    await client.close()
  })
})

describe('MCP content_search extra', () => {
  it('exposes content_search and routes the query to the configured sources when wired', async () => {
    const calls: string[] = []
    const contentSearch = async (q: string) => {
      calls.push(q)
      return [{ title: `result for ${q}` }]
    }
    // the content_search path never touches the service, so a minimal cast is sufficient
    const server = createMcpServer({} as unknown as StreamService, { ...noTier, contentSearch })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)

    expect((await client.listTools()).tools.map((t) => t.name)).toContain('content_search')
    const r = await client.callTool({ name: 'content_search', arguments: { query: '比特币' } })
    expect(calls).toEqual(['比特币'])
    expect(text(r)).toContain('result for 比特币')
    await client.close()
  })

  it('omits content_search when not wired', async () => {
    const server = createMcpServer({} as unknown as StreamService, noTier)
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('content_search')
    await client.close()
  })
})

describe('MCP netdisk rule-editing extra (external-agent surface)', () => {
  const calls: Array<[string, unknown]> = []
  const netdisk = {
    bindings: () => [{ id: 'map_1', title: '怡乐播客', dirPath: '/d', coverage: { left: { matched: 143 } } }],
    browse: async (path: string, recursive: boolean) => { calls.push(['browse', { path, recursive }]); return { path, recursive, total: 0, entries: [] } },
    residue: async (setId: string) => { calls.push(['residue', setId]); return { unmatchedLeft: [{ leftKey: 'yile:20', title: '020.x' }], orphanRight: [] } },
    previewSpec: async (setId: string, spec: unknown) => { calls.push(['preview', spec]); return { candidateSpec: spec, after: { left: { matched: 160 } }, changed: [] } },
    applySpec: async (setId: string, spec: unknown) => { calls.push(['apply', spec]); return { id: setId, coverage: { left: { matched: 160 } } } },
    reconcileStatus: async (showId?: string) => { calls.push(['reconcileStatus', showId]); return showId ? { counts: {}, pending: [], pendingTotal: 0, pendingTruncated: false, suspectDirs: [] } : { shows: [] } },
    reconcileDecide: (input: unknown) => { calls.push(['reconcileDecide', input]); return { ok: true } },
    reconcileExecute: async (showId: string) => { calls.push(['reconcileExecute', showId]); return { moved: 0, deleted: 0, pending: 0, errors: [] } },
    transcribeFile: async (input: { path: string; windowS?: number }) => { calls.push(['transcribeFile', input]); return { file: input.path, sampledOnly: true, segments: [] } },
    reconcileUndoRun: async (runId: string) => { calls.push(['reconcileUndoRun', runId]); return { undone: 0, skipped: 0, resynced: false } },
    sync: async (setId: string) => { calls.push(['sync', setId]); return { setId, bySeason: [] } },
  }

  async function connect() {
    const server = createMcpServer({} as unknown as StreamService, { ...noTier, netdisk })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)
    return client
  }

  it('exposes the four netdisk tools and routes residue/preview/apply through the service', async () => {
    const client = await connect()
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['netdisk_bindings', 'netdisk_residue', 'netdisk_preview_spec', 'netdisk_apply_spec']))

    expect(text(await client.callTool({ name: 'netdisk_bindings', arguments: {} }))).toContain('map_1')
    expect(text(await client.callTool({ name: 'netdisk_residue', arguments: { setId: 'map_1' } }))).toContain('yile:20')
    const spec = { version: 2, stages: [{ by: 'title', titleStrip: [], threshold: 0.85, margin: 0.15 }] }
    expect(text(await client.callTool({ name: 'netdisk_preview_spec', arguments: { setId: 'map_1', spec } }))).toContain('160')
    expect(text(await client.callTool({ name: 'netdisk_apply_spec', arguments: { setId: 'map_1', spec } }))).toContain('160')
    expect(calls.map((c) => c[0])).toEqual(['residue', 'preview', 'apply'])
    await client.close()
  })

  // 「AI 能看见网盘」这一格（spec 2026-08-25 §4.1）。它掉了不会有任何一处报错——只是模型
  // 再也答不出「你夸克里那个合集在哪」，然后拿一条猜出来的路径往下走。
  it('netdisk_browse 注册，path 缺省为根、recursive 默认关', async () => {
    const client = await connect()
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('netdisk_browse')

    await client.callTool({ name: 'netdisk_browse', arguments: { path: '/quark/来自：分享', recursive: true } })
    await client.callTool({ name: 'netdisk_browse', arguments: {} })
    expect(calls.filter((c) => c[0] === 'browse').map((c) => c[1])).toEqual([
      { path: '/quark/来自：分享', recursive: true },
      { path: '/', recursive: false },
    ])
    await client.close()
  })

  /**
   * 「听一段网盘音频」这一格。它掉了不会有任何一处报错——模型只是再也听不到网盘散文件，
   * 然后拿文件名硬猜这是哪一集（而文件名分不出来正是这些卡待决的原因）。
   */
  it('netdisk_transcribe 注册，路径与窗口原样递下去', async () => {
    const client = await connect()
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('netdisk_transcribe')

    calls.length = 0
    await client.callTool({ name: 'netdisk_transcribe', arguments: { path: '/quark/来源/116.mp3' } })
    await client.callTool({ name: 'netdisk_transcribe', arguments: { path: '/quark/来源/116.mp3', windowS: 30 } })
    expect(calls.filter((c) => c[0] === 'transcribeFile').map((c) => c[1])).toEqual([
      { path: '/quark/来源/116.mp3', windowS: undefined },
      { path: '/quark/来源/116.mp3', windowS: 30 },
    ])
    await client.close()
  })

  /** 没装配（没配 AList）就整个缺席——注册一个必然报错的动词比没有它更坏，模型会一直重试。 */
  it('没接 transcribeFile 时 netdisk_transcribe 不注册', async () => {
    const server = createMcpServer({} as unknown as StreamService, {
      ...noTier,
      netdisk: { ...netdisk, transcribeFile: undefined },
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('netdisk_transcribe')
    await client.close()
  })

  it('reconcile 三工具（状态/裁决/执行）注册并路由到 service', async () => {
    const client = await connect()
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['reconcile_status', 'reconcile_decide', 'reconcile_execute']))

    calls.length = 0
    expect(text(await client.callTool({ name: 'reconcile_status', arguments: {} }))).toContain('shows')
    await client.callTool({ name: 'reconcile_status', arguments: { show: 'fafa' } })
    expect(text(await client.callTool({
      name: 'reconcile_decide',
      arguments: { verdict: 'is-episode', leftKey: 'item:1', path: '/d/f.mp3' },
    }))).toContain('ok')
    expect(text(await client.callTool({ name: 'reconcile_execute', arguments: { show: 'fafa' } }))).toContain('moved')
    expect(calls.map((c) => c[0])).toEqual(['reconcileStatus', 'reconcileStatus', 'reconcileDecide', 'reconcileExecute'])
    expect(calls[1][1]).toBe('fafa') // show 参数原样透传
    await client.close()
  })

  it('omits the netdisk tools when the AList layer is not wired', async () => {
    const server = createMcpServer({} as unknown as StreamService, noTier)
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('netdisk_residue')
    await client.close()
  })
})

describe('MCP intent tools (protocol-level: intent_dossier must not be JSON-quoted)', () => {
  // Regression for the bug caught in review: intent_dossier used to ride the shared catalog,
  // where server.ts wraps every entry's result in `json(...)` — that JSON.stringify's a markdown
  // string, so the client would receive `"# 意图档案\n..."` (quoted, `\n` escaped) instead of the
  // raw document. It's now hand-registered (like stream_subscribe) so it can return
  // { content: [{ type: 'text', text: doc }] } directly — this test exercises that over a real
  // MCP client/server pair, not just the catalog's `run()` return value, so it would have caught
  // the bug (the catalog-level test could not: it never goes through server.ts's envelope).
  const dossierText = '# 意图档案\n\n目标：追踪某播客\n\n判定标准：提到该播客新一季的内容'
  const intents = {
    create: async (input: { goal: string }) => ({
      id: 'i1', goal: input.goal, criteria: 'c', streamIds: [], cadenceHours: 24, status: 'active', createdAt: 1,
    }),
    list: () => [{ id: 'i1', goal: 'x', criteria: 'c', streamIds: [], cadenceHours: 24, status: 'active', createdAt: 1, ledgerCount: 0 }],
    dossier: (id: string) => (id === 'i1' ? dossierText : null),
  } as unknown as import('../intent/service.ts').IntentService

  async function connect(withIntents: boolean) {
    const server = createMcpServer({} as unknown as StreamService, withIntents ? { ...noTier, intents } : noTier)
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)
    return client
  }

  it('intent_dossier returns the markdown verbatim — real newlines, no wrapping quotes', async () => {
    const client = await connect(true)
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['intent_create', 'intent_list', 'intent_dossier']))

    const r = await client.callTool({ name: 'intent_dossier', arguments: { id: 'i1' } })
    expect(text(r)).toBe(dossierText) // not `"${dossierText.replace(/\n/g, '\\n')}"`
    expect(text(r).startsWith('"')).toBe(false)
    expect(text(r)).toContain('\n') // a real newline, not the two-char escape `\n`
    await client.close()
  })

  it('intent_dossier reports a nonexistent id via isError, not a null payload', async () => {
    const client = await connect(true)
    const r = await client.callTool({ name: 'intent_dossier', arguments: { id: 'nope' } })
    expect(r.isError).toBe(true)
    await client.close()
  })

  it('omits all three intent tools when intents is not wired', async () => {
    const client = await connect(false)
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).not.toContain('intent_create')
    expect(names).not.toContain('intent_list')
    expect(names).not.toContain('intent_dossier')
    await client.close()
  })
})

describe('MCP get_conversions', () => {
  const longText = 'TRANSCRIPT_BODY_' + 'x'.repeat(400)
  const longMd = 'PARSE_MARKDOWN_' + 'y'.repeat(400)
  const ROWS = [
    {
      id: 'cv_3',
      kind: 'extract',
      itemId: 'p1',
      status: 'done',
      snapshot: { title: '研报' },
      updatedAt: '2026-06-19T03:00:00Z',
      timing: { totalMs: 4200, stages: [{ name: 'fetch', ms: 200 }, { name: 'ocr', ms: 4000 }] },
      result: { markdown: longMd },
    },
    {
      id: 'cv_2',
      kind: 'stt',
      itemId: 'i2',
      status: 'done',
      snapshot: { title: '最新' },
      updatedAt: '2026-06-19T02:00:00Z',
      timing: { totalMs: 9000, stages: [{ name: 'media', ms: 1000 }, { name: 'asr', ms: 8000 }] },
      result: { text: longText, lang: 'zh', segments: [{ start: 0, end: 1, text: 'hi' }] },
    },
    {
      id: 'cv_1',
      kind: 'stt',
      itemId: 'i1',
      status: 'done',
      snapshot: { title: '旧' },
      updatedAt: '2026-06-19T01:00:00Z',
      result: { text: longText, lang: 'zh' },
    },
  ]
  /** Mirrors the runner's list(): filters, newest-first, and strips result unless expanded. */
  const conversions = {
    list: (q: { item?: string; kind?: string; limit?: number; expandResult?: boolean }) => {
      let rows = ROWS
      if (q.item) rows = rows.filter((r) => r.itemId === q.item)
      if (q.kind) rows = rows.filter((r) => r.kind === q.kind)
      rows = rows.slice(0, q.limit ?? 50)
      return { items: rows.map((r) => (q.expandResult ? r : { ...r, result: undefined })) }
    },
  }

  async function connect(extras: Omit<McpExtras, 'isCommunitySource'>) {
    const server = createMcpServer({} as unknown as StreamService, { ...noTier, ...extras })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)
    return client
  }

  it('browsing without an item is a LIGHTWEIGHT index — no bodies', async () => {
    const client = await connect({ conversions })
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('get_conversions')
    const listed = text(await client.callTool({ name: 'get_conversions', arguments: {} }))
    expect(listed).toContain('i2') // newest-first identity kept
    expect(listed).toContain('最新')
    expect(listed).not.toContain(longText) // 这是 context 安全保证：浏览绝不驮正文
    expect(listed).not.toContain(longMd)
  })

  it('naming an item returns its bodies — that IS the ask', async () => {
    const client = await connect({ conversions })
    const got = text(await client.callTool({ name: 'get_conversions', arguments: { item: 'i2' } }))
    expect(got).toContain(longText)
    expect(got).not.toContain('研报') // 只回这个 item 的
  })

  it('filters by kind, so one item transcript vs OCR are separable', async () => {
    const client = await connect({ conversions })
    const parsesOnly = text(await client.callTool({ name: 'get_conversions', arguments: { kind: 'extract' } }))
    expect(parsesOnly).toContain('p1')
    expect(parsesOnly).not.toContain('i2')
  })

  it('can be forced back to a lean listing even when an item is named', async () => {
    const client = await connect({ conversions })
    const lean = text(await client.callTool({ name: 'get_conversions', arguments: { item: 'i2', expand: false } }))
    expect(lean).not.toContain(longText)
    expect(lean).toContain('i2')
  })

  it('carries the per-stage timing in both modes — that is what makes it worth reading', async () => {
    const client = await connect({ conversions })
    const listed = text(await client.callTool({ name: 'get_conversions', arguments: {} }))
    expect(listed).toContain('asr')
    const got = text(await client.callTool({ name: 'get_conversions', arguments: { item: 'p1' } }))
    expect(got).toContain('ocr')
  })

  it('returns an empty list for an item that was never converted', async () => {
    const client = await connect({ conversions })
    const got = text(await client.callTool({ name: 'get_conversions', arguments: { item: 'nope' } }))
    expect(got).toContain('[]')
  })

  it('is omitted entirely when conversions are not wired', async () => {
    const client = await connect({})
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('get_conversions')
  })

  it('no longer exposes the four superseded read tools', async () => {
    const client = await connect({ conversions })
    const names = (await client.listTools()).tools.map((t) => t.name)
    for (const n of ['list_transcripts', 'get_transcript', 'list_parses', 'get_parse']) expect(names).not.toContain(n)
  })
})

describe('能力包的工具（McpExtras.capabilityTools）', () => {
  const tool = (name: string, exec: () => Promise<unknown> = async () => ({ ok: name })): ToolDef => ({
    name,
    description: `${name} 的说明`,
    parameters: {
      who: { type: 'string', required: true, description: '给谁' },
      loud: { type: 'boolean' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    execute: exec,
    annotations: { destructiveHint: true },
  })

  async function connect(extras: Omit<McpExtras, 'isCommunitySource'>) {
    const server = createMcpServer({} as unknown as StreamServiceLike, { ...noTier, ...extras })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)
    return client
  }

  it('注册进 tools/list，参数与 destructiveHint 都带上', async () => {
    const client = await connect({ capabilityTools: () => [tool('demo_verb')] })
    const found = (await client.listTools()).tools.find((t) => t.name === 'demo_verb')
    expect(found?.description).toBe('demo_verb 的说明')
    expect(found?.inputSchema.required).toEqual(['who'])
    // 参数说明必须活着到这里——它是模型唯一知道这一格干什么的地方。
    expect((found?.inputSchema.properties as { who: { description?: string } }).who.description).toBe('给谁')
    expect(found?.annotations?.destructiveHint).toBe(true)
    await client.close()
  })

  it('调用走 execute → render；抛错走 isError 而不是协议错误', async () => {
    const client = await connect({
      capabilityTools: () => [tool('ok_verb'), tool('bad_verb', async () => { throw new Error('炸了') })],
    })
    const ok = await client.callTool({ name: 'ok_verb', arguments: { who: 'me' } })
    expect(JSON.stringify(ok.content)).toContain('ok_verb')
    const bad = await client.callTool({ name: 'bad_verb', arguments: { who: 'me' } })
    expect(bad.isError).toBe(true)
    expect(JSON.stringify(bad.content)).toContain('炸了')
    await client.close()
  })

  // 后端自己那几十个动词必须还在。用低层 `setRequestHandler` 挂能力工具会**覆盖**高层
  // McpServer 自己的 ListTools/CallTool handler —— 表现是 tools/list 照样 200、只是后端的
  // 工具全没了。这一条就是钉那件事。
  it('挂上能力工具之后，后端自己的工具一个都没少', async () => {
    const bare = await connect({})
    const before = (await bare.listTools()).tools.map((t) => t.name).sort()
    await bare.close()
    const client = await connect({ capabilityTools: () => [tool('demo_verb')] })
    const after = (await client.listTools()).tools.map((t) => t.name).sort()
    await client.close()
    expect(after).toEqual([...before, 'demo_verb'].sort())
    expect(before.length).toBeGreaterThan(5)
  })

  /**
   * **thunk 而不是字段** —— 这条测试的全部意义。
   *
   * `/api/mcp` 每请求现建一个 server，而能力包的装载在别的时刻发生（可选包动态 import，
   * 用户还能运行期装卸）。把 `capabilityTools` 写成 `ToolDef[]` 字段，装配之后才挂上的包
   * 就永远不出现在 `tools/list` 里，而 `/api/plugins` 照样列着它的动词——两边都不报错。
   *
   * **自证有牙**：把 `createMcpServer` 末尾那行改成在装配期取一次（例如在 `mountMcp` 里
   * 把 `extras.capabilityTools()` 的结果存下来复用），这条会红——第二次 `listTools` 里
   * 拿不到 `late_verb`。
   */
  it('每建一个 server 都现问一次：后挂上的工具跟得上', async () => {
    // **拿真 host，不是往一个数组里 push**：原地 push 同一个数组时，`capabilityTools` 写成
    // 字段（`capabilityTools: live` 那种）**照样绿**——同一个引用，字段和 thunk 读到的是
    // 同一份内容。这条要钉的是「装配之后才挂上的能力跟不跟得上」，所以中间那一步必须是
    // 一次真的 `host.mount()`。
    const host = createCapabilityHost({ dataDir: mkdtempSync(join(tmpdir(), 'srv-cap-')), log: () => {} })
    const extras: Omit<McpExtras, 'isCommunitySource'> = { capabilityTools: () => host.toolDefs() }
    const first = await connect(extras)
    expect((await first.listTools()).tools.map((t) => t.name)).not.toContain('late_verb')
    await first.close()

    await host.mount({ name: 'late', mount: async (ctx) => { ctx.registerTools([tool('late_verb')]) } }, {})
    const second = await connect(extras)
    expect((await second.listTools()).tools.map((t) => t.name)).toContain('late_verb')
    await second.close()
  })

  it('缺席时什么都不注册', async () => {
    const client = await connect({})
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('demo_verb')
    await client.close()
  })
})

describe('backendToolNames', () => {
  // 撞名闸门的名单源。**它读的是 SDK 的私有字段**——SDK 换个名字这里就静默返回空集，
  // 于是任何第三方包都能顶掉后端的动词。这条就是那个字段的守卫。
  it('把后端自己注册的工具名读回来（含 catalog 与就地注册的 bespoke 动词）', () => {
    const names = backendToolNames({} as unknown as StreamServiceLike, noTier)
    expect(names.length).toBeGreaterThan(5)
    expect(names).toContain('stream_list')
    expect(names).toContain('stream_subscribe')
  })

  it('不把能力包自己的工具算进去（否则它永远和自己撞）', () => {
    const cap: ToolDef = {
      name: 'cap_verb', description: 'x', parameters: {},
      output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: '' }] },
      execute: async () => ({}),
    }
    expect(backendToolNames({} as unknown as StreamServiceLike, { ...noTier, capabilityTools: () => [cap] })).not.toContain('cap_verb')
  })
})
