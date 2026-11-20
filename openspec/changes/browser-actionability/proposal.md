# browser-actionability

## Why

中继上的 `click` / `type` 今天只做两件事：用 `document.querySelector` 取第一个命中元素、读它的矩形，然后把 `Input.*` 事件按坐标发下去。它不检查这个人**能不能**点到那个元素，也不检查事件**有没有**到达页面：

- 被 cookie 横幅盖住的按钮、`disabled` 按钮、`display:none` 的按钮，点击全部返回成功，页面毫无变化（假成功）。
- 视口外的元素按元素中心的坐标点击，不先滚动；坐标落在视口外时浏览器什么也不做，调用方仍拿到成功。
- 命中测试与按下之间 DOM 节点被同名节点替换（churn）时，一部分点击静默丢失——输入发给了已经不存在的节点，没有任何回执。
- `type` 只确认选择器命中，不确认元素可见 / 可编辑，也不回读写入结果；表单偶发填写丢失时同样报成功。

调用方（recipe 的 `expect`、模型面的 `cdp_act`）只能靠事后观察猜，猜不到就以为动作没发生，或者更糟——以为已经发生。

## What Changes

- 在共享层新增 `shared/browser-relay/actionability.ts`：存在 → 可见（非 `display:none` / `visibility:hidden|collapse` / 零尺寸 / `opacity:0`，含祖先）→ 启用（`:disabled`、`aria-disabled="true"`、disabled `fieldset`）→ 用 `scrollIntoView` 滚进视口并等布局稳定 → 用 `document.elementFromPoint` 做命中测试（目标或其后代才算命中）。任一步不过就返回结构化失败，**不发出任何输入事件**。
- 点击与写入共用这一份前置检查；扩展的 `chrome.debugger` 与 CDP 绑定的 `CdpRelayOps` 都走同一个 `makeExtPageDriver`（扩展本身只是 CDP 管子，不含定位逻辑）。
- 回执契约：失败带稳定分类码 `not-found` / `not-visible` / `disabled` / `covered` / `detached` / `outside-viewport`（写入另有 `value-mismatch`、`not-editable`），并带人话原因；遮挡原因里简述遮挡元素。
- `click` / `type` 的旧布尔语义保留（`false` = 没找到，且任何前置检查失败都不发输入）；新增 `clickReceipt` / `typeReceipt` 返回结构化回执。`actWithConfirm` 把失败码提升为 `ActResult.status`，并新增 `delivery` 字段。
- 点击后的轻量确认：点击前在页内挂一次性 `click` 捕获监听，点击后短轮询它是否收到可信事件；收不到时回执标 `delivery: "unconfirmed"`——不是失败、不重试。
- 写入后回读：`input` / `textarea` 读 `value`，`contenteditable` 读文本；与写入值不一致即 `value-mismatch`。
- DOM churn：命中测试后、发输入前用节点标记复核同一节点；被替换则回 `detached`，按 locator 重新定位一次再试（只一次）。

## Capabilities

### New Capabilities
- `browser-actionability`：点击 / 写入前的可操作性检查、结构化失败回执、动作后确认与 churn 重定位。

### Modified Capabilities
- 无（`ext-cdp-interactive-transport` 的授权、域名校验与确认门不变；本 change 只让动作在“目标不可操作”时不再假成功）。

## Non-Goals

- 不引入 agent-browser 或任何新的外部二进制、新依赖。
- 不改扩展的授权边界、域名复核与高危确认门。
- 不把“动作后确认”升级成失败：没有 `expect` 的动作仍以 `delivery: "unconfirmed"` 如实回执，由调用方决定下一步。
- 不改 cloak / Playwright 那条 transport（它已有 Playwright 自带的 auto-wait）。

## Impact

- `shared/browser-relay/actionability.ts`（新增）、`shared/browser-relay/ext-page.ts`（click / type 接前置检查与回执）、`shared/browser-relay/page-driver.ts`（可选回执动词）、`shared/browser-relay/run-action.ts`（`runActionDetailed` / `actWithConfirm` 映射失败码）、`shared/browser-relay/interactive-gate.ts`（`ActResult` 状态与 `delivery`）。
- `shared/browser-relay/tool-specs.ts`：`cdp_act` 的描述写清新的失败状态与 `delivery: "unconfirmed"`。
- 测试：`shared/browser-relay/actionability.test.ts`（单测），`src/cdp-binding/actionability-relay.test.ts`（真 Chromium + 本地 fixture 的集成测试）。没有 Chromium 时整组跳过并打印原因。
- 公共导出：`shared/browser-relay/actionability.ts` 可被嵌入方直接 import；`ext-page.ts` 的既有导出不变。
- 既有行为：`click` / `type` 继续返回布尔；`runAction` 的返回值不变（新增的详细版本供 `actWithConfirm` 使用）。
