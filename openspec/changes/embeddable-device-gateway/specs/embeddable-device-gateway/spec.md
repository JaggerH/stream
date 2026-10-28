## ADDED Requirements

### Requirement: 设备网关是实例公共入口的一部分

系统 SHALL 提供 `deviceGateway(stream, opts)`：把设备配对与管理、扩展绑定、浏览器节点、站点身份四组
HTTP 路由，以及扩展中继与宿主中继两条 WS 端点，装成一个可挂到宿主应用上的网关。宿主 SHALL 通过
`app.route(opts.basePath, gateway.app)` 挂 HTTP 路由（`basePath` 缺省 `/api`），并在宿主 http server 的
`upgrade` 事件里调 `gateway.handleUpgrade(req, socket, head)`：路径属于 `${basePath}/ext` 或
`${basePath}/host` 时 SHALL 接管并返回 true，否则 SHALL 返回 false 且不触碰 socket。`gateway.close()`
SHALL 关闭两条中继的 WebSocket 服务与认领登记。

#### Scenario: 宿主挂上网关后设备可以配对并连上
- **WHEN** 宿主把网关挂在自定义前缀（如 `/api/stream`）上，调用管理口签发配对码，设备用码换取 token 后向
  `${basePath}/host` 发起 WS 握手
- **THEN** 握手成功，实例的宿主中继注册表里出现这台设备，且所有请求都落在宿主自己的 server 上

#### Scenario: 不属于自己的路径让出来
- **WHEN** 宿主的 server 上有发往其他路径的 upgrade 请求
- **THEN** `handleUpgrade` 返回 false，socket 原样留给宿主的其他处理者

### Requirement: 管理类端口的鉴权由宿主注入

网关 SHALL 把「谁可以调管理类 HTTP 端口」（签发配对码、列设备、撤销、改 facility 绑定、对设备下 op）
交给宿主注入的 `isAdmin(c)` 判定，返回 false SHALL 回 403。设备自己调用的端口 SHALL 不经这个判定：
`/devices/pair` 与 `/ext/pair` 只认一次性配对码，两条 WS 只认设备 / 绑定 token——与 serve 模式逐字节一致。

#### Scenario: 鉴权不过的管理调用
- **WHEN** `isAdmin` 对一个请求返回 false，该请求打在签发配对码端口上
- **THEN** 返回 403，且不产生配对码

#### Scenario: 设备用配对码连入不经管理鉴权
- **WHEN** 设备持有有效一次性码调用 pair，或持有有效 token 发起 WS 握手，而该请求方不满足 `isAdmin`
- **THEN** 照常放行

### Requirement: 配对回执里的地址由宿主给出

配对码回执与扩展配对回执里给设备的实例地址 SHALL 来自宿主注入的 `backendUrls()`。serve 模式 SHALL
继续传局域网地址，行为不变。

#### Scenario: 嵌入方给出自己的公网地址
- **WHEN** 宿主 `backendUrls` 返回它自己的地址列表，调用签发配对码
- **THEN** 回执的 `backends` 字段逐项等于该列表

### Requirement: serve 模式行为不变

`stream serve` SHALL 内部改用同一个网关装配设备面，路径、鉴权判据（本机回环）、配对回执地址（局域网）、
端口与中继行为 SHALL 全部与引入前一致。

#### Scenario: 既有集成测试
- **WHEN** 在改动后的代码上运行 serve 的路由、设备路由、扩展中继、宿主中继既有测试
- **THEN** 全部通过且无需修改断言

### Requirement: 网关不新建存储

网关 SHALL 使用实例已有的设备表、扩展绑定表、节点表、身份表与两条中继注册表，SHALL 不新建任何存储或
第二份注册表。
