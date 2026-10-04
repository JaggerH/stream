# @streamapp/dsh-plugin-stream-ui

[Stream](https://github.com/JaggerH/stream) 的 DSH 客户端 UI 插件：在用户自己的 DSH 里
接管整页布局壳（Stream 内容流为主面、对话为侧面），并把 Stream MCP 的工具回执渲染成
定制卡片。

这个包是**两半**的：

- **host 半**（`main`）跑在 DSH 引擎里。它唯一的职责是把这一行的 `streamBaseUrl` 配置
  经 `webServer.tapIndex()` 注入页面（`window.__STREAM_UI__`）——浏览器那半拿不到自己
  那一行的 config，这是 DSH 客户端装载器的形状决定的（详见 `src/wire.ts` 头注）。
- **client 半**（`exports["./client"]`）跑在浏览器里，读那个常量，装载 Stream 后端的
  面板资产并渲染卡片。

面板 bundle 有**两个挂载点**，这个壳把它们摆在两处：内容区（主面）与「空间 → 频道」
导航树（侧栏里那一段，8900 独立正门挂的是同一份）。**壳不复刻导航**——建删改名、折叠记忆、
"这个频道画得了吗"的判据全在面板那侧，壳只决定摆哪、把配色 token 指到 DSH 自己的变量
（`NAV_TOKEN_OVERRIDES`，由 `test/nav-token-overrides.test.ts` 对着面板那份名单核账）、
把"用户点了一行频道"接回自己的布局联动。

`exports["./registry-table.json"]` 是这个包渲染哪几个工具的**数据面**（tool → 定制卡 /
通用卡 + 理由）。运行时用不到它——构建时已经内联进两份产物；导出它是为了让外部（Stream
主仓的 parity 测试、任何想知道"这个包会画什么"的工具）读得到同一份真相。

**这是 Stream 唯一一个装进 DSH 的包**，因为它画的是 DSH 那张页。手上的那几件能力
（电脑操作 / 网盘）**不装进 DSH**：它们是 Stream 包的一格能力槽位，用户
`stream add @streamapp/<x>` 装进 Stream 后端，工具从 8900 的 `/api/mcp` 出去。

## 装法

它是一个 DSH **bundle**，必须装进一个**已经带 `@deepseek-ai/dsh-web-app` 的** profile——
bundle 关掉的是 web-app 的整页壳，新建的空 profile 里没有它可关。用你已有的 `web` profile
（`$DSH_HOME/profiles/web`），或者先 `cp -r profiles/web profiles/stream` 拷一份专用的：

```bash
npm i -g @deepseek-ai/dsh@0.2.0-rc.2   # 引擎版本要对得上，理由见下面「引擎版本」一节
dsh plugin --profile web add @streamapp/dsh-plugin-stream-ui
dsh web
```

`dsh plugin add` 会把本包列进那个 profile 的 `dsh.profile.bundles`（DSH 认到 `package.json#dsh.bundle`
就自动做），`cordis.patch.yml` 随之叠上去：关掉 web-app 的整页壳、插一行 MCP 客户端指向
`http://127.0.0.1:8900/api/mcp`、插本包。Stream 后端要另外跑着（`stream`）；这张页的 origin 是本机
地址，后端默认就认，不用登记。

## 引擎版本

**这份 bundle 跟着 `@deepseek-ai/dsh` 的客户端模块表走，两边版本必须对得上。** 浏览器那半不是
普通 ESM：宿主页面用自带的装载器把每个客户端包注册进去，`require` 只解析得了**一张表**——

- **平台种子表**（页面 shell 硬编码，`react` / `react/jsx-runtime` / `react-dom` /
  `react-dom/client` / `@deepseek-ai/cordis` / `@deepseek-ai/dsh-client-store` /
  `@deepseek-ai/dsh-client-ui-slots` / `@deepseek-ai/dsh-client-ui-primitives`）；
- 加上本包 `package.json#dsh.client.external` 逐条申报、且在 boot 图里有对应行的那些
  （今天只有一条：`@deepseek-ai/dsh-api-session-controller/client`，为了 `createScope`）。

表外的任何运行时 `require` 都会当场抛 **"missed the module table"**，整批客户端插件跟着起不来，
页面只剩 "Failed to load plugins"。**类型 import 不算**（`import type` 被擦掉，不产生请求），
所以卡片那些 `ToolCallBlock` 之类可以从任意包取。

版本要往上跟时，先读 `@deepseek-ai/dsh-client-modules` 的 README（模块表机制的真相源），再对
`test/contract.test.ts` 里钉住版本号的那条闸门。

后端不在本机或换了口：在 `$DSH_HOME/profiles/stream/cordis.patch.yml` 里覆盖同一个行 id 的 config
（`stream-mcp.url`、`stream-ui.streamBaseUrl`），别改本包；后端那边则要把这张页的 origin 登记进
`STREAM_TRUSTED_ORIGINS`（本机来源之外的页面才需要）。

## 开发

```bash
npm install
npm run typecheck && npm run test && npm run bundle   # 产物落 lib/
```

本地开发时把这个目录当 bundle 装进一个 dev profile（`dsh plugin --profile stream-dev add
file:<本目录绝对路径>`），`npm run watch` 重建 `lib/` 后刷新页面即生效；Stream 后端不参与装载。

## 发布

```bash
cd hosts/dsh
npm publish --access public     # prepublishOnly 会先跑 typecheck + test + bundle
```

前置与边界：

- 发之前 `npm pack --dry-run` 看一眼清单：应当只有 `README.md`、`package.json`、
  `cordis.patch.yml`、`registry-table.json` 和 `lib/` 里的四个文件（源码/测试/node_modules
  一个都不进）。
- `lib/` 被 gitignore：**它只存在于构建之后**。`prepublishOnly` 保证 publish 走这条路，
  但如果你手动 `npm pack` 打 tarball，得自己先 `npm run bundle`。
- npm 上 `@streamapp` scope 需要发布权限（`npm whoami` 确认登录的是有权限的账号）。
