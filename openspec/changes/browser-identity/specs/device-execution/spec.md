## MODIFIED Requirements

### Requirement: facility 默认设备与任务覆盖

用户 SHALL 能为一个 facility 指定默认目标，目标 SHALL 是设备、身份或环境三者之一；用户 SHALL 能在一条定时任务上以其中之一覆盖。
一次执行的目标 SHALL 按「任务的身份 → 任务的环境 → 任务的 `device` → 动作所属包的 facility 默认目标 → `local`」解析，且在执行开始时
解析一次、整次执行内不变。属于某 facility 的 recipe 源 SHALL 按「facility 默认目标 → `local`」解析。身份与环境目标的解析见
`identity-routing`。`command` 类任务设置设备、身份或环境时，系统 SHALL 拒绝该配置。

#### Scenario: 账号绑定后任务自动跟随
- **WHEN** 东方财富的默认设备设为 NAS，一条 `eastmoney:subscribe` 任务没有设置覆盖
- **THEN** 该任务在 NAS 上执行

#### Scenario: 任务覆盖
- **WHEN** 东方财富的默认设备是 NAS，一条 `eastmoney:calendar` 任务设置 `device` 为用户的 PC
- **THEN** 该任务在 PC 上执行，其他东财任务仍在 NAS 上执行

#### Scenario: 任务以身份覆盖设备
- **WHEN** 小红书的默认设备是 PC，一条小红书任务的身份覆盖为个人号A，个人号A 只登在笔记本上
- **THEN** 该任务在笔记本上执行

#### Scenario: 未绑定时行为不变
- **WHEN** 升级后没有任何绑定
- **THEN** 所有任务与采集在 `local` 执行，与升级前一致

#### Scenario: 本地命令不能派到设备
- **WHEN** 用户给一条 `command` 类任务设置设备、身份或环境
- **THEN** 保存被拒绝，并说明本地命令只能在主实例上执行

### Requirement: 整次执行留在同一台设备

一次执行解析出的设备与节点 SHALL 作用于该次执行内的全部出站与浏览器操作：`ctx.fetch`、plain-HTTP / HTML recipe 的请求、
`ctx.cookieFor` / `ctx.cookiesFor`、该次执行中触发的 `ctx.login`，以及浏览器类与桌面类 recipe 的 driver。设备上有多个节点时，
本次执行第一次用到浏览器或登录态时选定的节点 SHALL 在整次执行内不变。运行记录 SHALL 写入设备、节点、profile 名、环境与账号。
没有执行上下文的调用 SHALL 按 `local` 的默认节点处理。

#### Scenario: 中途重登在同一台设备上
- **WHEN** 一条在 NAS 上执行的东财任务发现会话失效并调用 `ctx.login('eastmoney')`
- **THEN** 登录 recipe 在 NAS 的浏览器里执行，随后的请求仍从 NAS 发出

#### Scenario: 中途新开的 profile 不会接走执行
- **WHEN** 一次在 PC 的「工作」节点上进行的采集执行到一半，用户打开了「个人」profile，它的节点连上
- **THEN** 本次执行剩下的浏览器命令与登录态读取仍落在「工作」节点上
