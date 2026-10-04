## Purpose

给 AI 的 MCP 工具面：解析与内容搜索工具、搜索工具之间对 agent 消歧，以及后端不在时经 stdio 仍可用、写操作优雅降级。

## Requirements

### Requirement: Parse MCP tool
The MCP server SHALL expose a `parse` tool taking an item id or a url and returning the extracted markdown. The tool SHALL serve from the same persistent per-item parse cache as the HTTP endpoint, triggering parsing on a miss and returning the markdown (or a running/error status) on a hit.

#### Scenario: Parse by item id
- **WHEN** the `parse` tool is called with an item id that has a cached parse result
- **THEN** it returns the cached markdown without re-invoking the backend

#### Scenario: Parse a fresh item
- **WHEN** the `parse` tool is called for an item with no cached parse result
- **THEN** it triggers parsing via the MinerU backend and returns the resulting markdown (or a running status to poll)

### Requirement: Content-search MCP tool
The MCP server SHALL expose a `content_search` tool when content search is wired (`extras.contentSearch` present), gated the same way as the other optional tools. The tool SHALL accept `{ query: string }` and return the items retrieved from the user's configured searchable sources (the registry-driven content-search core). When content search is not wired, the tool SHALL NOT be registered.

#### Scenario: Tool exposed when wired
- **WHEN** the MCP server is created with `extras.contentSearch` provided
- **THEN** a `content_search` tool is registered and a call with a query returns the content-search items as JSON content

#### Scenario: Tool omitted when not wired
- **WHEN** the MCP server is created without `extras.contentSearch`
- **THEN** no `content_search` tool is registered

### Requirement: Search tools are disambiguated for the agent
The three search-capable MCP tools SHALL carry descriptions that make their distinct jobs unambiguous, so an agent routes a request to the correct one: `stream_search` navigates the source registry (which sources exist and their call schema; it returns sources, not content); `content_search` retrieves real items from the user's configured searchable sources to answer a question; `video_search` searches film/TV/anime download sources (magnet/netdisk). Each description SHALL state what the tool returns and when to prefer it over the other two.

#### Scenario: Descriptions contrast retrieval vs navigation vs download
- **WHEN** the agent inspects the tool list
- **THEN** `content_search` is described as content retrieval from configured sources, `stream_search` as registry navigation returning sources, and `video_search` as download-source search — each distinguishable from the others

### Requirement: MCP is available over stdio without a running backend
The MCP server SHALL be launchable as a stdio subprocess by an MCP client (e.g. Claude Desktop's `mcpServers` config), serving the same tools over `StdioServerTransport` that the HTTP transport serves. This SHALL NOT require a running backend process or a listening port. The MCP tool logic (`createMcpServer` + `src/mcp/*`) SHALL remain a single implementation shared by both the HTTP and stdio transports — the stdio entry is a thin transport shell, not a second tool implementation.

#### Scenario: stdio MCP with no backend serves read tools
- **WHEN** an MCP client spawns the stdio MCP subprocess and no Stream backend is running
- **THEN** the server completes the MCP handshake, lists its tools, and a read/query tool (e.g. content-search) returns correct results sourced from disk — with no port and no backend process

#### Scenario: same tools over both transports
- **WHEN** the same tool is invoked over the HTTP transport and over the stdio transport
- **THEN** it runs the same `createMcpServer` tool code (no duplicated implementation), and the HTTP transport's behavior is unchanged from before this change

### Requirement: stdio entry adapts its data source to backend presence
On startup the stdio MCP entry SHALL probe for a running backend (`GET http://127.0.0.1:8900/api/health`). If a healthy backend is present, the entry SHALL route tool invocations to that backend (the single authority — freshest state, no direct database access). If no backend is present, the entry SHALL construct a disk-backed service by reusing the shared bootstrap to open the stores directly. At any time the database SHALL have exactly one uncontrolled accessor — the backend when it is running, otherwise the stdio process — so the two never contend for it.

#### Scenario: routes to a running backend
- **WHEN** the stdio MCP entry starts and a healthy backend answers `/api/health` on 8900
- **THEN** tool calls are routed to that backend and the stdio process does not open the database directly

#### Scenario: falls back to disk when no backend
- **WHEN** the stdio MCP entry starts and no backend answers the health probe (including probe timeout)
- **THEN** it constructs a disk-backed service via the shared bootstrap and serves read tools from disk

### Requirement: write/action tools degrade gracefully when no backend is present

When the stdio MCP entry has no running backend to route to, a write or action tool SHALL NOT
write to the database directly. A read/query tool SHALL NOT spawn anything. An action tool
SHALL spawn the Stream backend on demand (resolve command via STREAM_BACKEND_CMD env, else the
serve entry run with the current runtime), wait for /api/health, then forward the call — unless
STREAM_STDIO_NO_SPAWN=1, in which case it SHALL return the structured "needs backend running"
error as before. The stdio process SHALL terminate a backend it spawned when it exits, and
SHALL NOT terminate a backend it merely reused.

#### Scenario: action tool without backend spawns it
- **WHEN** the stdio entry runs disk-mode and an action tool (e.g. transcribe) is called
- **THEN** the entry spawns the backend, waits for /api/health, forwards the call, and
  subsequent calls route to the backend

#### Scenario: read tool without backend stays on disk
- **WHEN** the stdio entry runs disk-mode and a read tool is called
- **THEN** it is served from disk and no process is spawned

#### Scenario: NO_SPAWN opt-out restores the old error
- **WHEN** STREAM_STDIO_NO_SPAWN=1 and an action tool is called with no backend
- **THEN** the tool returns the structured "needs backend running" error and spawns nothing
