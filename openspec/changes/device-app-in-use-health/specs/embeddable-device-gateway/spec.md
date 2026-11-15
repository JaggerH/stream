## ADDED Requirements

### Requirement: 管理 502 与设备列表带出占用回执与健康事实

`POST /devices/:id/ops` 与 `POST /devices/:id/control` 的设备侧失败（502）按 `device-op-error-semantics`
的既有机制透传 `code` 与 `semantics`；`semantics` 的合法形状随之有两种：审批回执（`approval-required`，
`device-sensitive-semantics`）与占用回执（`app-in-use`：`{op, app: {id, name}}`）。后端 SHALL 原样转发、
不解释、不裁剪。`GET /api/devices` 的行在携带 `state` 时 SHALL 随其携带 `health`（设备上报的
`networkOk` / `clockSkewMs`，设备没报的字段不出现）。

#### Scenario: app-in-use 的回执经管理口带出

- **WHEN** 管理口对在线设备发一次 `focusApp`，设备回错误帧
  `{id, error: "app-in-use: …", code: "app-in-use", semantics: {op: "focusApp", app: {id, name}}}`
- **THEN** 回 502，body 为 `{error, code, semantics}`，`semantics` 与设备帧逐字段一致

#### Scenario: 设备列表带出 health

- **WHEN** 一台在线手机最近一条 `state` 帧带有 `health: {networkOk: false, clockSkewMs: -12493763}`
- **THEN** `GET /api/devices` 该行的 `state.health` 与之逐字段一致
