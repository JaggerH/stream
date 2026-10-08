# API Design Standards

## Principles & Rules

1. **Eliminate Redundant Endpoints**:
   - Avoid duplicating system check or metadata endpoints.
   - `/api/status` is the one rich system endpoint (`{ ok, cookies, manifests, streams: [{id, last_tick, item_count}] }`) — its HTTP 200 doubles as a liveness signal for authenticated callers. Do not add parallel metadata endpoints that duplicate it. (`/api/health` was folded into it 2026-07-02.)
   - **Sanctioned exception — `/api/health`**: a deliberately minimal, **unauthenticated** liveness probe (`{ ok: true, commit?, started_at, dirty_since_start, last_harvest_at?, pending_restart? }`), registered *before* the access guard (see 访问控制 below). It exists because the MCP spawn-or-reuse readiness gate (`src/mcp/spawn-backend.ts`) needs a probe that (a) works before any `api_token` is configured and (b) **never fails, and never waits on anything remote**. Keep it minimal and non-fallible — never give it data dependencies that can throw. (A regression once made it `await deps.health()`, so a failure inside an unrelated dependency 500'd the probe and broke that liveness contract; `last_harvest_at` now comes from a separate synchronous read-only closure.) It is not `/api/status`'s twin and carries no system detail.
     - The build-identity fields (`src/http/build-identity.ts`) answer **"which copy of the code is this process actually running"** — the only cheap defence against a hot-reload that silently missed a change, where "the switch was never wired" and "the change made no difference" look identical. They are the one sanctioned bit of local I/O on this path, and they stay inside the contract by construction: the whole block is wrapped in `try/catch` (a failure costs fields, never the 200), nothing is awaited, nothing touches the network. Measured cost: `git rev-parse` **3 ms once** (memoised for the process lifetime), and a `.ts` mtime scan of `src`+`shared`+`packages` **4–5 ms, at most once per 5 s** (cached; the readiness gate polls far faster than that). Adding a field here means keeping all four properties — local, synchronous, bounded, guarded.
     - `dirty_since_start` is a **hint, not an alarm**: any parallel worktree's uncommitted WIP counts toward it, so `> 0` is ordinary. `0` is the strong signal; the verdict you actually act on is whether `commit` is the one you meant to test. Never assert on it.
   - **Sanctioned exception — `GET /api/ext/relay-status`**: the ext-relay connection probe (`{ connected, since }`, `since` = ISO instant the *current* connection was established, `null` when down), likewise **unauthenticated** and registered *before* the access guard (see 访问控制 below) — it is the first diagnostic step when the extension seems offline, and demanding a credential exactly then defeats the purpose. Read-only, no side effects, no data; the relay dep being absent returns 404 (backend has no relay wired) rather than pretending "extension not connected". Added 2026-07-27 after a misdiagnosis burned four rounds of debugging because the relay had no observable surface at all (see also the connect/disconnect log lines in `shared/browser-relay/relay.ts`).

   - **Sanctioned exception — `GET /api/ext/claimed-tabs`**: which browser tabs the backend is *currently* driving (`{ tabIds: number[] }`), **unauthenticated** and registered before the access guard for the same reason as `relay-status` — the extension's reconciliation must not depend on holding a credential. It exists because lane→tab lives only in backend process memory: a restart orphans every harvest tab still open in the user's Chrome, and the extension can only reclaim them by asking whose tabs are still claimed. **An empty array and a failure are different answers and must stay different**: `[]` means "the backend claims none" (the normal post-restart state — reclaim them), whereas a missing session dep returns **503** so the extension does nothing. Returning `[]` on a wiring failure would tell the extension to close every tab in the group. The reclaim policy itself (only `probe` origin; never `adopted`, never `created`) lives in the extension, not here — see `write-recipe`'s `references/session-runtime.md`.

   - **Sanctioned exception — `GET /api/browser-capability`**: the harvest-capability quick verdict (`{ state, connected, since, everSeen, lastSeenAt?, extVersion?, browser?, platform? }`), also **unauthenticated** and registered before the access guard — the onboarding guidance has to be readable *before* a token exists. Not a duplicate of `relay-status`: that one answers "is it connected right now" from live state only, this one adds the persisted `everSeen` history, so `state` collapses to the three onboarding lines `ready` / `disconnected` / `never-seen` (design 2026-07-29 §5). `everSeen` is **monotonic and never expires** — the extension runs *inside* Chrome, so one connection answers both "is Chrome installed" and "is the extension installed", and "was installed once" is a historical fact an uninstall cannot undo (hence no TTL anywhere). Pure read of relay state + the `data/browser-capability.json` cache: **no probing, no waiting, no waking anything**, so it always returns instantly. `connected:false` is NOT a health verdict (an MV3 service worker being reclaimed is normal) and must never be written into `sourceHealth`.

   - **Sanctioned exception — `POST /api/browser-capability/diagnose`**: the *full* diagnostic, same shape as the quick verdict **plus** a `chrome` block (`{ selected, origin, candidates[], mustChoose }`). Unauthenticated for the same onboarding reason. The split is the point: the quick verdict never touches the filesystem so it always returns instantly, while this one enumerates Windows mounts and stats candidate `chrome.exe` paths — run it only when the quick verdict says `never-seen`, or when the user explicitly asks (design 2026-07-29 §5: existing users never reach it). POST, not GET, because it *does* work rather than read state.

   - **`/api/extension/{onboarding,materialize,install,decline}` —— 安装引导的四条，注册在门
     *之后*，不是豁免项。** 判据是"有没有副作用"：上面那两条快判是纯读，装机引导得在拿到凭证
     之前就能读；而 `install` 会**驱动用户自己的桌面**、`decline` 会落盘，有副作用的一律不进
     免检名单。`onboarding` 是 GET（读"拒绝过没有"，`{ declinedAt? }`），另三条是 POST。
     `install` 回三态 `{ status: 'connected' | 'needs-chrome-restart' | 'blocked', reason? }`：
     **`blocked` 必须带 reason 原文**（哪一步的哪个控件没匹配上），收窄成"装不上"就是把排查
     线索扔掉。**抛异常（500）和 `blocked` 是两件事**：前者是这一趟根本没跑起来（Stream
     Desktop 没连），去看 Stream Desktop；后者是跑了、卡在某一步，去看 Chrome。dep 缺席 → 四条全 404，
     别伪装成"装不了"。

     **MCP face — `harvest_capability`** (no parameters): the same structure this endpoint returns, over MCP. One shape, two doors — both assemble it through `diagnoseCapability()` in `src/browser/capability-store.ts`, so a field cannot exist on one side only. MCP gets *only* the full tier, not the quick/full split: the split exists because the onboarding page must render instantly, which a deliberate tool call has no equivalent of, and what a pure-MCP caller most needs — "which side do I install on" — is exactly what the `chrome` block answers. Guarded to `NeedsBackendError` in stdio disk mode (`src/mcp/disk-service.ts`): with no HTTP server there is no `attachExtRelay`, so the verdict would read `disconnected` ("reload the extension") when the truth is "the backend is not running" — the one read-shaped extra guarded for honesty rather than for writes.

   - **`GET|PUT /api/settings/harvest-browser`**: which Chrome harvesting rides (`{ selected, origin, candidates[], mustChoose }`; PUT takes `{ exe }`). Same `chrome` block the diagnostic embeds — one shape, two doors, no second projection. The backend **lists candidates and never picks one**: WSL + Windows both having Chrome is a legal state, and choosing wrong fails silently (harvest runs as a guest, everything "works", nothing is collected), so `mustChoose` exists to make the entry point stop and ask. PUT rejects a non-existent path with 400 rather than storing it — otherwise the failure surfaces hours later in an unrelated harvest round (the existence check lives on the `harvest-browser` config row's `validate` hook, so the generic `PUT /api/config/harvest-browser` gets the same rejection). The same field has three faces (web/app settings, desktop onboarding, `harvest_browser.exe` in config.yaml); this is the HTTP one.

   - **`GET|PUT /api/config/:rowId`** — the generic **config row** pair (engine: `src/settings/config-rows.ts`, spec `2026-08-17-config-rows-slice1`). GET returns `{ schema, values, secrets }`: `schema` is the row's schemastery `toJSON()` (the frontend revives it with `new Schema(json)` and renders the form from it), `values` is the layered merge (schema defaults ← config.yaml deploy defaults ← user layer) **with secret fields removed**, `secrets` maps each `.role('secret')` field to `{ configured }`. PUT takes a partial values object: unknown keys are **rejected with 400** (the strict-input gate below — the legal keys are the row's own schema keys, `rows.keys(id)`), absent/blank secrets keep the stored value, blank non-secrets mean "explicitly cleared" (no fallback to default); schema type errors and `validate`-hook rejections are 400 with the reason. Rows registered today: `video-sources`, `summary-prompt`, `harvest-browser`, `alist`. The legacy old-key blocks underlay the user layer **per key** (a row value overrides only the keys it sets). The older per-family `/api/settings/*` pairs for these are thin forwards kept for an observation period — new consumers use `/api/config/:rowId`, and **new settings get a row, not a new endpoint pair**. One family-specific note: AList's `adminPassword`/`mounts` are not row fields (bootstrap-internal credential / mount desired-state respectively).

2. **不认识的键要报 400，不许静默丢弃**（判据：`src/http/strict-input.ts` 的 `unknownKey` / `unknownKeyMessage`）：
   - 一个 handler 只读自己认识的那几个键，多出来的**连看都不看**。界面撞不到（字段名写死在前端），
     但 agent / 脚本 / 手写 curl 写错一个名字就拿到 **200 + 一份看起来完全正常的响应**——
     没有任何信号告诉它"你要的事情根本没发生"。
   - 报错必须带两样：**你写的是什么** + **大概想写什么**（`closestKey` 认得出 `stream_id`→`stream`
     这种下划线/驼峰的另一种写法，纯按编辑距离会漏）。只说"参数错误"等于没说。
   - 合法键列成一份具名常量（`ITEMS_QUERY_KEYS` / `STREAM_PATCH_KEYS`），**加字段就要加进去**——
     漏加是响亮的 400，不是静默失效，方向是对的。
   - **`src/http/` 下每个读 body 的写入端点都接了闸**（下面这份是全集）。新写的端点直接接上，
     别再添一处静默丢弃的：
     - 读：`GET /api/items`、`GET /api/download-options`
     - 订阅 / 频道：`POST /api/streams`、`PATCH /api/streams/:id`、`POST /api/channels`、
       `PATCH /api/channels/:id`、`PATCH /api/channels/:channelId/streams/:streamId/ad-filter`、
       同路径的 `title-filter`
     - 网盘：`POST /api/netdisk/mappings`、`.../:id/rebind`、`PATCH .../:id/entries/:leftKey`、
       `.../:id/spec/preview`、`.../:id/spec/apply`、`POST /api/netdisk/fs/{mkdir,move,remove,rename}`、
       `POST /api/netdisk/fs/put`（multipart 的字段名过同一道闸）、`PUT /api/netdisk/mounts`、
       `POST /api/netdisk/share/{verify,save,create}`
     - 整理：`POST /api/netdisk/reconcile/{open,undo,undo-run,decisions}`、
       `PUT /api/netdisk/reconcile/config`
     - Provider / 调用点：`POST /api/providers`、`PATCH /api/providers/:id`、
       `PUT /api/provider-callsites/:id/binding`
     - 条目 / 采集面：`PATCH /api/items/:id`、`POST /api/items/renormalize`、
       `POST /api/sources/preview`、`POST /api/facilities/:id/page/evaluations`
     - 收藏 / 播放：`POST /api/collections`、`PATCH /api/collections/:id`、
       `POST /api/collections/:id/items`（**顶层与每个数组元素各过一遍**——顶层只有一个 `items`，
       写错的键几乎总在元素里）、`PUT /api/collections/:id/order`、
       `PUT /api/collections/:id/items/:key`、`PUT /api/watch-progress/:key`、`POST /api/downloads`
     - 意图：`POST /api/intents`
     - 包 / 插件：`POST /api/recipes/packages/{preview,install,uninstall}`、
       `PUT /api/plugins/:pluginId/enabled`
     - 动作 recipe：`POST /api/recipes/action`（回 running 后 `GET /api/recipes/action/:runId` 等结果）、
       `POST /v1/images/generations`（会出图的动作 recipe 的 OpenAI 形状出口；`/v1/*` 过同一道门）
     - 设置：`POST /api/source-runtime-config/status`、`PUT /api/source-runtime-config`、
       `POST /api/source-runtime-config/provision`、
       `PUT /api/settings/{harvest-browser,summary-prompt,video-sources}`、
       `POST /api/settings/alist/test`、`POST /api/settings/archive/{reconcile-formats,orphans}`
     - 声纹：`POST /api/voiceprint/persons`、
       `POST /api/voiceprint/item/:itemId/clusters/:cluster/enroll`
     - 事件 / 扩展面（Origin 门控那两条也算）：`POST /api/events/read`、`POST /api/ext/verify`、
       `POST /api/ext/debug-log`
     - 分享：`POST /api/sharing/exports`、`POST /api/sharing/imports`、
       `POST /api/sharing/imports/:id/decisions`
     - 看板：`POST /api/data/query`、`POST /api/boards`、`PATCH /api/boards/:id`
       （`id`/`system` **不是** PATCH 的合法键：handler 用路径上的 id、保留现有 system 位，
       body 里带过来的那两个原本被静默丢掉）
     - 转换：`POST /api/conversions`
     - AI 介入：`POST /api/interventions/proposals/:pid/accept`（合法键 `ACCEPT_BODY_KEYS`，今天只有 `stateId`）、
       `POST /api/interventions/:id/permissions/:permId`（`PERMISSION_BODY_KEYS`，只有 `optionId`）、
       `POST /api/interventions/:id/messages`（`MESSAGE_BODY_KEYS`，只有 `text`）、
       `POST /api/interventions/explorations`（`EXPLORE_BODY_KEYS`：`facility` / `target` / `goal` / `limits`）
     - 配置 row：`PUT /api/config/:rowId` —— **合法键不是手抄的名单，是这一行 schema 声明的键**
       （`ConfigRowRegistry.keys(id)`）。名单和引擎同一个真相源，加字段永远漏不掉。
   - **不收 body 的端点不接闸**：它们的输入全在**路径段**里，handler 读都不读 body，加一道闸
     只是噪音。`.../sync`、`.../entries/:leftKey/reset`、
     `POST /api/netdisk/mounts/reconcile`、`POST /api/netdisk/reconcile/{:show,bindings/:id}/{preview,execute}`、
     `/api/{streams,channels}/:id/refresh`、`/api/streams/:id/seen`、
     `.../ad-filter/reclassify`、`/api/{streams,collections}/:id/playlist-export`、
     `/api/video/works/:key/refresh`、`/api/browser-capability/diagnose`、
     `/api/auth/facilities/:facility/focus`、`/api/provider-callsites/:id/restore-default`、
     `/api/credentials/:domain/connect`、`/api/facilities/:id/close`、
     `/api/intents/:id/{recruit,digest,retire}`、`/api/packages/:id/restart`、
     `/api/voiceprint/item/:itemId/clusters`、`/api/voiceprint/appearances/backfill`、
     `/api/interventions/proposals/:pid/reject`、
     `/api/interventions/:id/{continue,cancel,resume}`。
   - 闸放在形状校验**之前还是之后**看哪句话更准：一般在前（「你写的是 `sources`，该写 `members`」
     比「members must be an array」有用），但某个字段已有更准的专属错误时放在后
     （`PATCH /api/channels/:id` 的 `id` 由「id cannot be changed」挡下）。

3. **Resource-Oriented Pathing**:
   - Design API endpoints around nouns representing resources (e.g., `/api/channels`, `/api/streams`) rather than actions (e.g. `/api/get-channels`).

4. **Runtime Source Configuration**:
   - Runtime values belong to the Source named by `{ pluginId, sourceId }`; Provider rows never carry credentials, endpoints, or facility configuration.
   - `POST /api/source-runtime-config/status` returns non-secret values and secret status only, plus `envFallback: string[]` — the field names the host's deployment env fallback covers for this ref (names only, never values; always present, `[]` when none). The config sheet's required-field gate accepts these as satisfied: the member resolves them at run time from the same table (`src/kernel/plugins/runtime-config.ts`). `PUT /api/source-runtime-config` accepts only manifest-declared fields. Both are forwards into the config-row engine's **source family** (`/api/config/source:<ref>` is the same row — manifest fields are translated to the row's schema, so the layering/secret semantics are the engine's single implementation; the per-instance namespace guard applies on both doors).
   - Secret values are write-only and must not appear in Source detail, diagnostics, member params, cache keys, or stored items.
   - **`POST /api/source-runtime-config/provision`（自助申请一把 key）跑完必须回头核对那一格填上了没**——判据是重新读一次 `secrets[<field>].configured`，不是 recipe 没抛错。这类 recipe `allowEmpty`、不产 item，「建成功了」和「抽取一处没命中」在 runner 的回执里一字不差；照后者报成功，用户会拿着一格空 key 去别处查。**跑 + 核对只有一份实现**：`src/credentials/provision-slot.ts` 的 `provisionConfigSlot`，这个端点和 MCP 的 `provision_capability_key` 吃的是同一个函数（两边各写一遍的漂移是静音的：一边核对、另一边报假成功）。核不上时 `502` 并指路 `<dataDir>/failures/`。

## 访问控制：谁打得到 `/api/*`、`/v1/*` 和 `/ws`

后端绑 `0.0.0.0`（从手机/局域网访问 Stream 是刻意保留的能力），所以它同时是**局域网上每台机器**
和**你自己浏览器里每一个网页**的邻居。判据实现在 `src/http/access-guard.ts`，两道，顺序固定
（`/v1/*`——OpenAI 形状的生图口——挂在 `/api` 之外只是为了合 Base URL 的习惯，门是同一道）：

**第一道 · 浏览器维度**（`Host` + `Origin`）——挡的是"本机上的恶意网页"和 DNS rebinding。
一个页面 fetch `127.0.0.1:8900` 时，来源地址就是 loopback，跟我们自己的前端毫无区别；
认得出它的只有 Origin。

- `Origin` 缺失 → 可信（curl、MCP、本机原生进程，或同源 GET）。
- `Origin` 与 `Host` 同源 → 可信（我们自己的前端）。
- `chrome-extension://<固定 ID>` → 可信（**只认我们那个扩展**，别的扩展不认；网页伪造不了 Origin）。
- `Host` 必须是 IP 字面量或 `localhost`，**域名一律要在 `config.yaml` 的 `trusted_hosts` 里登记**。
  这条防的是 DNS rebinding：攻击者把自己的域名解析到 `127.0.0.1`，那时 Host 和 Origin 都是他的
  域名、"同源"照样成立，唯一还认得出它的就是"这名字我们没登记过"。
- 不过 → **403**。

**第二道 · 来源维度**（对端地址 + token）：

- loopback（`127.0.0.0/8`、`::1`）→ 放行，**不需要任何凭证**。能从本机连上来的人，token 拦不住。
  实测：Windows 的 Chrome 打 WSL 里的后端（mirrored 网络）看到的就是 `127.0.0.1`，主路全程无感。
- 其余一律要出示 token：`Authorization: Bearer <token>` 或 `?token=`（后者**只为浏览器存在**——
  WebSocket 没法自设请求头，手机首访也需要一条能点的链接；前端拿到后立刻存起来并把它从地址栏擦掉）。
- 拿不到对端地址 → 按外来处理（fail-closed）。"读不到源地址"绝不能变成"那就当本机吧"。
- 不过 → **401**，前端据此弹一次输入框（`AccessTokenPrompt`）。

**token 从哪来**：`config.yaml` 的 `api_token`（显式配置优先），否则首启自动生成到 `data/api-token`
（0600，同 `data/ext-relay-token` 那一档）。**默认必须有一把锁**，而不是默认没有。
取处是 `GET /api/access-token`，它**只对本机回答**（非 loopback 直接 403，哪怕对方已经持有 token）——
所以别的设备没法靠"打开一下设置页"把自己放进来。它连 `urls` 一起给（本机各网卡的 `http://<ip>:<port>/?token=…`），
因为手机上要用的是一条能点开的链接，不是 64 位十六进制手抄。

**豁免的那几条**（注册在门**之前**，各自在原地写明了理由）：`/api/health`、`/api/ext/verify`、
`/api/ext/relay-status`、`/api/ext/claimed-tabs`、`/api/ext/debug-log`、`/api/browser-capability[/diagnose]`。
共同点是"连不上/还没有凭证的时候正要用它"。`/api/ext/*` 那几条另有 Origin 门控。

## 反方向的那道门：扩展怎么认出后端

上面那道门管的是「谁打得到我们」。反过来还有一问：**扩展凭什么相信 `127.0.0.1:8900` 那头是我们？**
它比第一道更要紧——ext-relay 这条通道的能力等于「在用户任意标签上执行任意 JS」，也就是他的全部登录态。

判据不是"这个地址看起来对"，而是**双方都知道 `data/ext-relay-token`**：

- **扩展怎么拿到 token**：经 Chrome native messaging 拉起 `stream-desktop`（host id `com.stream.desktop`），由它读那个文件
  （`0600`，只有同一个用户读得到）。清单写在操作系统指定位置、`allowed_origins` 钉死我们的扩展 id，
  所以冒充者要伪造这条路得先能改用户的注册表/配置目录——到那一步它直接读 `data/cookies.json`
  更省事。**门槛从「抢一个端口」抬到「改你的机器」**（同 Claude Code 的 IDE 集成对
  CVE-2025-52882 的修法：带外通道走文件系统）。
- **后端怎么自证**：`POST /api/ext/verify`，body `{nonce}`，回
  `{proof: HMAC-SHA256(token, "stream-browser-verify:" + nonce)}`（前缀是 `VERIFY_PREFIX`，
  真相源 `shared/browser-relay/wire.ts`）。**回的是 proof，不是 token。**
  nonce 由扩展每次新生成，录下来的应答重放不了。

**别加一条把 secret 直接发出去的端点（`POST /api/ext/token` 这种形状）**——`app.ts` 原地和
`src/http/app.ext-verify.test.ts` 各有一条看门狗盯着。方向反了：扩展向对端索取凭证，等于谁抢到
这个口谁就拿到全部能力。

**扩展侧的两条红线**（`extension/src/lib/`）：
1. **绝不回退**。native host 取不到 token 就停在原地重试，不许退回去问后端要——有回退，
   冒充者只需让 native 那条路失败（它什么都不用做，没注册就是失败）就能拿回旧行为。
2. **先验后给**。WS 握手会把 token 放进 `Sec-WebSocket-Protocol`——**连上去这个动作本身就是
   在交出 secret**，所以 `verifyBackend` 必须在握手之前。（登录态本身不走 HTTP：后端在
   已经认证过的中继上发 `op:'cookiePull'` 来取，见 `docs/PACKAGE.md` §5.2。）

**加端点时注意**：门是 `app.use('/api/*', …)`，Hono 的中间件**只对之后注册的路由生效**。
`serve.ts` 里更晚挂上的 `/api/mcp`、`/_p` 网关都在门后（`/api/mcp` 能打开任意网址并在用户登录态里
执行任意 JS，它绝不能比别的端点松）。要新加豁免，就得注册在门之前，并在原地写清为什么。

## Domain Concepts & Glossary

To resolve naming confusion (e.g., Channel vs Stream vs Source), follow this model hierarchy:

1. **Channel (频道 - 展现分组层)**
   - **定义**：用户在前端创建的逻辑分组（例如“音乐/播客”、“Timeline”）。
   - **关系**：一个 Channel 包含一个 `stream_ids` 列表，它本身不负责数据拉取，仅作展示层聚合。
   - **消费模式**：`present` 字段是官方 Present 注册表（`timeline|search|audio|video|research|tasks|embed`）的 id，决定这个
     Channel 怎么取数、怎么渲染、挂哪些能力（`GET /api/presents` 列出注册表）；`kind` 是它的只读兼容
     别名。`options.slots` 可选地把某个 Provider Callsite 的路由**只在这个 Channel 内**改指到别的
     Provider 行（详见下节「Provider callsite bindings」）。
   - **注意**：resolve 模型里的 `targetType`（`/api/resolve/*`）指“解析目标类型”，与 Channel 无关。

2. **Stream (流 / 订阅流 - 采集管道层)**
   - **定义**：一个具体的数据采集管道/订阅实例（例如：“网易云歌单 60168357”）。
   - **关系**：在 API 中作为 Channel 下属的 `streams` 数组返回。

3. **Source (数据源入口)**
   - **定义**：manifest 声明的一个具体可调用入口，归属于唯一的 Plugin，只作为 Stream / Provider 的成员被绑定，不直接订阅。
   - **关系**：一个 Stream 聚合 ≥1 个 Source；`strategy: exclusive` 时按优先级只取第一个健康响应的（容灾即此机制）。

4. **Provider (全局无状态能力)**
   - **定义**：仅指按需调用的无状态能力（搜索、音频下载等）——入参在调用时提供，内部对成员 Source 互斥择优。见下节规范。
   - **注意**：「适配引擎」（rsshub/bilibili adapter）不是 Provider——那是 **Plugin** 的 adapter，别用 Provider 一词称呼它。

> 权威定义、不变量与数据流见 **[ARCHITECTURE.md](ARCHITECTURE.md)**。

## Stateless Service Provider Standards & CRUD API (无状态能力提供方规范与 CRUD 接口)

> 本节规范即 [ARCHITECTURE.md](ARCHITECTURE.md) 中 **Provider** 概念的接口与数据模型标准。

### 1. Provider 数据模型 (Data Model)
在系统中，每一个 Provider 对应配置库中的一个完整行记录 (full config row)：
* `id`: 唯一标识符。
* `label`: 人类可读名称。
* `description`: 描述信息。
* `category`: 能力分类，可选值为 `search | resolve | download | transform | transcribe | llm`。
* `serves`: 路由键数组 (array of matching keys)，支持 `'*'` 通配符作为 fallback 兜底。
* `strategy`: 调度策略，可选值为 `sequential | concurrent`。
* `members`: 成员能力定义数组，可包含以下类型元素：
  - `{ fn: string }`
  - `{ source: string, name?: string }` — `name` 是可选实例名，同一个 `source` 可在一行里出现多次
    （各带不同 `params`），寻址键、排序、`options.exclude`、调用账本都按 `name ?? source` 取
    （LLM 多实例即此机制，见下节）。`name` 撞上任何已注册 source id → 写入 `422
    name_shadows_source`（自己的 `source` 不算撞）。
  - `{ mode: 'auto', provides: string[] }`
* `contract`: 接口契约声明。
* `options.exclude`: 排除策略或节点列表。

### 2. CRUD 接口端点 (Endpoints)
* **GET `/api/providers` (List)**
  - 返回所有配置的 Providers 列表 `{ items: Provider[] }`。
  - `items` 中包含 `status: 'planned'` 的占位/计划声明条目，以及每行解析后的 `resolvedMembers`、统计的 `calls` 与 `callSites` 调用点。
  - `defaultSource`（可选）= 这一行的**默认来源**，完整的 Source 投影（与 `resolvedMembers[].source` 同一份 `publicSource`，带 `pluginId` 所以客户端能直接取 detail）。给「添加成员」用：在场就直接开这个源的配置面，缺席才让人去源目录里挑。声明在 `src/providers/seed.ts` 的 `PROVIDER_DEFAULT_SOURCE`（`llm` → `llm-openai`、`parse` → `ocr-vlm`），本机没装那个源时字段缺席。
* **GET `/api/providers?variant=transform&key=example.com` (Match Preview)**
  - 预览指定 `variant` 与匹配 `key` 的 Provider 匹配结果。
* **GET `/api/providers/:id` (Detail)**
  - 获取单个 Provider 的详细配置和状态。
* **POST `/api/providers` (Create)**
  - 创建新的 Provider 行。成功返回 `201 Created`；已存在返回 `409 Conflict`；校验失败返回 `400 Bad Request`。
* **PATCH `/api/providers/:id` (Update)**
  - 部分更新 (partial update) 指定 ID 的 Provider 行配置。
* **DELETE `/api/providers/:id` (Delete)**
  - 删除指定 ID 的 Provider。成功返回 `{ ok: true }`。

### 3. 分发调度模型 (Dispatch Model)
* **调用点一句话总结**：`调用点 = variant + 键提取 + invoke`，分发靠 `serves` 声明匹配。

## Conversions（转换：转成文字 / 补说话人 / 抽帧取画面文字 / 摘要）

**一个 conversion = 把一个 item 派生出一份新产物。** 五个 `kind`：`extract`（转成文字）、
`identify`（补说话人）、`frames`（抽帧取画面文字）、`summary`（摘要）、`audio-fp`（声学指纹），
共用一张表、一套生命周期、一套计时。`extract` 落定后按规则表自动往上长（`src/conversions/derive.ts`）：带时间轴
（= 走了转写分支）就派 `identify`；再是视频就派 `frames`。**上层塌了不会带走底座**——那是把
它们做成独立 conversion 而不是 extract 内部步骤的全部原因。
`audio-fp` 这一档产出的是**归堆判「同一份录音」用的声学指纹（chromaprint）**，不是给人读的
正文：它不进 `extract` 的分支表、没有前端触发入口，唯一的触发者是收件箱归堆的后台 worker
（`src/story-fold/`）。它的 `available` 由启动时的引擎探测决定（ffmpeg 的 chromaprint muxer →
`fpcalc`，两个都没有就整档关闭）。设计见
`2026-08-23-audio-fingerprint-fold-design.md`。
`summary` 这一档**今天没有前端触发者**——交互路径上的摘要由对话在同一轮直接给出，不落
conversion；这个 kind 仍受理 API/MCP 的直接调用（唯一的生产触发点是一次性迁移
`src/conversions/migrate.ts`），保留是因为后端能力和 MCP 消费方还在。
`extract` 内部按 `content.archetype` 分三条分支（`stt` 转写 / `ocr` 图片与 PDF / `article`
网页正文）+ 一档 `inline` 直取——**判分支归后端**（`shared/extract/plan.ts`，前端按钮显隐用的
是同一份代码），调用方只声明「我要这条内容的正文」，不需要先自己判断这是图还是视频还是网页。
设计见 `internal design record`（kind 收敛）与
`internal design record`（资源化）。

* **GET `/api/conversion-kinds`** — 能力发现：`{ items: [{ kind, label, stages, available, options, branches? }] }`。
  `available` = 该 kind 的后端此刻配没配。**前端据此决定按钮显不显示，不要再用「POST 一次看是不是
  503」去试探。** `branches` 只有 `extract` 有：`{ stt, ocr, article }` 各分支配没配——
  它是前端 `planExtract` 的 caps 输入（`inline` 不打后端，故不在列）。
* **POST `/api/conversions`** — body `{ kind, item, media?, snapshot?, options?, input?, force? }`。
  `item` 是 source handle（收件箱 item id，或 `tmdb:<id>[:SxxExx]` 这类没有 item 的网盘绑定分集）。
  `input` 仅派生类 kind 用，指向**上游那条 conversion**（摘要的输入是转写结果，不是原始媒体）。
  - 该 `(item, kind)` 已有非 error 记录且未带 `force` → **`200`** + 既有资源（命中缓存，绝不重复计费）
  - 新建 → **`201`** + `Location: /api/conversions/:id`
  - kind 未注册（后端没配）→ `503 unavailable`；kind 不认识 / 缺 item → `400 validation_error`；
    handle 查无 → `404`。三者都在**建记录之前**判掉，不留半条垃圾记录。
* **GET `/api/conversions`** — `?item=` `?kind=` `?status=` `?limit=`（默认 50，上限 200）`?cursor=`
  `?expand=result`。回 `{ items, nextCursor? }`。
  - **默认不带 `result`**：一集两小时播客的 `segments` 是数千条对象，列表页只需要状态和标题。
  - 游标锚在 **id**（按创建序单调）上，不是 `updated_at`——老行被 touch 一下就会跳进调用方已经读过
    的页里，漏条目。
* **GET `/api/conversions/:id`** — 单条（带 `result`）；未知 `404`。
* **DELETE `/api/conversions/:id`** — 取消并删除（在跑的中止、排队的出队、历史的直接删）。语义是
  「消灭这个意图和它的产物」，所以不另设 cancel 端点。未知 `404`。

**响应信封**（所有 kind 同形，`result` 按 kind 判别）：

```jsonc
{ "id": "cv_…", "kind": "extract", "item": "tmdb:123:S01E02", "status": "done",
  "queuePos": 3,                         // 仅 queued
  "snapshot": { "title": "…", "source": "…", "url": "…", "poster": "…" },
  "createdAt": "…", "startedAt": "…", "finishedAt": "…", "updatedAt": "…",
  "timing": { "totalMs": 184200,
              "stages": [{ "name": "stt:media", "ms": 12400 },
                         { "name": "stt:asr", "ms": 96800 },
                         { "name": "stt:diarize", "ms": 75000 }] },
  "ladder": { "via": "zhipu",              // 走梯子的 kind 才有；老记录没有
              "rungs": [{ "member": "zhipu", "source": "ocr-vlm", "ms": 4701, "outcome": "win" },
                        { "member": "ocr-mineru", "source": "ocr-mineru", "ms": 3,
                          "outcome": "miss", "reason": "MinerU 插件未开" }] },
  "error": { "code": "…", "message": "…" },  // 仅 error，与全局错误体同形
  "result": { "text": "…", "format": "plain", "branch": "stt",
              "detail": { "lang": "zh", "segments": [], "media": [] } } }
```

- **`extract` 的 `result` 合同**：`text`（正文）+ `format`（`markdown | plain`）+ `branch`
  （这份正文出自哪条分支）是公共部分——谁都能产出的只有它们；分支特产进 `detail`
  （`segments`/`lang`/`media` 只有转写拿得出，声纹归名、播放器同步、「只看某人」都靠
  `detail.segments`）。**不砍也不提层**：提到顶层会让 OCR 结果凭空多出恒空字段。
  `identify` → `{ segments, probe }`；`summary` → `{summary}`。`probe` 是 diarization 探测读数
  （`{ speakerCount, spokenSeconds, clusters: [{label, seconds}] }`）——**今天没有任何代码消费
  它**，是留给人和后续「转成文字递推」计划读的（`internal design record`
  §8 定阈值要用），`GET /api/conversions/:id` 是它唯一的另一端。`spokenSeconds` 是总数求和后
  只舍入一次的账，`clusters[].seconds` 是各簇分项各自舍入的展示近似——两者故意不相等，别指望
  `sum(clusters.seconds) === spokenSeconds`。
- **`frames` 的 `result` 合同**：`{ track, probe }`。`track` 是帧文字轨
  （`[{ at, text }]`，`at` 是秒），只留**转写拿不到的那部分**（幻灯片要点、代码、图表数字）——
  它**不混进正文**：转写是「谁说了什么」，帧文字是「屏幕上写着什么」。单帧 OCR 跑塌了会在轨里
  留一条 `[未识别：<原因>]`，不静静跳过（缺省信息正是这层要消灭的东西）。

  **`track: []` 不等于「没跑」。** 这一层是一道逐级止损的梯子，**每一级「判为不抽」都是
  `status: "done"` + 空 `track`**——判成 `error` 会让通知中心报错、让用户以为坏了，而它恰恰是在
  正常工作。走到哪一级停的、每一级付了什么钱，只在 `probe` 里：

  | `probe.stop` | 含义 | 付了什么 |
  |---|---|---|
  | `gate` | 闸门判纯口播（语速密度高、没有指示代词），信息全在嘴里 | 零 |
  | `no_source` | 取不到可抽帧的视频地址（没 video media / 网盘没配到 / 抖音容器没醒） | 零字节 |
  | `still_picture` | 稀疏 8 帧两两哈希距离的最大值低于门槛 → 固定机位，画面不动 | 8 次 range 请求 |
  | `no_new_text` | 探帧里挑 2–3 张 OCR，一个转写没有的字都没抽到 | + 3 次 OCR |
  | `done` | 全扫 → 逐帧 OCR → 逐帧判增量，正常跑完 | 全片一遍 |

  真失败只有三种，落 `status: "error"` 的 `error.code`：`source_failed`（取视频地址这一步的
  网盘/抖音容器/B 站签名炸了）、`sample_failed` / `plan_failed`（ffmpeg/ffprobe 自己炸了）。
  **它们绝不会被写成 `no_source` / `no_new_text`**——否则一次真的取址/取样失败在账上会跟
  「这条 item 就是没有可抽帧的东西」「探过没料」长得一模一样。

  `probe` 的其余读数：`gate`（闸门判词与依据）、`sampled`（稀疏取了几帧）、`maxDistance`
  （「画面动没动」的读数本身）、`ocrTried` / `ocrFailed` / `ocrEmpty`（送出去几次 OCR、其中抛错
  几次、跑成功但图上没字几次——**后两者指向相反的排查方向，别合并**）、`planned`（全扫去重后的
  候选帧数）、`truncated`（超上限被截掉几张，`> 0` 必须看得见，不许静默截断）、`framesKept`
  （最终抽到新字的帧数）。**「没跑」和「跑了没料」的分界线是 `ocrTried`。**
  这份账**今天没有任何代码消费**，`GET /api/conversions/:id`（或 `?kind=frames&expand=result`）是
  它唯一的另一端——阈值（帧数上限、探 OCR 张数、静止门槛）都还没量过，量它们只能靠这份账，
  所以文档不写就等于埋了。
- **`timing` 是信封字段，不是某个 kind 的私产**：阶段名由 kind 声明（`extract` 带分支前缀：
  `ocr:fetch|ocr:ocr`、`stt:media|stt:asr|stt:diarize`、`article:fetch`；`identify`: media|diarize，
  `frames`: source|sample|probe-ocr|plan|ocr，`summary`: summarize），打点在共享 runner 的阶段边界上，所以每个 kind 免费拥有。
  **未发生的阶段不出现在数组里**，不是 `ms: 0`——「没跑」和「跑了 0ms」必须可区分。
  失败的转换同样带 timing（慢失败才是要查的那种）。
- **`ladder` 也是信封字段**（同 `timing`，列表里也带）：这一次是 Provider 梯子上的谁干的。
  `via` = 赢家的**寻址键**，`rungs[].member`/`source` 两个都给——键常是用户起的实例名
  （`zhipu`），单看它答不出背后是哪个 source；单看 source 又分不清同一个源的两个实例。
  `outcome` 三态**必须分开消费**：`win`（它出的结果）/ `miss`（它弃权，没配或不适用）/
  `error`（它试了但失败）——miss 的下一步是去配置，error 的下一步是去查故障，方向相反，
  合并成「没成功」就等于把最费时间的那类误诊固化进 API。失败的转换同样带 `ladder`，而且那正是
  最该看它的时候。**带这个字段的 kind 只有 `extract`/`summary`**；`identify` 直连声纹后端，没有
  梯子。`frames` 逐帧认字走的是与 `extract` 的 ocr 分支同一条 `parse` 行，但一条转换要跑几十次
  OCR、走法各不相同，一个 `via` 说不清是谁干的——它的读数在 `result.probe` 的
  `ocrTried`/`ocrFailed`/`ocrEmpty` 里。**老记录没有这个字段**，消费方据此什么都不显示——补一个空走法等于声称"梯子上没人跑过"。

> **这一族是转换的唯一入口**，前端、MCP、声纹路由全部经它——**没有** `/api/parses`、
> `/api/transcripts`、`POST /api/transcripts/:itemId/summary` 这些端点，别去接它们。
> 也**没有 `{status:'none'}` 这种伪状态**——「还没转过」就是空列表。

**MCP 侧**：触发用 `extract(item)`——一个工具，不分转写/OCR/网页（模型和用户一样只关心
「把正文给我」，怎么取归后端判）；读取统一走 `get_conversions(item?, kind?, limit?, expand?)`
——不带 `item` 是轻量索引，带 `item` 返回该 item 的正文。

## 手动重新抓取（Refresh）

采集平时由调度器按 cadence 跑；这两个端点是「现在就抓一次」的手动入口，跑的是**真实持久化 tick**
（与 preview 不同——preview 从不落库）。

* **POST `/api/streams/:id/refresh`** — 单个流。`{ fetched, written }`；未知流 `404`。
* **POST `/api/channels/:id/refresh`** — 该频道的**全部成员流**，扇出跑。未知频道 `404`；
  未接 channelStore `503`。返回逐流账 + 合计：

```jsonc
{ "streams": [ { "streamId": "s1", "fetched": 12, "written": 3 },
               { "streamId": "s2", "error": "facility 未登录" } ],   // 失败的那条只有 error
  "fetched": 12, "written": 3, "failed": 1 }
```

- **部分失败仍是 `200`**。某个 facility 掉登录态、某个源超时是这条链路的常态；把整次请求判失败，
  会让另外几条成功的抓取在 UI 上一起消失。失败逐条记在 `streams[].error`，`failed` 给总数，
  由调用方决定怎么讲（前端说的是「抓取 N 条，新增 M 条（T 个源里 K 个没抓成）」）。
- **并发有上限**（`src/channels/refresh.ts`，默认 3）。采集是重活，有的流还骑着那个唯一的真浏览器——
  一个频道七八个流一起冲会把内存和浏览器打穿。`streams` 按**成员顺序**返回，不是完成顺序。
- 扇出为什么在服务端而不是让前端连发 N 个请求：并发上限、部分失败语义、结果汇总是一件事，
  放前端等于每个调用方各写一遍，而且第一版一定写成无上限的 `Promise.all`。

## Items 出线形状里的投影格

条目的四条读口（`GET /api/items`、`GET /api/channels/:id/items`、`GET /api/search?scope=content`、WS `item`
广播）全经一个出口 `toClientItem`（`src/http/client-item.ts`），它在那里**现算**附上四格（不入库，存量立刻生效）：

| 格 | 形状 | 谁定 |
|---|---|---|
| `author_enrich` | `{ source, params }`——前端拿它调 `/api/enrich?source=<source>&<params…>`，回 `{ name?, face?, url? }` | 包的 `stream.item.authorEnrich`；只在条目无 `author_avatar` 且有 `author` 时出 |
| `actions` | `[{ id, icon, label, recipe, params, toggle }]`——点一下走 `POST /api/recipes/action`，`sourceId = recipe`、参数 = `params` + `action: toggle[按下前 ? 1 : 0]` | 包的 `stream.item.actions`；参数占位符取不到的那条不出 |
| `source_label` | 源目录里那条源的标题（前面带站名） | 源目录 |
| `source_site` | `{ name, domain }` | 认领这条源的包的 `stream.homepage` |

源目录的出口 `publicSource`（`src/registry/public.ts`）同样多一格 `site: { name, domain }`，规则同 `source_site`。
契约见 `docs/PACKAGE.md` §0.5 的 `item` 一行。

## Items 维护

* **POST `/api/items/renormalize`** — body `{ streamId? } | { sourceId? } | {}`（互斥，全不带 = 全库）。拿存量 item 的 `raw` 用**当前** manifest 重跑 normalize，只覆盖 `content`（id/seq/muted 等不动）。`400` 两键同现、body 不是合法 JSON、body 不是对象、或 `streamId`/`sourceId` 类型不是 string；`404` scope 查无；`200` `{ scanned, updated, skipped: { noSourceId, manifestGone, parseError } }`。幂等：重算结果与现存 content 相同的行不写。

## Netdisk plugin access

`GET /api/netdisk/openlist-access` → `{ url, token }`：Stream 这份 OpenList 的网关路径（`<origin>/_p/alist`）
与永久 token。给装在用户 DSH 里的 `@streamapp/netdisk` 走 external 档用。alist 包不在场或
token 未铸出 → 404 `unavailable`。走 `/api/*` 同一道门。

## 网盘：上传文件、给目录建分享（外部导出脚本用）

消费方是本机上的导出脚本（每周把数据包传进夸克盘的固定目录，首发时给目录建一条分享链接）；它只调
这两条，不碰任何登录态。都在 AList 那道门后（网盘未装配 → 503）。

* **POST `/api/netdisk/fs/put`** — `multipart/form-data`：`path`（OpenList 绝对文件路径，如
  `/quark/闲鱼数据包/<pack>/<file>`）+ `file`（字节）。→ `200 { ok: true, size }`。同名覆盖；父目录不存在
  先建（逐级）。文件边收边落临时文件再流式 PUT 给 OpenList，不整份进内存；字段顺序无所谓。
  `400`：不是 multipart / 缺 path 或 file / path 不是绝对文件路径 / 认不出的字段（与 JSON 端点同一道闸）；
  `502 upstream_error`：OpenList 拒了（storage 不存在、cookie 失效……，message 原话）。
* **POST `/api/netdisk/share/create`** — body `{ path, passcode?, expireDays? }`：`path` 是 OpenList 目录路径
  （第一段是挂载点，按挂载表认 driver，目前只有夸克）；`passcode` 4 位字母数字，缺省 = 公开分享；
  `expireDays` 只认 0/1/7/30（夸克网页版的四档），缺省 0 = 永久。→ `200 { url, passcode?, pwdId }`。
  `400` 参数；`404 not_found` 夸克盘上没这个目录（不代建——分享的对象是已经传好的包）；
  `501 unsupported` 挂载点不是夸克；`503 unavailable` 没有夸克登录态或未装配；`502 upstream_error`
  夸克拒了（message 带停在哪一步）。**替换目录里的文件不影响已建的分享链接**（活体 2026-09-07：
  覆盖上传同名文件后同一条链接仍 alive、列出的是新内容）——所以「链接不变的周更」成立。
* **GET `/api/netdisk/share/list`** — 当前账号建出去的分享，一页。query `page`（1 起，缺省 1）、
  `size`（1..100，缺省 50），两个都必须是整数（`page=1x` 是 `400`，不会被当成第 1 页）。
  → `200 { items, page, size, total }`；`page * size < total` 就还有下一页——**只读第一页会静默漏掉
  后面所有链接**。每行：

  | 字段 | 说明 |
  |---|---|
  | `shareId` | 删除按它寻址（`share/delete` 只认这个） |
  | `pwdId` / `url` | 链接尾巴与整条链接。手里只有一条 URL 时，靠 `pwdId` 在这里对上是哪一行 |
  | `title` / `pathInfo?` | 标题、内容在盘上的位置（夸克的 `path_info`，可能是 `../父目录` 这种相对写法） |
  | `passcode?` | 提取码，公开分享没有 |
  | `expireDays?` | 0 永久 / 1 / 7 / 30。夸克回了不认识的档位 → 留空（不猜一个天数） |
  | `createdAt` / `expiredAt?` | ISO 时间。**永久分享不带 `expiredAt`**——夸克给的 2100-01-01 是占位 |
  | `state` | `active` / `expired`（自己设的期限到了）/ `invalid`（夸克把它下掉了）。两种「死」分开报 |
  | `fileNum` / `size` | 文件数、总字节 |
  | `auditStatus` | 夸克的审核态**原样带出**，不翻译（活体只见过 4 和 2，判据不明） |

  `503 unavailable` 没有夸克登录态或未装配；`502 upstream_error` 夸克拒了（**不回空列表**——空列表
  等于告诉用户「你没有分享」）。
* **POST `/api/netdisk/share/delete`** — body `{ shareIds: string[] }`（1..100 条，取自 `share/list` 的
  `shareId`）。→ `200 { results: [{ shareId, ok, message? }], deleted, failed }`。**逐条发、逐条回判**：
  一条失败其余照删，所以 `failed > 0` 时仍是 `200`——判据在 body 里，不在状态码上。整批做不成的事才非 200：
  `400` 参数、`503 unavailable` 没有夸克登录态或未装配。

  **删的是链接，不是文件**：分享删掉后目录仍在盘上（夸克文件按 `fid` 寻址，这个端点只吃 `share_id`）。
  **不可逆，夸克没有分享回收站**——删完那条链接立刻回 `41012「好友已取消了分享」`（活体 2026-09-07：
  建一条一次性分享自己删掉验的）。要恢复只能重建一条新链接，链接地址会变。

  为什么不用夸克天然的批量（端点确实吃 `share_ids` 数组）：同一次实测里数组混一个不存在的 id，
  整个请求回 `500 / code 15000`，且说不出是哪一条挂了。逐条发的代价是 N 条 = N 次上游请求。

## Packages（这台机器上装了什么）

扩展 Stream 的单位只有一种：**Stream 包**（槽位契约见 [PACKAGE.md](PACKAGE.md)）。这一节是它的
**目录读模型**。

* **GET `/api/packages`** — 内置层（仓库自带 `packages/`）+ 用户层（`<dataDir>/recipes/`，npm 装的）
  的**全部**包。`200 { packages: PackageSummary[] }`；后端没接 `packageInventory` → `503`
  （**不是空数组**——空数组等于告诉用户"你什么都没装"）。

  | 字段 | 说明 |
  |---|---|
  | `id` | canonical 包身份（`stream.id ?? stream.facility`） |
  | `name` | 显示名，缺省回落 `id`（前端不该拿到空标题） |
  | `description?` | `stream.tagline ?? stream.description` |
  | `layer` | `builtin` \| `user` |
  | `pkgName?` / `version?` | npm 包名与版本（卸载靠 `pkgName` 认包，不靠目录名） |
  | `slots.sources?` | Source 清单条数 |
  | `slots.recipes?` | `*.recipe.json` 份数 |
  | `slots.recipeNames?` | 那几份各叫什么（文件名去 `.recipe.json`，已排序）。只给份数说不出「装进来的是什么」 |
  | `slots.code?` / `slots.backend?` | `true`（有 `stream.code` / `stream.backend`） |
  | `slots.credentials?` | 申报的 cookie 域（非空才有） |
  | `hosted` | `slots.backend \|\| slots.credentials?.length` —— 见下 |
  | `role?` | 包在宿主里扮演的角色，今天只有 `'netdisk-base'`（宿主的网盘底座，判据是 `src/netdisk/base-package.ts` 的 `NETDISK_BASE_PACKAGE_ID`）。前端按它决定给不给「网盘挂载 + 绑定」配置面板——**前端不按包 id 分支**。没有角色的包不带这一格 |
  | `enabled?` | 启用开关现值，**只有填了插件槽位的包才有**（纯 recipe 包没有可翻的开关，给一个恒 true 的字段等于让前端画一个点不动的开关） |
  | `runtime?` | `{ state: 'running'\|'idle'\|'error'\|'unknown', image, lastUsed? }`，**只有带容器的包才有** |
  | `pending?` | 这个包装了 / 换版了但**还没生效**的那一条（`PendingChange`，见下面 `/api/packages/pending`），按 `pkgName` 对上行；只有用户层会有 |

  **没填的槽位不出现在对象里。** `recipes: 0` 与"没有 recipe 槽"是一回事，但前者会让前端画出一个
  `recipe×0` 的空标记。

  `hosted` 是**「这个包会不会在运行时坏」**（有容器 / 要登录态），判据的唯一实现是具名函数
  `isHostedPackage`（`src/packages/inventory.ts`），数字由 `inventory.real.test.ts` 钉着。
  **它不是 `fillsPluginSlot`**：那条问的是"宿主要不要替这个包做点什么"，还包含只提供 Source 清单 /
  normalizer 的 `rsshub` / `builtin` / `browser` / `replay`——那四个不会坏。两条判据回答两个不同的
  问题，别合并。

  `runtime.state` 是 `pluginStatus`（即 `/api/plugins` 用的那份带缓存的聚合）的**纯函数投影**，
  **不新起探活**：standby 管的服务读快照即可（它下次被用到会自愈），多一套探活 = 多一份会和
  `/api/plugins` 说法不一致的真相。

  **「有新版」不在这里**：查更新要打 npm registry（网络、会超时），塞进来会让首屏被 registry 抖动
  拖住。调 `GET /api/recipes/packages/updates`，按 `pkgName` 对上行。

  **错误原因也不在这里。** `runtime.state === 'error'` 只说"起不来"，不带理由——`PluginStatus`
  根本没有错误文本字段，硬凑一个就得新起一套探活（上一条）。理由在下面那条日志端点里。

* **GET `/api/packages/pending`** — 待生效清单：**启动那一刻装载的用户层**（冻住的快照）vs
  **盘上现在的**（每次请求现扫，不记账本——账本会漂，两份事实随时可重算）。
  `200 { pending: PendingChange[] }`，每条 `{ name, kind: 'installed'|'updated'|'removed', from?, to?,
  needsRestart, why }`。判据只看槽位：recipe 数据热生效（`needsRestart:false`），代码 / 能力 / 容器
  走启动路径，变了就要重启；凭证域不单独算（它是给代码 / 容器用的许可名单，那三格已经判过了），装 /
  换 / 卸三条路同一把尺。`removed` 的包在 `/api/packages` 里已经没有行，只有这里能看到。
  后端没接 `packagePending` → `503`。同一份计数也进 `/api/health.pending_restart`
  （`needsRestart` 为 true 的条数；没接就没有这一格；那一口吞异常，清单炸了只掉这一格）。

* **POST `/api/restart`** — 重启整个后端进程（**不是热重载**：优雅关掉再重新起，代码包 / 能力包 /
  容器 / 凭证域申报全部按正常启动路径重来），是「装了 → 生效」这条闭环的最后一步，配 `GET /api/packages/pending`
  一起用。优雅关复用 `serve.ts` 的 `shutdownThen`（停任务中心 → standby → 内核 effect 反序 → 释放锁），
  收尾按「谁拉起我」分档（`src/restart/policy.ts` 的 `classifyLauncher`）：

  | `mode` | 判据 | 收尾 |
  |---|---|---|
  | `supervised` | env `INVOCATION_ID`（systemd 注入）或 `STREAM_SUPERVISED=1`（`stream mcp` 壳与其他 supervisor 传） | 以 `RESTART_EXIT_CODE`（75）退出，监护者拉起（`stream mcp` 只认这一个退出码，别的退出码不拉起——那是崩溃而不是受控重启） |
  | `reexec` | 两者都不在 = 用户前台跑的 | 自己 `spawn` 同一份进程（同 execArgv、同参数）、`unref`，然后退出 |
  | `watch` | 只能显式指定（`scripts/dev.sh` 这么设） | **不自己关**：碰一下仓库根的 `restart-sentinel`，`tsx watch` 据此 SIGTERM + 拉起。监视器不看退出码，自己退了它就干等下一次改文件 |

  **显式 `STREAM_RESTART_MODE=supervised|reexec|watch` 压过自动判**（值不认识就当没设）。为什么要有它：
  `INVOCATION_ID` 会被 systemd 用户服务拉起的 scope / 终端**继承**——在这种终端里前台跑 `stream`，或
  `systemd-run --user --scope` 里跑 `pnpm dev`，都会被误判成 `supervised`，退 75 之后没人拉起。那样的终端里
  前台跑要 `export STREAM_RESTART_MODE=reexec`；dev.sh 自己已经 export 了 `watch`。
  闸门只看任务中心有没有**正在跑**的任务（`sidequest_jobs` 里 `state='running'`）：有 → `409
  { error: { code: 'conflict', message }, running: [{ id, label }] }`，不动；带 `?force=1` 才越过——
  8900 上跑着真金白银的定时任务，包更新不是打断它的理由。
  没接 `deps.restart` → `503`；开机窗口（HTTP 已在听、优雅关还没装好）收到请求 → `500`（进程不崩，
  过几秒重试即可）。
  过了闸门就是 `202 { mode: 'supervised' | 'reexec' | 'watch' }`，**先回 202 再关**：同步开始关会把 HTTP
  server 一起带走，响应就永远发不出去。调用方按 `/api/health.started_at` 变化判断「活回来了」——
  与 CONTRIBUTING.md「活体跑的是哪一份代码」同一判据，不新起一套。

* **GET `/api/packages/:id/logs?tail=N`** — 这个包的容器最后 N 行输出（stdout+stderr 合流，带
  RFC3339 时间戳，已剥掉 docker 的 8 字节帧头）。`tail` 夹在 `[1,1000]`，缺省 **200**；解析不出
  数字**回落 200 而不是 0**（`tail=0` 在 docker 那边是"一行都不要"，表现是面板空着、看起来像
  "这个容器没有日志"）。`200 { lines: string[], truncated }`（`truncated` = 行数顶到了 tail，上面
  还有）。`404` 这个包没有容器 / 容器从没建起来；`503` 够不着 docker 或没接 `containerOps`。
  **两种失败必须分开看**：前者是"去建它"，后者是"不是这个包的问题"。

* **POST `/api/packages/:id/restart`** — 重启这个包的容器。复用 `provisionBackend`（start / 按镜像
  重建 / 等健康），**不新写一套容器生命周期**。容器在跑时先 stop 再走 provision——否则 provision
  看见 running 判 no-op，"重启"什么都没做而接口回了成功。
  `200 { state: 'running' | 'error', error? }`。**容器起不来是 200 + `state:'error'`，不是 5xx**：
  请求本身成功了（我们确实试过了），失败的是那个容器；用 5xx 表达它，调用方就分不清"没连上后端"
  和"容器没起来"，而那是两种完全不同的处置。
  `404` 这个包没有容器槽；`409` 容器不存在**且** `manage_containers` 关着（message 里给出
  `docker compose up -d` 那条出路）；`503` 够不着 docker / 后端够不着容器网络。
  **`manage_containers` 关着不挡重启一个已存在的容器**：那个开关管的是"要不要替你建"，拿它挡住
  等于把一个崩溃回环的容器锁死，而重启正是用户唯一的自助动作。

  **与另外两个投影的关系**（三者交集只有 `id`，按本文第 1 条这不是冗余端点而是三个不同的资源问题）：
  `GET /api/plugins` 是**插件目录 + 它带的 Source**（被 `fillsPluginSlot` 过滤，纯 recipe 包不在）；
  `GET /api/recipes/packages` 是 **npm 管理面**（只扫用户层，装/卸/查更新靠它）；这一条是
  **「装了什么」**，不带 Source 清单、不带装卸操作。设计见
  `internal design record`。

## AI 介入：介入 run 与提议审核（Interventions）

recipe 认不出当前界面时后端自己开一个**介入 run**，问一次用户配的模型，答案过区分度闸后落成一条**待审提议**；
**提议不自动生效，人接受了才写进状态图**（spec `internal design record` §4 / §6 / §9）。
这组端点就是那个「人来看、人来点」的面，运维页「源健康」与频道配置吃它。存储在 `<dataDir>/interventions.db`（一域一库，
与 `agent-runs.db` 分开——那张表的停止原因是一格字符串枚举，含义与这边的两格相反）。

- `GET /api/interventions?source=&status=a,b&limit=` → `{ runs: RunRecord[], pending }`。`pending` 是**全局**待审提议数，
  不跟 `source` / `status` 过滤走（徽标不该因为开着一个过滤就显示 0）。
- `GET /api/interventions/:id` → `{ run, proposals }`；`GET /api/interventions/:id/events?since=<seq>` → `{ events }`，
  `seq` 单调、只追加，前端按 `since` 轮询。
- `POST /api/interventions/proposals/:pid/accept` body `{ stateId? }` → `{ proposal, learned?, applied }`。
  `state` 类写进**学到的那一层**状态图（`<dataDir>/state-graphs/<facility>.json`），`stateId` 必须是 `<facility>/<状态>`
  形状（400 `bad-state-id`），与包自带 `states.json` 撞 id 回 409 `clashes-with-authored`；`discriminator` 类把区分特征追加到
  学到那层的某个状态，body 必带 `stateId`（400 `need-state-id`），指向包自带的状态回 409 `cannot-edit-authored`；
  `transition` / `locator` 只改状态、`applied:false` 如实说；`recipe` 类把候选体写回包目录（见下）；`graph` 类把整份探索草稿并进学到的层（见下）。
  非 pending 再 accept / reject 回 409 `not-pending`。
- `POST /api/interventions/proposals/:pid/reject` → `{ proposal }`，同时把它背后那条答案缓存标成 `rejected-by-user`，
  同指纹下次命中缓存按「没有产出」处理、不再落提议。
- **agent 档（修复会话）**：源进隔离且设置里配了 `ai-agent`（`PUT /api/config/ai-agent` body `{ command, maxTurns?, maxTokens?, maxWallMinutes? }`）
  → 后端开一条 `kind:'repair'` 的 run，经 ACP 驱动用户自己的 code agent。事件流里 `tool_call` / `tool_result` / `tool_failed`
  按 `callId` 配对；`permission_requested`（`data.auto:false` 的带 `permissionId` 与 `options`）等人答。
  - `POST /api/interventions/:id/permissions/:permId` body `{ optionId }` → `{ ok }`；run 不活 404，`permId` 不对 409 `no-such-permission`。
  - `POST /api/interventions/:id/continue` → `{ ok }`；只对 `paused` 有效，否则 409 `not-paused`。各抬一档：+6 轮 / +1,000,000 token / +20 分钟。
  - `POST /api/interventions/:id/cancel` → `{ ok }`；`session/cancel`，run 收成 `cancelled`。
  - `POST /api/interventions/:id/messages` body `{ text }` → `{ ok }`；进队列，当前 turn 结束后作为下一条 prompt。
  - `POST /api/interventions/:id/resume` → `{ ok }`；后端重启后 `paused` 且带 `agentSession` 的 run 用 `session/load` 续；活着的 409 `busy`。
  - agent 档没挂（介入域缺 `repairs`）→ 这五个端点 503 `agent-unavailable`。
- `POST /api/interventions/proposals/:pid/accept` 对 `kind:'recipe'`：候选体校验后原子写回 `recipePath` 本身（内置包 = 仓库 `packages/<id>/`，第三方 = `<dataDir>/recipes/<pkg>/`），
  回 `{ proposal, applied: true, path }`；写失败 409 `write-failed` 且提议仍 `pending`。写回不动隔离账：`shouldRun` 读到 version 升高自己放行。
- **探索建图（spec `2026-09-12-ai-intervention-phase3-explore-design.md` §8）**：让 agent 在一张浏览器标签页上逐个点开口子，探出这个 facility 的状态图。
  - `POST /api/interventions/explorations` body `{ facility, target, goal, limits?: { maxStates?, maxDepth? } }` → `201 { runId }`。
    `target` 只认 `chrome:<tabId>`（用 `cdp_pages` 拿），别的写法 400 `bad-target`——`facility:<name>` 是采集正骑着的那一页，探索去点它等于抢它。
    缺 `facility` / `target` / `goal` 400 `need-fields`，写错键名 400 `unknown-key`，不认识的 facility 400 `unknown-facility`；
    同一个 facility 已有一条探索在跑 409 `explore-busy`（**一 facility 一条**，不排队）；没配 `ai-agent` / 没接 agent 档 503 `agent-unavailable`。
    `limits` 只认 `maxStates` / `maxDepth`（别的子键 400 `unknown-key`），两个都必须是**正整数**，否则 400 `bad-limits`——
    `0` 会让探索一步不走却报成功，小数 / 负数一路变成永远比不过的阈值，两种都不报错、只是什么都没探出来。缺省取 `DEFAULT_EXPLORE_LIMITS`。
    **探索挂在 facility 上**，露面那一行记在这个包的第一个源上。
  - `POST /api/interventions/proposals/:pid/accept` 对 `kind:'graph'`：整份草稿并进学到的层，回 `{ proposal, applied: true, states, transitions }`。
    `effect:'noop'` 的边不落（点了什么都没变，不是一条路），`effect` / `via` 是探索期脚手架、写之前剥掉，图里只留 `{ from, to?, steps }`。
    **撞车 = 整份不写**：草稿里任一状态 id 与合成图（包自带 ∪ 已学到）撞、或前缀不是 `<facility>/`、或转移指向图外的状态 → 409 `learned-rejected`，一条都没写进去
    （学到的那一层没有删接口，写一半再回滚是另一次会失败的写，所以全部校验做完才开始写）。提议没带草稿 → 409 `no-draft`。
  - 那条探索的进度在源健康视图的 `exploration` 格里（见下）。
- 错误体一律 `{ error: { code, message } }`；不存在 404 `not-found`。
- **源健康（spec `2026-09-12-ai-intervention-ui-design.md` §7）**：三本账（健康 / 关禁 / 修复 run）合成**一个状态词**，后端算、前端译。
  - `GET /api/source-health` → `{ sources: SourceHealthView[] }`，**只含 `status !== 'ok'`**；`GET /api/source-health/:sourceId` → `SourceHealthView`（任意源，正常也给；不认识 404 `unknown-source`）。`sourceId` 可能是多段（如 `@streamapp/xhs/xhs-home`）：路由吃到行尾，裸写（`/api/source-health/@streamapp/xhs/xhs-home`）和整体 `encodeURIComponent` 后的写法都能命中。
    `status ∈ awaiting | exploring | repairing | proposed | unrepairable | quarantined | auth | dead | degraded | ok`，判据按序取第一个命中（spec §5）。
    `exploring` = 这个源上有一条 `kind:'explore'` 的 run 在跑；它**等人**那一档（`paused` / `awaiting_confirmation`）仍落在 `awaiting`，两条路是同一颗按钮。
    带 `affectedChannels`（经 `affectedSources` → stream 成员 → 频道反查）、`run`（活跃的优先，同为活跃时 `repair` 压过 `explore`；`pending` 是 seq 最小那条未答许可；`now` 是最新一条 tool_call/message）。
    `proposal` = **等人审的那一条**，`kind ∈ recipe | graph`（pending 优先、否则最近一条），前端据 `kind` 分流第 ④ 格：
    `recipe` 看 `diff`（步骤级，`step:0` = 顶层字段），`graph` 看 `graph: { states, transitions }`，且它的 `validation` 四格一律 `'n/a'`、`diff` 为空数组——
    那四格问的是「这份候选 recipe 过没过校验」，一张图没走那条路，补 `'ok'` 等于替一件没发生的事作证。有这样一条 pending 提议时状态词是 `proposed`（源健不健康都算）。
    `exploration?: { runId, status, states, transitions, remaining }` —— **只在探索还活着时给**，数字从那条 run 的草稿文件现读；探索收尾后这一格缺席（草稿是「正在探」的现场）。
  - `POST /api/interventions/repairs` body `{ sourceId, reason? }` → `201 { runId, failed? }`；已有活跃会话 409 `repair-busy`（带 `runId`）；
    没配 `ai-agent` / 没接 agent 档 503 `agent-unavailable`；不认识 404 `unknown-source`。**不要求源处在关禁态**；`reason` 缺省 = 关禁账 lastReason → 健康账 lastError → `manual`。
  - 形状真相源 `src/intervention/source-health-view.ts`；前端镜像 `app/src/lib/api.source-health.ts`。
- **形状真相源**：`src/intervention/types.ts`（`RunRecord` / `RunEvent` / `Proposal`），前端 `app/src/lib/api.interventions.ts`
  是它的镜像，字段名逐字对齐。

## Facility 与它的活页面 (Facility & its live page)

**Facility** = 一个站点的**独占登录会话**（例如 `xhs`）。一个 facility 同时最多只有一个真浏览器 tab，
recipe 串行地骑着它跑（不变量见 ARCHITECTURE.md）。这个 tab 是一等资源，所以按资源寻址——
虽然我们主要是为了调采集才去读它，但"debug"是**用途**，不是**名词**。

* **GET `/api/facilities/:id/page`** — 该 facility 当前那个 tab 的状态 `{ facility, url, title }`；无 tab → `404`。
* **GET `/api/facilities/:id/page/screenshot`** — `image/jpeg`，看一眼它现在长什么样。
* **POST `/api/facilities/:id/page/evaluations`** — body `{ expression }`，在**那个 tab 里**求值，返回 `{ value }`（`201`）。
  用 POST 而非 GET：每次调用都在**创建**一次求值，结果不可寻址、不可缓存。求值在页面内先 `JSON.stringify`
  再跨界（SPA 的响应式 store 是 Proxy，直接 returnByValue 会得到 `{}`）。

三者都排队在该 facility 的任务尾链之后，**不会和正在跑的 recipe 交错**。
存在的理由：另起一个浏览器去看会撕裂那唯一的登录会话，所以**唯一正确的观察位置就是这个 tab 自己**。

> TODO（冗余端点）：现有 `GET /api/auth/facilities`（授权墙投影）按本文第 1 条规范，最终应并入
> `GET /api/facilities`，一个 facility 一行，同时带 `auth` 与 `session` 两块状态。

## 视频播放：解析与字节代理（`/api/media/*`）

宿主不认识任何视频平台。三条路由按 `platform` 派发 `video.resolve` 调用点（键 `<platform>-video`），
`vid` 长什么样、怎么换成可播放的流，全归认领那个平台的包（`package.json#stream.providers[]` 带
`callsites: ['video.resolve']`，见 PACKAGE.md §0.5）。加一个平台 = 装一个包，路由零改动。

* **GET `/api/media/play?platform=&vid=[&dl=1&name=]`** — 要 `progressive`，带上游要的请求头代理字节（`<video>` 可 seek）；`dl=1` 转成下载（文件名 `name`，缺省 `vid`）。缺 `platform` / `vid` → `400 validation_error`；解析为空见下面「解析为空」两档。
* **GET `/api/media/dash?platform=&vid=`** — 同上要 `dash`，回 MPD（`application/dash+xml`）；每条流的 BaseURL 指向 `/api/media/seg`。解析器对 `dash` 如实回空的平台（只有整片、没有分轨的短视频站）走 502，播放器自己回落 progressive。
* play / dash 两条**解析为空**时分两档，判据是成员管道带出来的 miss（`src/http/app.ts` 的 `unresolvedResponse`）：
  - **内容本身没有** —— 某个成员抛了 `ContentUnavailableError`（作品被删 / 私密 / 站方明确说没这件；miss 带 `unavailable`）→ `404 { error: 'unavailable', detail }`，`detail` 是**站方原话**。这不是我们这边挂了，用户重试、报修都白搭，所以不给 502；成员管道对它也不记源的健康账（`src/providers/unavailable.ts` 头注）。
  - **其余** —— `502 { error: 'unresolved', detail? }`。`detail` = 第一条 miss 的 reason（成员 decline 是 `declined (no result)`，容器 / 上游炸了是它的原话，例如容器单视频接口的 `HTTP 403`）；一条 miss 都没有（没有行 serve 这个平台）就不带 `detail`。
* play / dash 两条共同的出口：没配 Provider → `503`；频道槽位填了但全坏 → `422 slot_broken`（见 §5.1）。
* **GET `/api/media/seg?u=&b=…&m=video|audio`** — 分片代理。主机必须是某个解析器刚登记过的（SSRF 闸门，`isAllowedSegHost`），请求头也从那份登记里取——路由自己不认识任何站点的 Referer / Cookie。主节点 `u` 不行依次试备节点 `b`（可重复）：TTFB 超时或 5xx 即切换，末节点给宽窗口 + 一次重试。
* 三条都吃 `channelId`（见「Presents & channel-level Provider slots」）。每次解析走了哪条行、谁 decline 了记进 DebugBox `video-resolve`——排查播放失败先看它。

## 包交出来的处理器：富化与一键订阅

* **GET `/api/enrich?source=<name>&…`** — 先查包交出来的 `enrichers`（`activate()` 返回、`stream.code.enrichers` 申报，PACKAGE.md §3.2）：`source` 命中即把**整袋 query** 透传给它，返回值原样 JSON；包抛 `ValidationError` → `400 validation_error`，其余异常 → `502 upstream_error`。没命中才落宿主自己的分支（`link` / `hackernews` / `v2ex` / `xueqiu`，`HOST_ENRICH_SOURCES`）。撞名在装载期就拒了，所以包顶不掉宿主的分支。**包的 enricher 还有第二个面**：`/ws` 上的 `enrich.open` 命令（下一节），前端打开一条带 `content.enrich` 的 item 走的是它；HTTP 面给 MCP / 脚本用，两面调的是同一个函数。
  视频评论走的就是这一口，名字按 `<facility>-comments` 合同（PACKAGE.md §3.2）：例如
  `GET /api/enrich?source=douyin-comments&vid=<aweme_id>` → `{ comments, total, cursor? }`，翻页把回来的
  `cursor` 当 `cursor`（或 `page`）再发；末页不带 `cursor`（或给 `null`）。**宿主自己没有任何视频平台的评论分支**——
  哪个平台有评论，看它的包申报了哪个 enricher。
* **POST `/api/credentials/:domain/connect`** — 一键冷启动订阅。**域由包认领**：包在 `stream.code.connect` 申报键（= 域名，必须在它的 `credentials` 里），`activate()` 交出同名处理器（PACKAGE.md §3.2）。路由查表（大小写不敏感）：命中调一次，宿主 `subscribe(stream)`，回 `{ ok: true, id, ...extra }`（`ValidationError` → 400，其余 → 502）；没有包认领这个域 → `404 not_found`。宿主自己不认识任何域。

### WS 现取协议：`enrich.open` → `enrich.*`（`/ws`）

前端「打开一条」时的实时通道（`src/http/enrich-ws.ts`）。**只服务包交出的 enricher**：宿主自己那几条
（今天只剩 `link`）走 HTTP 就够，不占任何浏览器 lane；包自报 `prefetch: true` 的现取也走 HTTP（站外裸 HTTP，前端随滚动预取）。去哪现取由 item 自己说——包的 normalizer
在 `content.enrich` 里写下 `{ source, params }`（PACKAGE.md §3.2），前端原样搬进命令；宿主不认识任何站。

* **命令**（前端 → 后端）：`{ type: 'enrich.open', correlationId, source, params }`。`params` 全是字符串
  （≤ 32 个键、每值 ≤ 2048 字符），`correlationId` / `source` ≤ 128 字符；形状不对整条丢弃、不回应。
* **事件**（后端 → 前端，每条都带发命令那次的 `correlationId`）：
  - `enrich.started` — 已受理（自己开跑，或搭上了已在飞的同一份）。
  - `enrich.article { article }` — 正文 / 媒体那一半到了（enricher 结果里有 `article` 才发）。
  - `enrich.comments { comments, total }` — 评论到了（结果里有 `comments` 才发；`total` 缺省为条数）。
  - `enrich.completed` — 这次结束；`article` / `comments` 都没有也会发，前端据此收起加载态。
  - `enrich.failed { error }` — 查无此 enricher（包没装载 / 名字写错，**不静默回空**：空答案会被前端读成
    「这条没有正文」）、`ValidationError`、以及其他异常，`error` 截到 500 字。
  - `enrich.blocked { reason }` — enricher 抛了 `RecipeBlockedError`（按 `error.name` 判：限速排队超时、
    登录墙等），前端按「站点此刻不让进」而不是「坏了」呈现。
* **同一 `source` 一次只有一条在飞，新点击顶掉旧的（supersede）**：换了参数的新 `enrich.open` 会
  `abort()` 旧那次的 `signal`（一直传到 recipe 运行里，真正把 lane 让出来），被顶掉的那次**一个帧都不发**
  ——它的答案没人要，一条 `failed` 只会造一次假故障。
* **同 `source` 同 `params` 搭车（ride-along）**：键序无关地比较 `params`，相同就只加一个等待者，
  各人用各自的 `correlationId` 收同一份结果——不取消、不重跑（重跑会白扔一次已开始的站点访问，还会
  把请求缓存里别人等的那份一起弄失败）。不同 `source` 各自一条 lane，互不相干。
* 有副作用的动作（点赞 / 收藏 / 发消息）**不走这条协议**：它们是动作 recipe，走 `POST /api/recipes/action`
  （下一节），因为二次确认与 `userInitiated` 归那条路管。

## 动作 recipe 的脚本入口

* **POST `/api/recipes/action`** — body `{ sourceId, params?, confirmed? }`（strict-body，
  多余的键当场拒）。跑一份**动作** recipe：发消息、上架、下单这类有副作用的事。

四件从签名上看不出来、但决定怎么用它的事：

1. **和 MCP 的 `run_action_recipe` 是同一个闭包**（`runActionRecipe`，deps 由 `serve.ts` 原样递
   进来）。凭据注入、限速、facility 冷却、二次确认全共用一份——**不是两条平行实现**，改一边
   等于改两边。
2. **`confirmed` 与 MCP 那边同名同义**：两步确认只有一份。不带它调，高危动作回
   `needs-confirmation`；带 `confirmed: true` 重发才真跑。
3. **结果原样回，不折成 HTTP 码。** `done` / `needs-confirmation` / `blocked` 都是 200 的 body，
   由调用方判。尤其 **`blocked` 不等于"没做成"**——它也可能是"已经生效了，但没读到回执"，
   所以**调用方不许拿它当"可以重试"的信号**（见 `project planning record` 里那条）。
4. **它存在的理由是大参数**：动作参数可能带大块 base64（闲鱼商品图是 data URL），走 MCP 要穿过
   一次对话，抄错一个字就是 `atob` 失败。脚本直接 POST 没有这一段。
5. **`confirmed: true` 那次最多等 25s，没跑完就回 `{status:'running', runId}`**（动作还在机器上
   执行；跑完直接回来的结果也带 `runId`）。拿到 running 就 **GET `/api/recipes/action/:runId`**
   等结果：`{runId, domain:'action', status, sourceId, elapsedSec, result?, error?, note}`——run 的
   `status` 只说跑没跑完，`result.status` 才是动作的成败（就是 POST 本来会回的那份）；
   `status:'error'` = 中途炸了或后端重启，**动作可能已做了一部分**，先核目标应用再决定重不重跑。
   不是 action 档的 runId → 404。同 sourceId + 同 params **在飞**时再 POST 一次，回同一个 runId、
   不起第二轮；跑完之后再 POST 就是真的再做一次。设计：
   `internal design record`。
6. **第一方界面上的互动按钮也走这一口，没有专属端点。** 卡片 / 详情上的点赞 · 收藏直接
   `POST { sourceId: '<包名>/<动作源>', params, confirmed: true }`——按钮点击本身就是二次确认，所以带
   `confirmed`；回 `running` 就按第 5 条轮询（前端 800ms 一次、30s 上限），非 `done` 回滚乐观 UI。
   例：`packages/xhs/` 的 `xhs-like`（`{ noteId, action }`）。

### 生图的 OpenAI 形状出口（`/v1/images/*`）

* **POST `/v1/images/generations`** — body `{ model, prompt, n?=1, size?, response_format?='b64_json' }`
  → `{ created, data: [{ b64_json, revised_prompt }] }`。**GET `/v1/models`** 列出能填进 `model` 的那几个。
  **POST `/v1/images/edits`** — 图生图，multipart：`image`（文件，可多个、≤4 张、单张 ≤8MB）+ 同上的文本字段；
  参考图转成 data URL 经 recipe 的 `images` 参数递进页面。不支持 `mask`（站点没有局部重绘）。
  路径是 OpenAI 协议的标准形状：只会说 OpenAI 方言的客户端（无限画布这类）把 Base URL 填成
  **源本身** `http://127.0.0.1:8900`（和填 `https://api.openai.com` 一样，客户端自己拼 `/v1/…`），Key 随便。
  `/v1/*` 和 `/api/*` 过同一道门（Origin + token，见「访问控制」）。

它是**宿主的一个适配器**：把「会出图的动作 recipe」的产物换成客户端认识的形状。宿主不点名任何包——
`model` 就是 sourceId，谁能当模型由 recipe 自己在 `meta.produces: "images"` 里申报（条目要带 `url`，
退回带水印图的那张标 `watermarked:'true'`），一轮出几张读它的 `output.targetCount`（`n` 超过它就 400）；
一轮实际出几张由站点定（`perRun` 只是上限）：这一轮分不到自己那份的请求自动开下一轮（最多 4 轮）。接一个新的生图站点 = 加一份 recipe，宿主不动。**不是 LLM 入口**（`/v1/chat/completions` 那条已撤，见下一节）。

今天唯一的模型是 `doubao-image`（`packages/doubao/`）：一次请求 = 在用户自己的 Chrome 里跑一遍豆包网页版
「图像生成」（约 25–35s；纯文生图通常 4 张、带参考图 1 张——条数读页面数据里的 `imageList`，不猜）→ 从页面数据里挖每张的 `image_ori_raw`（**没有水印的原图**，签名 URL 公网可下）
→ 逐张下载 → b64 回。只有挖不到原图、退回带水印预览图的那张才过 `dewatermark` 容器补掉水印——它是可选包
（`stream add @streamapp/dewatermark`，源码在 stream-packages），没装而这一轮恰好用到 → **503**、message 写明装法。
同 model + 同 prompt 的并发请求合成一轮分食（画布「张数 4」发的是 4 个 n=1）。`confirmed:true` 由路由给
（程序消费者，同 CLI `--yes`）；`size` 非 1:1 时把比例约简后追加进 prompt（`, aspect ratio 3:2`，`revised_prompt` 回显）；
去水印（仅退路用到）失败整次按 502 回（包没装是 503）、**不回带水印的图**。错误体是 OpenAI 的 `{ error: { message, type } }`。
设计：`internal design record`。

同一个包里还有一条只读的 `doubao-chat-images`（不在 `/v1/*` 上，走 `POST /api/recipes/action`）：给一条豆包对话的 URL，把里面已经生成好的图读回来（每张的无水印原图 URL，`index` 0 = 最新的一张，`message` = 倒数第几条生图消息；可选 `last` 只要最新几条消息）。用在「用户在豆包里手动对话调好了图，要拿到本地」这一步——不发消息、不耗额度。只读得到页面渲染着的那段历史，不够会往上翻，到头就停。

还有一条 `doubao-drafts-clear`（同样走 `POST /api/recipes/action`，`effects: write`）：把豆包左栏「草稿」里的条目全部删掉（不可恢复），回每条被删草稿的标题。生图 recipe 每次失败（风控弹窗、没出图、超时）都会留一条带参考图和 prompt 的草稿，攒多了用它一次清干净；无参数。

## LLM 与 Agent (LLM & Agent)

LLM 调用是一次配置、处处可用的 **Provider 能力**；其上是 **Agent** 对话服务（工具 = Stream 自身能力）。端点全集见 Postman 集合（`docs/postman/stream.postman_collection.json` 的 Settings / Agent 分组）。

### LLM 设置（连接即 `llm` 行的成员）

**没有 `LlmSettings` 面板、也没有专用编辑器端点**（别去找 `/api/source-runtime-config/editor`）。LLM 连接就是 **`llm` Provider 行的成员**，走通用 Provider CRUD 配（见上「Provider 数据模型」）：

* **加/改一条连接** = 给 `llm` 行 `POST`/`PATCH /api/providers/:id` 一个 `{ source: 'llm-openai', name: <实例名>, params: { baseUrl, model } }` 成员（`name` 缺省即 `source`，是这个实例的寻址键、排序/排除/keyState 都按它取）。
* **该实例的 key** 走 `PUT /api/source-runtime-config`，body 加 `ref: 'llm:<实例名>'`（`llm-openai` manifest 声明了 `perInstance: true`，其 `runtime_config.ref` 命名空间只认 `^llm:[\w-]+$`；`ref` 不合法或缺失 → `400`）。对非 `perInstance` 的普通 Source 传 `ref` 同样 `400`（该 Source 的配置是共享的，不接受调用方指定落点）。`POST /api/source-runtime-config/status` 同一套 `ref` 规则读状态；`GET /api/providers` 的 `resolvedMembers[].keyState`（`'stored' | 'env' | 'missing' | null`）按同一个 ref 取层，key 本身永不回传。
* **`llm` Provider 行**：`variant: 'llm'`，成员一到多个 `llm-openai` 实例（builtin 源，**只有一种形状**：`baseUrl`/`model` 在成员自己的 `params` 上，key 经 `params.tokenName`——即上面的实例 ref——从 TokenProvider 取。没有第二种配置来源：`settings.json` 的 `llm` 块只剩摘要 prompt）。总结（`llm.summarize`）、聊天（`llm.chat`）、网盘季归属（`netdisk.spec.suggest`）三个调用点都从这行读，单一事实源；调用点绑定可选 `params: { model }` 覆盖该次调用用哪个模型（赢过成员自己的默认）。
* **摘要 prompt**：`GET`/`PUT /api/settings/summary-prompt`。`GET` 回 `{ prompt, configured }`（`configured` = llm 梯子上有没有一个端点齐全的成员，不是旧的任务绑定判据——它是活体状态，所以不在 config row 的 GET 里）；`PUT` body `{ prompt: string }`，持久化并热生效。写路径是 `summary-prompt` 配置 row 的薄转发（通用面 `PUT /api/config/summary-prompt` 同一份语义）。

### LLM 没有 HTTP 面

**Stream 不对外提供任何 LLM 端点，一条都没有。** 模型只有两个互不相干的去处：

* **后端自己的调用点**（总结、网盘建议/裁决、搜索 agent 的对话关节、extract 的压缩腿…）走**进程内**的 `ctx.llm.forTask` 梯子——上面那行 `llm` Provider 就是它的配置面，一步 HTTP 都不经过。用量账本落在 cache.db 的 `llm_usage` 表（只有后端自己写，没有读它的 HTTP 端点）。
* **对话里那个模型**归用户自己的宿主（Claude Code / Codex / DSH），Stream 完全不参与——不提供端点、不写任何 profile。宿主直接打用户配的那家，请求不经过 Stream。见 `docs/ARCHITECTURE.md`「对话」一节。

**别再往 Stream 上加一个 LLM 转发口。** 转发一层换来的是"多一处要维护的 OpenAI 方言兼容"，而它唯一的卖点——记账——在流式路径上根本记不到（SSE 分帧回，拿不到 usage）。要账本就用网关自己的。

# Provider callsite bindings

- `GET /api/provider-callsites` lists code-declared callsites, current bindings, and compatible Provider candidates.
- `PUT /api/provider-callsites/:id/binding` accepts `{ providerIds: string[], params?: object }`; fixed callsites require exactly one compatible Provider, while dispatch callsites preserve the supplied route order. `params` is the callsite-level override the capability reads (today: `model` on the `llm.*` / `netdisk.spec.suggest` callsites; a non-object is `400`).
  - **Whole-body replace, never a merge — omitting `params` clears it.** A client that only means to change `providerIds` MUST send the existing `params` back verbatim, or the override is silently dropped (`restore-default` relies on that same clearing semantics).
  - The response also carries `offeredDefaults` — bookkeeping, not user data: the default rows boot has already offered this binding. Boot only merges a default that is **not** in that list, so a row the user deleted stays deleted instead of coming back on every restart. It is the one field a write preserves rather than replaces, so clients never need to echo it.
- `POST /api/provider-callsites/:id/restore-default` restores that callsite's builtin default binding, and returns the restored binding. **When the callsite has no default rows** (its defaults come from a package that is not installed, e.g. `music.track.*`) it **clears** the binding and returns `null` — an empty binding would still count as "bound", so boot would skip that slot forever once the package arrives.
- `DELETE /api/providers/:id` returns `409` with `error.details` — `callsites` (still referenced by a global binding), `providers` (referenced as a `{provider}` composition member), and `channels` (`[{ channelId, callsiteId }]`, referenced by a Channel's `options.slots`) — non-empty means the delete is rejected.

## Spaces（频道之上那一层：侧栏的分组）

**别把它叫"组"**——Stream 里"组"已经有主了：频道本身就是「一组 stream」，代码里的
`groupedIds` / ungrouped 说的是"这个 stream 有没有被某个频道收编"。空间是频道的上一层。

- `GET /api/spaces` — `SpaceRecord[]`，按 `position` 升序、同值按 `id` 兜底（少了兜底那一段，
  同序号的两个空间在不同查询里会换位置，看起来像列表自己在抖）。
- `POST /api/spaces` `{ label, position?, id? }` → `201` + 记录。不给 `position` = 排在最后。
  `label` 空白串 `400`。
- `PATCH /api/spaces/:id` `{ label?, position? }` → 记录。**默认空间也能改名和挪位置**——
  它只是不能删。
- `DELETE /api/spaces/:id` → `{ ok: true }`。成员频道**挪回默认空间**，不跟着删（删空间不是
  删内容；两步在同一个事务里，否则中途失败会留下一批哪个空间下都不显示的频道）。
  默认空间 `400`：删了之后无主频道就没有落点。

`ChannelRecord` / `ChannelView` 因此多一个 `space_id`：

- `POST` / `PATCH /api/channels` 收 `space_id`。不给 = 落默认空间（`default-space`）。
  指向不存在的空间一律 `400`，**在写之前拦**——写进去就是那个频道在侧栏里彻底不出现，
  用户只会以为"没建成"。
- 无主 stream 生成的 solo 频道没有 channels 行，也就没有存放归属的地方，`space_id` 恒为默认
  空间。要把它挪走，得先让它变成一个真频道。
- **空间不随分享包走**（`SharedChannel` = `ChannelRecord` 去掉 `space_id`）：空间是本机侧栏的
  组织方式，对面机器上没有这一行；导入方一律落进自己的默认空间。

## Presents & channel-level Provider slots（2026-07-24）

- `GET /api/presents` — the official Present registry, `{ items: PresentDescriptor[] }` with
  `PresentDescriptor { id, label, needsStreams, slots: [{ callsiteId, label, variant, mode }] }`.
  `id` is one of `timeline | search | audio | video | research | tasks | embed`; `slots` is derived by grouping
  `provider-callsites` entries per Present — it is not an independent declaration.
- `GET /api/channels` items return `present` (Present registry id) and `options` (含
  `options.slots`，未配置任何 options 的频道不带这个字段); `kind` remains a deprecated read alias
  of `present` for the pre-migration frontend.
- `PATCH /api/channels/:id` returns the **persisted `ChannelView`** — byte-for-byte the same
  projection `GET /api/channels` serves for that id (expanded `streams` tree included), not the
  raw stored record. 前端据此"用返回体覆盖本地那一条"，不必写完手工合并自己那份可能陈旧的
  快照（见 `internal design record`）。
  `POST /api/channels` 仍返回原始记录（`stream_ids` 而非 `streams`）——新建路径只用它的 `id`。
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
- **`422 slot_broken`（spec §5.1）** — a filled slot is explicit intent: if none of the
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

## 整理：整轮撤销（undo-run）

* **POST `/api/netdisk/reconcile/undo-run`** — body `{ runId }`，把这一轮写下的溯源行按 rowid
  倒序撤回（移回 / 改名改回 / 重建目录），返回 `{ undone, skipped }`——`skipped` 是遇到的删除类
  行（`delete-dup`/`delete-loser`/`replace` 的旧正主），删除进了回收站，这条路不负责把它们捞
  回来，只计数不报错。`runId` 缺失 → `400 validation_error`；整理未装配 → `503 unavailable`。

  `POST /api/netdisk/reconcile/{:show,bindings/:id}/execute` 的响应现在多带 `renamed`（本轮
  改名的文件数）、`removedDirs`（清空后删掉的分享子目录数）、`runId`（回填给上面这条撤销接口）。

## 轮末裁决器（spec `2026-09-03-netdisk-llm-adjudicator`）

把归档 pending 卡与追更 pending 候选打包问一次模型，结论过代码闸后落决策账本；详见
`docs/MATCHING.md`「轮末裁决」一节。**模型不删文件**——只写 `is-episode`/`not-episode`。

* **POST `/api/netdisk/reconcile/bindings/:bindingId/adjudicate`** — body `{ losers?: boolean }`
  （缺省 `false`）。返回 `AdjudicationRun`：`{ runId, skipped?, asked, applied, rejected, unsure,
  failed? }`。`skipped:'same cards'` = 与上次问过的那批卡指纹相同且不足 7 天，节流跳过；
  `skipped:'no cards'` = 这一轮没有待问的卡；`failed` = 整批作废（`'no llm'` 未配置/调用失败，
  `'unparseable'` 回执不是合法 JSON）。`applied > 0` 且是 tmdb tv 绑定 → 响应前重新同步一次
  （同 execute/undo-run）。整理未装配 → `503 unavailable`；绑定不存在 → `404 not_found`。
* **POST `/api/netdisk/reconcile/bindings/:bindingId/adjudicate/revoke`** — body `{ runId }`。
  按 `note` 前缀 `llm:<runId>` 整批撤回这一轮模型裁的决定（不牵动人工那些），返回
  `{ ok: true, revoked }`——`revoked` 是删了几条决定行，0 不算错（那一轮本来就没有采纳任何条）。
  `runId` 缺失 → `400 validation_error`；未装配 → `503 unavailable`。

## 网盘整理：AI 建议 vs 人最终选择（对照账本）

AI 给过的判读，与人最后点的那一下，逐条对照。**它存在的唯一理由是给自动采纳一个准确率底数**：
判读带引文只保证"这话它真说过"，保证不了"引对了话、判对了集"。

**AI 那半截有两个生产写入方**：对话裁决（模型自己用 `netdisk_transcribe` 听、自己判、经决定
端点落账）与上面的轮末裁决器。人那半截照旧回填，存量里还没答的行仍答得上。

* **GET `/api/netdisk/reconcile/suggestions`** — `{ items, nextCursor?, summary }`。
  `?state=open|answered`、`?agreement=agree|disagree|inconclusive`、`?limit=`（默认 50，上限
  200）、`?cursor=`。认不得的枚举值 `400`（静默忽略会让人以为筛过了）；reconcile 未装配 `503`。
  **看反例用 `?agreement=disagree`**——AI 判错的实证比一致率数字有用得多。

**只有 GET，没有写入口，这是设计不是没做完。** 后半截（人选了什么）由 `POST …/reconcile/decisions`
写决定时回填，是那条路的副作用。再开一个写入口就是第二条来路，两条来路的账本必然对不齐，而
对不齐的账本比没有账本更坏——它看起来像个数。

`summary` **永远统计全表**，不跟着 `state`/`agreement`/`limit` 变：一个跟着当前页变的一致率，
读的人会当成总体。四格 `agreed`/`disagreed`/`inconclusive`/`open` 互斥且穷尽，相加恰好是
`countable`（= 判读给了 `is-episode`（带 leftKey）或 `none-of-these` 且带引文的那些）。少一格就会
有一类结局静默消失，而"人答了但没法比"恰恰是最容易被当成一致混进去的那类。

## 追更循环（follow loop）

TMDb 剧集绑定的「追」开关与手动触发；一轮做什么、节奏表、失败降级见 `docs/ARCHITECTURE.md`
「追更循环」一节。四条都先问追更服务在不在——未装配（netdisk 整体未启用）→ 一律 `503 unavailable`。

* **GET `/api/netdisk/mappings/:id/follow`** — 看一眼这条绑定的追更状态：
  `{ follow?, missingAired: string[], upcoming: number, shares: Array<{pwdId,netdisk,origin,
  validity,lastCheck}>, runs: FollowRunRecord[] }`（`runs` 最近 10 条，新的在前；每条跑过归档的
  带 `archived: { runId, moved, deleted, renamed, gated? }`，`gated` 只在归档被健康闸挡下时才有）。
  绑定不存在 → `404 not_found`。

* **PATCH `/api/netdisk/mappings/:id/follow`** — 开关，body `{ enabled: boolean }`。只收布尔，
  非布尔（如字符串 `'false'`）→ `400 validation_error`（避免真值判断把开关判成关不掉）。绑定不
  存在 → `404 not_found`；绑定存在但不是 TMDb tv 左侧（电影/订阅流）→ `400 validation_error`。
  关掉时清空 `nextCheckAt`（下次开等于重新排期，不会带着上次的到期时间）。

* **POST `/api/netdisk/mappings/:id/follow/run`** — 手动跑一轮（`trigger:'manual'`），同步返回这
  一轮的 `FollowRunRecord`。绑定不存在 → `404 not_found`。这条会真的转存文件——**转存不过人工
  二次确认**（用户拍板：往自己网盘里加文件可逆）。

* **POST `/api/netdisk/follow`** — 追一部还没有绑定的剧：body `{ tmdb: { id, media:'tv', title,
  year? } }`。后端拼作品目录（不收客户端传的路径，落点必须与转存那条路一致）、按需 `mkdir`、
  建空绑定并开开关，返回新绑定。`media` 不是 `'tv'` 或缺 `id`/`title` → `400 validation_error`；
  夸克挂载预设缺失 → `503 unavailable`；`mkdir`/`bind` 失败（AList 不可达等）→ `502 upstream`。

## 受影响的源（这份 recipe 坏了会连累谁）

* **GET `/api/sources/affected?id=<sourceId>`** —— 沿 `uses` 声明的反向闭包，回答「这个源坏了
  还有谁跟着哑」。回 `{ id, affected: Array<{ id, title, facility }>, unresolved: string[] }`；
  `id` 缺失 → `400 validation_error`，解析不到 → `404 not_found`，裸名歧义 → `400` 且消息里
  列着全部候选全名。

  `affected` **含起点自己**，字典序，永远非空（空会被读成"这个源不存在"）。`unresolved` 是
  解析不到的 `uses` 边（`<声明方> → <写下的 id>`）：它可能就指着本次查询的这个源，所以是答案
  里的一个洞，必须一起读。

  **为什么需要一条专门的路**：一份被共用的 recipe（xhs 的 detail）漂了，用它的那几个源
  **各自的健康状态仍是绿的**——没人替它们跑过那份 recipe。除了这里，没有任何一处能把它们
  点出来。声明怎么写见 [PACKAGE.md](PACKAGE.md) §1 的 `uses`。

  **`id` 走查询串、不走路径段**：全名是 `<npm 包名>/<局部名>`，本来就带 `/`（还可能带 `@`），
  塞进路径段就得两端各转义一次，而少转一次的表现是 404——一个看起来像「这个源不存在」的错。
  `id` 吃任何存量形状（全名 / `xhs:xhs-home` / 裸名），归一由 Registry 的四级解析做。

* **反着读的那一侧在 `GET /api/channels` 的成员行上**：每个成员多一格
  `dependencyIssues?: Array<{ kind:'broken', id, title?, health, error? } | { kind:'unresolved', id }>`
  ——「我自己绿着，但我依赖的东西有问题」。**只在真有问题时出现**（都健康就整格不发）。

  它和同一行的 `health` 是两件事：`health` 说「我采得动吗」，这一格说「我依赖的东西还在吗」。
  界面上只能挂在**用它的人**身上：被共用的那个源（xhs 的 detail）不是任何一条 Stream 的成员，
  没有属于它的行；而用它的那几行天天在用户眼前，且看起来一切正常。

## 链接认领（`/api/links/recognize`）

* **GET `/api/links/recognize?url=<url>`** — 「这条链接是谁的、是什么」：回
  `{ url, package, platform, kind?, id?, yields? } | null`。`null` = 没有已装的包认领它（200，不是 404——「没人认领」
  是一个答案）；缺 `url` → `400 validation_error`。认领表是各包的 `stream.links`（PACKAGE.md §0.5「`links`」），
  宿主不认识任何站。命中某包 `shortHosts` 的链接先展开再认（只打那个包声明过的主机，`redirect:manual`、最多 3 跳、
  每跳 5 秒），此时 `url` 是展开后的地址；展开失败按原链接认、原因进 DebugBox `links` 频道。它只认领，不派发、
  不抓内容——抓媒体是 `GET /api/media/from-url`（按认领到的 `<platform>-link` 派发 `content.enrich`）。
## Radar（URL → 候选源）

* **GET `/api/radar?input=<url>`** — 把一个粘进来的地址解析成能吃下它的候选源（RSSHub 目录 +
  原生插件），`{ input, matches: Array<{ sourceId, params, title }>, fallback: 'generic-url' |
  'unknown' }`；`input` 缺失 → `400 validation_error`。扩展 popup 的"雷达"就吃这个。

  **别把它挂回 `/api/intents`**——那是下面意图跟踪那份资源的路径。同一个 `method+path` 注册
  两次时 Hono 只让先注册的应答，后一个永远够不到，而**两边各自的单测照常绿**（各挂各的半个
  app，冲突只在真实装配里）。守卫在 `src/http/route-collisions.test.ts`：整装 app 的路由表里
  `method+path` 必须唯一。

### 「想接还接不了」清单 (Onboard Wishlist)

对话里搜到一个地址、但 `/api/radar` 没有候选源接住它时，记一笔"想接还接不了"。

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/onboard/wishlist` | 「想接还接不了」清单（对话里接不上的站），最新在前 |
| DELETE | `/api/onboard/wishlist/:id` | 删一条 |

**这份清单没有 HTTP 写入口**——唯一写入路径是对话里的 `note_unonboardable` 工具（模型主动调，
不保证完整）。

## 一次性解析（`/api/resolutions`）

* **GET `/api/resolutions?type=<targetType>&key=<key>`**（或 `?input=<粘进来的东西>`，由 IntentResolver
  分类出 type/key；两者都缺 → `400 validation_error`）——按 target-type 的梯子解析一次，
  `{ targetType, key, result: { source, items } | null }`。
  `result: null` = 这个 target-type 没有梯子（没装对应的包），不是"查无此物"。

  **`type=lyrics` 的 key 文法**：`<platform>:<id>`（已知曲目引用，`platform` 是某个包的 facility，
  由该包 `stream.links` 里的 track pattern / Provider 行 serveKeys 认领）或 `<title>::<artist>`（模糊搜）。
  歌词结果按 key 缓存在调用侧（命中永久、未命中 7 天，`AudioArchive` 拥有 TTL；HTTP 这一口与 MCP 的
  `resolve` 工具共用 `src/audio/lyrics-cache.ts`）；命中时 `result.source` 是 `lyrics-cache`。
  梯子一条都没答上（`result: null`）**不写缓存**——那是没配源，不是这首歌没歌词。

## Intents（意图跟踪）

订阅"目的"而非"源"：立一个 Intent 给一句 `goal`，LLM 生成判定标准 `criteria`；之后名下 Stream
的新 item 逐条按 `criteria` 判相关性，相关的并入档案。概念与不变量见
[ARCHITECTURE.md § Intent](ARCHITECTURE.md#intent意图)。除 `GET /api/intents/:id/dossier`
（返回 markdown 原文）外全部 JSON。`deps.intents` 未装配（如最小测试装配）时全部端点 `503
{ error: { code: 'unavailable' } }`。

* **POST `/api/intents`（Create）** — body `{ goal: string, streamIds?: string[], recruit?:
  boolean }`。`deps.intents` 未装配 → `503 { error: { code: 'unavailable' } }`；`goal` 缺失/空串
  或 `streamIds` 不是 `string[]` → `400 validation_error`；`goal` 校验通过后 LLM 生成 `criteria`
  失败或落盘失败 → Intent 不立，`500 { error: { code: 'upstream_error', message } }`（message 即
  抛出的错误，如"LLM 未配置"）。成功 `201`，返回新 `IntentRecord`；`recruit:true` 时额外触发一次
  招源（同 `POST /:id/recruit`），成功则响应体附带 `recruited: RecruitOutcome`，招源失败
  **不影响**已经立好的 Intent（可事后用 `POST /:id/recruit` 重试，不体现在这次响应里）。
* **GET `/api/intents`（List）** — `{ intents: Array<IntentRecord & { ledgerCount: number }> }`，
  含 `retired` 的。`ledgerCount` = 该 Intent 账本里已判过的 item 数（粗略反映活跃度）。
* **GET `/api/intents/:id`（Detail）** — 单条 `IntentRecord & { ledgerCount }`；不存在 → `404
  not_found`。
* **GET `/api/intents/:id/dossier`（档案）** — 响应体是**原始 markdown 文本**（`content-type:
  text/markdown`），不是 JSON 信封；意图不存在 → `404 not_found`；存在但还没消化出任何相关内容
  → `200` 空字符串（不是 404——Intent 本身是有效的，只是档案还没内容）。
* **POST `/api/intents/:id/recruit`（招源）** — 在本机源注册表内按 `goal+criteria` 搜候选、LLM
  挑源、验参、查重、试吃，通过的当场订进该 Intent 的专属频道（`intent-<id 前 8 位>`），同步执行
  （秒级）完成后直接返回结果，不是异步发现：`200 { subscribed: [{ streamId, sourceId }], reused:
  string[], dropped: number }`——`subscribed` 是本次新订的流，`reused` 是命中查重、复用的既有
  streamId（不新订），`dropped` 是候选里被验参/查重/试吃闸挡下的条数。Intent 不存在 →
  `404 not_found`；已 `retired` 的 Intent（调用方状态错误，不是招源本身失败）→
  `409 { error: { code: 'conflict', message: '意图已退休' } }`；recruit 未接线（bootstrap 未装配
  `IntentServiceDeps.recruit`）→ `503 { error: { code: 'unavailable', message } }`；其余失败
  （含挑源阶段的上游 LLM 调用失败）→ `500 { error: { code: 'upstream_error', message } }`。
* **POST `/api/intents/:id/digest`（立即消化一轮）** — 手动触发一轮消化（不等 cadence），返回
  `DigestOutcome { judged: number, relevantNew: number, errors: number, remaining: number,
  windowSaturated: string[] }`。`judged` 是本轮尝试判定的条数（含判定失败、计入 `errors` 的那些，
  受 `maxJudged`，默认 100，封顶一轮串行 LLM 调用数）；`remaining` 是本轮账本外但没轮到、留给下一
  轮的条数（账本天然是断点，不丢；`remaining > 0` 时本轮不推进 `lastDigestAt`，下一次
  `intent-digest-scan` 会立即接着排，不必等整个 cadence）；`windowSaturated` 是本轮里"消化窗口
  （每流最近 200 条）整窗都是未判条目"的 stream id 列表——出现即代表窗口外可能有更旧的条目被永久
  漏判。与调度任务 `intent-digest-scan` 共用同一个单槽队列（`IntentService` 内部串行），不会因为
  手动触发而和巡检抢跑出两轮并发 LLM 调用。Intent 不存在 → `404 not_found`。
* **POST `/api/intents/:id/retire`（退休）** — 把 `status` 置 `retired`（**不删除**，历史账本/档案
  保留），并回退该 Intent 招源订到的流（取消订阅、单条失败只记日志不回滚）与其专属频道；手动绑的
  Stream 不受影响。`intent-digest-scan` 只扫 `status: 'active'` 的 Intent，退休的不参与，但仍可
  `GET`/`POST .../digest` 手动消化。不存在 → `404 not_found`。没有反向"取消退休"端点。

**没有编辑端点**：不能改 `goal`/`criteria`/`streamIds`（`POST /api/intents` 时的
`streamIds` 是唯一的写入口，`POST /:id/recruit` 是另一个追加订阅的口）；要改 `goal`/`criteria`
目前只能重新 `create`。

**MCP 面**（`src/mcp/tool-catalog.ts` + `src/mcp/server.ts`）：`intent_create`（`{goal}` → 同
`POST /api/intents` 不带 `recruit`）、`intent_list`（同 `GET /api/intents`）走通用 catalog、走
标准 JSON 信封；`intent_dossier`（`{id}` → markdown 原文）因为不能被信封转义（会把换行转义成
`\n` 字面量）单独手注册，找不到意图时用 MCP SDK 的 `isError` 通道报错而非返回 null。招源与主动
消化**不进 MCP 面**——那是后台调度/HTTP 操作，不是查询。

## Sharing（配置分享 · stream-bundle）

分享用户编排配置（Channel/Stream/Provider 闭包）为单个 `stream-bundle/v1` JSON。**导入零执行**（recipe 只在被引用 Stream 下次 tick 才跑）、**凭证从不进包**（只写 `requires.credentials`/`runtimeConfig` 需求声明）、**传输 host 无关**（URL 或本地文件）。设计见 `internal design record`（闭包/包格式）与 `internal design record`（导入台账）。

**核心模型（import decision ledger）**：一次导入 = 一个可寻址资源（run）；它留下的每个待拍板事项 = 一个 item（`kind: 'parked-provider' | 'slot-conflict' | 'notice'`，各带 `subject`/`mine`/`theirs`/`choices`/`detail`）。导入落地但惰性：无分歧的事直接做掉，有分歧的落成 open item——**拍板前不破坏本机任何已生效配置**。decision 是 item 唯一的状态迁移（open → decided/dismissed），执行失败不半提交。UI 的导入结果页与 AI 的「帮我导入并处理」吃同一份数据。

- `POST /api/sharing/exports` — body `{ root: { kind: 'channel'|'stream'|'provider', id }, meta?: Partial<BundleMeta>, providerIds?, bindingCallsiteIds?, netdiskBindingIds? }` → `{ bundle, warnings[] }`。从根走依赖闭包：代码插件进 `requires.plugins`（声明+版本约束），recipe 整份进 `embedded.recipes`；`meta` 缺省用根 label + 当日 + revision `1.0.0` 补全。params 藏疑似密钥 → `400` 拒绝导出。可选数组是能力搭车（见下两节）。
- `POST /api/sharing/imports` — body `{ url } | { bundle }` → `201` `ImportRun{ id, at, meta, remaps, recipeDecisions, netdiskBindings, items[] }`。配置行 id 撞车 remap（system 频道 stream_ids append 复用 + 槽位按下述语义合并）；recipe 版本 semver 合并（升/复用/跨 major 落 notice）；缺插件/待补凭证/待补 runtime-config 各落 notice item；未知/坏 format `400` 且不做部分写入。
- `GET /api/sharing/imports` — `{ items: [{ id, at, meta, openCount, itemCount, netdiskBindings }] }`（at 倒序）。
- `GET /api/sharing/imports/:id` — run 的**当前态**（非导入时快照）：parked-provider 的 open item 以 store 现值实时投影（provider 已被别处激活/删除 → 显示为 decided/dismissed），并附 `conflicts` 冲突体检。
- `POST /api/sharing/imports/:id/decisions` — body `{ itemId, choice }`。choice 必须属于该 item 的 `choices`。成功 `200 { item }`；重复拍板 / 执行失败（激活冲突、槽位校验失败等）→ `409 { error, item, conflicts[] }`，item 保持 open、原因写回 `detail`；未知 run/item `404`。错误体一律 `{ error: { code, message } }`。

**system 频道的 `options.slots` 导入语义**：包内槽键先过 provider id 改写；本机该 callsite **未配置**（`slots` ∪ `candidateSlots` 均无此键）→ 静默合并（引用随包 parked 行的落 `candidateSlots`，激活时搬回）；**已配置** → 本机继续生效，包内那份落 `slot-conflict` item（`mine`/`theirs` 带双方 provider 投影，run 是唯一存储，不在频道 options 上留第二份）。`use-imported` 的 decision：键内全部可用 → 过 `validateSelection` 写 `slots`；含 parked → 落 `candidateSlots` 等激活。非系统频道撞 id 走 fork 新频道，结构上无槽位冲突。

### Sharing 能力搭车（config-sharing v2 · Provider）

- `POST /api/sharing/exports` 的 `providerIds?: string[]` / `bindingCallsiteIds?: string[]`——显式勾选把作者**非系统** Provider 行 + binding 覆盖搭进包（不进频道闭包）；成员 runtime_config 仅进 `requires.runtimeConfig`（无值），Provider 成员藏密钥 → 400 拒绝导出。
- 导入的 Provider「趴着进」（park-on-import）：落库但不入 dispatch，对方现有路由不变；每行落一个 `parked-provider` item（`choices: use-imported | keep-mine | append | dismiss`，与激活语义一一对应）。decision 执行即激活（含 candidateSlots 恢复）；serves 重叠 / binding 抢占详情由 `GET /api/sharing/imports/:id` 的 `conflicts` 投影给出，调用方看完再拍。
- 待激活清单没有独立端点：从 run 的 open items 里读（provider 行本身仍走 `/api/providers` 的 CRUD 与 parked 行为）。

### Sharing 网盘 binding 搭车（config-sharing v2 · B）

- `POST /api/sharing/exports` 的 `netdiskBindingIds: string[]`——勾选把网盘对齐 binding 的**可移植子集**（`left` + `matchSpec` + 仅人工订正 entries + 可选 shareUrl）搭进包 `netdiskBindings` 块；**不带** `right.path`/fileId/凭证。stream-left 且 stream 未随包 → 告警。勾选项复用既有 `GET /api/netdisk/mappings`（不新增列举端点）。
- `ImportRun.netdiskBindings: {id,title,shareUrl?}[]`——导入把每项暂存为 `right` 未解析、`autoSync:false` 的 pending MappingSet（**导入零执行**：不转存/不 sync/不采集），回一份待转存清单引导对方：用自己夸克登录态转存 → 挂 AList → 走既有 `POST /api/netdisk/mappings/:id/rebind` → sync 用随包 matchSpec 确定性重算完成首绑（不重跑 AI）。rebind 走既有端点、不进 items；stream-left 缺 stream 落 notice item。
