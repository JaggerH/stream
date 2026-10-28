## ADDED Requirements

### Requirement: 秘密来源可注入，缺省关闭

系统 SHALL 允许嵌入方（`createStream` / `createRuntime` 的选项）注入一个 `SecretSource`。未注入时，`cdp_act` 的
`kind:'login'` SHALL 以 `secret-source-missing` 拒绝，且系统其余行为 SHALL 与本 change 引入前一致。

#### Scenario: 没有来源
- **WHEN** 未注入 `SecretSource`，调用 `cdp_act({kind:'login', secret:'site-a', ...})`
- **THEN** 返回 `secret-source-missing`，页面上没有任何输入发生

### Requirement: 登录前核对 origin

系统 SHALL 在填写任何字段之前，经 CDP 读取目标标签顶层 frame 的 URL 得到 origin，并与来源给出的 `origins` 精确比对；
不一致 SHALL 以 `origin-mismatch` 拒绝且不填写任何字段。登录表单位于 iframe 时 SHALL 以 `login-in-iframe-unsupported` 拒绝。

#### Scenario: 页面换了站
- **WHEN** 秘密 `site-a` 绑定 `https://a.example`，而目标标签当前在 `https://evil.example`
- **THEN** 返回 `origin-mismatch`，两个输入框都保持原样

### Requirement: 原子地填写、提交、离开或清空

系统 SHALL 在一次 `kind:'login'` 调用内完成：可信输入各字段 → 提交（`submitSelector` 或 Enter）→ 在 `waitMs` 内等待
主 frame 导航；未导航 SHALL 清空所有填过的字段。结果 SHALL 只含 `status`、`origin`、`filled`（字段名）、`navigated`、`cleared`。

#### Scenario: 登录成功跳转
- **WHEN** 提交后页面在 15 s 内导航到新地址
- **THEN** 返回 `navigated:true`，结果中没有用户名、密码或一次性码

#### Scenario: 密码错误不跳转
- **WHEN** 提交后页面停在原地
- **THEN** 填过的字段被清空，返回 `navigated:false, cleared:true`

### Requirement: 登录动作期间拒绝读取

从登录动作开始到导航完成或字段清空，系统 SHALL 立即拒绝同一标签上的 `cdp_look`、`cdp_shot` 以及 `cdp_act` 的读取与
输入类动作，错误码 `secret-fill-in-progress`。清空失败时，`chrome:<tabId>` 目标 SHALL 被关闭；无法关闭时锁 SHALL 一直保持。

#### Scenario: 并发读取被拒
- **WHEN** 登录动作进行中，另一个调用对同一标签执行 `cdp_look({js:'document.querySelector("input[type=password]").value'})`
- **THEN** 该调用立即返回 `secret-fill-in-progress`，没有读到任何值

### Requirement: 秘密值不出现在任何记录中

秘密值 SHALL NOT 出现在日志、debug bus、中继慢命令账本、运行记录、错误信息与工具结果中。承载秘密的 CDP 命令在中继侧 SHALL 只记录命令名与耗时。

#### Scenario: 特征串审计
- **WHEN** 以特征串作密码完成一次登录动作（成功与失败各一次）
- **THEN** 在全部日志、debug bus 条目、运行记录与 MCP 结果中搜索该特征串，命中为 0

### Requirement: 固定按高危处理

`kind:'login'` SHALL 固定归类为 `intent:'credential'` 的高危动作：交互通道在未带 `confirmed:true` 时 SHALL 返回 `needs-confirmation`。

#### Scenario: 未确认
- **WHEN** 交互通道调用 `cdp_act({kind:'login', ...})` 未带 `confirmed`
- **THEN** 返回 `needs-confirmation`，不取秘密、不填写
