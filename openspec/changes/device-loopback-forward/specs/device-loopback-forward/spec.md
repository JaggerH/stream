## ADDED Requirements

### Requirement: 只转发到设备声明过的回环端口

设备 SHALL 在 `hello` 里以可选字段 `ports: number[]` 声明允许被转发的本机回环端口；未声明该字段或声明
为空的设备 SHALL 一台端口都不允许。后端 SHALL 只把请求转给该设备 hello 里声明过的端口，其他端口以
`port-not-declared` 拒绝且不发帧。agent 收到转发请求 SHALL 再次校验端口在声明清单里，并 SHALL 只连接
`127.0.0.1` 上的该端口。

#### Scenario: 未声明端口被拒
- **WHEN** 一台设备的 hello 声明 `ports:[8765]`，入口请求目标是它的 9999 端口
- **THEN** 后端以 `port-not-declared` 拒绝，设备没有收到任何帧

#### Scenario: 未声明 ports 的设备不可转发
- **WHEN** 一台在线设备的 hello 没有 `ports` 字段
- **THEN** 任何端口的目标都以 `port-not-declared` 拒绝

### Requirement: http.forward 的线上语义

`http.forward` SHALL 携带端口、短期凭证、方法、路径与查询串、多值有序的请求头、可选 base64 请求体与
超时；SHALL 回传状态码、多值有序的响应头与 base64 响应体。agent SHALL 在超时内未回应时以 op 超时失败。
该通道 SHALL NOT 获取或等待该设备的 UI 会话租约，SHALL 与 `http.fetch` 共用同一套独立并发上限与排队
语义。

#### Scenario: 到回环后端的往返
- **WHEN** 入口收到 `GET /api/fwd/<device>/<port>/status`，设备声明了该端口且回环上有服务答 200 `ok`
- **THEN** 调用方收到 200 与 `ok`

### Requirement: ws.forward 的双向往返

`ws.forward` SHALL 以 op 请求建立到设备回环端口的连接，agent 建连成功 SHALL 以 op 回应确认，失败 SHALL
以 op 错误回应。此后 SHALL 支持双向数据帧：`{type:'fwd-data', id, b64}`（两个方向同一形状）与
`{type:'fwd-close', id}`。任一侧关闭 SHALL 让另一侧收到关闭帧；设备断连 SHALL 让所有在途转发会话失败。

#### Scenario: WebSocket 往返
- **WHEN** 客户端经入口打开一条 WebSocket，向设备回环上的回声服务发一条消息
- **THEN** 消息经 `fwd-data` 帧双向送达，回声原样返回；任一侧关闭时对端收到 `fwd-close`

### Requirement: 短期凭证绑定范围且可过期

转发入口 SHALL 要求请求带主实例为该挂载签发的短期凭证（HMAC + 过期时间戳，缺省 60 分钟）；SHALL 绑定
`(device, port)`（可另绑挂载 id）；SHALL 用常量时间比较；过期 SHALL 以 403 `credential-expired` 拒绝；
范围不符 SHALL 以 403 拒绝。凭证 SHALL NOT 承载或替换用户的任何 token。凭证字符串出现在日志里 SHALL
被打码。

#### Scenario: 凭证过期
- **WHEN** 一条 60 分钟前签发的凭证被用来请求转发地址
- **THEN** 收到 403 `credential-expired`，设备没有收到任何帧

#### Scenario: 凭证范围不符
- **WHEN** 为 (device A, port 8765) 签发的凭证被用于 (device A, port 8888)
- **THEN** 收到 403，端口 8888 没有收到任何帧

### Requirement: 剥离主实例身份

转发入口 SHALL 从入站请求剥掉 `Cookie`、`Authorization`、`Proxy-*` 头再转发；转发请求 SHALL 以转发凭证
头（`x-stream-fwd-cred`）作为唯一身份。出站响应 SHALL 剥掉全部 `Set-Cookie` 头。

#### Scenario: 浏览器 cookie 不出主实例
- **WHEN** 同站导航让浏览器在入口请求上带上了主实例的会话 cookie
- **THEN** 设备回环后端收到的请求头里没有 `Cookie`，只有 `x-stream-fwd-cred`

#### Scenario: 构件不能种主实例的 cookie
- **WHEN** 回环后端对一个转发请求答 `Set-Cookie: a=1`
- **THEN** 调用方收到的响应头里没有 `Set-Cookie`

### Requirement: 直开也沙箱

每个转发响应 SHALL 携带 `Content-Security-Policy: sandbox allow-scripts allow-forms` 与
`X-Content-Type-Options: nosniff`，使得不经过 iframe、直接在浏览器打开转发地址时页面运行在不透明源里，
调不到主实例的同源 API。

#### Scenario: 直接在标签页打开转发地址
- **WHEN** 一个浏览器标签直接 GET 转发地址
- **THEN** 响应带上述两个头；页面内脚本处于 sandbox CSP 之下

### Requirement: 限流与大小上限

转发入口 SHALL 按来源与 `(device, port)` 记键限流（缺省令牌桶：容量 30、每秒补 3），超出以 429 拒绝。
请求体超过缺省 1 MiB、响应体超过缺省 8 MiB SHALL 以 413 拒绝且请求不发往设备。ws 单帧超过缺省 1 MiB
SHALL 断开会话。

#### Scenario: 超限请求被拒
- **WHEN** 一个 2 MiB 的请求体发往转发地址
- **THEN** 收到 413，设备没有收到任何帧

#### Scenario: 限流生效
- **WHEN** 同一来源短时间打满令牌桶后继续请求
- **THEN** 收到 429

### Requirement: 入口可组合、不写死源

转发入口 SHALL 以可挂载到任意 HTTP 路径前缀（或专用主机名下整站）的形式提供，路径解析 SHALL 相对挂载
前缀；iframe 地址与重定向 SHALL 用相对路径或由挂载方传入的 base，SHALL NOT 写死 host。挂载器与凭证
签发/校验 SHALL 从公共入口导出，嵌入方 SHALL NOT 需要触碰内部文件。

#### Scenario: 挂在自定义前缀下
- **WHEN** 嵌入方把转发入口挂到宿主应用的 `/x/fwd/` 前缀下
- **THEN** `/x/fwd/<device>/<port>/<cred>/…` 正常工作，凭证校验与转发行为与内置前缀下逐字节一致
