# embeddable-device-gateway

## Why

Stream 可以经 `createStream()` 嵌进宿主进程，但设备的连接面（配对、扩展绑定、节点、身份这几组 HTTP 路由，
加上 `/api/host` 与 `/api/ext` 两条 WS 中继）全部长在 `stream serve` 自己的那套 HTTP 装配里：嵌入方不调
`routes()`（那会自建端口、绑全部网卡、挂面板），设备就一个都连不上来。另外嵌入方要维护「哪台设备在线」，
实例只有 `onBindingConnected` 一个口子，没有设备 / 绑定的上下线事件；`cdp_*` 的 `chrome` 档也只认本机扩展，
远端设备上的浏览器只能绕道 facility 采集会话。

## What Changes

- **公共入口 `deviceGateway(stream, opts)`（`@streamapp/engine` 导出）。** 把 serve 里设备、扩展绑定、
  节点、身份四组 HTTP 路由与两条中继的挂载抽成一个可挂到宿主 Hono app / 宿主 http server 上的网关。
  宿主注入两件事：管理类端口的鉴权（`isAdmin`）与配对码里给设备的实例地址（`backendUrls`）。
  `routes()` 改为内部使用同一个网关——serve 的路径、鉴权、行为逐字节不变。
- **设备上下线事件 `stream.devices.onChange(listener)` 与在线快照 `stream.devices.online()`。**
  由两条中继的注册表在连接建立 / 断开时发出；同一设备新连接顶掉旧连接只发一次 online。
- **`cdp_*` 新目标写法 `device:<deviceId>/chrome[:<tabId>]`。** 四个动词都认：走那台设备上在线的
  扩展绑定（选取规则与注册表 `pick` 一致）；设备没有在线绑定报固定错误码 `device-browser-offline`；
  `kind:'login'` 在这一档同样可用，读取锁按 `device:<id>/chrome:<tabId>` 记键。
- 不新建任何存储：设备表、绑定表、节点表、身份表、两条中继注册表都用实例已有的那几份。

## Capabilities

### New Capabilities
- `embeddable-device-gateway`：可嵌入的设备网关（四组路由 + 两条中继 + 注入的鉴权与地址）。

### Modified Capabilities
- `embeddable-engine`：实例句柄的 `devices` 域新增上下线事件订阅与在线快照。
- `ext-cdp-interactive-transport`：`cdp_*` 新增 `device:<id>/chrome[:<tabId>]` 目标档。

## Impact

- `src/engine/device-gateway.ts`（新）、`src/engine/routes.ts`、`src/engine/devices.ts`、`src/engine/index.ts`
  （导出）、`src/http/ext-relay.ts`（shared/browser-relay/relay.ts）、`src/http/host-relay.ts`、
  `src/http/ext-relay-registry.ts`、`src/http/host-registry.ts`、`src/mcp/cdp-target.ts`、
  `src/mcp/cdp-router.ts`、`src/mcp/mcp-extras.ts`、`shared/browser-relay/tool-specs.ts`、
  `src/kernel/plugins/agent.ts`（mcpExtras 转发表 +1 格）。
- serve 行为不变（现有 `serve.routes.test.ts`、`device-routes`、`ext-relay*`、`host-relay*` 测试全绿为证据）。
