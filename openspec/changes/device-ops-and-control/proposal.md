# device-ops-and-control

## Why

`hello` 里设备已经声明了自己实现的 op 集，但面向嵌入方的设备快照（`devices.online()`）与上下线事件
（`devices.onChange`）不带出来：嵌入方看不到一台在线的设备会什么，也就无法在派活前判断「这台设备做不
做得了这件事」，桌面能力探测也因此只能逐个 op 试错。

同时，设备端已经实现了两种带外控制帧（`setBusy` 置忙、`exemptions` 豁免下发，见 `device-sensitive-semantics`），
但后端只有 recipe 执行链路在发：管理面（`isAdmin` 保护的那组设备管理端口）没有一条 HTTP 路由能把控制帧
送到设备上。审批类调用方需要在「等待用户批准」期间把设备置忙、按任务下发豁免——这在嵌入方的管理面上
是常规操作，今天只能自己绕。

## What Changes

- **设备上下线事件与在线快照带 op 清单。** `DeviceChange` 的 device 一支与 `DeviceSnapshot.devices` 的
  每行增加可选 `ops?: string[]`，取自该连接 `hello` 里声明的 op 集；每次握手成功发出的
  online 事件携带当次 hello 的 ops（重连换了 op 集合，事件就是最新事实），offline 事件不带。绑定行不变。
- **网关管理口新增 `POST /devices/:id/control`。** body 就是一条控制帧
  `{"type":"control","control":"setBusy"|"exemptions",...}`，只认这两种 `control`；鉴权与现有管理口
  一致（`isAdmin`）；设备不在线回 404 `{error:"device-offline"}`；帧格式按 `device-sensitive-semantics`
  定死的格式校验（`busy` 必须是布尔；`reason` 可选字符串；`ask` 项的 `action` 只收
  `commit|send|install|setting|call|link`）。发送走带外通道（不等会话租约、不占单发尾锁——控制帧正是
  要在 recipe 占着设备时发的那一帧），设备回执 `{id,result}` / `{id,error}` 原样转成 200 / 502。
- **设备 agent 的 hello 声明它实际执行的转发 op。** Linux 设备 agent 的 `DEVICE_OPS` 目前只有
  `http.fetch`，而 `forward.rs` / `main.rs` 已经在执行 `http.forward` / `ws.forward`——服务端
  `forwardRelay` 先查 `hasOp`，没声明就是 502 no-relay，设备转发恒不可用。把两个转发 op 加进声明；
  hello 的声明与会话循环实际处理的名单由守卫测试钉成一致。
- **设备 agent 对状态目录单实例。** 同一状态目录起两个 agent 会用同一个 token 互相挤掉连接、反复
  断连。进入设备模式前对状态目录加 flock（非阻塞）：拿不到锁打一行清楚的日志退出（非零码）；
  锁随进程退出由内核释放，不落要清理的文件。

## Capabilities

### Modified Capabilities

- `embeddable-engine`：`devices` 域的上下线事件与在线快照载荷增加 `ops` 字段（ADDED Requirement）。
- `embeddable-device-gateway`：管理类 HTTP 端口新增对设备发控制帧的一条（ADDED Requirement）。
- `device-loopback-forward`：设备 hello 声明它实际执行的转发 op（ADDED Requirement）。
- `device-execution`：设备 agent 对状态目录单实例（ADDED Requirement）。

## Dependencies

- 依赖 `device-sensitive-semantics` 已定死的控制帧格式（置忙与豁免下发）与 Android 端解析（`Frames.control`）。
- 依赖 `embeddable-device-gateway` 已落地的网关与 `isAdmin` 口径、`hello` op 声明。

## Non-Goals

- 不改变控制帧的设备端语义（何时置忙、豁免如何被校验）——那属于 `device-sensitive-semantics`。
- 不给 `GET /api/devices`（面板列设备）加 ops——面板场景用不到，管理面快照走嵌入方口径。
- 不做豁免的任何服务端记账：豁免集合的真相源在设备上，连接断开即清空。
