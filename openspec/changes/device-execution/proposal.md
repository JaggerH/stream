## Why

Stream 的执行今天**只有一个位置**：后端进程所在的那台机器。HTTP 请求从它发出，浏览器类 recipe
驱动的是它本机的 Chrome（扩展只连 `127.0.0.1:8900`），登录态按域名存一份 `data/cookies.json`。

这个假设已经不成立了：

- **主实例要常驻在一台始终在线的机器上**，而那台机器不一定在用户所在的地区。例如主实例放在
  美国加州，而 `@streamapp/eastmoney` 的登录在用户的大陆网络里做、下单也必须从那里发出——
  登录与交易不在同一个地方，券商风控拒绝或标记会话，失败只报「会话失效」，排查方向全错。
- **执行端已经分叉了。** `android-phone-surface` 让手机成了一个执行端；家里常开的 NAS、旧笔记本
  也是。给每台设备单独部署一套 Stream 不可行——账号、任务、条目会散落在多个实例里。
- 主实例搬离用户的 PC 之后，**用户自己 PC 上的 Chrome 也连不上它**：扩展的信任链（nativeMessaging
  读本机 `data/ext-relay-token`）只在同机成立。

需要的是：**一个 Stream 实例统一管理所有账号与任务，任务在用户指定的设备上执行。**

本 change 取代未落地的 `package-egress-proxy`。那份提议在网络层给后端的请求换出口 IP；但地区与会话
一致性是「请求在哪台设备上发起」的结果，换 IP 只补齐了其中一项（登录态仍离开设备、请求指纹仍是
后端的），还要另起一套 SOCKS 部署、出口探测与国家比对。

## What Changes

- **设备是执行位置。** 已配对的 host agent（PC、手机、新增的 Linux 无界面设备如 NAS）各自声明 op 集；
  调度按「这台设备有没有这个 op」决定能不能派，不按平台分支。后端本机是一个名为 `local` 的设备。
- **两层绑定，用户配置，不做探测。** facility（账号）有一个默认设备；定时任务行可以覆盖。一次执行
  解析出一台设备后，整次执行——`ctx.fetch`、`ctx.cookieFor`、中途触发的 `ctx.login`、浏览器类
  recipe——都留在那台设备上。**设备不在线就失败，绝不回落到 `local`。**
- **登录态按（设备，域名）存储。** 设备 X 上登录得到的 cookie 只给设备 X 上的执行使用。现有
  `data/cookies.json` 迁为 `local` 设备的快照，行为不变。
- **设备代发 HTTP（`http.fetch` op）。** 后端有唯一入口 `fetchFor(runContext)`：`local` 走
  `ownedFetch`，其他设备经 relay 交给 agent 发出。`PluginContext` 新增 `ctx.fetch`；plain-HTTP /
  HTML recipe 执行器与 `@streamapp/eastmoney` 都经它。cookie 由后端注入，agent 无状态。
- **允许访问的主机由包声明。** `package.json#stream.network.hosts`（缺省 = `stream.credentials`），
  安装闸门展示给用户；后端派发前校验、agent 收到后再校验。agent **始终拒绝私网目标**（在设备侧
  DNS 解析之后判）。设备侧 `ALLOW_HOSTS` 作为高级选项，配置后优先级最高。
- **扩展与 Stream 实例多对多绑定，每条绑定挂在一台设备上。** 一个扩展可以同时绑定多个实例（本机的 Stream、
  远处的主实例），一个实例可以绑定多个扩展。本机绑定沿用 native host 的信任链；远程绑定用为某台设备签发的
  一次性配对码换得专属 token，扩展直连实例。每条绑定在扩展里有自己的连接、标签组与 cookie 同步范围，互不越界；
  远程实例新要的 cookie 域名需用户批准。实例侧 ExtRelay 从一条变成按绑定区分，「设备有浏览器」即「设备上有在线的绑定」。
- **Linux 无界面 agent。** 复用 `app/host-agent` 的平台无关核心，新增 `linux` 平台构建（relay 与 `http.fetch`）。
  配对沿用一次性码，设备 id 为 `linux:<uuid>`。不发布容器镜像。
- **失败可分辨。** 触发时设备不在线 = `device-offline`（未发出任何动作，可按 `maxAttempts` 重试）；
  执行中途断连 = `device-lost`（状态未知，**不自动重试**，发通知）。运行记录带 `deviceId`。

## Capabilities

### New Capabilities
- `device-execution`：设备作为执行位置；facility 默认设备 + 任务覆盖；执行上下文；离线与断连的失败语义。
- `device-scoped-credentials`：登录态按（设备，域名）存取与刷新。
- `device-http-fetch`：`http.fetch` op、`fetchFor` 唯一入口、包声明主机、agent 侧私网拒绝。
- `device-browser-relay`：扩展与实例多对多绑定、绑定挂在设备上、按绑定的 ExtRelay 与隔离。
- `linux-device-agent`：Linux 无界面 agent。

### Modified Capabilities
- `owned-outbound-http`：owned 通道成为 `fetchFor` 在 `local` 设备上的实现；包不再直接调全局 `fetch`。

## Dependencies

- 依赖 `android-phone-surface` 已落地的部分：多设备 `host-registry`、`hello` 声明 op 集、设备配对与
  device token。本 change 在其上扩展平台 `linux` 与配对时的平台字段，不重写它们。

## Non-Goals

- **不做地区 / 出口 IP 探测**，不做国家比对。设备在哪里由用户知道，绑定是用户配置。
- **不做自动选设备**、设备分组、负载均衡、「任意一台在线设备」。绑定到哪台就去哪台。
- **不做同一站点多账号**（一个 facility 绑多台设备各跑一个账号）。现有 cookie 模型不支持，单独开题。
- **不做卫星运行时**：设备上不运行 recipe 解释器或 code 包，逻辑全在主后端。
- **不做流式响应、大文件下载、WebSocket 代发**；响应体上限 10MB。
- **RSSHub worker 的出站不经设备**（它不走 `ctx.fetch`）。
- **不发布 NAS / 执行端容器镜像**，不做远程看屏（noVNC 等）。
- 扩展不能脱离设备单独作为执行位置：没有 agent 的机器上的 Chrome 不进绑定下拉。

## Impact

- 后端：`src/http/host-registry.ts`（平台 `linux`）、`src/http/host-relay.ts`（`http.fetch` 不占 UI 租约、
  独立并发上限）、`shared/browser-relay/relay.ts`（按绑定的 ExtRelay）、新的扩展绑定表与 `/api/ext/pair`、新模块
  `src/devices/`（绑定表、执行上下文、`fetchFor`）、`src/http/owned-outbound.ts`。
- 凭据：`src/credentials/pushed-cookie-store.ts`、`cookie-puller.ts`、`cookie-provider.ts`（按设备）、
  `src/serve.ts`（`cookieFor` 读执行上下文）。
- 任务：`src/tasks/task-store.ts`（`device` 列）、`src/tasks/package-actions.ts`（执行上下文、失败分类）、
  `src/tasks/center.ts`（运行记录 `deviceId`）。
- 包：`src/packages/activate.ts`（`ctx.fetch`）、`src/replay/recipe-package.ts`（`stream.network.hosts`
  解析与安装闸门展示）、`src/adapters/replay/adapter.ts`（`makeHttpFetch` / `makeHtmlFetch` 走 `fetchFor`）、
  `packages/eastmoney/`（`client.ts` 用注入的 fetch，声明 `network.hosts`）。
- agent：`app/host-agent`（`linux` 构建、`http.fetch`、私网拒绝、`ALLOW_HOSTS`）。
- 扩展：`extension/src/lib/config.ts`（一组绑定）、`pairing.ts`（配对码配对）、`driver.ts`（按绑定的会话、组隔离）、
  `sync.ts`（按绑定推 cookie、待批准域名）、popup（绑定列表、配对、批准）。
- 面板：facility 卡片的默认设备选择、任务编辑器的设备覆盖、运行记录显示设备。
- 守卫：`packages/**` 的 code 包禁止直接调全局 `fetch`。
- 文档：`docs/ARCHITECTURE.md`（执行位置一节、出站一节）、`docs/PACKAGE.md`（`stream.network.hosts`、
  `ctx.fetch`）、扩展 README（绑定与配对）。
- 删除 `openspec/changes/package-egress-proxy/`。
