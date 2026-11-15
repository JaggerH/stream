## ADDED Requirements

### Requirement: 管理口对设备发控制帧

网关 SHALL 提供 `POST /devices/:id/control`（随 `basePath` 组合，管理类端点，经宿主注入的 `isAdmin`
判定，false 回 403）。body SHALL 是一条控制帧 `{"type":"control","control":"setBusy"|"exemptions",...}`：
只认这两种 `control`，其余 SHALL 回 400；帧格式 SHALL 按 `device-sensitive-semantics` 定死的格式校验
（`setBusy` 的 `busy` SHALL 是布尔、`reason` 可选字符串；`exemptions` 的 `ask` 项 `action` SHALL 只收
`commit|send|install|setting|call|link`，`financeVisible` SHALL 是字符串数组）。设备不在线 SHALL 回
404 `{error:"device-offline"}`。发送 SHALL 走带外通道：不等会话租约、不占单发 op 尾锁。设备回执
`{id,result}` SHALL 转成 200 `{result}`，`{id,error}` SHALL 转成 502 `{error}`。

#### Scenario: 置忙帧整链路
- **WHEN** 管理面对一台在线设备发 `{"type":"control","control":"setBusy","busy":true,"reason":"等待审批"}`
- **THEN** 设备收到带后端分配 id 的控制帧，回执 `{id,result}` 转成 200 `{result}`

#### Scenario: 不认识的 control 与格式不合法的帧
- **WHEN** body 的 `control` 不是 `setBusy`/`exemptions`，或 `setBusy` 缺 `busy`、`ask` 项 `action` 不在集合里
- **THEN** 回 400，设备上没有任何帧发出

#### Scenario: 设备不在线
- **WHEN** 管理面对一台不在线的设备发控制帧
- **THEN** 回 404 `{error:"device-offline"}`，设备上没有任何帧发出

#### Scenario: 非管理调用方
- **WHEN** `isAdmin` 对一个 `/devices/:id/control` 请求返回 false
- **THEN** 回 403，设备上没有任何帧发出
