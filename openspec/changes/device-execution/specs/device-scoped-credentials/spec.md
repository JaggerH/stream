## ADDED Requirements

### Requirement: 登录态按（设备，域名）存储

系统 SHALL 为每台设备分别保存登录态快照，快照 SHALL 仍以整份替换方式更新，并 SHALL 以仅属主可读的权限落盘。
`cookieFor(domain)` SHALL 返回当前执行上下文设备的快照中该域的 cookie；某台设备上登录得到的 cookie SHALL NOT
被另一台设备上的执行使用。

#### Scenario: 两台设备各用各的会话
- **WHEN** 东财在 NAS 上登录过，PC 上从未登录过，一条任务覆盖到 PC 执行
- **THEN** 该任务读到的东财登录态为空，并在 PC 上触发登录，NAS 的快照不受影响

### Requirement: 每台设备只被要求交出与它绑定的域

为某台设备刷新登录态时，系统 SHALL 只向该设备的浏览器请求绑定到该设备的 facility 所声明的凭据域；`local` SHALL
请求所有未绑定到其他设备的域。

#### Scenario: NAS 的浏览器不被要求交出无关站点
- **WHEN** 只有东方财富绑定到 NAS，系统为 NAS 刷新登录态
- **THEN** 请求的域只包含东方财富声明的凭据域

### Requirement: 登录刷新的是执行设备的快照

`ctx.login(facility)` SHALL 在执行上下文设备的浏览器中运行该 facility 的登录 recipe，并 SHALL 在成功后强制刷新
该设备的快照。

#### Scenario: 在 NAS 上重登
- **WHEN** NAS 上的执行调用 `ctx.login('eastmoney')` 并成功
- **THEN** NAS 的快照被刷新，`local` 的快照没有变化

### Requirement: 现有登录态迁为 local

升级后首次启动时，系统 SHALL 把已有的单份登录态快照迁为 `local` 设备的快照，内容不变；迁移失败时 SHALL 保留
原文件并告警，SHALL NOT 删除原文件。

#### Scenario: 升级不掉登录
- **WHEN** 用户升级前已有东财登录态，升级后没有任何绑定
- **THEN** 东财任务在 `local` 执行时读到与升级前相同的登录态
