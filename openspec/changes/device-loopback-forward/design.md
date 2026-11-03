# device-loopback-forward — Design

## D1. 与 `http.fetch` 的关系

方向相反的两套闸门：`http.fetch` 是**出站代发**（目标任意主机、DNS 后私网拒绝）；`http.forward` 是
**入站转发**（目标只能是设备回环、只认声明端口）。不共用代码路径，但共用 host-relay 的「独立 HTTP
通道」机械（在途上限、排队、不占 UI 会话租约、`abortEpoch` 随帧下发）。

## D2. 线上形状

- `hello` 增加可选 `ports: number[]`。缺失或空 = 全部拒绝（fail closed）。设备端来源：agent 配置目录
  的 `forward-ports.json`（整数数组），连接时读一次；改了要重连。
- `http.forward` args：`{port, cred, method, path, headers:[k,v][], body?(base64), timeoutMs}`；result
  与 `http.fetch` 的 result 同形：`{status, headers:[k,v][], body(base64), url}`（`url` 回 `path`）。
- `ws.forward` args：`{port, cred, path, headers:[k,v][]}`；result `{ok:true}` 或 op error
  （`port-not-declared` / `connect-failed`）。之后双向主动帧 `{type:'fwd-data', id, b64}` 与
  `{type:'fwd-close', id}`，`id` 是 op 的 id。单帧上限 1 MiB（超出即关会话）。
- 主动帧路由：`host-relay.handleMessage` 在 `{id,...}` 配对与 `state`/`abort` 之外新增
  `fwd-data`/`fwd-close` 分支，按 `id` 交给注册在 relay 上的转发会话处理器；断连（`rejectAll`）一并
  清理会话。

## D3. 凭证

HMAC-SHA256，密钥用主实例已有的 secrets 体系（`secrets.ts` 的实例密钥；不可用时启动报错，不悄悄退化）。
载荷：`{dev, port, wid?, exp}`（`wid` = 挂载 id，可选），base64url(`payload`) + '.' + base64url(mac)。
签发 `mintForwardCredential(secret, scope, ttlMs)`，校验 `verifyForwardCredential(secret, scope, token)`
——解析载荷 → 常量时间比较 mac → 检查 `exp` → 检查 `dev`/`port`/`wid` 与请求目标一致（范围不符与过期
都 403，错误码分开：`credential-expired` / `credential-scope`）。日志/错误信息只出现凭证前 8 位。

## D4. 入口挂载器

`mountDeviceForward(app, deps)`：`deps = {registry, isAdmin?…, mint, verify, rateLimit, base?}`。路径
`*fwd/:deviceId/:port/:cred/*` 由调用方传前缀（缺省 `/api/fwd`），路径解析相对前缀。顺序：方法收集 →
限流（令牌桶 `(clientIp, device, port)`）→ 校验凭证（范围、过期）→ 设备在线且声明了端口 → 尺寸上限 →
剥头 → 转发。响应统一加 `CSP: sandbox allow-scripts allow-forms` 与 `nosniff`，剥 `Set-Cookie`。
WS upgrade：同一前缀在 Hono 之外由挂载器同时返回 upgrade 处理（同 `hostRelayHandler` 的组合式
`handle` 先例），路径与凭证校验一致后走 `ws.forward`，在入口 socket 与设备帧之间搬运。

转发请求附加头：`x-stream-fwd-cred`（仅有的身份头）与 `x-forwarded-*` 不加（回环后端要什么自己看
query）。入站剥：`cookie`、`authorization`、`proxy-*`、`sec-fetch-*` 保留（无害）……只剥前三类，其他
原样。

## D5. 缺省值（v1 代码常量）

- 凭证 TTL 60 分钟；挂载页在 `exp - 5min` 刷新。
- 令牌桶：容量 30，每秒补 3，键 `(来源, device, port)`。
- 请求体 1 MiB；响应体 8 MiB；ws 单帧 1 MiB。
- `http.forward` 在途上限与 `http.fetch` 共用 `DEVICE_FETCH_CONCURRENCY = 4`。

## D6. widget 界面与凭证

挂载页（`src/widgets/page.ts` 服务）列出 `data/widgets.json`；点开 iframe
`src = <base>/fwd/<device>/<port>/<cred>/<entry>`，`sandbox="allow-scripts allow-forms"`（不带
`allow-same-origin`）。页内脚本持有一个 `setInterval`，在最近一次签发的 `exp - 5min` 时经
`/api/widgets/:id/credential` 换新凭证并替换 iframe 地址。设备离线：列表标出；iframe 顶层返回可读
502 页面（同样带 CSP sandbox 头）。
