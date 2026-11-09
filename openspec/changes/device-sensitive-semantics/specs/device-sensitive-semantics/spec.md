## ADDED Requirements

### Requirement: 提交类动作缺省要求审批请求

执行端 SHALL 在 gated op（`click`、`invoke`、`setValue`、`type`、`clearInput`、`scroll`，以及
`press` 的 Enter——与 `type` 携带换行同口径）执行前做敏感判定。命中提交类（结构信号或词表）、消息
发送、安装、系统设置更改、呼叫、离开当前 App 的链接，或类目表把该 App 的此类动作标为 ask 时，执行端
SHALL NOT 执行任何设备动作，SHALL 回 `approval-required` 错误，错误 SHALL 附 `semantics`：`op`、
`app`（id、显示名、类目）、`control`（role 与打码、裁剪后的文案）、`reasons`（枚举见 design D2，
开放集合）、`bindingDigest`、`screenDigest`，且 `snapshotRef` 可缺省。词表未识别的提交类候选（可点击
且在表单或确认上下文）SHALL 同样回 `approval-required`，reason 为 `commit-unrecognized`；非搜索输入框
里携带换行的 `type` 与其上的 Enter 在消息 / 社交类 App 判 `message-send`，在其他 App 判
`commit-unrecognized`。`semantics` SHALL NOT 含屏幕原文、控件树或任何凭据值。`press` 的 Back / Home
不做提交判定，但 SHALL NOT 越过 deny 类目的可见性。

#### Scenario: 提交按钮被扣下
- **WHEN** 一次 `click` 的目标是词表命中的「立即支付」按钮
- **THEN** 回复是 `approval-required`，按钮未被点击，`semantics.reasons` 含 `payment-label`，帧里没有屏幕原文

#### Scenario: 词表未识别仍从严
- **WHEN** 一次 `click` 的目标是一个可点击控件，文案不含任何词表词条，但它在表单的确认位置
- **THEN** 回复是 `approval-required`，`semantics.reasons` 含 `commit-unrecognized`

#### Scenario: 非提交动作照常
- **WHEN** 一次 `click` 的目标是一个翻页 tab 或「取消」按钮
- **THEN** 该 op 照常执行，没有审批请求

#### Scenario: 回车发送被扣下
- **WHEN** 消息类 App 里先 `type` 一段不带换行的文字，再 `press` Enter
- **THEN** 回复是 `approval-required`，`semantics.reasons` 含 `message-send`，消息没有发出

#### Scenario: 未入类目 App 的换行提交从严
- **WHEN** 类目未知的 App 里，非搜索输入框收到带换行的 `type`，或其上收到 `press` Enter
- **THEN** 回复是 `approval-required`，`semantics.reasons` 含 `commit-unrecognized`

#### Scenario: 搜索框的回车照常
- **WHEN** `press` Enter 或带换行的 `type` 落在搜索输入框
- **THEN** 该 op 照常执行，没有审批请求

#### Scenario: deny 类目优先于审批
- **WHEN** 一次 `click` 发生在 deny 类目的 App 里
- **THEN** 回复是 `app-denied` 而不是 `approval-required`，动作与读取都没有发生

### Requirement: 批准凭据执行前四查

gated op 的 `args.approval` 为 `{ id, bindingDigest, screenDigest, expiresAt }` 时，执行端 SHALL 在任何
设备动作前依次校验：`expiresAt` 已过 → `approval-expired`；重算 `digest(设备, 会话租约, op, 规范化参数)`
与 `bindingDigest` 不符 → `approval-mismatch`；凭据 id 已消费 → `approval-used`；执行前重读树、重算屏幕
摘要与 `screenDigest` 不符 → `approval-stale`。任一检查失败 SHALL NOT 执行动作，且 SHALL NOT 消费凭据。
通过全部四查后执行动作，并把该凭据 id 标记为已消费。四查 SHALL 先于设备动作、后于 keyguard 检查。

#### Scenario: 换参数作废
- **WHEN** 调用方批准了一次 `click` 后，重发同 op 但改了参数的调用，凭据原样携带
- **THEN** 回复是 `approval-mismatch`，没有点击发生，凭据未被消费

#### Scenario: 一个批准只执行一次
- **WHEN** 同一凭据的调用成功执行后再次原样重发
- **THEN** 回复是 `approval-used`，没有第二次动作

#### Scenario: 过期即无效
- **WHEN** 凭据的 `expiresAt` 已过执行端时钟
- **THEN** 回复是 `approval-expired`，没有动作发生

#### Scenario: 批准后屏幕变了
- **WHEN** 批准期间目标页滚动或跳转，屏幕摘要与凭据携带的 `screenDigest` 不符
- **THEN** 回复是 `approval-stale`，什么都不执行；执行端没有自动重新发起审批请求

#### Scenario: 无关动画不 stale
- **WHEN** 屏幕别处的轮播图滚动，目标区域与结构未变，凭据四查其余各项通过
- **THEN** 动作执行

#### Scenario: 检查失败不消费
- **WHEN** 一次带凭据的调用因 `approval-stale` 被拒
- **THEN** 该凭据 id 不进入已消费集合

### Requirement: 凭据值不出现在任何出站帧

执行端 SHALL 在读取层识别密码字段（密码 state 或密码词命中）与验证码字段（验证码词命中且未被排除项
排除），并 SHALL 在任何出站帧之前把它们的值替换为固定掩码：`find` / `readSubtree` 的文本与标签、截图里
被识别元素的显示区域、`approval-required` 回执里的控件文案。执行端无法保证截图覆盖完整时 SHALL 不回图，
以 `secure-window` 失败。凭据值（密码、验证码原文）SHALL NOT 出现在任何出站帧里。

#### Scenario: 树读取只见掩码
- **WHEN** `readSubtree` 读到一个已输入验证码的输入框
- **THEN** 该元素的文本是掩码，验证码原文不在帧里

#### Scenario: 截图掩不了就不回图
- **WHEN** `screenshot` 的画面含凭据字段但执行端无法定位其显示区域
- **THEN** 回复是 `secure-window` 错误，没有图片出站

#### Scenario: 回执文案也打码
- **WHEN** 一次 `click` 被扣为 `approval-required`，目标文案含验证码样式的数字
- **THEN** `semantics.control.label` 里是掩码后的文本

### Requirement: 凭据字段禁止写入

`setValue`、`type`、`clearInput` 的目标是密码或验证码字段时，执行端 SHALL 以 `credential-field-denied`
失败且不执行写入。此拒绝 SHALL NOT 被任何审批凭据或豁免解除。

#### Scenario: 写密码框被拒
- **WHEN** 一次 `type` 的目标是密码输入框，调用携带了有效凭据
- **THEN** 回复是 `credential-field-denied`，密码框没有变化

#### Scenario: 验证码框不例外
- **WHEN** 一次 `setValue` 的目标是验证码输入框
- **THEN** 回复是 `credential-field-denied`

### Requirement: deny 类目的 App 缺省整体不可见

类目表把 `finance` 与 `passwords` 定为缺省 deny，`blocked` 为用户手动拉黑。对处于 deny 状态的 App：
窗口列表 SHALL 不显示它，`find` / `readSubtree` SHALL 读不到其内容，任何 op SHALL 以 `app-denied` 失败，
其通知 SHALL 不出现。`blocked` 的解除 SHALL 只走名单移除，SHALL NOT 走豁免。`passwords` 类的不可见
SHALL NOT 被任何豁免解除；`finance` 类的不可见 SHALL 只能被调用方下发的任务级可见性豁免解除。

#### Scenario: 资金 App 读不到屏
- **WHEN** 执行端前台是一个 finance 类目的 App，调用方发起 `readSubtree`
- **THEN** 回复是 `app-denied`，帧里没有该 App 的任何内容

#### Scenario: 用户拉黑的 App 打不开
- **WHEN** 一次 `click` 要作用于用户手动拉黑的 App 的窗口
- **THEN** 回复是 `app-denied`

#### Scenario: 拉黑解除不走豁免
- **WHEN** 调用方对一个用户手动拉黑的 App 下发可见性豁免
- **THEN** 下发被拒（`exemption-invalid`），该 App 仍不可见；解除只能由用户在名单里移除

### Requirement: ask 豁免只来自调用方且只解除 ask

执行端的 ask 豁免（App × 动作类目）SHALL 只来自调用方的下发，执行端 SHALL NOT 自带豁免过期、
SHALL NOT 管理豁免的建立与收回：下发即生效，再次下发即替换，连接断开即清空。ask 豁免 SHALL 只解除
被豁免 App × 类目的「要求审批」，SHALL NOT 解除任何 App 的不可见，SHALL NOT 解除凭据字段的拒绝。

#### Scenario: 豁免后同类动作不再问
- **WHEN** 调用方下发了某消息 App 的发送类豁免，之后该 App 里一次发送类动作被判定
- **THEN** 该动作照常执行，没有审批请求；该 App 的其他提交类动作仍要求审批

#### Scenario: ask 豁免解除不了不可见
- **WHEN** 调用方对某 finance 类目的 App 下发了 ask 豁免
- **THEN** 该 App 仍整体不可见，动作仍回 `app-denied`

#### Scenario: 豁免解除不了凭据字段
- **WHEN** 调用方下发了某 App 的豁免，之后一次 `type` 落在该 App 的密码框
- **THEN** 回复仍是 `credential-field-denied`

#### Scenario: 断开即清空
- **WHEN** 执行端与调用方的连接断开后重连，调用方未重新下发豁免
- **THEN** 执行端不再持有任何豁免，提交类动作恢复要求审批

### Requirement: 可见性豁免仅限资金类、仅任务级

调用方 SHALL 能下发资金类（`finance`）App 的可见性豁免，把该 App 从不可见升为可见。其作用域 SHALL
为本任务级，由调用方收回；连接断开即清空。可见性豁免 SHALL NOT 解除该 App 提交类动作的审批要求：
升为可见后，提交类动作仍逐次 `approval-required`。对 `passwords` 类 App、`blocked` App 或凭据字段的
可见性豁免请求 SHALL 被拒（`exemption-invalid`）且不生效。

#### Scenario: 资金 App 豁免后可见但仍逐次审批
- **WHEN** 调用方对某 finance 类 App 下发可见性豁免，之后该 App 里一次提交类动作被判定
- **THEN** 该 App 的屏幕可读，且这次动作回 `approval-required`，未因豁免免批

#### Scenario: passwords 豁免请求被拒
- **WHEN** 调用方对某 passwords 类 App 下发可见性豁免
- **THEN** 下发被拒（`exemption-invalid`），该 App 仍不可见

#### Scenario: 任务结束豁免收回
- **WHEN** 调用方收回可见性豁免（或连接断开）
- **THEN** 该 finance 类 App 恢复不可见

### Requirement: 进程重启换新会话租约，旧凭据一律失配

执行端进程重启后 SHALL 使用新的会话租约标识，SHALL NOT 复用重启前的租约标识。重启前签发的批准凭据
重发时 SHALL 因绑定不符以 `approval-mismatch` 拒绝，SHALL NOT 执行任何设备动作。

#### Scenario: 重启后重放被拒
- **WHEN** 执行端进程重启后，调用方原样重发一条重启前批准的凭据
- **THEN** 回复是 `approval-mismatch`，没有动作发生

### Requirement: 置忙期间执行端拒绝执行类动作

调用方 SHALL 能用控制帧把执行端置忙。置忙期间，除 `status`、`sleep` 与控制帧外的一切 op SHALL 以
`device-busy` 失败且不执行，错误 message SHALL 带调用方给的原因。`busy: false` 或连接断开 SHALL 解除。
执行端 SHALL NOT 自行推断忙的结束时刻。

#### Scenario: 置忙时点击被拒
- **WHEN** 执行端被置忙后收到一次 `click`
- **THEN** 回复是 `device-busy`，没有手势下发

#### Scenario: 置忙时设备仍可观察
- **WHEN** 执行端被置忙后收到 `status`
- **THEN** `status` 照常返回

#### Scenario: 调用方断开即解忙
- **WHEN** 执行端置忙期间与调用方的连接断开
- **THEN** 忙解除，重连后的 op 照常执行

### Requirement: 词表与类目表随 Stream 版本走

提交类、资金、安装、呼叫、设置、密码与验证码词表（11 种 UI 语言）与 App 类目表 SHALL 以数据文件随
Stream 版本发布，SHALL NOT 在运行时热更新。摘自 Pinky（Apache-2.0）的部分 SHALL 在 NOTICE 中保留出处
与许可证。执行端对不认识的 reason SHALL 照常上报（reasons 是开放集合），调用方对不认识的 reason SHALL
按要求审批处理。

#### Scenario: 排除项防误报
- **WHEN** 一次 `click` 的目标文案是「Order history」或「sort by」
- **THEN** 没有审批请求，动作照常

#### Scenario: 长文案不算按钮
- **WHEN** 一次 `click` 的目标是一段以提交动词开头的长文本段落（拉丁文案超过 6 词）
- **THEN** 没有审批请求
