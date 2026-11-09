## Why

设备端已经能替用户完成带后果的动作（`android-phone-surface`：点击、输入、启动 App）。这些动作有多敏感，只有设备看得见：被点控件的角色与文案、所在 App 的类目、目标是不是密码框或验证码框，都在设备的无障碍树里，素材离开设备就无从判定。今天执行端对动作没有任何语义把关：一个「立即支付」按钮和一个翻页 tab 在协议里都是一次 `click`，密码框和普通输入框在协议里都是一次 `setValue`，读取层也不加区分地把整棵树原样出站——密码与验证码的值会出现在树读取和截图的出站帧里。

需要的是：**执行端在动作发出前识别「这是什么」，把能拦的拦在数据离开设备之前。**

- 提交类动作（发送、支付、确认、删除、安装、改设置等）**缺省要求一次审批请求**：不执行，回结构化错误，把判定素材带给调用方，由调用方决定怎么问、问谁、问完怎么恢复。
- 密码与验证码的值**在任何出站帧里都不出现**：打码在读取层完成，而不是事后审计。
- 资金、密码管理、用户手动拉黑的 App **对调用方整体不可见**：读不到屏、动作一律拒绝。
- 调用方批准之后按原参数重发同一次调用，执行端自校批准凭据（绑定、一次性、过期、屏幕未变）后才执行。

档位裁决、批准人、审批记录与恢复流程都是调用方的审批产品语义，不在本提案内；本提案只定义执行端的判定、回执与校验协议。

## What Changes

- **提交类动作缺省要求审批请求。** 执行端对会作用于屏幕的动作（`click`、`invoke`、`setValue`、`type`、`clearInput`、`scroll`）在执行前做敏感判定：命中提交类（结构信号 + 多语言词表）或类目表把该 App 标为 ask 的动作不执行，回 `approval-required` 并附 `semantics`（op、App 与类目、控件 role 与打码后的文案、reasons、屏幕 digest、打码快照引用）。**缺省从严**：词表未识别的提交类候选（`role=button` 且在表单 / 确认上下文）同样要求审批（reason `commit-unrecognized`）。
- **批准凭据与执行前四查。** 调用方批准后按审批里的参数原样重发同一次调用，`args.approval = { id, bindingDigest, screenDigest, expiresAt }`。执行端在任何动作前自校四件事，任一不过即拒绝：凭据过期 → `approval-expired`；绑定不符（设备 / 会话租约 / op / 参数 digest 任一不同）→ `approval-mismatch`；凭据已消费 → `approval-used`；执行前重读屏幕、digest 已变 → `approval-stale`。一个批准只执行一次动作。凭据过期时长由调用方配置，执行端只认凭据上的过期时刻。
- **读取层打码。** 密码框与验证码字段的值在出站前替换为掩码：树读取（`find` / `readSubtree`）的标签与文本、截图里被识别元素的覆盖区域、`approval-required` 回执里的控件文案。无法可靠掩码时不回图（同 `secure-window`）。密码与验证码字段禁止写入：`setValue` / `type` / `clearInput` 一律 `credential-field-denied`，任何审批与豁免都不可解除。
- **App 类目与可见性。** 类目表随 Stream 版本走；deny 类目（资金、密码管理、用户手动拉黑）的 App 对调用方整体不可见：读不到屏、通知不出现、任何动作拒绝（`app-denied`）。豁免永远不解除 deny 类目与凭据字段。
- **App 级豁免由调用方下发。** 执行端只存储与匹配调用方下发的豁免（App × 动作类目），不自带过期、不管理生命周期：下发即生效，连接断开即清空。豁免只解除「要求审批」，不解除 deny，不解除凭据字段。
- **审批未决期间执行端可被置忙。** 调用方用控制帧把执行端置忙（busy）；置忙期间除 `status`、`sleep` 与控制帧外一律回 `device-busy`；`busy:false` 或连接断开自动解除。执行端不推断忙的时长。
- **词表与类目表随 Stream 版本走。** 提交 / 资金 / 安装 / 呼叫 / 设置 / 密码 / 验证码词表（11 种 UI 语言）与 App 类目表以数据文件随 Stream 发布，摘自 Pinky（Apache-2.0）的部分保留 NOTICE 与出处。漏报的兜底是结构信号优先于词表 + 缺省从严。

## Capabilities

### New Capabilities

- `device-sensitive-semantics`：执行端的敏感动作判定、`approval-required` 回执与 semantics schema、批准凭据的执行前校验、读取层打码、App 类目与可见性、豁免下发、置忙语义、词表与类目表。

### Modified Capabilities

- `android-recipe-replay`：gated op 的处理流程在既有 keyguard 检查之后、任何设备动作之前加入 busy 检查与敏感闸；既有 Requirement（keyguard、stale-ref、abort 等）的语义不变。

## Dependencies

- 依赖 `android-phone-surface` 已落地的部分：多设备 host-relay、`hello` 声明 op 集、`{id, result | error{code, message}}` 帧封装、每设备的会话租约。本提案不改变这些机制。
- 沿用 `device-execution` 确立的错误码族语义：`device-offline`（未发出任何动作、可挂起恢复）、`device-lost`（状态未知、不自动重试）、`device-incapable`（派发前能力不足）。

## Non-Goals

- **不做档位裁决与审批产品语义。** reasons 到档位的映射、谁能批、审批记录与挂起恢复归调用方；执行端只回执与校验。
- **不管理豁免的建立、收回与过期。** 豁免由调用方下发与收回，执行端不持有关限状态。
- **不做录屏、审计与快照存储。** 执行端只产出打码快照的设备端引用；留存与可见性归调用方。
- **不做 OCR。** 无障碍树不可得的自定义绘制 UI（Flutter、游戏引擎、无无障碍的 WebView）的判定能力以现状为限，如实表现为「无语义」并走缺省从严。
- **不引入新 op、不改变 op 集声明机制。** 敏感闸作用于既有 op；busy 与豁免走控制帧，不走 op。
- **词表与类目表不做运行时热更新**，随 Stream 版本发布。

## Impact

- `app/android/`：新增策略引擎（词表、类目、凭据字段识别、打码、提交类判定），op 处理层接入 busy 检查、敏感闸与批准凭据校验，读取层（`find` / `readSubtree` / `screenshot`）接入打码。词表与类目表以数据文件随 App 构建，`NOTICE` / `THIRD-PARTY-NOTICE` 登记 Pinky（Apache-2.0）出处。
- host-relay 协议文档（`docs/`）：新增错误码、`semantics` schema 与控制帧（busy、豁免下发）说明。
- 调用方（桌面 runner、宿主后端）需要认识新错误码并按需处理 `args.approval`；本提案不要求任何调用方行为变更——不认识新错误码的调用方维持今天的失败语义。
