import type { Hono } from 'hono'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createMcpServer, type McpExtras } from '../mcp/server.ts'
import type { StreamServiceLike } from '../mcp/tools.ts'

/**
 * Mounts the MCP server on `/api/mcp` of an already-built Hono app, stateless mode
 * (no per-session state — every tool call is a one-shot request/response, so there's
 * nothing to key by session). Reuses the exact same `service`/`extras` the REST routes
 * on this app were built with, so MCP and the web frontend share one live
 * Scheduler + user store instead of drifting apart across separate processes.
 *
 * Inherits the app's existing `/api/*` auth middleware and Caddy proxy rule for free —
 * no new route prefix, no new reverse-proxy config.
 *
 * A fresh McpServer + transport is created per request: the SDK's stateless mode
 * (`sessionIdGenerator: undefined`) explicitly forbids reusing one transport across
 * requests — reuse throws "Stateless transport cannot be reused across requests"
 * on the second call. `service`/`extras` are captured once and shared across every
 * request's fresh server — only the protocol-layer objects are per-request.
 */
export async function mountMcp(app: Hono, service: StreamServiceLike, extras: McpExtras): Promise<void> {
  app.all('/api/mcp', async (c) => {
    try {
      const mcpServer = createMcpServer(service, extras)
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      await mcpServer.connect(transport)
      return await transport.handleRequest(c.req.raw)
    } catch (e) {
      // **停机窗口里的调用要干净拒绝，不能变成未捕获错误。** agent 修复/探索会话的子进程在
      // 后端关停的那几分钟里还活着（它们的 kill 有宽限期），会照常打工具；而 cordis 域已经
      // inactive、库已经关上，工具一碰 `ctx` 就抛（活体 2026-11-15：`cannot get required
      // service "packages" in inactive context`、`unhandledRejection: The database connection
      // is not open`）。回一个 MCP 客户端认得的 JSON-RPC 错误信封，让它把这轮判成失败自己
      // 放弃，而不是把正在退出的进程炸出裸栈。
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 300)
      console.error(`[mcp] /api/mcp 请求被拒绝（服务关停中或处理失败）：${message}`)
      return c.json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: `stream 服务正在关停或暂时不可用，MCP 调用被拒绝：${message}` },
      }, 503)
    }
  })
}
