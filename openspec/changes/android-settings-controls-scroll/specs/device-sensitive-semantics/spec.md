## ADDED Requirements

### Requirement: settings 类目里的步进按钮与滑杆判 `setting`

在 `settings` 类目（`apps.json` 的 `settings`）里，gated op 的目标满足以下任一条时，执行端 SHALL 把
`setting` 加入 `semantics.reasons`，并按既有 ask 闸要求审批（`approval-required`，动作不执行）：

- 可点击控件的名字（文本或 contentDescription）以 `increase` / `decrease` 开头，或中文去
  标点数字后的核心以 `增大` / `减小` / `加` / `减` 开头（步进按钮）；
- 可点击控件的名字是 `＋` / `－` / `+` / `-` / `−`，且与树中一个滑杆（`role` 或 `className` 含
  `Seek` / `Slider` 的非滚动控件）同一行（垂直重叠至少较小高度的一半）且水平间隙不超过
  `ICON_GAP_PX`（160 px）；
- 目标是滑杆本身（点击轨道、`invoke` 上的滚动动作）；
- op 是 `setValue` 且目标是滑杆；
- op 是 `scroll` 且树中存在可滚动的滑杆（`isScrollable` 的滑杆节点）。

词表（`stepperWords` / `cjkStepperPrefixes`）随 Stream 版本走。本规则 SHALL NOT 作用于非 `settings`
类目：购物 App 的数量 ± 按钮、音量滑杆等不因此要求审批；提交 / 付款另按既有判定。

#### Scenario: 步进按钮被扣下
- **WHEN** 设置页上 `invoke` 了名为「Decrease font size」的按钮
- **THEN** 回复是 `approval-required`，`semantics.reasons` 含 `setting`，按钮未被点击

#### Scenario: ＋ / － 图标按钮被扣下
- **WHEN** 设置页上 `invoke` 了滑杆旁名为「＋」的按钮
- **THEN** 回复是 `approval-required`，`semantics.reasons` 含 `setting`

#### Scenario: 点击滑杆轨道被扣下
- **WHEN** 设置页上一次 `click` 的落点是滑杆，或 `invoke` 一个滑杆 ref，或 `setValue` 一个滑杆 ref
- **THEN** 回复是 `approval-required`，`semantics.reasons` 含 `setting`，动作未执行

#### Scenario: 非设置类目的数量步进照常
- **WHEN** 购物 App 的数量「－ 1 ＋」按钮被 `invoke`，树里没有滑杆
- **THEN** 该 op 照常执行，没有 `setting` 理由

#### Scenario: 普通页面滚动不受影响
- **WHEN** 设置类目页面里没有可滚动的滑杆，调用方发 `scroll`
- **THEN** 滚动照常执行，没有 `setting` 理由
