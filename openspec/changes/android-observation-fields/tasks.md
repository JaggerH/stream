# android-observation-fields — tasks

- [x] 1. 身份与找回的原语（新文件 `agent/Stability.kt`，纯 JVM 可测）：`ElementFp`（role、className、
       身份名、viewId、rect、editable、hint、inList、上下文）、身份键（role + 身份名 + viewId；
       输入框身份名取提示词，无提示词视为无名）、`stripDigits`、`relocate`（唯一匹配 + 上下文一致 +
       位移 ≤15%；stationary 时放宽：同 viewId 原地、数字改名或轮换提示词）、`stationary`
       （前后唯一有名元素 ≥2 且八成以上原地 ≤2%）、`effectOf`（no_effect / small_change /
       place_changed / done）、`readableResourceId`（`^[A-Za-z0-9_]{4,}$` 且含连续 3 个字母）
- [x] 2. `UiNode.hintText` / `isShowingHint`；`NodeAdapter` 从 `hintText` / `isShowingHintText` 读，
       `text == hint` 也算显示提示词；`FakeNode` 补齐
- [x] 3. `RefTable` 改跨读保留表：ref 编号单调、退役不复用；snapshot 按身份键沿用旧 ref（唯一、同
       窗口、区域无变化事件、位移 ≤15%、列表项原地 ≤2%）；`resolve` 报四种 stale 分型
       （`StaleRefException` 变 `AgentError` 子类，带 `code: "stale-ref"` 与 `semantics: {kind, ref}`）
- [x] 4. `Dispatcher.find`：元素带 `hintText` / `isShowingHintText` / `viewId` / `editable`，回执带
       `viewport`；`ui.tree` 升 v3
- [x] 5. `Dispatcher.windows`：行带 `type` / `layer` / `viewport`；悬浮层与键盘列出、`foreground`
       恒假、`scopeWindow` 只认应用窗口；`AndroidDevice.windows` 供 type/layer
- [x] 6. `Dispatcher.resolveRef`：动作时找回（新树里唯一匹配 → 更新条目，回执带 `relocated`）；带
       审批凭据不找回；滚动过的列表项不找回
- [x] 7. `Device.lastA11yEventMs` / `scrolledSince`（`ChangeLog` 记事件时刻、按滚动键判别；服务喂
       事件时刻）；`Dispatcher.settle` 静默等待（quiet 450ms + 树指纹变化即完成，封顶 2.5s，时间参数
       可注入），回执 `settled` / `changedDuringRead` / `effect` / `confirmed` / `relocated`；
       press 三键走同一等待
- [x] 8. 单测：`StabilityTest`（找回与 stationary 与 effect）、`RefTableTest` 重写（沿用、分型、不复
       用）、`DispatcherTest`/新 `ObservationFieldsTest`（字段、viewport、windows type/layer、找回、
       静默等待、凭据不放宽）
- [x] 9. TS：`A11yElement` / `A11yRowValue` / `A11yFindResult` 补类型；`HostOpSemantics` 增加
       `{kind, ref}`；vitest 对应透传断言；`pnpm -r typecheck` 与相关包测试
- [x] 10. `docs/API.md`：ops 表、ref 生命周期、stale 分型、静默等待回执
- [ ] 11. 真机（Android 16）验证：轮播页 ref 沿用与找回、倒计时页动作不卡 2.5s、输入框提示词读出
