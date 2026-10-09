# Stream

**English** | [简体中文](README.zh-CN.md)

**Let your AI find the way once. Stream writes the route down — then replays it on a schedule, with
no tokens spent, inside desktop apps too, and calls the AI back only when it breaks.**

Today's agents can drive a browser and a computer for you, but doing the same thing a second time
is no cheaper and no more reliable than the first. Stream freezes the route an agent got working
into a **recipe** — executable data, not a prompt — and a local scheduler replays it in **your own
logged-in Chrome** and in **desktop clients**, with no model in the loop.

Underneath, it is a self-hostable **information-flow layer**: many sources — RSSHub routes plus
native adapters (Xiaohongshu, Bilibili, Douyin, podcasts, netdisks, …) — flow into one inbox,
served to a web UI and to AI agents (MCP) from a single process. All data stays on your machine.

## Architecture in one paragraph

You subscribe to **Channels** (Timeline / Search / Audio). A Channel aggregates **Streams** —
scheduled feed members that pull from one or more **Sources** (`strategy: fanout` merges them
all; `strategy: exclusive` takes the first healthy one). Every Source belongs to exactly one
**Plugin** (adapter + presenter + optional managed backend container), which is how it actually
executes. Stateless on-demand capabilities (search, audio download) are **Providers** — global,
parameterized, internally exclusive over their Sources. Authoritative definitions, invariants,
and data flow: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Quick start

```bash
npx @streamapp/stream                    # try it
npm i -g @streamapp/stream && stream     # keep it
```

Requires **Node 20+** and nothing else — no git, no Docker, no compiler. Then open
<http://127.0.0.1:8900>; that one port is the web UI, `/api/*`, `/ws`, and MCP. All data lives in
`~/.stream` (uninstall = delete it + `npm rm -g @streamapp/stream`).

**Already using Claude Code / Codex / OpenClaw?** Paste this to it and it installs and connects
itself:

```text
Install Stream with `npm i -g @streamapp/stream`, start it with `stream`, verify
`curl -s 127.0.0.1:8900/api/health` returns ok:true, then register it as an MCP server
(`claude mcp add stream -- stream mcp`, or the equivalent one line for this host) and install its
skills with `curl -s -X POST 127.0.0.1:8900/api/skills/install`. If the browser extension is not
connected (`/api/browser-capability` is not "ready"), walk me through loading it.
```

Every failure mode on the way from “installed” to “actually working for me” is silent, so check by
side effect, in this order:

| Question | Command | What green looks like |
|---|---|---|
| Is the backend alive? | `curl -s 127.0.0.1:8900/api/health` | `{"ok":true}` |
| Is the browser extension connected? | `curl -s 127.0.0.1:8900/api/browser-capability` | `"state":"ready"` |
| Is my stream scheduled? | `curl -s 127.0.0.1:8900/api/streams` | the id you created is listed |
| Did it actually harvest anything? | `POST /api/streams/<id>/refresh` | `fetched > 0` **and** `written > 0` |
| Is this capability usable now? | `curl -s 127.0.0.1:8900/api/conversion-kinds` | its `available` / `branches.*` is true |

- **Without the Chrome extension, login-gated sites return guest-level content — with no error.**
  Harvesting borrows the login state of your own browser; Stream ships no browser and stores no
  passwords.
- **Create a stream with `channel_id`.** A stream that belongs to no channel runs this session and
  is gone after a restart.
- **`fetched: 0` does not mean “nothing new”** — more often the source does not resolve, the
  parameters are wrong, or login state is missing.

**The full step-by-step guide** — installing the extension, subscribing the first stream, turning
on transcription, connecting a chat host, installing skills, running a recipe from the command
line — is **[cli/README.md](cli/README.md)** (the same page npm shows).

## MCP usage

Stream exposes the **same tool set over two transports** — pick per client:

| Transport | Available in | Use when | Needs a standing backend? |
|---|---|---|---|
| **stdio** — `stream mcp` | every npm install | the default. One line, and it works whether or not the backend is up | **No** — it starts one for you |
| **HTTP** (streamable) — `http://127.0.0.1:8900/api/mcp` | every install | you already keep a backend running and would rather point the client straight at it | **Yes** |
| **stdio** — `src/mcp/stdio-entry.ts` | source checkouts only | you are working in the repo and want read tools to keep answering with no backend at all | **No** |

**Claude Code**
```bash
claude mcp add stream -- stream mcp                                     # stdio — the normal install
claude mcp add --transport http stream http://localhost:8900/api/mcp    # HTTP — backend already running
# source checkout, read tools with no backend at all
claude mcp add stream --env STREAM_DATA_DIR=<abs>/stream/data \
  -- npx tsx --tsconfig <abs>/stream/tsconfig.json <abs>/stream/src/mcp/stdio-entry.ts
```

**Codex** (`~/.codex/config.toml`)
```toml
[mcp_servers.stream]
command = "stream"
args = ["mcp"]
# HTTP form (backend up): set `url = "http://localhost:8900/api/mcp"` instead of command/args,
# if your Codex build supports streamable-HTTP MCP servers.
```

**antigravity / Gemini CLI** (`~/.gemini/settings.json`) and **Claude Desktop** (same shape)
```json
{ "mcpServers": { "stream": { "command": "stream", "args": ["mcp"] } } }
```
For the HTTP form use `"httpUrl": "http://localhost:8900/api/mcp"` in place of `command`/`args`.

- Add `Authorization: Bearer <api_token>` to the HTTP form only if you set `api_token`.
- In the source-checkout form, **keep the `--tsconfig`**: tsx reads the `tsconfig.json` of the
  client's *working directory*, not Stream's, and a tsconfig it cannot parse kills the server on
  start with only `CONNECTION_CLOSED` to show for it.
- **Tool-list changes are server-side.** When the served tools change, nothing needs reinstalling —
  each client reconnects/restarts to re-pull `tools/list`.

How the transports work (probe rule, what degrades without a backend, env vars):
[docs/ARCHITECTURE.md → *MCP over stdio*](docs/ARCHITECTURE.md).

## Login state

Cookie-protected sources (Bilibili, Weibo, Xiaohongshu, Quark, …) need your browser's login state.
**There is nothing to configure, and no container involved**: install the extension, and the
backend pulls the cookies it needs from your Chrome when it needs them — which domains is derived
from what you have installed and subscribed to. They land in `data/cookies.json`, mode 0600.
Plugin backend containers never hold credentials. Details: [docs/PACKAGE.md](docs/PACKAGE.md) §5.

## Current limitations

- Linux has no Stream Desktop binary. Sources that need a logged-in browser can
  still run there, but only see guest-visible content and may not report that
  limitation as an error.
- Native desktop control is available on Windows. macOS supports the browser
  pairing portion only; it does not control arbitrary desktop windows.
- The recipe-authoring loop is not yet end-to-end: recording, reviewing, and
  publishing a robust recipe still needs manual development work.
- Action recipes protect their steps with drift checks, but a changed UI can
  still leave an action partly completed; retrying without checking the target
  can repeat a side effect.
- Upgrading a very old local data store may require manual recovery rather than
  an automatic migration.
- Built-in packages that require a managed container are installed with the
  main release and cannot currently be added later with `stream add`.

## From source

For changing the code or authoring RSSHub routes. Needs Node 20+ and pnpm 10+.

```bash
git clone <this-repo-url> stream && cd stream
pnpm install
cp config.example.yaml config.yaml           # edit paths
pnpm test && pnpm typecheck
pnpm dev                                     # backend on :8900
curl -s http://127.0.0.1:8900/api/health     # {"ok":true} when up
```

Plugin backends (pansou, AList, Douyin, …) are optional containers, started separately with
`pnpm plugins compose > docker-compose.yml && docker compose up -d`. Prerequisites in full, the
optional RSSHub clone, upgrading an old data store, logs, and the self-hosted all-in-one container
form: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Contribution workflow:
[CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

Most documents under `docs/` are currently written in Chinese.

| Document | What it answers |
|---|---|
| [cli/README.md](cli/README.md) | The full user guide: install, first stream, capabilities, connecting an agent |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The model (Channel / Stream / Source / Plugin / Provider), configuration layers, scheduling, serving, ad filtering, where things live in the code |
| [docs/PACKAGE.md](docs/PACKAGE.md) | Adding a source or a plugin: manifest, recipe, code, container, and credential slots |
| [docs/API.md](docs/API.md) | HTTP API: streams, channels, conversions, packages, access control |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Running from source, day-to-day ops, release shapes |
| [docs/GATEWAY.md](docs/GATEWAY.md) | Plugin gateway and port rules |
| [docs/AGENT-TOOLING.md](docs/AGENT-TOOLING.md) | Adding tools for chat agents and verifying they are really used |
| [extension/README.md](extension/README.md) | The browser extension |

## Status

Dogfooding daily. Stream is licensed under the [Apache License 2.0](LICENSE).
