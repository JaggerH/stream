import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { StreamServiceLike } from './tools.ts'
import type { McpExtras } from './tool-catalog.ts'
import { withCapabilityTools } from './capability-tools.ts'
import { toolSpecs, type ToolCallContext, type ToolResult } from './tool-registry.ts'

export type { McpExtras } from './tool-catalog.ts'
export { AGENT_CHANNEL_ID, AGENT_CHANNEL_LABEL } from './tool-registry.ts'

/** 只把 MCP `CallToolResult` 的两格交出去：`value`（进程内接口的原值）不上线，否则 MCP 的回包多一格。 */
const wire = (r: ToolResult) => (r.isError ? { content: r.content, isError: true } : { content: r.content })

/**
 * MCP 是工具接口（`tool-registry.ts` 的 `toolSpecs`）外面的**一层协议**：遍历同一组 spec 注册，
 * 参数校验交给 SDK（同一个 zod shape），调用转给同一个 `invoke`。工具面本身不在这里——在这里加工具
 * 就是让嵌入方的 `stream.tools` 和 MCP 分叉。只有两个资源是 MCP 独有的（工具接口没有资源这个概念）。
 *
 * 必须走高层 `registerTool`，别改成低层 `Server.setRequestHandler`：高层 `McpServer` 已在 ListTools /
 * CallTool 上装了 handler，低层再 set 一次是**覆盖**——后端工具当场从 `tools/list` 消失而 200 照回
 * （见 capability-tools.ts 头注）。
 */
export function createMcpServer(service: StreamServiceLike, extras: McpExtras): McpServer {
  const server = new McpServer({ name: 'stream', version: '0.1.0' })

  for (const spec of toolSpecs(service, extras)) {
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: spec.schema, annotations: spec.annotations },
      async (args, extra) => {
        const ctx: ToolCallContext = { signal: extra.signal }
        const token = extra._meta?.progressToken
        if (token !== undefined) {
          ctx.onProgress = (p) =>
            void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, ...p } }).catch(() => {})
        }
        return wire(await spec.invoke(args as Record<string, unknown>, ctx))
      },
    )
  }

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

  return server
}

/**
 * **后端自己注册了哪些工具名。** 能力包与它们撞名硬拒（`createCapabilityHost` 的
 * `reservedToolNames`）——一个第三方包起个 `extract` 就能把后端的动词顶掉，而模型只会觉得
 * 这个工具突然变笨了。
 *
 * **不手抄名单，问工具接口自己**（不带能力包那一截）：手抄的第二份漂移时没有任何一处会喊。
 * 它只在 mount 期被调，一次运行也就几次。
 */
export function backendToolNames(service: StreamServiceLike, extras: McpExtras): string[] {
  return toolSpecs(service, withCapabilityTools(extras, () => [])).map((s) => s.name)
}

/** Connect the server over stdio (the usual MCP transport for local agents). */
export async function startStdio(service: StreamServiceLike, extras: McpExtras): Promise<McpServer> {
  const server = createMcpServer(service, extras)
  await server.connect(new StdioServerTransport())
  return server
}
