## Purpose

内核之上的 REST 适配层：webview 的跨源访问、Provider 调用点绑定 API，以及删除冲突的响应形状。

## Requirements

### Requirement: REST adapter over the core
The backend SHALL expose an HTTP API over the same `StreamService`/registry/scheduler the MCP adapter uses, with no business-logic duplication: `GET /api/streams`, `GET /api/items`, `GET /api/search`, `GET /api/status`, `GET /api/health`, `POST /api/subscribe`, `POST /api/unsubscribe`.

#### Scenario: List streams
- **WHEN** a client GETs `/api/streams`
- **THEN** it receives the named streams (id, description, type)

#### Scenario: Items merged and per-stream
- **WHEN** a client GETs `/api/items` (optionally `?stream=<id>&limit=<n>`)
- **THEN** it receives recent items newest-first from the item store, merged or filtered

#### Scenario: Search the registry
- **WHEN** a client GETs `/api/search?intent=<q>`
- **THEN** it receives ranked source candidates with their schema

#### Scenario: Status reports readiness
- **WHEN** a client GETs `/api/status`
- **THEN** it receives the login-cookie snapshot (`cookies`: which domains are held + when it was last taken) and manifest/stream counts

#### Scenario: Subscribe adds a stream
- **WHEN** a client POSTs a named-stream definition to `/api/subscribe`
- **THEN** the stream is added, scheduled, and persisted, and appears in `/api/streams`

### Requirement: Cross-origin access for the webview
The API SHALL permit requests from the Tauri webview and localhost origins; a remote backend SHALL additionally require a bearer token.

#### Scenario: Local webview origin allowed
- **WHEN** the Tauri webview calls the local API
- **THEN** the request is permitted (CORS allows the webview/localhost origin)

#### Scenario: Remote requires token
- **WHEN** a remote backend is configured with a token and a request omits or mismatches it
- **THEN** the request is rejected as unauthorized

### Requirement: Provider callsite binding API
The HTTP API SHALL list Provider callsites with their current binding and compatible Provider candidates, and
SHALL support reading, replacing, clearing where allowed, and restoring each binding.

#### Scenario: List configurable callsites
- **WHEN** a client GETs the Provider callsites endpoint
- **THEN** it receives each descriptor, current binding, compatible Provider candidates, and usage metadata

#### Scenario: Replace a fixed binding
- **WHEN** a client PUTs one compatible Provider id to a fixed callsite binding endpoint
- **THEN** subsequent calls through that callsite use the selected Provider

### Requirement: Provider deletion conflict response
The HTTP API SHALL return HTTP 409 rather than a system-row validation error when deleting a Provider that is
referenced by one or more bindings, and SHALL include the blocking callsite ids in the error details.

#### Scenario: Referenced Provider cannot be deleted
- **WHEN** a client DELETEs a Provider with active binding references
- **THEN** the response is HTTP 409 and includes every blocking callsite id
