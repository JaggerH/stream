# Plugin Gateway and Port Rules (Gateway & Ports Cookbook)

> A progressive-disclosure entry point for future AI: when you run into issues such as "a plugin backend cannot connect / ports do not match / `/_p` returns 404", read this first, then follow the file pointers below for deeper detail.

## One-Sentence Mental Model

**There is only one external entry point: `127.0.0.1:8900`. The reverse proxy for `/_p/<service>/*` is handled by the **backend itself** (`mountPluginGateway`; see `src/http/plugin-gateway.ts`), not by Caddy. Plugin containers never open their own doors to the outside.**

There are only two forms:

- **Main path (dev + installed `stream` + MCP)**: **there is no Caddy**. The backend is a native process on the host, and **binding `8900` itself is that door**: `/api`, `/ws`, and `/_p` respond directly; during dev, other paths are forwarded to Vite on the host (`src/http/dev-frontend.ts`), while in release they are packaged static assets (`src/http/static-mount.ts`). It cannot reach container-internal DNS, so plugins use the **host tier** loopback door (see below).
  - Release and dev use the same backend; the only difference is who starts it: release = packaged `server.mjs` (the `stream` command), dev = `tsx watch src/serve.ts`; both bind `8900`.
- **Self-hosted side path (NAS/VPS, `pnpm plugins compose --selfhost`)**: Caddy acts as a **thin edge** on 8900: it forwards `/api`, `/ws`, and `/_p/*` all to `serve-backend` (`Caddyfile.local`) and does not know about any plugin itself; `serve-backend` and every plugin container share the `stream` network, so it directly reaches container DNS to complete the `/_p` reverse proxy.

**`STREAM_PLUGIN_NETWORK` decides how the backend reaches plugin containers. There are three tiers**:

| Tier | Who uses it | How it reaches plugins |
|---|---|---|
| `host` | **Normal main path** (`pnpm dev` / stdio / installed `stream`; `scripts/dev.sh` already sets this by default) | "One door": `compose.ts` publishes a random loopback port `127.0.0.1::<container port>` for each plugin with a backend; after standby wakes the container, it inspects that port, caches the origin, and the backend connects directly (header comment in `plugin-target.ts` + spec `2026-07-22-host-plugin-door-design.md`) |
| `compose` | Only the self-hosted side path remains | On the same `stream` internal network as the plugin; `resolvePluginTarget` statically resolves container DNS `http://<service>:<port>` |
| `none` | No plugin containers are running | Cannot reach them: the `/_p` gateway is not mounted at all (prints `/_p gateway not mounted`), `resolvePluginTarget` returns `null`, and the proxy count is zero. **The core keeps running** |

The number of host ports is O(1) and does not grow with the number of plugins; **random loopback ports do not violate this rule** (they bind `127.0.0.1`, live and die with containers, and do not consume the external budget). The real rule to enforce is: **do not add fixed `ports:` entries for ordinary backends**.

## Two Container Types, Two Exit Paths (This Is the Easiest Place to Be Misled)

| Type | Exit path | Examples |
|---|---|---|
| Ordinary plugin backend (no human UI) | `expose` + one **random loopback port** (`127.0.0.1::<container port>`, the host-tier data plane); clients always go through `/_p/<service>/*` | pansou, douyin-tiktok-download-api |
| Facility with its own management UI | Declare `publish: <host port>` in `stream.backend` and publish it **additionally** and directly (`0.0.0.0`) | The mechanism exists (`src/packages/descriptor.ts` schema + `compose.ts` `backendService`), but **no plugin uses it** (`grep publish packages/*/package.json` = 0). This includes AList: it is expose+loopback; Stream takes full control of its storage configuration through login state + bootstrap and does not expose AList's own UI/password. |

The generated artifacts contain **only plugin containers** and no infrastructure containers at all (`compose.test.ts` pins this). Login state does not pass through containers: the browser extension pushes directly to the backend; see `docs/PACKAGE.md` §5.2.

Misconception recap: the port list in `docker ps` is not the plugin gateway routing table. **`docker ps` now shows one `127.0.0.1:<random port>->...` for each running plugin**; that is the host-tier data plane, not "this plugin opened a port to the outside", and it is not part of the gateway rules. The `/_p` routing table exists only inside `mountPluginGateway`. Conversely, when a container is **stopped**, that port does not exist (it lives and dies with the container), so not seeing a plugin in `docker ps` does not mean it is broken.

## Single Source of Truth (Where to Change Things)

- `src/plugins/gateway.ts` — `GATEWAY_PORT` (default 8900), `GATEWAY_PREFIX` (`/_p`), and `pluginGatewayUrl()` (root-relative URL for clients). The compose generator and frontend code both import from here; **do not hard-code the port elsewhere**.
- `src/http/plugin-gateway.ts` — `mountPluginGateway`: the backend's own `/_p/<service>/*` reverse proxy, which strips the prefix, passes through method/headers/body, and streams the response back. The target origin is resolved by `resolvePluginTarget` in `src/plugins/plugin-target.ts` (compose form: container DNS) or by the standby `standbyOrigin` cache (host form: the random loopback port inspected after wakeup); none: no route is registered. **This is where routing actually takes effect, not the Caddyfile.**
- `src/plugins/compose.ts` — generates compose services from each plugin `package.json` `stream` field (and also generates the thin Caddyfile when `--selfhost` is used):
  - Ordinary backend → `expose: [port]` + `ports: ["127.0.0.1::<port>"]` (`backendService`; the latter is the host-tier data plane)
  - `backend.publish` → additional `ports: ["<publish>:<port>"]`
  - Gateway service itself (thin-edge Caddy) → `ports: ["127.0.0.1:8900:80"]` (`services.gateway`) — **it is generated only for the `--selfhost` tier**: the condition is that `opts.stream` is present, because on the main path the backend itself is the door, and a Caddy standing there has nowhere to forward
  - `generateCaddyfile` → only `import Caddyfile.local`: plugin `/_p` reverse proxying has been folded into the backend, so no plugin routes are generated on the Caddy side.
- `Caddyfile.local` (`.example` is the seed) — the handwritten thin-edge routes **only for the self-hosted tier**: `/api`, `/ws`, and `/_p/*` → `serve-backend`; `/` also → `serve-backend` (the UI lives in the separate front-door page it serves). The main path has no Caddy, so these two files do not participate.
- `packages/<name>/package.json` (`stream.backend`) — each plugin declares its own backend (image/port/health/gpu/volumes/mem/publish, etc.). (`src/plugins/` is the **code** for loader/compose/gateway, not where descriptors live.)
- `docker-compose.override.yml` — the local dev override generated by the generator (it replaces `backend.dev` services with local source mounts); **do not edit it by hand and expect the change to persist**, because rerunning generation overwrites it.

## Troubleshooting Order (Increase Depth Gradually in This Order)

1. **On the host machine** (browser / curl / Postman / host-side script), a request to `http://localhost:8900/...` reports `ECONNREFUSED / fetch failed` → first confirm that the backend is running (main path: `pnpm dev`; that door is the backend itself); if it still does not connect, switch to `127.0.0.1:8900` (the self-hosted-tier gateway publishes only IPv4, and some fetch clients resolve `localhost` by trying `::1` first and fail). **This does not apply to server-side adapters**: adapters no longer go through the gateway port; they use `resolvePluginTarget` (`src/plugins/plugin-target.ts`) to connect directly to container DNS `http://<service>:<port>`. For `ECONNREFUSED / fetch failed` on the adapter side, check whether the descriptor / `STREAM_PLUGIN_NETWORK` wiring is correct (see item 4).
2. `/_p/<service>` **404** → the backend did not register that route at all: `mountPluginGateway` prints `/_p gateway not mounted` when there is no target (= `none` tier, no plugin containers are running), or that service is not in descriptors.
3. `/_p/<service>` **502, and it returns immediately** (not a timeout) → the host tier cannot obtain an origin. The most common reason is not "the container is sleeping" (sleeping containers can be woken), but that **the container does not exist at all**: `docker compose down` **deletes** stopped plugin containers, while standby only starts and stops them; it does not create them. Fix with `docker compose create`, then hit it again and you should see a 2-3 second wakeup.
4. To debug by connecting directly to a backend → when the container is running, curl the `127.0.0.1:<random port>` shown in `docker ps` (the host tier uses it by design), or use `docker compose exec` to enter the container; do not add `publish` for debugging.
5. Remote stack / release package → client-side code uses `pluginGatewayUrl`, which always returns root-relative `/_p/<service>`; the server-side fetch base is decided by `STREAM_PLUGIN_NETWORK` (main path `host` → standby loopback origin; self-hosted `compose` → container DNS). Explicit URL configuration for an individual adapter has higher priority. **There is no such configuration as an "overall base url"**: using one base for two purposes (both clients and backend self-fetches) is wrong; the two are separate.

## Related Topics

- Overview of Stream packages and the `package.json#stream` field: `docs/PACKAGE.md`
- Overall architecture: `docs/ARCHITECTURE.md`
- AList / netdisk integration design: `internal design record` (AList is now expose-only; Stream automatically takes over its storage configuration through the login-state broker + bootstrap, no longer through manual setup in a Web UI published by the host; externally, it only goes through `/api/netdisk/*`)
