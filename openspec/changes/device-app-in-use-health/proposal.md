# device-app-in-use-health

## Why

设备执行端 today 会抢走用户正在用的前台 App：用户在前台逛购物 App 时，一次 `focusApp` 直接把它顶到后台。
合理的做法是等用户用完——但执行端今天对「这个 App 是不是正被用户用着」没有事实可用，调用方也没有一个
结构化信号可以挂起等待。

同时，设备环境问题会让所有 op 看起来都失败，根因却只有设备自己看得见：系统时钟错了几个月导致
设备侧所有 HTTPS 校验失败、无障碍服务没开、屏幕锁着、网络断/未验证。调用方今天只能从一个个 op
失败的报错里猜，缺一份能读的设备健康事实。

## What Changes

- **执行端不抢用户正在用的 App。** 可能接管屏幕的 op（`focusApp`、`scopeWindow`、动作类
  `click`/`invoke`/`setValue`/`type`/`clearInput`/`scroll`/`press`）在执行任何动作之前判定目标 App
  是否正被用户占用。占用判定基于两个设备端事实：目标 App 当前持有前台焦点，且无障碍服务在最近 10 秒
  内观察到一次用户触摸交互事件——执行端自己注入的手势不算（注入期间及完成后 2 秒内的触摸事件不计入）。
  命中即不执行任何动作，回 `app-in-use` 错误：code 为 `app-in-use`，`semantics` 为
  `{op, app: {id, name}}`（name 缺省取包名）。纯读取 op（`find`/`readSubtree`/`url`/`screenshot`）
  不触碰屏幕，不做此判定。挂起等待与重试策略归调用方。
- **`state` 帧增加可选 `health`。** 设备在 `state` 帧里带 `health` 对象：`networkOk`（系统对默认网络
  的连通性校验，`NET_CAPABILITY_VALIDATED`）与 `clockSkewMs`（本机时钟减后端时钟的毫秒偏差，正 =
  设备快）。后端时间是后端进程自己的时钟：设备注册 android 的 `hello` 之后，后端立即向该设备发一帧
  `{type: "time", serverTime: Date.now()}`，设备以收到该帧那一刻的本机时钟减 `serverTime` 得到偏差，
  并立即回发一条携带偏差的 `state`；同一连接内复用该偏差，重连后重测。收到 `time` 帧之前 `clockSkewMs`
  缺省缺失。设备只上报事实，不做判断（不设「偏差多大算坏」的阈值）。无障碍开关与锁屏状态已由 `state`
  的既有字段 `a11yEnabled`/`keyguardLocked`/`screenOn` 报告，本提案不重复。
- **`GET /api/devices` 的行带出 `health`**（随既有 `state` 字段一起）；`POST /devices/:id/ops` 与
  `/devices/:id/control` 的 502 透传机制不变（`device-op-error-semantics`），`app-in-use` 的
  `code` 与 `semantics` 经既有通道原样带出；`HostOpError` 的 `semantics` 类型放宽为两种设备回执的
  并集（审批回执 `DeviceOpSemantics`、占用回执 `AppInUseSemantics`），类型从 `@streamapp/engine`
  公共入口导出。

## Capabilities

### Modified Capabilities

- `android-recipe-replay`：执行端占用判定与 `app-in-use` 错误；`state` 帧的 `health` 扩展与后端
  `time` 帧（ADDED + MODIFIED Requirement）。
- `embeddable-device-gateway`：管理口 502 透传的 `semantics` 增加 `app-in-use` 回执形状；`GET /api/devices`
  行随 `state` 带出 `health`（ADDED Requirement）。

## Dependencies

- 依赖 `device-op-error-semantics` 已落地的结构化错误通道：设备错误帧 `{id, error, code?, semantics?}` →
  `HostOpError` → 管理口 502 body。本提案不新增通道，只新增一种 code 与一种 semantics 形状。
- 依赖 `android-phone-surface` 的 `state` 帧机制（hello 后立即 + 每 30 秒 + 无障碍变化时发送）。

## Non-Goals

- **不定义挂起等待策略。** 收到 `app-in-use` 后等多久、何时重试、是否提示用户，归调用方。
- **不做任务中途抢回前台的仲裁。** 动作类 op 的判定窗口是每个执行点；超出「最近 10 秒内有用户输入」
  之外的用户在场判断（例如用户在读屏没有触摸）不做。
- **设备端不做健康判断。** 时钟偏差多大算坏、网络未验证算不算不能用，都是调用方的事；设备只报事实。
- **桌面设备不在此提案内。** 桌面 agent 没有等价的前台占用与触摸事实源，`time` 帧只发给 android 平台。
- **不改变 op 集声明机制。** 不新增 op，判定作用于既有 op。

## Impact

- `app/android/`：`Dispatcher` 的占用判定与错误回执；`Device` 接口与 `AndroidDevice`/无障碍服务接入
  触摸交互事件（自注入手势排除）；`RelayClient` 接收 `time` 帧、`state` 帧带 `health`；`RelayService`
  上报 `networkOk`。
- `src/http/host-registry.ts`（`HostDeviceState.health` + `parseState`）、`src/http/host-relay.ts`
  （android hello 后发 `time` 帧；`HostOpSemantics` 并集类型）、`src/engine/index.ts`（类型导出）、
  `docs/API.md`（`state` 帧契约与 `/ops` 502 的 `app-in-use` 一段）。
- 兼容性：`health` 与 `clockSkewMs` 都是缺省缺失的新字段，老设备不带上游解析照旧；`error` 与状态码
  不变；`semantics` 的两种形状由 `op` 字段同现的上下文区分，后端原样转发不解释。
