## ADDED Requirements

### Requirement: 设备是执行位置，能力由声明的 op 集决定

系统 SHALL 把每台已配对且在线的 host agent 视为一个执行位置，并 SHALL 把后端本机视为一个始终在线的
设备 `local`。一台设备能执行什么 SHALL 只由它在 `hello` 中声明的 op 集决定，SHALL NOT 按平台分支。
执行需要的能力设备没有声明时，系统 SHALL 在派发前以 `device-incapable` 失败，并 SHALL NOT 向设备发送任何帧。

#### Scenario: 无界面设备不接 UI recipe
- **WHEN** 一条桌面 recipe 的执行解析到一台只声明了 `http.fetch` 的 Linux 设备
- **THEN** 执行以 `device-incapable` 失败，错误说明缺少的能力，设备没有收到任何帧

### Requirement: facility 默认设备与任务覆盖

用户 SHALL 能为一个 facility 指定默认设备，并 SHALL 能在一条定时任务上覆盖设备。一次执行的设备 SHALL 按
「任务的 `device` → 动作所属包的 facility 默认设备 → `local`」解析，且在执行开始时解析一次、整次执行内不变。
属于某 facility 的 recipe 源 SHALL 按「facility 默认设备 → `local`」解析。`command` 类任务设置 `device` 时，
系统 SHALL 拒绝该配置。

#### Scenario: 账号绑定后任务自动跟随
- **WHEN** 东方财富的默认设备设为 NAS，一条 `eastmoney:subscribe` 任务没有设置 `device`
- **THEN** 该任务在 NAS 上执行

#### Scenario: 任务覆盖
- **WHEN** 东方财富的默认设备是 NAS，一条 `eastmoney:calendar` 任务设置 `device` 为用户的 PC
- **THEN** 该任务在 PC 上执行，其他东财任务仍在 NAS 上执行

#### Scenario: 未绑定时行为不变
- **WHEN** 升级后没有任何绑定
- **THEN** 所有任务与采集在 `local` 执行，与升级前一致

#### Scenario: 本地命令不能派到设备
- **WHEN** 用户给一条 `command` 类任务设置 `device`
- **THEN** 保存被拒绝，并说明本地命令只能在主实例上执行

### Requirement: 整次执行留在同一台设备

一次执行解析出的设备 SHALL 作用于该次执行内的全部出站与浏览器操作：`ctx.fetch`、plain-HTTP / HTML recipe 的
请求、`ctx.cookieFor` / `ctx.cookiesFor`、该次执行中触发的 `ctx.login`，以及浏览器类与桌面类 recipe 的 driver。
没有执行上下文的调用 SHALL 按 `local` 处理。

#### Scenario: 中途重登在同一台设备上
- **WHEN** 一条在 NAS 上执行的东财任务发现会话失效并调用 `ctx.login('eastmoney')`
- **THEN** 登录 recipe 在 NAS 的浏览器里执行，随后的请求仍从 NAS 发出

### Requirement: 绝不回落到 local

解析到非 `local` 设备的执行 SHALL NOT 在任何失败情形下改为在 `local` 上执行或发出请求。

#### Scenario: 设备离线时零请求经主实例发出
- **WHEN** 东财的默认设备是 NAS，NAS 不在线，定时任务触发 `eastmoney:repo`
- **THEN** 执行以 `device-offline` 失败，且主实例没有向 `eastmoneysec.com` 发出任何请求

### Requirement: 离线与断连分开报告

派发前设备不在线 SHALL 以 `device-offline` 失败，且 SHALL 按任务的 `maxAttempts` 重试。执行中途设备断连或设备
请求超时 SHALL 以 `device-lost` 失败，SHALL NOT 自动重试，SHALL 发出一条通知，并在运行记录中标记结果状态未知。
每条运行记录 SHALL 包含执行所在的 `deviceId`。

#### Scenario: 中途断连不重跑
- **WHEN** 一次申购动作已提交部分委托后 NAS 断连，任务 `maxAttempts` 为 3
- **THEN** 该次执行以 `device-lost` 结束，不再重试，用户收到通知，运行记录显示「状态未知」与设备 NAS

#### Scenario: 运行记录带设备
- **WHEN** 一次东财日历任务在 NAS 上执行完毕
- **THEN** 运行记录里能看到执行设备为 NAS
