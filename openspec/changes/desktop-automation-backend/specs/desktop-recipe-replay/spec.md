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
