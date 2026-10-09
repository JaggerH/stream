# API Design Standards

## Principles & Rules

1. **Eliminate Redundant Endpoints**:
   - Avoid duplicating system check or metadata endpoints.
   - `/api/status` is the one rich system endpoint (`{ ok, cookies, manifests, streams: [{id, last_tick, item_count}] }`) — its HTTP 200 doubles as a liveness signal for authenticated callers. Do not add parallel metadata endpoints that duplicate it. (`/api/health` was folded into it 2026-07-02.)
   - **Sanctioned exception — `/api/health`**: a deliberately minimal, **unauthenticated** liveness probe (`{ ok: true, commit?, started_at, dirty_since_start, last_harvest_at?, pending_restart? }`), registered *before* the access guard (see Access Control below). It exists because the MCP spawn-or-reuse readiness gate (`src/mcp/spawn-backend.ts`) needs a probe that (a) works before any `api_token` is configured and (b) **never fails, and never waits on anything remote**. Keep it minimal and non-fallible — never give it data dependencies that can throw. (A regression once made it `await deps.health()`, so a failure inside an unrelated dependency 500'd the probe and broke that liveness contract; `last_harvest_at` now comes from a separate synchronous read-only closure.) It is not `/api/status`'s twin and carries no system detail.
     - The build-identity fields (`src/http/build-identity.ts`) answer **"which copy of the code is this process actually running"** — the only cheap defence against a hot-reload that silently missed a change, where "the switch was never wired" and "the change made no difference" look identical. They are the one sanctioned bit of local I/O on this path, and they stay inside the contract by construction: the whole block is wrapped in `try/catch` (a failure costs fields, never the 200), nothing is awaited, nothing touches the network. Measured cost: `git rev-parse` **3 ms once** (memoised for the process lifetime), and a `.ts` mtime scan of `src`+`shared`+`packages` **4–5 ms, at most once per 5 s** (cached; the readiness gate polls far faster than that). Adding a field here means keeping all four properties — local, synchronous, bounded, guarded.
     - `dirty_since_start` is a **hint, not an alarm**: any parallel worktree's uncommitted WIP counts toward it, so `> 0` is ordinary. `0` is the strong signal; the verdict you actually act on is whether `commit` is the one you meant to test. Never assert on it.
   - **Sanctioned exception — `GET /api/ext/relay-status`**: the ext-relay connection probe (`{ connected, since }`, `since` = ISO instant the *current* connection was established, `null` when down), likewise **unauthenticated** and registered *before* the access guard (see Access Control below) — it is the first diagnostic step when the extension seems offline, and demanding a credential exactly then defeats the purpose. Read-only, no side effects, no data; the relay dep being absent returns 404 (backend has no relay wired) rather than pretending "extension not connected". Added 2026-07-27 after a misdiagnosis burned four rounds of debugging because the relay had no observable surface at all (see also the connect/disconnect log lines in `shared/browser-relay/relay.ts`).

   - **Sanctioned exception — `GET /api/ext/claimed-tabs`**: which browser tabs the backend is *currently* driving (`{ tabIds: number[] }`), **unauthenticated** and registered before the access guard for the same reason as `relay-status` — the extension's reconciliation must not depend on holding a credential. It exists because lane→tab lives only in backend process memory: a restart orphans every harvest tab still open in the user's Chrome, and the extension can only reclaim them by asking whose tabs are still claimed. **An empty array and a failure are different answers and must stay different**: `[]` means "the backend claims none" (the normal post-restart state — reclaim them), whereas a missing session dep returns **503** so the extension does nothing. Returning `[]` on a wiring failure would tell the extension to close every tab in the group. The reclaim policy itself (only `probe` origin; never `adopted`, never `created`) lives in the extension, not here — see `write-recipe`'s `references/session-runtime.md`.

   - **Sanctioned exception — `GET /api/browser-capability`**: the harvest-capability quick verdict (`{ state, connected, since, everSeen, lastSeenAt?, extVersion?, browser?, platform? }`), also **unauthenticated** and registered before the access guard — the onboarding guidance has to be readable *before* a token exists. Not a duplicate of `relay-status`: that one answers "is it connected right now" from live state only, this one adds the persisted `everSeen` history, so `state` collapses to the three onboarding lines `ready` / `disconnected` / `never-seen` (design 2026-07-29 §5). `everSeen` is **monotonic and never expires** — the extension runs *inside* Chrome, so one connection answers both "is Chrome installed" and "is the extension installed", and "was installed once" is a historical fact an uninstall cannot undo (hence no TTL anywhere). Pure read of relay state + the `data/browser-capability.json` cache: **no probing, no waiting, no waking anything**, so it always returns instantly. `connected:false` is NOT a health verdict (an MV3 service worker being reclaimed is normal) and must never be written into `sourceHealth`.

   - **Sanctioned exception — `POST /api/browser-capability/diagnose`**: the *full* diagnostic, same shape as the quick verdict **plus** a `chrome` block (`{ selected, origin, candidates[], mustChoose }`). Unauthenticated for the same onboarding reason. The split is the point: the quick verdict never touches the filesystem so it always returns instantly, while this one enumerates Windows mounts and stats candidate `chrome.exe` paths — run it only when the quick verdict says `never-seen`, or when the user explicitly asks (design 2026-07-29 §5: existing users never reach it). POST, not GET, because it *does* work rather than read state.

   - **`/api/extension/{onboarding,materialize,install,decline}` — the four install-guidance routes are registered
     *after* the gate and are not exemptions.** The check is "whether there are side effects": the two quick verdicts above are pure reads, and install guidance must be readable before a credential
     exists; but `install` **drives the user's own desktop**, and `decline` writes to disk, so anything with side effects does not enter
     the exemption list. `onboarding` is GET (reads "whether it has been declined", `{ declinedAt? }`), and the other three are POST.
     `install` returns three states, `{ status: 'connected' | 'needs-chrome-restart' | 'blocked', reason? }`:
     **`blocked` must include the original `reason` text** (which control in which step failed to match); narrowing it to "cannot install" throws away the debugging
     clue. **Throwing an exception (500) and `blocked` are two different things**: the former means this run never started at all (Stream
     Desktop is not connected), so inspect Stream Desktop; the latter means it ran and got stuck at some step, so inspect Chrome. Missing dep -> all four routes return 404;
     do not disguise it as "cannot install".

     **MCP face — `harvest_capability`** (no parameters): the same structure this endpoint returns, over MCP. One shape, two doors — both assemble it through `diagnoseCapability()` in `src/browser/capability-store.ts`, so a field cannot exist on one side only. MCP gets *only* the full tier, not the quick/full split: the split exists because the onboarding page must render instantly, which a deliberate tool call has no equivalent of, and what a pure-MCP caller most needs — "which side do I install on" — is exactly what the `chrome` block answers. Guarded to `NeedsBackendError` in stdio disk mode (`src/mcp/disk-service.ts`): with no HTTP server there is no `attachExtRelay`, so the verdict would read `disconnected` ("reload the extension") when the truth is "the backend is not running" — the one read-shaped extra guarded for honesty rather than for writes.

   - **`GET|PUT /api/settings/harvest-browser`**: which Chrome harvesting rides (`{ selected, origin, candidates[], mustChoose }`; PUT takes `{ exe }`). Same `chrome` block the diagnostic embeds — one shape, two doors, no second projection. The backend **lists candidates and never picks one**: WSL + Windows both having Chrome is a legal state, and choosing wrong fails silently (harvest runs as a guest, everything "works", nothing is collected), so `mustChoose` exists to make the entry point stop and ask. PUT rejects a non-existent path with 400 rather than storing it — otherwise the failure surfaces hours later in an unrelated harvest round (the existence check lives on the `harvest-browser` config row's `validate` hook, so the generic `PUT /api/config/harvest-browser` gets the same rejection). The same field has three faces (web/app settings, desktop onboarding, `harvest_browser.exe` in config.yaml); this is the HTTP one.

   - **`GET|PUT /api/config/:rowId`** — the generic **config row** pair (engine: `src/settings/config-rows.ts`, spec `2026-08-17-config-rows-slice1`). GET returns `{ schema, values, secrets }`: `schema` is the row's schemastery `toJSON()` (the frontend revives it with `new Schema(json)` and renders the form from it), `values` is the layered merge (schema defaults ← config.yaml deploy defaults ← user layer) **with secret fields removed**, `secrets` maps each `.role('secret')` field to `{ configured }`. PUT takes a partial values object: unknown keys are **rejected with 400** (the strict-input gate below — the legal keys are the row's own schema keys, `rows.keys(id)`), absent/blank secrets keep the stored value, blank non-secrets mean "explicitly cleared" (no fallback to default); schema type errors and `validate`-hook rejections are 400 with the reason. Rows registered today: `video-sources`, `summary-prompt`, `harvest-browser`, `alist`. The legacy old-key blocks underlay the user layer **per key** (a row value overrides only the keys it sets). The older per-family `/api/settings/*` pairs for these are thin forwards kept for an observation period — new consumers use `/api/config/:rowId`, and **new settings get a row, not a new endpoint pair**. One family-specific note: AList's `adminPassword`/`mounts` are not row fields (bootstrap-internal credential / mount desired-state respectively).

2. **Unknown keys must return 400; do not silently discard them** (check: `unknownKey` / `unknownKeyMessage` in `src/http/strict-input.ts`):
   - A handler only reads the few keys it recognizes, and it **does not even look at** extra ones. The UI does not hit this (field names are hardcoded in the frontend),
     but if an agent / script / handwritten curl mistypes a name, it gets **200 + a response that looks completely normal** —
     with no signal telling it "the thing you wanted did not happen at all".
   - The error must include two things: **what you wrote** + **what you probably meant** (`closestKey` recognizes alternate underscore/camelCase spellings such as `stream_id` -> `stream`,
     which pure edit distance would miss). Saying only "invalid parameter" is the same as saying nothing.
   - List legal keys in a named constant (`ITEMS_QUERY_KEYS` / `STREAM_PATCH_KEYS`), and **add every new field to it** —
     forgetting to add it becomes a loud 400, not a silent no-op, which is the right direction.
   - **Every write endpoint under `src/http/` that reads a body is connected to the gate** (the following is the complete set). Connect new endpoints directly;
     do not add another place that silently discards input:
     - Reads: `GET /api/items`, `GET /api/download-options`
     - Subscriptions / channels: `POST /api/streams`, `PATCH /api/streams/:id`, `POST /api/channels`,
       `PATCH /api/channels/:id`, `PATCH /api/channels/:channelId/streams/:streamId/ad-filter`,
       the same path's `title-filter`
     - Netdisk: `POST /api/netdisk/mappings`, `.../:id/rebind`, `PATCH .../:id/entries/:leftKey`,
       `.../:id/spec/preview`, `.../:id/spec/apply`, `POST /api/netdisk/fs/{mkdir,move,remove,rename}`,
       `POST /api/netdisk/fs/put` (multipart field names pass through the same gate), `PUT /api/netdisk/mounts`,
       `POST /api/netdisk/share/{verify,save,create}`
     - Organize: `POST /api/netdisk/reconcile/{open,undo,undo-run,decisions}`,
       `PUT /api/netdisk/reconcile/config`
     - Provider / callsites: `POST /api/providers`, `PATCH /api/providers/:id`,
       `PUT /api/provider-callsites/:id/binding`
     - Items / harvest surfaces: `PATCH /api/items/:id`, `POST /api/items/renormalize`,
       `POST /api/sources/preview`, `POST /api/facilities/:id/page/evaluations`
     - Collections / playback: `POST /api/collections`, `PATCH /api/collections/:id`,
       `POST /api/collections/:id/items` (**the top level and each array element each pass through the gate once** — the top level has only `items`,
       and mistyped keys are almost always inside elements), `PUT /api/collections/:id/order`,
       `PUT /api/collections/:id/items/:key`, `PUT /api/watch-progress/:key`, `POST /api/downloads`
     - Intents: `POST /api/intents`
     - Packages / plugins: `POST /api/recipes/packages/{preview,install,uninstall}`,
       `PUT /api/plugins/:pluginId/enabled`
     - Action recipes: `POST /api/recipes/action` (after it returns running, use `GET /api/recipes/action/:runId` and similar routes for the result),
       `POST /v1/images/generations` (the OpenAI-shaped outlet for action recipes that generate images; `/v1/*` passes through the same gate)
     - Settings: `POST /api/source-runtime-config/status`, `PUT /api/source-runtime-config`,
       `POST /api/source-runtime-config/provision`,
       `PUT /api/settings/{harvest-browser,summary-prompt,video-sources}`,
       `POST /api/settings/alist/test`, `POST /api/settings/archive/{reconcile-formats,orphans}`
     - Voiceprint: `POST /api/voiceprint/persons`,
       `POST /api/voiceprint/item/:itemId/clusters/:cluster/enroll`
     - Events / extension surface (the two Origin-gated routes also count): `POST /api/events/read`, `POST /api/ext/verify`,
       `POST /api/ext/debug-log`
     - Sharing: `POST /api/sharing/exports`, `POST /api/sharing/imports`,
       `POST /api/sharing/imports/:id/decisions`
     - Boards: `POST /api/data/query`, `POST /api/boards`, `PATCH /api/boards/:id`
       (`id`/`system` **are not** legal PATCH keys: the handler uses the id from the path and preserves the existing system bit,
       while those two keys from the body were previously silently discarded)
     - Conversions: `POST /api/conversions`
     - AI interventions: `POST /api/interventions/proposals/:pid/accept` (legal keys: `ACCEPT_BODY_KEYS`, currently only `stateId`),
       `POST /api/interventions/:id/permissions/:permId` (`PERMISSION_BODY_KEYS`, only `optionId`),
       `POST /api/interventions/:id/messages` (`MESSAGE_BODY_KEYS`, only `text`),
       `POST /api/interventions/explorations` (`EXPLORE_BODY_KEYS`: `facility` / `target` / `goal` / `limits`)
     - Config rows: `PUT /api/config/:rowId` — **the legal keys are not a handwritten list; they are the keys declared by this row's schema**
       (`ConfigRowRegistry.keys(id)`). The list and engine share the same source of truth, so adding a field can never be missed.
   - **Endpoints that do not accept a body do not connect to the gate**: all their input is in **path segments**, and the handler does not read the body at all, so adding a gate is
     only noise. `.../sync`, `.../entries/:leftKey/reset`,
     `POST /api/netdisk/mounts/reconcile`, `POST /api/netdisk/reconcile/{:show,bindings/:id}/{preview,execute}`,
     `/api/{streams,channels}/:id/refresh`, `/api/streams/:id/seen`,
     `.../ad-filter/reclassify`, `/api/{streams,collections}/:id/playlist-export`,
     `/api/video/works/:key/refresh`, `/api/browser-capability/diagnose`,
     `/api/auth/facilities/:facility/focus`, `/api/provider-callsites/:id/restore-default`,
     `/api/credentials/:domain/connect`, `/api/facilities/:id/close`,
     `/api/intents/:id/{recruit,digest,retire}`, `/api/packages/:id/restart`,
     `/api/voiceprint/item/:itemId/clusters`, `/api/voiceprint/appearances/backfill`,
     `/api/interventions/proposals/:pid/reject`,
     `/api/interventions/:id/{continue,cancel,resume}`.
   - Whether the gate goes **before or after** shape validation depends on which sentence is more precise: generally it goes before ("you wrote `sources`; write `members`"
     is more useful than "members must be an array"), but it goes after when a field already has a more precise dedicated error
     (`id` in `PATCH /api/channels/:id` is blocked by "id cannot be changed").

3. **Resource-Oriented Pathing**:
   - Design API endpoints around nouns representing resources (e.g., `/api/channels`, `/api/streams`) rather than actions (e.g. `/api/get-channels`).

4. **Runtime Source Configuration**:
   - Runtime values belong to the Source named by `{ pluginId, sourceId }`; Provider rows never carry credentials, endpoints, or facility configuration.
   - `POST /api/source-runtime-config/status` returns non-secret values and secret status only, plus `envFallback: string[]` — the field names the host's deployment env fallback covers for this ref (names only, never values; always present, `[]` when none). The config sheet's required-field gate accepts these as satisfied: the member resolves them at run time from the same table (`src/kernel/plugins/runtime-config.ts`). `PUT /api/source-runtime-config` accepts only manifest-declared fields. Both are forwards into the config-row engine's **source family** (`/api/config/source:<ref>` is the same row — manifest fields are translated to the row's schema, so the layering/secret semantics are the engine's single implementation; the per-instance namespace guard applies on both doors).
   - Secret values are write-only and must not appear in Source detail, diagnostics, member params, cache keys, or stored items.
   - **After `POST /api/source-runtime-config/provision` (self-service key application) finishes, it must go back and check whether that cell is filled** — the check is rereading `secrets[<field>].configured`, not whether the recipe avoided throwing. This kind of recipe is `allowEmpty` and produces no items, so "created successfully" and "one extraction did not match" look identical in the runner receipt; reporting success for the latter sends the user elsewhere with an empty key cell. **Run + check has exactly one implementation**: `provisionConfigSlot` in `src/credentials/provision-slot.ts`; this endpoint and the MCP `provision_capability_key` use the same function (writing the two sides separately would drift silently: one side checks while the other reports false success). If the check fails, return `502` and point to `<dataDir>/failures/`.

## Access Control: Who Can Reach `/api/*`, `/v1/*`, and `/ws`

The backend binds to `0.0.0.0` (accessing Stream from a phone / LAN is an intentionally preserved capability), so it is simultaneously a neighbor of **every machine on the LAN**
and **every webpage in your own browser**. The check is implemented in `src/http/access-guard.ts`; there are two gates, in a fixed order
(`/v1/*` — the OpenAI-shaped image-generation outlet — lives outside `/api` only to fit Base URL habits; the gate is the same one):

**First gate · browser dimension** (`Host` + `Origin`) — this blocks "malicious webpages on the local machine" and DNS rebinding.
When a page fetches `127.0.0.1:8900`, the source address is loopback, indistinguishable from our own frontend;
only Origin can identify it.

- Missing `Origin` -> trusted (curl, MCP, local native processes, or same-origin GET).
- `Origin` is same-origin with `Host` -> trusted (our own frontend).
- `chrome-extension://<fixed ID>` -> trusted (**only our extension is recognized**, not other extensions; webpages cannot forge Origin).
- `Host` must be an IP literal or `localhost`; **domain names must all be registered in `trusted_hosts` in `config.yaml`**.
  This protects against DNS rebinding: an attacker resolves their own domain name to `127.0.0.1`; at that point Host and Origin are both their
  domain name, and "same-origin" still holds, so the only remaining way to identify it is "this name is not registered by us".
- Failing this -> **403**.

**Second gate · source dimension** (peer address + token):

- loopback (`127.0.0.0/8`, `::1`) -> allowed, with **no credential required**. A token cannot stop someone who can connect from the local machine.
  Measured: Windows Chrome hitting the backend inside WSL (mirrored networking) appears as `127.0.0.1`, and the main path is unaffected throughout.
- Everything else must present a token: `Authorization: Bearer <token>` or `?token=` (the latter **exists only for browsers** —
  WebSocket cannot set request headers by itself, and the first phone visit also needs a clickable link; the frontend stores it immediately after receiving it and erases it from the address bar).
- If the peer address cannot be obtained -> treat it as external (fail closed). "Cannot read the source address" must never become "then treat it as local".
- Failing this -> **401**, and the frontend shows one input prompt accordingly (`AccessTokenPrompt`).

**Where the token comes from**: `api_token` in `config.yaml` (explicit configuration wins); otherwise it is automatically generated on first startup into `data/api-token`
(0600, same tier as `data/ext-relay-token`). **There must be a lock by default**, not none by default.
The retrieval point is `GET /api/access-token`, and it **only answers local callers** (non-loopback gets 403 directly, even if the caller already has a token) —
so other devices cannot let themselves in by "opening the settings page once". It also returns `urls` (each local network interface's `http://<ip>:<port>/?token=...`),
because a phone needs a clickable link, not a manually copied 64-bit hex string.

**The exempt routes** (registered **before** the gate, with their reasons documented in place): `/api/health`, `/api/ext/verify`,
`/api/ext/relay-status`, `/api/ext/claimed-tabs`, `/api/ext/debug-log`, `/api/browser-capability[/diagnose]`.
Their common property is "this is exactly what you need when you cannot connect / do not have a credential yet". The `/api/ext/*` routes have separate Origin gating.

## The Reverse Gate: How the Extension Recognizes the Backend

The gate above controls "who can reach us". In the other direction there is another question: **why should the extension trust that the other end of `127.0.0.1:8900` is us?**
It matters even more than the first gate — the ext-relay channel's capability is equivalent to "execute arbitrary JS on any of the user's tabs", which means the user's full login state.

The check is not "this address looks right"; it is **both sides know `data/ext-relay-token`**:

- **How the extension obtains the token**: it launches `stream-desktop` through Chrome native messaging (host id `com.stream.desktop`), and that process reads the file
  (`0600`, readable only by the same user). The manifest is written in the operating-system-designated location, and `allowed_origins` pins our extension id,
  so an impersonator must first be able to modify the user's registry/config directory to forge this path — and at that point it is simpler to read `data/cookies.json`
  directly. **The threshold is raised from "grab a port" to "modify your machine"** (the same fix shape as Claude Code's IDE integration for
  CVE-2025-52882: the out-of-band channel goes through the filesystem).
- **How the backend proves itself**: `POST /api/ext/verify`, body `{nonce}`, returns
  `{proof: HMAC-SHA256(token, "stream-browser-verify:" + nonce)}` (the prefix is `VERIFY_PREFIX`,
  and the source of truth is `shared/browser-relay/wire.ts`). **It returns the proof, not the token.**
  The extension generates a new nonce every time, so recorded responses cannot be replayed.

**Do not add an endpoint that sends the secret directly (`POST /api/ext/token` and similar shapes)** — `app.ts` in place and
`src/http/app.ext-verify.test.ts` each have a watchdog for this. The direction is wrong: if the extension asks the peer for a credential, whoever grabs
this port gets the full capability.

**Two red lines on the extension side** (`extension/src/lib/`):
1. **Never fall back**. If the native host cannot obtain the token, stay in place and retry; do not fall back to asking the backend for it — with a fallback,
   an impersonator only needs to make the native path fail (it does not have to do anything; not being registered is already failure) to get the old behavior back.
2. **Verify before giving**. The WS handshake puts the token into `Sec-WebSocket-Protocol` — **the act of connecting already
   hands over the secret**, so `verifyBackend` must run before the handshake. (The login state itself does not go over HTTP: the backend sends `op:'cookiePull'` over
   the already authenticated relay to fetch it; see `docs/PACKAGE.md` §5.2.)

**When adding endpoints, note**: the gate is `app.use('/api/*', ...)`, and Hono middleware **only applies to routes registered afterward**.
The `/api/mcp` and `/_p` gateways mounted later in `serve.ts` are both behind the gate (`/api/mcp` can open arbitrary URLs and
execute arbitrary JS in the user's login state, so it must never be looser than other endpoints). To add a new exemption, register it before the gate and document why in place.

## Domain Concepts & Glossary

To resolve naming confusion (e.g., Channel vs Stream vs Source), follow this model hierarchy:

1. **Channel (presentation grouping layer)**
   - **Definition**: a logical group the user creates in the frontend (for example, “音乐/播客” ("music/podcasts"), “Timeline”).
   - **Relationship**: a Channel contains a `stream_ids` list; it is not responsible for data fetching itself and only aggregates at the presentation layer.
   - **Consumption mode**: the `present` field is an id from the official Present registry (`timeline|search|audio|video|research|tasks|embed`), determining how this
     Channel fetches data, renders it, and mounts capabilities (`GET /api/presents` lists the registry); `kind` is its read-only compatibility
     alias. `options.slots` can optionally reroute a Provider Callsite **only inside this Channel** to another
     Provider row (see the next section, "Provider callsite bindings").
   - **Note**: `targetType` in the resolve model (`/api/resolve/*`) means "resolve target type" and is unrelated to Channel.

2. **Stream (subscription Stream - harvest pipeline layer)**
   - **Definition**: a concrete data harvest pipeline / subscription instance (for example: “网易云歌单 60168357” ("NetEase Cloud Music playlist 60168357")).
   - **Relationship**: returned in the API as the `streams` array under a Channel.

3. **Source (data-source entrypoint)**
   - **Definition**: a concrete callable entrypoint declared by the manifest. It belongs to exactly one Plugin and is bound only as a member of a Stream / Provider, not subscribed to directly.
   - **Relationship**: a Stream aggregates >=1 Source; with `strategy: exclusive`, it takes only the first healthy response by priority (this is the disaster-recovery mechanism).

4. **Provider (global stateless capability)**
   - **Definition**: refers only to stateless capabilities invoked on demand (search, audio download, and so on) — inputs are supplied at call time, and member Sources are selected internally with mutually exclusive priority. See the next section's standard.
   - **Note**: an "adapter engine" (rsshub/bilibili adapter) is not a Provider — it is a **Plugin** adapter; do not call it a Provider.

> For authoritative definitions, invariants, and data flow, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Stateless Service Provider Standards & CRUD API (Stateless Capability Provider Standards and CRUD API)

> This section is the interface and data-model standard for the **Provider** concept in [ARCHITECTURE.md](ARCHITECTURE.md).

### 1. Provider Data Model (Data Model)
In the system, each Provider corresponds to one full config row in the config store:
* `id`: unique identifier.
* `label`: human-readable name.
* `description`: description information.
* `category`: capability category; valid values are `search | resolve | download | transform | transcribe | llm`.
* `serves`: array of matching keys; supports the `'*'` wildcard as a fallback.
* `strategy`: scheduling strategy; valid values are `sequential | concurrent`.
* `members`: array of member capability definitions; can contain elements of the following types:
  - `{ fn: string }`
  - `{ source: string, name?: string }` — `name` is an optional instance name. The same `source` can appear multiple times in one row
    (each with different `params`), and the address key, sorting, `options.exclude`, and call ledger all use `name ?? source`
    (LLM multi-instance uses this mechanism; see the next section). If `name` collides with any registered source id -> write fails with `422
    name_shadows_source` (its own `source` does not count as a collision).
  - `{ mode: 'auto', provides: string[] }`
* `contract`: interface contract declaration.
* `options.exclude`: exclusion strategy or node list.

### 2. CRUD API Endpoints (Endpoints)
* **GET `/api/providers` (List)**
  - Returns the list of all configured Providers, `{ items: Provider[] }`.
  - `items` includes placeholder / planned declaration entries with `status: 'planned'`, plus each row's resolved `resolvedMembers`, counted `calls`, and `callSites` callsites.
  - `defaultSource` (optional) = this row's **default Source**, the full Source projection (the same `publicSource` as `resolvedMembers[].source`, with `pluginId` so the client can fetch detail directly). Used for "Add member": if present, open this Source's config surface directly; if absent, ask the user to choose from the source catalog. Declared in `PROVIDER_DEFAULT_SOURCE` in `src/providers/seed.ts` (`llm` -> `llm-openai`, `parse` -> `ocr-vlm`); the field is absent when that Source is not installed locally.
* **GET `/api/providers?variant=transform&key=example.com` (Match Preview)**
  - Previews the Provider match result for the specified `variant` and matching `key`.
* **GET `/api/providers/:id` (Detail)**
  - Gets the detailed configuration and status of a single Provider.
* **POST `/api/providers` (Create)**
  - Creates a new Provider row. Success returns `201 Created`; already exists returns `409 Conflict`; validation failure returns `400 Bad Request`.
* **PATCH `/api/providers/:id` (Update)**
  - Partially updates the Provider row configuration for the specified ID.
* **DELETE `/api/providers/:id` (Delete)**
  - Deletes the Provider with the specified ID. Success returns `{ ok: true }`.

### 3. Dispatch Scheduling Model (Dispatch Model)
* **One-sentence callsite summary**: `callsite = variant + key extraction + invoke`; dispatch matches through `serves` declarations.

## Conversions (convert to text / add speakers / extract frame text / summaries)

**One conversion = derive a new artifact from one item.** The five `kind`s are `extract` (convert to text),
`identify` (add speakers), `frames` (extract frame text), `summary` (summary), and `audio-fp` (acoustic fingerprint).
They share one table, one lifecycle, and one set of timing. After `extract` settles, it automatically grows upward according to the rule table (`src/conversions/derive.ts`): if it has a timeline
(= it went through the transcription branch), dispatch `identify`; if it is also video, dispatch `frames`. **A collapse in an upper layer does not take the base away** — that is the entire reason they are independent conversions instead of internal steps inside extract.
The `audio-fp` tier outputs an **acoustic fingerprint (chromaprint) used by folding to judge "the same recording"**, not body text for humans to read:
it does not enter the branch table for `extract`, has no frontend trigger entry, and its only trigger is the background worker for inbox folding
(`src/story-fold/`). Its `available` is determined by engine probing at startup (ffmpeg's chromaprint muxer →
`fpcalc`; if neither exists, the entire tier is turned off). See the design in
`2026-08-23-audio-fingerprint-fold-design.md`.
The `summary` tier **has no frontend trigger today** — summaries on the interaction path are returned directly by the chat in the same turn and are not written as
conversions; this kind still accepts direct API/MCP calls (the only production trigger point is the one-off migration
`src/conversions/migrate.ts`), and is kept because backend capability and MCP consumers still exist.
Inside `extract`, branching is split by `content.archetype` into three branches (`stt` transcription / `ocr` images and PDFs / `article`
webpage body) plus an `inline` direct-fetch tier — **branch selection belongs to the backend** (`shared/extract/plan.ts`; the frontend uses
the same code for button visibility). Callers only declare "I want the body text for this content"; they do not need to first decide whether it is an image, video, or webpage.
See `internal design record` (kind convergence) and
`internal design record` (resourceization).

* **GET `/api/conversion-kinds`** — capability discovery: `{ items: [{ kind, label, stages, available, options, branches? }] }`.
  `available` = whether the backend for this kind is configured right now. **The frontend decides button visibility from this; do not probe with "POST once and see whether it is
  503".** Only `extract` has `branches`: whether each of `{ stt, ocr, article }` is configured —
  it is the caps input for frontend `planExtract` (`inline` does not hit the backend, so it is not listed).
* **POST `/api/conversions`** — body `{ kind, item, media?, snapshot?, options?, input?, force? }`.
  `item` is a source handle (an inbox item id, or a netdisk-bound episode without an item such as `tmdb:<id>[:SxxExx]`).
  `input` is only for derived kinds, and points to **the upstream conversion** (the input to summary is the transcription result, not the original media).
  - An existing non-error record for this `(item, kind)` and no `force` → **`200`** + the existing resource (cache hit; never bill twice)
  - Newly created → **`201`** + `Location: /api/conversions/:id`
  - kind not registered (backend not configured) → `503 unavailable`; unknown kind / missing item → `400 validation_error`;
    handle not found → `404`. All three are judged **before creating the record**, leaving no half garbage record.
* **GET `/api/conversions`** — `?item=` `?kind=` `?status=` `?limit=` (default 50, max 200) `?cursor=`
  `?expand=result`. Returns `{ items, nextCursor? }`.
  - **By default, does not include `result`**: `segments` for a two-hour podcast episode are thousands of objects; list pages only need status and title.
  - The cursor anchors on **id** (monotonic by creation order), not `updated_at` — if an old row is touched, it would jump into a page the caller has already read and cause missed items.
* **GET `/api/conversions/:id`** — single record (with `result`); unknown returns `404`.
* **DELETE `/api/conversions/:id`** — cancel and delete (abort if running, dequeue if queued, delete directly if historical). The semantics are
  "destroy this intent and its artifact", so there is no separate cancel endpoint. Unknown returns `404`.

**Response envelope** (same shape for every kind; `result` is discriminated by kind):

```jsonc
{ "id": "cv_…", "kind": "extract", "item": "tmdb:123:S01E02", "status": "done",
  "queuePos": 3,                         // queued only
  "snapshot": { "title": "…", "source": "…", "url": "…", "poster": "…" },
  "createdAt": "…", "startedAt": "…", "finishedAt": "…", "updatedAt": "…",
  "timing": { "totalMs": 184200,
              "stages": [{ "name": "stt:media", "ms": 12400 },
                         { "name": "stt:asr", "ms": 96800 },
                         { "name": "stt:diarize", "ms": 75000 }] },
  "ladder": { "via": "zhipu",              // only kinds that use the ladder have this; old records do not
              "rungs": [{ "member": "zhipu", "source": "ocr-vlm", "ms": 4701, "outcome": "win" },
                        { "member": "ocr-mineru", "source": "ocr-mineru", "ms": 3,
                          "outcome": "miss", "reason": "MinerU 插件未开" }] },
  "error": { "code": "…", "message": "…" },  // error only; same shape as the global error body
  "result": { "text": "…", "format": "plain", "branch": "stt",
              "detail": { "lang": "zh", "segments": [], "media": [] } } }
```

- **The `result` contract for `extract`**: `text` (body) + `format` (`markdown | plain`) + `branch`
  (which branch this body came from) are the shared part — they are the only fields everyone can produce; branch-specific products go into `detail`
  (`segments`/`lang`/`media` are only available from transcription; voiceprint naming, player sync, and "only watch a certain person" all rely on
  `detail.segments`). **Do not cut them, and do not lift them up a layer**: lifting them to the top level would create permanently empty fields out of thin air for OCR results.
  `identify` → `{ segments, probe }`; `summary` → `{summary}`. `probe` is the diarization probe reading
  (`{ speakerCount, spokenSeconds, clusters: [{label, seconds}] }`) — **no code consumes it today**.
  It is kept for humans and the later "convert to text recursively" plan (`internal design record`
  §8 needs it to set thresholds), and `GET /api/conversions/:id` is its only other end. `spokenSeconds` is the ledger after summing the total and
  rounding only once; `clusters[].seconds` are display approximations where each cluster item is rounded separately — the two are intentionally not equal, so do not expect
  `sum(clusters.seconds) === spokenSeconds`.
- **The `result` contract for `frames`**: `{ track, probe }`. `track` is the frame text track
  (`[{ at, text }]`, where `at` is seconds), and keeps only **the part that transcription cannot capture** (slide points, code, chart numbers) —
  it **does not mix into the body**: transcription is "who said what"; frame text is "what is written on the screen". If OCR for one frame collapses, the track keeps
  one `[未识别：<原因>]` ("unrecognized: <reason>") entry instead of silently skipping it (missing information is exactly what this layer exists to eliminate).

  **`track: []` does not mean "did not run".** This layer is a stepwise stop-loss ladder, and **every level that judges "do not sample" is
  `status: "done"` + empty `track`** — judging it as `error` would make the notification center report an error and make the user think something broke, when it is precisely
  working normally. Which level stopped it, and what each level paid, only appears in `probe`:

  | `probe.stop` | Meaning | What was paid |
  |---|---|---|
  | `gate` | Gate judges pure talking-head content (high speech-density rate, no demonstratives); all information is in the mouth | Zero |
  | `no_source` | Cannot obtain a video address to sample (no video media / netdisk not matched / Douyin container not awake) | Zero bytes |
  | `still_picture` | The maximum pairwise hash distance among sparse 8 frames is below the threshold → fixed camera, image does not move | 8 range requests |
  | `no_new_text` | Pick 2–3 probe frames for OCR and extract not a single character absent from the transcription | + 3 OCR calls |
  | `done` | Full scan → per-frame OCR → per-frame incremental judgment, completed normally | One full pass over the whole video |

  There are only three real failures, written to `error.code` with `status: "error"`: `source_failed` (the netdisk/Douyin container/Bilibili signature blew up while fetching the video address), `sample_failed` / `plan_failed` (ffmpeg/ffprobe itself blew up).
  **They are never written as `no_source` / `no_new_text`** — otherwise a real address-fetch/sample failure would look identical in the ledger to
  "this item simply has nothing that can be sampled" or "probed and found no material".

  The other `probe` readings: `gate` (gate wording and evidence), `sampled` (how many frames were sparsely sampled), `maxDistance`
  (the reading for "did the image move" itself), `ocrTried` / `ocrFailed` / `ocrEmpty` (how many OCR calls were sent out, how many of them threw,
  and how many succeeded but had no text in the image — **the latter two point to opposite investigation directions; do not merge them**), `planned` (candidate frame count after full-scan dedupe),
  `truncated` (how many frames were cut off by the upper limit; `> 0` must be visible, no silent truncation), `framesKept`
  (final number of frames where new text was extracted). **The boundary between "did not run" and "ran but had no material" is `ocrTried`.**
  No code consumes this ledger today; `GET /api/conversions/:id` (or `?kind=frames&expand=result`) is
  its only other end — thresholds (frame count limit, number of probe OCR frames, stillness threshold) have not been measured yet, and they can only be measured from this ledger,
  so not documenting it is the same as burying it.
- **`timing` is an envelope field, not a private product of one kind**: stage names are declared by kind (`extract` carries branch prefixes:
  `ocr:fetch|ocr:ocr`, `stt:media|stt:asr|stt:diarize`, `article:fetch`; `identify`: media|diarize,
  `frames`: source|sample|probe-ocr|plan|ocr, `summary`: summarize). Timing is captured at stage boundaries in the shared runner, so every kind gets it for free.
  **Stages that did not happen do not appear in the array**, instead of `ms: 0` — "did not run" and "ran for 0ms" must be distinguishable.
  Failed conversions also carry timing (slow failures are exactly the kind to investigate).
- **`ladder` is also an envelope field** (same as `timing`, also included in lists): who on the Provider ladder did this run use.
  `via` = the **addressing key** of the winner. Both `rungs[].member` and `source` are provided — the key is often the instance name chosen by the user
  (`zhipu`), and looking at it alone cannot tell which source sits behind it; looking at source alone cannot distinguish two instances of the same source.
  Consumers **must keep the three `outcome` states separate**: `win` (this result came from it) / `miss` (it abstained because it was not configured or not applicable) /
  `error` (it tried and failed) — the next step after miss is configuration, while the next step after error is troubleshooting; the directions are opposite.
  Merging them into "did not succeed" bakes the most time-consuming kind of misdiagnosis into the API. Failed conversions also carry `ladder`, and that is exactly
  when it matters most. **Only `extract`/`summary` kinds carry this field**; `identify` connects directly to the voiceprint backend and has no
  ladder. `frames` recognizes text frame by frame through the same `parse` row as the `ocr` branch of `extract`, but one conversion may run OCR dozens of times
  with different paths each time; a single `via` cannot say who did it — its readings are in `result.probe` as
  `ocrTried`/`ocrFailed`/`ocrEmpty`. **Old records do not have this field**; consumers therefore display nothing — adding an empty path would be equivalent to claiming "nobody on the ladder ran".

> **This family is the only entry point for conversions**. The frontend, MCP, and voiceprint routing all go through it — there is **no** `/api/parses`,
> `/api/transcripts`, or `POST /api/transcripts/:itemId/summary` endpoint, so do not connect to them.
> There is also **no pseudo-state like `{status:'none'}`** — "not converted yet" is an empty list.

**MCP side**: trigger with `extract(item)` — one tool, without splitting transcription/OCR/webpage (the model, like the user, only cares about
"give me the body text"; how to get it is judged by the backend). Reads all go through `get_conversions(item?, kind?, limit?, expand?)`
— without `item` it is a lightweight index; with `item` it returns the body text for that item.

## Subscribe to a Stream (`POST /api/streams`)

A Stream references sources and may fan-out. The stream persists in `data/stream.db`:

```jsonc
{
  "id": "my-movies",                  // the stream's identity; 409 if it already exists
  "label": "豆瓣观影",                 // display name
  "strategy": "fanout",               // fanout | exclusive — no default, always send it
  "members": [                        // each member is { plugin, source, params }
    { "plugin": "rsshub", "source": "movie-douban-playing", "params": {} },
    { "plugin": "rsshub", "source": "movie-douban-weekly",  "params": {} }  // fan-out; cross-source dupes collapse
  ],
  "cadence_seconds": 1800,
  "options": {}                       // required, may be empty — see below
}
```

Every key above is **required** (`options` may be `{}`, but the field itself must be present).
Two optional ones: `channel_id` (bind the new stream to a channel in the same request — do it here,
not in a follow-up PATCH; a stream no channel references is not loaded after a restart) and
`contract`. Anything else is **rejected with 400** listing the accepted names — a misspelled field
is never silently dropped.

- **`plugin` + `source`** — `plugin` is the owning package's id (`packages/<id>/package.json`
  `stream.id`), `source` is an entry id from that package's `manifests.yaml`. The pair is joined
  into `<plugin>:<source>` and looked up in the registry, which falls back to the bare `source`
  name, so `source` is what actually has to be right. A source collected by recipe in your own
  logged-in Chrome belongs to the `replay` plugin
  (e.g. `{ "plugin": "replay", "source": "lizhi-user", "params": { "id": "…" } }`).
- **`options`** — the free-JSON home of a stream's side fields: `vault_subdir` (defaults to the
  stream `id`), `mode`, `ad_filter`, `harvest`. No schema, no migrations.
- **`"strategy": "exclusive"`** — for a feed reachable through several backends: `members` become
  an ordered ladder and only the first **healthy** one is harvested (a per-source health ledger
  marks dead/degraded backends; a `browser`/`browser-page` member can be the last rung).
  `pnpm doctor` shows each source's health; see `docs/PACKAGE.md` §9.

Over MCP the equivalent is **`subscribe_source`** (give it a source id and params; it derives the
id/vault_subdir and upserts, so re-subscribing the same source+params lands on the same stream).
`stream_subscribe` is the low-level variant for hand-authoring a whole stream; it takes its own
shape (`{id, description, sources:[{source_id, params}], cadence_seconds, vault_subdir}`) and
assigns no channel.

## Manual Refresh (Refresh)

Harvest normally runs by scheduler according to cadence; these two endpoints are manual entries for "harvest once right now", and run a **real persisted tick**
(unlike preview — preview never writes to the database).

* **POST `/api/streams/:id/refresh`** — single Stream. `{ fetched, written }`; unknown Stream returns `404`.
* **POST `/api/channels/:id/refresh`** — **all member Streams** of this Channel, run in fan-out. Unknown Channel returns `404`;
  no connected channelStore returns `503`. Returns a per-Stream ledger + totals:

```jsonc
{ "streams": [ { "streamId": "s1", "fetched": 12, "written": 3 },
               { "streamId": "s2", "error": "facility 未登录" } ],   // the failed one only has error
  "fetched": 12, "written": 3, "failed": 1 }
```

- **Partial failure is still `200`**. A facility losing login state or a source timing out is normal on this path; judging the whole request as failed
  would make the other successful harvests disappear from the UI too. Failures are recorded one by one in `streams[].error`, and `failed` gives the total,
  so callers decide how to present it (the frontend says "harvested N items, added M items (K of T sources failed)").
- **Concurrency is capped** (`src/channels/refresh.ts`, default 3). Harvest is heavy work, and some Streams also ride the single real browser —
  firing seven or eight Streams in one Channel at the same time can punch through memory and the browser. `streams` is returned in **member order**, not completion order.
- Why fan-out is on the server instead of making the frontend send N requests: the concurrency cap, partial-failure semantics, and result summary are one thing;
  putting them on the frontend means every caller writes its own copy, and the first version will certainly be an unbounded `Promise.all`.

## Projection Cells in the Outbound Item Shape

The four read exits for items (`GET /api/items`, `GET /api/channels/:id/items`, `GET /api/search?scope=content`, and WS `item`
broadcasts) all go through one exit, `toClientItem` (`src/http/client-item.ts`), where it **computes on demand** and attaches four cells (not written to the database, effective immediately for existing data):

| Cell | Shape | Who decides |
|---|---|---|
| `author_enrich` | `{ source, params }` — the frontend uses it to call `/api/enrich?source=<source>&<params…>`, returning `{ name?, face?, url? }` | The package's `stream.item.authorEnrich`; only emitted when the item has no `author_avatar` and has `author` |
| `actions` | `[{ id, icon, label, recipe, params, toggle }]` — a click goes to `POST /api/recipes/action`, `sourceId = recipe`, parameters = `params` + `action: toggle[before press ? 1 : 0]` | The package's `stream.item.actions`; the row whose parameter placeholders cannot be resolved is not emitted |
| `source_label` | The title of that source in the source directory (with the site name in front) | Source directory |
| `source_site` | `{ name, domain }` | The `stream.homepage` of the package that claims this source |

The source directory exit `publicSource` (`src/registry/public.ts`) likewise has one more cell, `site: { name, domain }`, with the same rule as `source_site`.
The contract is in the `item` row of `docs/PACKAGE.md` §0.5.

## Items Maintenance

* **POST `/api/items/renormalize`** — body `{ streamId? } | { sourceId? } | {}` (mutually exclusive; none = whole database). Takes existing items' `raw` and reruns normalize with the **current** manifest, only overwriting `content` (leaving id/seq/muted and others unchanged). `400` when both keys appear, body is not valid JSON, body is not an object, or `streamId`/`sourceId` is not a string; `404` when the scope is not found; `200` `{ scanned, updated, skipped: { noSourceId, manifestGone, parseError } }`. Idempotent: rows whose recomputed result is identical to existing content are not written.

## Netdisk plugin access

`GET /api/netdisk/openlist-access` → `{ url, token }`: the gateway path (`<origin>/_p/alist`) for this Stream OpenList
and permanent token. Used by `@streamapp/netdisk` installed in the user's DSH for the external tier. The alist package is absent or
token not minted → 404 `unavailable`. Goes through the same gate as `/api/*`.

## Netdisk: Upload Files and Create Directory Shares (for External Export Scripts)

The consumer is an export script on this machine (each week it uploads the data package into a fixed directory on Quark netdisk, and on first release creates a share link for the directory); it only calls
these two endpoints and does not touch any login state. Both are behind the AList gate (netdisk not installed/configured → 503).

* **POST `/api/netdisk/fs/put`** — `multipart/form-data`: `path` (OpenList absolute file path, such as
  `/quark/闲鱼数据包/<pack>/<file>`) + `file` (bytes). → `200 { ok: true, size }`. Same-name overwrite; if the parent directory does not exist,
  create it first (level by level). The file is received into a temporary file while streaming and then streamed as PUT to OpenList; the field order does not matter.
  `400`: not multipart / missing path or file / path is not an absolute file path / unrecognized field (same gate as JSON endpoints);
  `502 upstream_error`: OpenList rejected it (storage does not exist, cookie expired..., `message` is verbatim).
* **POST `/api/netdisk/share/create`** — body `{ path, passcode?, expireDays? }`: `path` is an OpenList directory path
  (the first segment is the mount point; driver is recognized by the mount table, currently only Quark); `passcode` is 4 alphanumeric characters, default = public share;
  `expireDays` only accepts 0/1/7/30 (the four options in the Quark web UI), default 0 = permanent. → `200 { url, passcode?, pwdId }`.
  `400` parameters; `404 not_found` this directory does not exist on Quark netdisk (not created on behalf of the caller — the share target is the already-uploaded package);
  `501 unsupported` mount point is not Quark; `503 unavailable` no Quark login state or not installed/configured; `502 upstream_error`
  Quark rejected it (`message` says which step stopped). **Replacing files in the directory does not affect an existing share link** (live verification 2026-09-07:
  after overwriting an uploaded file with the same name, the same link was still alive and listed the new content) — therefore "weekly updates with an unchanged link" holds.
* **GET `/api/netdisk/share/list`** — shares created by the current account, one page. query `page` (1-based, default 1),
  `size` (1..100, default 50); both must be integers (`page=1x` is `400` and is not treated as page 1).
  → `200 { items, page, size, total }`; if `page * size < total`, there is another page — **reading only the first page silently misses
  all later links**. Each row:

  | Field | Description |
  |---|---|
  | `shareId` | Deletion is addressed by this (`share/delete` only accepts this) |
  | `pwdId` / `url` | The link tail and the full link. When all you have is a URL, use `pwdId` here to match which row it is |
  | `title` / `pathInfo?` | Title, and location of the content on disk (Quark's `path_info`, possibly a relative form like `../父目录`) |
  | `passcode?` | Extraction code; public shares do not have one |
  | `expireDays?` | 0 permanent / 1 / 7 / 30. If Quark returns an unknown tier → leave blank (do not guess a number of days) |
  | `createdAt` / `expiredAt?` | ISO time. **Permanent shares do not carry `expiredAt`** — the 2100-01-01 Quark gives is a placeholder |
  | `state` | `active` / `expired` (the deadline you set was reached) / `invalid` (Quark took it down). Report the two kinds of "dead" separately |
  | `fileNum` / `size` | File count, total bytes |
  | `auditStatus` | Quark's audit state is **passed through verbatim**, not translated (live verification has only seen 4 and 2; the criterion is unclear) |

  `503 unavailable` no Quark login state or not installed/configured; `502 upstream_error` Quark rejected it (**do not return an empty list** — an empty list
  is equivalent to telling the user "you have no shares").
* **POST `/api/netdisk/share/delete`** — body `{ shareIds: string[] }` (1..100 entries, from `shareId` in `share/list`).
  → `200 { results: [{ shareId, ok, message? }], deleted, failed }`. **Send and judge responses one by one**:
  if one fails, the rest are still deleted, so it remains `200` when `failed > 0` — the check is in the body, not in the status code. Only failures that make the whole batch impossible are non-200:
  `400` parameters, `503 unavailable` no Quark login state or not installed/configured.

  **This deletes the link, not the files**: after a share is deleted, the directory remains on disk (Quark files are addressed by `fid`; this endpoint only accepts `share_id`).
  **Irreversible; Quark has no share recycle bin** — after deletion, that link immediately returns `41012「好友已取消了分享」` ("the friend canceled the share") (live verification 2026-09-07:
  verified by creating a one-time share and deleting it myself). To restore it, you can only create a new link, and the link address changes.

  Why not use Quark's native batch operation (the endpoint does accept a `share_ids` array): in the same live test, mixing one nonexistent id into the array
  made the whole request return `500 / code 15000`, and it could not say which entry failed. The cost of sending one by one is N entries = N upstream requests.

## Packages (what is installed on this machine)

There is only one unit for extending Stream: **Stream packages** (see [PACKAGE.md](PACKAGE.md) for the slot contract). This section is its
**directory read model**.

* **GET `/api/packages`** — **all** packages from the builtin layer (the repository's own `packages/`) + the user layer (`<dataDir>/recipes/`, installed by npm).
  `200 { packages: PackageSummary[] }`; backend without `packageInventory` wired → `503`
  (**not an empty array** — an empty array tells the user "you have nothing installed").

  | Field | Description |
  |---|---|
  | `id` | canonical package identity (`stream.id ?? stream.facility`) |
  | `name` | display name, falling back to `id` by default (the frontend should not receive an empty title) |
  | `description?` | `stream.tagline ?? stream.description` |
  | `layer` | `builtin` \| `user` |
  | `pkgName?` / `version?` | npm package name and version (uninstall identifies the package by `pkgName`, not by directory name) |
  | `slots.sources?` | Source list item count |
  | `slots.recipes?` | number of `*.recipe.json` files |
  | `slots.recipeNames?` | the names of those files (file names with `.recipe.json` removed, already sorted). A count alone cannot say "what was installed" |
  | `slots.code?` / `slots.backend?` | `true` (has `stream.code` / `stream.backend`) |
  | `slots.credentials?` | declared cookie domains (present only when non-empty) |
  | `hosted` | `slots.backend \|\| slots.credentials?.length` — see below |
  | `role?` | the role the package plays in the host, currently only `'netdisk-base'` (the host's netdisk base; the check is `NETDISK_BASE_PACKAGE_ID` in `src/netdisk/base-package.ts`). The frontend uses it to decide whether to show the "网盘挂载 + 绑定" ("netdisk mount + bind") configuration panel — **the frontend does not branch by package id**. Packages without a role do not carry this cell |
  | `enabled?` | current value of the enable switch, **present only for packages that fill plugin slots** (pure recipe packages have no switch to flip; giving them an always-true field makes the frontend draw a switch that cannot move) |
  | `runtime?` | `{ state: 'running'\|'idle'\|'error'\|'unknown', image, lastUsed? }`, **present only for packages with containers** |
  | `pending?` | the pending row for a package that has been installed / changed version but **has not taken effect yet** (`PendingChange`, see `/api/packages/pending` below), matched to the row by `pkgName`; only the user layer can have this |

  **Unfilled slots do not appear in the object.** `recipes: 0` and "no recipe slot" mean the same thing, but the former makes the frontend draw an empty
  `recipe×0` marker.

  `hosted` means **"whether this package can break at runtime"** (has a container / needs login state). The only implementation of the check is the named function
  `isHostedPackage` (`src/packages/inventory.ts`), and the numbers are pinned by `inventory.real.test.ts`.
  **It is not `fillsPluginSlot`**: that one asks "whether the host needs to do something for this package", and also includes `rsshub` / `builtin` / `browser` / `replay` that only provide a Source list /
  normalizer — those four do not break. The two checks answer two different
  questions; do not merge them.

  `runtime.state` is a **pure-function projection** of `pluginStatus` (the cached aggregation also used by `/api/plugins`),
  **it does not start a new health probe**: services managed by standby can read the snapshot (they self-heal the next time they are used). Adding another health probe means adding another source of truth that can disagree with
  `/api/plugins`.

  **"Has a new version" is not here**: checking updates requires hitting the npm registry (network, can time out), and putting it here lets registry jitter
  drag down first screen load. Call `GET /api/recipes/packages/updates` and match rows by `pkgName`.

  **The error reason is not here either.** `runtime.state === 'error'` only says "cannot start", without a reason — `PluginStatus`
  has no error text field at all, and forcing one would require starting another health probe (the previous point). The reason is in the logs endpoint below.

* **GET `/api/packages/pending`** — pending-effective list: **the user layer loaded at startup** (frozen snapshot) vs
  **what is currently on disk** (rescanned on every request, no ledger recorded — the ledger can drift, and both facts can be recomputed at any time).
  `200 { pending: PendingChange[] }`, each item `{ name, kind: 'installed'|'updated'|'removed', from?, to?,
  needsRestart, why }`. The check looks only at slots: recipe data takes effect hot (`needsRestart:false`), code / capability / container
  go through the startup path and require restart when changed; credential domains are not counted separately (they are the allowlist used by code / containers, and those three cells have already been checked). Install /
  change / uninstall use the same ruler. `removed` packages no longer have a row in `/api/packages`; only this endpoint can show them.
  Backend without `packagePending` wired → `503`. The same count also goes into `/api/health.pending_restart`
  (the number of rows where `needsRestart` is true; if not wired, this cell is absent; that mouth swallows exceptions, so if the list explodes only this cell disappears).

* **POST `/api/restart`** — restart the entire backend process (**not hot reload**: gracefully shut down, then start again; code packages / capability packages /
  containers / credential-domain declarations all rerun through the normal startup path). This is the last step in the "installed → effective" loop and is used with `GET /api/packages/pending`.
  Graceful shutdown reuses `shutdownThen` from `serve.ts` (stop task center → standby → kernel effects in reverse order → release lock),
  and the tail behavior is tiered by "who launched me" (`classifyLauncher` in `src/restart/policy.ts`):

  | `mode` | Check | Tail behavior |
  |---|---|---|
  | `supervised` | env `INVOCATION_ID` (injected by systemd) or `STREAM_SUPERVISED=1` (passed by the `stream mcp` shell and other supervisors) | exit with `RESTART_EXIT_CODE` (75), the supervisor brings it up again (`stream mcp` recognizes only this exit code; other exit codes are not restarted — that is a crash, not a controlled restart) |
  | `reexec` | neither is present = user running in the foreground | `spawn` the same process itself (same execArgv, same arguments), `unref`, then exit |
  | `watch` | can only be specified explicitly (`scripts/dev.sh` sets it this way) | **do not shut down itself**: touch `restart-sentinel` at the repository root, and `tsx watch` uses that to SIGTERM + relaunch. The watcher does not inspect exit codes; if it exits by itself, the watcher just waits for the next file change |

  **Explicit `STREAM_RESTART_MODE=supervised|reexec|watch` overrides auto-detection** (unrecognized values are treated as unset). Why this exists:
  `INVOCATION_ID` is **inherited** by scopes / terminals launched from systemd user services — running `stream` in the foreground in such a terminal, or
  running `pnpm dev` inside `systemd-run --user --scope`, is misdetected as `supervised`; after exit 75, no one brings it back up. In those terminals,
  foreground runs need `export STREAM_RESTART_MODE=reexec`; dev.sh already exports `watch` itself.
  The gate only checks whether the task center has **currently running** tasks (`state='running'` in `sidequest_jobs`): yes → `409
  { error: { code: 'conflict', message }, running: [{ id, label }] }`, and it does nothing; only `?force=1` bypasses it —
  real scheduled tasks with real stakes may be running on 8900, and package updates are not a reason to interrupt them.
  No `deps.restart` wired → `503`; request received during the startup window (HTTP is listening, graceful shutdown is not installed yet) → `500` (the process does not crash;
  retry after a few seconds).
  After passing the gate, the response is `202 { mode: 'supervised' | 'reexec' | 'watch' }`, **return 202 before shutting down**: starting shutdown synchronously also takes down the HTTP
  server, so the response never gets sent. Callers use changes to `/api/health.started_at` to determine "it is alive again" —
  the same check as "which code is live" in CONTRIBUTING.md, without starting another one.

* **GET `/api/packages/:id/logs?tail=N`** — the last N output lines from this package's container (stdout+stderr merged, with
  RFC3339 timestamps, docker's 8-byte frame header already stripped). `tail` is clamped to `[1,1000]`, default **200**; unparsable
  numbers **fall back to 200 rather than 0** (`tail=0` on docker means "no lines", which makes the panel empty and look like
  "this container has no logs"). `200 { lines: string[], truncated }` (`truncated` = the line count hit tail, so there is more above).
  `404` this package has no container / the container has never been created; `503` docker is unreachable or `containerOps` is not wired.
  **The two failures must be treated separately**: the former means "go create it"; the latter means "this is not this package's problem".

* **POST `/api/packages/:id/restart`** — restart this package's container. It reuses `provisionBackend` (start / rebuild by image /
  wait for health), **it does not write another container lifecycle**. If the container is running, stop it first and then run provision — otherwise provision
  sees running and returns no-op, so "restart" does nothing while the API returns success.
  `200 { state: 'running' | 'error', error? }`. **A container that cannot start is 200 + `state:'error'`, not 5xx**:
  the request itself succeeded (we really tried), the failing thing is that container; expressing it as 5xx makes callers unable to tell "could not reach backend"
  from "container did not come up", and those are two completely different remedies.
  `404` this package has no container slot; `409` the container does not exist **and** `manage_containers` is off (the message gives the
  `docker compose up -d` escape route); `503` docker is unreachable / the backend cannot reach the container network.
  **`manage_containers` being off does not block restarting an existing container**: that switch controls "whether to create it for you"; using it to block
  restart locks a crash-looping container, while restart is the user's only self-service action.

  **Relationship to the other two projections** (the three only intersect on `id`; per item 1 in this document, this is not a redundant endpoint but three different resource questions):
  `GET /api/plugins` is **the plugin directory + Sources it carries** (filtered by `fillsPluginSlot`; pure recipe packages are absent);
  `GET /api/recipes/packages` is **the npm management surface** (scans only the user layer; install/uninstall/check updates rely on it); this endpoint is
  **"what is installed"**, without a Source list or install/uninstall operations. See
  `internal design record` for the design.

## AI Intervention: Intervening in Runs and Reviewing Proposals (Interventions)

When a recipe cannot recognize the current interface, the backend starts an **intervention run** itself, asks the model configured by the user once, and if the answer passes the distinctiveness gate it writes a **pending proposal**;
**proposals do not take effect automatically; only after a person accepts one is it written into the state graph** (spec `internal design record` §4 / §6 / §9).
This set of endpoints is the "a person looks, a person clicks" surface; the ops page "源健康" ("source health") and Channel configuration consume it. Storage is in `<dataDir>/interventions.db` (one database per domain,
separate from `agent-runs.db` — that table's stop reason is a single string enum, whose meaning is opposite to the two cells here).

- `GET /api/interventions?source=&status=a,b&limit=` → `{ runs: RunRecord[], pending }`. `pending` is the **global** pending-review proposal count,
  not affected by `source` / `status` filters (a badge should not show 0 just because a filter is open).
- `GET /api/interventions/:id` → `{ run, proposals }`; `GET /api/interventions/:id/events?since=<seq>` → `{ events }`,
  `seq` is monotonic and append-only; the frontend polls by `since`.
- `POST /api/interventions/proposals/:pid/accept` body `{ stateId? }` → `{ proposal, learned?, applied }`.
  `state` proposals write into the **learned layer** state graph (`<dataDir>/state-graphs/<facility>.json`); `stateId` must have the shape `<facility>/<state>`
  (400 `bad-state-id`), and colliding with a package-authored `states.json` id returns 409 `clashes-with-authored`; `discriminator` proposals append distinguishing features to
  a state in the learned layer, body must include `stateId` (400 `need-state-id`), and pointing to a package-authored state returns 409 `cannot-edit-authored`;
  `transition` / `locator` only change state, `applied:false` says that honestly; `recipe` proposals write the candidate body back to the package directory (see below); `graph` proposals merge the whole exploration draft into the learned layer (see below).
  Accepting / rejecting a non-pending proposal returns 409 `not-pending`.
- `POST /api/interventions/proposals/:pid/reject` → `{ proposal }`, and also marks the answer cache behind it as `rejected-by-user`;
  the next cache hit with the same fingerprint is treated as "no output" and does not create another proposal.
- **agent tier (repair sessions)**: a Source enters isolation and settings include `ai-agent` (`PUT /api/config/ai-agent` body `{ command, maxTurns?, maxTokens?, maxWallMinutes? }`)
  → the backend starts a `kind:'repair'` run, driving the user's own code agent through ACP. In the event stream, `tool_call` / `tool_result` / `tool_failed`
  are paired by `callId`; `permission_requested` (with `data.auto:false`, `permissionId`, and `options`) waits for a human answer.
  - `POST /api/interventions/:id/permissions/:permId` body `{ optionId }` → `{ ok }`; inactive run 404, wrong `permId` 409 `no-such-permission`.
  - `POST /api/interventions/:id/continue` → `{ ok }`; valid only for `paused`, otherwise 409 `not-paused`. Each bumps one tier: +6 turns / +1,000,000 tokens / +20 minutes.
  - `POST /api/interventions/:id/cancel` → `{ ok }`; `session/cancel`, and the run finishes as `cancelled`.
  - `POST /api/interventions/:id/messages` body `{ text }` → `{ ok }`; enters the queue, then becomes the next prompt after the current turn ends.
  - `POST /api/interventions/:id/resume` → `{ ok }`; after backend restart, a `paused` run with `agentSession` resumes through `session/load`; live runs return 409 `busy`.
  - agent tier not attached (the intervention domain lacks `repairs`) → these five endpoints return 503 `agent-unavailable`.
- `POST /api/interventions/proposals/:pid/accept` for `kind:'recipe'`: after candidate validation, atomically write back to `recipePath` itself (builtin package = repository `packages/<id>/`, third-party = `<dataDir>/recipes/<pkg>/`),
  returning `{ proposal, applied: true, path }`; write failure returns 409 `write-failed` and the proposal remains `pending`. Writing back does not touch the isolation ledger: `shouldRun` reads the higher version and lets it pass.
- **exploration graph building (spec `2026-09-12-ai-intervention-phase3-explore-design.md` §8)**: lets the agent click through openings one by one in a browser tab and discover the state graph for this facility.
  - `POST /api/interventions/explorations` body `{ facility, target, goal, limits?: { maxStates?, maxDepth? } }` → `201 { runId }`.
    `target` only accepts `chrome:<tabId>` (obtain it with `cdp_pages`); any other form returns 400 `bad-target` — `facility:<name>` is the page currently ridden by harvest, and exploration clicking it would steal it.
    Missing `facility` / `target` / `goal` returns 400 `need-fields`; wrong key names return 400 `unknown-key`; unknown facility returns 400 `unknown-facility`;
    an existing exploration already running for the same facility returns 409 `explore-busy` (**one exploration per facility**, no queue); no `ai-agent` configured / agent tier not wired returns 503 `agent-unavailable`.
    `limits` accepts only `maxStates` / `maxDepth` (other child keys return 400 `unknown-key`), and both must be **positive integers**, otherwise 400 `bad-limits` —
    `0` makes exploration take zero steps but report success; decimals / negative numbers turn into thresholds that are never beaten. Neither reports an error; they just discover nothing. The default is `DEFAULT_EXPLORE_LIMITS`.
    **Exploration is attached to the facility**, and the surfaced row is recorded on this package's first Source.
  - `POST /api/interventions/proposals/:pid/accept` for `kind:'graph'`: merge the whole draft into the learned layer, returning `{ proposal, applied: true, states, transitions }`.
    Edges with `effect:'noop'` are not written (nothing changed after the click, so it is not a route); `effect` / `via` are exploration-time scaffolding and are stripped before writing, leaving only `{ from, to?, steps }` in the graph.
    **Collision = write none of it**: if any state id in the draft collides with the composed graph (package-authored ∪ learned), or its prefix is not `<facility>/`, or a transition points to a state outside the graph → 409 `learned-rejected`, and not a single row is written
    (the learned layer has no delete API; writing half and rolling back is another write that can fail, so all validation finishes before writing begins). Proposal without a draft → 409 `no-draft`.
  - The progress of that exploration is in the `exploration` cell of the source-health view (see below).
- Error bodies are always `{ error: { code, message } }`; missing items return 404 `not-found`.
- **source health (spec `2026-09-12-ai-intervention-ui-design.md` §7)**: three ledgers (health / quarantine / repair run) compose into **one status word**, computed by the backend and translated by the frontend.
  - `GET /api/source-health` → `{ sources: SourceHealthView[] }`, **contains only `status !== 'ok'`**; `GET /api/source-health/:sourceId` → `SourceHealthView` (any Source, including healthy ones; unknown returns 404 `unknown-source`). `sourceId` may have multiple segments (for example `@streamapp/xhs/xhs-home`): the route consumes to the end of the line, and both the raw form (`/api/source-health/@streamapp/xhs/xhs-home`) and the fully `encodeURIComponent`-encoded form match.
    `status ∈ awaiting | exploring | repairing | proposed | unrepairable | quarantined | auth | dead | degraded | ok`, and the check takes the first match in order (spec §5).
    `exploring` = a `kind:'explore'` run is running on this Source; its **waiting for human** tier (`paused` / `awaiting_confirmation`) still falls under `awaiting`; both paths are the same button.
    Includes `affectedChannels` (via `affectedSources` → stream members → reverse lookup to Channels), `run` (active runs first; when both are active, `repair` beats `explore`; `pending` is the unanswered permission with the smallest seq; `now` is the latest tool_call/message).
    `proposal` = **the row waiting for human review**, `kind ∈ recipe | graph` (pending first, otherwise the latest row); the frontend branches the ④ cell by `kind`:
    `recipe` reads `diff` (step-level, `step:0` = top-level field), `graph` reads `graph: { states, transitions }`, and its four `validation` cells are all `'n/a'` with an empty `diff` array —
    those four cells ask "whether this candidate recipe passed validation"; a graph never walked that path, and filling in `'ok'` would testify for something that did not happen. When such a pending proposal exists, the status word is `proposed` (regardless of Source health).
    `exploration?: { runId, status, states, transitions, remaining }` — **only present while exploration is live**; numbers are read on demand from that run's draft file. After exploration ends, this cell is absent (the draft is the live scene of "currently exploring").
  - `POST /api/interventions/repairs` body `{ sourceId, reason? }` → `201 { runId, failed? }`; existing active session returns 409 `repair-busy` (with `runId`);
    no `ai-agent` configured / agent tier not wired returns 503 `agent-unavailable`; unknown returns 404 `unknown-source`. **Does not require the Source to be in quarantine**; default `reason` = quarantine ledger lastReason → health ledger lastError → `manual`.
  - Shape source of truth: `src/intervention/source-health-view.ts`; frontend mirror: `app/src/lib/api.source-health.ts`.
- **shape source of truth**: `src/intervention/types.ts` (`RunRecord` / `RunEvent` / `Proposal`), and frontend `app/src/lib/api.interventions.ts`
  is its mirror, with field names aligned byte for byte.

## Facility and Its Live Page (Facility & its live page)

**Facility** = one site's **exclusive login session** (for example `xhs`). A facility can have at most one real browser tab at the same time,
and recipes run serially while riding it (see ARCHITECTURE.md for the invariant). This tab is a first-class resource, so it is addressed as a resource —
although our main reason for reading it is to debug harvest, "debug" is a **use**, not a **noun**.

* **GET `/api/facilities/:id/page`** — state of that facility's current tab `{ facility, url, title }`; no tab → `404`.
* **GET `/api/facilities/:id/page/screenshot`** — `image/jpeg`, a quick look at what it currently looks like.
* **POST `/api/facilities/:id/page/evaluations`** — body `{ expression }`, evaluate in **that tab**, returning `{ value }` (`201`).
  Use POST rather than GET: each call **creates** one evaluation, and the result is not addressable or cacheable. Evaluation first runs `JSON.stringify`
  inside the page before crossing the boundary (SPA reactive stores are Proxy objects, and returning by value directly yields `{}`).

All three queue behind that facility's task tail chain and **do not interleave with a running recipe**.
Reason for existence: opening another browser to look would tear the single login session, so **the only correct observation point is this tab itself**.

> TODO (redundant endpoint): existing `GET /api/auth/facilities` (auth-wall projection), per item 1 in this document, should eventually merge into
> `GET /api/facilities`, with one row per facility and both `auth` and `session` state blocks.

## Video Playback: Resolution and Byte Proxy (`/api/media/*`)

The host does not know any video platform. The three routes dispatch by `platform` to the `video.resolve` callsite (key `<platform>-video`);
what `vid` looks like and how to turn it into a playable stream are entirely owned by the package that claims that platform (`package.json#stream.providers[]` with
`callsites: ['video.resolve']`; see PACKAGE.md §0.5). Adding a platform = installing a package, with zero route changes.

* **GET `/api/media/play?platform=&vid=[&dl=1&name=]`** — requests `progressive`, proxies bytes with the headers required upstream (`<video>` can seek); `dl=1` turns it into a download (file name `name`, default `vid`). Missing `platform` / `vid` → `400 validation_error`; empty resolution is handled by the two tiers under "empty resolution" below.
* **GET `/api/media/dash?platform=&vid=`** — same as above, but requests `dash` and returns MPD (`application/dash+xml`); each stream's BaseURL points to `/api/media/seg`. Platforms whose resolver honestly returns empty for `dash` (short-video sites with only a whole-file stream and no split tracks) get 502, and the player falls back to progressive itself.
* When play / dash **resolve empty**, there are two tiers; the check is the miss carried out by the member pipeline (`unresolvedResponse` in `src/http/app.ts`):
  - **The content itself is unavailable** — some member threw `ContentUnavailableError` (work deleted / private / the site explicitly says it does not exist; miss carries `unavailable`) → `404 { error: 'unavailable', detail }`, where `detail` is **the site's original wording**. This is not a failure on our side; user retries and repairs are useless, so do not return 502. The member pipeline also does not record this in the Source health ledger (header note in `src/providers/unavailable.ts`).
  - **Everything else** — `502 { error: 'unresolved', detail? }`. `detail` = the reason of the first miss (member decline is `declined (no result)`, container / upstream explosion is its original wording, such as the container single-video API's `HTTP 403`); when there is no miss at all (no row serves this platform), `detail` is omitted.
* Shared exits for play / dash: no Provider configured → `503`; Channel slot filled but all broken → `422 slot_broken` (see §5.1).
* **GET `/api/media/seg?u=&b=…&m=video|audio`** — segment proxy. The host must be one that some resolver just registered (SSRF gate, `isAllowedSegHost`), and request headers also come from that registration — the route itself does not know any site's Referer / Cookie. If primary node `u` fails, try backup nodes `b` in order (repeatable): switch on TTFB timeout or 5xx, and give the final node a wider window + one retry.
* All three accept `channelId` (see "Presents & channel-level Provider slots"). Each resolution records which row ran and who declined into DebugBox `video-resolve` — check it first when diagnosing playback failure.

## Processors Handed Over by Packages: Enrichment and One-Click Subscription

* **GET `/api/enrich?source=<name>&…`** — first check `enrichers` handed over by packages (returned by `activate()`, declared in `stream.code.enrichers`; PACKAGE.md §3.2): if `source` matches, pass the **entire query bag** through to it and return the result as JSON unchanged; package throws `ValidationError` → `400 validation_error`, other exceptions → `502 upstream_error`. Only if nothing matches does it fall back to the host's own branches (`link` / `hackernews` / `v2ex` / `xueqiu`, `HOST_ENRICH_SOURCES`). Name collisions are rejected at load time, so packages cannot override host branches. **Package enrichers also have a second surface**: the `enrich.open` command on `/ws` (next section), used when the frontend opens an item with `content.enrich`; the HTTP surface is for MCP / scripts, and both surfaces call the same function.
  Video comments use this exact mouth, with names contracted as `<facility>-comments` (PACKAGE.md §3.2): for example
  `GET /api/enrich?source=douyin-comments&vid=<aweme_id>` → `{ comments, total, cursor? }`; pagination sends the returned
  `cursor` as `cursor` (or `page`) again; the final page omits `cursor` (or gives `null`). **The host itself has no comments branch for any video platform** —
  which platform has comments is determined by which enricher its package declares.
* **POST `/api/credentials/:domain/connect`** — one-click cold-start subscription. **The domain is claimed by the package**: the package declares a key in `stream.code.connect` (= domain name, which must be in its `credentials`) and `activate()` hands over a handler with the same name (PACKAGE.md §3.2). The route looks it up (case-insensitive): on hit, it calls once, the host `subscribe(stream)`, and returns `{ ok: true, id, ...extra }` (`ValidationError` → 400, others → 502); if no package claims this domain → `404 not_found`. The host itself does not know any domain.

### WS Fetch-On-Demand Protocol: `enrich.open` → `enrich.*` (`/ws`)

The realtime channel used when the frontend "opens an item" (`src/http/enrich-ws.ts`). **It only serves enrichers handed over by packages**: the host's own branches
(today only `link`) are fine over HTTP and do not occupy any browser lane; fetch-on-demand declared by a package with `prefetch: true` also goes through HTTP (plain off-site HTTP, prefetches as the frontend scrolls). Where to fetch on demand is said by the item itself — the package's normalizer
writes `{ source, params }` into `content.enrich` (PACKAGE.md §3.2), and the frontend copies it into the command unchanged; the host does not know any site.

* **Command** (frontend → backend): `{ type: 'enrich.open', correlationId, source, params }`. `params` are all strings
  (≤ 32 keys, each value ≤ 2048 characters), `correlationId` / `source` ≤ 128 characters; malformed shape drops the whole line with no response.
* **Events** (backend → frontend, each carrying the command's `correlationId`):
  - `enrich.started` — accepted (started itself, or attached to an identical one already in flight).
  - `enrich.article { article }` — the body / media half arrived (sent only when the enricher result has `article`).
  - `enrich.comments { comments, total }` — comments arrived (sent only when the result has `comments`; `total` defaults to the item count).
  - `enrich.completed` — this attempt finished; sent even when neither `article` nor `comments` exists, and the frontend uses it to dismiss loading state.
  - `enrich.failed { error }` — no such enricher (package not loaded / name typo, **do not silently return empty**: an empty answer would be read by the frontend as
    "this item has no body"), `ValidationError`, and other exceptions; `error` is truncated to 500 characters.
  - `enrich.blocked { reason }` — enricher threw `RecipeBlockedError` (checked by `error.name`: rate-limit queue timeout,
    login wall, etc.); the frontend presents it as "the site does not allow entry right now" rather than "broken".
* **Only one request per `source` is in flight at a time; a new click supersedes the old one**: a new `enrich.open` with different params
  `abort()`s the old call's `signal` (propagated all the way into recipe execution, actually freeing the lane), and the superseded call **sends no frame at all**
  — nobody wants its answer, and a `failed` would only create a fake fault.
* **Same `source` and same `params` ride along**: compare `params` without regard to key order; if equal, add only another waiter,
  and each receives the same result with their own `correlationId` — no cancellation, no rerun (rerunning would waste a site access already started and would
  also make the shared request cache fail for everyone waiting on it). Different `source`s each have their own lane and do not interfere.
* Side-effecting actions (like / favorite / send message) **do not use this protocol**: they are action recipes and use `POST /api/recipes/action`
  (next section), because secondary confirmation and `userInitiated` belong to that path.

## Script Entry Point for Action Recipes

* **POST `/api/recipes/action`** — body `{ sourceId, params?, confirmed? }` (strict-body,
  extra keys are rejected immediately). Runs one **action** recipe: sending messages, listing items, placing orders, and other side-effecting work.

Four facts are not visible from the signature but determine how to use it:

1. **It is the same closure as MCP's `run_action_recipe`** (`runActionRecipe`; deps are passed through from `serve.ts` unchanged).
   Credential injection, rate limits, facility cooldown, and secondary confirmation all share the same implementation — **not two parallel implementations**; changing one side
   changes both sides.
2. **`confirmed` has the same name and meaning as on the MCP side**: there is only one two-step confirmation. Calling without it makes high-risk actions return
   `needs-confirmation`; resend with `confirmed: true` to actually run.
3. **Results are returned unchanged, not folded into HTTP status codes.** `done` / `needs-confirmation` / `blocked` are all 200 bodies,
   and the caller decides. In particular, **`blocked` does not mean "did not complete"** — it can also mean "already took effect, but no receipt was read",
   so **callers must not treat it as a signal that retry is safe** (see that entry in `project planning record`).
4. **It exists because of large parameters**: action params may contain large base64 blobs (Xianyu product images are data URLs); sending them through MCP means passing through
   a conversation, where one copied-wrong character becomes an `atob` failure. Direct script POST removes that leg.
5. **The `confirmed: true` attempt waits at most 25s; if it is not finished, it returns `{status:'running', runId}`** (the action continues executing on the machine;
   results that return directly also carry `runId`). After receiving running, **GET `/api/recipes/action/:runId`**
   for the result: `{runId, domain:'action', status, sourceId, elapsedSec, result?, error?, note}` — the run's
   `status` only says whether execution finished; `result.status` is the action's success/failure (the body POST would have returned);
   `status:'error'` = crashed mid-run or backend restarted, and **the action may already have partially completed**; check the target app before deciding whether to rerun.
   A runId outside the action tier → 404. If the same sourceId + same params is **in flight**, another POST returns the same runId
   and does not start a second round; after it finishes, another POST really performs the action again. Design:
   `internal design record`.
6. **Interactive buttons in the first-party UI also use this endpoint; there are no dedicated endpoints.** Like / favorite on cards / details simply
   `POST { sourceId: '<package>/<action-source>', params, confirmed: true }` — the button click itself is the secondary confirmation, so it includes
   `confirmed`; if it returns `running`, poll according to item 5 (frontend once every 800ms, 30s cap), and roll back optimistic UI for non-`done`.
   Example: `xhs-like` in `packages/xhs/` (`{ noteId, action }`).

### OpenAI-Shaped Image Generation Exit (`/v1/images/*`)

* **POST `/v1/images/generations`** — body `{ model, prompt, n?=1, size?, response_format?='b64_json' }`
  → `{ created, data: [{ b64_json, revised_prompt }] }`. **GET `/v1/models`** lists the values that can be filled into `model`.
  **POST `/v1/images/edits`** — image-to-image, multipart: `image` (file; multiple allowed, ≤4 images, each ≤8MB) + the same text fields above;
  reference images are converted to data URLs and passed into the page through the recipe's `images` param. `mask` is not supported (the site has no inpainting).
  The path is the standard OpenAI protocol shape: clients that only speak the OpenAI dialect (such as the infinite canvas) set Base URL to
  **the Source itself** `http://127.0.0.1:8900` (same as setting `https://api.openai.com`; the client appends `/v1/…` itself), Key arbitrary.
  `/v1/*` and `/api/*` pass through the same gate (Origin + token; see "Access control").

It is **an adapter in the host**: it turns the product of an "action recipe that can output images" into a shape the client understands. The host does not name any package —
`model` is the sourceId; who can act as a model is declared by the recipe itself in `meta.produces: "images"` (items must carry `url`,
and the fallback watermarked image is marked `watermarked:'true'`). How many images are emitted per round is read from its `output.targetCount` (`n` above it returns 400);
how many images actually appear in a round is decided by the site (`perRun` is only an upper bound): requests that do not get their share in this round automatically start another round (max 4 rounds). Connecting a new image-generation site = adding a recipe; the host does not change. **This is not an LLM entry point** (the `/v1/chat/completions` route has been removed; see the next section).

Today's only model is `doubao-image` (`packages/doubao/`): one request = run the Doubao web app's "图像生成" ("image generation") in the user's own Chrome
(about 25–35s; text-only image generation usually yields 4 images, with reference images 1 image — the count is read from `imageList` in page data, not guessed) → dig each image's `image_ori_raw` out of page data (**the original image without watermark**, signed URL downloadable from the public internet)
→ download each one → return b64. Only when the original image cannot be dug out and the fallback watermarked preview image is used does the `dewatermark` container remove the watermark — it is an optional package
(`stream add @streamapp/dewatermark`, source in stream-packages); not installed and this round happens to need it → **503**, with the message spelling out how to install it.
Concurrent requests with the same model + same prompt are combined into one round and share the results (canvas "张数 4" ("count 4") sends 4 requests with n=1). `confirmed:true` is supplied by the route
(programmatic consumer, same as CLI `--yes`); when `size` is not 1:1, it reduces the ratio and appends it to the prompt (`, aspect ratio 3:2`, echoed in `revised_prompt`);
if dewatermarking (used only on the fallback path) fails, the whole request returns 502 (503 when the package is not installed), and **does not return a watermarked image**. Error body is OpenAI's `{ error: { message, type } }`.
Design: `internal design record`.

The same package also has a read-only `doubao-chat-images` action (not on `/v1/*`, uses `POST /api/recipes/action`): given a Doubao conversation URL, read back the images already generated in it (each image's watermark-free original URL; `index` 0 = newest image, `message` = nth image-generation message from the end; optional `last` means only the latest few messages). It is used for the step "the user manually tuned the image in Doubao and wants to bring it local" — it sends no messages and consumes no quota. It can only read the part of history currently rendered by the page; if not enough, it scrolls upward and stops at the end.

There is also `doubao-drafts-clear` (also through `POST /api/recipes/action`, `effects: write`): deletes every item in the Doubao left-sidebar "草稿" ("drafts") list (irreversible), returning the title of each deleted draft. Each failed image-generation recipe run (risk-control popup, no image, timeout) leaves a draft containing the reference image and prompt; when too many accumulate, use it once to clear them; no params.

## LLM and Agent (LLM & Agent)

LLM calls are a **Provider capability** configured once and usable everywhere; above it is the **Agent** conversation service (tools = Stream's own capabilities). The complete endpoint set is in the Postman collection (Settings / Agent groups in `docs/postman/stream.postman_collection.json`).

### LLM Settings (the connection is a member of the `llm` row)

**There is no `LlmSettings` panel and no dedicated editor endpoint** (do not look for `/api/source-runtime-config/editor`). An LLM connection is a **member of the `llm` Provider row**, configured through the general Provider CRUD surface (see "Provider data model" above):

* **Add/change a connection** = `POST`/`PATCH /api/providers/:id` a `{ source: 'llm-openai', name: <instance name>, params: { baseUrl, model } }` member into the `llm` row (`name` defaults to `source`, and is this instance's addressing key; sorting/exclusion/keyState all use it).
* **The instance's key** goes through `PUT /api/source-runtime-config`, with `ref: 'llm:<instance name>'` added to the body (`llm-openai` manifest declares `perInstance: true`, and its `runtime_config.ref` namespace only accepts `^llm:[\w-]+$`; invalid or missing `ref` → `400`). Passing `ref` to an ordinary non-`perInstance` Source is also `400` (that Source's config is shared and does not accept caller-specified landing points). `POST /api/source-runtime-config/status` reads status with the same `ref` rules; `resolvedMembers[].keyState` (`'stored' | 'env' | 'missing' | null`) in `GET /api/providers` reads its layer with the same ref, and the key itself is never returned.
* **The `llm` Provider row**: `variant: 'llm'`, one or more `llm-openai` instances as members (builtin Source, **only one shape**: `baseUrl`/`model` are on the member's own `params`, and the key is taken from TokenProvider through `params.tokenName` — that is, the instance ref above. There is no second configuration source: the `llm` block in `settings.json` only leaves the summary prompt). The three callsites summary (`llm.summarize`), chat (`llm.chat`), and netdisk season ownership (`netdisk.spec.suggest`) all read this row as the single source of truth; callsite bindings may optionally use `params: { model }` to override which model that call uses (it wins over the member's own default).
* **Summary prompt**: `GET`/`PUT /api/settings/summary-prompt`. `GET` returns `{ prompt, configured }` (`configured` = whether the llm ladder has a member with a complete endpoint, not the old task-binding check — it is live state, so it is not in the config row's GET); `PUT` body `{ prompt: string }`, persisted and hot-effective. The write path is a thin forwarder to the `summary-prompt` config row (same semantics as the general surface `PUT /api/config/summary-prompt`).

### LLM Has No HTTP Surface

**Stream does not provide any external LLM endpoint, not even one.** Models have only two unrelated destinations:

* **The backend's own callsites** (summary, netdisk suggestions/adjudication, search agent conversation joints, extract compression leg, …) use the **in-process** `ctx.llm.forTask` ladder — the `llm` Provider row above is its configuration surface, and it does not pass through HTTP at all. Usage ledger is written to the `llm_usage` table in cache.db (only the backend writes it; there is no HTTP endpoint to read it).
* **The model in the chat** belongs to the user's own host (Claude Code / Codex / DSH), and Stream is completely uninvolved — it provides no endpoint and writes no profile. The host calls the provider configured by the user directly; the request does not pass through Stream. See the "Conversation" section in `docs/ARCHITECTURE.md`.

**Do not add an LLM forwarding endpoint to Stream again.** Adding a forwarding layer only buys "one more place to maintain OpenAI dialect compatibility", and its only selling point — metering — cannot be measured on streaming paths (SSE returns frames, and usage is unavailable). If you need a ledger, use the gateway's own.

# Provider callsite bindings

- `GET /api/provider-callsites` lists code-declared callsites, current bindings, and compatible Provider candidates.
- `PUT /api/provider-callsites/:id/binding` accepts `{ providerIds: string[], params?: object }`; fixed callsites require exactly one compatible Provider, while dispatch callsites preserve the supplied route order. `params` is the callsite-level override the capability reads (today: `model` on the `llm.*` / `netdisk.spec.suggest` callsites; a non-object is `400`).
  - **Whole-body replace, never a merge — omitting `params` clears it.** A client that only means to change `providerIds` MUST send the existing `params` back verbatim, or the override is silently dropped (`restore-default` relies on that same clearing semantics).
  - The response also carries `offeredDefaults` — bookkeeping, not user data: the default rows boot has already offered this binding. Boot only merges a default that is **not** in that list, so a row the user deleted stays deleted instead of coming back on every restart. It is the one field a write preserves rather than replaces, so clients never need to echo it.
- `POST /api/provider-callsites/:id/restore-default` restores that callsite's builtin default binding, and returns the restored binding. **When the callsite has no default rows** (its defaults come from a package that is not installed, e.g. `music.track.*`) it **clears** the binding and returns `null` — an empty binding would still count as "bound", so boot would skip that slot forever once the package arrives.
- `DELETE /api/providers/:id` returns `409` with `error.details` — `callsites` (still referenced by a global binding), `providers` (referenced as a `{provider}` composition member), and `channels` (`[{ channelId, callsiteId }]`, referenced by a Channel's `options.slots`) — non-empty means the delete is rejected.

## Spaces (the layer above Channels: sidebar grouping)

**Do not call it a "group"** — in Stream, "group" already has an owner: a Channel itself is "a group of streams", and
`groupedIds` / ungrouped in the code means "whether this stream has been incorporated by some Channel". A Space is the layer above Channels.

- `GET /api/spaces` — `SpaceRecord[]`, sorted by `position` ascending, with `id` as the fallback for equal values (without that fallback segment,
  two Spaces with the same ordinal can swap positions across different queries, making the list look like it is jittering on its own).
- `POST /api/spaces` `{ label, position?, id? }` → `201` + record. No `position` = placed last.
  Blank `label` string returns `400`.
- `PATCH /api/spaces/:id` `{ label?, position? }` → record. **The default Space can also be renamed and moved** —
  it only cannot be deleted.
- `DELETE /api/spaces/:id` → `{ ok: true }`. Member Channels are **moved back to the default Space**, not deleted along with it (deleting a Space is not
  deleting content; the two steps are in the same transaction, otherwise a mid-way failure leaves a batch of Channels that do not appear under any Space).
  Default Space returns `400`: after deleting it, ownerless Channels have nowhere to land.

`ChannelRecord` / `ChannelView` therefore adds one `space_id`:

- `POST` / `PATCH /api/channels` accept `space_id`. Omitted = lands in the default Space (`default-space`).
  A reference to a nonexistent Space is always `400`, and **is blocked before writing** — once written, that Channel disappears entirely from the sidebar,
  and the user only thinks "it was not created".
- Solo Channels generated from ownerless streams have no channels row, so there is nowhere to store ownership; `space_id` is always the default
  Space. To move it away, first turn it into a real Channel.
- **Spaces do not travel with share packages** (`SharedChannel` = `ChannelRecord` without `space_id`): Spaces are the organization method for the local sidebar;
  that row does not exist on the other machine. The importer always lands them in its own default Space.

## Presents & channel-level Provider slots (2026-07-24)

- `GET /api/presents` — the official Present registry, `{ items: PresentDescriptor[] }` with
  `PresentDescriptor { id, label, needsStreams, slots: [{ callsiteId, label, variant, mode }] }`.
  `id` is one of `timeline | search | audio | video | research | tasks | embed`; `slots` is derived by grouping
  `provider-callsites` entries per Present — it is not an independent declaration.
- `GET /api/channels` items return `present` (Present registry id) and `options` (including
  `options.slots`; Channels with no configured options do not carry this field); `kind` remains a deprecated read alias
  of `present` for the pre-migration frontend.
- `PATCH /api/channels/:id` returns the **persisted `ChannelView`** — byte-for-byte the same
  projection `GET /api/channels` serves for that id (expanded `streams` tree included), not the
  raw stored record. The frontend can therefore "overwrite the local row with the response body" without manually merging its own possibly stale
  snapshot after the write (see `internal design record`).
  `POST /api/channels` still returns the raw record (`stream_ids`, not `streams`) — the creation path only uses its `id`.
- `POST` / `PATCH /api/channels` accept `present`; the legacy field name `variant` is still
  accepted as a write alias, and the historical value `'mixed'` is mapped to `'timeline'` on
  write (matches the boot-time channel-table migration). Body validation: `present` (or its
  `variant` alias) must be one of `timeline|search|audio|video|research|embed`, else `400 validation_error`
  (`tasks` is the system channel's own present and is not creatable through the API).
  `options.url` (the `embed` Present's page address), if present, must be an absolute http(s)
  URL — anything else (`javascript:`, a relative path, a non-string) is `400 validation_error`
  with `options.url` named in the message; reachability is not checked.
  `options.slots`, if present, is validated key by key: the `callsiteId` must be a known
  Provider Callsite and its `providerIds` must pass the exact same rule a global binding write
  does (`ProviderBindings.validateSelection` — fixed needs exactly one compatible Provider,
  dispatch needs ≥1, ids unique, each Provider's `variant` must match the callsite's) — any
  violation is `400 validation_error` and the whole PATCH/POST is rejected (no partial write).
- **`channelId` query parameter** — carried by the HTTP endpoints that resolve through a
  Provider Callsite from inside a Channel's context, to let that Channel's `options.slots`
  override the global binding: `GET /api/search` (`scope=content|price|music|video|resources`),
  `GET /api/media/play`, `GET /api/media/dash`,
  `GET /api/download-options`, `GET /api/enrich`, `GET /api/media/tracks/resolve`. Omit it (or point
  it at a Channel with no slot filled for that callsite) and the endpoint falls back to the
  global binding — unchanged behavior. Callers with no Channel context (MCP tools, radar
  enrichment) never pass it.
- **`422 slot_broken` (spec §5.1)** — a filled slot is explicit intent: if none of the
  slot's `providerIds` resolve to a usable (non-parked, non-deleted) Provider row, the seven
  `channelId`-carrying endpoints above return `422 { error: { code: 'slot_broken', message } }`
  instead of silently falling back to the global binding or a callsite's hardcoded default.
  Same call also `events.emit`s a `provider.slot_broken` event (`severity: 'warn'`, `dedupeKey:
  'slot:<channelId>:<callsiteId>'` — repeat hits refresh the existing Bell entry instead of
  piling up duplicates) into the notification center; the frontend additionally pops an acrylic
  sonner toast. Fix by repointing or clearing the channel's slot via `PATCH /api/channels/:id`.
- **`options.candidateSlots`** — mirrors `options.slots`' shape (`Record<callsiteId,
  providerId[]>`) but is inert: it is never read by `fixed()`/`dispatch()`. A stream-bundle
  import parks slot references that point at a Provider row being imported alongside it
  (park-on-import, same treatment as parked-provider composition members) — the rewritten
  callsite key moves to `candidateSlots` instead of `slots` so the channel never lands in a
  `slot_broken` state right after import. Activating a parked provider (a `use-imported`/
  `append` decision on its import item, `POST /api/sharing/imports/:id/decisions`) scans
  channels' `candidateSlots` and restores any key whose `providerIds` are now all
  resolvable back into `options.slots`; a key with a still-parked/missing id among its ids
  stays in `candidateSlots` (no partial restore).

## Organize: Whole-Run Undo (undo-run)

* **POST `/api/netdisk/reconcile/undo-run`** — body `{ runId }`, rolls back the provenance rows written by this run in reverse rowid
  order (move back / rename back / rebuild directory), returns `{ undone, skipped }` — `skipped` is the delete-type
  rows encountered (the old winner of `delete-dup`/`delete-loser`/`replace`); deletion went to the recycle bin, and this path is not responsible for fishing them
  back out, only counting them without reporting an error. Missing `runId` → `400 validation_error`; organize not assembled → `503 unavailable`.

  The response from `POST /api/netdisk/reconcile/{:show,bindings/:id}/execute` now also carries `renamed` (number of files renamed in this run),
  `removedDirs` (number of share subdirectories deleted after being emptied), and `runId` (backfilled for the undo endpoint above).

## End-of-Round Adjudicator (spec `2026-09-03-netdisk-llm-adjudicator`)

Package archive pending cards and follow-loop pending candidates and ask the model once; after the conclusion passes the code gate, write it to the decision ledger. See
the "End-of-round adjudication" section in `docs/MATCHING.md` for details. **The model does not delete files** — it only writes `is-episode`/`not-episode`.

* **POST `/api/netdisk/reconcile/bindings/:bindingId/adjudicate`** — body `{ losers?: boolean }`
  (default `false`). Returns `AdjudicationRun`: `{ runId, skipped?, asked, applied, rejected, unsure,
  failed? }`. `skipped:'same cards'` = the card fingerprints are the same as the batch asked last time and fewer than 7 days have passed, so throttling skips it;
  `skipped:'no cards'` = this run has no cards to ask about; `failed` = the whole batch is voided (`'no llm'` not configured / call failed,
  `'unparseable'` receipt is not valid JSON). `applied > 0` and a tmdb tv binding → resync once before responding
  (same as execute/undo-run). Organize not assembled → `503 unavailable`; binding does not exist → `404 not_found`.
* **POST `/api/netdisk/reconcile/bindings/:bindingId/adjudicate/revoke`** — body `{ runId }`.
  Revokes this whole run of model-adjudicated decisions by `note` prefix `llm:<runId>` (without touching manual ones), returns
  `{ ok: true, revoked }` — `revoked` is the number of decision rows deleted; 0 is not an error (that run may never have accepted any row).
  Missing `runId` → `400 validation_error`; not assembled → `503 unavailable`.

## Netdisk Organize: AI Suggestions vs Human Final Choices (Comparison Ledger)

Compare the AI's judgments with the final human click, row by row. **Its only reason to exist is to provide an accuracy baseline for automatic acceptance**:
judgments with citations only guarantee "it really said this"; they do not guarantee "it cited the right words and judged the right episode".

**The AI half has two production writers**: conversational adjudication (the model uses `netdisk_transcribe` to listen, judges by itself, and writes through the decision
endpoint) and the end-of-round adjudicator above. The human half is still backfilled as before, and existing unanswered rows remain answerable.

* **GET `/api/netdisk/reconcile/suggestions`** — `{ items, nextCursor?, summary }`.
  `?state=open|answered`, `?agreement=agree|disagree|inconclusive`, `?limit=` (default 50, cap
  200), `?cursor=`. Unrecognized enum values return `400` (silently ignoring them makes people think the filter was applied); reconcile not assembled returns `503`.
  **Use `?agreement=disagree` to inspect counterexamples** — empirical cases where AI judged wrongly are much more useful than an agreement-rate number.

**There is only GET and no write entrance; this is by design, not unfinished work.** The back half (what the human selected) is backfilled by `POST …/reconcile/decisions`
as a side effect when it writes the decision. Opening another write entrance creates a second route in; ledgers with two routes in inevitably drift out of alignment, and
a misaligned ledger is worse than no ledger — it looks like a number.

`summary` **always counts the whole table** and does not follow `state`/`agreement`/`limit`: readers treat an agreement rate that follows the current page
as global. The four buckets `agreed`/`disagreed`/`inconclusive`/`open` are mutually exclusive and exhaustive, and their sum is exactly
`countable` (= the judgments that gave `is-episode` (with leftKey) or `none-of-these` and carried a citation). Missing one bucket silently makes
a class of outcomes disappear, and "human answered but cannot be compared" is exactly the class most easily folded into agreement.

## Follow Loop (follow loop)

The "follow" toggle and manual trigger for TMDb TV bindings; for what one run does, the cadence table, and failure degradation, see the "follow loop" section in `docs/ARCHITECTURE.md`.
All four endpoints first ask whether the follow service exists — not assembled (netdisk as a whole not enabled) → always `503 unavailable`.

* **GET `/api/netdisk/mappings/:id/follow`** — inspect this binding's follow state:
  `{ follow?, missingAired: string[], upcoming: number, shares: Array<{pwdId,netdisk,origin,
  validity,lastCheck}>, runs: FollowRunRecord[] }` (`runs` are the latest 10, newest first; each run that performed archive
  carries `archived: { runId, moved, deleted, renamed, gated? }`, and `gated` only exists when archive was blocked by the health gate).
  Binding does not exist → `404 not_found`.

* **PATCH `/api/netdisk/mappings/:id/follow`** — toggle, body `{ enabled: boolean }`. Only booleans are accepted;
  non-booleans (such as string `'false'`) → `400 validation_error` (prevents truthiness from making the toggle impossible to turn off). Binding does not
  exist → `404 not_found`; binding exists but its left side is not TMDb tv (movie/subscription Stream) → `400 validation_error`.
  Turning it off clears `nextCheckAt` (turning it back on is equivalent to rescheduling from scratch; it does not carry the previous due time).

* **POST `/api/netdisk/mappings/:id/follow/run`** — manually run one round (`trigger:'manual'`), synchronously returns this
  run's `FollowRunRecord`. Binding does not exist → `404 not_found`. This endpoint really saves files — **saving does not go through a manual
  second confirmation** (user decision: adding files to one's own netdisk is reversible).

* **POST `/api/netdisk/follow`** — follow a show that does not yet have a binding: body `{ tmdb: { id, media:'tv', title,
  year? } }`. The backend assembles the work directory (it does not accept a client-supplied path; the landing point must match the save route), runs `mkdir` on demand,
  creates an empty binding and turns the toggle on, then returns the new binding. `media` is not `'tv'` or `id`/`title` is missing → `400 validation_error`;
  Quark mount preset missing → `503 unavailable`; `mkdir`/`bind` failure (AList unreachable, etc.) → `502 upstream`.

## Affected Sources (who this recipe breaks when it breaks)

* **GET `/api/sources/affected?id=<sourceId>`** —— follows the reverse closure declared by `uses` and answers "if this Source breaks,
  who else goes silent along with it". Returns `{ id, affected: Array<{ id, title, facility }>, unresolved: string[] }`;
  missing `id` → `400 validation_error`, cannot resolve → `404 not_found`, ambiguous bare name → `400` with all candidate full names
  listed in the message.

  `affected` **includes the starting point itself**, is lexicographic, and is never empty (empty would be read as "this Source does not exist"). `unresolved` is
  an unresolvable `uses` edge (`<declarer> → <written id>`): it may point exactly at the Source queried this time, so it is a hole
  in the answer and must be read together.

  **Why a dedicated route is needed**: when a shared recipe (xhs detail) drifts, the few Sources that use it
  **still each have green health** — nobody has run that recipe for them. Nothing except this route can
  point them out. For how to write the declaration, see `uses` in [PACKAGE.md](PACKAGE.md) §1.

  **`id` uses the query string, not a path segment**: the full name is `<npm package name>/<local name>`, which already contains `/` (and may contain `@`),
  so putting it into a path segment requires escaping on both sides, and missing one escape shows up as 404 — an error that looks like "this Source does not exist".
  `id` accepts any existing shape (full name / `xhs:xhs-home` / bare name); normalization is handled by the Registry's four-level resolution.

* **The reverse-reading side is on member rows in `GET /api/channels`**: each member adds one cell
  `dependencyIssues?: Array<{ kind:'broken', id, title?, health, error? } | { kind:'unresolved', id }>`
  — "I am green myself, but something I depend on has a problem". **It appears only when there is a real issue** (if everything is healthy, the whole cell is omitted).

  It is separate from `health` on the same row: `health` says "can I harvest", while this cell says "does what I depend on still exist".
  In the UI it can only hang on **the user of the dependency**: the shared Source (xhs detail) is not a member of any Stream,
  so it has no row of its own; the few rows that use it are in front of the user every day and appear completely normal.

## Link Claiming (`/api/links/recognize`)

* **GET `/api/links/recognize?url=<url>`** — "whose link is this, and what is it": returns
  `{ url, package, platform, kind?, id?, yields? } | null`. `null` = no installed package claims it (200, not 404 — "nobody claims it"
  is an answer); missing `url` → `400 validation_error`. The claim table is each package's `stream.links` (PACKAGE.md §0.5 "`links`"),
  and the host does not know any site. Links hitting a package's `shortHosts` are expanded before recognition (only hosts declared by that package are hit, `redirect:manual`, max 3 hops,
  5 seconds each hop), and at that point `url` is the expanded address; expansion failure recognizes the original link, and the reason goes to the DebugBox `links` Channel. It only claims, and does not dispatch
  or grab content — media grabbing is `GET /api/media/from-url` (dispatches `content.enrich` by the recognized `<platform>-link`).
## Radar (URL → Candidate Sources)

* **GET `/api/radar?input=<url>`** — parses a pasted-in address into candidate Sources that can consume it (RSSHub catalog +
  native plugins), `{ input, matches: Array<{ sourceId, params, title }>, fallback: 'generic-url' |
  'unknown' }`; missing `input` → `400 validation_error`. The extension popup's "雷达" ("Radar") consumes this.

  **Do not hang it back onto `/api/intents`** — that is the path for the intent-tracking resource below. When the same `method+path` is registered
  twice, Hono only lets the first registered one respond and the later one is unreachable forever, while **both sides' unit tests stay green** (each mounts its own half
  app; the conflict only exists in the real assembly). The guard is in `src/http/route-collisions.test.ts`: in the fully assembled app's route table,
  `method+path` must be unique.

### "Want to Onboard but Cannot Yet" List (Onboard Wishlist)

When a URL is found in conversation but `/api/radar` has no candidate Source to catch it, write down one "want to onboard but cannot yet" entry.

| Method | Path | Description |
|---|---|---|
| GET | `/api/onboard/wishlist` | "Want to onboard but cannot yet" list (sites that cannot be onboarded in conversation), newest first |
| DELETE | `/api/onboard/wishlist/:id` | Delete one entry |

**This list has no HTTP write entrance** — the only write path is the `note_unonboardable` tool in conversation (called proactively by the model,
and not guaranteed to be complete).

## One-Shot Resolution (`/api/resolutions`)

* **GET `/api/resolutions?type=<targetType>&key=<key>`** (or `?input=<pasted thing>`, where IntentResolver
  classifies type/key; both missing → `400 validation_error`) — resolves once through the target-type ladder,
  `{ targetType, key, result: { source, items } | null }`.
  `result: null` = this target-type has no ladder (the corresponding package is not installed), not "nothing found".

  **The key grammar for `type=lyrics`**: `<platform>:<id>` (known track reference, where `platform` is a package's facility,
  claimed by that package's track pattern in `stream.links` / Provider row serveKeys) or `<title>::<artist>` (fuzzy search).
  Lyrics results are cached by key on the call side (hits forever, misses for 7 days; `AudioArchive` owns the TTL; this HTTP opening and the MCP
  `resolve` tool share `src/audio/lyrics-cache.ts`); on a hit, `result.source` is `lyrics-cache`.
  No rung in the ladder answered (`result: null`) **does not write cache** — that means no Source is configured, not that the song has no lyrics.

## Intents (Intent Tracking)

Subscribe to a "purpose" rather than a "Source": create an Intent with a `goal`; the LLM generates the judgment standard `criteria`; after that, new items in Streams
under it are judged one by one for relevance against `criteria`, and relevant ones are merged into the dossier. For concepts and invariants, see
[ARCHITECTURE.md § Intent](ARCHITECTURE.md#intent). Except for `GET /api/intents/:id/dossier`
(returns raw markdown), all endpoints are JSON. When `deps.intents` is not assembled (for example, in minimal test assembly), all endpoints return `503
{ error: { code: 'unavailable' } }`.

* **POST `/api/intents` (Create)** — body `{ goal: string, streamIds?: string[], recruit?:
  boolean }`. `deps.intents` not assembled → `503 { error: { code: 'unavailable' } }`; missing/empty-string `goal`
  or `streamIds` not a `string[]` → `400 validation_error`; after `goal` validation passes, LLM generation of `criteria`
  fails or write-to-disk fails → no Intent is created, `500 { error: { code: 'upstream_error', message } }` (message is the
  thrown error, such as "LLM 未配置" ("LLM not configured")). Success returns `201` and the new `IntentRecord`; when `recruit:true`, it additionally triggers one
  Source recruitment (same as `POST /:id/recruit`), and if successful the response body includes `recruited: RecruitOutcome`; Source recruitment failure
  **does not affect** the already-created Intent (it can be retried later with `POST /:id/recruit`, and is not reflected in this response).
* **GET `/api/intents` (List)** — `{ intents: Array<IntentRecord & { ledgerCount: number }> }`,
  including `retired` ones. `ledgerCount` = the number of items already judged in this Intent's ledger (a rough activity signal).
* **GET `/api/intents/:id` (Detail)** — single `IntentRecord & { ledgerCount }`; nonexistent → `404
  not_found`.
* **GET `/api/intents/:id/dossier` (Dossier)** — the response body is **raw markdown text** (`content-type:
  text/markdown`), not a JSON envelope; intent does not exist → `404 not_found`; exists but has not digested any relevant content yet
  → `200` empty string (not 404 — the Intent itself is valid; the dossier just has no content yet).
* **POST `/api/intents/:id/recruit` (Source Recruitment)** — search candidates in the local Source registry by `goal+criteria`; LLM
  selects Sources, validates params, deduplicates, and trial-eats; passing ones are subscribed immediately into this Intent's dedicated Channel (`intent-<first 8 chars of id>`), synchronously
  executed (seconds-scale) and returns the result directly, not async discovery: `200 { subscribed: [{ streamId, sourceId }], reused:
  string[], dropped: number }` — `subscribed` is the newly subscribed Streams in this call, `reused` are existing
  streamIds hit by deduplication and reused (not newly subscribed), and `dropped` is the number of candidates blocked by param validation/deduplication/trial-eat gates. Intent does not exist →
  `404 not_found`; an already `retired` Intent (caller state error, not a Source recruitment failure) →
  `409 { error: { code: 'conflict', message: '意图已退休' } }` ("Intent retired"); recruit not wired (bootstrap did not assemble
  `IntentServiceDeps.recruit`) → `503 { error: { code: 'unavailable', message } }`; other failures
  (including upstream LLM call failure during Source selection) → `500 { error: { code: 'upstream_error', message } }`.
* **POST `/api/intents/:id/digest` (Digest One Round Now)** — manually triggers one digest round (without waiting for cadence), returns
  `DigestOutcome { judged: number, relevantNew: number, errors: number, remaining: number,
  windowSaturated: string[] }`. `judged` is the number of items this round attempted to judge (including those whose judgment failed and counted in `errors`,
  subject to `maxJudged`, default 100, capping the number of serial LLM calls per round); `remaining` is the number of items outside the ledger in this round that did not get a turn and are left for the next
  round (the ledger is naturally a checkpoint and loses nothing; when `remaining > 0`, this round does not advance `lastDigestAt`, and the next
  `intent-digest-scan` immediately continues scheduling without waiting for the whole cadence); `windowSaturated` is the list of stream ids whose "digest window"
  (latest 200 items per Stream) is entirely unjudged in this round — its presence means older items outside the window may be permanently
  missed. It shares the same single-slot queue with the scheduled task `intent-digest-scan` (serialized inside `IntentService`), so manual triggering does not
  race the inspection into two concurrent rounds of LLM calls. Intent does not exist → `404 not_found`.
* **POST `/api/intents/:id/retire` (Retire)** — sets `status` to `retired` (**does not delete**; historical ledger/dossier
  are retained), and rolls back Streams subscribed by this Intent's Source recruitment (unsubscribe; per-item failure only logs and does not roll back) plus its dedicated Channel; manually bound
  Streams are unaffected. `intent-digest-scan` only scans Intents with `status: 'active'`; retired ones do not participate, but can still
  be manually digested through `GET`/`POST .../digest`. Nonexistent → `404 not_found`. There is no reverse "unretire" endpoint.

**No edit endpoint**: `goal`/`criteria`/`streamIds` cannot be changed (`streamIds` on
`POST /api/intents` is the only write entrance, and `POST /:id/recruit` is another entrance for appending subscriptions); changing `goal`/`criteria`
currently requires creating again.

**MCP surface** (`src/mcp/tool-catalog.ts` + `src/mcp/server.ts`): `intent_create` (`{goal}` → same as
`POST /api/intents` without `recruit`), `intent_list` (same as `GET /api/intents`) go through the generic catalog and
standard JSON envelope; `intent_dossier` (`{id}` → raw markdown) is manually registered separately because it cannot be escaped by the envelope (which would escape newlines into
literal `\n` values); when the intent is not found, it reports an error through the MCP SDK's `isError` channel instead of returning null. Source recruitment and active
digesting **do not enter the MCP surface** — those are background scheduling / HTTP operations, not queries.

## Sharing (Config Sharing · stream-bundle)

Share user-orchestrated config (Channel/Stream/Provider closure) as a single `stream-bundle/v1` JSON. **Import executes nothing** (recipes only run on the next tick of the Stream that references them), **credentials never enter the package** (only `requires.credentials`/`runtimeConfig` requirement declarations are written), and **transport is host-independent** (URL or local file). See `internal design record` (closure/package format) and `internal design record` (import ledger) for design.

**Core model (import decision ledger)**: one import = one addressable resource (run); every pending decision item it leaves behind = one item (`kind: 'parked-provider' | 'slot-conflict' | 'notice'`, each with `subject`/`mine`/`theirs`/`choices`/`detail`). Import lands but is lazy: non-disputed things are done immediately, while disputed ones become open items — **before a decision, it does not damage any locally effective config**. A decision is the item's only state transition (open → decided/dismissed), and execution failure does not half-commit. The UI import result page and the AI's "help me import and process it" consume the same data.

- `POST /api/sharing/exports` — body `{ root: { kind: 'channel'|'stream'|'provider', id }, meta?: Partial<BundleMeta>, providerIds?, bindingCallsiteIds?, netdiskBindingIds? }` → `{ bundle, warnings[] }`. Follows the dependency closure from the root: code plugins go into `requires.plugins` (declaration + version constraints), and the full recipe goes into `embedded.recipes`; `meta` defaults are filled from the root label + current date + revision `1.0.0`. Suspected keys hidden in params → `400` reject export. Optional arrays are capability carry-along (see the next two sections).
- `POST /api/sharing/imports` — body `{ url } | { bundle }` → `201` `ImportRun{ id, at, meta, remaps, recipeDecisions, netdiskBindings, items[] }`. Config row id collisions remap (system Channel `stream_ids` append reuse + slots merge according to the semantics below); recipe version semver merge (upgrade/reuse/cross-major becomes notice); missing plugins / credentials to fill / runtime-config to fill each become a notice item; unknown/bad format returns `400` and does not partially write.
- `GET /api/sharing/imports` — `{ items: [{ id, at, meta, openCount, itemCount, netdiskBindings }] }` (`at` descending).
- `GET /api/sharing/imports/:id` — the run's **current state** (not a snapshot at import time): parked-provider open items are projected live from current store values (provider already activated/deleted elsewhere → displayed as decided/dismissed), and includes a `conflicts` conflict checkup.
- `POST /api/sharing/imports/:id/decisions` — body `{ itemId, choice }`. choice must belong to that item's `choices`. Success `200 { item }`; duplicate decision / execution failure (activation conflict, slot validation failure, etc.) → `409 { error, item, conflicts[] }`, item remains open, reason is written back to `detail`; unknown run/item `404`. Error bodies are always `{ error: { code, message } }`.

**Import semantics for the system Channel's `options.slots`**: slot keys inside the package first go through provider id rewriting; if the local callsite is **not configured** (`slots` ∪ `candidateSlots` both have no such key) → silently merge (references that land on parked rows from the package go to `candidateSlots`, and move back on activation); if **already configured** → the local config keeps taking effect, and the package's copy becomes a `slot-conflict` item (`mine`/`theirs` carry both provider projections, and the run is the only storage; no second copy is left on Channel options). The `use-imported` decision: if every id in the key is usable → write `slots` after `validateSelection`; if it contains parked ones → put it in `candidateSlots` until activation. Non-system Channels with id collisions fork a new Channel, so structurally they have no slot conflict.

### Sharing Capability Carry-Along (config-sharing v2 · Provider)

- `POST /api/sharing/exports`'s `providerIds?: string[]` / `bindingCallsiteIds?: string[]` — explicit selection carries the author's **non-system** Provider rows + binding overrides into the package (not into the Channel closure); member runtime_config only goes into `requires.runtimeConfig` (without values), and a Provider member hiding a key → 400 reject export.
- Imported Providers "enter lying down" (park-on-import): written to the database but not into dispatch, leaving the other side's existing routes unchanged; each row gets a `parked-provider` item (`choices: use-imported | keep-mine | append | dismiss`, one-to-one with activation semantics). Decision execution activates it immediately (including candidateSlots restoration); serves overlap / binding takeover details are projected by `conflicts` from `GET /api/sharing/imports/:id`, so the caller decides after reading them.
- The pending-activation list has no standalone endpoint: read it from the run's open items (the provider row itself still uses `/api/providers` CRUD and parked behavior).

### Sharing Netdisk Binding Carry-Along (config-sharing v2 · B)

- `POST /api/sharing/exports`'s `netdiskBindingIds: string[]` — selection carries the **portable subset** of a netdisk alignment binding (`left` + `matchSpec` + manual-correction entries only + optional shareUrl) into the package's `netdiskBindings` block; it **does not carry** `right.path`/fileId/credentials. stream-left but Stream not included in the package → warning. Selection reuses existing `GET /api/netdisk/mappings` (no new listing endpoint).
- `ImportRun.netdiskBindings: {id,title,shareUrl?}[]` — import temporarily stores each item as a pending MappingSet whose `right` is unresolved and `autoSync:false` (**import executes nothing**: no save / sync / harvest), and returns a to-save list to guide the other side: use their own Quark login state to save → mount AList → use existing `POST /api/netdisk/mappings/:id/rebind` → sync deterministically recomputes with the packaged matchSpec to complete the first binding (does not rerun AI). rebind uses the existing endpoint and does not enter items; stream-left missing stream becomes a notice item.
