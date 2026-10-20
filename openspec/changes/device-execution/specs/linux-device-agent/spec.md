## ADDED Requirements

### Requirement: Linux 无界面 agent

host agent SHALL 提供 Linux 构建，以 `linux` 平台连接 `/api/host`，并 SHALL 只声明它实际具备的 op：`http.fetch`。
浏览器 SHALL NOT 经 agent 接入（见 `device-browser-relay`）。它 SHALL 复用现有的协议与 WS 客户端实现，SHALL NOT 另起一套协议实现。主实例 SHALL 接受
`linux` 平台的 `hello`。

#### Scenario: NAS 连上后出现在设备列表
- **WHEN** NAS 上的 agent 以 `linux` 平台完成握手
- **THEN** 设备列表显示该设备在线，平台为 linux，能力包含 `http.fetch`

### Requirement: 配对携带平台并可无人值守完成

配对请求 SHALL 携带平台，返回的设备 id SHALL 为 `<platform>:<uuid>`。agent SHALL 能在首次启动时从环境变量读取主实例地址与
一次性配对码完成配对，并 SHALL 把 device token 持久化到自己的数据卷；之后启动 SHALL NOT 再需要配对码。配对码仍 SHALL 只对
主实例本机的请求签发。

#### Scenario: 容器重启不需要重新配对
- **WHEN** NAS 首次以有效配对码启动并配对成功，之后容器重启且环境变量里的配对码已过期
- **THEN** agent 用已保存的 device token 重新连上，设备 id 不变
