## Why

用户的 Chrome 常有多个 profile：工作一个、个人一个，同一个网站在两边登着不同的账号。Stream 今天分不清它们：

- **本机只认一个扩展连接。** 本机绑定只有一条 `local`，`ExtRelay.connect` 以最新为准、顶替旧连接——两个 profile
  同时开着，扩展会互相把对方挤下线，采集落到哪个 profile 看谁后连上。
- **远程绑定只认到设备。** 一台设备挂几条绑定时，`ExtRelayRegistry.pick` 取设备默认、否则最近连上的那条，
  和这次执行该用哪个账号无关。
- **登录态按设备一份，整份替换。** `data/cookies/<deviceId>.json` 由设备上被选中的那条绑定拉取。两个 profile
  轮流被选中，快照就在工作账号和个人账号之间来回覆盖；纯 HTTP 的采集与动作拿到哪份是偶然的。
- **扩展不知道自己在哪个 profile 里。** Chrome 不给扩展任何读 profile 的 API。

后果不只是采错号。用个人号发了一条本该用工作号发的消息、在工作环境里下了个人的单，这类事故比「没执行」严重得多，
而今天没有任何一层能拦住它。

device-execution 的 Non-Goals 明确留下了这道题（「不做同一站点多账号」）。本 change 接着做。

## What Changes

- **浏览器节点。** 一个 Chrome profile 里的一个扩展实例 = 一个节点，由扩展首次运行时生成的 `nodeId` 标识（存在该 profile
  自己的 `chrome.storage.local` 里，天然按 profile 隔离）。扩展握手时报上 `nodeId`。本机绑定从「一条 `local`」变为
  「每个节点一条」，同一台机器上的多个 profile 可以同时在线、互不顶替。
- **profile 认领。** 设备上的 host agent 新增两个 op：`browser.profiles` 读 Chrome 的 `Local State` 列出 profile
  （目录名、显示名、登录的 Google 邮箱）；`browser.claim` 用 `--profile-directory=<dir>` 打开扩展自己的认领页
  `chrome-extension://<id>/claim.html#<nonce>`。这个页面只会在那个 profile 里打开，由那个 profile 的扩展实例接住，
  把 `nonce` 和自己的 `nodeId` 报回 Stream——节点与 profile 由此对上。扩展记住自己的 profile，以后不再需要认领。
- **环境。** 用户给每个节点标一个环境（「工作」「个人」或自定义），随运行记录留痕，也可作为路由目标。
- **站点身份。** 包在登录声明里可选地加一个 `whoami`（一个返回当前账号的接口 + 取 id / 昵称的路径）。Stream 在每个节点上
  探测各 facility 当前登录的是谁，得到一张「facility / 账号 / 在哪些节点上」的表。没有 `whoami` 的 facility 按节点区分，
  身份记为「该节点上的账号」。
- **按身份路由。** facility 的默认目标与任务覆盖除了「设备」之外可以是「身份」或「环境」。解析出身份后：找一个在线且确实登录着
  该身份的节点；没有在线的、但知道它在哪个 profile，就让 host agent 唤起那个 profile 并等它连上；执行前再核对一次身份。
  **任何情况下都不换身份顶上**：找不到 = `identity-offline`，核对不符 = `identity-mismatch`。
- **登录态按节点。** cookie 快照从按设备改为按节点：`data/cookies/<deviceId>/<nodeId>.json`。一次执行的 `cookieFor`
  读的是这次执行选定的那个节点的快照。
- **一个 profile 一个 Stream 标签组，撤掉「Stream 独立窗」。** 今天 AI 驱动的标签在别的窗口里开出新标签时，扩展会在那扇窗里
  另建一个「Stream 独立窗」组，窗和组只增不减（用户实测攒了近 50 个）。改为：每条绑定在浏览器里至多一个组；别的普通窗里冒出来的
  标签挪进主组那扇窗；升级时收编旧的独立窗组。
- **留痕。** 运行记录加节点、profile、环境、账号；面板与扩展 popup 都显示「这是哪个 profile / 哪个环境」。

## Capabilities

### New Capabilities
- `browser-node`：节点标识、本机多节点、profile 认领、环境标注。
- `site-identity`：`whoami` 声明、身份探测、身份表、执行前核对。
- `identity-routing`：身份 / 环境作为路由目标、按需唤起 profile、失败语义。

### Modified Capabilities
- `device-browser-relay`（device-execution）：本机绑定按节点；配对绑定与节点一一对应。
- `device-scoped-credentials`（device-execution）：登录态由（设备，域名）改为（节点，域名）。
- `device-execution`（device-execution）：解析顺序加入身份与环境；运行记录加字段。

## Dependencies

- `device-execution` 全部计划（已合并，未归档）：设备、扩展绑定、执行上下文、`pickBrowser`、按设备的 cookie 拉取。
- host agent 的 `ensureApp` / `launch.rs`（已有 `--profile-directory` 支持）。

## Non-Goals

- **cookie 不出浏览器**（请求改由扩展在浏览器里代发）。这是上云前要做的另一件事，单独开题；本 change 只把快照的粒度从设备
  缩到节点。
- **按环境的策略**：工作环境的动作一律审批、工作数据不进个人的 Intent 与记忆。环境在本 change 里只是标签与路由目标，策略
  归将来的大脑 change。
- **同一 profile 内切换账号**：一个 profile 里一个站点同一时刻只有一个账号；要两个账号就用两个 profile。
- **Chrome 以外的浏览器**：认领只在 Chrome 上验证。Edge 等 Chromium 系的 `Local State` 同构，但不在本 change 的验收范围。
- **没有 host agent 的机器做认领**：只有扩展、没有 agent 的 Chrome 仍能作为节点，但只能由用户在配对时手动起名，不能被自动唤起。
- **云端多租户**：本 change 在本机单用户的现状下落地；节点、身份、路由这几个概念在云端照样成立，不为上云另做设计。

## Impact

- 扩展：`nodeId` 生成与持久化、握手带 `nodeId` / profile、认领页 `claim.html`、popup 显示当前 profile 与环境；
  本机绑定按节点（`extension/src/lib/config.ts`、`driver.ts`、`backend-identity.ts`、`native-host.ts`、新 entrypoint）。
- 共享：`shared/browser-relay/handshake.ts`（`nodeId`、`profileDir`、`profileName`）。
- 后端：`src/http/ext-relay-registry.ts`（本机多节点、节点 ↔ 绑定）、新 `src/devices/node-store.ts`（节点表：设备、profile、
  环境）、新 `src/identity/`（`whoami` 探测、身份表、核对）、`src/devices/placement.ts`（身份 / 环境目标）、
  `src/credentials/device-cookie-pullers.ts` 与 `pushed-cookie-store.ts`（按节点）、`src/manifest/types.ts`（`whoami`）、
  任务中心与运行记录、`/api/devices/*` 新路由。
- host agent：`browser.profiles`、`browser.claim` 两个 op；`launch.rs` 按 profile 唤起。
- 包：给已知能答「我是谁」的 facility 补 `whoami`（先做 bilibili、xhs、eastmoney 三个）。
- 面板：设备页的节点列表（profile、环境、在线）、「识别 profile」、身份表；facility 与任务的目标选择器加身份 / 环境。
- 文档：`docs/ARCHITECTURE.md`（执行位置一节加节点与身份）、`docs/PACKAGE.md`（`whoami`）、扩展 README。
