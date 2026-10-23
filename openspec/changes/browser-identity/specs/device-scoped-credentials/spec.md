## MODIFIED Requirements

### Requirement: 登录态按（设备，域名）存储

系统 SHALL 为每个节点分别保存登录态快照，快照 SHALL 仍以整份替换方式更新，并 SHALL 以仅属主可读的权限落盘。
`cookieFor(domain)` SHALL 返回当前执行上下文选定节点的快照中该域的 cookie；某个节点上的 cookie SHALL NOT 被另一个节点上的执行
使用，同一台设备上的不同节点也不例外。不带 `nodeId` 的老扩展 SHALL 沿用按设备的快照。

#### Scenario: 两台设备各用各的会话
- **WHEN** 东财在 NAS 上登录过，PC 上从未登录过，一条任务覆盖到 PC 执行
- **THEN** 该任务读到的东财登录态为空，并在 PC 上触发登录，NAS 的快照不受影响

#### Scenario: 同一台电脑的两个 profile 不互相覆盖
- **WHEN** PC 的「工作」与「个人」两个节点都登着小红书、账号不同，两边先后被拉取登录态
- **THEN** 两份快照各自独立；一条以个人号A 为目标的纯 HTTP 采集读到的是「个人」节点的 cookie

### Requirement: 每台设备只被要求交出与它绑定的域

为某个节点刷新登录态时，系统 SHALL 只向该节点请求解析到它的 facility 所声明的凭据域：以设备为目标、目标是该节点所在设备的
facility，以及以身份或环境为目标、能解析到该节点的 facility。`local` 设备上的节点 SHALL 另外请求所有未绑定到其他目标的域。

#### Scenario: NAS 的浏览器不被要求交出无关站点
- **WHEN** 只有东方财富绑定到 NAS，系统为 NAS 上的节点刷新登录态
- **THEN** 请求的域只包含东方财富声明的凭据域

### Requirement: 登录刷新的是执行设备的快照

`ctx.login(facility)` SHALL 在执行上下文选定节点的浏览器中运行该 facility 的登录 recipe，并 SHALL 在成功后强制刷新该节点的快照，
随后 SHALL 重新探测该节点上该 facility 的身份。

#### Scenario: 在 NAS 上重登
- **WHEN** NAS 上的执行调用 `ctx.login('eastmoney')` 并成功
- **THEN** NAS 上那个节点的快照被刷新，`local` 与其他节点的快照没有变化
