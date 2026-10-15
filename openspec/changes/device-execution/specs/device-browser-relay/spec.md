## ADDED Requirements

### Requirement: 设备上的浏览器经本机 agent 接入

在未运行主实例的设备上，agent SHALL 在本机 `127.0.0.1:8900` 提供扩展所需的连接面：relay WS 升级、挑战应答与
cookie 推送；其他路径 SHALL 返回 404。agent SHALL 持有一份本机 token 并经 native host 交给扩展，扩展与 agent 之间的
信任校验 SHALL 与今天扩展与后端之间的校验一致。扩展 SHALL NOT 需要任何改动或配置远程地址。设备本身运行着主实例时，
agent SHALL NOT 监听该端口。

#### Scenario: PC 上的扩展在主实例远离后仍可用
- **WHEN** 主实例运行在另一台机器，用户 PC 上运行着已配对的 agent 与装了扩展的 Chrome
- **THEN** 扩展连上本机 agent，主实例看到 PC 这台设备有浏览器通道

#### Scenario: 冒充者拿不到 token
- **WHEN** 另一个进程抢占了设备上的 `127.0.0.1:8900`
- **THEN** 扩展的挑战应答失败，扩展不交出 token

### Requirement: 浏览器通道以设备身份复用

agent SHALL 把扩展的 relay 帧封装进它已配对的 `/api/host` 连接，以 `browser` 通道区分；SHALL 在 `hello` 中以 `browser`
声明有浏览器通道，并 SHALL 在扩展断开时通知主实例该通道下线。不带通道标记的帧 SHALL 按现有 op 帧处理。

#### Scenario: 扩展断开时能力随之下线
- **WHEN** NAS 上的 Chrome 退出
- **THEN** 主实例把 NAS 标为无浏览器通道，此后解析到 NAS 的浏览器类 recipe 以 `device-incapable` 失败

### Requirement: 浏览器类 recipe 在执行设备的浏览器上运行

主实例 SHALL 为每台有浏览器通道的设备各维护一条 relay，浏览器类 recipe SHALL 使用执行上下文设备的那一条；会话标签组、
tab 归属与采集窗口的行为 SHALL 与今天在本机时一致。

#### Scenario: 东财登录在 NAS 的 Chrome 里执行
- **WHEN** 一次绑定到 NAS 的执行调用 `ctx.login('eastmoney')`
- **THEN** 登录 recipe 驱动的是 NAS 上的 Chrome，`local` 的 Chrome 没有打开任何标签
