## ADDED Requirements

### Requirement: 设备声明与快照带 op 清单

`devices` 域的上下线事件与在线快照 SHALL 携带设备在 `hello` 里声明的 op 集：online 事件（device 支）与
`online()` 快照的每行设备 SHALL 有可选 `ops?: string[]`，取自该连接的 hello。每次握手成功发出的 online
事件 SHALL 携带当次 hello 的 op 集（重连换了 op 集合，事件就是最新事实）；offline 事件 SHALL NOT 携带
ops。扩展绑定行（binding 支）SHALL NOT 改变。

#### Scenario: 快照给出已声明的 op
- **WHEN** 一台设备完成 WS 握手，hello 声明了若干 op，宿主调用 `online()`
- **THEN** 该设备行带 `ops`，内容与 hello 一致

#### Scenario: 重连换 op 集合后事件带新集合
- **WHEN** 同一设备断开后用声明了不同 op 集合的新 hello 重新握手
- **THEN** 这次握手发出的 online 事件带新的 `ops`

#### Scenario: 离线事件不带 ops
- **WHEN** 一台在线设备断开
- **THEN** offline 事件没有 `ops` 字段
