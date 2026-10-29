# cdp-binding — tasks

## 计划 1：准入与状态

- [x] 1. `src/cdp-binding/loopback.ts`：`loopbackCdpUrl`（复用 `isLoopbackAddress`）、`serverUrlOf`；非回环 / 非 http(s) 抛 `CdpAddressRefused`
- [x] 2. `src/cdp-binding/state.ts`：`CdpBindingState {token, nodeId, bindingId}`、`newNodeId()`、读（坏文件 → null）、写（0600、临时文件 + rename）

## 计划 2：配对与对端自证

- [x] 1. `src/cdp-binding/pairing.ts`：`pairWithCode`（扩展 Origin、一次性码）、`verifyServer`（挑战应答、`timingSafeEqual`）、`bindingProof`
- [x] 2. 顺序写进注释并落实：换 token → 验对端 → 才把 token 交进 WS 握手

## 计划 3：CDP 与命令映射

- [x] 1. `src/cdp-binding/cdp-connection.ts`：`/json/version` 发现 → 浏览器级 WS；单命令超时、事件分发、断线回调
- [x] 2. `src/cdp-binding/ops.ts`：认领集合、tabId 映射、`list` / `newTab` / `openTab` / `closeTab` / `activateTab` / `activeTab` / `frames` / `cookieNames` / `cookiePull` / `subscribe` / `unsubscribe` / `holdProfile` / `releaseProfile`、CDP 透传（`expectDomain`、fire-and-forget、截图预算）、OOPIF 子会话与 `tab-opened` 事件
- [x] 3. 日志只记命令名与耗时

## 计划 4：生命周期

- [x] 1. `src/cdp-binding/binding.ts`：`startCdpBinding`；中继断线退避重连（每次重新 verify）、CDP 断开 → 断中继 + 固定间隔重试、`4003` / `4004` 终态、心跳判死
- [x] 2. `close()` 幂等；`done` 在循环退出时兑现

## 计划 5：入口

- [x] 1. `src/cdp-binding/index.ts` 导出 `startCdpBinding` 与类型；`src/engine/index.ts` 导出；`exports.guard.test.ts` 快照更新
- [x] 2. `src/install/cli.ts`：`cdp-bind` 子命令解析（`--server` / `--state` / `--cdp`，支持 `--flag=value`）与帮助；`cli-entry.ts` 分派；`src/install/cdp-bind-command.ts` 从 stdin 读配对码、处理 SIGTERM/SIGINT

## 计划 6：测试

- [x] 1. `loopback.test.ts` / `state.test.ts` / `pairing.test.ts`（假服务端按真实规则验 Origin 与 proof）
- [x] 2. `ops.test.ts`：对着真 Chromium 覆盖每条命令与每类透传；日志金丝雀
- [x] 3. `binding.test.ts`：假 CDP + 假中继，覆盖首次配对、重启不再要码、4003/4004 终态、中继重连、心跳判死、浏览器消失与回来、`close()`、日志不含 token / 配对码
- [x] 4. `e2e.test.ts`：真 Stream + 设备网关 + 真 Chromium：配对 → 绑定上线 → `cdp_look` 读到真页面 → 杀掉浏览器 → 离线；`cdp_act({kind:'login'})` 走通且密码 / 用户名不进任何日志
- [x] 5. `cli.test.ts` 补 `cdp-bind` 的解析用例（含"没有 `--code`"）

## 计划 7：收尾

- [x] 1. `docs/ARCHITECTURE.md` 写清这一档的边界、判据与已知差异
- [x] 2. `tsc --noEmit -p .` + 全量 vitest；rebase 到 origin/main；推送
