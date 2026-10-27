# private-fetch-guard

## Why

Stream 的后端会把**调用方随手给的一个网址**抓回来读：对话里的 `read_url` / `stream_fetch_url` /
`video_resolve` 三个工具，以及与 `stream_fetch_url` 共用同一份实现的 HTTP 门
`GET /api/media/from-url` 与 `GET /api/enrich?source=link`。个人自部署时后端和用户的服务同机或同网，这是正常用法；但当后端作为
服务端部署（面向多个调用方、或跑在云主机上）时，这条「给什么抓什么」的路同时也是一条能打到
本机回环、云元数据地址（169.254.169.254）和内网服务的路。默认行为保持不变；服务端部署的实例
可以打开一个开关，让这条路拒绝内网地址。

这条路**今天已有一道主机名级别的闸**（`src/adapters/safe-fetch.ts` 的 `isPrivateHost`，字面量
判定，文章抽取等路径恒开），但它有三个洞，正是本 change 要补的：

1. **不看解析结果**。`internal.corp` 这类主机名不在黑名单字面量里，解析到哪就连到哪；
2. **不防 DNS rebinding**。校验发生在「连接之前」且校验的是主机名，fetch 自己会再解析一次，
   两次结果可以不同；
3. **范围不全**。CGNAT（100.64/10）、ULA（fc00::/7）、IPv4 映射的 IPv6、0.0.0.0/8 都不在名单里。

## What Changes

- **新增一个可选开关，默认关闭。** `config.yaml` 的 `caller_fetch_guard.reject_private`（缺省
  false）。关闭时所有相关路径与现在逐字节一致——现有主机名级闸照旧，不新增任何校验。
- **作用范围只限「由调用方传入任意网址」的抓取路径**：MCP 工具 `read_url`、`stream_fetch_url`、
  `video_resolve`，以及 HTTP 门 `GET /api/media/from-url`（`stream_fetch_url` 的同源入口）与 `GET /api/enrich?source=link`（正文阅读器，与 `read_url` 共用正文抽取与缓存）。
  **不挂在全局 fetch / HTTP 客户端上**：用户配置的订阅源、RSSHub 桥（自带的请求栈，独立 worker）、
  插件与适配器访问的服务地址（容器 API、AList 等）都是可信配置，照常访问内网——它们不在
  开关的作用范围内，开关打开也不受影响。
- **打开后按「实际要连接的 IP」逐跳判定。** 每一跳（含每次重定向）在连接时校验：自定义连接层
  （undici Agent 的 connect / lookup）让**校验的地址就是实际连接的地址**——先解析校验、再让
  fetch 重新解析的写法一律不用，DNS rebinding 从机制上不可达。拒绝的地址类：回环（127/8、::1）、
  私有段（10/8、172.16/12、192.168/16）、链路本地（169.254/16、fe80::/10）、CGNAT（100.64/10）、
  ULA（fc00::/7）、未指定（0.0.0.0/8、::）、IPv4 映射的 IPv6（::ffff:0:0/96，按内嵌 IPv4 判）、
  IPv6 组播（ff00::/8）。协议只允许 http/https。
- **例外名单。** `caller_fetch_guard.allow` 接受主机名（精确匹配，大小写不敏感）与 CIDR 网段
  （IPv4 / IPv6）。名单内的主机名跳过 IP 判定；名单内的网段对解析出的地址放行。名单只作用于
  本开关的路径，不影响现有主机名级闸对其他路径的语义。
- **被拒时的报错可分辨。** 拒绝以明确的错误返回（工具回 `{error}` 或 MCP isError 消息、HTTP 门
  回 502 + 原因），错误信息带上主机、IP 与拒绝原因（地址类），不会变成「没抓到正文」或裸异常。

## Capabilities

### New Capabilities
- `caller-fetch-guard`：调用方传入任意网址的抓取路径的可选私网拒绝开关、连接时逐跳校验、
  例外名单与拒绝报错语义。

## Non-Goals

- **不改默认行为。** 开关关闭（缺省）时个人自部署访问内网服务完全不受影响，包括
  `read_url` 现有的主机名级闸也保持原样。
- **不碰可信配置的出站路径**：订阅源采集（recipe 的 HTTP 门保持现状——它今天就有自己的
  公网闸，语义不变）、RSSHub 桥、插件/适配器服务地址、网盘客户端、转写/LLM 等 BYOK 端点。
- **不做全局 fetch / HTTP 客户端的补丁**：内嵌 RSSHub 的请求改写器与本进程出站通道互不感知
  （见 owned-outbound-http），本 change 也不引入新的进程级替换。
- **不覆盖非「调用方 URL」的抓取**：web_search 命中结果的正文折叠、favicon 代取、媒体下载、
  阅读器对已采集条目的转文字等，都不在开关作用范围内（维持各自现状）。
- 远程设备（device-execution 的非 `local` 执行位置）侧的判定不在此展开：那台设备自己的
  网络位置与策略是设备侧的事，`local` 设备（本进程）的判定由本 change 覆盖。

## Impact

- 新模块 `src/net/caller-fetch-guard.ts`：策略解析（配置 → 名单/网段）、地址判定、连接时校验
  的 undici Agent、作用域（AsyncLocalStorage）。
- `src/adapters/safe-fetch.ts`：守卫激活时走受校验的连接（`redirect: 'follow'` 的每一跳连接都
  过校验层）；未激活时走原路径，一字不改。
- `src/devices/fetch.ts`：`fetchFor` 的 `local` 分支在守卫激活时同样过校验层（覆盖
  `stream_fetch_url` / `video_resolve` 经包 `ctx.fetch` 发出的跳转）。
- `src/mcp/tool-catalog.ts`：三个工具的 run 包进守卫作用域并接住拒绝错误。
- `src/http/app.ts`：`/api/media/from-url` 与 `/api/enrich?source=link` 的处理包进守卫作用域。
- `src/engine/index.ts`：装配期读配置设进程级策略位；**只开不关**（同进程后建的实例没写这一项，不会关掉先建实例打开的守卫）。
- `src/types.ts`（`AppConfig.caller_fetch_guard`）、`config.example.yaml`（注释样例）、
  `src/engine/index.ts`（装配期把配置解析成策略）。
- 测试：`src/net/caller-fetch-guard.test.ts`（地址类逐条、rebinding、重定向、例外名单、
  作用域不扩大、开关关闭行为一致），解析器可注入，全部不碰外网。
