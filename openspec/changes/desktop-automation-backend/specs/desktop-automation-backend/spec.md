## ADDED Requirements

### Requirement: Windows 语义 a11y 执行优先委托外部 desktop automation CLI

Windows 的 host agent SHALL 把语义 a11y 读与动作（`find`、`invoke`、`setValue`、`readSubtree`）
优先委托给内嵌的 desktop automation CLI（agent-desktop，Apache-2.0，
版本 pin 主.次 = 1.2），并 SHALL 保留现有 UIA 实现作为回落。委托方式 SHALL 是每 op 一个 CLI
子进程（JSON envelope v2.x），MUST NOT 改变 `Desktop` trait 的 op 面或 `dispatch` 的分发行为。
CLI 的 ref 只在单个 snapshot 内有效；后端 SHALL 持有当前 snapshot 上下文，使 `find` 命中的 ref
与后续 `invoke` / `setValue` 落在同一 snapshot，且 `scopeWindow` / `focusApp` SHALL 使其作废。
CLI 不可用（进程起不来、版本不符）时 SHALL 静默走 UIA 并留痕，MUST NOT 报错——它是可选能力。

`find` 的查询语义（`role` / `name` / `nameContains` / `className` / `path`）SHALL 全量保留；
CLI 查询面没有 `nameContains` 等价物时 SHALL 用 snapshot + 本地过滤补齐，MUST NOT 静默丢条件。

`setValue` 的投递确认 SHALL 读 CLI 的 disposition：`delivered_verified` / `delivered_unverified`
算成功、`not_delivered` SHALL 报错（与 UIA 路的回读纪律同口径）。

#### Scenario: 后台窗口上语义设值不抢前台

- **WHEN** 目标窗口在后台、用户窗口持前台，recipe 对一个 ValuePattern 可写控件执行 `setValue`
- **THEN** 动作经 CLI 的语义路投给元素本身，前台不变化，回执 `backend` 为 `agent-desktop`

#### Scenario: CLI 缺席时不影响其它 op

- **WHEN** 平台包里没有 agent-desktop 二进制或版本 pin 不符
- **THEN** host agent 启动正常、日志留痕，语义 op 走 UIA 路，坐标 / 键盘 / 截图 op 行为不变

#### Scenario: nameContains 查询不丢条件

- **WHEN** recipe 用 `{role:'ListItem', nameContains:'频道名'}` 定位动态长名的列表项
- **THEN** 后端以 snapshot + 本地过滤执行该查询，命中结果与 UIA 路的语义一致

### Requirement: 指定错误回落 UIA，投递未知绝不重执行

agent-desktop 报以下情况时 SHALL 回落 UIA 路并在回执标注原因（这些失败都发生在动作**投递之前**，
回落不会重复执行）：`AMBIGUOUS_TARGET`、`POLICY_DENIED`、`PERM_DENIED`、`APP_NOT_FOUND`、
`WINDOW_NOT_FOUND`、`SNAPSHOT_NOT_FOUND`、`ACTION_NOT_SUPPORTED`、动作进程 spawn 失败；`STALE_REF`
SHALL 重取 snapshot 一次、仍败才回落（原因码标 `stale-retried`；ref 失效 = 确定未执行，重试安全）。
会话锁屏时 SHALL 直接走 UIA 路。以下情况 MUST NOT 回落：`ELEMENT_NOT_FOUND` 与 `ACTION_FAILED`
（前者是正常结果，回落会掩盖 drift 分类；后者说明应用没收下，换路同样没用）；**动作进程超时、
中途失败、回执解析不了、未知错误码**——动作 op 的输入可能已经落到应用上，回落 UIA 路就是执行
第二次（一次点击「发送」变两次）。投递状态不明的动作 op SHALL 以 `delivery-unknown` 档如实上抛，
MUST NOT 重发；读 op（无副作用）对同一类失败照旧回落。

#### Scenario: 双胞胎控件回落 UIA

- **WHEN** 两个同名控件使 CLI 报 `AMBIGUOUS_TARGET`
- **THEN** 动作由 UIA 路重新定位后完成，回执带 `backend` 与 `fallback` 原因码

#### Scenario: 元素不存在不回落

- **WHEN** recipe 查询一个此刻不存在的元素，CLI 报 `ELEMENT_NOT_FOUND`
- **THEN** op 返回空结果，不执行 UIA 路，drift 分类与 CLI 缺席时一致

#### Scenario: 动作超时不重执行

- **WHEN** 一次 `invoke` 的 CLI 进程超时被强杀（输入可能已经投出）
- **THEN** host agent 以 `delivery-unknown` 报错，不回落 UIA 路、不重发该动作；同一查询若发生在
  `find`（读 op）上则照旧回落

### Requirement: 动作回执与日志可区分执行路

动作 op 的回执 SHALL 带执行路标记：`backend`（`agent-desktop` / `uia`）与发生回落时的
`fallback` 原因码；未回落时 MUST NOT 出现 `fallback` 键（「没验到」与「验过」分得开的同一
纪律）。host agent SHALL 为每次回落写一行本地日志（op、原因码、耗时），供真机验收统计
一致率与回落率。

#### Scenario: 回执说明走了哪条路

- **WHEN** 一次 `setValue` 先被 CLI 以 `POLICY_DENIED` 拒绝、随后由 UIA 路完成
- **THEN** 回执 `backend` 为 `uia`、`fallback` 为对应原因码，本地日志有一行对应记录

### Requirement: 降级开关与二进制定位

环境变量 `STREAM_DESKTOP_BACKEND=uia` SHALL 使语义 op 整批走 UIA 路（缺省 = CLI 优先）。
二进制 SHALL 在 host agent exe 同目录寻找 `agent-desktop.exe`，`STREAM_AGENT_DESKTOP_PATH`
SHALL 覆盖定位。启动自检 SHALL 解析 `--version` 并要求主.次版本等于 pin 值；不符时本会话
SHALL 永久走 UIA。

#### Scenario: 开关整批回旧路

- **WHEN** `STREAM_DESKTOP_BACKEND=uia` 下执行一轮桌面 recipe
- **THEN** 所有语义 op 走 UIA 路，回执 `backend` 为 `uia`，无 CLI 子进程被启动

### Requirement: agent-desktop 随平台包分发

release 流程 SHALL 把 agent-desktop 的 Windows 二进制内嵌进 `@streamapp/desktop-win32-x64`
平台包（bin/ 与 stream-desktop 同目录），下载 SHALL 核验上游 checksums（CRLF 剥除后比对），
用户 MUST NOT 另行安装。第三方归属 SHALL 记入 `THIRD-PARTY-NOTICE`（Apache-2.0）。

#### Scenario: 干净装机即有语义路

- **WHEN** 用户安装包含平台包的发行版后运行桌面 recipe
- **THEN** CLI 从平台包 bin/ 解析成功、版本自检通过，无需任何额外安装步骤

### Requirement: Windows target 常驻 CI 闸门

常规 test 流程 SHALL 包含 Windows target 的 `cargo check`（交叉、不链接），使 Windows 构建
可编译成为每次 push 都被验证的事实；发布流程不再是他唯一能暴露构建断裂的地方。

#### Scenario: 漏门的平台引用当场变红

- **WHEN** 一个 linux-only 模块被无门的代码引用
- **THEN** push 时 Windows target 的 check job 失败，而不是等到下一次打 release tag
