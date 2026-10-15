## ADDED Requirements

### Requirement: Linux 无界面 agent

host agent SHALL 提供 Linux 构建，以 `linux` 平台连接 `/api/host`，并 SHALL 只声明它实际具备的 op：`http.fetch`，以及
扩展在线时的 `browser`。它 SHALL 复用现有的协议与 WS 客户端实现，SHALL NOT 另起一套协议实现。主实例 SHALL 接受
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

### Requirement: 一个镜像提供执行端所需的全部组件

系统 SHALL 发布一个 x86_64 与 aarch64 的容器镜像，内含 agent、Chromium（虚拟显示）、预装的 Stream 扩展与 native host 清单，
以及用于人工介入的 noVNC。该镜像 SHALL NOT 要求设备开放入站端口；noVNC SHALL 默认只绑定本机或由用户显式映射。

#### Scenario: 在群晖上部署执行端
- **WHEN** 用户在群晖 Container Manager 中用该镜像、主实例地址与配对码启动容器
- **THEN** 主实例的设备列表出现这台 NAS，并同时具备 `http.fetch` 与 `browser` 能力
