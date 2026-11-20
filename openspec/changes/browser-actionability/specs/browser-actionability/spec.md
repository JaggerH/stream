# browser-actionability

## ADDED Requirements

### Requirement: 动作前可操作性检查

点击与写入（`click` / `type`，即中继上的 fill 路径）在发出任何 `Input.*` 事件之前 SHALL 依次确认：

1. 选择器命中了元素（存在）；
2. 元素可见——矩形宽高都大于零，且元素及其祖先链上没有 `display:none`、`visibility:hidden|collapse`、`opacity:0`；
3. 元素启用——不匹配 `:disabled`（含 disabled `fieldset` 的后代）、不带 `aria-disabled="true"`；写入还要求目标可编辑；
4. 元素已滚进视口——用 `scrollIntoView` 滚动并等布局稳定，滚动后与视口仍有可见交集；
5. 落点命中测试通过——`document.elementFromPoint` 返回目标本身或其后代（必要时穿透打开的 shadow root）。

任一步不通过 SHALL 返回结构化失败，MUST NOT 发出该动作的输入事件。点击的落点 SHALL 取元素可见部分的中心；显式 `position` 偏移 SHALL 相对元素矩形左上角计算。

#### Scenario: 被横幅遮挡的按钮
- **WHEN** 一个元素被覆盖层挡住，调用方对它 `click`
- **THEN** 返回 `covered` 失败，原因里带遮挡元素的简述，页面没有收到任何鼠标事件

#### Scenario: 禁用 / 隐藏 / 透明按钮
- **WHEN** 目标匹配 `:disabled`、`display:none`、`visibility:hidden`、零尺寸或 `opacity:0`
- **THEN** 分别返回 `disabled` / `not-visible` 失败，一个输入事件都不发

#### Scenario: 视口外的元素会先滚进来
- **WHEN** 目标在视口下方（或上方）但页面可以滚动到它
- **THEN** 先滚动到可见区域再点击，`delivery` 反映页面是否收到可信点击

#### Scenario: 滚动也进不了视口
- **WHEN** 目标固定在视口外（例如 `position:fixed; left:-9999px`），滚动不改变它的位置
- **THEN** 返回 `outside-viewport` 失败，一个输入事件都不发

### Requirement: 稳定失败码与向后兼容的回执

失败 SHALL 带稳定分类码与一句人话原因。分类码至少包括：`not-found`、`not-visible`、`disabled`、`covered`、`detached`、`outside-viewport`；写入另有 `value-mismatch` 与 `not-editable`。

`PageDriver.click` / `type` 的既有布尔返回 SHALL 保留：没命中元素仍是 `false`，且任何前置检查失败都不发输入、也返回 `false`。需要区分原因时 SHALL 使用新增的 `clickReceipt` / `typeReceipt`，返回 `{ok, reason?: {code, reason}, delivery?, point?}`。

`actWithConfirm` SHALL 把详细回执的失败码提升为 `ActResult.status`，并把 `delivery` 原样带出；`not-found` 与既有语义完全一致。

#### Scenario: 旧调用方不受影响
- **WHEN** 一个只读 `click` 布尔值的既有调用方点到被遮挡的元素
- **THEN** 得到 `false`，且页面没有收到输入事件

#### Scenario: 模型面看到失败原因
- **WHEN** 模型通过 `cdp_act` 点击一个被遮挡的元素
- **THEN** 回执 `status` 为 `covered`，`reason` 说明被哪个元素遮挡

### Requirement: 动作后确认

`click` SHALL 在发出输入前于页内安装一次性 `click` 捕获监听，并在点击后短时间轮询是否收到可信 `click` 事件。收到时回执 `delivery: "confirmed"`；没收到时回执 `delivery: "unconfirmed"`，MUST NOT 因此判失败，也 MUST NOT 自动重试。带 `expect` 的调用仍按既有语义轮询预期特征。

`type` SHALL 在写入后回读同一节点的值（`input` / `textarea` 读 `value`，`contenteditable` 读文本），与写入值逐字比较。不一致 SHALL 返回 `value-mismatch`。回读 SHALL 只在页内比较，不把值放进回执或错误文本。

#### Scenario: 页面没收到点击事件
- **WHEN** 鼠标事件已发出，但页面没有产生可信 `click`（例如目标在此期间被移除）
- **THEN** 回执为 `delivery: "unconfirmed"`，动作不判失败

#### Scenario: 写入被页面改写
- **WHEN** 写入后回读值与写入值不一致
- **THEN** 返回 `value-mismatch` 失败

### Requirement: DOM 替换后的重定位

命中测试与发出输入之间，若目标节点被同名节点替换（节点标记不再匹配），动作 SHALL 返回 `detached`，按 locator 重新定位一次并重试；只重试一次，第二次仍 `detached` 就如实返回。

#### Scenario: 列表节点被替换
- **WHEN** 目标在命中测试之后、按下之前被替换成新节点
- **THEN** 第一次尝试报 `detached`，重新定位后对当前节点再试一次；成功则动作照常完成
