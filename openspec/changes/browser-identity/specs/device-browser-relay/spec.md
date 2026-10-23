## MODIFIED Requirements

### Requirement: 设备的浏览器能力来自挂在它上面的绑定

设备 SHALL 当且仅当至少一个在它上面的节点在线时具备浏览器能力；本机设备上的每个节点各有一条绑定，配对绑定各属于一个节点。
浏览器类 recipe SHALL 在执行上下文设备上选一个在线节点：目标为身份或环境时按 `identity-routing` 选；目标为设备时选设备的默认节点，
没有则取最近连上的那个。选中的节点及其绑定 SHALL 在本次执行内固定并写入运行记录。会话标签组、tab 归属与采集窗口的行为
SHALL 与今天在本机时一致。设备上没有节点 SHALL 以 `device-incapable` 失败；有节点但都离线 SHALL 以 `device-offline` 失败。

#### Scenario: 东财登录在 NAS 的 Chrome 里执行
- **WHEN** 一次绑定到 NAS 的执行调用 `ctx.login('eastmoney')`
- **THEN** 登录 recipe 驱动的是 NAS 上的那个节点，`local` 的 Chrome 没有打开任何标签

#### Scenario: NAS 的 Chrome 退出
- **WHEN** NAS 上唯一的节点断开，随后一条解析到 NAS 的浏览器类 recipe 触发
- **THEN** 该次执行以 `device-offline` 失败，没有发出任何浏览器命令

#### Scenario: 本机默认节点
- **WHEN** 本机有「工作」「个人」两个节点在线，「工作」被设为默认，一条以本机设备为目标的浏览器类 recipe 触发
- **THEN** 该 recipe 在「工作」节点上执行
