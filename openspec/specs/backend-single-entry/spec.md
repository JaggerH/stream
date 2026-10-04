## Purpose

宿主上只有一扇门：后端自己发前端静态资源、自己当插件网关，对外发布的端口数恒为一。

## Requirements

### Requirement: Backend serves the built frontend
When the backend runs as the app's hosted sidecar (release), it SHALL serve the built frontend static assets at `/`, so the webview loads the UI same-origin from the backend. In dev the frontend is served by Vite via the Tauri shell's `devUrl`, and the backend SHALL NOT serve static assets — the dev/release difference is source (Vite HMR) vs artifact (built static), nothing else.

#### Scenario: Release serves static
- **WHEN** the backend runs from the packaged app (release)
- **THEN** a request to `/` returns the built frontend `index.html` and its assets from the backend, with no separate frontend server

#### Scenario: Dev leaves the frontend to Vite
- **WHEN** the backend runs in dev
- **THEN** the backend does not serve `/` static assets; the webview loads the frontend from Vite (`devUrl`), and `/api` `/ws` `/_p` `/api/mcp` still resolve to the backend

### Requirement: Backend owns the plugin gateway
The backend SHALL be the single authority for the `/_p/<plugin>` plugin gateway: it both mints the root-relative `/_p/...` URLs handed to clients and reverse-proxies `/_p/<plugin>/*` to that plugin's backend. It SHALL resolve the proxy target per deployment shape — in compose, the plugin's in-network address derived from its descriptor (e.g. `pansou:8888`); in the desktop shape, the single-door loopback (that door is a later change). When no plugin gateway target is configured (e.g. desktop with no container plugins), the backend SHALL NOT serve `/_p` and core functionality SHALL continue unaffected.

#### Scenario: Compose proxies to in-network plugin
- **WHEN** the backend runs on the `stream` network and a request hits `/_p/pansou/search`
- **THEN** the backend reverse-proxies it to the pansou container by its in-network address, and the plugin container publishes no host port

#### Scenario: No gateway target configured
- **WHEN** the backend runs with no plugin gateway target (no container plugins)
- **THEN** `/_p` is not served and all core routes (`/`, `/api`, `/ws`, `/api/mcp`) work normally

#### Scenario: Single URL authority
- **WHEN** the backend hands a client a plugin URL
- **THEN** it is a root-relative `/_p/<plugin>/...` path resolved same-origin by the backend itself — no internal host name leaks to the client

### Requirement: Single published port invariant
The host SHALL expose exactly one published port for the core — the backend at a fixed loopback port `127.0.0.1:8900`. Plugin backends SHALL remain unpublished, reachable only through the backend's `/_p` gateway. `/api/mcp` SHALL ride the same port under `/api` and SHALL NOT occupy a separate port. This invariant SHALL hold identically in dev, compose, and the desktop shape.

#### Scenario: Only the core port is published
- **WHEN** the stack is running with plugins enabled
- **THEN** the only host-published port is the backend's `127.0.0.1:8900`; every plugin backend is unpublished and reached via `/_p`

#### Scenario: MCP shares the core port
- **WHEN** an MCP client connects to `http://127.0.0.1:8900/api/mcp`
- **THEN** it reaches the backend's MCP mount under `/api` with no dedicated MCP port
