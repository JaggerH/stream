# android-scroll-until-claim-labels — tasks

## 计划 1：失败测试先行

- [x] 1. `ScrollUntilTest`：已可见不滑、滚 N 步找到、两次树不变到底、`maxSteps`、`timeoutMs`、无 `until` 保持原形、窗口消失
- [x] 2. `DetectTest` / `PolicyGateTest`：领券放行（中英）、领取并开通照拦、支付确认对话框里的领取照拦、去结算/提交订单/立即支付/确认付款照拦
- [x] 3. `WindowKindsTest` / `DispatcherTest`：ANR 识别（资源 id、多语言词）、所属应用包名、`windows` 回执字段
- [x] 4. 协议测试 `src/http/device-routes.test.ts`：`scroll until` 回执与 `windows` 的 `anr` / `appPackage` 原样透传

## 计划 2：实现

- [x] 1. `Dispatcher.scroll`：`until` / `maxSteps`（缺省 20，1–50）/ `timeoutMs`（缺省 15000，0–60000）；`scrollUntil` 单步循环、两次不变判到底；回执 `found`/`scrolls`/`stopped`/`visible`/`match`
- [x] 2. `Detect`：领取词表与例外判定；`isCommitLabel` / `movesMoney` / `isClaimLabel`；`Gate` 跳过领取类的 commit / install / payment，支付确认对话框例外；`unrecognizedCommit` 排除领取标签
- [x] 3. `WindowInfo` 增加 `anr` / `appPackage`；`WindowKinds` 的 `looksLikeAnr` / `anrOwner`；`AndroidDevice.windows` 对 system 窗口做有界探测；`toMap` 输出新字段
- [x] 4. `ui.tree` 能力升到 v4

## 计划 3：文档与验证

- [x] 1. `docs/API.md`：`windows` 的 ANR 标注、`scroll` 的 `until` 参数 / 缺省 / 回执、敏感闸的领取词表与例外
- [x] 2. `:agent:testDebugUnitTest` 全量（346 条，6 条 `OwnTouchFrameTest` 是 lean aarch64 的 Robolectric 环境性失败，单列）
- [x] 3. `:app:testDebugUnitTest`
- [x] 4. Stream 全量测试 + `pnpm -r typecheck`；rebase、推到 `ci/scroll-until-claim`
