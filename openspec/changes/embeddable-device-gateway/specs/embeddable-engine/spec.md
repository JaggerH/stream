## ADDED Requirements

### Requirement: 设备上下线事件

实例句柄的 `devices` 域 SHALL 提供 `onChange(listener)`：设备（宿主中继）或扩展绑定连上、断开时以
`{ kind, ...标识, online, at }` 通知监听者。同一设备的新连接顶掉旧连接时 SHALL 只发一次 online，不发
中间的 offline；心跳判死走连接关闭路径，SHALL 自然发 offline。监听器抛错 SHALL 只记日志，不影响连接。
返回的退订函数 SHALL 停止通知。

#### Scenario: 设备连上再断开
- **WHEN** 一台设备完成 WS 握手，随后连接关闭
- **THEN** 监听者先收到 `online:true` 再收到 `online:false`，各一次，载荷带设备 id、名称与平台

#### Scenario: 新连接顶掉旧连接
- **WHEN** 同一设备在旧连接还活着时用新连接握手，随后旧连接关闭
- **THEN** 监听者只收到一次 `online:true`，不收到 offline

### Requirement: 在线快照

`devices` 域 SHALL 提供 `online()`：返回当前在线的设备（id、名称、平台）与扩展绑定（绑定 id、设备 id、
节点 id），供宿主启动时先读一次再订阅。

#### Scenario: 启动时已有在线设备
- **WHEN** 实例上已有连着的设备与绑定，宿主调用 `online()`
- **THEN** 快照与注册表现状一致，且与后续事件流衔接后无缺漏
