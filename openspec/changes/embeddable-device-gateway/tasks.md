# embeddable-device-gateway — tasks

## 计划 1：中继握手抽 handle

- [x] 1. `shared/browser-relay/relay.ts`：`attachExtRelay` 的 upgrade 逻辑抽成 `extRelayHandler(relay, opts) → { path, wss, handle }`；`handle` 对非本路径返回 false 且不碰 socket；`attachExtRelay` 保持原签名
- [x] 2. `src/http/host-relay.ts`：同上抽 `hostRelayHandler`（426 / 401 / 503 的拒绝路径原样保留）
- [x] 3. 既有 `ext-relay*` / `host-relay*` 测试全绿（行为不变）

## 计划 2：网关

- [x] 1. `src/engine/device-gateway.ts`：四组路由 + `ProfileClaims` 接线 + 两条中继 handler；`isLocal` → `opts.isAdmin`；`basePath` 处理；`close()` 关两条 wss 与 claims
- [x] 2. 四个 mount 函数路由串改相对路径，四个测试文件改挂 `/api` 子 app
- [x] 3. `routes()` 改用网关挂载；`attachRelayServers` 改用 `gateway.handleUpgrade` + 一条 close effect；serve.ts 共享同一个 io
- [x] 4. 网关测试：测试自建 server + Hono（basePath `/api/stream`）走签码 → pair → WS → onChange 全链路；替换连接只发一次 online；心跳判死 offline；`handleUpgrade` 让出别人的路径；`isAdmin=false` 管理口 403；设备 token / 配对码不进日志

## 计划 3：上下线事件

- [x] 1. `HostRelayRegistry` / `ExtRelayRegistry` 各加 `onChange`（顶掉旧连接只发一次 online；被顶掉的旧 socket 断开不误发 offline）+ 单测
- [x] 2. `stream.devices.onChange` / `stream.devices.online()`：`devices.ts` 汇点 + `createStream` 接线 + 单测（监听器抛错不影响连接）

## 计划 4：device:<id>/chrome 档

- [x] 1. `devices/errors.ts` 加 `DeviceBrowserOffline`（code `device-browser-offline`）
- [x] 2. `cdp-target.ts`：`device` scheme + `parseDeviceChrome`；`cdp-router.ts`：`deviceChrome` 依赖位、四动词分流、锁键 `device:<id>/chrome[:<tabId>]`、`kind:'login'` 可用
- [x] 3. `mcp-extras.ts`：按设备取绑定建 lane（pick 规则、错误折叠、按 bindingId 缓存）；agent.ts 转发表 + `MCP_EXTRAS_DEP_COUNT`
- [x] 4. `tool-specs.ts`：`device` tier 的 target 形状与四条说明；chrome-only 宿主不出现这一档
- [x] 5. 测试：两台假设备各一条绑定只碰自己的 relay；设备不在线报固定错误码；锁键新形状；login 在 device 档可用

## 计划 5：导出与收尾

- [x] 1. `src/engine/index.ts` 导出 `deviceGateway` 与类型；exports.guard 快照更新
- [x] 2. 全量 `flock /tmp/stream-heavy.lock node_modules/.bin/vitest run src shared` + `tsc --noEmit -p .`（环境性失败名单不变）；rebase、push、提交说明即交付记录
