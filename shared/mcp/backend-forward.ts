import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

/** stdio↔HTTP thin proxy (design Open Q leaning, §"backend-forward-service 形态"): a low-level
 *  MCP Server that forwards every ListTools/CallTool/ListResources/ReadResource it receives on
 *  its (stdio-facing) side to a Client connected over HTTP to the running backend's /api/mcp.
 *  Deliberately does NOT go through createMcpServer — no StreamService/tool logic lives here,
 *  every tool call still executes inside the backend's one createMcpServer, so "one tool logic"
 *  holds even though this bridge never builds a service. Takes only a URL — no config/db path,
 *  so it structurally cannot open the local database (D5). */
export async function makeBackendForwardServer(backendUrl = 'http://127.0.0.1:8900'): Promise<Server> {
  const client = new Client({ name: 'stream-stdio-forward', version: '0.1.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${backendUrl}/api/mcp`)))

  const server = new Server({ name: 'stream', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => client.listTools())
  server.setRequestHandler(CallToolRequestSchema, (req) => client.callTool(req.params))
  server.setRequestHandler(ListResourcesRequestSchema, () => client.listResources())
  server.setRequestHandler(ReadResourceRequestSchema, (req) => client.readResource(req.params))
  // Close the backend-facing HTTP client when the stdio-facing side closes (client disconnect,
  // stdin EOF) so the forwarded connection doesn't linger after this process is done with it.
  server.onclose = () => void client.close()
  return server
}
