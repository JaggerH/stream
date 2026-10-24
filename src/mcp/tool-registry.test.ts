import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from './server.ts'
import { createStreamTools, toolSpecs } from './tool-registry.ts'
import type { McpExtras } from './tool-catalog.ts'
import type { StreamServiceLike } from './tools.ts'
import type { ToolDef } from '../../shared/capability/types.ts'
import { SearchRunStore } from '../agent/search/run-store.ts'

/**
 * 「什么都在场」的 extras：任何格读出来都是一个可调用、任何下级格也都在场的东西——于是 catalog 的
 * 每个 `if (extras.x)` / `if (nd.y)` 都成立，列出来的就是**全部**工具。守卫要的正是这一份全集：
 * 新加一个工具忘了标，它一定在这里出现。
 */
const anything: unknown = new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' ? undefined : anything),
  apply: () => anything,
})
const everything = (capabilityTools: () => ToolDef[] = () => []): McpExtras =>
  new Proxy({} as McpExtras, {
    get: (_t, k) => (k === 'capabilityTools' ? capabilityTools : anything),
  })

const capTool = (name: string, extra: Partial<ToolDef> = {}): ToolDef => ({
  name,
  description: `${name} 的说明`,
  parameters: { who: { type: 'string', required: true, description: '给谁' } },
  output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
  execute: async (args) => ({ hi: args.who }),
  ...extra,
})

const fakeService = {
  list: () => [{ id: 's1' }],
  status: () => ({ s1: { items: 3 } }),
} as unknown as StreamServiceLike

async function mcpClient(service: StreamServiceLike, extras: McpExtras) {
  const server = createMcpServer(service, extras)
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'parity', version: '0' })
  await client.connect(clientT)
  return client
}

describe('stream.tools ↔ MCP 一致', () => {
  it('MCP tools/list 与 tools.list() 一项一项相等（名字、说明、参数 JSON-Schema、annotations、顺序）', async () => {
    const extras = everything(() => [capTool('demo_cap'), capTool('demo_ro', { annotations: { readOnlyHint: true } })])
    const tools = createStreamTools(fakeService, extras)
    const client = await mcpClient(fakeService, extras)
    const viaMcp = (await client.listTools()).tools.map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations,
    }))
    const local = tools.list()
    expect(local.length).toBeGreaterThan(60)
    expect(viaMcp).toEqual(local)
    await client.close()
  })

  it('调用结果相同：成功 / 参数校验失败 / 工具不存在 / 能力包工具', async () => {
    const extras: McpExtras = { isCommunitySource: () => false, capabilityTools: () => [capTool('demo_cap')] }
    const tools = createStreamTools(fakeService, extras)
    const client = await mcpClient(fakeService, extras)
    const cases: Array<[string, Record<string, unknown> | undefined]> = [
      ['stream_list', {}],
      ['stream_status', {}],
      ['stream_unsubscribe', {}], // 缺 id → 校验失败
      ['no_such_tool', {}],
      ['demo_cap', { who: 'me' }],
      ['demo_cap', { who: 1 }],
    ]
    for (const [name, args] of cases) {
      const viaMcp = await client.callTool({ name, arguments: args })
      const { value: _v, ...local } = await tools.call(name, args)
      expect(local, name).toEqual(viaMcp)
    }
    await client.close()
  })

  it('call() 还交回原值（MCP 那边只有它的 JSON 文本）', async () => {
    const tools = createStreamTools(fakeService, { isCommunitySource: () => false })
    const r = await tools.call('stream_list', {})
    expect(r.value).toEqual([{ id: 's1' }])
    expect(r.isError).toBeUndefined()
  })

  it('能力包的工具随包上下线出现 / 消失（每次 list 现问）', () => {
    let defs: ToolDef[] = []
    const tools = createStreamTools(fakeService, { isCommunitySource: () => false, capabilityTools: () => defs })
    expect(tools.list().map((t) => t.name)).not.toContain('late_cap')
    defs = [capTool('late_cap')]
    expect(tools.list().map((t) => t.name)).toContain('late_cap')
    defs = []
    expect(tools.list().map((t) => t.name)).not.toContain('late_cap')
  })

  it('ctx.signal 透传到能力包的 execute', async () => {
    let seen: AbortSignal | undefined
    const ac = new AbortController()
    const tools = createStreamTools(fakeService, {
      isCommunitySource: () => false,
      capabilityTools: () => [capTool('sig', { execute: async (_a, c) => ((seen = c?.signal), 'ok') })],
    })
    await tools.call('sig', { who: 'x' }, { signal: ac.signal })
    expect(seen).toBe(ac.signal)
  })

  it('ctx.caller 记进这次调用建出的运行记录', async () => {
    const store = new SearchRunStore(':memory:')
    const extras = new Proxy({ isCommunitySource: () => false } as McpExtras, {
      get: (t, k) =>
        k === 'searchAgent'
          ? { start: async (goal: string) => { await Promise.resolve(); return store.create(goal) }, get: (id: string) => store.get(id) }
          : (t as unknown as Record<string | symbol, unknown>)[k],
    })
    const tools = createStreamTools(fakeService, extras)
    const r = await tools.call('search_agent', { goal: 'x' }, { caller: 'embedder:test' })
    const runId = (r.value as { runId: string }).runId
    expect(store.get(runId)?.caller).toBe('embedder:test')
    // 不带 caller 的调用不记
    const r2 = await tools.call('search_agent', { goal: 'y' })
    expect(store.get((r2.value as { runId: string }).runId)?.caller).toBeUndefined()
    store.close()
  })
})

/**
 * 嵌入方只会把只读工具交给无人值守的调用方（在它们有审批流之前）。所以**每个工具都必须显式说
 * 自己是不是只读**——漏标就是让嵌入方去猜，而猜错的方向是把一个会下单的工具当成查询。
 * 分类见 design.md 附录 C；改动这张表等于改了嵌入方的放行面，要显式改这里。
 */
describe('annotations 守卫', () => {
  const all = toolSpecs(fakeService, everything(() => [capTool('cap_unannotated'), capTool('cap_ro', { annotations: { readOnlyHint: true } })]))

  it('每个工具都显式声明 readOnlyHint（true / false）', () => {
    for (const s of all) expect(typeof s.annotations.readOnlyHint, s.name).toBe('boolean')
  })

  it('能力包没声明的按非只读；声明了的照用', () => {
    expect(all.find((s) => s.name === 'cap_unannotated')?.annotations.readOnlyHint).toBe(false)
    expect(all.find((s) => s.name === 'cap_ro')?.annotations.readOnlyHint).toBe(true)
  })

  it('只读名单钉死（改它 = 改嵌入方的放行面）', () => {
    const readOnly = all.filter((s) => s.annotations.readOnlyHint && !s.name.startsWith('cap_')).map((s) => s.name).sort()
    expect(readOnly).toEqual(
      [
        'capability_status', 'cdp_shot', 'content_search', 'get_agent_run', 'get_conversions', 'get_events',
        'graph_frontier', 'harvest_capability', 'inbox_search', 'intent_dossier', 'intent_list',
        'list_person_appearances', 'list_sources', 'netdisk_bindings', 'netdisk_browse', 'netdisk_preview_spec',
        'netdisk_residue', 'netdisk_share_verify', 'netdisk_transcribe', 'price_search', 'read_content', 'read_url',
        'reconcile_status', 'resolve', 'resolve_intent', 'stream_categories', 'stream_fetch_url', 'stream_list',
        'stream_read', 'stream_search', 'stream_sources', 'stream_status', 'video_resolve', 'video_search', 'web_search',
      ].sort(),
    )
  })

  it('真动手的那几个标 destructiveHint', () => {
    for (const n of ['run_action_recipe', 'cdp_act', 'cdp_look', 'reconcile_execute', 'netdisk_follow', 'provision_capability_key', 'stream_unsubscribe']) {
      expect(all.find((s) => s.name === n)?.annotations, n).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    }
  })
})
