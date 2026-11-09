## ADDED Requirements

### Requirement: 敏感闸先于任何设备动作

每个 op 在既有的 keyguard 检查之后、任何手势或无障碍动作之前，SHALL 依次执行 busy 检查与敏感闸
（由 `device-sensitive-semantics` 能力定义）。busy 或敏感闸命中时，op SHALL 以对应错误码失败，
SHALL NOT 执行任何设备动作；既有的 `stale-ref`、abort 与错误码语义不变。

#### Scenario: 锁屏优先于置忙
- **WHEN** 执行端被置忙且安全锁屏亮起时收到一次 `click`
- **THEN** 回复是 `device-locked`（keyguard 检查在最前），busy 检查未到

#### Scenario: 闸命中不动作
- **WHEN** 一次 `click` 的目标是词表命中的提交按钮
- **THEN** 回复是 `approval-required` 并附 semantics，按钮未被点击
