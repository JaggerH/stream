## ADDED Requirements

### Requirement: 扩展与 Stream 实例多对多绑定

扩展 SHALL 持有一组绑定，每条绑定是一个 Stream 实例地址与该实例认可的 token；扩展 SHALL 为每条绑定各自连接。一个 Stream
实例 SHALL 能同时接受多个扩展的连接。本机绑定 SHALL 沿用 native host 取 token、挑战应答通过才连的路径；旧配置 SHALL 在首启迁成
一条本机绑定，行为不变。

#### Scenario: 一个 Chrome 同时服务本机 Stream 与远处的主实例
- **WHEN** 用户 PC 上运行着本机 Stream，扩展另有一条到主实例的配对绑定
- **THEN** 两个实例都看到这个扩展在线，各自能在它上面运行浏览器类 recipe

#### Scenario: 一个主实例连着多台设备上的扩展
- **WHEN** PC 与 NAS 上的 Chrome 各自配对绑定到同一个主实例
- **THEN** 主实例同时持有两条在线的扩展绑定

### Requirement: 配对绑定挂在一台设备上

实例 SHALL 能为一台已配对的设备（或 `local`）签发一次性扩展配对码，有效期与限流 SHALL 与设备配对码一致，签发 SHALL 只对实例本机的
请求开放。扩展用码配对后 SHALL 得到专属 token，实例 SHALL 只保存 token 的哈希，绑定 SHALL 挂在签发时指定的设备上。一台设备 SHALL
能挂多个绑定。设备被撤销时，挂在它上面的绑定 SHALL 一并撤销。扩展 SHALL 只向 `https://` 或回环地址配对。

#### Scenario: NAS 的 Chrome 绑定到主实例
- **WHEN** 用户在主实例上为 NAS 签发扩展配对码，并在 NAS 的 Chrome 里填入主实例地址与该码
- **THEN** 扩展得到 token，主实例的 NAS 设备显示有一条在线的扩展绑定

#### Scenario: 不经 HTTPS 的远程地址不能配对
- **WHEN** 用户在 popup 里填入 `http://203.0.113.5:8900` 与有效配对码
- **THEN** 扩展拒绝配对，配对码没有被发送

### Requirement: 每次连接前先验对端

对每条绑定，扩展 SHALL 在交出 token 前用该绑定的 token 做挑战应答；对端证明不了 SHALL NOT 连接、SHALL NOT 推送 cookie。

#### Scenario: 地址被冒充
- **WHEN** 一条配对绑定的地址被解析到一台不知道该 token 的服务器
- **THEN** 挑战应答失败，扩展不连接、不交出 token

### Requirement: 绑定之间互相隔离

每条绑定 SHALL 有自己的会话标签组与 tab 归属；一张 tab SHALL 至多属于一条绑定。扩展 SHALL 拒绝一条绑定对不属于它的 tab 发出的命令。
cookie 同步 SHALL 按绑定进行：推往该绑定的实例，只含该绑定批准过的域名。配对绑定的实例新要求的域名 SHALL 在用户于扩展中批准后才生效，
包括经 relay 的 cookie 拉取；本机绑定的域名照旧自动生效。

#### Scenario: 一个实例驱动不了另一个实例的 tab
- **WHEN** 主实例对一张属于本机 Stream 标签组的 tab 发出 CDP 命令
- **THEN** 扩展以错误拒绝该命令，tab 不受影响

#### Scenario: 远程实例新要一个域名
- **WHEN** 主实例的同步配置新增 `mail.example.com`
- **THEN** 扩展不推送该域 cookie，popup 把它显示为待批准，用户批准后才推送

### Requirement: 设备的浏览器能力来自挂在它上面的绑定

设备 SHALL 当且仅当至少一条挂在它上面的扩展绑定在线时具备浏览器能力。浏览器类 recipe SHALL 在执行上下文设备上选一条在线绑定：
设备的默认绑定，没有则取最近连上的那条；选中的绑定 SHALL 在本次执行内固定并写入运行记录。会话标签组、tab 归属与采集窗口的
行为 SHALL 与今天在本机时一致。设备上没有绑定 SHALL 以 `device-incapable` 失败；有绑定但都离线 SHALL 以 `device-offline` 失败。

#### Scenario: 东财登录在 NAS 的 Chrome 里执行
- **WHEN** 一次绑定到 NAS 的执行调用 `ctx.login('eastmoney')`
- **THEN** 登录 recipe 驱动的是挂在 NAS 上的那个扩展，`local` 的 Chrome 没有打开任何标签

#### Scenario: NAS 的 Chrome 退出
- **WHEN** NAS 上唯一的扩展绑定断开，随后一条解析到 NAS 的浏览器类 recipe 触发
- **THEN** 该次执行以 `device-offline` 失败，没有发出任何浏览器命令

### Requirement: 撤销绑定

实例 SHALL 能撤销一条扩展绑定；撤销后 SHALL 立即断开它的连接并拒绝它的 token。扩展收到撤销 SHALL 停止重连并在 popup 中标明该绑定已被撤销，
其他绑定 SHALL 不受影响。

#### Scenario: 撤销 NAS 上的绑定
- **WHEN** 用户在主实例上撤销 NAS 的扩展绑定
- **THEN** NAS 的扩展不再重连主实例，它到其他实例的绑定照常工作
