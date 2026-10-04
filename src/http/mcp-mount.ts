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
    const mcpServer = createMcpServer(service, extras)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await mcpServer.connect(transport)
    return transport.handleRequest(c.req.raw)
  })
}
