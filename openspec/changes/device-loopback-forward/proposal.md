# device-loopback-forward

## Why

已配对的设备（PC、NAS、Linux 无界面设备）与主实例之间只有一条出站 WebSocket（`/api/host`）。设备上
跑着的本机服务（比如用户自己写的一个小页面及其后端）只听设备自己的回环地址，主实例与浏览器都够不着：
要么在设备上开入站端口（用户不愿意、也常常做不到——NAT 后面），要么放弃。

需要的是反方向的一条通道：**主实例把对某个入口的 HTTP / WebSocket 请求，经设备已经连上来的节点连接
转发到那台设备回环地址上的指定端口，再把响应送回。** 设备不开任何入站端口。它对自部署用户直接有用
（把自己机器上的本机页面接进 Stream 界面，见 widget-manifest），也是嵌入方后续按子域挂载的基础设施。

## What Changes

- **设备声明可转发端口。** `hello` 增加可选字段 `ports: number[]`（设备端自己的配置文件给出，缺省
  缺失 = 该设备一台都不允许）。后端只把请求转给 hello 里声明过的端口；agent 收到后再次校验，并只连
  `127.0.0.1`。
- **两个新 op：`http.forward`（一次请求一响应）与 `ws.forward`（WebSocket 双向往返）。** 都不占 UI
  会话租约，走 `http.fetch` 同款的独立并发通道（独立在途上限）。`ws.forward` 建立后双向数据用无 id 的
  `{type:'fwd-data'|'fwd-close', id}` 主动帧（与 `state`/`abort` 同一先例）。
- **入口路由 + 短期凭证。** 挂载器提供一个可组合的转发入口（HTTP 与 WS upgrade），可挂任意前缀，也
  可由嵌入方在专用主机名下整站提供。入口请求必须带主实例为该挂载签发的短期凭证（HMAC + 过期，缺省
  60 分钟），凭证绑定 `(device, port)`，常量时间比较；**不带、也不替换用户 token**。过期 403
  `credential-expired`；拿 A 端口的凭证访问 B 端口 403。
- **剥离主实例身份。** 入站请求里的 `Cookie`、`Authorization`、`Proxy-*` 与主实例自身会话头不转给
  设备后端；转发请求带上的唯一身份是这次挂载的凭证头。出站响应剥掉 `Set-Cookie`。
- **直开也沙箱。** 每个转发响应加 `Content-Security-Policy: sandbox allow-scripts allow-forms` 与
  `X-Content-Type-Options: nosniff`——iframe 的 sandbox 属性只对被嵌入生效，直接在新标签打开转发地址
  时由 CSP sandbox 把页面压进不透明源。
- **限流与大小上限（缺省值，v1 为代码常量）。** 令牌桶按 `(来源, device, port)` 记键：容量 30、每秒
  补 3，超出 429。请求体上限 1 MiB、响应体上限 8 MiB，超出 413。ws 单帧 1 MiB。
- **导出。** 挂载器（`mountDeviceForward`）与凭证签发/校验从公共入口导出，嵌入方不碰内部文件。

## Capabilities

### New Capabilities
- `device-loopback-forward`：经设备连接把 HTTP / WebSocket 请求转发到设备回环端口；端口声明、凭证、
  身份剥离、限流与大小上限。

## Dependencies

- 依赖 `device-execution` 已落地的骨架：`/api/host` 中继、`hello` op 集声明、设备配对与 device token、
  `host-relay` 的独立 HTTP 通道。本 change 在其上加两个 op 与 `ports` 字段，不重写它们。
- 依赖 `embeddable-device-gateway` 的组合式挂载先例（`RelayHandler.handle` / `alsoPaths`）。

## Non-Goals

- **不做流式响应**：`http.forward` 一次请求一响应，响应整体缓冲（上限 8 MiB）；流式走 `ws.forward`。
- **不做多设备广播 / 端口发现**：转到哪台设备的哪个端口由挂载配置指名。
- **不改 `http.fetch` 的语义**：那是出站代发（目标任意主机、拒绝私网）；本 change 是入站转发（目标
  只能是设备回环、只认声明端口）。两套闸门方向相反，不共用代码路径。
- 嵌入方按子域隔离各构件（每个构件独立子域）属于嵌入方接线，本 change 只要求入口不写死源。

## Impact

- `src/http/host-relay.ts`（`http.forward` 通道、`ws.forward` 建连与主动帧路由）、
  `src/http/host-registry.ts`（`ports` 解析与查询）、`src/http/device-forward.ts`（新：凭证、入口挂载
  器、头剥离、限流）、`src/engine/index.ts`（导出）、`src/engine/device-gateway.ts`（挂转发入口）。
- agent：`app/host-agent/src/forward.rs`（新）、`protocol.rs`（op 分发）、`relay.rs`（hello 带
  `ports`、主动帧发出）。
- 文档：`docs/ARCHITECTURE.md` 设备一节加「回环转发」。
