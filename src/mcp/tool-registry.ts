/**
 * 工具目录的**进程内接口**（openspec `embeddable-engine` D3）：`list()` / `call()`。
 *
 * 它是工具面的唯一一份：`createMcpServer`（`/api/mcp` 与 stdio）只是它外面的一层协议——遍历同一组
 * `ToolSpec` 注册、把调用转给同一个 `invoke`。所以「MCP 暴露什么」和「嵌入方看到什么」不可能分叉：
 * 工具集合、名字、参数（zod → JSON-Schema 走 SDK 自己那个转换器）、结果、出错形状全是同一份。
 *
 * 两条要记住的：
 * - **每次 `list()` / `call()` 现建一遍目录**，不缓存。能力包的工具在运行期上线下线，`McpExtras` 里还有一批
 *   按域可用性现算的 getter——缓存一次就是把「那一刻有哪些工具」冻住（`McpExtras.capabilityTools` 头注）。
 *   MCP 端点本来就是每请求现建一个 server，代价相同。
 * - `call()` 的参数校验与出错形状**照抄 SDK 的 CallTool 处理器**（`McpServer.setToolRequestHandlers`）：
 *   校验失败 / 工具不存在 / 工具抛错都回 `{isError:true, content:[{type:'text', text}]}`，文本与经 MCP 调用一字不差。
 *   嵌入方要判错看 `isError`，不靠 try/catch。
 */
import { z } from 'zod'
import { getParseErrorMessage, normalizeObjectSchema, objectFromShape, safeParseAsync } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { ErrorCode, McpError, type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import type { ToolDef } from '../../shared/capability/types.ts'
import type { StreamServiceLike } from './tools.ts'
import { toolCatalog, RO, WRITE, ACTS, type McpExtras, type ToolAnnotations } from './tool-catalog.ts'
import { zodShapeFromParameters } from './capability-tools.ts'
import { runWithToolCaller } from '../tool-caller.ts'
// 订阅这件事只有一份判据（流 id 怎么定、占位名叫什么、采集策略是什么）——前端订阅和
// `subscribe_source` 同吃 `shared/subscribe`。复刻一份的代价是安静的：两条路建出的流会慢慢
// 长得不一样（id 规则、backfill 深度、要不要自动改名），而没有任何测试会因此变红。
import { buildStreamCreate, DEFAULT_HARVEST } from '../../shared/subscribe/subscribe.ts'
import type { Stream } from '../streams/types.ts'

export type { ToolAnnotations } from './tool-catalog.ts'

/** 模型代订的流统一落这个频道——给用户留后悔药：一眼看清「AI 替我订了些什么」，不满意整批删。 */
export const AGENT_CHANNEL_ID = 'agent-subscriptions'
export const AGENT_CHANNEL_LABEL = '对话订的'

/** `tools.list()` 的一项：与 MCP `tools/list` 的同名四格一致（`inputSchema` 是 JSON-Schema）。 */
export interface ToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: ToolAnnotations
}

export interface ToolProgress {
  progress: number
  total?: number
  message?: string
}

export interface ToolCallContext {
  /** 谁调的。记进这次调用建出的运行记录（`agent-runs.db` 的 `caller` 列）。 */
  caller?: string
  /** 取消。能力包的工具透传给 `execute`；目录里的工具今天不看它。 */
  signal?: AbortSignal
  /** 进度回调。经 MCP 时接到 `notifications/progress`；今天还没有工具报进度，口先留着。 */
  onProgress?: (p: ToolProgress) => void
}

/** 一次调用的结果：MCP `CallToolResult` 的形状，外加 `value`——工具返回的原值（MCP 那边只有它的 JSON 文本）。 */
export interface ToolResult {
  content: ContentBlock[]
  isError?: boolean
  /** 结构化原值。出错时没有。 */
  value?: unknown
}

export interface StreamTools {
  list(): ToolDescriptor[]
  call(name: string, args?: Record<string, unknown>, ctx?: ToolCallContext): Promise<ToolResult>
}

/** 一条可注册的工具：zod raw shape（MCP `registerTool` 要它，校验也靠它）+ 已校验参数上的调用。 */
export interface ToolSpec {
  name: string
  description: string
  schema: z.ZodRawShape
  annotations: ToolAnnotations
  invoke(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult>
}

const json = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], value: data })

const errorResult = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true })

/**
 * 能力包没声明 `readOnlyHint` 的一律按非只读：一个第三方包不说，我们不替它担保。
 * 包自己给了 `destructiveHint` 就留着。
 */
function capabilityAnnotations(def: ToolDef): ToolAnnotations {
  const a = def.annotations ?? {}
  return { ...a, readOnlyHint: a.readOnlyHint === true }
}

/**
 * 当下的全部工具，**顺序即 MCP `tools/list` 的顺序**：目录 → 三个就地写的（`intent_dossier` /
 * `stream_subscribe` / `subscribe_source`）→ 能力包。撞名抛 `Tool X is already registered`（与 SDK
 * `registerTool` 同一句）——后端自己的动词永远赢，能力包宿主在 mount 期已经硬拒过一次，这里是第二道。
 */
export function toolSpecs(service: StreamServiceLike, extras: McpExtras): ToolSpec[] {
  const specs: ToolSpec[] = []
  const seen = new Set<string>()
  const add = (s: ToolSpec) => {
    if (seen.has(s.name)) throw new Error(`Tool ${s.name} is already registered`)
    seen.add(s.name)
    specs.push(s)
  }

  for (const entry of toolCatalog(service, extras)) {
    add({
      name: entry.name,
      description: entry.description,
      schema: entry.schema,
      annotations: entry.annotations,
      invoke: async (args, ctx) => json(await entry.run(args, ctx)),
    })
  }

  // 就地写：档案是 markdown，要以原文到客户端，不能被 `json(...)` 引号包一层。找不到走 isError（抛 → 统一兜）。
  if (extras.intents) {
    const intents = extras.intents
    add({
      name: 'intent_dossier',
      description: '读一个意图的档案（markdown 原文）：目标、判定标准、命中摘要的时间线。意图不存在时报错。',
      schema: { id: z.string() },
      annotations: RO,
      invoke: async ({ id }) => {
        const doc = intents.dossier(id as string)
        if (doc === null) throw new Error(`意图不存在: ${String(id)}`)
        return { content: [{ type: 'text', text: doc }], value: doc }
      },
    })
  }

  // 就地写：MCP 收一整个 Stream（subscribe_source 是由 source id 建流的便捷版——形状真不同）。
  // 同 id 再订会覆盖那条流 → ACTS。
  add({
    name: 'stream_subscribe',
    description:
      'LOW-LEVEL: author a whole Stream by hand and schedule it. For "subscribe me to this" use `subscribe_source` INSTEAD — it derives the id/vault_subdir for you, upserts (same source+params lands on the SAME stream instead of a duplicate), and takes a `channel`. ' +
      'This tool has NO `channel` parameter and does not assign one: the stream it creates lands in the default position, so if the user said where it should go, you cannot honour that here — use `subscribe_source`. ' +
      'Reach for this one only when `subscribe_source` genuinely cannot express the Stream — e.g. it needs SEVERAL sources in one Stream, or a specific id/vault_subdir you must control.',
    schema: {
      id: z.string(),
      description: z.string(),
      sources: z.array(z.object({ source_id: z.string(), params: z.record(z.string(), z.unknown()) })),
      cadence_seconds: z.number(),
      vault_subdir: z.string(),
    },
    annotations: ACTS,
    invoke: async (stream) => {
      service.subscribe(stream as unknown as Stream)
      return json({ subscribed: stream.id })
    },
  })

  // 由 source id 建流的便捷版。**和上面那个不是重复**——`stream_subscribe` 要调用方自己造一整个 Stream，
  // 这一条把 id / vault_subdir / cadence 交给 `shared/subscribe` 那份唯一判据：id 是候选决定的（确定性），
  // 同一个源 + 参数再订一次落到同一条流上（upsert）。追加式 → WRITE。
  add({
    name: 'subscribe_source',
    description:
      'Subscribe to a source: create a persisted, scheduled Stream from a source id (+ its params). The source id comes from resolve_intent or stream_search. Confirm with the user before subscribing.' +
      ' Pass `channel` when the user said where it should go (the channel NAME they used is fine); omit it and the stream lands in 「对话订的」, a review bucket for assistant-made subscriptions.' +
      " Do NOT invent a name: pass the candidate's own `title` as a placeholder and Stream replaces it with the real feed name after the first harvest.",
    schema: {
      source_id: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
      title: z.string().optional(),
      channel: z.string().optional(),
      cadence_seconds: z.number().optional(),
    },
    annotations: WRITE,
    invoke: async (a) => {
      const { source_id, params, title, channel, cadence_seconds } = a as {
        source_id: string
        params?: Record<string, unknown>
        title?: string
        channel?: string
        cadence_seconds?: number
      }
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
    },
  })

  // 能力包的工具，**每次现问**（见 McpExtras.capabilityTools 的头注）。排在最后。
  // `execute` 抛错是一条**结果**（isError），不是协议错误；`signal` 必须透传，断了的表现是"它一直没回来"。
  for (const def of extras.capabilityTools?.() ?? []) {
    add({
      name: def.name,
      description: def.description,
      schema: zodShapeFromParameters(def.parameters),
      annotations: capabilityAnnotations(def),
      invoke: async (args, ctx) => {
        try {
          const value = await def.execute(args ?? {}, { signal: ctx.signal })
          return { content: def.output.render(args, value) as ContentBlock[], value }
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err))
        }
      },
    })
  }

  return specs
}

/** zod raw shape → JSON-Schema，**与 SDK `tools/list` 同一条路**（同一个转换器、同一组选项），否则两边会差在细节上。 */
export function inputJsonSchema(schema: z.ZodRawShape): Record<string, unknown> {
  const obj = normalizeObjectSchema(objectFromShape(schema as never))
  return obj
    ? (toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: 'input' }) as Record<string, unknown>)
    : { type: 'object', properties: {} }
}

/** 校验 + 调用 + 兜错，与 SDK 的 CallTool 处理器同一套语义（见文件头）。MCP 层不走这里——SDK 自己校验。 */
async function callSpec(spec: ToolSpec | undefined, name: string, args: Record<string, unknown> | undefined, ctx: ToolCallContext): Promise<ToolResult> {
  try {
    if (!spec) throw new McpError(ErrorCode.InvalidParams, `Tool ${name} not found`)
    const parsed = await safeParseAsync(objectFromShape(spec.schema as never), args)
    if (!parsed.success) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Input validation error: Invalid arguments for tool ${name}: ${getParseErrorMessage(parsed.error)}`,
      )
    }
    return await runWithToolCaller(ctx.caller, () => spec.invoke(parsed.data as Record<string, unknown>, ctx))
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err))
  }
}

export function describeSpec(s: ToolSpec): ToolDescriptor {
  return { name: s.name, description: s.description, inputSchema: inputJsonSchema(s.schema), annotations: s.annotations }
}

export function createStreamTools(service: StreamServiceLike, extras: McpExtras): StreamTools {
  return {
    list: () => toolSpecs(service, extras).map(describeSpec),
    call: (name, args, ctx = {}) => callSpec(toolSpecs(service, extras).find((s) => s.name === name), name, args, ctx),
  }
}
