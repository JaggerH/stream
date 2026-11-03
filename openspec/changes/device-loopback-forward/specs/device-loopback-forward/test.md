# device-loopback-forward 测试计划

## HTTP 转发

- **只转声明端口**：device A 声明 `ports=[8765]`，请求它的 9999 → 403 port-not-declared；未声明 ports 的 device → 403 port-not-declared。
- **凭证过期**：TTL 60 分钟，发一条 65 分钟前的凭证 → 403 credential-expired。
- **范围不符**：为 (A,8765) 签的凭证用于 (A,8888) → 403 credential-scope。
- **身份剥离**：请求头带 `Cookie: abc=123; Authorization: Bearer token` → 设备端收到的帧里不带这两项；响应里 `Set-Cookie: x=1` 被剥掉。
- **大小上限 413**：请求体 2 MiB → 413；响应体超 8 MiB → 413。
- **直开沙箱**：直接 GET 转发地址，响应带 `Content-Security-Policy: sandbox allow-scripts allow-forms` 与 `X-Content-Type-Options: nosniff`。

## WebSocket 转发

- **往返**：建连 → fwd-data(b64) → fwd-close；单帧 1 MiB 上限。
- **断连清理**：设备断开 → 所有 onForwardSession 立即 onClose。

## 限流

- **桶耗尽 429**：同一来源短时间内打满令牌桶 → 429。

## Rust 侧（本机不可编译则跳过）

- hello.ports 解析与查询：缺失→undefined，空数组→[]，非法→null 拒连接。
- http.forward / ws.forward 的端口校验：不在声明清单→error。
- 只连 127.0.0.1：拒绝私网、拒绝 localhost（除非 cfg(test)）。
- 单元测试 + fake 回环服务：http.forward 完整往返，ws.forward 数据往返。

## 接线（gateway 层）

- 网关挂在任意 basePath 时转发入口随 `${basePath}/fwd` 挂上：HTTP 坏凭证 → 403（不是 404）；
  同路径的 WS upgrade 被拒，不开成真连接。
