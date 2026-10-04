import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { StreamServiceLike } from './tools.ts'
import { toolCatalog, type McpExtras } from './tool-catalog.ts'
import { registerCapabilityTools, withCapabilityTools } from './capability-tools.ts'
// 订阅这件事只有一份判据（流 id 怎么定、占位名叫什么、采集策略是什么）——前端订阅和
// `subscribe_source` 同吃 `shared/subscribe`。复刻一份的代价是安静的：两条路建出的流会慢慢
// 长得不一样（id 规则、backfill 深度、要不要自动改名），而没有任何测试会因此变红。
import { buildStreamCreate, DEFAULT_HARVEST } from '../../shared/subscribe/subscribe.ts'
import type { Stream } from '../streams/types.ts'

export type { McpExtras } from './tool-catalog.ts'

/** 模型代订的流统一落这个频道——给用户留后悔药：一眼看清「AI 替我订了些什么」，不满意整批删。 */
export const AGENT_CHANNEL_ID = 'agent-subscriptions'
export const AGENT_CHANNEL_LABEL = '对话订的'

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] })

/**
 * Thin MCP adapter over the tested StreamService. The tool surface comes from the shared
 * `toolCatalog` (one source of truth with the in-app agent — see tool-catalog.ts); this face
 * mounts every catalog entry whose backing capability is present, wrapping the result in the
 * MCP `json(...)` envelope. Only `stream_subscribe` (a full-Stream variant the agent doesn't
 * share) and the two ambient resources are hand-registered here.
 */
export function createMcpServer(service: StreamServiceLike, extras: McpExtras): McpServer {
  const server = new McpServer({ name: 'stream', version: '0.1.0' })

  for (const entry of toolCatalog(service, extras)) {
    server.registerTool(
      entry.name,
      { description: entry.description, inputSchema: entry.schema },
      async (args) => json(await entry.run(args as Record<string, unknown>))
    )
  }

  // Bespoke: the dossier is markdown meant to reach the client as raw text, not JSON-quoted
  // inside `json(...)`'s envelope — same "differs in more than the result wrapper → bespoke"
  // rule as stream_subscribe below. Not-found is reported via the SDK's own isError channel
  // (throwing inside the handler — same mechanism every catalog entry already relies on).
  if (extras.intents) {
    const intents = extras.intents
    server.registerTool(
      'intent_dossier',
      {
        description: '读一个意图的档案（markdown 原文）：目标、判定标准、命中摘要的时间线。意图不存在时报错。',
        inputSchema: { id: z.string() },
      },
      async ({ id }) => {
        const doc = intents.dossier(id)
        if (doc === null) throw new Error(`意图不存在: ${id}`)
        return { content: [{ type: 'text' as const, text: doc }] }
      }
    )
  }

  // Bespoke: MCP takes a full Stream (the agent's subscribe_source is a convenience variant
  // that builds the Stream from a source id — genuinely different shape, so kept out of the
  // shared catalog by the "differs in more than the result wrapper → bespoke" rule).
  server.registerTool(
    'stream_subscribe',
    {
      description:
        'LOW-LEVEL: author a whole Stream by hand and schedule it. For "subscribe me to this" use `subscribe_source` INSTEAD — it derives the id/vault_subdir for you, upserts (same source+params lands on the SAME stream instead of a duplicate), and takes a `channel`. ' +
        'This tool has NO `channel` parameter and does not assign one: the stream it creates lands in the default position, so if the user said where it should go, you cannot honour that here — use `subscribe_source`. ' +
        'Reach for this one only when `subscribe_source` genuinely cannot express the Stream — e.g. it needs SEVERAL sources in one Stream, or a specific id/vault_subdir you must control.',
      inputSchema: {
        id: z.string(),
        description: z.string(),
        sources: z.array(z.object({ source_id: z.string(), params: z.record(z.string(), z.unknown()) })),
        cadence_seconds: z.number(),
        vault_subdir: z.string(),
      },
    },
    async (stream) => {
      service.subscribe(stream)
      return json({ subscribed: stream.id })
    }
  )

  // Bespoke: 由 source id 建流的便捷版。**和上面那个不是重复**——`stream_subscribe` 要调用方
  // 自己造一整个 Stream（id / vault_subdir / cadence 全靠它编），而这一条把那几样交给
  // `shared/subscribe` 那份唯一判据：id 是候选决定的（确定性），同一个源+参数再订一次落到
  // 同一条流上（upsert），而不是又造一条一模一样的。
  server.registerTool(
    'subscribe_source',
    {
      description:
        'Subscribe to a source: create a persisted, scheduled Stream from a source id (+ its params). The source id comes from resolve_intent or stream_search. Confirm with the user before subscribing.' +
        ' Pass `channel` when the user said where it should go (the channel NAME they used is fine); omit it and the stream lands in 「对话订的」, a review bucket for assistant-made subscriptions.' +
        " Do NOT invent a name: pass the candidate's own `title` as a placeholder and Stream replaces it with the real feed name after the first harvest.",
      inputSchema: {
        source_id: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
        title: z.string().optional(),
        channel: z.string().optional(),
        cadence_seconds: z.number().optional(),
      },
    },
    async ({ source_id, params, title, channel, cadence_seconds }) => {
      // 用户点了名的频道就进那个；没点名才落「对话订的」。找不到时**不订**：把可选频道原样
      // 报回去让模型据实回答。悄悄改落别处 = 用户以为进了 A、其实在 B，和「说了没做」同类。
      const wanted = channel?.trim()
      let channelId = AGENT_CHANNEL_ID
      let channelLabel = AGENT_CHANNEL_LABEL
      if (wanted) {
        const hit =
          service.listChannels().find((c) => c.id === wanted || c.label === wanted) ??
          service.listChannels().find((c) => c.label.replace(/\s+/g, '') === wanted.replace(/\s+/g, ''))
        if (!hit) {
          return json({
            error: `没有叫「${wanted}」的频道，没有订阅`,
            available: service.listChannels().map((c) => ({ id: c.id, label: c.label })),
          })
        }
        channelId = hit.id
        channelLabel = hit.label
      }

      const body = buildStreamCreate({ sourceId: source_id, params: params ?? {}, title: title?.trim() || '' })
      const stream: Stream = {
        id: body.id,
        description: body.label,
        sources: [{ source_id, params: params ?? {} }],
        cadence_seconds: cadence_seconds && cadence_seconds > 0 ? cadence_seconds : body.cadence_seconds,
        vault_subdir: (body.options.vault_subdir as string) ?? body.id,
        harvest: { ...DEFAULT_HARVEST },
        // **名字不归模型编。** 打上这一格，首采成功后由 auto-name.ts 用 feed 的真名覆盖。
        // 没有它，流名会永远停在模型随口写的那句上，而同频道里手工订的邻居都叫着正经节目名。
        label_auto: true,
      }
      // **顺序不能反**：频道不存在时 subscribe 会静默不挂（见 StreamService.ensureChannel）。
      if (channelId === AGENT_CHANNEL_ID) {
        service.ensureChannel({ id: AGENT_CHANNEL_ID, label: AGENT_CHANNEL_LABEL, present: 'timeline' })
      }
      service.subscribe(stream, channelId)
      return json({
        subscribed: stream.id,
        channel: channelLabel,
        name: stream.description,
        name_is_placeholder: true,
        note: 'The name above is a placeholder — it becomes the real feed name after the first harvest. Tell the user which channel it went into; do not promise a name.',
      })
    }
  )

  // Ambient vocabulary — readable without a tool call. (AI SDK has no resource concept, so
  // these are MCP-only; the agent reads the same data via stream_list when it needs it.)
  server.registerResource(
    'streams',
    'stream://streams',
    { description: 'Current Streams (subscribed feed units)', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, text: JSON.stringify(service.streamsResource(), null, 2) }] })
  )

  // Facet browsing — the shape of what exists without enumerating sources.
  server.registerResource(
    'topics',
    'stream://topics',
    { description: 'Aggregate topics across all sources', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, text: JSON.stringify(service.topics(), null, 2) }] })
  )

  // 能力包的工具，**每建一个 server 现问一次**（见 McpExtras.capabilityTools 的头注）。
  // 排在最后：撞名时 `registerTool` 自己抛「Tool X is already registered」，也就是后端自己的
  // 动词永远赢——而 host 那一侧在 mount 期就已经硬拒过一次，这里是第二道。
  registerCapabilityTools(server, extras.capabilityTools?.() ?? [])

  return server
}

/**
 * **后端自己注册了哪些工具名。** 能力包与它们撞名硬拒（`createCapabilityHost` 的
 * `reservedToolNames`）——一个第三方包起个 `extract` 就能把后端的动词顶掉，而模型只会觉得
 * 这个工具突然变笨了。
 *
 * **不手抄名单，问 server 自己**：手抄的第二份漂移时没有任何一处会喊（`toolCatalog` 之外还有
 * 几个就地注册的 bespoke 动词），拿一份不存在的名字去比，比出来的"没撞"是假的。代价是每次调用
 * 现建一个一次性 server；它只在 mount 期被调，一次运行也就几次。
 *
 * `_registeredTools` 是 SDK 的私有字段——它是**目前唯一**能把已注册的工具名读回来的口
 * （`listTools` 要一条真连接）。SDK 换名字这里就读到空集，于是撞名闸门静默失效，所以
 * `server.test.ts` 有一条钉着它非空且含 `stream_list`。
 */
export function backendToolNames(service: StreamServiceLike, extras: McpExtras): string[] {
  const probe = createMcpServer(service, withCapabilityTools(extras, () => []))
  const registered = (probe as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools
  return Object.keys(registered ?? {})
}

/** Connect the server over stdio (the usual MCP transport for local agents). */
export async function startStdio(service: StreamServiceLike, extras: McpExtras): Promise<McpServer> {
  const server = createMcpServer(service, extras)
  await server.connect(new StdioServerTransport())
  return server
}
