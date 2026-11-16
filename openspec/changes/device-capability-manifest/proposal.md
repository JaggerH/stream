# device-capability-manifest

## Why

后端今天只能从 `hello.ops`（op 名清单）推断一台设备能做什么。op 名是执行层的细节：同一项能力在不同设备上
由不同的 op 撑起，有的设备类（例如没有界面自动化的平台）将来只有通知、intent 一级的能力，根本没有界面 op。
调用方想按「这台设备能不能读界面 / 能不能截图 / 能不能发通知」来调整做法，就只能把 op 名硬编码成能力，
或者逐个 op 试探。

## What Changes

- **`hello` 增加可选的能力清单。** `capsVersion`（清单的 schema 版本，当前 1）与 `caps`：能力 id →
  `{ v, availability? }`。`v` 是该能力自己的版本（正整数）；`availability` 是 `always`（缺省即此义）/
  `foreground`（仅在设备上的 agent 处于前台时可用）/ `push`（需经推送唤醒）。初始词表：`ui.tree`、`ui.act`、
  `screen.shot`、`app.launch`、`app.in_use`、`input.text`、`notify.post`、`intent.run`；词表开放，后端保留
  不认识的 id。每个 agent 只声明它真有 op 撑起的能力。
- **Android agent 与桌面 host-agent 都发清单。** Android：`ui.tree`、`ui.act`、`screen.shot`、`app.launch`、
  `app.in_use`、`input.text`。桌面（Windows / macOS）：由声明的 op 推出 `ui.tree`、`ui.act`、`screen.shot`、
  `app.launch`、`input.text`（不声明 `app.in_use`：桌面没有占用判定）。Linux 设备模式：空清单（明说一项都没有）。
- **后端解析、校验、随设备保存，并经既有设备口带出。** `HostHello.caps`；`devices.onChange` 的 device online
  事件与 `devices.online()` 快照在 `ops` 旁边带 `caps`；`GET /api/devices` 的在线行带 `caps`。类型
  `DeviceCaps` / `DeviceCapability` / `CapAvailability` 从库入口导出。
- **兼容。** 旧设备不带清单：照常握手，事件与快照里没有 `caps` 这一格。旧后端不认识这两格：照常握手（JSON
  多余字段被忽略）。`capsVersion` 不是本后端认识的版本，或 `caps` 不是对象：照常握手、清单整个忽略（不半读）。
  已知版本下单个条目畸形（id 不合规、`v` 不是正整数、不认识的 `availability`、超过 64 项）：只丢这一条，其余照收，
  每条连接记一行日志——清单永远不让 hello 被拒，旧后端不会因为新设备扩展了词表或取值而拒绝它。

## Capabilities

### Modified Capabilities

- `embeddable-device-gateway`：设备上下线事件与快照携带能力清单（ADDED Requirement）。

## Non-Goals

- 不按能力路由或拒绝 op：调度仍按 op 名判断 `unsupported`，清单只是给调用方读的声明。
- 不新增 op；`notify.post` / `intent.run` 只进词表，今天没有 agent 声明。

## Impact

- `src/http/host-registry.ts`（`parseHello` + 类型）、`src/engine/devices.ts`、`src/engine/index.ts`（类型导出，
  `exports.guard` 快照）、`src/http/device-routes.ts`、`docs/API.md`。
- `app/android/agent`：`Frames.hello` 带清单、`ANDROID_CAPS`。
- `app/host-agent`：`relay::with_caps` / `caps_for_ops`，本机与设备模式的 hello。
