# desktop-automation-backend

## Why

Windows 桌面执行的语义路径（a11y 读树、invoke、set-value）今天由 `app/host-agent/src/windows.rs`
里自维护的 UIA 代码承担。同时存在一个成熟的外部 desktop automation CLI（[agent-desktop](https://github.com/vercel-labs/agent-desktop)，
Apache-2.0），它把「语义动作不抢前台」做成了默认策略：headless 下 ref 点击/设值走 UIA 语义
pattern、失败关闭（`POLICY_DENIED`），物理输入一律要求显式 `--headed`——与桌面采集「后台干活
不打扰用户」的核心诉求一致。

本 change 把它接入为 Windows 上语义 a11y 读与动作的**首选执行者**，同时保留 Stream 自己的
实现作为回落与坐标/键盘/消息/视觉层的唯一载体：

- **不抢前台是默认，不是可选项。** agent-desktop 的 headless 语义路（Invoke pattern、Value
  pattern + 回读确认）与 windows.rs 现有的 invoke 梯子、set_value 回读纪律语义同构，但策略
  层（`allow_focus_steal` / `allow_cursor_move` 两比特）比 Stream 的「调用方自觉」更硬。
- **UI 变更后的定位靠结构特征，与现有重放模型天然一致。** agent-desktop 的 ref 只在单个
  snapshot 内有效（`@<snapshot_id>:eN`），跨步骤一律重新定位——这正是 desktop-recipe-replay
  「a11y Locator by structural features, not stable id」已经规定的行为。
- **三层兜底一条不少。** agent-desktop 是纯 a11y，没有视觉层；自绘控件（不暴露 UIA 树的
  Electron 应用）、坐标点击、物理键盘、`PostMessage` 消息路、锁屏采集都留在 windows.rs，
  一行不删。

Windows 的 `type` 只有物理键盘路（headless 直接 `POLICY_DENIED`），本 change 把 recipe 层的
打字引导定为「优先 set-value」：`setValue` 是元素级投递、不需要前台；`type` 仅在用户在场或
recipe 显式同意抢屏时使用（前台闸门照旧）。

## What Changes

- **新增 `AgentDesktopBackend`**（`app/host-agent/src/agent_desktop.rs`，Windows 构建）：
  组合持有现有 `WindowsDesktop` 并实现 `Desktop` trait，`main.rs` 的 `Backend` 换成它。
  **op 面与 `dispatch` 完全不变**。语义 a11y op（`find` / `invoke` / `setValue` /
  `readSubtree` / `readElements` 的 a11y 档）优先委托给内嵌的 agent-desktop CLI
  （每 op 一个子进程，版本 pin 主.次 = 1.2，启动时 `--version` 自检）；其余 op
  （窗口枚举、scope/focus、坐标路、`type`、`press`、`nudge`、`post_input`、`clearInput`、
  `screenshot`、see/OCR 全档、`readElements` 三档、browser、launch）原样走 `WindowsDesktop`
  ——`readElements` 的三档共享同一次截屏，只换 a11y 一档要重构整条管线，且 agent-desktop
  的 a11y 档与 Stream 同源（都是 UIA），第一批不值得换。
- **回落规则（UIA 路保留）。** 锁屏会话直接走旧路；agent-desktop 报指定错误码时回落
  `WindowsDesktop` 的 UIA 实现：`AMBIGUOUS_TARGET` / `POLICY_DENIED` / `PERM_DENIED` /
  `APP_NOT_FOUND` / `WINDOW_NOT_FOUND` / `SNAPSHOT_NOT_FOUND` / `ACTION_NOT_SUPPORTED` /
  进程失败 / 超时；`STALE_REF` 重新 snapshot 一次、仍败才回落（回执标记 `stale-retried`）。
  `ELEMENT_NOT_FOUND`（空结果是正常结果）与 `ACTION_FAILED`（应用没收下，换路同样没用）
  **不回落**，如实上报。
- **回落一律留痕。** `settle` 回执新增 `backend`（`agent-desktop` / `uia`）与 `fallback`
  （原因码）字段（缺字段 = 没发生回落，wire 兼容）；host-agent 本地日志逐条记录
  op、原因码、耗时。
- **降级开关与定位。** `STREAM_DESKTOP_BACKEND=uia` 整批回旧路；二进制在 agent exe 同目录
  找 `agent-desktop.exe`，`STREAM_AGENT_DESKTOP_PATH` 可覆盖；版本自检不过或进程起不来 =
  本会话永久走 UIA 并留痕（可选能力，不报错）。
- **打字引导。** recipe 层优先 `setValue`（元素级、不抢前台）；`type` 保留键盘路 + 前台闸门
  （`guard_actuation` / `guard_typing_landed` 语义一字不动）。`clearInput` 留键盘路；
  语义清空 = `setValue` 空串。
- **分发内嵌。** release-desktop 的 Windows job 从 agent-desktop 的 GitHub Release 下载
  Windows 包并核验 checksums，落平台包 `bin/agent-desktop.exe`；`THIRD-PARTY-NOTICE`
  增加 Apache-2.0 条目。
- **CI 防构建断裂。** 常规 test 流程增加 Windows target 的交叉 `cargo check`（不链接、
  不需要 mingw），让「Windows 还能编译」成为每次 push 都被验证的事实，而不是等到下一次
  打 release tag 才发现。

## Capabilities

### New Capabilities
- `desktop-automation-backend`：Windows 桌面语义 a11y 执行委托外部 desktop automation CLI；
  回落梯子与留痕；降级开关与版本自检；分发内嵌。

### Modified Capabilities
- `desktop-recipe-replay`：打字引导（优先 set-value）；动作回执可区分走了哪条执行路。

## Dependencies

- 依赖现有 desktop-recipe-replay 的 op 面与重放模型（本 change 不改它们）。
- agent-desktop 以 Release 二进制内嵌分发，Apache-2.0；升级 = 换 pin 的 minor 版本 +
  换下载 URL + 重跑真机清单。
