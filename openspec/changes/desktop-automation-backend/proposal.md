# desktop-automation-backend

## Why

Windows 桌面执行的语义路径（a11y 读树、invoke、set-value）今天由 `app/host-agent/src/windows.rs`
里自维护的 UIA 代码承担。同时存在一个成熟的外部 desktop automation CLI（[agent-desktop](https://github.com/vercel-labs/agent-desktop)，
Apache-2.0），它把「语义动作不抢前台」做成了默认策略：headless 下 ref 点击/设值走 UIA 语义
pattern、失败关闭（`POLICY_DENIED`），物理输入一律要求显式 `--headed`——与桌面采集「后台干活
不打扰用户」的核心诉求一致。

本 change 把它接入为 Windows 与 macOS 上语义 a11y 读与动作的**首选执行者**，同时保留 Stream
自己的实现作为回落与坐标/键盘/消息/视觉层的唯一载体：

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

macOS 的语义路径由 `app/host-agent/src/macos.rs`（`AXUIElement`）承担。上游同样支持
macOS 13+（AX API）：headless 下 ref 点击 / 设值走语义动作，不移动指针、不抢焦点，只有
`--headed` 才允许物理输入——委托的前提在 macOS 上同样成立。两处平台差异单独处理：

- **名字有三个来源。** mac 控件的名字分散在 `AXTitle` / `AXDescription` / `AXValue`，
  只读一个会把「控件存在」读成「控件不存在」（`macos.rs` 头注第 2 条）。
- **授权是进程级的。** 辅助功能授权（TCC）按启动 agent 的那个应用算，缺了之后每条 AX 调用
  都会失败。所以 `PERM_DENIED` 在 macOS 上是**整会话降级**，不是逐 op 回落。

## What Changes

- **新增 `AgentDesktopBackend<D>`**（`app/host-agent/src/agent_desktop.rs`）：组合持有任意
  `Desktop` 实现并实现 `Desktop` trait——Windows 传 `WindowsDesktop`（UIA），macOS 传
  `MacDesktop`（AX），委托 glue 只有一份；`main.rs` 两个桌面平台的 `Backend` 都换成它。
  **op 面与 `dispatch` 完全不变**。语义 a11y op（`find` / `invoke` / `setValue` /
  `readSubtree`）优先委托给内嵌的 agent-desktop CLI（每 op 一个子进程，版本 pin 主.次 = 1.2，
  启动时 `--version` 自检）；其余 op（窗口枚举、scope/focus、坐标路、`type`、`press`、
  `nudge`、`post_input`、`clearInput`、`screenshot`、see/OCR 全档、`readElements` 三档、
  browser、launch）原样走本平台后端——`readElements` 的三档共享同一次截屏，只换 a11y 一档
  要重构整条管线，且 agent-desktop 的 a11y 档与 Stream 同源，第一批不值得换。
- **平台差异收敛为一张 `Profile`**：role 词表（Windows / macOS 各一张表）、name 来源
  （mac 三个）、`className`（mac 的 `AXIdentifier`）与 `read:value`（mac 的 `AXValue`）、
  权限缺失策略、回执的 native 标记（`uia` / `ax`）。glue 里没有平台分叉。
- **回落规则（native 路保留）。** 锁屏会话直接走旧路；agent-desktop 报指定错误码时回落
  本平台后端：`AMBIGUOUS_TARGET` / `POLICY_DENIED` / `PERM_DENIED` /
  `APP_NOT_FOUND` / `WINDOW_NOT_FOUND` / `SNAPSHOT_NOT_FOUND` / `ACTION_NOT_SUPPORTED` /
  进程失败 / 超时；`STALE_REF` 重新 snapshot 一次、仍败才回落（回执标记 `stale-retried`）。
  `ELEMENT_NOT_FOUND`（空结果是正常结果）与 `ACTION_FAILED`（应用没收下，换路同样没用）
  **不回落**，如实上报。
- **macOS 的委托面**：与 Windows 相同的语义 op 优先委托；上游不分配 ref 的角色
  （静态文本、容器、窗口）与原生 `AX` 名查询整条回落 `macos.rs`——前者委托过去只会把
  「存在」读成空，后者会被 canonical 词表放宽。macOS 的 role 映射单独一张表。
- **macOS 权限缺失 = 整会话降级。** CLI 报 `PERM_DENIED`（辅助功能授权）时，本 op 照表回落
  `macos.rs`（原因码 `perm-denied`），并把委托层本会话置为不可用：后续 op 直接走 AX、
  不再起 CLI 进程；只留一行日志，**不弹窗、不报错**。Windows 的 `PERM_DENIED`（UIPI）仍逐 op 回落。
- **回落一律留痕。** `settle` 回执新增 `backend`（`agent-desktop` / `uia` / `ax`）与
  `fallback`（原因码）字段（缺字段 = 没发生回落，wire 兼容）；host-agent 本地日志逐条记录
  op、原因码、耗时。
- **降级开关与定位。** `STREAM_DESKTOP_BACKEND=uia|native` 整批回旧路；二进制在 agent exe
  同目录找 `agent-desktop.exe`（macOS 为 `agent-desktop`），`STREAM_AGENT_DESKTOP_PATH` 可覆盖；
  版本自检不过或进程起不来 = 本会话永久走本平台后端并留痕（可选能力，不报错）。
- **打字引导。** recipe 层优先 `setValue`（元素级、不抢前台）；`type` 保留键盘路 + 前台闸门
  （`guard_actuation` / `guard_typing_landed` 语义一字不动）。`clearInput` 留键盘路；
  语义清空 = `setValue` 空串。
- **分发内嵌。** release-desktop 的 Windows job 落 `bin/agent-desktop.exe`；macOS 两个 job
  （arm64 / x64）下载对应架构的包、核验 checksums，落 `bin/agent-desktop`；两个 darwin
  平台包的 `files` 白名单加行。`THIRD-PARTY-NOTICE` 的条目补平台说明。
- **CI 防构建断裂。** 常规 test 流程增加 Windows 与 macOS target 的交叉 `cargo check`
  （不链接），让「两个桌面平台都还能编译」成为每次 push 都被验证的事实，而不是等到下一次
  打 release tag 才发现。

## Capabilities

### New Capabilities
- `desktop-automation-backend`：Windows / macOS 桌面语义 a11y 执行委托外部 desktop
  automation CLI；回落梯子与留痕；降级开关与版本自检；分发内嵌。

### Modified Capabilities
- `desktop-recipe-replay`：打字引导（优先 set-value）；动作回执可区分走了哪条执行路。

## Dependencies

- 依赖现有 desktop-recipe-replay 的 op 面与重放模型（本 change 不改它们）。
- agent-desktop 以 Release 二进制内嵌分发，Apache-2.0；升级 = 换 pin 的 minor 版本 +
  换下载 URL + 重跑两个平台的真机清单。
- macOS 委托要求 macOS 13+ 与辅助功能授权；屏幕录制授权只影响截图/OCR（不走委托）。
