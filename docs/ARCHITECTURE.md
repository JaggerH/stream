# Stream Architecture

Stream is a self-hostable **information-flow layer**: it ingests many sources (RSSHub routes plus
native adapters like xhs / bilibili / douyin) into one inbox, normalizes them with per-source
normalizers, and exposes everything — feeds, search, resolution, transcription — to both a web
frontend and AI agents (MCP) from a single process. Data sources mount as plugins.

This document is the authoritative definition of the concepts and their dependency structure.
`docs/PACKAGE.md` covers one layer of it (Stream packages / Plugins) in depth.

## The model at a glance

Five concepts. The **aggregation chain** is `Channel → Stream → Source`. A Source carries the id
of the Plugin it belongs to, and is *executed through* that Plugin at runtime — the Plugin is the
**ownership and execution boundary**, not a layer of the aggregation chain. A **Provider** sits
outside the chain: a global, stateless, on-demand capability. (**Present** is not a sixth
concept — it is the official registry of Channel consumption modes that `Channel.present`
indexes into; see Channel below.)

```
  subscription / call ──────────────▶ Channel       (entry point; present: timeline | search | audio | video
                                                     + options.slots: per-Channel Callsite→Provider overrides)
                                        │ aggregates ≥1
                                        ▼
                                      Stream        (scheduled feed member; strategy: fanout | exclusive;
                                                     mode: feed | collection — storage shape)
                                        │ references ≥1
                                        ▼
                                      Source        (one manifest entry; knows its owning Plugin)
                                        │ executed through
                                        ▼
  ┌───────────────────────────────── Plugin ─────────────────────────────────┐
  │ adapter (facility API → raw items)   normalizer (raw → display model)    │
  │ optional managed backend container   declared credential domains         │
  └──────────────────────────────────────────────────────────────────────────┘

  Provider  (global stateless capability: 身份归代码（系统件）或行上（用户自建）,编排 members/options 归行;
             调用点 = category + 键提取 + invoke()；分发 = ProviderDirectory.match — never scheduled, owned by no Channel;
             频道可经 options.slots 按调用点覆盖路由,但 Provider 行本身永远全局、被引用而非被持有)
```

| Concept | Definition | Lives in (target state — see [Data & File Structures](#data--file-structures-target-state)) |
|---|---|---|
| **Channel** | The only subscribe/invoke entry point. A **view**: references ≥1 Streams by id; one `present` per Channel (an id into the official Present registry) decides the full consumption mode (acquisition + rendering + attachable capabilities); `options.slots` optionally overrides which Provider fills a Callsite for this Channel. | user store (`channels` table) |
| **Stream** | A scheduled feed unit with **global identity**, reusable across Channels; aggregates ≥1 Sources with a `strategy`; its `mode` (`feed`\|`collection`) is the storage-shape authority | user store (`streams` table) |
| **Provider** | A global, stateless, on-demand capability. 身份（category/serves 键/fallback/strategy/contract）：系统件归代码（`src/providers/system/`），用户自建归行；编排（members/options）一律归行。分发经 `ProviderDirectory.match` | identity: code + user store; orchestration: user store (`providers` table) |
| **Source** | One concrete callable entry declared by a manifest, or derived from a recipe's `meta`; carries its owning `pluginId` | its Stream package (`packages/<id>/manifests.yaml`, or a `*.recipe.json`) |
| **Plugin** | A Stream package that fills ≥1 **plugin slot** (manifest(s) / adapter code / normalizer / managed backend container / credential domains / source grouping) | `packages/<id>/` (builtin) or `<dataDir>/recipes/<@scope__name>/` (user-installed) |

## 能力归一化：三根轴，各画各的线

「builtin vs recipe」是个假二分法——它把三根独立的轴糊成一个词，让「引擎凑巧支不支持」替
设计画线。任何一个 facility 能力（验活、转存、resolve、搜索……）都独立回答三个问题
（权威定义与拍板记录：`internal design record`）：

| 轴 | 问题 | 取值 | 谁关心 |
|---|---|---|---|
| **表达** | TS 代码还是声明式数据？ | code / data | 没人——Source 的实现私事，上层不可见 |
| **分发** | 烤进镜像还是热插？ | image / hot-drop | 产品：付费触点要求「加 facility＝加数据，不发版」 |
| **效应** | 只读，还是改变外部世界？ | read / write | 安全：引擎门禁兜得住读的最坏情况，兜不住写 |

**画线结果**：读能力 → 数据、热插
（SSRF 公网门 + cookieDomain 绑定 + jar 域名分桶在结构上兜住最坏情况）；**写能力也可以是 recipe**
——`xhs-like`（点赞/收藏写用户账户）就是一份 recipe，recipe 可以写用户账户。
门禁看不懂一个 POST 会干什么，但**不用「写留在代码里」去堵**：第三方内容审不了，
装不装是用户自己的取舍，不做信任分级、不做出身审定。分享/加载第三方 recipe 只做**统一免责声明**
（①安全性不做保障 ②第三方内容需用户自行确认是否可信），**不做逐项授权、不做包来源签名**。
范例：夸克/百度**验活**都是 recipe（热插数据），夸克**转存**目前是代码（`shared/netdisk/quark/save.ts`，
跟着 facility 走）——实现选择，非禁令。

**网盘这一块按「认盘 / 配号」二分**（spec `internal design record`）：

- **认盘**——对一个网盘做的事：验一条分享存不存活、列它的文件、把内容转存进用户自己的盘、取可播放的
  直链、跳转网盘 web 页、往盘里传文件（OpenList `fs/put`，流式）、给盘上的目录建分享链接（夸克
  `share` → `task` → `share/password` 三步，`shared/netdisk/quark/share-api.ts`；路径→fid 与「跳转夸克」
  同一条 `browse.ts`）、列自己建出去的分享（夸克 `share/mypage/detail`，分页）、按 shareId 删分享
  （夸克 `share/delete`，**删链接不删文件、不可逆**，逐条发以拿到逐条结果）。这三件事编排都在
  `src/netdisk/share-create.ts`（列/删不看挂载表：「我的分享」是账号级的表），HTTP 面
  `POST /api/netdisk/{fs/put,share/create,share/delete}` + `GET /api/netdisk/share/list`
  给本机导出脚本用，见 `docs/API.md`。全是 cookie 鉴权、无签名的公开接口，facility 级、可打包。实现住 `shared/netdisk/`
  （OpenList client、夸克 save / play / browse / verify / share 建列删、百度 verify、判决词汇），**两个宿主同吃一份**：
  Stream 编排层（`src/netdisk/`、`src/kernel/plugins/provider.ts`）和网盘能力包
  `@streamapp/netdisk`（`capabilities/netdisk/`，可选能力包；登录态**同进程**向后端挂出来的
  `streamBrowserCookies` 服务现取）。装法一条：`stream add @streamapp/netdisk`，后端重载后
  由 `src/capabilities/load.ts` 挂上（见下面「能力包」一节），模型因此多四个 `netdisk_*` 动词。
  配置在 `config.yaml` 的 `capabilities.netdisk` 那一格：给了 `openlistUrl` + 永久 token =
  **external 档**（从 `GET /api/netdisk/openlist-access` 拿 `<origin>/_p/alist` 与那个 token，
  包不碰 storage admin）；留空 = **managed 档**，包经 `shared/docker/engine-api.ts`（与 standby
  同一份 Docker Engine API 客户端）自己拉容器、接管 admin、挂载、空闲回收；同机发现 Stream 的
  `alist` 容器就让位。
- **配号**——把网盘上的文件对上节目单：绑定、匹配（`src/netdisk/match-engine/`，纯函数）、归档。能同时看见
  节目单和网盘目录的只有编排层，所以它留在 Stream，不进插件。

### 能力包：Stream 后端是唯一宿主，能力是 Stream 包的一格槽位

**能力包**是「一件手上的能力」的分发单位，源码住 `capabilities/<x>/`，契约是
`shared/capability/types.ts`：`export const capability`，`mount(ctx, config)` 从
`CapabilityContext` 拿到 `dataDir` / `log` / `require` / `provide` / `registerTools` /
`destructiveGate` / `onDispose` 七格。**唯一那份宿主实现在后端**：`src/capabilities/host.ts`。

| | 内置 | 可选 |
|---|---|---|
| 谁 | **Stream Desktop**（能力名 `desktop`，电脑操作：中继 + 四个 `cdp_*` + cookie 服务 + `stream-desktop` 那条命） | `@streamapp/netdisk`（认盘四个动词）与用户按需安装的兼容能力包 |
| 怎么进来 | `private: true`，随后端 bundle 出货；`src/host-agent/mount.ts` 交给宿主挂 | `stream add @streamapp/<x>` → `<dataDir>/recipes/<@scope__name>/`；后端重载后 `src/capabilities/load.ts` 扫出 `stream.capability` 非空的包、动态 import `dist/index.js` |
| 工具从哪出 | 8900 的 `/api/mcp` | 同左——宿主那一行（`claude mcp add stream -- stream mcp`）永远不用改 |

**挂载顺序：内置先、可选后**，因为撞名是**硬拒**（`registerTools` 与 `provide` 都查两张名单：
已注册的能力工具、后端自己的工具名）——顺序直接决定谁被拒。反过来的话，用户装一个起名
`desktop` 的包就能把机器上的 Stream Desktop 顶掉。

**一个包 mount 抛错只记一行、继续装下一个**，不拖死别的包、不拖死后端；它已注册的工具 / 服务 /
收摊函数一并回滚。`import` 与 `mount` 各有一道超时（默认 30s）。

**登录态递送只在进程内**。这是约束不是实现选择：网盘要用浏览器握着的登录态，cookie 一旦跨进程
就是一个不可逆的安全面（spec `2026-09-02-netdisk-capability-plugin-design.md` §4.1）。所以只有
一对——后端 `provide(BROWSER_COOKIE_SERVICE)`、netdisk `require(BROWSER_COOKIE_SERVICE)`。
包能拿到哪几个域由它自己在 `package.json#stream.credentials` 申报，宿主据此去扩展要，
**方向永远是宿主派发、包不索取**。

**`stream mcp` 不是编排层。** recipe 怎么跑、桌面动作怎么串、网盘文件怎么对节目单，全在 8900
那个后端。这个子命令（`src/install/mcp-command.ts`）只做两件杂活：**探一次**本机
`/api/health`（2s 超时），在场就整面转发到 `/api/mcp`；不在场就先把后端拉起来再转发。
探测只做一次，后端中途起停都不切换——切换意味着工具面在会话中间变，宿主的工具快照跟不上。

**匹配是通用能力，网盘只是它的一种货架。** 引擎吃的是抽象文件条目（路径、大小、时长），动文件走的是
一个五动作接口（列 / 建目录 / 搬 / 删 / 给直链）。货架之间的差异——大小写敏感、删能不能撤、列举是不是
现状、能不能报「还在写」——由货架**自己申报**一张自述表（`shared/netdisk/shelf.ts` 的 `ShelfTraits`），
规划器按申报降级，不认来源类型。加一种货架（本地目录）= 实现五个动作 + 填这张表，规划器一行不改；
漏填是编译期缺字段。一条守卫测试钉着「引擎不认识 I/O」（`reconcile/engine-boundary.test.ts`），
一套契约测试（`reconcile/shelf-contract.ts`）让每个实现跑同一份用例。今天唯一的实现是 `AlistClient`
（`id === 'openlist'`），决定账本的键因此带着货架 id。各条判据和阈值见 `docs/MATCHING.md`
「输入失真时归档器怎么降级」。

**一条绑定的三个货架必须在同一个货架上**这条约束还没有落成检查：跨货架的「搬」要变成「拷贝 + 删」，
五动作接口里没有这一档，而今天只有一种货架，没有可比对象。等第二种货架落地时和它一起做。

## Two configuration layers

| Layer | Holds | Written by | Read |
|---|---|---|---|
| `config.yaml` | where things live on this machine: paths, dirs, ports, ad-filter rules | a human, in a text editor | once at boot (`loadConfig`) |
| `data/settings.json` (`SettingsStore`) | everything set from the running app: LLM connections, AList, per-Source runtime config, plugin toggles, harvest browser | the Settings page / the extension's one-click Connect / `PUT /api/settings/*` | every read, hot-applied |

**The overlay always wins** (`settings.get().x ?? config.x`) — so the same value must not be kept in
both. A duplicate in `config.yaml` does nothing at all until the overlay is lost, and then it
**silently takes over** with a value nobody has maintained: the failure mode is not an error but
wrong data (an old AList host still answering, serving another machine's files).
Anything a user can change from the UI belongs in the overlay only.

## Runtime Source Configuration

Runtime Source Configuration is the private deployment configuration a Source needs to execute:
API keys, tokens, endpoints, language, region, model, and similar facility values. It is neither a
Provider field nor a call parameter. A manifest declares `runtime_config { ref, fields }`; `ref`
is the persistence identity, so multiple Sources may intentionally share one facility config (for
example TMDb metadata and images). Values live in the private SettingsStore overlay, while the
manifest carries only the public schema.

The existing Source Config Sheet is the only editing surface. Backend Settings owns host/deployment
settings only. Secret fields are write-only: HTTP status reports whether a secret is configured,
never its value. Before execution, an adapter resolves the Source ref into a private execution
context. That context never enters Stream/Provider member params, cache keys, diagnostics, or item
storage. Login cookies remain separate: `auth.cookie` dynamically resolves browser cookies by domain.

### 自助申请：谁能替用户把一格配置填满

一格配置有两个方向的声明，本来只有一个方向走得通：**需要**（一个 Source 的 manifest 说
「我要 ref X」）和**产出**（一条 recipe 声明 `extract` + 自己的 `runtime_config`，跑一趟就把
只显示一次的明文写进 X）。产出那一侧从前没有任何索引，配置界面手里只有「我要 X」，查不到
「谁能给我 X」——一条跑得通的自助申请在界面上等于不存在。

判据是具名函数 **`provisionedConfigSlot`**（`src/replay/recipe-provisioner.ts`）：canonical
browser recipe + `extract` + 目标字段已在**自己的** `runtime_config` 里声明为 `secret`。它同时
是抽取 sink 的绑定判据（`SessionRecipeExecutor.sinkFor`）——一份判据两个方向，不许各写一份。
数字由 `src/replay/recipe-provisioner.test.ts` 钉着（今天恰好 4 条内置 recipe 产出 3 个 ref）。

反查索引住在 Source 域：**`SourcesService.configProvisionerFor(ref)`**（`src/kernel/plugins/sources.ts`）。
它**只认内置层 recipe**，与 `secret_params` 闸 3 同一条理由的镜像——否则第三方包只要声明
`runtime_config.ref: 'groq'`，内置 groq 那张配置卡上就会长出一颗跑它代码、写用户真钥匙的按钮。

HTTP 面两格，都挂在既有那对端点上（不新开只读端点）：
`POST /api/source-runtime-config/status` 的回执多一格 `provisioner`（`null` = 没人能帮），
`POST /api/source-runtime-config/provision` 真去跑那条 recipe（`userInitiated: true`，
第一方 UI 路径，同 `xhs-like`）。**成功的判据不是请求 2xx**：这类 recipe `allowEmpty`、不产
item，成功和白跑在 runner 的回执里一字不差，所以端点跑完回头问一次 `secrets[field].configured`，
不为真就报 502 并指向 `failures/`。UI 在 Source Config Sheet：撞上「要这把 key 但还没有」
那一刻弹一次引导（两个按钮：自己去注册 = `helpUrl` 外链 / 一键帮我完成 = 跑 recipe），
之后靠字段旁那颗按钮回来。

**manifest 那一侧读不到 recipe 体**，所以 `recipeToManifest` 把这条判据的结论投影成
`runtime_config.provisions`（`src/manifest/types.ts`）——**推出来的，不是包作者手写的**，
`meta` 里抄一份会被剥掉。`selfProvisionRecipesFor`（`src/auth/self-provision.ts`）只认这一格。
别拿「声明了同一个 `ref`」当判据：那只说明这份 Source 和那格配置有关系，方向可以是反的
（`eastmoney-login` 声明 `ref: eastmoney` 是为了**读**用户手填的资金账号/交易密码）。

**跑 + 回头核对只有一份实现**：`provisionConfigSlot`（`src/credentials/provision-slot.ts`）。
上面那个端点和对话里模型手上那个工具吃的是同一个函数——两边各写一遍的漂移是静音的：
一边核对、另一边把一次白跑说成「我已经帮你申请好了」。

**对话面两个工具**（`src/mcp/tool-catalog.ts`，判据在 `src/mcp/capability-gaps.ts`）：

* **`capability_status`（读）** —— 「这件事为什么做不了、谁能修」。可用性的真相源是
  `conversions.kinds()` 里 extract 那一行的 `branches`（后端选分支吃的就是它），**不另造嗅探**；
  「谁能修」从这条能力骑的那一行 Provider 的成员反查——声明的成本阶梯
  （`SYSTEM_IDENTITIES` 的 `defaultMembers`）∪ 用户库里现有的成员，逐个问 manifest 要哪一格
  `runtime_config`。声明那一半不能省：`transcribe` 行是「哪些 key 在就写哪几档」建出来的，
  一把 key 都没有时**那一行压根不存在**，只读库会答出「没有成员」这个既真又没用的答案。
  回执 `state` 有四档，各对一个不同的下一步：`ready` / `needs-key-self-serve`（缺 key 且有
  recipe 能产出 → 引导二选一）/ `needs-key-manual`（缺 key 且没人能产出 → 只给 `helpUrl`）/
  `blocked-other`（**不是缺 key**：机器上没 ffmpeg、梯子空、或 key 已配好但后端没重启）。
  第四档单列是硬要求——对它说「我帮你申请一把 key」是指错路，而指错路没有一处会报错。
* **`provision_capability_key`（写）** —— 包住 `provisionConfigSlot`，**显式二次确认**
  （不带 `confirmed` 一步都不执行，形状同 `run_action_recipe`）。确认回执要把账户级副作用讲清：
  在用户自己的 Chrome 里、用他的账号建一把真 key，建 key 不幂等。
  活体验收步骤在 `docs/AGENT-TOOLING.md` §5.1。

## Channel

A Channel (UI 里就叫「频道」) is what a user (or agent)
subscribes to and what every ref names. It is a **view**: it references its member Streams by id
(never owns them) and materializes on read — the referenced Streams' stored items are merged,
ad-filtered, and deduped on each item's cross-source ref. Items belong to Streams, not Channels:
a Stream referenced by several Channels is harvested once, on its own cadence, and its items are
stored once. A member that fails only *degrades* the result (fewer items) — it never fails the
Channel.

**Present** — one per Channel, an id into the official **Present registry**
(`src/providers/presents.ts`) — selects the full consumption mode: how data is acquired, how it
is rendered, and which capabilities attach. Every descriptor answers two orthogonal questions:

| 轴 | 问题 | 取值 |
|---|---|---|
| `needsStreams` | 这个 Present 绑不绑 Stream？ | true / false |
| `data` | 数据怎么取到？ | `collected`（源→采集→item 库→读库）/ `live`（请求到来时现执行，不落库） |

|  | `needsStreams: true` | `needsStreams: false` |
|---|---|---|
| **`data: 'collected'`** | timeline / audio / video — 按 cadence 定期采集入库，读的是库 | — |
| **`data: 'live'`** | research — 绑 Stream，但每次请求现读 Stream 成员的源，不落库 | search — 什么都不绑，查询现场分发给 search Provider；tasks — 调度引擎的执行台账；embed — 一张外部网页 |

- **Timeline** — members are harvested on schedule and shown as a merged feed.
- **Search** — no standing harvest; a query dispatches to search **Providers** at call time.
- **Audio** — members produce playable playlists; playback/download capabilities (audio
  **Providers**) attach.
- **Video** — members produce work/episode rows; video resolve, resource search and detail
  enrichment **Providers** attach.
- **Research** — a Channel binds a Stream whose member Source points at a `cockpit_sdk` run
  artifacts directory; a general live-list face (`GET /api/live/streams/:streamId/items`) reads
  that directory fresh on every call and returns one row per run — no harvest, no storage. Run
  detail (manifest + individual artifacts) does **not** ride the same general face: a list is
  structurally the same shape across every live Present, but a detail view is not — video's
  detail is a player, research's is a manifest-driven artifact grid. A single columnar frame
  abstraction general enough to carry both would end up carrying neither well, so detail is not
  generalized at all: research gets its own two routes
  (`GET /api/research/streams/:streamId/runs/:runId[/artifacts/:name]`,
  `src/http/research-routes.ts`) that mirror Cockpit's own `/api/runs/{id}` shape verbatim.
- **Embed（外接面板）** — one Channel = one external web page: `options.url` (an absolute
  http(s) URL, validated on write) is rendered as a full-pane `<iframe>` (`embedMode` in
  `app/src/panel/StreamPanel.tsx`; sandbox allows scripts/same-origin/forms/popups since the
  page is a user-configured trusted dashboard). No Streams, no slots, no local data; a missing
  or non-http(s) URL shows an explanatory placeholder, never an empty frame. The URL is edited in
  the Channel's config tab via `PRESENT_EXTRAS.embed`. Design:
  `internal design record`.

A Present descriptor is `{ id, label, needsStreams, data, slots }`, where `slots` is the set of
Provider **Callsites** that surface on that Present's channels (derived by grouping
`PROVIDER_CALLSITES` entries — the callsite list is the one source of truth, the Present
registry only aggregates it, it never double-declares slots). `GET /api/presents` exposes the
registry. *Status note: the current code models this as `ChannelRecord.present: 'timeline' |
'search' | 'audio' | 'video' | 'research' | 'tasks' | 'embed'` (`src/store/types.ts`); all seven
official Presents are built-in — no user-defined/plugin Presents yet (see
`internal design record` §9 non-goals).*

**Channel-level slots** — a Channel's `options.slots: Record<callsiteId, providerIds[]>`
overrides the global Callsite→Provider binding *within that Channel only* (e.g. an NSFW
Channel's `search.resources` slot routes to a Channel-specific search Provider while every
other Channel keeps using the global default). Slots are validated with the exact same rule as
a global binding (`ProviderBindings.validateSelection` — fixed needs exactly one compatible
Provider, dispatch needs ≥1, variant must match); a Provider referenced by any Channel's slot
cannot be deleted until the slot is cleared (see Provider below).

**Broken slot = loud error, never a silent fallback (spec §5.1).** A filled slot is explicit
user intent, so if none of its `providerIds` resolve to a usable row (all parked or deleted),
resolution does *not* fall back to the global binding or a hardcoded default — it throws
`SlotBrokenError`, which the HTTP layer turns into `422 slot_broken` plus a `provider.slot_broken`
Bell event (the resource-search UI additionally shows a toast); see [API.md](API.md).

Resolution order: Channel
slot (if the calling HTTP endpoint carries a `channelId` and that Channel has the slot filled)
→ global binding → none.

**Management surfaces derive from the Present descriptor** (2026-07-25): the in-context
`ChannelManageSheet` (`app/src/components/manage/`) renders its sections from a Channel's
`{ needsStreams, slots }` — a subscription section iff `needsStreams`, one provider selector per
declared slot, plus a `PRESENT_EXTRAS` registry as the seam for future Present-specific
sections — and `SlotSwitcher` edits the same `options.slots` inline at a callsite's own UI
surface (v1: the resource-search results surface only — `search.resources`, not `search.video`;
changing the provider re-runs the query, and a
`422 slot_broken` puts the chip in a warning state — the streamed resource search resolves the
slot *before* opening the NDJSON stream and fans out over the resolved row's members, so both
halves are real). The Plugins/Channels/Providers pages are unchanged in function but demoted to
a collapsed sidebar group (`nav.manage`, default-collapsed unless one of those three views is
active; when the sidebar itself is collapsed to icons the group drops the collapsible wrapper
and the three entries stay as always-visible icon buttons — a collapsed group inside an icon
rail would be unreachable) — they remain the inventory for objects with no
browsing context (an unreferenced Provider, a plugin container, a not-yet-subscribed Channel).
Design: `internal design record`.

## Stream

A Stream is a scheduled feed unit: at each cadence tick the scheduler runs it with **no
call-time input** and it produces items, stored under the Stream's own id. Streams have global
identity and are freely reusable across Channels (harvest once, view anywhere). A Stream
aggregates ≥1 Sources under one `strategy`:

- **`fanout`** — harvest ALL member Sources, merge + dedup (a discovery feed spanning several
  platforms).
- **`exclusive`** — members are a priority ladder; only the first Source that successfully
  responds wins (one podcaster's playlist reachable through two mutually exclusive RSSHub
  routes). Health is tracked per Source in a global ledger (`src/source-health-store.ts`);
  degraded/dead members are skipped and re-probed.

Both strategies return the same shape (a batch of items); they differ only in the combine rule
(union vs first-success). That is why they are one concept with a strategy field, not two
concepts.

**Storage shape** is a second, independent axis: `mode: 'feed' | 'collection'`.
`scheduler.modeOf(streamId)` is the sole authority — a Stream's own `mode` wins when set, else
it derives from any member Source's manifest declaring `mode:'collection'`, else `'feed'`:

- **`feed`** (default) — an unbounded timeline: each harvest persists only genuinely-new items
  (dedup-gated append), and ItemStore evicts down to a rolling per-stream cap (`capPerStream`,
  500) so storage stays bounded.
- **`collection`** — a bounded upstream set (a playlist, a podcast's full back-catalog, a
  favourites list, a ranking board): each harvest re-fetches full depth and the result is
  written via `ItemStore.replaceStream` — the stream's stored items are rebuilt wholesale in
  upstream order, not gated by dedup — and the Stream is excluded from the all-latest timeline.
  Replacement is **per member source's shard**, and it is **not unconditional** — see below.

**collection 的替换有两道闸门**（`src/collection-replace-guard.ts`，2026-07-30 spec）。一个空快照
有两种截然不同的来源，而替换层看到的形状一模一样：上游真的空了（该替换）vs 上游抽风/本轮根本
没采到（替换 = 数据丢失，2026-07-24 怡乐 1015 条）。所以：

1. **采集侧给成功指针** — `AdapterFetchResult.authoritative`（缺省 true）。错误路径继续抛错；
   decline 路径（环境缺席 / Browser-Fallback 关 / 隔离中）返回 `authoritative:false`。非权威结果
   **不替换分片、不进请求缓存、不记 health**，只走 `onHarvestSkipped` 出声。
2. **替换侧兜"近乎全空"** — 权威但新快照 0 条而旧分片有货时，第一轮只保住不替换，**连续两轮**
   都这么说才真替换。真清空只晚一轮生效。刻意**不按缩水百分比拦**（会误伤真实的大幅删减）。
   armed 位 per (stream, source)，持久化在 `stream.db` 的 `collection_guard` 表。

两层都经通用事件层出声（`harvest.snapshot-held`），`dedupeKey` 里编进 reason 这个终态。

`strategy` (how members combine) and `mode` (how the result is stored) are orthogonal — a
`collection` Stream can still be `fanout` or `exclusive`. **There is no `Stream.kind`**, and
nothing else implies collection-shaped storage on the side: not an `audio` flag, not
`manifest.ordering==='snapshot'`, not an item-count ceiling. `manifest.ordering:'snapshot'`
exists ONLY as a loader read-alias to `mode:'collection'` (`src/manifest/loader.ts`). Consumption
routing — which view a Stream's items render in (timeline feed vs audio player) — is a
**separate** authority: `Channel.present` (see Channel above).

## Provider

Provider 的实现选择不由调用方硬编码的 Provider id 决定。代码声明稳定的 **Callsite** 合同（输入/输出、variant、固定或按 key 分发），`stream.db.provider_bindings` 保存 Callsite 到 Provider 的用户可编辑引用；调用方先解析 binding，再复用同一 `ProviderExecutor.invoke()` / `collect()` 执行。这样 Provider 行内的 Source 顺序与 dispatch Callsite 的 Provider 路由顺序保持两层独立，且可从任一端反查引用。被 binding 引用的 Provider 不可删除；内置默认 Provider/binding 可恢复，但不是永久锁定行。

**频道级槽位覆盖全局 binding（2026-07-24）**：`ProviderBindings.fixed()`/`.dispatch()` 都接受可选
`{ channelId }`；带了且该频道 `options.slots[callsiteId]` 非空 → 用槽位指定的 Provider 集合替代
全局 binding（parked 行同样在槽位路径被过滤，语义与全局 binding 一致）；不带 `channelId`、或该
频道没填这个槽位 → 回落全局 binding，行为不变。HTTP 层只有携带频道语境的调用点（Video Present
的搜索/播放解析、音乐播放解析等）在 query string 上传 `channelId`；MCP 全局搜索、radar 富化等无
频道语境的调用点不传，永远走全局 binding。调用计数仍只在执行器内打点，槽位路径同样被计数覆盖。
被任一频道槽位引用的 Provider 与被 binding 引用的 Provider 同规则不可删除（`DELETE
/api/providers/:id` 的 `409 error.details.channels` 列出引用的频道+callsite）。

**槽位废 = 显式报错,绝不静默回落（spec §5.1）**：槽位是用户显式意图，槽里挑不出任何可用行
（全 parked/已删）时不回落全局 binding、也不回落调用点写死的默认值——抛 `SlotBrokenError`，
HTTP 层接住转成 `422 slot_broken` + `provider.slot_broken` Bell 事件（Bell 全端点覆盖；
toast 目前只接在资源搜索面，其余端点靠 Bell）。

A Provider is a **global, call-driven, on-demand capability**, expressed as **one config row**
(与 Stream 同构，2026-07-03 设计收敛并落地):

```
身份（category / serves 键 / fallback / strategy / contract / expand）
  ├─ 系统 Provider：住代码 —— src/providers/system/ 一条一个模块（SYSTEM_IDENTITIES 静态表）；
  │   行上的身份字段只是落库副本，读写两侧都以代码为准（PATCH 身份字段 → 400 响亮拒绝）
  └─ 用户自建 Provider：住行上（它没有代码）
编排（members / options / binding）：一律住 stream.db 的行上，用户可编辑、可分享
调用点 = 自身 category（编译期身份） + 路由键提取函数（输入 → key） + 一句 invoke()
分发   = ProviderDirectory.match(category, key, {fallback}) —— 选行判据的唯一入口：
         具名 serves 键命中优先；无命中且调用点显式传 fallback:true 才落兜底行，
         命中结果带 viaFallback 进账本/DebugBox。'*' 只是兜底布尔的线上/落库形状。
```

- **variant** 决定输入/输出签名与默认 strategy：`search`（查询词 → 条目列表，并发合并）、
  `resolve`（key → 一个对象，顺次首胜）、`download`（ref → 资产，顺次 + contract）、
  `transform`（内容 → 内容，顺次）。`timeline` 不是 variant——那是 Stream。
- **members** 四型：`{source}` 显式源成员、`{matches}` radar 匹配段（按 URL pattern 实时展开
  命中的源）、`{mode:'auto', provides:X}` 派生段（声明 `provides: [X]` 的源实时展开入列，新装
  插件自动加入）、`{provider}` **组合成员**（一个 Provider 引用另一个 Provider）。前三型全部展开
  成 Source；`{provider}` 是**组合闭包**——执行器**递归 `invoke()`** 子 Provider（黑盒：子的
  strategy/门禁/去重是子的内部语义,父层不复制），子的 items 型结果并入父。递归带访问路径,**防
  自引用/环/超深**（`MAX_COMPOSITION_DEPTH`,越界抛错、不进 invoke 循环）；被 `{provider}` 成员
  引用的 Provider 不可删除（与 binding 引用保护同构）。成员参数以 `$input` 洞声明绑定,输入值由
  调用点在调用时给——绑定归行定义,输入归调用点。调用点给的输入若是一个**普通对象**（如
  `video.resolve` 的 `{vid, format}`、`content.enrich` 的 `{url}`），非 builtin 成员收到的是
  空键 + 该对象整个展开进 `params`（`memberCallArgs`，`src/providers/invoke-types.ts`）；
  builtin 成员的实现函数则直接拿整个输入对象。
- **认领 → 派发：链接先认领，再按键派发**。「用户贴一条链接」这类调用点分两步：**认领**回答这条链接是哪个包、
  哪个平台、什么类型、id 多少——只有一张表（各包的 `stream.links`）、一个函数（`recognizeLink`，
  `src/links/recognize.ts`），宿主不认识任何站；**派发**用认领结果拼键（`<platform>-<名词>`：`content.enrich`
  用 `<platform>-link`、`video.resolve` 用 `<platform>-video`、取歌用平台键），交给声明了那个键的 Provider 行。
  任何声明里都不写域名形状的键。没人认领的链接走宿主的通用兜底（直链媒体 / 网页正文）。曲目识别与下载中转页
  同样只吃认领结果。`radar`（这页能订阅成哪个源）与 `serving`（这台 CDN 主机的字节怎么送）回答的是别的问题，
  不在这张表里。声明形状与校验见 [PACKAGE.md](PACKAGE.md) §0.5「`links`」，设计见
  `internal design record`。
- **多实例成员与 per-instance key**（LLM 归一化，2026-07-27）：`{source}` 成员可选带 `name`——
  同一个 Source 可以在一行里出现多次，各带不同 `params`，寻址键（去重、排序、
  `options.exclude`、调用账本）一律用 `name ?? source` 取，不是裸的 sourceId。`llm` 行正是
  这么用的：`llm-openai`（OpenAI 兼容 Source）配多个实例，各自 `params.{baseUrl, model,
  tokenName}` 自足描述一个端点，互不共享配置。key 落点是**成员实例**而非整个 Source：manifest
  声明 `runtime_config.perInstance: true` 的 Source（今天仅 `llm-openai`），一份 key 存在
  `params.tokenName` 指向的那一层（约定 `<ref命名空间>:<实例名>`，如 `llm:<实例名>`），不是
  `runtime_config.ref` 那层——`GET /api/providers` 的 `resolvedMembers[].keyState`
  （`stored`/`env`/`missing`）按 `keyRefOf`（`src/credentials/key-state.ts`）取的就是这一层，一个
  实例缺 key 不牵连另一个。调用点（`llm.summarize`/`llm.chat`/`netdisk.spec.suggest`）可在
  binding 上带 `params.model` 覆盖，赢过成员自己的默认——模型选择因此下放到"这次调用要哪个
  模型"，不是"这条连接固定哪个模型"。注意 `params.model` **只换型号名，不换端点和钥匙**：换到
  另一家（另一个 baseUrl + token）是"换成员"，不是改这个覆盖。对话通道就是这么换的——每条
  会话记一个**成员键**（`GET /api/agent/models` 的 `member`，存在会话表的 `model_member` 上），
  输入框左下角那个开关写它；存键不存型号，型号是成员自己的参数、会被改。**不变量**：实例名与 auto 段（`{mode:'auto', provides}`）
  展开出的真实 source id 共享同一个寻址命名空间——`name` 撞上任何已注册 source id 时写入侧拒绝
  （`422 name_shadows_source`），因为寻址键一撞车真源会被这个实例悄悄顶掉、行为异常但界面上看
  不出来（`name` 等于自己的 `source` 不算撞，等价于不写 `name`）。详见 [API.md](API.md)「LLM
  设置」一节与 `internal design record`。
- **strategy `expand`**（依赖式 A→B 组合子,provisional）：作用于有序两成员 `[A,B]`——invoke A →
  每个 A-item(handle)按 `expand.map` 的 `$item.<field>` **纯字段取值**参数化 B（不引入任意求值,
  守"数据拿不到 ambient capability"红线）→ invoke B → B 的 items 经 `expand.assemble` 装配进该条
  的 `links[]{url,type,desc}`。有界并发 + handle 封顶 + 单钻失败/超时跳过。契约按第一个消费者
  （btbtla:搜索出季卡片→逐条钻详情页取下载行,产 pansou 多链接形状）够用而定,待第二样本收敛。
- **成员结果两种形状**（2026-07-17 能力归一化）：**items 型** = 条目数组（`[]` = decline，
  既有全部成员）；**object 型** = 一个判决/结果对象（`null` = decline，探针与解析器——判决
  不穿 item 的衣服）。形状由 Source 的 `manifest.output` 声明（recipe 侧对应
  `output:'object'`），执行器缝上解包。`resolve` variant 的成员应当是 object 型（key → 一个
  对象本来就是它的定义）；存量数组形状的 resolve 成员机会性迁移。
- **contract**：命名的结果合格判据（如 `{accept:'lossless'}`）——不合格视为 miss 落档。
- 运行时是**一个执行器**（`src/providers/executor.ts` 的 `invoke()`）：顺次分支 =
  decline/合同拒/抛错三类 miss 落档、首个合格结果携 `via` 返回；并发分支 = 全员合并、
  逐源归属。**调用计数只在执行器内打点**（`cache.db.provider_calls`），管理页据此验证
  调用点是否真实经过 Provider 行。
- **执行策略是可换件的注册表**（`src/providers/strategies/`，sequential/concurrent/expand
  三件内置,`BUILTIN_STRATEGY_NAMES` 驱动写入校验）——加一个新策略不改执行器本体。横切
  （超时 / 分类 / 健康记账）不住在任何一条策略里,统一收在单成员管道 `member-pipeline.ts`
  （碰成员的唯一口子）,三条策略共用同一份。**降级读法是熔断,不是重排**：顺序永远是行里
  定的原序,`SourceBreaker` 只按健康账本裁决"这个成员这一下试不试"（只吃错/超时,空不触发,
  冷却随连败递增且有封顶,绝不永久降级）。权威设计见
  `internal design record`。
- **`ResolveEngine`（`src/resolve/engine.ts`）吃同一套件**,不是第二条各写各的梯子：
  `resolve()` 是原序逐档 + 同一个 `SourceBreaker` 裁决（整表走 `plan()`：冷却中跳过；全员冷却时
  强行试冷却剩余**最短**的那一档——一次调用至少真实试一档）。那条兜底不变量只有一个实现
  （`forceProbeShortest`）,顺次策略吃的是同一份——它逐成员 `admit` 只为豁免组合成员。
  成员调用走 `member-pipeline.ts`。
  **超时只吃 manifest 自报的 `member_timeout_ms`,不设全局缺省**——resolve 的调用方全是交互式的
  （`GET /api/resolve`、MCP `resolve_target`；周期采集走 `Scheduler.fetchSource`,不经这里）,
  确实可能被挂死的源拖住;之所以还不设全局闸,是墙钟上限眼下有两套并存的表,值定在哪一层要随
  `project planning record` 那条一起定,先设第三个数只会再多一套。resolve 的"空 = 这一档答不了这个 key,
  落下一档"照旧,空永不触发熔断。
- **`collect()` 不是第二种语义,是全收（并发）语义下的另一种结果形状**：`invoke()` 把合格结果
  合并成一个 items 数组,`collect()` 保留「哪个成员给的哪份」的成对结构,供**按来源合并字段**的
  调用点用（影视详情三行就是：TMDb 与 OMDb 都要跑完,再按声明顺序填空)。顺次（首胜即停）语义
  下 collect 自相矛盾——"逐个问但一个都不停"那不是顺次,是并发。两侧都响亮拒绝：执行器分发处
  `strategy.collect` 缺席即抛（带策略名与行 id）,绑定写入侧由 `PROVIDER_CALLSITES` 的
  `collect: true` 标记 + `ProviderBindings.validateSelection` 提前拒（全局 binding 与频道槽位
  共用这一条,槽位不另立规则）——别让"绑了一条首胜行"拖到详情页真去取数时才炸。

The litmus test against Stream is **trigger + result ownership**, not parameter count. A Stream is
time-driven (T1) and persists feed items; a Provider is call-driven (T2) and returns results to its
caller. A Provider invocation carries no durable per-call state in the user-data model, but its

### Video detail enrichment

Video work details keep the same ownership split: a Stream owns discovery, episode rows, and
availability (netdisk, magnet, external link, or a future local playback Stream). Discovery only
stores its list-facing facts (`videoRef`: title, explicit work year/kind, source URL, and native
authority IDs). It never triggers metadata traffic.

Netdisk availability, however, does not *require* a Stream. A binding's left side is「where the
episode list comes from」, a discriminant — not「a subscribed Stream」. `left.kind:'stream'` reads
the list from ItemStore; `left.kind:'tmdb'` reads it from the TMDb authority, so an un-subscribed
movie or series binds a netdisk folder and plays without ever becoming a Stream. The alignment
engine never learns which — it only ever consumes `LeftEntry[]`. This does **not** introduce a
sixth top-level concept: 「a film」stays un-modelled (its identity already lives, cache-shaped, in
`video_details` keyed `tmdb:<id>`); the discriminant names a *source*, not an entity. Design:
`internal design record`.

富化有**两个触发点**，都落到同一份缓存上：打开详情页（cache miss 时现场跑），以及**采集把条目写进
读模型的那一刻**（`VideoEnrichQueue`，挂在 Scheduler 的 `onItemPersisted` 上，范围是视频频道的成员
流）。后者是列表侧封面和中文名的来源——只有一行标题的源（奖项名单之类）自己交不出图，不在采集时
富化的话，没被点开过的作品在墙上永远是灰框。队列只对缓存已过期的身份发请求，按 cacheKey 去重，
失败只记日志：它是背景动作，没有资格拖慢或拖垮一轮采集。

On a detail cache miss, the `video-canonical` resolver receives those facts and verifies an
authority-side TMDb/IMDb reference without fetching the discovery page. Its evidence may include
localized titles, aliases, explicit year/kind, and normalizer-provided people; a non-verifiable
candidate is a miss, never a fuzzy substitution. The `video-metadata` Provider and then the
`video-images` Provider receive the resulting confirmed IDs to supply normalized metadata,
posters, backdrops, and logos. Member order is merge priority even when a Provider is concurrent.
The combined result is cached in `stream.db` table `video_details`, keyed by the discovery lookup
so the next detail open returns without another Provider call. Future local embedded artwork and
screen grabs join `video-images` as Sources—no Stream or detail-page rewrite. Ranking feeds,
including Douban rankings, remain discovery inputs rather than detail metadata Sources.
implementation MAY reuse a facility-scoped runtime resource such as a logged-in browser session.
It MAY also be parameterless: Home recommendation is the canonical example.

*行模型的落地范围：`stream.db.providers` 存整行，`/api/providers` 全套 CRUD + 匹配预览，
音频双链 / 三类搜索 / magnet / enrich-url / ResolveEngine 都经行执行并计数。**尚未**经行走的能力：
parse(MinerU)、transcribe(ASR)、enrich 富化聚合、summarize(LLM)——它们「异步排队 + 落库」的形状
不适配 invoke，管理页的"待迁移"区标着各自的调用位置。*

### 影视页找资源（video resource finder）

绑了 AList 的剧集走 `gateResolveOnlyVideoMedia`（`src/content/video-playability.ts`）：对齐执行器
配上文件的集能播，没配上的是一张「网盘未匹配」灰卡。灰卡上的「找资源」按钮直通既有的
`/api/search?scope=resources&stream=1`，影视二级页 hero 上另有一个整剧维度的同名入口。

**去重在后端，过滤在前端**——两件事性质不同，别合并：

- **去重是数据质量问题。** `resource-search` 跨源去重（`src/video/dedupe.ts` 的 `Deduper`，键由
  `dedupeKey` 给出：磁力取 btih、ed2k 取 file hash、网盘取分享 ID）。插在 `extract → aggregate`
  之间，批量路与流式路共用 `src/video/facet-source.ts` 的 `facetOneSource`。重复对谁都是脏的，
  所以 MCP `video_search` 那条 AI 路同样受益。两条路的顺序语义**有意不同**：批量路按 Provider
  成员声明序（确定性），流式路按到达序（先到先得——要按声明优先级就得等齐，废掉流式）。
  `VideoSourceTiming.dropped` 把「全是重复」与「无结果」分开，否则全重复的源会谎报 `status:'empty'`。
- **过滤是「我这台机器能用什么」的视图问题。** 允许集 = `GET /api/netdisk/mounts` 的
  `searchableSourceTypes`（`src/netdisk/source-types.ts`：magnet/ed2k 无条件 + AList **实际挂载**
  的 driver 映射出的类型）。真相源是 `listStorages()` 而非 `MOUNT_PRESETS`——presets 只是挂载
  助手的清单，手挂的百度/阿里也该被认。过滤动作在 `app/src/lib/resourceFilter.ts`，**逐链**走
  `links[]`（pansou 一条消息常带混合类型链接，按条目过滤会误杀「首链百度、但也带夸克」的结果），
  存活首链重新镜像回 `link`/`sourceType`/`password`。AList 不可达 → 退到 `{magnet, ed2k}` 并标降级。

结果面板是 `app/src/components/ResourceFinder.tsx`（摊平分面树、一键复制）；`VideoChannel`
挂在全局搜索，是另一个入口。

**链接 → 文件这一段，网盘剧集已经通了，磁力/ed2k 还没有。** 搜索返回链接不是文件：网盘链接靠
转存变成文件（人手动点「转存」，或追更循环自动转存缺集，见「追更循环」一节），磁力/ed2k 仍然
没有下载器接住，落不了地。文件一旦落到 AList 上，后半段（对齐执行器 → resolve URL → 灰卡变活）
是通的。验活=recipe（热插数据，quark/baidu 都走这条），转存=代码（实现选择，非禁令——写效应
一档的口径是「recipe 也可写账户」，见「能力归一化」一节）。
设计见 `internal design record`。

### 归档器（reconciler）：文件落到网盘之后，谁把它挪到该在的地方

转存只是把文件放进了共享上游目录；「按集身份认出它、归到认领货架还是第二货架、同集多份择优、
真重复静默清掉」是另一段活，落在 `src/netdisk/reconcile/`——三层模型。**整理的对象是一条绑定**，
不是"一个节目"：影视一键去重是「无暂存区、无第二货架」的退化配置，和播客整理共用同一套代码，
不是平行实现。

- **认集只有一个脑**：「这个文件是哪一集」由**绑定匹配器**（`src/netdisk/match-engine/`：
  证据层收全事实 → 裁决层按规则表 R1–R14 判，时长主锚 + 名字地板 + 阈值体系，
  见 `docs/MATCHING.md`）回答，用的谱和绑定同步是同一份
  （`sync.ts` 的 `resolveSpec`）。**归档器不许有自己的判定逻辑**——它只把结论落成动作。
  要改判定就改谱，绑定与归档器一起变。
- **分组键**（`src/netdisk/identity.ts` 的 `makeIdentity()`）：内建通用清洗（水印/噪声括注/标点/
  异体字归一/小写化）+ 来自绑定 `MatchSpec` 的标题前缀剥离与集号正则。它**只做分组键**：人工豁免
  按它存、字节全等重复按它判"是不是同一集"。
- **输入池**：来源目录（只读扫描，`sourceDirs`，**可选**——不配就是原地模式，只在认领货架自身的
  文件里挑赢家、判删落选副本，没有搬运）**∪ 认领货架（`claimed`）现有文件**——库内那份是不是
  这一集，同样只能由那一个匹配脑说。第二货架（`secondary`）不进池（它的契约就是"不配对"），
  只用来判字节全等重复和同名占位；这条绑定没配 `secondary`（如影视）就没有这一层。
- **归档**：`plan.ts` 的 `buildPlan` 是纯函数，顺序为 豁免/墓碑 → 字节全等重复（`delete-dup`）→
  跑一次匹配器 → 四个筐（`claimed` 进认领货架、`offline` 进第二货架——没配 `secondary`
  则判定照记、原地不动；`copy` 三道闸门（正主在架、质量可比、配上集才算重复）全过 → 判
  `delete-loser`（同集只留质量最高那份；质量平手时留**名字对得上这一集标题**的那份，判据见
  `docs/MATCHING.md`），任一道不过转人裁 `compare` 并排对照；`hold` 时长未知
  下轮续探）。`execute.ts` 只在这之后按 plan 真正调 AList move/remove。设计见
  `internal design record` 与
  `internal design record`。
  - **去向只有三个**：认领货架、第二货架、子节目目录（外加 `delete-dup`/`delete-loser` 两种删除，
    不是"搬去哪"而是直接移除）。子节目（独立编号体系 + 独立文件夹）的 `numPattern` **只选
    目的地、不豁免匹配**：命中它只是把 `claimed` 的落点从认领货架根换成子节目文件夹，认领本身
    照样由匹配器裁。做成"名字命中即认领"的前置 pass 就是第二个判定脑——错身文件被按名字认领
    原地不动，正确那份永远 `swap-hold` 等一个不腾空的位置（死锁）。
  - **两个货架的真实契约是不同的**，名字讲的却是来历，读的时候要翻译一次：`claimed` = **要跟
    节目单配对的那些**（绑定的落地目录，匹配器只看这里，播客影视通用必有）；`secondary`
    （播客场景下即「下架」）= **不配对、文件自己就是一集的那些**——它本身被当作一个 alist source
    采进来（`packages/alist/normalizer.ts`），每个文件直接变成一条可播 item。所以「挪去 `secondary`」
    不是让文件消失，是把它换到另一条路上；这也是为什么"没配上"可以是自动且安全的默认结果。
    `secondary` 是可选概念——影视没有，认不出的文件原地不动、永不删。
  - **两个货架的地址不在归档器的配置里**（spec §6 P8）：`claimed` 的地址是绑定的 `right.path`
    （绑定属于解析层，它的活是给收费集补音频/视频）；`secondary` 的地址是该订阅那条**下架
    stream** 扫的目录（下架集是权威清单的补充来源，本身就是一条扫网盘的 stream）。归档器每轮
    现解（`ReconcileService.shelvesOf`），配置里只有 `sourceDirs`。左侧来自 TMDb 的绑定
    （`left.kind:'tmdb'`，典型是影视）天然没有「下架」这个概念，`secondary` 留空、不报错；左侧
    来自订阅流（`left.kind:'stream'`）却解不出下架来源、或地址撞了来源目录——就停下报错，不拿
    别处的路径顶上：没有 stream 在扫的目录，文件搬进去不可播、不在任何清单里，等于从用户眼前
    消失。
  - **`durationS === undefined` 是"没探到"、不是"时长不对"**：只能进 `hold`，永远不进 `offline`
    ——否则一次夸克凭证过期就会把一批好文件挪下货架。
  - **绝不往已有同名文件的目录里搬**：`executePlan` 的 move 按 `(srcDir → dstDir)` 分组、组间
    顺序不保证，同轮对搬会撞名。撞上就降级 `pending swap-hold`，下一轮自然落位——**除非占位
    那份本轮就被无条件删掉**，那时它提升回 `move` 并带 `evicts`，执行器先删后搬、删没成这条
    搬运也不跑（换槽位，判据见 `docs/MATCHING.md`）。
  - **多季影视绑定（`left.kind:'tmdb' && media:'tv'`）落点与改名走另一套规则**：认领的集不落
    认领货架根，落 `tv-<id>/S<nn>/`（`<nn>` 取匹配器判给它的 leftKey 里的季号，两位补零）；
    `auto` 认领时给文件名加 `S03E14 - ` 前缀（原名原样跟在后面，绝不把标题塞进去——和谐规避
    的理由不变），已带**正确**前缀的不改，前缀与引擎判断**打架**（名字写 S03E14、引擎判它是
    S03E15）出 `pending`（`evidence-conflict`），不搬不改名——名字和引擎打架时不许机器单方面
    改写证据。「同一集」的判据也换了：配上集的文件按匹配器给的 leftKey（`tmdb:<id>:S03E14`）
    判同集，跨季两个都叫「第7期」天然不撞；没配上集的文件原地不动，只在**同一目录**内做字节
    全等去重（`delete-dup`），永不参与 `delete-loser`/`replace`——落选副本必须是引擎认定的同一
    集才算。归档器与绑定同步**走同一条季分区匹配路**（先按叶子文件夹定季、再每季单独匹配，
    见 `docs/MATCHING.md`「多季影视归档」）——一锅裁决会把跨季同期号的文件判成同一集。文件名
    里带「纯享」的是另一条播放线、不是那一集：它们进 `tv-<id>/纯享/S<nn>/`，不加编号前缀，
    也不走落选副本那一路（除非引擎把它认成了某一集的正主，那时它就是那一集）。改名
    （`rename` 动作）与移动一样先记溯源，一轮里的全部动作共享一个 `run_id`，可整轮撤销
    （`POST /api/netdisk/reconcile/undo-run`，按 rowid 倒序）。

**对账式，没有独立进度账本**：来源目录本身就是待处理队列，每轮重新扫描 + 重新决策，幂等靠文件系
统现状而非记录"上次处理到哪"——这也是为什么 `runScheduled` 可以每天整份重跑而不必对齐续跑点。
`service.ts` 落三份状态，全在 `data/netdisk.db`（网盘域一域一库，与 `stream.db`/`cache.db`
并列——绑定/绑定条目/整理配置/裁决/账本/审计/时长缓存共七张表，设计见
`internal design record` §4；各 Store 对外 API
不变，只换底座）：
**决定账本**（`decisions` 表，人工 `exempt`/`tombstone`，命中即跳过、不动不报）+ **溯源**
（`run_actions` 表，每次 move/delete 一条，携带匹配依据 `basis`，支持 `undo`）+ **运行账本**
（`reconcile_runs` 表，每次 preview/execute 一条，同时原样进 API 响应）。运行账本是"这一轮到底
发生了什么"的唯一落点：每个进入本轮的文件恰好一行（含无动作的）、`conservation` 自证
`input === 各筐之和`、`authority` 记清单条数/付费数/时长覆盖率、`errors` 收探测失败与 AList
报错——**错误是行，不是日志**。另有两位管「这一轮算不算数」：`trigger`（`'scheduled'` /
`'manual'`）和 `gated`（清单健康闸挡下的那轮，带 `reason` + `detail`）。**权威清单的健康闸拿它们
挑基线**——只有没被闸住的定时轮和手动执行当得了基线，判据见 `docs/MATCHING.md`
「输入失真时归档器怎么降级」。

默认**观察档**（`autoExecute:false`）：定时任务只报告数量、不动文件，需人工在 UI 确认后显式
`execute`（或事后把某个 show 配成 `autoExecute:true` 真正自动落地——但删除类动作即使
`autoExecute:true` 也必过一次「将删清单」预览确认，搬运和字节全等重复不受这道闸拦）。路由
`/api/netdisk/reconcile/*`（config/preview/execute/undo/provenance/decisions，见
`src/http/netdisk-routes.ts`）；另有 `/api/netdisk/reconcile/bindings/:bindingId/preview|execute`——
不依赖预配置的整理 show，直接对任意一条绑定跑一键去重（UI 入口：MovieChannel 作品绑定菜单、
整理面板「扫全部绑定去重」）。调度任务 `netdisk-reconcile`（`0 30 3 * * *`，互斥组 `netdisk`——
与网盘同步、追更共用那份登录态，同时只跑一条；见「调度中心」
一节）每天一次跑 `runScheduled()`，按 show 汇总一条通知（`dedupeKey: reconcile:<show>`）——
定时轮永远不会自己删掉质量落选的同集副本，只报数量。

### 追更循环（follow loop）：找资源 → 补集 → 归位，人只打一个开关

TMDb 剧集绑定上有一个「追」开关（`MappingSet.follow.enabled`）：新建的 tv 绑定默认开，存量绑定
迁移默认关，电影绑定永远没有这个字段。开着的剧，系统自己判断哪几集已播出但还没拿到、回访已知
分享、找不到再搜新分享、只转存缺的那几集、同步归位，结果推成通知——人不点搜索、不点转存，只
决定追不追。实现在 `src/netdisk/follow/`：纯策略在 `plan.ts`（无 I/O），执行在 `service.ts`。

**已播出但没拿到，判据是**：`entries` 里没有已认领文件、且 `airDate` 存在、且 `airDate ≤` 今天。
**`airDate` 缺席不算已播出**——TMDb 没给日期时宁可漏追，不能拿"缺席"当"还没播"来搪塞，也不能
当"已经播"去瞎搜。

一轮（`FollowService.runOnce`）依次：

1. **同步 + 算缺集**：先 `sync` 一次拿最新分集与当前配对，算出 `missingAired`。空 → 本轮结束。
2. **回访旧源**：账本里没标记「不可用」的每条分享逐条验活、递归列目录（深度上限 3、每层 200
   条）。候选池是**这条分享里还没转存过的全部文件**（`savedFids` 之外的），不是"上次没见过的"
   ——上一轮见过但当时没配上（还没播）、或转存失败的文件，这轮照样要认；「比上次多了几个文件」
   只是给人看的数字。喂给匹配引擎对缺集配对，命中的进转存清单。
3. **找新源**（仅当回访后仍有缺集）：缺集落在哪几季就搜哪几季（缺得多的季先搜，最多 3 季），每季
   查询串 = 作品名 + 第N季（阿拉伯数字与中文数字各试一次，见 `docs/MATCHING.md` 判据），走
   `/api/search?scope=resources` 同一个批量搜索函数，只留支持转存的网盘、验活、算「这条分享覆盖
   几集缺集」，按**覆盖数 → 覆盖文件字节之和 → 该分享总配对数**排序取前 3 条。
4. **转存**：只提交命中的文件，不整份转存。落点是绑定右侧目录**下与分享同名的子文件夹**（文件在
   分享里的 `第三季（4K）/xxx.mp4` 就落到 `tv-<id>/第三季（4K）/xxx.mp4`），不平铺进作品根——根
   目录里可能已经躺着别季同名的「第7期上」，而认集时靠的正是那个季文件夹。夸克那一侧的三条硬约束
   （`shared/netdisk/quark/save.ts`）：文件 token 绑在取它的那次会话上，转存前一律用自己的会话按父
   目录重取；提交按分享里的父目录分组、每组带各自的 `pdir_fid`；`status 2` 不等于全到了，实报的
   落地数（`save_as_sum_num`）写进结果。
5. **同步**：转存是夸克那边的异步任务、AList 再慢一拍，所以转存后最多同步 6 轮、每轮隔 10 秒
   （`RESYNC_ATTEMPTS` / `RESYNC_INTERVAL_MS`），认出来就停。
6. **归档**：首次 `sync` 没失败就跑，不论本轮有没有转存到新文件——调
   `reconcile.executeBinding(setId, { losers: true, gated: true })`：`losers:true` 让同集落选
   副本自动删进回收站（用户拍板，无人介入，夸克回收站约 10 天兜底）；`gated:true` 走定时轮
   `netdisk-reconcile` 同一道权威清单健康闸，被闸住就只记账不动文件。结果记进
   `follow_runs.archived`（`{runId, moved, deleted, renamed, gated?}`），归档器未装配 → 记一行
   错误、不影响本轮转存结果。归档搬了 / 删了 / 改了名，说明有文件刚落进季文件夹，多同步一轮把
   它们认出来。`netdisk-follow` 与 `netdisk-reconcile` 两条定时任务对同一条绑定加**按绑定的
   互斥锁**（`ReconcileService` 内 `Map<bindingId, Promise>`，进程内），后到的等前一个跑完，
   不会一个在转存、一个在规划搬删地并发改同一目录。
7. **轮末裁决**（spec `2026-09-03-netdisk-llm-adjudicator`）：归档之后，把归档待定卡与本轮判成
   `pending` 的追更候选（分享里有货、但置信度不够自动转存的文件）打包问一次模型，结论过代码闸
   后落决策账本；归档卡过闸的立刻重跑一次归档，追更候选过闸的直接转存到货架。裁决器没装配
   （`deps.adjudicate` 结构类型注入缺席）→ 跳过，不算故障。结果记进 `follow_runs.adjudicated`
   （`{runId, asked, applied, rejected, unsure, failed?}`）；有采纳就多同步一轮把新落地/新裁定的
   文件认出来。详见 `docs/MATCHING.md` 「轮末裁决」一节。
8. **通知**：一条 `follow.round` 事件，`dedupeKey: follow:<setId>`，零缺集且零错误的轮不发。转存了
   文件但一轮都没认出（夸克还在搬 / 文件名认不出集号），标题如实说「转存了 N 个文件，还没认出集」，
   这种轮不计无果。归档搬了或删了东西，通知里附一句「归档：搬 N · 删 M · 改名 K」；被闸住则附
   「归档被闸：<detail>」。

**对话里也能开这一轮**：MCP 工具面上有 `netdisk_follow`（看 / 开 / 关 / 跑一轮）与
`netdisk_share_verify`（只读地验一条分享），骑的是 `FollowService` 自己那几个方法——账本、退避、
归位那一步全在方法里面，所以模型走的和定时轮是同一条路，不存在"绕过循环自己转存"这一档。
`run` 会真转存 + 按 `losers:true` 删落选副本，工具描述里写着「先跟用户说」。**`run` 开完就返回**
（回 `{started, setId, note}`）：一轮量级是分钟，而一次工具调用 200 秒就超时——等下去只会让模型
手里拿着一条「失败了」，而那一轮还在后台真转存、真删副本。结果去 `view` 的 `lastRuns[0]` 读
（那一行额外带 `errorList`）。同一条绑定已经在跑时回 `{started:false, alreadyRunning:true}`，
在跑名册是 `FollowService` 自己那一份（定时轮与工具面共用一个入口）。

**匹配引擎在无时长档下怎么用**：候选文件只有名字和大小，用绑定自己的 `matchSpec` 跑规则表，
时长证据缺席时走名字地板；**只接受 `status:'auto'` 的配对**，`pending` 一律不转存——宁可漏拿，
不乱拿，拿错的文件会占坑，漏掉的下一轮还能补。「认集只有一个脑」这条不变量不因为无时长而松动：
候选筛选与落地后配对用的是同一个 `NetdiskService.matchExternalFiles`。

**两本账本**（`data/netdisk.db`）：`binding_shares` 记每条绑定知道的分享（`origin: 'manual' |
'search'`、上次验活结果、已转存过的文件 fid），是回访的依据；`follow_runs` 每轮一行（缺集、回访
明细、搜索明细、转存明细、同步前后配对数、错误），通知与详情页都从它读，**错误是行，不是日志**。

**失败与降级**：
- 首次 `sync` 失败 → 本轮直接结束，不推进节奏、不动无果计数，下个周期原样再试。
- 夸克登录态掉了（`quarkSave` 回 `stage:'auth'`）→ 本轮剩余转存全部跳过，不计入无果轮数，另发
  一条 `follow.auth` 事件（`severity:'warn'`，`dedupeKey: 'follow-auth'`）。
- 验活/列目录/搜索/匹配报 `unknown` 或抛错（问不到答案）→ 记一行错误，但**不算无果轮**——「问不
  到答案」和「问到了、答案是没有」是两回事，前者不该拖慢节奏。只有真的问到了、答案是「这轮没补
  上任何一集」才计一次无果。

**节奏**（`follow/plan.ts` 的 `nextCheckAt`，纯函数）：

| 状态 | 间隔 |
|---|---|
| 有缺集且最近一集 `airDate` 在 3 天内（`FRESH_WINDOW_DAYS`） | 6 小时（`FRESH_INTERVAL_H`） |
| 有缺集，其余 | 24 小时 × 2^min(无果轮数, 3)，封顶 7 天（`BASE_INTERVAL_H` / `MAX_BACKOFF_POW`） |
| 无缺集，但有未播出的集（在播季） | 下一集 `airDate` 当天 20:00 本地时区（`AIR_CHECK_HOUR`） |
| 无缺集也无未播出 | 30 天（`IDLE_DAYS`，等 TMDb 加新季） |

调度：内置任务 `netdisk-follow`（每小时扫一次，只跑到期的绑定，`serial:true`）。**到期与否每次扫描按
当前分集现算**（`FollowService.dueAt`：锚在 `lastCheckAt`、按真正的今天判「已播」），不信上一轮存下的
`nextCheckAt`——两轮之间分集会变（人手 / 裁决器补上了缺集、TMDb 给占位补了日期、今天恰好是播出日），
存下的数只是那一刻的答案；现算出来不同就写回，面板显示的「下次检查」才是真的。刚打开开关时
`nextCheckAt` 被清空 = 立刻到期，这条不变。

**进度的分母只数已播出的集**（`follow/plan.ts` 的 `progressOf` / `isUnaired`，作品面板与 `netdisk_sync` 的
`bySeason` 同一把尺）：TMDb 先把整季占位列出来，还没播（airDate 在今天之后）或未定档（无 airDate）且盘上
没有任何候选文件的，不进分母、也不算缺，单独报 `unaired`；已配上或盘上已有候选的一律在分母里。

路由（未装配 `FollowService` 时四条全 503）：`GET/PATCH /api/netdisk/mappings/:id/follow`（看一眼 /
开关）、`POST /api/netdisk/mappings/:id/follow/run`（手动跑一轮）、`POST /api/netdisk/follow`（还没
绑定的剧：建作品目录 + 建空绑定 + 开关）。

**现状的限制**：先转存、之后才手动建绑定的分享不会进 `binding_shares`——账本只在「转存时就带着
`bind` 参数直接自动绑定」那条路上才写（`POST /api/netdisk/share/save`）；分开两步做的用户体验是
「转存成功但这条分享追更从来没听说过」。

## Source

A Source is one concrete callable entry, declared by a manifest entry in its package's
`packages/<id>/manifests.yaml` (or derived from a recipe's `meta`): id,
description (load-bearing for discovery/search), topics, capabilities, `auth` (credential
declaration), route/params schema, cadence hint. A Source belongs to exactly one Plugin
(`pluginId` is assigned by the backend catalog) and is only ever executed through it. Sources
are members — of Streams and of Providers — never subscribed to directly.

### 掉了登录态谁去登：`auth.login` 的三档

`auth: { type: 'session', login }` 说的**不是登录态存在哪**（浏览器档一律住在用户自己的
Chrome 里），而是**掉了谁出面**：

| `login` | 谁出面 | 形状 |
|---|---|---|
| `cookie` | 用户自己在 Chrome 上重登 | 只声明 `cookieDomain`；**不进重登面板**（点了没用） |
| `qr` | Stream 弹扫码面板，扫在这个 facility 自己那条采集 lane 上 | `loginUrl` + `qrSelector` |
| `oauth` | Stream 替他点掉"用 Google 继续"，骑浏览器里已有的第三方登录态 | `loginUrl` + `oauthButton` + `accountSelector`；**`account` 不在包里**，它是用户各自的邮箱，住 `runtime_config`，登录时现取 |

后两档共用一条装配路径（同一条 lane、同一个 Transport-backed 登录页，`src/kernel/plugins/auth.ts`），
差别只在 provider。**哪几档在重登面板里露面是一份具名的名单**：`PANEL_LOGIN_KINDS`
（`src/auth/facility-auth-view.ts`）——加第四档 login 时必须来这里回答一次「它需不需要 Stream
出面」，漏了的表现是 provider 注册了、能跑，但横幅永不点亮、面板里没有那一行，整条能力静默
地是死代码。运行经验（provider 不认识任何一种验证方式、`needsHuman` 的边界、活体量到的坑）
在 `.claude/skills/write-recipe/references/login-and-session.md`。

## Plugin

There is exactly **one unit of extension: the Stream package**. Builtin packages live in
`packages/<id>/` in the repo (directory named by the `packages_dir` config field, default
`./packages`); packages the user installs from npm live in `<dataDir>/recipes/<@scope__name>/`.
Both are scanned by the same scanner, described by the same `package.json#stream` field, and
loaded down the same path. A package declares which **capability slots** it fills: source
manifests, recipe data, code (`activate(ctx)`), a docker container, credential domains.

A **Plugin** is a package that fills ≥1 *plugin* slot — the judgement is the named predicate
`fillsPluginSlot` (`src/plugins/loader.ts`), **not** which directory it lives in. `/api/plugins`
lists only those (10 today, out of 29 builtin packages); pure recipe packages have their own
pages. A package may fill both projections at once (a recipe package that also ships a container).

A Plugin adapts one external facility into Stream. It is the **ownership and execution
boundary** of its Sources — every Source resolves to exactly one Plugin, and harvesting a Source
means running its Plugin's machinery:

- **adapter** (`packages/<id>/adapter.ts`, handed to the host by the package's `activate(ctx)`;
  only shared/core adapters stay in `src/adapters/`) — maps the facility's API to raw Stream
  items, dispatching on `params.mode`.
- **normalizer** (`src/content/<id>.ts`, registered in `src/content/normalize.ts`) — normalizes raw
  adapter output into the display model. Normalizers run **at ingest** and the normalized result
  is stored; changing a normalizer only affects newly harvested items.
- **managed backend container** (optional, declared under `stream.backend` in `packages/<id>/package.json`) —
  the facility's own published image (Stream never repackages third-party scrapers). Never
  hand-run: `pnpm plugins compose > docker-compose.yml && docker compose up -d` generates and
  brings up the whole active plugin set on the shared `stream` network, with health checks
  (that generated file holds **only** plugin containers — Stream's own backend/frontend run on
  the host; `--selfhost` emits the all-in-one form instead); the
  generated file holds **no credentials at all** — secrets never bake into images, into `env`,
  or into the compose. `pnpm plugins compose --dev` emits a bind-mount override for
  zero-rebuild development.
- **credential domains** — declared on the manifest (`auth: { type: cookie, domain }`) or on the
  descriptor (`credentials: [domain]`). Either way it is a **declaration of what the host may
  hand this package**, never a fetch path: the host is the only scheduler, it resolves the cookie
  a call needs and injects it (`init(env)` / `sidecar.start(creds)` / `ctx.cookieFor`). Nothing
  calls back into the host for credentials — see `docs/PACKAGE.md` §5.1.

Full package/plugin guide (slot contracts, worked example + template): `docs/PACKAGE.md`.
Gateway & port rules (`expose` vs `publish`, one host port `127.0.0.1:8900`, troubleshooting order): `docs/GATEWAY.md`.
Dev/prod container runtime & how deps reach the container (add-a-dependency flow, anonymous-volume staleness): `docs/DEVELOPMENT.md`.

## Intent（意图）

订阅的单位有两层：Stream 订阅的是**源**（"这个播客的 RSS"），Intent 订阅的是**目的**（"我想追某类
内容，不管它从哪冒出来"）。一个 Intent 聚合 ≥1 个 Stream（一部分是手动绑的已有 Stream，一部分是
招源订到的），本身不采集，只消化其名下 Stream 已经采到的 item。它不是 Channel 的替代——Channel
仍是"怎么看"（present + 渲染），Intent 是"看完之后哪些算数、沉淀成什么"，两者相互独立、都可以
指向同一批 Stream。

- **招源（recruit）在本机源注册表内找源，一次调用直接落订阅**：注册表按 `goal+criteria` 搜（取前
  30 条候选）→ LLM 从候选里挑最多 5 条 → 逐条验参（`params_schema.required` 里的字段缺值即丢弃，
  宁缺毋滥、不猜参数）→ 查重（已订过同 source+等值 params 的流 → 复用，不再新订）→ 试吃闸
  （`previewSource` 空结果或报错即丢弃）→ 首次真订时懒建意图专属频道 `intent-<id 前 8 位>`、把新
  流订进去 → 记录 `subscribed`/`reused`/`dropped` 并发一条事件（零命中也发，讲明是候选池空还是
  全被闸门挡下）。落地在 `src/intent/recruit.ts::runRecruit`。
- **退休（retire）把 `status` 置 `retired` 并回退招源产生的订阅**：下线该 Intent 招源订到的每个
  流（`recruitedStreamIds`，手动绑的不动）、删掉意图专属频道；单个回退失败只记日志、不回滚整个
  retire。`intent-digest-scan` 只扫 `status: 'active'` 的 Intent，退休的不参与，但仍可手动触发一轮
  消化。
- **criteria 是立意图时一次性生成的**：`goal`（用户原话，不改写）交给 LLM，产出 `criteria`（白话
  判定标准：什么算相关、什么明确排除）。criteria 之后只读不改——消化的每一条判定都靠它，不存在
  跑一半标准变了的情况。LLM 不可用时 Intent 不立（create 直接抛错），不留一个没有判定标准的空壳。
- **注解是意图驱动的，没有通用标签体系。** Stream 层的 item 不带"相关/不相关"这类通用字段；相关性
  只在某个 Intent 的账本里成立——同一条 item 在意图 A 的账本里可能是 relevant，在意图 B 的账本里
  从未出现（因为 B 根本没订阅那个 Stream）或被判 not relevant。判定标准不是全局分类器，是这一个
  Intent 私有的尺子。
- **消化产物 = 账本 + 档案，两者性质不同**：
  - **账本**（每 Intent 一份，键 = itemId）记录"这条 item 判过了、结论是什么、摘要是什么"。**账本
    即增量游标**——一轮消化只处理不在账本里的 item，不需要额外的"上次消化到哪"指针；判定失败的
    item 不入账本，下轮自然重试，不会因为一次 LLM 抖动永久漏判。
  - **档案**是**累积改写的认知**，不是逐条摘要的堆叠日志：每轮消化把新的相关内容并入既有档案，
    由 LLM 重写出一份更新后的整体认知（读者是人，不是"第 N 条：…"的流水账）。档案先于账本写入
    ——一轮里合并档案失败则整轮不落账本、`lastDigestAt` 不推进，下轮全量重判（零丢失，代价是
    重复判一次）；合并成功但落账本失败则相关内容已经进了档案，不会因为账本没写成而在档案里消失。
    写档案前把当前版本留一份 `dossier.prev.md`（同目录，覆盖式，只留上一版）——LLM 重写出问题
    （如把档案改坏、清空）时能对照上一版核实或手动恢复。
- **调度**：每 10 分钟跑一次全量扫描（`intent-digest-scan`，`src/tasks/builtin.ts`，接入通用
  「调度中心」，与 Data Scheduling 的 T1/T2/T3 无关——它不产出 Stream item，只是驱动"该消化的
  Intent 去消化"这件运维性周期活），到期判据是 `lastDigestAt + cadenceHours*3600s <= now`（或从未
  消化过）；单个 Intent 消化失败不打断其余到期的 Intent。消化本身（`IntentService.digestNow`）单槽
  串行——手动触发的消化与巡检共用同一个队列，避免同一时刻打多轮 LLM。一轮消化最多判 `maxJudged`
  （生产传 100）条，超出留给下一轮（账本天然是断点）；截断发生时（`remaining > 0`）本轮不推进
  `lastDigestAt`，下一次 `intent-digest-scan` 会判它仍然 due、立即接着排，不必等整个
  cadence——否则日产量超过 `maxJudged` 的 Intent 积压只会越攒越多。`listItems` 每个 stream 只取
  最近 200 条（窗口），两轮间某 stream 新增超过 200 条时最旧的条目会被永久漏判——`runDigestRound`
  检测到窗口整窗都是未判条目时会记日志并在 `DigestOutcome.windowSaturated` 里报出该 stream。
  一轮里判过的条目全部失败（`errors === judged`，通常是 LLM 端点整体不可用）算失败轮，触发指数
  退避：`digestBackoffUntil` 从 30 分钟起、每连续失败一轮翻倍、封顶 4 小时；退避期内该 Intent 被
  `scanDue` 跳过（不占用整点扫描的重试预算）；出现一次成功判定即清零退避计数。
- **落地**：`src/intent/`（`types.ts` 数据形状、`store.ts` 持久化——JSON 落盘，Intent 清单一份
  `intents.json`，每个 Intent 各自一份 `ledger.json` + `dossier.md`、`llm.ts` 四原语
  `parseIntent`/`judgeItem`/`mergeDossier`/`pickSources`、`digest.ts` 一轮消化的纯函数、
  `recruit.ts` 注册表内招源的纯函数、`service.ts` 服务面）。
  HTTP 面 `/api/intents*`（7 条路由，见 [API.md](API.md)）。MCP 面三个工具：`intent_create` /
  `intent_list` 走通用 catalog，`intent_dossier` 因为要把 markdown 原文直送客户端（不能被
  `json(...)` 信封转义）而单独手注册在 `src/mcp/server.ts`，与 `stream_subscribe` 同一类"形状不同
  故 bespoke"的先例。招源与主动消化不进 MCP 面——那是后台调度或 HTTP 操作，不是查询。

## 配置分享（stream-bundle）

Plugin/Recipe 分发的是**能力**（分发层只读声明）；**配置分享**分发的是上面一层——用户在
`stream.db` 里攒的**编排**（Channel/Stream/Provider 闭包）。代码在 `src/sharing/`，路由挂在
`/api/sharing/*`（`src/http/sharing-routes.ts`）。设计：`internal design record`
（闭包/包格式）+ `2026-07-24-import-decision-ledger-design.md`（导入台账）。

- **分享单位** = Channel/Stream/Provider 任一为根，沿 `stream_ids → members → {plugin,source}` 收闭包。
- **包形态** = 单个 `stream-bundle/v1` JSON（form B）：代码型 Plugin 只进 `requires.plugins`（声明+版本约束、塞不进），数据型 Recipe 整份内嵌 `embedded.recipes`（对方开箱即用）。判定唯一走 plugin-source-catalog。
- **凭证红线**：包内**永无**任何 cookie/token/apiKey 值——`auth:cookie` 域与 `runtime_config` 只翻成 `requires.credentials`/`runtimeConfig` 的需求声明（schema）。导出对 `members.params` 做敏感字段体检，命中即拒。
- **传输 host 无关**：导入接受 URL（走 `ownedFetch`，不特判 host）或本地文件。
- **两轴冲突**：配置行 id 撞车 → remap（生成新 id + 改写包内引用，绝不动本机已有行；system 频道 stream_ids append 复用、槽位键级合并——本机未配的静默并入，已配的落 slot-conflict 待拍板）；recipe 版本撞车 → semver 合并（升/复用/跨 major 停并落 notice）。
- **导入零执行**：导入只写配置行 + 落盘内嵌 recipe；recipe 只在被引用 Stream 下次 T1 tick 才跑。
- **import decision ledger**（`src/sharing/import-run-store.ts` + `decide.ts`）：一次导入 = 一个可寻址 run，
  遗留事项统一为 items（`parked-provider`/`slot-conflict`/`notice`，各带 mine/theirs/choices）；decision 是
  唯一状态迁移，执行失败不半提交。落一份**本机私有 JSON**（数据目录，不进 `stream.db`/`cache.db`），离线、
  不外发。API：`POST/GET /api/sharing/imports*` + `POST /api/sharing/imports/:id/decisions`。UI 导入结果页
  与 AI「帮我导入并处理」吃同一份数据。

**外部前置依赖（未落地）**：recipe 包的 **author-scoped 身份**（`@author/facility` + semver + integrity）
归 `recipe-packages` spec，是另一个 change。本分享层的冲突接口已按 scoped id 写好、内嵌装载先兼容
当前 facility 单包形态；前置落地后把 binding 的 `plugin` 位换成 `@author/facility` 即启用三分支，
**不需重写冲突逻辑**。提交侧（预填 issue/token 静默提交）、一键发布、中央 registry 均本期非目标。

### 能力搭车（capability-share，config-sharing v2）

分享包可选搭载作者的**能力层**——因为 Provider 是**全局路由**（按 serves+variant 在 callsite 处
dispatch），加一个改变对方所有同变体频道的行为，**不能照搬 Stream 的加法语义**。三层 dispatch 里只
有 callsite 是代码（应用契约、两边都有、不进包）；binding 与 Provider 行是数据、才搬。

- **顶层可选块** `providers` / `providerBindings`（与 `channels` 平级、**不进频道闭包**）——只由作者
  **显式勾选**加入，且只收 `system!==true` 的行。
- **park-on-import（趴着进）**：导入的 Provider 打 `options.parked=true` 落库，但**被所有 serves
  匹配/枚举点排除**（`ProviderExecutor.match`→`listActiveProviders`、`ProviderBindings.dispatch`、
  `/api/provider-callsites` 选项逐处过滤 `isParked`），导入后对方路由**逐字不变**。binding 覆盖落
  `options.candidateBinding` 候选，**不写生效的 `provider_bindings`**。
- **激活时才解冲突**：每个 parked Provider 在导入 run 里落一个 `parked-provider` item（choices：用导入的 /
  用本机的 / 按序并存 / 先不管）；`GET /api/sharing/imports/:id` 实时投影 serves 重叠 / 候选 binding 抢占的
  冲突体检，decision 执行激活（清 `parked`、按需写 `provider_bindings`），其间对方 dispatch 不变。

**后继**：网盘对齐 binding 的分享（`netdisk-binding-share`，change B）复用本节的「顶层可选块 + 显式
勾选 + 趴着进」地基——见下。

### 网盘 binding 搭车（netdisk-binding-share，config-sharing v2 · B）

分享包顶层可选 `netdiskBindings` 块携带 `MappingSet` 的**可移植子集** `left + matchSpec + 仅人工订正
entries`（+ 可选 `shareUrl`）——**零 fileId、无 `right.path`（作者本机 AList 路径）、无凭证**。成立靠已验证
的真相：`matchSpec` 是规则（对 `{name,size}` 匹配）、`rightFile`/`right.path` 是路径/文件名身份、转存保
目录树。导入把每项暂存为 `right` 未解析、`autoSync:false` 的 **pending MappingSet**（**导入零执行**：不
转存/不 sync/不采集），回一份待转存清单；对方用自己夸克登录态转存 → 挂 AList → 走**既有** `rebind` →
`sync` 用随包 matchSpec **确定性重算**完成首绑，**不重跑 AI、不改对齐引擎**（`sync.ts`/`mapping-store.ts`
零改动）。stream-left 且 stream 未随包 → 告缺/落 notice item（tmdb-left 无此问题）。

至此 **config-sharing v2 收束**：A（自定义 Provider 能力搭车）+ B（网盘 binding 搭车），二者共用「顶层
可选块 + 显式勾选 + 导入不改对方现状（Provider 趴着进 / 网盘暂存 pending）」这一套分享安全地基。

## Invariants

1. **Entry-point rule** — every subscription and invocation names a Channel. When a user
   subscribes to a bare Stream, the system implicitly wraps it in a same-named single-member
   Timeline Channel; a "standalone Stream" is UI shorthand only.
2. **Plugin is the sole ownership edge** — a Source belongs to exactly one Plugin; the frontend
   and upper layers never guess ownership from id prefixes. (Established in
   `openspec/specs/plugin-source-catalog/`; see `docs/PACKAGE.md` §8.)
3. **Stream vs Provider criterion** — what triggers execution, and where do results land?
   T1 time-driven + persisted feed items → Stream. T2 call-driven + returned directly → Provider.
   Call-time params are common for Providers but are **not** the discriminator: a parameterless
   recommendation invocation (for example a logged-in Home Feed) is still a Provider when it runs
   only on demand and its ephemeral results are never persisted as feed items.
4. **Trigger exclusivity** — every data acquisition is initiated by exactly one of the three
   scheduling triggers (T1 tick / T2 invoke / T3 enqueue — see [Data Scheduling](#data-scheduling)).
   No other code path fetches. A second standing harvest loop is by definition a bug.
5. **归堆永不阻止入库** — 同质内容归堆（下节）只回答「这几条摆一格还是摆三格」，
   永远不回答「这条存不存」。后者只属于 `DedupStore`。合并这两者的后果是跨平台采到的
   第二份被当重复丢在入库那一步，连「他也发到 B 站了」这个事实都存不下来。

## 同质内容归堆 (story fold)

**转载、搬运、同一件事的多份拷贝，只占一格。** 代码在 `src/story-fold/`，权威设计见
`internal design record`。

- **它是呈现层的能力**，不是采集层的：只产出「谁和谁是一堆、代表是谁、为什么」，
  一条内容都不删（`rep + members` 展开等于输入，测试钉着这条）。
- **和 `DedupStore` 的边界**见上面不变量 5。一个管「存不存」，一个管「摆几格」。
- **骨架通用，阈值不通用**：证据器（url-identity / title-dice / 以后的媒体指纹、
  作者身份、语义）是共用的，每个场景配一份自己的 `FoldProfile`。一个阈值通吃
  「转载」和「同作者不同内容」必然误并。
- **序列身份是判据的命门**：数字 + 第 X 季/期 + 上下集（中文数字归一）对不上 → 一票否决，
  跑在任何相似度之前。**站点不是判据**——百家号/搜狐号/网易号是「一个域名、无数个发布者」，
  转载最密的地方恰好都在站内，所以「同一档节目的两集不许并」全靠这道否决扛着。
- **同站的「标题像」只算疑似，要第 2 档抓正文确认**（`titleNeedsTextConfirm`）：同一个号
  天天更新的栏目标题只换尾巴词，实测搜狐两天的「每日一练｜时事政治模拟题」Dice 0.857
  越过 0.85，题目却完全不同，而序列身份挡不住它（标题里一个号都没有）。降级后这一对在
  第 1 档各自成堆，自然流到第 2 档，不另开确认通路。**跨站不降级**（标题像就免费并完，
  那是第 1 档存在的价值），**同一个链接也不降级**（URL 同一性是事实）。
  降级由 `withSameHostTextConfirm` 按第 2 档到底可不可用来置位：**第 2 档缺席就不降级**——
  没人接得住的「疑似」等于把同站的标题相同转载永久拆开。
- 字面相似度公式全后端只有一份：`src/text/similarity.ts`（网盘认集与归堆共用同一把尺）。
- **判据：折叠只在消费端能展开时才生效**——没有展开入口就折，等于把内容无声藏掉。

**两处挂点，两份场景档**（`src/story-fold/profiles.ts` / `inbox.ts`）：

| 档 | 挂在哪 | 主力证据 | 消费端 |
|---|---|---|---|
| A 搜索折叠 | 网页搜索梯子出口（`src/search/web-search-ladder.ts`） | 三级阶梯，一级比一级贵、前一级判不动才轮到后一级：**① URL 归一 + 标题 Dice**（本地零请求；同站的标题证据降级成疑似，交给 ②）→ **② 正文最长共享块**（`story-fold/text-fold.ts`，抓正文）→ **③ 问模型「是不是同一篇稿子」**（`story-fold/semantic-fold.ts`，零抓取、一发调用） | MCP `web_search` / 对话 agent / search_agent（共享一个出口） |
| B 收件箱归堆 | 采集那一跳只**记账 + 排队**（`scheduler.ts`）→ **后台 worker 判**（`story-fold/worker.ts`）→ 账本 → `/api/items` 投影 | **媒体对媒体走声学指纹**（chromaprint，判「同一份录音」，见 spec）；其余对走**文本**（正文 / 转写） | 前端列表（`app/src/lib/storyFold.ts`） |

### 档 A 的第二道判据：比正文（`src/story-fold/text-fold.ts`）

链接和标题判不出来的那些——**门户转发、聚合站、镜像站会重拟标题**，两条的 Dice 只有 0.3，
正文却是同一段话。这一档就是来救它们的。

**判据是「最长连续共享块」≥ 130 字，不是草图 Jaccard**（`src/text/shingle.ts` 的
`longestSharedRun`）。理由是量出来的：网页正文抽出来必然拖着一身样板（导航、推荐位、
免责声明、股吧滚动条），**整篇算的 Jaccard 对真转载只有 0.076–0.14**、对「各写各的同一件事」
是 0.006–0.016，两个数都贴着 0，中间没有能安全下刀的地方；换成最长共享块，同一批数据是
**246 字 vs 11 字**。样板文字（「投资者据此操作，风险自担」这类）都在几十字量级，够不着门槛。
档 B 仍用草图，因为它两边不同时在场、只存得下指纹——**两把尺各有各的场景，别互相替换**。

- **抓正文用来救第 1 档判不动的那些**——标题不像的转载，以及**同站那些「标题像但只算疑似」的**
  （见上一节）：`fold()` 先跑，只在**剩下的堆代表之间**补判。
  成本因此是 O(堆数) 次抓取，不是 O(对数)——比对免费，抓取才要钱。
- **候选闸门**（`worthFetchingText`）两条：两边都抠得出 host（抠不出的是磁力/非 http，
  本来也抓不了正文）、序列身份不冲突（第 2 集和第 3 集正文可能很像，这道硬否决必须跑在
  花钱之前）；**不设标题相似度下限**（"标题完全不像"正是它存在的理由）。上限 12 篇，
  按输入序（＝相关性序）截断。
- **同站的一对先剥掉共同页眉页脚再比**（`sharedStoryRun`）：同一个站的任意两个页面天然共享
  一整段样板，而它足够长，**自己就能越过门槛**——实测澎湃 484 字、网易号 209 字（三对内容
  毫不相干的同站文章之间一字不差），百家号 66 字、搜狐 37 字。四个站的样板**都正好是两篇的
  共同后缀**，所以剥的是量出来的那一截，不靠名单也不靠结构标记。剥完还剩 ≥ 门槛 = 正文里
  真有一大段一样。共同边长过较短那篇一半时反过来认它是正文（同站一字不差的转载）。
  跨站一律不剥——两个不同站的共同后缀是内容，不是样板。
- 转成文字复用 `read_url` 背后那一份（`makeArticleFetchDep`），不另造抓取器；草图按归一化 URL
  缓存在进程里，同一个地址一次进程只抓一次。
- **抓不到 = 判不了 ≠ 不像**：失败、超时（8s）、正文太短（<200 字，多半是拦截页/登录墙——
  两个站撞上同一屏「Just a moment…」会相似度 1.0，字数门槛就是防这个误并）都只让那一对
  保持原样。整段兜底，绝不把一份好好的搜索结果变成 error。
- 关灯开关 `STREAM_SEARCH_TEXT_FOLD=0`（默认开）：关掉只是退回「只比链接和标题」。
- **「各写各的同一件事」不在这一档的射程内**（NHK 自己写的稿 vs 通稿转载：最长共享块 8 字）。
  那是设计里的第三种同质，别指望调这里的门槛把它们并起来——第 3 档也不做它，见下。

### 档 A 的第三道判据：问模型（`src/story-fold/semantic-fold.ts`）

**同一篇通稿被 AI 重写过**，字面上就不剩什么了：活体实测新浪原样转发共享 **246 字**、
搜狐让 AI 重写后只剩 **17 字**，而「各写各的同一件事」是 **6–11 字**——17 和 11 挨在一起，
**这条线上没有能下刀的地方**，所以判据只能从「字面」换成「意思」。

三档问的**始终是同一个问题：这是不是同一份内容**。第 1 档看链接，第 2 档看字面，第 3 档看意思。
**「两家各自采写同一件事」三档都不并**：那是两篇不同的稿子，各有各的采访和角度，两篇都该看得见。

- **零抓取**：只吃第 2 档已经抓到的那批正文（按归一化 URL 查表），没正文的堆不参与。
  它的全部成本是**一次搜索最多一发模型调用**（走 `llmContentQuiet` + `story-fold.semantic`
  调用点，模型可单独绑定），不是每对问一次。
- **模型说了也不算数**：序列身份这道硬否决在**问之前和拿到答案之后各跑一次**。
  同一档节目两集的正文开头几乎一样，模型没有条件分辨——分辨那件事靠标题里的号。
  同站样板不会污染这一档：递给模型的是正文**开头** 600 字，而样板都在页尾。
- **evidence 的 kind 是 `semantic`，绝不混进 `text-identity`**：这一档是问出来的、不是算出来的，
  可信度天然软一档，看的人要能一眼分清是哪一级下的判断。
- **判不了的一切形态保持原样**：没配 LLM、梯子全 decline、超时（20s）、回话读不懂、
  正文没抓到。绝不变成 error。
- 关灯开关 `STREAM_SEARCH_SEMANTIC_FOLD=0`（默认开）。
- **已知的软肋**（活体实测）：模型会往「同一件事」滑——同一场采访的两家不同写法有时被判成同一篇稿子。
  prompt 里那条「删掉一篇会不会丢信息」是收住它的主力判据，改 prompt 前先读
  `semantic-fold.ts` 的头注。
- **同站放开之后新出现的代价**：标题相似度这一档不看站点了，于是**同一个站里两条标题极像、
  却又没有任何序号可以区分**的内容会被并掉。活体真样本：搜狐 `a/613889193_121124005` 与
  `a/577012683_121124005` 是两天的「每日一练｜时事政治模拟题」，题目完全不同，标题 Dice
  0.857 → 被并。序列身份对这一类无能为力（标题里没有号）。

### 档 B 的判据：内容身份 = 内容本身（文本或波形）

**同一条内容被重新投放时，标题会被改写、封面会换、时长会因转码/剪片头差几秒、链接必然
不同——只有内容本身不变。** 身份按形态落在两种判据上：

- 文字类内容：正文本来就在，白拿；网页链接走正文抓取。判据是文本草图
  （`src/text/shingle.ts`，MinHash，每条存 64 个数）。
- 媒体对媒体（两边都是音视频）：声学指纹（chromaprint，`src/media/audio-fingerprint.ts`），
  比的是波形不是文字——本地零模型调用，编码差异/片头错位天然鲁棒。设计见
  `internal design record`。
- 跨形态对（一边文章一边音视频）：媒体侧走转写取文本再比文本；超 20 分钟的媒体受成本
  闸门保护（`src/story-fold/text-source.ts` 的 `maxMediaSeconds`），这类对判不了。

**标题和时长退成候选生成器**（`store.neighbors` + `worthChecking`），一个字都不参与结论。
这条是被活体打出来的：拿时长当判据时，两个歌单共享几十首歌，四分钟左右的歌互相乱折，
一个堆滚到 22 条。**时长从来不是身份。**

**取文本是有代价的**（转写实测平均 16s、最慢 142s），所以：

- 判据搬到**后台 worker**，不在采集热路径上；
- **只给有候选的条目取文本**——一条 item 没有任何候选，就永远不会被转写；
- 复用 `extract` 那条链路（自己判分支、自己缓存、转过一次不重复计费），不另造转写；
- 太长的音视频（>20 分钟）暂不取文本，于是**判不了**（不是判成"不是同一条"）。
  抽段转写落地后这条闸门放开。
- **「判不了」和「不像」必须分开**：前者留在待判队列等文本，后者出队。混成一个，
  等文本的条目会被当成已经判过而永远不再看。

**作者不参与判断。** 同一条内容就是同一条，谁发的不改变这件事——搬运号发的和本人发的
本来就该收在一起。「来源」在归堆之后只剩**一个**用处：**看哪个源在同质内容上持续先发**
（`source_lead` 表 → `GET /api/story-fold/leaderboard`；列表里门面那条标一句"首发，早 N 小时"）。

**这条线一个字都不问用户。** 两个源常发同一条内容这件事，靠并堆次数自己攒
（`story_pair`）——观察得到的事实没有理由做成一个待办去打扰人。

档 B 的几条硬规矩，破一条这个能力就变成"内容会莫名消失"：

- **同一个 Stream 内永不归堆**——一个 Stream = 一个源 + 一个账号，它自己的两条按定义
  就是两条内容。这道闸门不依赖任何阈值，比阈值可靠。
- **collection 流（歌单/收藏夹）整个不进这条线**。它们是**目录快照，不是发布事件**：
  一首歌出现在两个歌单里，说的是"这两个歌单都收了它"；而「谁先发」算出来的是**用户
  两次收藏之间隔了多久**。2026-08-13 活体上真这么算过一轮，领先榜煞有介事地报了
  "平均领先 15253 秒"。判据放在 `scheduler.ts` 的 collection 分支——那里刻意没有归堆那一跳。
- **代表 = 发布最早的那条**，每次并入/拆堆都重算。不是"我先采到的那条"——那只反映采集
  顺序（谁 cadence 短谁先被采到），和"谁先发"无关，而这条线要回答的正是后者。
- **一对只记一次领先**：两条都在待判队列里，先判的那条已经并了它们；后判的那条若再走
  一遍，同一对的"谁先发"会被记第二次，领先数直接翻倍。已归堆的条目直接出队。
- **人工拆堆要记否决**（`story_fold_veto`）：只删归属的话，下一轮采集照原判据合回去。
- **代表不在当前页时，成员照常显示**（前端）：堆的代表可能在分页之外，藏起来就是
  "这条凭空消失了"，而且没有找回的入口。
- **并列不硬分先后**：同一秒发出来的只记源对、不记领先。判谁快是编造精度。
- **时长永远不是身份**，它只是把候选集缩到个位数的检索键（2026-08-13 活体上当过一次
  判据：两个网易云歌单共享几十首歌，此后任意两首四分钟左右的歌被折成一堆，一个堆滚到
  22 条）。判据只有文本。

账本全部住 `cache.db`——**纯附加，删光就回到没有归堆的样子**，而且里面没有一格是用户
手输的（同质关系和领先度都是从采集到的内容自己攒出来的，删了重跑一遍采集就有）。

## Data Scheduling

The single authority on **when data moves, what drives it, how fetch parameters compose, and
where results land**. Historically this was never defined, so parallel engines and ad-hoc param
plumbing accumulated; this chapter is the contract every acquisition path must satisfy.

### Triggers — exactly three

| | Trigger | Driven by | Executor | Results |
|---|---|---|---|---|
| **T1** | `tick(stream)` | time (`cadence_seconds`) | Scheduler | persisted to ItemStore under the Stream's id |
| **T2** | `invoke(provider, key)` | a call site | Provider executor | returned to the caller — never stored as feed items |
| **T3** | `enqueue(job)` | a call site, long-running | a job queue | persisted to the job's dedicated ledger |

- **T1** — fanout: harvest ALL members (fetched concurrently; persisted sequentially through the
  shared dedup), merge. One failing member degrades the tick, it does not fail it — a tick errors
  only when every attempted member failed. On scheduled ticks a repeatedly-failing member backs
  off exponentially (skip 0/1/3/… ticks, capped); a manual refresh always attempts every member.
  exclusive: members are a priority ladder — start at the first healthy rung, fall through on
  hard error, first success wins; non-healthy tops are re-probed every K ticks. Failures degrade,
  never fail the Stream. Cadence timers are chained (next tick arms after the previous finishes —
  a slow harvest can never overlap itself) and first fires are jittered so same-cadence Streams
  don't volley in sync.
- **T2** — sequential: try members in order; decline / contract-reject / hard error are three
  miss kinds that fall through; first qualifying result returns with `via` provenance.
  concurrent: all members run, results merge with per-item source provenance.
- **T3** — *declared contract only* (details live in each capability's own spec): triggered by a
  call, queued with a persistent job ledger, idempotent on a job key, results land in dedicated
  ledgers (audio archive, transcripts, parses) that deliberately outlive feed items. The
  still-planned Provider capabilities (parse / transcribe / summarize) are T3-shaped — their
  async queue + persistence is why they don't fit `invoke()`.

### Parameter composition — one pipeline, one precedence

Every fetch's effective params compose in this order (later wins):

```
defaults            manifest params_schema defaults (the single home of per-source defaults)
⊕ source-config     per-source invocation values (cross-plugin, schema-validated; never runtime secrets)
⊕ policy            scheduler-injected scheduling policy (e.g. harvest backfill limit) — T1 only
⊕ member bindings   the row's bound params; constants on Streams,
                    `$input` holes filled with the key on Providers
⊕ call-time extra   the caller's own params — T2 only
```

Member bindings outrank policy on purpose: an explicitly bound param is a statement of intent;
policy fills gaps, it never overrides configuration. Effective params feed both `adapter.fetch`
and the cache key — two fetches with different effective params never share a cache entry.

### Harvest policy (T1)

A Stream MAY declare `options.harvest = { backfillLimit?, incrementalLimit? }`. The scheduler
injects `limit` per the pipeline above: `backfillLimit` on **first harvest** — defined as *no
item ever persisted under the Stream's id* (durable dedup count, no extra state field) — else
`incrementalLimit`. A failed first harvest persists nothing, so the next tick retries the
backfill (idempotent). Streams without `options.harvest` are fetched with unchanged params —
the policy is strictly opt-in (meant for slow-updating archives, not busy feeds).

### Caching

Cache key = `(adapter, source id, effective params)`. TTL derives from the manifest's cadence
hint, clamped [5 min, 24 h] — and on T1 it is additionally capped by the Stream's own
`cadence_seconds`, so a user-set cadence below the floor still gets a real fetch every tick.
Concurrent identical fetches collapse onto one in-flight request. Live previews (Stream/Source
preview) fetch **fresh** — they bypass the cache-hit check (still joining any in-flight fetch,
still refilling the cache) because a preview answers "what does the source say NOW".
**A cache hit never moves health** — health reflects the upstream facility, not our cache.

**Per-item enrichment** goes through `ContentCache` (`src/content-cache.ts`, `content_cache`
table in cache.db — the regenerable side): a tryGet-style `(namespace, key) → fact` cache with
per-namespace TTL, schema `version` (bump = all old rows become misses, no migrations),
optional negative caching and optional stale-fallback. Consumers register their namespace in
their own `wire*` function so the spec lives next to the projection it describes (current:
`article`, `favicon`). Invalidation is entirely mechanical — TTL, version bump, or the user's
explicit refresh (`fresh`); no module ever "remembers to clear" a cache. **Red line: cache
stable facts only — never signed/expiring CDN URLs** (that class of value is resolved live;
it is why the embedded RSSHub's content cache stays disabled). Deliberately OUTSIDE this
pattern: T3 ledgers (artifacts, not caches), DiscoverCache (SWR product semantics),
AList link caches (TTL owned by the upstream signature), and `video_details` (a richer
organism — canonical pipeline, partial writes, four-state reads — that would lose capability
squeezed into tryGet).

### Health accounting

Only real acquisition attempts write the health ledger: T1 harvests and T2 ladder attempts.
Ad-hoc reads (UI preview, MCP browse, doctor views) pass `recordHealth=false` and never
contaminate it. The ledger drives the exclusive ladder's starting rung and re-probe cycle.

### Persistence

- **T1** → normalizer (at ingest) → ad-filter → dedup → ItemStore keyed by stream id; a
  `feed`-mode Stream dedup-gates and appends (evicting to `capPerStream`), a `collection`-mode
  Stream calls `replaceStream` and rebuilds that source's shard each harvest — **subject to the
  two replace gates** (success pointer + near-empty) — see Stream → storage shape above.
- **T2** → returned to the caller; never stored as feed items.
- **T3** → the job's dedicated ledger; no FK to evictable feed items.

### Read state — per-Stream unread watermark

`StreamSeenStore` (`src/stream-seen-store.ts`, own sqlite in the user data dir) persists, per Stream,
the highest ItemStore `seq` the viewer has seen. It is **Channel-agnostic** — any view can ask a
Stream's unread state via `ItemStore.newCountSince(streamId, seenSeq)` (count of items inserted after
the watermark) and advance it via `POST /api/streams/:id/seen` (→ `maxSeq`). The watermark only
advances (`max()`), so re-marking is idempotent. First consumer: the video Channel's **正在追的**
section, where `/api/channels` attaches `newCount` to a video Channel's non-ranking members (its
presence is what marks a Stream as "followed") and the badge clears on open. `seq` (not `timestamp`)
is the key so counts are robust to missing/unreliable publish dates.

### 存量查询 —— 读「已经采集进库的那批」

`ItemStore.search({ streams, author, q, since, until, limit, order })` 是**按条件读存量**的唯一
入口：过滤维度 AND 起来，按发布时间（`timestamp`，缺省回落 `created_at`）排序，回
`{ items, matched }`——`matched` 是 limit 之前的全部命中数，消费方靠它说「共 N 条，这里给了 M 条」。

- **实现是朴素的 SQLite LIKE，不是 FTS5**，这是量过之后的决定：活体 13k 行 / 190MB 的
  `cache.db` 上，作者过滤 ~140ms、正文关键词 ~93ms。FTS5 要建索引 + 迁移，还要与四条写入路径
  （`add`/`addMany`/`replaceStream`/`rewriteItems`）保持同步，而那种漂移是**静默**的。
  **重评触发条件：这条查询过 ~500ms，或表过 ~10 万行**（写在 `src/item-store.ts` 的头注里）。
- `q` 只扫 title / `body_text` / `content.text`，**不扫整份 json**——`raw` 里是上游原样 payload，
  扫它会把 url、id 和无关字段一起命中。
- **消费方**：MCP 的 `inbox_search`（`src/mcp/inbox-search.ts`）。它把每条投影成瘦身回执
  （id/stream_id/title/author/timestamp/url/excerpt，excerpt 截断了就标 `excerpt_truncated`），
  **绝不带 `raw`/`body_html`/`content.media`**：一条条目的完整 JSON 约 850 字符，几十条就能把
  一轮对话的上下文撑爆。频道过滤在那一层解析（频道 id 或用户嘴里的名字 → 它引用的 stream
  集合；认不出就把现有频道列进回执），ItemStore 自己不认识频道。
- **正文给多少，按 `planExtract` 的分支给**（`shared/extract/plan.ts`，「这条 item 的正文该怎么取」
  的唯一权威）：`inline` 档（正文本来就在条目上）给到 1000 字并在没截断时标 `full_text: true`
  ——**明说别再对它调 `extract`**；其余分支（音视频/图片/外链，正文真要跑一趟转换才有）给 300 字。
  两档不分家的代价实测过：模型对 8 条纯文本帖调了 10 次 extract，每次只是把同一段文字原样再取
  一遍。**回执里的"下一步"也是承诺**——指一条对这类数据不成立的路，模型就会照着走。

### Live preview (no store)

"看看展示效果" before committing: fetch a Stream (or one ad-hoc source with unsaved params),
normalize it, and render it in the UI exactly like the Channel timeline — **without writing
anything**. This is the read-side counterpart to T1: same fetch + normalizer path, none of the
persistence.

- **Scheduler** — `readStreamNormalized(streamId, { limit })` fans out over the Stream's
  members, normalizes each, merges newest-first (no dedup — a preview shows raw overlap), caps at
  `limit ?? 20`. `readSourceNormalized(sourceId, params)` does the same for a single source with
  ad-hoc params. Both call `fetchSource` **without `recordHealth`** (invariant above) and
  collect per-source failures into `errors[]` (classified via `classifyError`) instead of
  throwing — a partial preview still renders.
- **Service** — `StreamService.previewStream` / `previewSource` delegate verbatim (MCP-reachable).
- **REST** — `GET /api/streams/:id/preview?limit=` and `POST /api/sources/preview`
  (`{ sourceId, params }`), both returning `PreviewResult { items, errors }`.
- **UI** — a「预览」button per Stream (the channel's 配置 tab) and in the source config sheet opens a modal
  that reuses the timeline's `PostItemRow`; failures surface through the shared `Warnings` panel.
  Nothing touches ItemStore or the health ledger.

### Browser Recipe execution (session-backed T2)

A **Recipe** is a versioned, declarative execution contract owned by the replay plugin. It records
how a Source uses a logged-in browser session: session requirements, ordered browser actions,
simultaneous observations (Network response bodies, page state, or DOM fallback), output mapping,
and validation/drift guards. Recipe remains the product and file-format term; the architecture does
not introduce a parallel top-level "Workflow" concept.

**drift 的判定不是一次布尔。** 一步的 `expect` 落空、或整趟判 `blocked`/`drift` 时，runner 会先
按一张**状态图**认一眼当前页面（`src/replay/state-*.ts`；今天只有内置的 Cloudflare 三档）：认出
死路或有逃生口的障碍，结论就翻成 `challenged`，而不是 `drift`。这是一条**架构级判据**，因为两边
代价极不对称——判 `drift` 会让 `RepairLedger` 连着几次把这个源**静默隔离**，此后它返回
`items:0 + errors:[]`，和「跑成功了、但确实没搜到」一模一样；判 `challenged` 只是等一次 facility
冷却。这一步**排在 `loginCheck.wall` 探测之前**：具体的先于笼统的。整套模型见 `docs/ENGINE.md` §6。

These axes are independent:

- **Source** is the externally meaningful entry point (`xhs-home`, `xhs-search`). A Source MUST NOT
  be duplicated merely because the same entry can be observed through DOM, XHR, or page state.
- **Recipe** is the Source's execution contract. One package MAY contain private reusable recipes
  such as `xhs-detail`, shared by multiple Source entry recipes and not exposed in discovery.
- **Session** is runtime state. A recipe declares `one-shot` or facility-scoped `persistent`
  lifecycle and `unattended` / `interactive` visibility; the session manager, not the recipe
  runner, owns the Chrome tab lifetime. There is exactly ONE browser — the user's own Chrome over
  the extension relay; Stream ships no browser of its own (see `docs/ENGINE.md` §2). The relay has
  exactly one peer at a time, and that peer is Stream's own backend: the relay, the four
  `cdp_look`/`cdp_shot`/`cdp_act`/`cdp_pages` verbs (all four tiers: chrome/facility/webview/
  desktop) and the extension's `/api/ext/verify` gate all live in the backend, with the
  chrome-tier implementation and the tools' descriptions/param schemas in
  `shared/browser-relay/` (`cdp-chrome.ts`, `tool-specs.ts`); see `.claude/skills/drive-live-ui/`.
  Ownership on a machine is a single last-writer-wins pointer (`~/.stream/datadir`) plus a single
  native-messaging registration, and neither says a word when it is overwritten — so a second
  Stream backend on the same box silently takes the hand. Pairing was verified end to end on a
  real Windows box against a real extension, with the green falsified by a negative control (drop
  only the native-messaging registration and the extension never arrives):
  `internal design record`; the mechanism is
  `internal design record`.
- **Observer** describes how results are read while actions execute. Network/state/DOM observers
  are composable and MAY run together; they are not separate Sources and not mutually exclusive
  harvest modes.

A facility-scoped persistent browser session does not make the Provider stateful in the user-data
model. The Provider invocation is still T2: it receives a call, returns ephemeral normalized items,
and writes no feed rows. The session is an execution resource, like a connection pool, held only to
preserve a plausible continuous browser context.

For a silent shadow session, the normal data flow is:

```
frontend invocation
  -> backend Provider / correlated Recipe task
  -> extension CDP transport
  -> owned Chrome automation tab in the user's current profile
  -> trusted browser actions + bounded observer windows
  -> backend normalization (normalizer)
  -> frontend result or incremental WS events
```

The host names no site anywhere on this path. The package's normalizer writes on each item
*where* to fetch the rest (`content.enrich = { source, params }`), the frontend opens it over the
generic `enrich.open` WS command (`docs/API.md`), the host dispatches to the package's enricher of
that name, and the enricher runs the package's own detail recipe through `ctx.readSource`
(`docs/PACKAGE.md` §3.2). Adding a site with a live-fetched detail = shipping a package; nothing in
`src/` changes.

The reverse event path is `site -> extension -> backend -> frontend`. The extension remains a pure
CDP transport: it may forward raw command results and subscribed CDP events, but recipe selection,
action sequencing, response matching, mapping, rate policy, and drift classification remain in the
backend.

`xhs-home` (recommend) and `xhs-search` (search) are distinct Source entry points sharing a private
detail recipe/session. `xhs-search` is a T2 Provider invocation: its feed and detail results are
ephemeral: only an explicit user action that materializes an item may place a normalized snapshot
into storage. (**Do not build a surface that renders `xhs-home` live** — a never-ending rec feed does
not serve an AI-facing collection layer, and it is the one thing that would need a fat browser tab
kept alive.)

## 调度中心 (Task Scheduling Center)

Stream 进程内还有一类周期任务，跟 Data Scheduling 章节的 T1/T2/T3 完全不是一回事：不产出
Stream item，只是些运维性的后台活儿——刷新 cookie、清扫过期 job、standby reaper、网盘 autosync。
它们统一收在调度中心里——**别为一个周期需求裸起 `setInterval`**，那等于一处一份重试/日志/失败
处理、互不复用。调度中心内嵌 [Sidequest](https://github.com/lukin/sidequest)（inline runner + SQLite 落盘，
无需额外容器/队列），cron 表达式驱动，失败自带重试与可观测的运行记录。

- **怎么加一个周期任务**：在 `src/tasks/builtin.ts` 里加一条 `ScheduledTask`（cron + handler），
  handler 需要的依赖（cookie provider、events sink、netdisk store…）通过 `TaskDeps`
  （`src/tasks/types.ts`）声明式注入，`serve.ts` 用 `setTaskDeps()` 在启动时一次性接好；不要在
  handler 里闭包捕获全局单例。
- **两类任务**：运维任务写死在 `src/tasks/builtin.ts`（stream 自己的内脏，改排期改代码）；
  业务任务住 `data/stream.db` 的 `scheduled_tasks` 表，`run` 是**跑一条外部命令**
  （`src/tasks/exec-runner.ts`），排期在 UI 里改、改完立即重排不重启。两类编译成同一个
  `ScheduledTask`、走同一个 Job 类、落同一张账本——历次执行是同一套查询。
- **外部任务怎么报效果**：退出码只说明进程没崩。约定任务在 stdout 打一行
  `::outcome:: {"summary":"...","detail":{...}}`，执行器取最后一行解析成 `TaskOutcome`
  存进账本（`src/tasks/outcome.ts`）。不报就只有一句「exit 0（任务没报 ::outcome::）」。
- **面板**：任务清单、排期与历次执行在 `present: 'tasks'` 那档频道（`app/src/components/tasks/`，
  数据走 `/api/tasks`，`src/http/task-routes.ts`）。顶栏与其余四档 Present 同一格
  （`ChannelTitleMenu` + 32px 标题行），卡片走 acrylic `Card`/`Badge`/`Button`。
  Sidequest 自带的 `/_p/sidequest`（走 gateway 前缀，见 `src/plugins/gateway.ts`）仍在，但它是
  job 视角、所有任务共用一个 Job 类，分不出谁是谁——查单条任务用前者。
- **排期在页面上怎么读怎么改**：cron 原文没人一眼读得出来，所以卡片上**人话在主位、cron 原文
  在次位、后面跟接下来三次触发时刻**（`app/src/lib/cronFriendly.ts`：翻译 + 预设编译 + 下次触发
  求解，无第三方 cron 依赖）。改排期是**先选形状（每 N 分钟 / 每小时 / 每天 / 每周 / 每月）再填
  数字**，表达式由预设写出来；复杂表达式留了「自定义表达式」逃生口，边打边校验、边打边给人话。
  两条不许破的规矩：**认不出就退回原文，绝不编一句近似的人话**；**跨时区、或「日」与「周几」
  同时限定时，下次触发时刻显式说"算不出来"，不猜**（各家 cron 实现在这两处语义不一致）。
- **改一条用户任务要把整行发回去**：写路由只有 upsert 一条（`PUT /api/tasks/:id`），只发
  `{ enabled: false }` 会被 400 挡在「command 必填」上。页面的暂停/恢复、改排期都是拿列表里
  那一行原样回发、只覆盖一个键（`app/src/lib/api.tasks.ts` 的 `saveTask`）。内置任务这两个
  控件不画——它们的排期改代码不改库。
- **分组（`group`）只影响这一页怎么摆。** 任务表按它分节渲染，每节一个组名小标题；没有 `group`
  的行落进最后一节「未分组」（不替它们编组名），全都没分组时一条组标题也不画。它**不参与调度、
  依赖、并发或路由**——别给它执行语义。它存在的理由是任务拆细了：一个数据源一条（各源更新时间
  不同，共用一个 cron 就没有新鲜度可言），拆完列表变长，"这几条是同一个市场的"在界面上看不出来。
  组名不是白名单：编辑器那格是**可输入的下拉**，候选来自现有任务用过的组名（内置的也算），
  也能当场敲一个新的。组的顺序和候选顺序都按组名排（`localeCompare`，中文按拼音），组内顺序原样
  保留——顺序稳定，加一条任务不会把整页重排。内置任务分四组：**登录态 / 网盘 / 意图 / 运维**
  （`src/tasks/builtin.ts` 的 `GROUPS`）；DB 里那一列叫 **`group_name`**，因为 `group` 是 SQL 关键字。
- **并发由三格分别管，各答一个问题**（`src/tasks/types.ts`，判定流程见 `stream-cron` skill）：
  - `serial` —— **这一条任务不叠着自己跑**（uniqueness 存活即拒：上轮没完就跳过本次）。
    它只管这条任务和它自己，**不决定队列、不让它跟别的任务互斥**。不变量：**终态 job 不带
    `unique_digest`**——带着就等于"永远排着队"，同一任务此后每班都被判 duplicated；启动巡检
    （`src/tasks/orphan-sweep.ts`）把上次进程留下的 claimed/running 行记成 failed 时一并清 digest，
    并把任何终态还带 digest 的行清掉、记日志。
  - `exclusiveOn` —— **这条任务独占的那样东西的名字**（一座外部数据桥的 worker、一份登录态
    标签、一个库文件的写锁、一把 key 的配额）。同名的任务共用队列 `x:<组名>`（concurrency 1），
    同时只跑一条；缺席 = 进 `default`（concurrency 4），不跟任何人互斥。名字是**资源**的名字，
    不是业务类别：`jq-bridge` 好（看一眼采集器就知道自己该不该进来），`cn-data` 坏
    （"我这条算不算"永远说不清）。**独享的东西不需要排队**——只有一条任务用它，`serial` 就够了。
  - `whenBusy` —— 轮不上的时候：`queue`（默认，排着）或 `skip`（这一班不跑）。判据只有一句：
    **迟到之后还算不算同一件事**。补数、导出、发布算 → 排着（排队不吃 `timeoutMs`，那是在子进程
    spawn 那一刻才起表，所以"等"没有隐藏代价）；有外部时间窗的动作（申购/打新、竞价前报盘、
    有截止时间的提交）不算 → 这一班不跑，并在后端日志和事件面板各留一条（`task.skipped`，warn）。
  互斥组的队列是**运行期建的**（`Sidequest.queue.create`，concurrency 1）：组名是用户在界面上
  现敲的，静态 `queues` 声明里没有它。建不出来时那条任务**不排期**——未知队列的 job 会落账然后
  永远没人捡，那比不排期更坏。`skip` 那一档的节拍器是调度中心自己持的 node-cron，不走 sidequest 的
  `schedule()`：那条路到点直接落账、中间没有钩子，而"组正忙就别入队"必须在**入队之前**答完
  （入队之后再判就晚了——队列 concurrency 是 1，那条 job 会安静地排着，等前面跑完再跑）。
  丢班自愈也过这一关：skip 任务的丢班在组正忙时不补（`skipped-busy`，进那一轮 watchdog 的
  summary 和 detail）。「立即跑一次」是人点的，不看 `whenBusy`，照常入队由队列保住互斥。
  DB 里两列叫 `exclusive_on` / `when_busy`；界面上有互斥组的行画一枚行内小标记（组名 + skip 档
  的「不排队」），不新开一列——绝大多数行没有它。
- **「立即跑一次」一律两步确认**，确认态 5 秒自己过期，**不按任务分档**。理由是具体的：A 股
  逆回购任务误点一次 = 撤掉全部挂单 + 全仓买入逆回购，当天撤不回来。**闸挂在动作上，不挂在
  任务的自述上**——别再给任务行加一个 `effect` 之类的自述枚举来分档：那种字段是行主自己填的，
  没有后端消费方，填错不报错，于是闸静悄悄地就不在了。这一档的代价（只读任务多一次点击）
  远小于它换来的"没有缺口"。
- **一条任务的全部参数就是它的命令行**（`command` / `args` / `env` / `cwd`），没有第二层参数
  模型。"用哪个账号跑"是 argv 里的一个词（`--alias jagger`），所以配置页把这四格放在同一块里；
  真正的密码/token 一格都不在任务行上，它们住脚本自己的配置或 Stream 的 `runtime_config`。
- **账本保留期**：`ledger-prune` 每天 04:15 清一次，每任务留最近 200 次或 30 天（取宽的）。
- **登录态导出（`session-export`，每 10 分钟）**：凭证域的**出口方向**。此前宿主手里那份登录态
  只有两个进程内消费者（采集注入 env、插件容器拿 Cookie 头），这是第三个——**本机一个我们不
  拥有的进程**，它按自己的约定读一个磁盘文件。它存在的理由是消掉那个进程为了拿登录态而自己
  开的第二个浏览器：同一份登录态在用户自己的 Chrome 里本来就有，Stream 也本来就在取
  （`cookiePull`）。声明只在 `config.yaml` 的 `session_exports`（一条都没写 = 整格不装配，
  任务表上也不出现这个任务），实现与三条边界在 `src/credentials/session-export.ts` 的头注：
  **无 API/UI 入口**、`extras[].url` 必须落在声明的 `domain` 之内且过 SSRF 闸、文件 0600。
  声明的 `domain` 会并进 `requiredCookieDomains`（第二个来源，manifest 的 `auth` 是第一个）
  ——漏了这一并集就是每轮拿到空 cookie 而**没有任何一处会报错**。周期是 10 分钟而不是"够新
  就行"：那一发带 cookie 的 GET 同时把站点的 session idle 计时器按回零，**保鲜之外还在续命**，
  这是有意为之。
- **后端得自己活过来**：调度中心跑在后端进程里，所以"后端在不在"直接决定"任务跑不跑"。常驻形态
  是 `scripts/stream-back.service`（`Restart=always` + 开机自启，安装说明在文件头注）；`scripts/dev.sh`
  进场时把它停掉、退场时起回来，两者抢同一个 8900 由 `serve.ts` 的单实例锁兜底。
- **边界（互不接管）**：调度中心只管"运维性周期任务"；采集主链路（T1 `tick(stream)`，见上面
  Data Scheduling 章节的 `scheduler.ts`）不迁移进来——它的链式 `setTimeout` 自重新武装、抖动、
  exclusive 降级等语义是采集专属的，两套调度器各管一摊，谁也不吃谁。
- **防回归**：`src/tasks/no-bare-setinterval.test.ts` 对 `src/` 做全量词边界 grep（`\bsetInterval\b`），
  白名单外一律 FAIL——新的周期需求禁止绕开调度中心裸起定时器。

## 进程内内核（Cordis）：域插件树与生命周期

后端进程的装配骨架是 [Cordis](https://github.com/cordiverse/cordis)（`cordis@4.0.0-rc.8`，
精确锁版）。`bootstrap()`（`src/bootstrap.ts`，~530 行）只做一件事：建内核 → 按依赖序挂
**域插件** → 返回 `{ config, kernel }`。跨模块能力全部住在 `ctx.<域>` 上，域插件在
`src/kernel/plugins/`，一域一文件一聚合对象（declaration merging 就近声明）。

装配序（即依赖序）：settings → credentials → packages → sources → storage → streamEvents →
harvest → auth → adapters → provider → llm → netdisk → search-fanout → conversions → agent →
scheduling。另有三个机制件：`runtime-config`（唯一 runtimeConfig 解析器）、`backend-directory`
（带 backend 的包的唯一合并名单）、`module-hooks`（模块级钩子随内核挂卸 + 未接线报告）。

`ctx.llm`（`src/kernel/plugins/llm.ts`）是**后端自己**全部 LLM 出站的单点，只有两格：
`forTask`（按调用点路由的任务级调用，带按 callsite×日的用量账本与 validate 失败升级）和
`usage`（账本，cache.db）。**它没有 HTTP 面**——所有消费方都在本进程内，一步 HTTP 都不经过。
要用 LLM 的新功能 = 注册一个 callsite + 绑 Provider 行，禁止另配 endpoint+key 入口。

对话里那个模型是**另一条路**：它归用户自己的宿主（Claude Code / Codex / DSH），由宿主直接打
它配的网关，不经过 `ctx.llm`、也不经过 Stream 的任何端点（见下面「对话」一节）。两条路各自的
账本各自记，别指望在一处看到全部。

规则（改这一层前必读）：

- **ctx key 一律带域前缀或域名**；上游 cordis 占用 `logger/events/registry/reflect/fiber`——
  尤其 `events`：`provide('events')` 不抛不覆盖**静默无效**，所以事件层叫 `streamEvents`。
  完整规则见 `src/kernel/context.ts` 头注。
- **持句柄/定时器/watcher/WSS 的对象必须 `ctx.effect()` 登记**，disposer 关它。关停统一走
  `quiesceKernel(kernel)`（撤销按注册反序）；serve 层手写关停只剩 stopTaskCenter/standbyMgr。
- **域间的前向依赖用运行时解引用**（thunk / 调用时读 `ctx.<域>`），绝不装配期解构存快照——
  装配期冻结的症状是热换失效/启动窗口静默失真，且不报错。scheduler⇄service 的真环在
  scheduling 域内闭合（`onFeedTitle` 回调运行时解引用）。
- **HttpDeps 键冻结**（`src/http/app.ts` 头注）：新增能力挂 `ctx.<域>`，不加键。
  注意有若干**不走 HttpDeps 的直连**（插件网关、standby、taskDeps、mountMcp、mountLlmIngress、mountConfigRows、registerDshRoutes、
  mountLiveRoutes、mountResearchRoutes、两个 WS attach、stdio disk 档）——改域时用
  `rg "boot\.<字段>"` + 各批次 spec 的收尾扫描键核对。
- **Stream 包 ≠ Cordis 插件**：包（`packages/<id>/`）是跨进程信任边界（六格槽位模型），
  内核插件是进程内组合单位，两者永不合并。

演进史与各批验收在 `internal design record`（母 spec + 八个批次）。

## Serving

The core backend (`src/serve.ts`) hosts the REST API (`/api/*`), the WebSocket feed (`/ws`),
MCP mounted at `/api/mcp` (streamable HTTP, same
Bearer auth), and reverse-proxies `/_p/<plugin>` to plugin containers (see GATEWAY.md). It is
served behind **one published entry, `127.0.0.1:8900`**:

- **Native host process (dev / installed CLI / MCP — the main path)** — the node
  backend binds `127.0.0.1:8900` **directly and is itself the door**: no Caddy anywhere. `/api`,
  `/ws`, `/_p` it answers itself; `/panel/*` serves the prebuilt panel bundles
  (`src/http/panel-mount.ts`); everything else falls through to the standalone front door, a
  self-contained page that mounts those bundles (`src/http/standalone-page.ts`). It must live outside the container to see the *user's own
  Chrome* (probe it, launch it, share a filesystem with it) — see
  `2026-07-29-backend-native-single-entry-design.md`. Packaged, it is the bundled `server.mjs`
  the `stream` command runs; in dev it is `tsx watch src/serve.ts`.
- **Docker Compose (self-host branch only — NAS/VPS)** — the `gateway` container (Caddy)
  publishes `127.0.0.1:8900→80` and forwards to `serve-backend`, which listens on `4555`
  **inside** the network (not published; host `curl :4555` won't hit it). Generated by
  `pnpm plugins compose --selfhost`. That form has no "user's browser" side at all, so
  login-gated human harvest doesn't belong to it.

Ways that one backend gets started (all the same process, same port, same door): `pnpm dev`
(= `scripts/dev.sh`: `tsx watch` + a host Vite, the dev default), `pnpm serve` (= `tsx src/serve.ts`,
no watch — what the packaged `server.mjs` is), or the self-host container.
Never two at once on `8900`; there is exactly one entry per machine.

**进程级兜底网**（`src/process-guard.ts`，`main()` 里紧跟 `createKernel()` 挂上，源码树与打包的
`server.mjs` 同一个入口所以两种形态都盖住）：孤儿 promise 的 `unhandledRejection` **不再带走整个
进程**——完整堆栈进 error 日志 + 一条 `process.unhandled-rejection` 通知（severity `error`）；
`uncaughtException` 同样记录 + 通知（`process.uncaught-exception`），但**仍然退出(1)**交给
supervisor 拉起（栈被撕断在半路，带着半截状态继续服务比死掉更坏）。**它不是消音器**：日志绝不
降级成摘要，这里也绝不许长出「分类后忽略某几种」的白名单——要治的是那条孤儿 promise 本身。

### 前端↔后端传输（两种，权威定义见 `backend-connection` spec）

Stream 自己的界面是 `app/` 打出来的几份 IIFE bundle（`app/dist-panel/panel*.js`），由后端那扇门
（`:8900`）从 `/panel/*` 发（`src/http/panel-mount.ts`），页面因此与 API 同源。挂它的壳有两个：
8900 的独立正门（`src/http/standalone-page.ts`，没被 `/api`、`/_p`、`/panel` 认领的路径都落它），
以及用户 DSH 里那个 Stream UI 插件的页面（跨源，但 origin 是本机地址，`isTrustedOrigin` 默认认）。

传输只有一种：**原生 `fetch` + 原生 `WebSocket`**。同源那一档（浏览器直接打 `:8900`——dev 期页面
就是后端反代过来的 Vite，release 期是后端 serve 的静态；自托管档则由边缘 Caddy 同源托管）基址为空、
走相对路径；跨源那一档（面板住在用户 DSH 那一页）基址是后端自己的 origin。

**upstream 指向谁（发现阶梯）**：① 用户在设置里配的**远程后端 URL** —— 优先，探健康后直取；
② 没配 → 同源相对，不探端口。配了但探不通 → 回落同源。

### MCP over stdio (on-demand)

MCP has two transports over **one** tool codebase (`src/mcp/tools.ts` + `src/mcp/tool-catalog.ts`):
the HTTP mount above (`/api/mcp`, unchanged — requires the backend already running) and **stdio**,
which an MCP client spawns on demand — no standing backend required.

**On a normal install the stdio entry is the CLI itself: `stream mcp`** (`src/install/mcp-command.ts`,
registered as `claude mcp add stream -- stream mcp`). It is a pure forwarder: probe `GET /api/health`
on `STREAM_BACKEND_URL` (default `http://127.0.0.1:8900`, 2 s), then relay every `tools/list` /
`tools/call` to that backend's `/api/mcp`. It builds no StreamService and opens no database, so it
cannot become a second writer. Backend absent → it spawns one (the same `bin/stream.mjs`, not a
second startup path) and forwards once health goes green.

**A source checkout keeps a second, richer stdio entry** (`src/mcp/stdio-entry.ts`, run via
`pnpm mcp:stdio` = `tsx src/mcp/stdio-entry.ts`). It exists for the case `stream mcp` deliberately
does not cover: answering **read** tools with no backend anywhere. On startup it probes the same
`GET /api/health` on `STREAM_BACKEND_URL` (default `http://127.0.0.1:8900`, 800ms timeout — any
failure or timeout counts as absent, `shared/mcp/probe-backend.ts`):

- **Backend present** → the process becomes a thin **backend-forward** proxy
  (`shared/mcp/backend-forward.ts`, the same forwarder `stream mcp` uses): every tool call is
  relayed to the running backend's `/api/mcp`.
  It never opens `stream.db`/`cache.db` itself — the backend stays the DB's sole writer.
- **Backend absent** → the process opens the on-disk stores itself via `bootstrap()`
  (`src/mcp/disk-service.ts`, **without** starting the scheduler) and serves **read** tools
  (list/search/preview/status, …) directly off disk. **Write/action tools** (subscribe,
  unsubscribe, schedule/reschedule/unschedule a Stream, refresh, transcribe, netdisk apply-spec,
  search-agent start, chrome_cdp/close-tab, …) degrade: they throw/reject a structured
  `NeedsBackendError` (`code: 'needs_backend'`, message tells the caller to start the backend and
  retry) instead of touching the DB or driving a live browser — zero writes, zero process/browser
  spawns.

Relevant env vars: `STREAM_DATA_DIR` (data dir for the disk-service branch — same variable the
Docker/desktop backend uses), `STREAM_CONFIG` (config.yaml path override), `STREAM_BACKEND_URL`
(probe target, default `http://127.0.0.1:8900`), `STREAM_NO_SCHEDULER=1` (query-only backend: skip
`scheduler.start()` so no standing harvest runs — `spawn-backend.ts` injects it by default when the
stdio router spawns a full backend on demand, matching the disk-service branch's scheduler-free
posture; explicit callers can override).

Claude Desktop `mcpServers` config sample — the normal install first, the checkout form second:

```json
{
  "mcpServers": {
    "stream": { "command": "stream", "args": ["mcp"] },
    "stream-checkout": {
      "command": "npx",
      "args": ["tsx", "--tsconfig", "/path/to/stream/tsconfig.json", "/path/to/stream/src/mcp/stdio-entry.ts"],
      "env": { "STREAM_DATA_DIR": "/path/to/stream/data" }
    }
  }
}
```

The **checkout** entry is still a `tsx`-run TypeScript file and is not packaged into a binary; the
published package reaches the same tools through `stream mcp`, whose bin is the bundled
`server.mjs` CLI (that packages `serve.ts`, not `stdio-entry.ts`).

Per-client registration recipes (Claude Code, Codex, antigravity/Gemini CLI, Claude Desktop) for
both transports live in [`README.md` → *MCP usage*](../README.md#mcp-usage). Note that the served
tool set is defined here, server-side: when tools change (e.g. a rename), clients pick it up by
reconnecting/restarting — a running MCP session keeps the `tools/list` it fetched at startup.

### 后端生命周期：两模式 + 分层安装

MCP 按需（上面 stdio 一节）解决的是「查询不需要常驻后端」；但 **timeline 采集本质上需要「有人按时去
跑」**——没有一个活着的进程，就没人触发 cadence 定时器。这是采集和 MCP 查询的根本区别，也是「后端
到底要不要常驻」这个问题的来源。答案不是两个产品，而是**同一份 core 的两种模式**，只差一根轴：
有没有常驻（OS 服务）。

|  | **无常驻** | **有常驻（OS 服务）** |
|---|---|---|
| 纯 MCP | 按需：stdio 起来，disk 读 / 写降级为 `needs_backend`。全关掉什么都不跑。 | 无头服务器：后端作为 OS 服务常驻，MCP 永远 forward 给它，频道后台自动更新，用 Claude 查最新。 |

**core（node 后端 + MCP，一份代码、一个入口）在这两格里一个字节都不变。** 变的只有「谁负责让它活着」。
DB 单访问者不变量自动成立，不靠锁：probe-first 纪律（见上 stdio 一节）保证「服务在跑就 forward/复用、
没在跑才 disk 读」。

**分层安装**（把「core 是唯一不变量」落到安装物理层，而不只是运行时行为）：

```
L0 core 基座   node 后端 + MCP（一份代码，一个入口）   ← 始终存在，唯一不变量
L1 MCP 注册    stdio 命令写进客户端配置                ← 指向 L0，几乎总在
L2 常驻（可选） OS 服务单元（systemd user / LaunchAgent / 登录任务）  ← 指向 L0，运行时开关
```

**没有桌面壳这一层**：界面是 8900 那扇门发的面板，以及用户 DSH 里那份 Stream UI 插件。L2 只是
「指向 L0」，可随时装卸、不改 L0。纯 MCP 用户装的就真的只有 L0+L1。

**Companion extension (`extension/`).** A standalone WXT/MV3 Chrome extension is a thin face
over this API: it tells Stream which cookie domains are worth pulling (and answers the backend's
`op:'cookiePull'` over the relay) and discovers/subscribes sources for the current
page via `GET /api/intents` + `POST /api/streams/from-intent` (classify a URL → build the
member → create the Stream in one call). It ships no radar rules and no resolve logic — the
brain stays in Stream. See `extension/README.md`.

**它怎么装到用户的 Chrome 里。** 三态判定来自 `GET /api/browser-capability`
（`ready` / `disconnected` / `never-seen`）；引导只在 `never-seen` 出现——`disconnected` 是
"装过又掉了"，走排查，不是再劝他装一遍。引导出现在三个地方：面板首次打开时的横幅（拒绝一次就
记 `settings.json` 的 `extension_onboarding.declinedAt`，之后不再在启动时提）、设置页里那个
**永远在**的固定入口、以及用户自己发起的动作因为扩展没连而做不成时的现场提示（同一个能力
一天最多提一次）。

三个动作端点：`POST /api/extension/materialize`（把扩展目录物化到 `<dataDir>/extension/`，
回绝对路径）、`POST /api/extension/install`（代装，见下）、`POST /api/extension/decline`；
另有 `POST /api/extension/uninstall`（卸载）与 `POST /api/extension/reload`（在扩展详情页点「重新加载」、
以中继换新连接为判据；**全程走 Stream Desktop 不经中继**，扩展断连时也够得着）、
`POST /api/extension/console`（读扩展后台控制台，同样不经中继）——这四条桌面 recipe 共用 `openExtensionsPageSteps`（`src/browser/chrome-ext-page.ts`）那四步进扩展页；
另有 `GET /api/extension/onboarding` 读"拒绝过没有"。**手动装和代装指向同一个目录**，
出问题时排查只有一条路径。目录来源三档（判据一律是**产物在不在**，不是"是不是开发模式"，
解析在 `shared/browser-relay/extension-dir.ts`）：

1. 仓库里的 `extension/.output/chrome-mv3`——开发机（判据是 cwd 下那个相对路径上有没有产物）。
2. npm 包 `@streamapp/chrome-extension`（目录 = 包根下的 `chrome-mv3`）——CLI 发行包
   （`cli/package.json` 依赖它）走这一档：干净装机上仓库产物不在。
   这个包由 `scripts/publish-extension.mjs` 发，版本照抄扩展的 `manifest.version`。

代装（`src/browser/extension-install.ts`）和卸载（`extension-uninstall.ts`）各是一条
`kind:'desktop'` recipe，跑在和 telegram/qq 同一个 `runDesktopRecipe` 上——同一套失败判定、
同一份现场、同一个会话租约（接管指示条与 `Ctrl+Alt+Esc` 中止都挂在那个租约上）。三条必须
知道的事实：开发者模式开没开**读不出来**，判据是「加载未打包」这个按钮在不在；文件夹对话框
是一个**独立的顶层窗口**（Chrome 主窗口的 owned window，但进程还是 `chrome.exe` 自己），
所以要先 `scopeWindow` 过去才找得到它的控件；窗口标题是**包含**匹配，所以扩展页那个标题必须
写全「扩展程序 - Google Chrome」——只写「扩展程序」会匹配上对话框的「选择扩展程序目录。」。
控件名候选表在 `src/browser/chrome-ext-page.ts`，全部实测得来；每一步在 `out.log` 里留一行
`[desktop-probe]` 时间戳，出问题先看它。

**成功判据只有一条：扩展连上了中继**（`browser-capability` 变 `ready`）。页面上出现卡片不算
——两者会安静地分家，最常见的是 native messaging 清单在这次 Chrome 启动之后才登记。所以
"步骤跑完但没连上"回的是 `needs-chrome-restart`，不是"安装失败"。开发者模式扩展每次启动的
那个气泡是已知代价，绕不开（商店上架能免掉，但扩展要读本机 `data/ext-relay-token`）。

### 进程出站 HTTP 归属

内嵌 RSSHub 的 request-rewriter 在懒加载时**进程级** patch 了 `globalThis.fetch` 与
`node:http`/`node:https` 的 `get`/`request`（无 Referer 时强塞 self-origin Referer）。所以出站分两条：

- **Stream 自己的出站** → 一律走 `src/http/owned-outbound.ts`：`ownedFetch`（Response 语义）或
  `owned.{httpGet,httpsGet,httpRequest,httpsRequest}`（流式 / Range / 精细 header）。它在进程启动
  **顶层同步**快照原始绑定（结构性早于 RSSHub 运行时懒加载），改写器够不着；`serve.ts` 在 `load-env`
  之后**首位** import 以保证捕获时序；命门测试 `owned-outbound.sentinel.test.ts` 锁死的是捕获机制本身
  （import 后再 patch，已存引用不受影响）。
- **RSSHub 路由** → 走它自己的改写器，不经 owned（那是它的内政，不动）。
- SSRF 守卫（`safe-fetch.ts` 的 `isPrivateHost`/`publicHttpUrl`）与逐 host Referer 策略
  （`media/serving.ts` 的 `refererForUrl`，数据来自包的 `serving[].referer` 声明）是**业务层**职责，跑在 owned 之上，不下沉到 owned。
- **别再造第四份私人绕法**：需要改写器够不着的出站，import owned，不要新写 node-http 快照。其余
  全局 `fetch` 调用点按证据分批迁（见 `openspec/changes/owned-outbound-http/recon.md`）。

## Diagnostics — 两个「飞行记录器」，不同层，别混

同名但毫无关系。都叫飞行记录器是因为思路一样：故障发生时当事人已经死了，没法自己报告，
只能靠提前采样、事后取证。

| | 事件循环卡顿记录器 | OOM 诊断记录器 |
|---|---|---|
| 观测谁 | **后端** Node 进程 | **前端** Chrome 标签页（renderer） |
| 代码 | `src/loop-lag.ts` → `src/serve.ts` | `app/src/lib/diagnostics/` |
| 记什么 | `perf_hooks` 事件循环延迟直方图 + 任务级归因（`src/op-track.ts`，常开）+ CPU profile 归因（按需） | heap / DOM 规模 / 音频缓冲 / 音频事件 |
| 记哪 | stdout 一行 + DebugBox `loop` 频道 | 浏览器 IndexedDB（`stream-diagnostics`） |
| 常态 | **常开**，idle 零噪声 | **默认关闭**，在后端设置 Sheet 里开 |
| 为什么要 | 同步操作堵住事件循环时连自己的日志都打不出来 | renderer 被 OOM 杀掉后没有代码能再执行 |

### DebugBox 的两层：看现在用环，等偶发用文件

两者都由 `serve.ts` 那一个 `recordDebug` 喂，任何频道的生产者都不用关心自己进了哪层：

| | 内存环（`src/http/debug-log.ts`） | 落盘（`src/http/debug-sink.ts`） |
|---|---|---|
| 存哪 | 进程内，200 条**跨全频道共用** | `data/debug-failures.jsonl`，一行一条 JSON |
| 收什么 | 全部条目 | **只收 `ok:false`**，且**一字不差的重复按 10 分钟窗口折叠**——文件是证据，不是流水账 |
| 活多久 | **进程一重启就没** | 一直在；超 4MB 轮转成 `.jsonl.1`，只留一代 |
| 谁读 | `GET /api/debug/log?channel=…`、前端 DebugBox | 人 / agent 直接 `grep '"<频道>"' data/debug-failures.jsonl` |

**读这个文件时先看 `_repeated`**：带这个字段的行意味着"上一段窗口里它还出现了 N 次"，
也就是一条**常态噪音**，不是偶发现场。没有这个字段才是只响过一次的那种。

**为什么必须有第二层**（这是踩出来的）：偶发故障的排查全都写成「观测已埋好，等撞一次现场」，
而探针只进内存环时那句话是假的——开发期 `tsx watch` 一天热重载几十次，一轮采集就能把 200 条
冲干净。实测：三条各自等了若干天的 TODO，回头去读环，里面只剩后端启动那一分钟的东西。
**观测埋在会被清空的地方，等于没埋**；而这类墙/竞态还都会自己好，现场不留就再也复现不了。

判"哪些值得留档"的判据只有 sink 里那一份——环无条件把每条转给它（`debug-log.test.ts` 钉着这条，
在环里补第二道 `ok` 过滤会当场变红）。

**为什么要折叠**（同样是踩出来的）：落盘上线半天就攒了 2.2MB，其中 `plugin-target` 1216 条里
**1184 条一字不差**——standby 让 voiceprint 容器睡着，例行探测每分钟如实答一次"没有地址"，
连打 21 小时。这不是故障，但按这个速度一两天就冲一轮轮转，而要等的偶发现场几周才撞一次：
**噪音会在证据到来之前把它挤出去**，等于把"几分钟被清空"换成"几天被冲掉"。折叠的判据是
**一字不差**（channel+key+summary+fields），不能放宽成 channel+key——真现场的 summary 里带着
耗时/状态码，几乎不会重复，而放宽之后同一 key 的第二次真现场会被前一条挡掉。

**OOM 诊断记录器的关键不变量**（设计与细节：`internal design record`）：

- 会话一开始就写 `running`。下次启动仍看到 `running` = 上次没能收尾 → 改写为
  `suspected-abnormal`。这是**推断不是确证** —— 别在 UI 或结论里把它说成「确定 OOM」。
- 数据**只存本地、只由用户主动导出**，不上传后端也不给第三方。播放 URL 只留 host +
  pathname 的 hash，query/fragment 丢弃（签名密钥就在 query 里）。
- 字段为 `null` = **未测量**，不是「实测为 0」。`performance.memory` 是 Chromium 专有的
  **趋势**指标，不等于 renderer 总内存，不可单独用于归因。
- 裁剪按会话隔离；会话淘汰先丢例行的 `ended`、按 `lastWriteAt` 排序。**这两条都是踩过坑
  的**：全局裁剪会让新会话挤掉崩溃会话的样本；按 `startedAt` 排序会把「播了 70 分钟才崩」
  的会话当成最旧的删掉 —— 两种都正好毁掉本功能的唯一意义。

## 对话

**对话不在 Stream 里，在宿主里。** Stream 里有三种东西，家不一样（spec
`2026-09-05-stream-stops-hosting-dsh-design.md` §1.3）：**后台**（调度、采集、追更、归档——常驻进程，
8900 那个后端）、**能力**（叫一次做一次，给 agent 用的形态是 MCP + skill）、**看**（monitor、收件箱、
影视音乐、网盘浏览——8900 的独立正门 `src/http/standalone-page.ts`，挂 `app/dist-panel/` 那几份
面板 bundle，里面没有对话）。对话属于用户自己的宿主：Claude Code、Codex、DSH，都经
`/api/mcp` 使唤后台，skill 告诉它们怎么用（`src/skills/shipped.ts`）。

**宿主那边只有一行，指向 Stream**：`claude mcp add stream -- stream mcp`（Codex 是 `config.toml`
的 `mcp_servers` 一行；DSH 的 stream-ui bundle 里那行 `dsh-mcp-client` 直接指
`http://127.0.0.1:8900/api/mcp`）。`stream mcp`（`src/install/mcp-command.ts`）是一层 stdio 壳，
探一次后端、在场整面转发、不在场先拉起它。**这一行此后不用再改**——往 Stream 里加多少能力包，
工具都从同一个口出去。

**Stream 不装、不起、不代理任何宿主。** 仓库里不出现 DSH 的版本号；`child_process` 里不出现 `dsh`
（`src/no-dsh-hosting.guard.test.ts` 钉着）。将来打包成带对话的产品，起 DSH 的是一个站在后端与
DSH 之上的**启动器**，不是后端（spec §2.1）。

**DSH 这条路上多一样东西：Stream UI 插件**（`hosts/dsh/`，npm `@streamapp/dsh-plugin-stream-ui`）。
它是一个 DSH **bundle**：用户把它 `dsh plugin --profile web add` 进带 web 界面的 profile 之后，包里的 `cordis.patch.yml`
叠在那个 profile 上——关掉 web-app 的整页壳与侧栏、插一行 `dsh-mcp-client` 指向 Stream 的
`/api/mcp`（`serverName: stream`，模型看到的名字是 `mcp__stream__<raw>`，UI 插件按这个前缀
注册定制卡）、插本包。装好后 DSH 的整张脸是 Stream（内容流为主面、对话为侧列，同一批面板
bundle 从 8900 的 `/panel/*` 取），卡片和会话之间能互送——这是 DSH 独有的锦上添花，8900 独立页
里没有对话也就没有这条联动。壳反转的机制读数在 spec `2026-08-17-stream-as-dsh-plugin-design.md`
§9–§15；安装的主语是用户。

**「空间 → 频道」导航是面板 bundle 的第二个挂载点**（`mountNav`），不是宿主的东西：8900 独立
正门把它摆在左列、DSH 壳把它摆在侧栏里那一段，两处挂的是同一份代码，宿主只决定摆哪、把
`--stream-nav-*` 配色 token 指到自己的变量。两个挂载点之间的"当前频道"在 bundle 内部同步，
**宿主不是中间的转发点**——每个宿主各养一份镜像状态的那套往返契约已经退役
（spec `2026-09-06-shared-sidebar-nav-design.md`）。

导航树底下还有一条**宿主动作栏**（`mountNav` 的 `footer`）：「管理」入口与明暗切换，**各自给了
才画，两格都不给整条不出现**。8900 独立正门两格都给（所以那张页**没有顶栏**——标题、管理、
明暗全在这条栏里，管理是盖在内容上的一层弹层，内容区那棵树从头活到尾不被卸）；DSH 一格都不给
（它有自己的设置窗与主题开关），所以侧栏里的 DOM 与没有这条栏时逐字相同。

那张页要打 Stream 的 `/api/*`，而它的 origin 是用户 dsh web 的口——Stream 不知道那个数，也不需要：
本机来源（127.0.0.1 / localhost 任意口）`isTrustedOrigin` 默认可信。只有后端与 DSH 不在同一台机器时，
才把那张页的 origin 经 `STREAM_TRUSTED_ORIGINS`（逗号分隔，精确串匹配）登记进白名单。

**模型、工具面、preset 都归用户的 DSH。** 模型在 DSH「设置 - 模型」页配；模型手里有没有 bash 是
用户 profile 的事，Stream 不保证也不守。会话标题用用户自己的模型。

**能力包装进 Stream，不装进 DSH**（定义见「能力归一化」一节的「能力包」）：
`stream add @streamapp/<x>`，工具从 8900 的 `/api/mcp` 出去。DSH 那边只有一行 MCP 客户端指着
`http://127.0.0.1:8900/api/mcp`，装不装能力包它一个字都不用改。要装进 DSH profile 的只有
`dsh-plugin-stream-ui`（那份必须进带 `dsh-web-app` 的 profile，例如 `web`）。网盘包要复用 Stream
那份 OpenList（external 档）时问 `GET /api/netdisk/openlist-access` 拿网关路径与永久 token，
写进 `config.yaml` 的 `capabilities.netdisk` 那一格。

**后端不读宿主的私有文件，没有例外。** 用户和宿主聊过什么归宿主自己（DSH 有自己的会话历史），
Stream 不提供读口——读另一个产品的内部日志格式，格式一变就静默读空。

**`src/agent/` 下留着的不是聊天**：`search/`（目标导向的发现循环，spec 2026-07-15）与
`ctx.agent` 域里的意图跟踪 / 网页搜索梯子 / `mcpExtras` 工具面——它们本来就与聊天路径无关，
只是共用同一条 `llm.chat` 调用点和同一份工具面。

**发现循环是一条，域有两个**（spec 2026-09-01）。`runSearch`（`src/agent/search/flow.ts`）
是「搜索领路 → 找到聚集地 → 进窝抽候选 → 验 → 学会了再搜一轮」的骨架，代码定分支和停止
条件，LLM 只在三个关节上被问（搜什么词 / 这条是窝还是货 / 切不切题）。**领域差异全部收在
一个注入的 `DiscoveryDomain`，只有五格**（`domain.ts`）：`parse`（从窝的页面认出候选）、
`check`（这条算不算数）、`habitat`（这类东西通常在哪儿出没）、`identityOf`（两条是不是同
一个）、`originsOf`（这条来自哪几个窝）。

| 域 | 候选是什么 | 验证器 | 工具面 |
|---|---|---|---|
| `netdisk`（`domains/netdisk.ts`） | 一条网盘分享链 | 开链验活（`netdisk.share.verify`） | `search_agent` —— 吃一句自由描述，找**某个具体东西**的获取渠道 |
| `catalog`（`domains/catalog.ts`） | 一个商品型号 + 价格 + 出处 | `price_search`（现成能力，不新增源） | `enumerate_candidates` —— 吃**结构化约束**，回答"符合条件的有哪些" |

两个工具分开而不是加参数，理由是**入参形状不同**（自由描述 vs 已经是结构的约束），塞进
同一个 `goal: string` 等于把结构拍平成散文再让 LLM 猜回去。两者共用一个 run 库
（`agent-runs.db`）和 `get_agent_run`；记录上的 `domain` 是**读 `targets` 的前提**——两个
域的候选形状不同、共用一格。

**候选集必须带出处。** 枚举不可能是全集，所以回执里 `stopped`（收敛 / 被轮次截断 / 早停 /
扩源干涸）和 `coverage`（几轮、开了几个窝、还剩几个没开、抽出多少、验完留下多少）是一等
产物：**在任意子集上算支配，结论不是"不完整"而是误导**——「已排除 X」照样自信地印出去，
而真正划算的那个可能压根没进过候选集。这条判据的下游是 `purchase_decide` 的支配运算（见"最优性价比"
一节的 `research record`）。

**购买决策整条路线跑在代码里，不跑在提示词里**（`src/agent/purchase/job.ts`，spec
`2026-09-02-purchase-decision-job-design.md`）。工具是 `purchase_decide`：一次调用走完
「枚举全集 → 横评里谁被点名 → 逐台取价 → 支配运算 → 回执」。**模型只在三个窄口上**：
把用户的话变成结构化约束、读一页横评、把回执讲成人话。它不能改数，答案里出现的型号必须
在回执里。

为什么要收进代码：**提示词是请求不是约束**——把九步写成一段几百词的说明交给模型自觉执行，
最常被跳过的恰好是枚举那一步。同理，**这条线在工具面上只有这一个入口**：再给模型一个"手工
组装终稿"的工具，它就会把回执逐字段手抄进去、抄的时候把口径抄错（"残值查不到"→"残值按 0 计"）。
回执就是终稿，Stream UI 插件直接把它画成对比卡。**先跑再问**：只有品类必填，其余带默认值起跑、
回执自报假设——让它先访谈用户的结果是一张五行问卷、一个工具都没调。**说法只有一份源码**：
`.claude/skills/purchase-decision/SKILL.md`，出货给用户的每个宿主都读它（`src/skills/shipped.ts`）。
闭合 job 的固定形状 = 一个 MCP 工具（路线）+ 一份 skill（说法）。

三个只有这条链才有的判据，都在 `job.ts` 里：

- **枚举优先直查，不优先 discovery**。有产品库可问的品类（手机 → `packages/zol/`）按品类和
  价格档拼 URL 一次取回，零 LLM。discovery 那条留给没有产品库的品类。
- **抽取关节的 enum 必须带逃生项**（`signal.ts` 的 `NOT_IN_SET`）。强制模型在候选集里选、
  又不给"都不是"这一项，它会挑一个并把理由写得头头是道——**字段本身是个假的正确答案**。
  逃生项的计数是一等回执字段：它是"全集抓漏没有"的唯一线索。enum 之外还有事后集合校验，
  两道都要（这条路上没有语法层的约束解码可用，见 spec §4）。
- **取不到的数不许悄悄拿默认值顶替，也不许因此装死**。用户说会转手却查不到保值率：不按残值 0
  算成"持有成本"（那等于凭空多记一笔成本、把它错误地斩掉，而表格上一切正常），也不把它踢出比较
  （那样前沿为空、模型手里没东西可交）。做法是**整份回执统一退到按买入价排**，并在一等字段
  `residual.mode: 'purchase_only'` 里大声说明——口径必须全体一致，一台扣一台不扣就不在同一根轴上。

**搜到 → 接成订阅。** 对话里搜到一个地址之后，接进来这一跳是三步：搜索工具给出 URL →
`resolve_intent`（`RadarMatcher`，按域名+路径模板找谁能吃它）→ `subscribe_source` 建流。
代订的流统一落频道「对话订的」（`agent-subscriptions`）——给用户留后悔药，一眼看清 AI 替他
订了些什么。**建频道必须排在 subscribe 前面**：`StreamService.subscribe` 拿到不存在的频道 id
时静默不挂（流建了、调度加了、就是不属于任何频道，且没有一处报错），所以那一步收敛成了具名的
`ensureChannel`。接不上时（`matches` 为空）助手如实说并停，同时用 `note_unonboardable` 记进
「想接还接不了」清单（`/api/onboard/wishlist`）——那份清单靠模型主动调，**不保证完整**。

## Data & File Structures (target state)

The designed shapes, from the model above — current code differs (see
[Where things live (current code)](#where-things-live-current-code) and
[Migration notes](#migration-notes)).

**One base shape, two states.** Stream and Provider share a base record; the discriminant is a
derivable property — are all member params bound? — not a flag (invariant 3 encoded in data):

```ts
interface StreamBase {
  id: string                            // global identity (Streams are reusable across Channels)
  label?: string
  strategy: 'fanout' | 'exclusive'      // members complementary → fanout; interchangeable → exclusive
  members: SourceBinding[]              // ordered = priority when exclusive
  contract?: CapabilityContract         // exclusive accept-predicate (e.g. lossless)
}

interface Stream extends StreamBase {   // fully bound → schedulable
  cadence_seconds: number
  mode?: 'feed' | 'collection'          // storage shape: unbounded append/evict vs bounded full-refresh
  inputs?: never
}

interface Provider extends StreamBase { // call-driven → on-demand; may be parameterless
  inputs?: Record<string, ParamSpec>    // declared call-time params when the capability needs them
  capability: string                    // glue-layer index ('search', 'audio.download', …)
  cadence_seconds?: never
}

interface SourceBinding {
  plugin: string                        // pluginId
  source: string                        // source template id within that plugin
  params: Record<string, Value | { $input: string }>  // constants, or references to declared inputs
}

interface Channel {                     // a view — references, never owns
  id: string
  label: string
  present: 'timeline' | 'search' | 'audio' | 'video' | 'research' | 'tasks' | 'embed'   // Present registry id
  streamIds: string[]
  options?: {                           // per-present config (e.g. audio download policy) +
    slots?: Record<string, string[]>    // callsiteId → Provider ids, overrides the global
                                         // binding within this Channel only (see Provider above)
  }
}
```

Validation rules: every `$input` must name a declared Provider input. A Provider has `capability`
and no cadence, but MAY have no inputs (for example `recommend`). A Stream has
`cadence_seconds`, no call-time inputs, and is executed only by T1.

**Distribution layer** (committed, read-only declarations) — a plugin is a self-contained
package:

```
packages/<pluginId>/
  config.yaml        # descriptor: backend, credentials, normalizer, official flag
  manifests.yaml     # ALL of this plugin's Source templates (params schema, auth, capabilities —
                     #   the capabilities declarations are what Provider derivation reads)
```

(Huge generated catalogs — RSSHub — keep their runtime catalog loader; static `manifests.yaml`
is for hand-written plugins.)

#### RSSHub 有两个来源，catalog 只有一个

RSSHub 跑在自己的 worker 线程里（`src/rsshub-worker.ts`），本体从三处解析，顺序在
`resolveRsshubPkg`（`src/rsshub-client.ts`）：

| 档 | 是什么 | 谁在用 | 要 tsx 吗 |
|---|---|---|---|
| 开发检出 | `RSSHUB_PKG`（默认旁边那个 git clone）的 **TypeScript 源码** | 源码形态。自己写 RSSHub 路由时改了要立刻跑到，所以**检出在场就它赢** | 要（.ts + tsconfig 的 `@/*` paths） |
| `<dataDir>/rsshub/` | 预构建 ESM `dist-lib/pkg.mjs` | 发行安装。**第一次跑到 RSSHub 源时由 Stream 自己 `npm install` 到那儿**（`src/rsshub-install.ts`） | 不要 |
| npm 包 `rsshub` | 同上 | 谁自己往我们旁边装了一份就用它 | 不要 |

**RSSHub 不是发行包的依赖，这是故意的**：它经 `@jocmp/mercury-parser` 拖着两个 `github:` 依赖，
npm 装它们必须 spawn git，而干净的 Windows 上没有 git——整条 `npm i @streamapp/stream` 会直接失败
（实测）。改成我们自己当那次 install 的根，`overrides` 才生效（依赖里的 overrides 被 npm 完全忽略），
git 也就不需要了。解析顺序、代价、失败话术全在 `src/rsshub-install.ts` 的头注。

- **`--import tsx` 只加在 worker 入口自己是 `.ts` 那一档**（`execArgvForEntry`）。发行包里入口是
  预构建的 `resources/rsshub-worker.mjs`（`scripts/build-server.mjs` 单独打、`build-cli.mjs` 单独
  出货——它是运行时 `new Worker(URL)` 找的文件，**不会被 server.mjs 的 bundle 拽进去**）。
- **catalog（RSSHub 全量路由长尾，~3900 条）来自一份缓存，由取数顺手刷新**：
  `<dataDir>/rsshub-routes.json`。开机时读它（读不到就退回检出的 `assets/build/routes.json`，
  两个都没有就只有 curated）；缓存缺席或过期（7 天）时，**在一次真的 RSSHub 取数之后**由
  `RssHubAdapter` 顺手取一遍 `request('/api/namespace')`，落盘并 `Registry.swapCatalog()` 换进去。
  `request('/api/namespace')` 返回的就是 `routes.json` 的同一个对象
  （`scripts/workflow/build-routes.ts` 正是把它 `JSON.stringify` 出来的），实测更全
  （1981 ns / 3861 routes vs 检出那份构建产物 1670 / 3309）。
  **为什么不在开机时取**：拉起 RSSHub worker 要 +168MB RSS、0.65s，而 worker 起来就不会自己退——
  从不碰 RSSHub 源的用户不该背这份内存。取数之后那一刻它已经热着，代价只剩 67ms 加一次写盘。

**Runtime layer** (user data, SQLite — no YAML/JSON user config). Two files, split on one
criterion: *would losing it hurt, or can it be re-harvested?*

```
data/stream.db   # user-owned, precious, small — the single backup unit
  channels           # views: present, label, stream references, options.slots（开库时把存量 targets 表就地 RENAME 收编）
  streams            # fully-bound units (cadence, global id, reusable; options JSON absorbs
                     #   per-stream toggles like autoDownload — no single-flag side tables)
  providers          # user overrides of derived capability defaults (priority, exclusions)
  liked_track        # liked-songs ledger
  asset, track_asset # audio archive ledger (the one real FK pair — stays in one file)
  download_job       # download queue
  conversions        # 转换产物 (extract/identify/frames/summary/audio-fp，item-keyed;
                     #   outlive item eviction by design — see Conversions below)
  discovered_channel # search-channel telemetry

data/cache.db    # regenerable, fat, high-churn — never backed up
  items              # normalized items from Stream harvests, keyed by stream_id
                     #   (Provider results are returned to the caller, never stored here)
  seen_items         # harvest dedup fingerprints
```

`streams` and `providers` are twin tables over the shared base columns, each adding its
state-specific columns — the inheritance relationship expressed in storage. `conversions.item_id`
references evictable cache rows, so it carries **no** FK constraint — those records deliberately
outlive their items.

**Conversions**：所有转换产物住单张 `conversions` 表，按
`kind`（`extract | identify | frames | summary | audio-fp`）判别；`extract`（转成文字）内部按 `content.archetype`
分 `stt`/`ocr`/`article` 三条分支 + `inline` 直取，判分支在 `shared/extract/plan.ts`（前端按钮
显隐与后端选分支同一份代码）。**队列/去重/取消/重启续跑/计时这套编排只有一份**
（`src/conversions/runner.ts`）：一种新转换 = 注册一个 converter，**别新建 service + store +
端点族**——抄第二份的代价实测过，先长出来的那份后来加的延迟重排、job 账本、事件，抄出来的那份
一个都没有。分阶段耗时打在 runner 的阶段边界上，所以每个 kind 免费拥有。契约见 [API.md](API.md#conversions转换-转成文字--补说话人--抽帧取画面文字--摘要)。

**转成文字是一条会自己往上长的梯子。** `extract` 只产出底座那一份（转写 / OCR / 网页正文 / 直取）；
更深的层（`identify` 补说话人、`frames` 抽帧取画面文字）是**独立的 conversion**，由
`ConversionRunner` 按 `src/conversions/derive.ts` 的规则表自动排出。

**那里有两张表，别混**——判据是「下游要不要读上游的产物」：

| | 表 | 什么时候排 | 今天有谁 |
|---|---|---|---|
| **接力** | `CONVERSION_DERIVATIONS` | 上游 `done` 之后 | extract → `frames` |
| **并肩** | `CONVERSION_COSTARTS` | 起上游的**同一刻** | extract ‖ `identify` |

接力的下游要拿上游的产物当判据（抽帧要读转写才知道值不值得抽），所以必须等。并肩的两件事
互不为输入，只是碰巧要同一份字节——等就是白等（实测取白文 20–140s、分人 200–900s）。

| 规则 | 判据 | 判不出来时 |
|---|---|---|
| 接力 → `frames` | 上游带时间轴（`segmentsIn`，`shared/extract/transcript.ts` 前后端同吃一份），且 `detail.media` 里有 video | **放行**（这层便宜） |
| 并肩 ‖ `identify` | 这条 item 有能转写的音视频（`transcribableMedia`，后端真身那个具名判断） | **不起**（这层贵） |

**两条的方向刻意相反**，别当成不一致：抽帧漏掉一条的代价是那页幻灯片的字永远不进正文、
没有任何一处会喊；声纹多起一批的代价是一堆必然 `no_media` 的记录和真金白银的容器时间。

- 两张表的 `when` 都是**纯判据**：接力那张只拿得到那条 `ConversionRecord`，并肩那张只拿得到
  起跑时的 `options`（**那一刻还没有上游记录可读**，这正是两者签名不同的原因）。都不许打 store、
  不许打任何 I/O，也**不许抛**——谓词抛出会被 runner 的外层 try 当成「没有要排的」，
  **静默吃掉整张表**。`options` 是从 HTTP body 一路递进来的，形状是调用方说了算：用之前先验类型。
- 并肩**只在真的新建了记录时**发生。命中去重（缓存）时不排，否则每次点一下转成文字都白排一条声纹。
  `force` 原样传下去：重跑转成文字时并肩那条跟着重跑。
- 真不是视频的由 `frames` converter 自己兜底（取不到视频地址 → `no_source`，零字节、`done`）。
- 接力只在上游 `done` 时发生；上游失败或被取消，不派。
- **`identify` 不认识文字**：它产出一条带名字的说话人时间线，「把标签投影到文字段上」
  （`alignTextToClusters`）由 converter 在时间线出来**之后**自己做。这不是风格，是并肩的前提——
  文字塞进去就等于把它重新绑回转成文字后面。converter 因此**读两次上游**：起跑时读媒体线索，
  分人跑完再读一次拿转写。写成一次读就等于并行白做（起跑那一刻上游必然还没落定，读到的永远
  是空）。真赶上上游还没好，就少一次投影，时间线照样落库、照样成功。
- 并肩还有一个前提是**取字节不重复付**：落盘缓存取完才写，两条同时开工时后来的那个必然读空。
  在途表（`AudioCache.share`）保证同一份字节同一时刻只取一次。缺了它并行是负收益。
- 上游**真的重跑过**时下层跟着重排（走到派生就说明上游有了新产物，旧的下层是对着旧产物算的）。
  唯一不排的情况是该 (item, kind) 已经有一条在排队/在跑——那条就是这条 item 的下一层。
- 每次补说话人都会把探到的读数写进转换结果（`probe`：几个说话人、有人说话的总秒数、每簇多久）。
  **读的是 diarization 时间线，不是转写段**——没有转写的那些正是这份账最该覆盖的。
- 派生失败**不回头影响上游**——最贵的那份（转写）必须落地即安全。
- 两张规则表在 `ConversionRunnerDeps` 上都是**必填**字段：漏接线的表现是「什么都不发生」
  （并肩漏了就是「串行照跑，只是永远不并行」，没有一处会喊），必须在 typecheck 就炸。
  **加一层就在 `derive.ts` 加一行**，那是唯一的装配点。

设计见 `internal design record`。

**视频抽帧**（`src/media/video-frames.ts` + `src/media/frame-hash.ts`）：给一个**可寻址的输入**
（本地路径或支持 range 的 URL，ffmpeg 一视同仁；**管道喂不了**——`-ss` 精确 seek 要能往回跳），
产出一串去过重的候选帧（时刻 + 感知哈希）。整帧要用时才 `frameAt` 去取。

- 取候选走 **I 帧直取**，不做场景检测——后者要解码全片，实测慢 3.7 倍，而更准的帧位置对
  下游没用：花钱的是每帧一次 OCR，帧数由「画面变了几次」决定，那是去重在管的。
- 去重用 dHash 比**上一张留下的**（不是上一张看过的，否则慢慢漂移的画面会一张都留不下）。
- 缩放与灰度由 ffmpeg 直出 **17×16** raw 灰度，**整条链路不解码图片、不引图像库**。不用更省
  内存的 9×8：实测换页信号只有 5 位、淹没在 0–1 位的噪声里（调门槛救不了），17×16 下换页
  是 28 位、噪声 0–2，隔离带够宽（详见 spec §5.3）。
- `DEFAULT_MIN_DISTANCE`（10）已按 17×16 网格的实测数字钉死：噪声底 0–2、换页信号 28，
  量的是合成素材，真实素材噪声底可能更高。

抽帧分**两段路，成本差三个数量级**：探测走 `sampleFrames`（按时刻 seek 取样，每帧一次 range
请求，代价与片长无关）；闸门放行之后才走 `planVideoFrames`（`-skip_frame nokey` 扫完整个文件）。
`mediaDurationS`（`src/media/video-frames.ts`）是全仓共用的时长探测口，`src/media/audio-windows.ts`
的转写热路径也吃它，**别各自维护第二份**。输入既可以是本地路径也可以是 URL——ffmpeg 一视同仁。

- `src/conversions/frames/gate.ts`：要不要抽。只吃转写白拿的东西（字数÷时长、指示语密度）。
  **没有转写 → 抽**：那恰恰说明信息可能全在画面上。**时长量不到时也抽**（`unknown_duration`），
  理由要说实话——不能因为算不出密度就谎称「语速密度低」。这两种「抽」在账上的
  `charsPerMinute` 都记 `null`；只有真转写、真时长都有、算出来就是 0 字/分钟才记 `0`——
  `null`（没量到）与 `0`（真的没人说话）绝不能混，这批读数将来要用来定阈值，混了就污染量法。
- `src/conversions/frames/new-text.ts`：抽到的字里有多少是新的。逐行与**同一时刻**的转写比，
  重合的丢（烧进画面的字幕天生与该时刻语音一致），不重合的留。按时刻不按全片——全片比对会
  误杀「他后面才念到的那页要点」。
- 两处的默认阈值都**还没在真实素材上量过**，是待验证的起点不是判据。

**`frames` 这一层的全部形状是一道逐级止损的梯子**（`src/conversions/converters/frames.ts`），
每一级都留下一份说得出理由的读数（`result.probe`，契约见
[API.md](API.md#conversions转换-转成文字--补说话人--抽帧取画面文字--摘要)）：

| `probe.stop` | 判据 | 这一级的读数 | 付了什么 |
|---|---|---|---|
| `gate` | `framesGate` 判纯口播 | `gate`（判词 + 字/分钟 + 指示语命中数） | 零 |
| `no_source` | `resolveVideoSource` 回 null | — | 零字节 |
| `still_picture` | 稀疏 8 帧两两哈希距离最大值 < 门槛 | `sampled`、`maxDistance` | 8 次 range 请求 |
| `no_new_text` | 探帧挑 2–3 张 OCR，`newTextAt` 全无新字 | + `ocrTried`/`ocrFailed`/`ocrEmpty` | + 3 次 OCR |
| `done` | 全扫 → 逐帧 OCR → 逐帧判增量 | + `planned`/`truncated`/`framesKept` | 全片一遍 |

- **前四级「判为不抽」全是 `status: done`。** 判成 `error` 会让通知中心报错、让用户以为坏了，
  而它恰恰是在正常工作。真失败只有 `source_failed`（取视频地址炸了）/ `sample_failed` /
  `plan_failed`（ffmpeg 自己炸了）三种，
  它们**绝不能混进 `no_source` / `no_new_text`**——否则一次真的取址/取样失败在账上会跟
  「这条 item 就是没有可抽帧的东西」「探过没料」长得一模一样。
- **`track: []` 不是证据**（四级止损都产出空数组）。「没跑」和「跑了没料」的分界线是 `ocrTried`。
- **全扫必须在三道闸之后。** `planVideoFrames` 是唯一读完整个文件的一步（两小时的片子几个 GB），
  而且这一层要**重新取一遍视频源**——转写那份字节只有音轨，复用不了。顺序写反了不会有任何报错，
  只会每条视频都白烧几个 GB 流量。所以三条 ffmpeg 命令（`sampleFrames`/`planVideoFrames`/
  `frameAt`）在 converter 上是**注入项**而不是直接 import：这条不变量只能靠「planVideoFrames
  被调用过几次」来钉，直接 import 就钉不住。
- 视频源两条腿在 `src/media/video-source.ts`，形状一致——**直链 + 那个 CDN 要的 headers**
  （网盘 AList 直链 / `video.resolve` 调用点按 `(provider, vid)` 派发到认领那个平台的包，包的
  resolve 成员给出渐进式直链）。与取音频那条（`src/transcribe/media.ts`）**故意分开**：那条只要能喂
  音轨的 media（含纯音频），这条只认带画面信号的 video-kind media。
  **这条腿只吃直连地址，不吃任何包的容器端点**：某些设施容器的下载端点报错时回 200 + 一段 JSON
  （外面还套着 `video/mp4`），ffmpeg 只会换回一句 `Invalid data found`，真实原因全丢；能翻译那个错误
  信封的只有认识它的包，而 ffmpeg 自己发请求绕不过去——所以解析成员的合同就是「直链 + headers」，
  作品没了 / 私密时成员**抛**带站方原话的 `ContentUnavailableError`。解析器（`makeVideoResolver`）
  自己不往上抛——执行器把成员的错收进 `InvokeResult.misses`、值为 null——所以抽帧和转写那两条腿
  都经第五参 `sink` 接下这一次的结果，成员失败过就把原话（`memberFailureReason`）抛成 Error；
  只是 decline 才落 null（抽帧）/ 通用那句（转写）。
- 逐帧认字走的是与 `extract` 的 ocr 分支**同一条 `parse` 能力行**（同一份「配没配」判据，
  bootstrap 里的 `parseLadderAvailable`）——判据分家的表现是「一个按钮亮着、另一个恒 503」。
- 帧文字轨**不混进正文**：转写是「谁说了什么」，帧文字是「屏幕上写着什么」。今天它只经
  `GET /api/conversions?kind=frames&expand=result` 读得到；合成读口是下一步。

**说话人是一条独立的轴**：`identify`（补说话人）只跑 diarization + 认名，**不跑 STT**——所以给
一条已经转写过的内容补名，不用再付一次 whisper 的钱。转写也不是它的前提（没有转写就只做纯
diarization）。

**说话人数据只有一份存储：声纹库时间线**（`item_diarization`，`src/voiceprint/store.ts`）。
「名字贴在文字上」不是存储物，是读口 `src/voiceprint/view.ts` 用 时间线 × 转写段 读时现算的
投影——现算的永远新鲜，转写重跑后不会读到旧快照。所有改名（enroll、自动抽名、删人撤名）都
只落时间线，投影自动跟上；`identify` 的 `result` 只存探测读数（`probe`）。出现账
（appearances）也只从时间线记。老 item 的存量抄件由启动迁移反推进时间线
（`src/voiceprint/migrate-segments.ts`，幂等）。**别在转写 segments 的 `speaker` 字段上建任何
新读写**——那是历史遗留的死数据，读口会无条件覆写它。收敛始末见
`internal design record`。

对话侧的接线跟着这条分法走，**三个工具，按「起任务」和「读结果」分开**：

| 工具 | 干什么 | 会不会等 |
|---|---|---|
| `extract` | 起转成文字，答「说了什么」。返回的文本**不带任何说话人信息**（哪怕 diarize 开着） | 等，最多 3 分钟 |
| `identify_speakers` | 起补说话人，答「谁说的」，回一份带人名和时间戳的对话稿 | 等，最多 5 分钟 |
| `read_content` | **读口**：把三条轨合成一份按时刻排好的稿子 | 不等，立刻回 |

**起任务和读结果必须分开。**「等一层跑完」和「把已有的拼起来」耗时差着两个数量级，混成一个
工具就只能取其一：要么读一次也可能卡三分钟，要么永远读不到还在跑的那层。

`read_content`（`src/conversions/read-content.ts` + 纯函数 `src/conversions/compose.ts`）是**帧文字轨
在模型这一侧的唯一到达路径**——没有它那层就是没有消费者的死代码。两条不变量：

- **吃哪几层由模型选，不设默认**（`include_speakers` / `include_screen_text`）。能力是逐层累加的，
  帧文字可能有几十行，问「他说了什么」的人不该被迫付这笔 token。
- **每层都带 `state`，内容为空时那才是答案**：`absent`（没跑）/ `running`（在跑）/ `error`（失败）
  / `empty`（跑了没料，**这是有效答案**，`detail` 说得出为什么）/ `ready`。四种「空」合成一个空值，
  就等于让模型据此告诉用户「这视频屏幕上没有字」——而真相可能是那层压根没跑。
- 画面文字在稿子里带 `〔画面〕` 前缀：屏幕上的字和话混在一起，模型会把幻灯片标题当成某人
  说过的原话去引用。
- 说话人的**内容**来自声纹读口的现算投影（`McpExtras.speakers` → `view.ts`）；这一层的
  **状态**只看 identify 记录自己的 `probe`——时间线上还留着上一轮的名字时，一次一无所获的
  识别必须报 `empty`，不能借旧名冒充成功。

`speakerScript`（`src/conversions/speaker-script.ts`）负责并段与序号名：分钟级的 segments 数组永远不进
对话上下文。名单里的 `anonymous` 必须交出去——没认领的簇名字是「说话人 2」这种占位序号，
不标的话模型会把它当真名引用。**序号名的口径与前端 `useSpeakerMap` 一致**（按总发言时长降序）。

`article` 分支打 `article-extract` Provider 行——一条抓取梯子（`strategy: sequential`）：
`article-defuddle`（裸 HTTP + Defuddle，不跑页面 JS，免费、不出境）在前，正文太短（< 200
字符，SPA 空壳）即 decline；`article-firecrawl`（Firecrawl 云端跑 JS）兜底，只在前者 decline
时才出境，静态页因此永远不出境。降级判据在成员内部，梯子外面不做第二次判断（走法记进
`ladder`，见 [API.md](API.md#conversions转换-转成文字--补说话人--抽帧取画面文字--摘要)）。正文里的每张配图
（`![alt](url)` 标记）逐张下载后打一遍 `parse` Provider 行（视觉模型 → MinerU 兜底；MinerU 是可选容器包
`@streamapp/mineru`，没装时 `ocr-mineru` 这一级不亮、梯子到视觉模型为止），识别
结果批注回图片所在行的行尾；未识别的留下 `[未识别：<原因>]` 可见标记，不静默跳过。按图缓存
（`ContentCache` 的 `ocr-image` 命名空间，key = 图片 URL，30 天）。

**Only these two SQLite files exist** — do not add a third for a new subsystem, and **user config
never goes into YAML/JSON**: Channel / Stream / Provider config lives in `data/stream.db` and
nowhere else. `src/store/import-legacy.ts` only adopts rows out of *retired sqlite files* and
sweeps orphan ones; it reads no YAML/JSON. There is no top-level `manifests/` directory either —
Source manifests live in `packages/<id>/manifests.yaml`, one per plugin.

## Where things live (current code)

| Concept / mechanism | Location |
|---|---|
| Channel / Stream / Provider user config | `data/stream.db` (`src/store/user-store.ts`; adoption of retired sqlite files + orphan sweep: `src/store/import-legacy.ts`) |
| research present(manifest 解析、live 列表面、详情面) | `src/board/run-source.ts`, `src/http/live-routes.ts`, `src/http/research-routes.ts` |
| research 前端(一级 live 列表、二级 run 详情、view 注册表) | `app/src/components/ResearchChannel.tsx`, `app/src/components/ResearchRunDetail.tsx`, `app/src/research/` |
| Source manifests | `packages/<id>/manifests.yaml` |
| Plugin descriptors | `packages/<id>/package.json`（`stream` 字段） |
| Adapters | `src/adapters/<id>/`, `src/rsshub-adapter.ts` |
| RSSHub 本体（在哪、哪一份） | `src/rsshub-client.ts` 的 `resolveRsshubPkg`——见下 |
| Browser Recipe schema / runner / packages | `src/replay/`, `packages/<facility>/*.recipe.json`（内置）、`<dataDir>/recipes/<@scope__name>/`（用户装的） |
| 状态图（认状态 / 死路 / 逃生口 / 轨迹） | `src/replay/state-graph.ts`（类型与纯函数）、`state-perception{,-dom,-desktop}.ts`（`identify`）、`state-machine.ts`（主循环，未接线）、`state-classify.ts`（失败后的诊断，**唯一接了线的**）、`state-assemble.ts`、`states-builtin.ts`（CF 三档）、`state-trace.ts` |
| Extension CDP transport / shadow tabs | `shared/browser-relay/`（relay 本体 / wire 常量 / 挑战应答 / 高危闸门 / 元素清单，两侧同吃一份；`src/http/ext-relay.ts` 等旧路径是薄壳）, `src/replay/browser-ext*.ts`, `extension/src/lib/driver.ts` |
| Normalizers | `src/content/<id>.ts`, registry in `src/content/normalize.ts` |
| Channel view materialization (/api/channels/:id/items) | `src/http/app.ts` |
| Exclusive (failover) execution | `src/providers/executor.ts` (Provider rows), `src/scheduler.ts` (Stream harvests) |
| Scheduler (harvest loop) | `src/scheduler.ts` |
| Source health ledger | `src/source-health-store.ts` |
| HTTP app + MCP mount | `src/http/app.ts`, `src/http/mcp-mount.ts` |
| MCP tools | `src/mcp/server.ts`, `src/mcp/tools.ts` |
| Frontend | `app/` |
| 事件循环卡顿飞行记录器（**后端** Node 进程） | `src/loop-lag.ts`（挂在 `src/serve.ts`） |
| 任务边界归因（op-track，卡顿时"谁在跑"） | `src/op-track.ts` |
| OOM 诊断飞行记录器（**前端** Chrome 标签页） | `app/src/lib/diagnostics/`，开关/导出在 `app/src/components/DiagnosticsSettings.tsx` |

## Names & aliases that are still live (read this before renaming anything)

- **Storage shape is `mode: 'feed' | 'collection'` and nothing else** — `scheduler.modeOf()` is the
  sole authority (see Stream → storage shape above). There is no `Stream.kind`, and neither an
  `ordering` flag nor an item-count cap gates collection storage.
  **Nothing writes `options.mode` for you** — there is no boot-time migration, and in practice
  almost every stream leaves it unset and is classified live by `modeOf()` (audio-Channel
  membership, then member manifests). A stored `mode` *shadows* both rules: stamp one and the
  stream stays that way even after joining an audio Channel, so only stamp it when the upstream
  shape genuinely differs from what membership implies.
  `manifest.ordering:'snapshot'` still parses (`src/manifest/loader.ts`) but *only* as a read-alias
  to `mode:'collection'`; it never independently drives behavior. Consumption authority is
  `Channel.present`.
- **netdisk verify/save 的 category 是 `resolve`** — 验活/转存语义上是「key → 一个对象」。
  身份住 `src/providers/system/`，存量库那一列是死数据（**读侧一律取代码**，别去读那一列）。
- **`strategy` 只有 `'fanout' | 'exclusive'`**（`src/store/types.ts`）。写 `failover` 会被 user
  store 直接拒（`src/store/user-store.test.ts` 钉着它抛错）；这个词只活在散文和
  `scheduler.failover.test.ts` 的文件名里，值一律写 `'exclusive'`。
- **"Provider" 只指无状态能力。** 有状态的容灾就是一个 `strategy: exclusive` 的 Stream——别为它
  另造 "Resolver"/"Mirror" 之类的名字，也别把适配引擎叫 Provider。
- **入口概念一律叫 Channel**（code / API / storage：`ChannelRecord`、`/api/channels*`、
  `stream.db.channels`）。三处不叫 Channel 的地方是刻意的：opaque id `default-timeline`/
  `default-audio`，以及 **resolve 模型**的
  `targetType`/`/api/resolve/targets`——那里的 "target" 指*解析目标*，是另一个词。
- **`ChannelRecord.present`**（`timeline|search|audio|video`）是权威字段，注册表在
  `src/providers/presents.ts`（`GET /api/presents`），per-Channel `options.slots` Callsite 覆盖见
  上面 Provider 一节（设计见 `internal design record`）。
  两个别名仍在：HTTP POST/PATCH `/api/channels` 接受 `variant` 作为写别名（老前端），
  `GET /api/channels` 回 `kind` 作为 deprecated 读别名。存量里的 `'mixed'` 在启动时归并成
  `'timeline'`（幂等，`UserStore` migration）。
- **scheduler 只从 `stream.db` 取种**（`referencedStreamIds`）——没有第二个订阅来源。
- 两文件存储模型见 [Data & File Structures](#data--file-structures-target-state)；包一律是
  per-plugin 目录（`packages/<id>/{package.json,manifests.yaml}`）。
