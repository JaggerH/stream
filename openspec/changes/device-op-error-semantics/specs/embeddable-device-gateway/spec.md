## ADDED Requirements

### Requirement: 管理口透传设备错误的结构化字段

管理口 `POST /devices/:id/ops` 与 `POST /devices/:id/control` 的设备侧失败（502）SHALL 在 body 里
透传设备错误帧的机器可读字段：`error`（既有的人话消息）之外，设备帧带了 `code` SHALL 带出 `code`，
带了 `semantics` SHALL 原样带出 `semantics`；设备帧没带的字段 SHALL NOT 出现在 body 里。状态码与
既有字段 SHALL 不变（老调用方不受影响）。`semantics` 是设备端 `approval-required` 的结构化回执
（`device-sensitive-semantics`：`op`、`app`、`control`、`reasons`、`bindingDigest`、`screenDigest`、
可选 `snapshotRef`），后端 SHALL 原样转发、不解释、不裁剪。

#### Scenario: approval-required 的回执整链路透传
- **WHEN** 管理口对在线设备发一次 `click`，设备回错误帧
  `{id, error:"approval-required: …", code:"approval-required", semantics:{op,app,control,reasons,bindingDigest,screenDigest}}`
- **THEN** 回 502，body 为 `{error, code, semantics}`，`semantics` 与设备帧逐字段一致

#### Scenario: 其他错误码一并带出
- **WHEN** 设备对一次 op 回 `{id, error:"stale-ref: n3 …", code:"stale-ref"}`
- **THEN** 回 502，body 为 `{error, code}`，没有 `semantics` 字段

#### Scenario: 设备只回 message 时 body 不变
- **WHEN** 设备回 `{id, error:"action-failed: …"}`（无 code、无 semantics）
- **THEN** 回 502，body 恰为 `{error}`，与既有契约一致

#### Scenario: 排队超时与断连不伪造结构化字段
- **WHEN** op 因排队超时或连接断开失败（错误来自后端，不是设备帧）
- **THEN** 回 502，body 只有 `{error}`，没有 `code` 与 `semantics`
