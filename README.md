# Stream

**让你的 AI 探一次路，Stream 把这条路记下来——之后定时跑、不花 token、能进桌面 app，坏了再叫 AI 来修。**

Underneath, a self-hostable **information-flow layer**: many sources — RSSHub routes plus native adapters
(xhs, bilibili, douyin, …) — flow into one inbox, rendered by per-source presenters, served to a
web frontend and to AI agents (MCP) from a single process. Data sources mount as **plugins**;
what you follow is organized into **Channels**; the thing an agent figures out once is a **recipe**,
replayed by the scheduler without a model in the loop.

> **第一次装？直接看 [上手指南](#上手指南装--用)** —— 从一条命令到"它真的在替我干活"，每一步都带判据。
> 三条路（贴一段话给你的 agent / 装了直接用 / 从源码跑）在 `cli/README.md`（npm 页）的开头，那是外人看到的那份。
> 下面这两节是概念地图，装的时候不需要先读懂。

## Architecture in one paragraph

You subscribe to **Channels** (Timeline / Search / Audio). A Channel aggregates **Streams** —
scheduled feed members that pull from one or more **Sources** (`strategy: fanout` merges them
all; `strategy: exclusive` takes the first healthy one). Every Source belongs to exactly one
**Plugin** (adapter + presenter + optional managed backend container), which is how it actually
executes. Stateless on-demand capabilities (search, audio download) are **Providers** — global,
parameterized, internally exclusive over their Sources. Authoritative definitions, invariants,
and data flow: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**. Package/plugin how-to:
**[docs/PACKAGE.md](docs/PACKAGE.md)**.

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

## What runs where

Everything is served behind **one published entry, `http://127.0.0.1:8900`** — and that entry is
**the backend itself**, a native process on the host. It answers `/api/*`, `/ws` and
`/_p/<plugin>` directly and serves the web UI on every other path (Vite in dev, packaged static
in release). No reverse proxy in front of it (see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §Serving).

- `pnpm dev` → backend (hot-reload, `:8900`) + Vite (`:5273`, reached *through* `:8900`): web
  frontend, REST API (`/api/*`), WebSocket feed (`/ws`), scheduler,
  MCP at **`/api/mcp`** (streamable HTTP, same Bearer auth). In the web app,
  the `/channels` page is the plugin/source catalog; channels are managed in the sidebar.
- `docker compose up -d` → the **plugin backends** (pansou, AList, Douyin, …), and nothing
  else. Every one of them is an optional capability — skip them all and harvesting still works,
  because login state comes straight from the browser extension, not from a container.
  Stream's own backend and frontend are *not* in there either: the backend has to sit on the host
  to see the user's own Chrome, which is what human harvest rides. The all-in-one container form
  still exists for NAS/VPS self-hosting:
  `pnpm plugins compose --selfhost > docker-compose.selfhost.yml`.
- `pnpm plugins compose > docker-compose.yml` (+ `--dev` override) → generates that compose,
  managed plugin backends on the shared `stream` network (never hand-write `docker run`).
- `pnpm doctor` → per-source health, failover state, missing-credential prescriptions.

## 上手指南（装 + 用）

这一节是**从零到「它真的在替我干活」**的完整路径，人和 AI 都照它走。每一步都给了**判据**——
一条能跑的命令加一个该看到的答案；判据不过就别往下走，往下走只会把一个静默的失败带到更远的
地方。（下面所有命令在装 Stream 的那台机器上跑；`8900` 是默认端口。）

### 0. 装

```bash
npx @streamapp/stream            # 试一下
npm i -g @streamapp/stream && stream    # 长期用
```

需要 **Node 20+**（`node -v` 查；没有就去 <https://nodejs.org> 装 LTS，Windows 上
`winget install OpenJS.NodeJS.LTS` 也行）。**除了 Node 别的什么都不用装**——不需要 git、不需要
Docker、不需要 Python 或编译器（原生依赖有预编译包）。
大件是**用到才装**，不占开箱体积：RSSHub 在第一次跑到 RSSHub 源时装（约 400MB，实测
43s~147s，看机器和网络）。开箱这一次只有 96 个包 / 230MB，十几秒。

```bash
curl -s 127.0.0.1:8900/api/health        # → {"ok":true,...}
```

- 数据全在 `~/.stream`（`--data <dir>` 可改）。**卸载 = 删掉这个目录 + `npm rm -g @streamapp/stream`**，
  没有别的残留。
- 端口默认 `8900`（`--port` 可改）——**宿主上只有这一扇门**，前端、`/api/*`、`/ws`、插件全走它。
- 从源码跑（要改代码、或者自己写 RSSHub 路由）看下面的 `Setup`。
- **已经在用 Claude Code / Codex / OpenClaw？** 不用手装：把 `cli/README.md` 开头那段提示词贴给它，
  它自己装、自己接 MCP、自己装 skill。

**从命令行跑一条动作 recipe**（不经 agent；要定时就把它填进调度中心的命令执行体）：

```bash
stream recipe run qq-send --param contact=张三 --param message=到了          # 只打印会做什么，退出码 2
stream recipe run qq-send --param contact=张三 --param message=到了 --yes    # 真跑；0 做成 / 1 没读到回执 / 3 没正常收尾 / 4 环境 / 5 够不着后端
```

它是 `POST /api/recipes/action` 的薄壳，两步确认、凭据、限速全在后端那条路上（`src/install/recipe-run.ts` 头注）。

### 1. 把 Chrome 扩展装上 —— 不装的后果是静默的

采集**借你自己浏览器的登录态**（Stream 不自带浏览器，也不存你的密码）。没有扩展，小红书 / B 站 /
抖音这类站点只能拿到游客看得见的东西——**不报错，只是采得少、采得浅**，这是新装机最常见也最难
自己发现的一种坏法。

打开 `http://127.0.0.1:8900`，首次进去会引导你装。手动装是这样：

```bash
curl -s -X POST 127.0.0.1:8900/api/extension/materialize   # → {"dir":"…/.stream/extension"}
```

拿那个 `dir` 去 Chrome：`chrome://extensions` → 打开右上角**开发者模式** → **加载已解压的扩展程序**
→ 选那个目录。（Chrome 从 137 起移除了 `--load-extension`，所以命令行装不了，GUI 是唯一的路。
桌面 agent 在场时 `POST /api/extension/install` 能替你点完这几下。）

**判据**（唯一可信的那个，别看 Chrome 的图标）：

```bash
curl -s 127.0.0.1:8900/api/browser-capability
# → {"state":"ready","connected":true,...}
```

- `"never-seen"` = 从来没连上过 → 还没装，或者装在了另一个 Chrome 上。
- `"disconnected"` = 装过、现在没连 → 点一下扩展图标叫醒它（MV3 的 service worker 会自己休眠，
  后端重启后尤其如此）。

### 2. 订阅第一条流 —— 记得给它一个频道

```bash
curl -s -X POST 127.0.0.1:8900/api/streams -H 'content-type: application/json' -d '{
  "id": "my-podcast",
  "label": "故事FM",
  "strategy": "fanout",
  "cadence_seconds": 86400,
  "options": {},
  "channel_id": "default-audio",
  "members": [{ "plugin": "replay", "source": "@streamapp/lizhi/lizhi-user",
                "params": { "id": "2657184879512415276" } }]
}'
```

**`channel_id` 不是可选的讲究**：一条不属于任何频道的流，本次会话在调度里、**重启之后就没了**
（开机只装载「被某个频道引用的流」）。要绑频道就在建流这一句里绑，别建完再补。
频道 id 用 `curl -s 127.0.0.1:8900/api/channels` 看；开箱自带四个
（`default-timeline` / `default-audio` / `default-video` / `default-tasks`）。

找源：`curl -s -G 127.0.0.1:8900/api/sources --data-urlencode "q=播客"`。**`members[].source` 填它回的
`id`——真正必须对的是这一个**；`plugin` 填它的 `adapter`（`rsshub` / `replay` / `builtin`…）即可，
填错也解析得到（实测：`plugin` 写错、`source` 写对，照样采回 961 条）。**没配好扩展的话，要登录态的源
会采得又少又浅**——回到第 1 步。

**判据**：

```bash
curl -s -X POST 127.0.0.1:8900/api/streams/my-podcast/refresh   # → {"fetched":961,"written":961}
```

`fetched: 0` **不是**"没有新内容"。它一般意味着：`source` 那个 id 在这台机器上解析不到（那条源
来自一个本机没有的 recipe 包）、参数不对、缺登录态、或者那条源坏了。去
`curl -s "127.0.0.1:8900/api/debug/log?channel=harvest"` 看这一轮的分阶段耗时和结论——**日志里
连一条这个源的记录都没有，就是根本没跑到它**（多半是没解析到），而不是跑了没结果。

### 3. 打开需要钥匙的能力（转写、认字、摘要…）

这类能力按「成本阶梯」组织：同一件事有好几档后端，配上哪一档就走哪一档。**先问它现在缺什么**：

```bash
curl -s 127.0.0.1:8900/api/conversion-kinds
# extract 那一行的 branches: {"stt":false,"ocr":true,"article":true}  ← stt 缺钥匙
```

要转写（语音转文字）就配一把 Groq 的 key。**Stream 可以替你去申请**——它在你自己的 Chrome 里
打开厂商控制台、用你**已经登录**的账号建一把新 key，写进本地配置（全程不经过任何第三方）。

> **前提：先在那个 Chrome 里登录 <https://console.groq.com>**（Groq 支持用 Google 账号登录，免费额度
> 够用）。这一步用的就是你现成的登录态——没登录的话它会停在登录页，这不是失败，是缺前提。


```bash
curl -s -X POST 127.0.0.1:8900/api/source-runtime-config/provision \
  -H 'content-type: application/json' \
  -d '{"pluginId":"builtin","sourceId":"groq-whisper","params":{"name":"stream-auto-7f3a"}}'
# → secrets.apiKey.configured: true          （实测 ~17 秒）
```

自己去拿也行（`https://console.groq.com/keys`），然后用 `PUT /api/source-runtime-config` 填进去。
**配完不用重启**，下一次问就该变了：

```bash
curl -s 127.0.0.1:8900/api/conversion-kinds   # branches.stt → true
```

转写一集：

```bash
curl -s -X POST 127.0.0.1:8900/api/conversions -H 'content-type: application/json' \
     -d '{"kind":"extract","item":"<item id>"}'          # → {"id":"cv_…","status":"running"}
curl -s 127.0.0.1:8900/api/conversions/cv_…              # 轮到 status:"done"，result.text 是文字稿
```

（一小时的播客约 4~5 分钟：取媒体 + 重编码占大头，真正的识别只要几十秒。）

### 4. 接一个对话宿主（可选）

Stream 自己没有对话，用你已有的 agent。三步，第三步才是可选的：

**一、装 Stream。** 第 1 步已经做完了（`npm i -g @streamapp/stream && stream`）。
**装了它就有电脑操作**——用户自己那个已登录的 Chrome，加上原生桌面窗口。

**二、宿主那边配一行，指向 Stream。**

```bash
claude mcp add stream -- stream mcp      # Codex 是 config.toml 的 mcp_servers 一行
```

`stream mcp` 是一层 stdio 壳：它探一次本机的后端，在场就整面转发到 `/api/mcp`，不在场就先把
后端拉起来再转发。**这一行此后不用再改**——往 Stream 里加多少能力，工具都从同一个口出去。

**三、想要更多能力就往里加：**

```bash
stream add @streamapp/netdisk      # 网盘：验分享 / 转存 / 直链 / 跳转
stream remove @streamapp/netdisk   # 不想要了
```

能力包是 Stream 包的一格槽位（`package.json#stream.capability`），装进 `<dataDir>/recipes/`
后由后端在**自己进程里**挂上——登录态不出这个进程。组件页里点装是同一条路。
**装完要重启后端才生效**（安装那一刻只落盘），装上了没有的话先重启再排查。

内容检索与下载适配器不随新安装默认带上；需要时由你明确选择安装：

```bash
stream add @streamapp/bt0
stream add @streamapp/btbtla
stream add @streamapp/1lou
stream add @streamapp/zuna
stream add @streamapp/toubiec
stream add @streamapp/shooter
stream add @streamapp/iqiyi
```

它们仍是独立的 Stream 包，默认不带只是避免发行包替用户决定内容来源；安装、审核与卸载都走同一条
`stream add` / `stream remove` 链路。

再往下：第 6 节把 Stream 的 skill 装给你的 agent（MCP 给工具，skill 给"什么时候用哪个"）。

#### DSH 用户多一样：Stream UI bundle

DSH 装上它之后整张脸就是 Stream（内容流 + 对话）。它也读第 6 节装的那批 skill（同一个
`~/.agents/skills/` 目录）：

```bash
npm i -g @deepseek-ai/dsh@0.2.0-rc.2   # 引擎版本要对得上：这份 bundle 按 0.2.0 的客户端模块表构建
# 装进已经带 web 界面的那个 profile（$DSH_HOME/profiles/web）——bundle 关掉的是 web-app 的整页壳，
# 新建的空 profile 里没有它可关。想单独留一个 profile 给 Stream：先 cp -r profiles/web profiles/stream，再把下面的 web 换成 stream。
dsh plugin --profile web add @streamapp/dsh-plugin-stream-ui
dsh web                                                          # 单独的 profile 就是 dsh --profile stream
```

这份 bundle 是**唯一**要装进 DSH profile 的东西；能力包一律装进 Stream，DSH 那边一个字都不用改。
Stream 后端照常跑着就行（`stream`），那张页在本机哪个口上都不用告诉它——本机来源默认可信。
后端和 DSH 不在同一台机器时才需要登记：`STREAM_TRUSTED_ORIGINS=http://<那台机器>:<口> stream`。

> **模型是你自己的**：在 DSH 的「设置 - 模型」页配 provider；Stream 不参与。
> **前面三步都不依赖它**——收集、采集、转写都不用模型。

### 5. 接给别的 AI 客户端（MCP）

不走 `stream mcp` 也行：后端跑着就直接用 HTTP 这一档 `http://127.0.0.1:8900/api/mcp`
（设了 `api_token` 才需要 `Authorization: Bearer …`）。不想让后端常驻就用 stdio 那一档，
客户端按需拉起进程。三条路的工具集完全一样，细节见下面的 `MCP usage`。

### 6. 把 Stream 的 skill 装进你自己的 agent（Claude Code / Codex）

上一步给的是**工具**，这一步给的是**手艺**——什么时候用哪个、按什么顺序、什么算数。只给工具
不给手艺，模型会把它们用成一次性的查询。

```bash
curl -s -X POST 127.0.0.1:8900/api/skills/install
# → {"dir":"…/.stream/skills","hosts":[{"host":"claude-code","root":"…/.claude/skills","landings":[…]}]}
```

它做两件事：把随包出货的 skill 刷进 `~/.stream/skills/`，再从 `~/.claude/skills/`（Claude Code）
和 `~/.agents/skills/`（Codex）**链接**过去。是链接不是拷贝——所以
`npm i -g @streamapp/stream` 升级之后，两个 agent 手里同时变新。

**判据**：

```bash
curl -s 127.0.0.1:8900/api/skills     # hosts[].landings[].mode 都是 "link"
```

Claude Code 里敲 `/stream-` 就能看到它们，Codex 里是 `$stream-`。

- 名字一律带 `stream-` 前缀，**不会顶掉你自己的同名 skill**；那个位置已经有别的东西时它跳过
  并在回执里说明，绝不覆盖。
- 撤销：`POST /api/skills/uninstall`（只删它自己建的那些，你手写的同名目录一个都不碰）。
- `mode` 报 `"copy"` 说明这台机器建不出符号链接——功能一样，但升级后要再跑一次 install。

---

### 给 AI 的一页：判据，不是叙述

替人装 Stream 时，**每一步都以副作用为准**，不要以"我已经装好了"为准——这条链路上每一种坏法都
是安静的（采到游客态数据、流不排班、能力显示可用但一跑就失败）。按顺序把这几句跑完，全绿才算装完：

| 问 | 命令 | 绿的样子 |
|---|---|---|
| 后端活着吗 | `curl -s 127.0.0.1:8900/api/health` | `{"ok":true}` |
| 采集的手在不在 | `curl -s 127.0.0.1:8900/api/browser-capability` | `"state":"ready"` |
| 目录装载了多少 | 启动日志 `[stream] registry: …` | `N curated + M recipe + K RSSHub catalog` |
| 这条流真的在调度里吗 | `curl -s 127.0.0.1:8900/api/streams` | 能看到你刚建的 id |
| 它真的采到东西了吗 | `POST /api/streams/<id>/refresh` | `fetched > 0` **且** `written > 0` |
| 这个能力现在能用吗 | `curl -s 127.0.0.1:8900/api/conversion-kinds` | 那一条 `available` / `branches.*` 为 true |
| 这件事为什么做不了 | MCP 工具 `capability_status` | 它会分清「缺钥匙且我能替他申请」/「缺钥匙只能他自己拿」/「根本不是缺钥匙」 |

三个最容易误判的地方，都真栽过：

- **`fetched: 0` 不等于「没有新内容」。** 更常见的是参数不对或缺登录态。判之前先看
  `GET /api/debug/log?channel=harvest`。
- **建完流不给频道归属**，它这次会跑、重启后消失；导入分享包时更彻底——落库了但从来不排班，
  而导入回执是成功的。建流时就带 `channel_id`。
- **"配好了"不等于"能用了"。** 判据永远是那条能力自己的自述（`/api/conversion-kinds`），
  不是配置那一格的 `configured`。

更深的一层（给对话 agent 加工具、写提示词、验它真照做）见
[docs/AGENT-TOOLING.md](docs/AGENT-TOOLING.md)。

## Installation shapes: pure-MCP core, plus optional persistent service

Stream installs in layers, and **only the base is required**:

- **L0 core** — the node backend + MCP (this repo, one codebase, one entry point). Always present;
  everything below just points at it. `Setup` below walks through installing L0.
- **L1 MCP registration** — point an MCP client (Claude Desktop, …) at the core over **HTTP**
  (`http://127.0.0.1:8900/api/mcp`, one command, full tool set). From a **source checkout** there is
  a second option — the stdio entry, which the client spawns on demand and which needs no standing
  backend (see `docs/ARCHITECTURE.md` §Serving → "MCP over stdio"); the published npm package does
  not ship it. Either way you get the same tools — see `MCP usage` below.
- **L2 persistent (optional)** — run the core as a long-lived OS service so scheduled harvesting
  keeps running with no window open. An opt-in switch, not the default.
There is no desktop shell — the UI is the panel the backend itself serves on `127.0.0.1:8900`
(plus the Stream UI plugin you can install into your own chat host). L2 is an independent add-on
that can be installed or removed without touching the core underneath. This README's `Setup`/`Run`
sections below cover the L0 (+ L1) path, which is everything you need today.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node 20+ | RSSHub itself wants 22.22.2+, but it is installed on demand, not as a dependency |
| pnpm 10+ | `npm install -g pnpm` |
| WSL2 / Linux native FS | If you clone **RSSHub**, put it under `~/projects/` (ext4), not `/mnt/c/...` — pnpm symlinks fail on drvfs |
| RSSHub clone (built) | **Optional.** Stream installs the prebuilt `rsshub` package into `<dataDir>/rsshub` the first time an RSSHub source runs; clone it only to author routes yourself. Setup step 2 |
| Docker + Compose (optional) | Only for plugin backends (pansou, AList, Douyin, …) and optional container packages installed with `stream add` (`@streamapp/ddddocr` / `dewatermark` / `mineru` / `voiceprint`, from [stream-packages](https://github.com/JaggerH/stream-packages)). Not needed for harvesting — login state comes from the browser extension |

---

## 升级须知（老装机必读）

系统 Provider 的身份现在住在代码里（`src/providers/system/`），启动期**不再有任何 provider 数据
迁移**——库里那几列是死数据，代码一改就是新身份。代价是这条迁移链一并删掉了，所以一份**早于
`33221b4c` 的库**升过来会缺那几步（改名的行、退役的行、补过的成员）。

升级路径：先 checkout `33221b4c` 跑一次（让它把库带到当前形状），再升到新版。全新安装无此顾虑。

## Setup

### 1. This repo
```bash
git clone <this-repo-url> stream && cd stream
pnpm install         # builds better-sqlite3 (approved via pnpm-workspace.yaml allowBuilds)
```

### 2. RSSHub as a sibling lib — optional
`pnpm install` already pulled the prebuilt `rsshub` package, and that is what runs when no clone is
present. Clone it when you want **either** of the two things the package can't give you: authoring
RSSHub routes yourself (the clone's TypeScript sources are what a source checkout runs — it wins over
the package), or the full ~3000-route catalog in the source picker (`assets/build/routes.json` is a
build artifact of the clone and is absent from the npm tarball).

```bash
git clone --depth 1 https://github.com/DIYgod/RSSHub.git ~/projects/RSSHub
cd ~/projects/RSSHub && pnpm install && pnpm build:routes   # routes.js is REQUIRED
```
To develop against an RSSHub checkout, set `RSSHUB_PKG=/abs/path/RSSHub/lib/pkg.ts`.

### 3. Configure
```bash
cp config.example.yaml config.yaml          # edit paths
```
Subscriptions live in `data/stream.db` (created on first boot) — add them from the web UI,
the HTTP API (`POST /api/streams`), or the MCP `subscribe_source` tool.

### 4. Verify the suite
```bash
pnpm test
pnpm typecheck
```

### 5. Run
```bash
pnpm dev                                                    # backend (:8900) + Vite (:5273)
curl -s http://127.0.0.1:8900/api/health                    # {"ok":true} when up

# optional — plugin backends (pansou / AList / Douyin / …), reached at /_p/<plugin>
pnpm plugins compose        > docker-compose.yml            # baked images
pnpm plugins compose --dev  > docker-compose.override.yml   # dev: bind-mount + hot reload
docker compose up -d                                        # compose auto-merges both
```
Single entry `http://127.0.0.1:8900` — frontend, API, WS, MCP, plugin backends all behind it,
and that entry is the backend itself. Day-to-day ops (logs, dependencies, the self-hosted
all-in-one container form): [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

---

## Configuration

Two layers, and they answer different questions.

**`config.yaml`** (gitignored; `config.example.yaml` is the annotated source of truth) — where things
live on this machine, read once at boot:
```yaml
vault_root: /path/to/obsidian/vault/streams   # optional markdown mirror of ingested items
vault_enabled: true           # false = keep only the app read model (sqlite)
dedup_db: ./data/dedup.db
packages_dir: ./packages      # builtin Stream packages (plugins + recipes, one layer)
```

**`data/settings.json`** — everything you set from the running app (LLM connections,
AList, per-source runtime config, plugin toggles). Written by the Settings page, the browser
extension's one-click Connect, and the corresponding `/api/settings/*` endpoints; hot-applied, no
restart. **This overlay always wins over `config.yaml`**, so don't keep a second copy of these
values in the yaml — a stale duplicate there does nothing until the day the overlay is lost, and
then it silently takes over.

---

## Ad filtering (fold, don't delete)

Item-level, deterministic, opt-in. Add an `ad_filter` block to `config.yaml`:
```yaml
ad_filter:
  keywords: [推广, 赞助, 恰饭, sponsored]   # vs title + body + source category tags
  domains:  [taobao.com, jd.com]            # vs item urls; also matches subdomains
```
Keywords also match the source's own `category` tags (RSSHub `item.category`) — the
high-precision signal: v2ex's 推广 node flags promos there even when the title looks
innocent. Caveat: broad topic words (`广告`) substring-match *news about* advertising
on news feeds — prefer ad-specific phrases and lean on category.
On ingest each item is checked; a match sets `muted: { reason: 'ad', rule }` on the
`StreamItem` (the matched rule is kept so the routing is explainable). Muted items are
**folded into a dedicated 广告 channel** in the sidebar (below the channel list) —
they still land in the read model and are kept out of All Latest and every stream view,
but one click on 广告 shows them. Nothing is dropped, so a false positive is fully
recoverable. A canonical default rule set ships built-in (`src/content/ad-rules.default.ts`);
config rules extend it. Classifier: `src/content/ad-filter.ts`; the channel is a
client-side virtual view (`app/src/lib/items.ts`, `ADS_CHANNEL`).

---

## Adding a source (manifest)

Add an entry to the owning package's `packages/<id>/manifests.yaml` (a top-level YAML list). The `description` / `topics` / `example_queries` are what `stream_search` matches — write them well or the source is undiscoverable.

```yaml
id: weibo-friends
adapter: rsshub
description: 微博关注的人的最新动态时间线。
topics: [微博, weibo, 社交, 关注]
example_queries: [微博好友动态, what my weibo follows posted]
capabilities: [timeline]
auth: { type: cookie, domain: weibo.com }   # or { type: none }
route: /weibo/friends
cadence_hint_seconds: 600
params_schema: {}
```
Route templating: use `{key}` placeholders filled from a stream's `params` (e.g. `/bilibili/user/dynamic/{uid}`). For ad-hoc routes there's a non-discoverable `rsshub-raw` source that takes a literal `route` param.

Cookie domains are mapped to RSSHub env vars in `src/cookie-mapper.ts` (bilibili, weibo, xhs, zhihu, twitter/x, github). Add entries there for new platforms.

For a source that needs its own adapter/presenter/backend container (a new **plugin**), follow
`docs/PACKAGE.md` — worked example (douyin) and copy-paste template (pansou) in §10.

---

## Subscribing a stream

A Stream references sources and may fan-out. Subscribe from the web UI, or via
`POST /api/streams` — the stream persists in `data/stream.db`:

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
not in a follow-up PATCH) and `contract`. Anything else is **rejected with 400** listing the
accepted names — a misspelled field is never silently dropped.

- **`plugin` + `source`** — `plugin` is the owning package's id (`packages/<id>/package.json`
  `stream.id`), `source` is an entry id from that package's `manifests.yaml`. The pair is joined
  into `<plugin>:<source>` and looked up in the registry, which falls back to the bare `source`
  name, so `source` is what actually has to be right. A source collected by recipe in your own
  logged-in Chrome belongs to the `replay` plugin
  (e.g. `{ "plugin": "replay", "source": "lizhi-user", "params": { "id": "…" } }`).
- **`options`** — the free-JSON home of a stream's side fields: `vault_subdir` (defaults to the
  stream `id`), `mode`, `ad_filter`, `harvest`. No schema, no migrations.

Over MCP the equivalent is **`subscribe_source`** (give it a source id and params; it derives the
id/vault_subdir and upserts, so re-subscribing the same source+params lands on the same stream).
`stream_subscribe` is the low-level variant for hand-authoring a whole stream; it takes its own
shape (`{id, description, sources:[{source_id, params}], cadence_seconds, vault_subdir}`) and
assigns no channel.

For a feed reachable through several backends, use `"strategy": "exclusive"` (the word *failover*
survives only in prose and test file names — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):
`members` become an ordered ladder and only the first **healthy** one is harvested (a per-source
health ledger marks dead/degraded backends; a `browser`/`browser-page` member can be the last
rung). Run `pnpm doctor` to see each source's health. See `docs/PACKAGE.md` §9.

---

## MCP usage

Stream exposes the **same tool set over two transports** (one shared tool codebase,
`src/mcp/tools.ts` + `src/mcp/tool-catalog.ts`) — pick per client:

| Transport | Available in | Use when | Needs a standing backend? |
|---|---|---|---|
| **stdio** — `stream mcp` | **every npm install** | the default. One line, and it works whether or not the backend happens to be up | **No** — it starts one for you |
| **HTTP** (streamable) | **every install** (npm, source) | you already keep a backend running and would rather point the client straight at it | **Yes** — `/api/mcp` only answers while the backend listens |
| **stdio** — `src/mcp/stdio-entry.ts` | **source checkouts only** | you are working in the repo and want read tools to keep answering with no backend at all | **No** |

**The one line for a normal install** (the CLI's `stream` bin is the stdio entry — there is
nothing to point at a checkout):

```bash
claude mcp add stream -- stream mcp
```

**What `stream mcp` does** (`src/install/mcp-command.ts`): it probes `GET /api/health` on
`STREAM_BACKEND_URL` (default `http://127.0.0.1:8900`, 2 s), then forwards every `tools/list` /
`tools/call` to that backend's `/api/mcp`. **It loads nothing itself** — no StreamService, no
database handle, so it structurally cannot become a second writer. Backend absent → it spawns one
(the same `bin/stream.mjs`, no separate startup path) and forwards once health goes green. Two
hosts racing to spawn is benign: the loser dies on `EADDRINUSE` and forwards to the winner.

**The source-checkout entry is a different thing** (`src/mcp/stdio-entry.ts`, `pnpm mcp:stdio`).
It probes the same way, but with the backend absent it opens the on-disk stores itself and serves
**read** tools (list/search/read/preview/status) directly, while **write/action** tools (subscribe,
refresh, transcribe, netdisk apply, `chrome_*`, …) return a structured `needs_backend` error — no
second writer, no surprise process spawn.

Full mechanism (probe rule, degrade list, env vars) lives in
[`docs/ARCHITECTURE.md` → *MCP over stdio*](docs/ARCHITECTURE.md).

### Registering it in a client

The **stdio command on a normal install is `stream mcp`** — no path, no env var, because the
backend it talks to (or starts) already knows its own data dir. From a **source checkout** you can
instead register `npx tsx --tsconfig <abs>/stream/tsconfig.json <abs>/stream/src/mcp/stdio-entry.ts` (env: `STREAM_DATA_DIR` = the data
dir; optional `STREAM_BACKEND_URL`, `STREAM_CONFIG`) to keep the read-off-disk fallback.
**Keep the `--tsconfig`**: tsx reads the `tsconfig.json` of the client's *working directory*, not Stream's — opened
from another project whose tsconfig tsx can't parse (e.g. `paths` without `baseUrl`), the server dies on start and
the client only reports `CONNECTION_CLOSED`.
The **HTTP** form needs no command, only the URL —
`http://127.0.0.1:8900/api/mcp` (the single entry — the same one whether that backend was started
by `pnpm dev`, the installed `stream` command, or the self-hosted container stack); add
`Authorization: Bearer <api_token>` only if you set `api_token`.

> **Tool-list changes are server-side.** When the served tools change (e.g. a tool is renamed),
> nothing to reinstall — each client just **reconnects/restarts** to re-pull `tools/list`. A
> running session keeps the list it fetched at startup.

**Claude Code** (`claude mcp add`)
```bash
# stdio — the normal install; starts the backend if it is not up
claude mcp add stream -- stream mcp
# HTTP — backend already running
claude mcp add --transport http stream http://localhost:8900/api/mcp
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

**antigravity / Gemini CLI** (`~/.gemini/settings.json`)
```json
{ "mcpServers": { "stream": { "command": "stream", "args": ["mcp"] } } }
```
For the HTTP form use `"httpUrl": "http://localhost:8900/api/mcp"` in place of `command`/`args`.

**Claude Desktop** — same `mcpServers` JSON shape as antigravity above.

Core tools (fixed surface, independent of source count): `stream_list`, `stream_search`,
`stream_read`, `stream_subscribe` / `stream_unsubscribe`, `stream_status`. Further tools cover
content search, transcription, document parsing, video/music search+resolution, and intent
resolution — see `src/mcp/server.ts`.

---

## Login state (cookies)

Cookie-protected sources (bilibili, weibo, xhs, quark, …) need your browser's login state.
**The backend asks for it; the extension never sends it.** Over the same authenticated relay the
harvest rides, the backend issues `op:'cookiePull'` for the domains it needs and the extension
answers with those cookies out of your Chrome. It lands in `data/cookies.json`, mode 0600.

The backend asks because only it knows *when* the login state is needed — a harvest is starting,
its snapshot has gone stale, a request just came back 401. It pulls when the relay connects, before
a harvest whose snapshot is older than 5 minutes, and whenever the extension reports that a synced
domain's cookies changed. There is no timer on either side.

**There is nothing to configure, and no container involved.** Install the extension
(`extension/README.md`), point it at your Stream, done. Which domains it reads is derived from
what you actually have installed and subscribed to — the backend hands the extension that list,
so a newly added login-gated source is covered without you editing anything.

Plugin backend containers never hold credentials — not in the image, not in `env`, not in the
generated compose. The host is the only scheduler: it resolves the cookie a call needs and hands
it down. A package only *declares* which domains it may be given (`stream.credentials`).
See `docs/PACKAGE.md` §5.1.

---

## File Layout

```
stream/
├── packages/                  builtin Stream packages (committed) — plugins + recipe packages, one dir each
├── config.yaml                YOUR config (gitignored)
├── data/                      stream.db (user config) + cache.db (items/dedup) (gitignored)
├── app/                       web frontend (Vite + React)
├── docs/                      ARCHITECTURE.md, PACKAGE.md, api.md, …
├── src/
│   ├── manifest/              SourceManifest types + validating loader
│   ├── registry/              registry + lexical search backend
│   ├── adapters/              Adapter type + host-owned adapters only (builtin, replay, favicon, safe-fetch); facility adapters live in packages/<id>/
│   ├── rsshub-adapter.ts      RSSHub adapter (route templating + raw passthrough)
│   ├── content/               presenters (+ ad filter) — raw item → display model
│   ├── packages/              Stream package descriptor parser + scanner (one shape for all packages)
│   ├── plugins/               plugin projection of a package + compose generator + CLI
│   ├── credentials/           CredentialProvider/Resolver + cookie/token providers
│   ├── named-streams/         NamedStream types + source-id helpers
│   ├── resolve/               resolve engine（targetType/key 解析模型）+ intent 分类
│   ├── scheduler.ts           registry-driven scheduler (fan-out/failover + shared dedup)
│   ├── http/                  Hono app: REST API + MCP mount
│   ├── mcp/                   StreamService + MCP server (tools.ts, server.ts)
│   ├── doctor/                per-source health CLI
│   ├── bootstrap.ts           wires the stack from config
│   └── serve.ts               single-process entry (API + WS + scheduler + MCP)
└── openspec/ , internal design records/   specs + plans
```

---

## Testing

```bash
pnpm test          # vitest run (unit; fake adapters, no network)
pnpm test:watch
pnpm typecheck     # tsc over src/
```

---

## Status

Dogfooding daily. Stream is licensed under the [Apache License 2.0](LICENSE).
