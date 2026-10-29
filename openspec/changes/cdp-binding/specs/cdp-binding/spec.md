## ADDED Requirements

### Requirement: 用 CDP 驱动的浏览器是一条普通的扩展绑定

系统 SHALL 提供一个客户端（`startCdpBinding(opts)`），连上本机 Chromium 的 CDP 端口后，按扩展中继的
协议与服务端交互：`POST /api/ext/pair` 用一次性码换 token、`POST /api/ext/verify` 让服务端用这把 token
签挑战应答、再以 WS `/api/ext`（子协议 `[browser-relay.v1, token]`，query 带 `nodeId`）接入。
服务端 SHALL NOT 为它新增端点、修改中继协议或事件类型；实例看到的 SHALL 是一条普通的 `binding`
上线 / 离线事件。

#### Scenario: 配对到上线
- **WHEN** 服务端为某台设备签发了一条 ext 配对码，客户端用这条码配对并连上 `/api/ext`
- **THEN** 实例的 `devices.onChange` 收到 `{kind:'binding', deviceId, bindingId, online:true}`，并且
  `devices.online().bindings` 里包含这条绑定

#### Scenario: 浏览器退出
- **WHEN** 浏览器进程被杀，CDP 连接断开
- **THEN** 客户端 SHALL 主动断开中继，实例 SHALL 收到 `online:false`；浏览器回来后客户端 SHALL 自动
  重新 verify 并连上（不再要求配对码）

### Requirement: 中继命令全量可用

客户端 SHALL 支持扩展 driver 的全部命令：`list`、`newTab`、`openTab`、`closeTab`、`activateTab`、
`activeTab`、`frames`、`cookieNames`、`cookiePull`、`subscribe` / `unsubscribe`、`holdProfile` /
`releaseProfile`，以及任意 CDP 方法透传（含 `expectDomain` 校验、`sessionId` 子会话、截图预算、
fire-and-forget）。回执形状（`{id, result | error, swMs}`）与服务端发起的 `cdp-event` / `tab-opened`
帧 SHALL 与扩展一致。

#### Scenario: 组外标签一律拒
- **WHEN** 一条命令指向不在认领集合里的标签（用户自己开的标签）
- **THEN** `closeTab` / `subscribe` / 透传 SHALL 以错误回执拒绝，且不向浏览器发出任何改动

#### Scenario: 认领标签自己开出来的标签
- **WHEN** 认领的标签经用户手势打开一个新标签（`openerId` 指向它）
- **THEN** 新标签 SHALL 进入认领集合，并发出 `{type:'tab-opened', tabId, openerTabId, url}`

#### Scenario: 域名变了就不动手
- **WHEN** 透传命令带 `expectDomain`，而标签当前 URL 的主机名与之不符
- **THEN** SHALL 以错误回执拒绝，命令不发给浏览器

#### Scenario: 跨站 iframe
- **WHEN** 调用方要求列出 `frames`
- **THEN** SHALL 返回该标签的 OOPIF 子会话（带 url），并允许用 `sessionId` 把命令打进子会话；
  不认识的 `sessionId` SHALL 被拒

### Requirement: CDP 地址只许回环

客户端 SHALL 只接受回环的 CDP 地址（`127.0.0.0/8`、`::1`、`localhost`、`*.localhost`，判据复用 API
访问门那一个 `isLoopbackAddress`）；其余地址 SHALL 在启动时拒绝，进程不起。

#### Scenario: 局域网地址
- **WHEN** 传入的 CDP 地址是 `http://192.168.1.9:9222`
- **THEN** `startCdpBinding` SHALL 抛错，且不发起任何连接

### Requirement: 配对码只从 stdin 读

`stream cdp-bind` SHALL 只在需要配对时从 stdin 读一行配对码；SHALL NOT 接受命令行参数或环境变量里的
配对码。配对码 SHALL NOT 出现在日志、状态文件或任何回执里。

#### Scenario: 命令行给码
- **WHEN** 用户在命令行上写 `--code 123456`
- **THEN** 该参数 SHALL 被当作不认识的参数报错退出

#### Scenario: 重启
- **WHEN** 状态文件已存在
- **THEN** 进程 SHALL 不读 stdin、直接 verify 重连

### Requirement: 状态文件与撤销

状态文件（`--state`）SHALL 只存 token、nodeId 与绑定 id，权限 0600，写入 SHALL 先写临时文件再 rename。
服务端以 `4003`（撤销）或 `4004`（token 属于另一个节点）关闭连接时，客户端 SHALL 停止重连并结束进程。

#### Scenario: 被撤销
- **WHEN** 服务端撤销这条绑定并以 `4003` 关闭连接
- **THEN** 客户端 SHALL 不再发起连接，`done` 兑现，进程以正常码退出

### Requirement: 日志不记参数与返回值

日志 SHALL 只包含命令名、耗时与生命周期事件；SHALL NOT 包含任何命令参数或返回值——尤其是
`Input.insertText` 的文本与 cookie 的值。

#### Scenario: 登录动作
- **WHEN** 用一份值为可搜字符串的秘密跑一次 `cdp_act({kind:'login'})`
- **THEN** 实例日志、网关日志、绑定日志与调试总线里 SHALL 搜不到该字符串

### Requirement: 公共入口与 CLI

`@streamapp/engine` SHALL 导出 `startCdpBinding` 与 `CdpBinding` / `CdpBindingOptions` 类型（导出清单
快照随之更新）。`stream cdp-bind --server <url> --state <file> [--cdp <url>]` SHALL 是一个不 chdir、
不 import 后端的长驻进程，收到 SIGTERM / SIGINT 时关闭连接后退出。

#### Scenario: 嵌入方在测试里起一份
- **WHEN** 调用方 `await startCdpBinding(opts)` 并在结束时 `close()`
- **THEN** 中继与 CDP 连接都断开，重连循环结束，`close()` 可重复调用
