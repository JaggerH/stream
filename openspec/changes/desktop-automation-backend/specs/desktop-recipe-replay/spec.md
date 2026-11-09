## ADDED Requirements

### Requirement: 打字优先语义设值

桌面 recipe 的文字输入 SHALL 优先用 `setValue`（元素级投递、不需要前台）；键盘 `type` SHALL
仅在用户在场、或 recipe 显式同意抢屏（如带人工确认的交互步骤）时使用。坐标级打字的既有
语义（前台闸门、打字中途前台丢失的分辨）MUST NOT 改变。清空输入框的语义路是 `setValue`
空串；键盘 `clearInput` 保留为既有路径。

理由：Windows 上 `type` 只有物理键盘路，投给「此刻的焦点窗口」——后台采集场景它必然抢屏
或失败；`setValue` 的收件人是元素本身，与 `invoke` 同类，锁屏照常生效。

#### Scenario: 后台采集的表单填写不碰前台

- **WHEN** 定时任务在用户不在场时向桌面应用的输入框写入文本
- **THEN** recipe 以 `setValue` 完成，全程不改变前台；需要键盘的步骤（如触发应用自己的
  补全）显式声明抢屏并过前台闸门

#### Scenario: 语义清空草稿

- **WHEN** recipe 需要在写入新内容前清掉输入框残留
- **THEN** 它对该元素 `setValue` 空串（元素级、不抢前台），而不是走键盘组合键

### Requirement: 投递未知的动作不自动重试

桌面失败分类 SHALL 新增 `delivery-unknown` 档：动作的投递状态不明（执行进程超时 / 中途失败 /
回执解析不了），输入**可能已经落在应用上**。重放引擎对它 SHALL 停步如实上报（与
`foreground-lost-midway` 同一条处置纪律：先看目标应用的实际状态，别直接重发），MUST NOT 自动
重试该步、MUST NOT 换落地方式重执行、MUST NOT 在设值失败时退回键盘重打——三者都是把同一个
可能已生效的动作再做一遍。它与 `foreground-lost`（输入确定没发出，直接重试）MUST 分为两档。

#### Scenario: 动作进程超时后引擎停步

- **WHEN** host agent 对一个动作 op 回 `delivery-unknown`，而该步骤声明了 `else:'retry'`
  或还有其它落地方式候选
- **THEN** runner 以 drift 结束该趟并如实转述原因，该动作恰好执行了一次（零重发、零换候选）

#### Scenario: 设值投递未知时不退键盘

- **WHEN** `setValue` 的投递状态不明，而 runner 的既有策略是「Value pattern 不成就退回键盘」
- **THEN** 键盘退路不执行（退路只属于「确定没写进」的失败），整步以 delivery-unknown 上报
