# browser-actionability

## 计划 1：失败测试

- [x] 1. `shared/browser-relay/actionability.test.ts`：`not-found` / `not-visible` / `disabled` / `covered` / `outside-viewport` / `detached` 各一条，断言失败时零 `Input.*`
- [x] 2. 同上：成功路径落在可见交集中心、`position` 偏移不被滚动改写
- [x] 3. `src/cdp-binding/actionability-relay.test.ts`：真 Chromium + 本地 fixture，覆盖 overlay / states / 视口外 / churn / 表单回读
- [x] 4. `actWithConfirm`：失败码成为 `status`，成功但无点击事件时 `delivery: "unconfirmed"`

## 计划 2：共享层实现

- [x] 1. `shared/browser-relay/actionability.ts`：探测表达式、滚动 + 布局稳定、命中测试 + 遮挡描述、节点标记复核
- [x] 2. `ext-page.ts`：`clickReceipt` / `typeReceipt`；`click` / `type` 转调并保持布尔语义；写入回读
- [x] 3. `page-driver.ts`：可选回执动词
- [x] 4. `run-action.ts`：`runActionDetailed`；`actWithConfirm` 映射失败码与 `delivery`
- [x] 5. `interactive-gate.ts`：`ActResult` 状态扩展与 `delivery`
- [x] 6. `tool-specs.ts`：`cdp_act` 说明书补新状态与 `delivery`

## 计划 3：验证与交付

- [x] 1. 受影响测试 + `pnpm typecheck`（未改 `extension/`，其套件不涉及本层）
- [x] 2. Stream 全量（整包，套整机锁）
- [x] 3. 用与 fixture 相同的六个 relay 任务测改动前后的成功率，写进报告
- [ ] 4. 推 Stream 的 `ci/browser-actionability`（不推 main），删 worktree
