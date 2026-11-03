# device-loopback-forward

## 计划 1：后端

- [x] 1. `hello.ports` 解析（host-registry：可选、全为 1–65535 整数、去重；registry 查询 `ports(id)`）
- [x] 2. `http.forward` op：host-relay 复用独立 HTTP 通道（与 `http.fetch` 同一在途上限与排队）
- [x] 3. `ws.forward` op：建连 op 回应 + `fwd-data`/`fwd-close` 主动帧路由（handleMessage 分发、断连清理）
- [x] 4. 凭证：HMAC 签发/校验（绑 device+port+挂载 id、60 分钟、常量时间比较、日志打码）
- [x] 5. 入口挂载器 `mountDeviceForward`：任意前缀、头剥离（Cookie/Authorization/Proxy-\*/Set-Cookie）、
      CSP sandbox + nosniff、令牌桶限流、1 MiB/8 MiB 上限、HTTP 走 `http.forward`、WS upgrade 走
      `ws.forward`
- [x] 6. `deviceGateway` 挂转发入口；`src/engine/index.ts` 导出挂载器与凭证签发/校验

## 计划 2：agent（Rust）

- [x] 1. hello 带可选 `ports`（设备端配置文件读入）
- [x] 2. `http.forward`：端口校验、只连 127.0.0.1、超时、响应回传
- [x] 3. `ws.forward`：建连、双向 `fwd-data`/`fwd-close` 帧、1 MiB 单帧上限
- [x] 4. 单元测试（fake 回环服务）；本机 cargo 不可用则如实写进报告

## 计划 3：测试与文档

- [x] 1. 只转声明端口（未声明端口与未声明 ports 的设备都拒）
- [x] 2. 凭证：过期 403、范围不符 403（device、port 各一）
- [x] 3. 身份剥离：入站 Cookie/Authorization 不转发、出站 Set-Cookie 剥掉
- [x] 4. 直开沙箱：转发响应带 CSP sandbox 与 nosniff
- [x] 5. 大小上限 413、限流 429
- [x] 6. WebSocket 往返（假 socket 的后端测试）
- [x] 7. `docs/ARCHITECTURE.md` 设备一节加回环转发；推送前全量测试 + typecheck
