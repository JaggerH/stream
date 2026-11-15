## ADDED Requirements

### Requirement: 设备 hello 声明它实际执行的转发 op

设备 agent 的 hello SHALL 声明设备会话循环实际处理并给回执的全部 op（`http.fetch`、`http.forward`、
`ws.forward`）：服务端按声明派活——`forwardRelay` 先查 `hasOp`，hello 少声明一个转发 op，设备的转发
通道 SHALL 永远不可用（no-relay）。声明与循环处理名单 SHALL 由守卫测试钉成一致。

#### Scenario: 转发 op 已声明
- **WHEN** 一台 Linux 设备 agent 完成 WS 握手，主实例对它发起 `http.forward` / `ws.forward`
- **THEN** 设备按声明受理（不再是 502 no-relay），回环转发可用
