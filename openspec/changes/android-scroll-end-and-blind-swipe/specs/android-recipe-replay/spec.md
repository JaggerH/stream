## ADDED Requirements

### Requirement: 滚动回执说清是否到头与为什么没动

`scroll`（带或不带 `until`）的回执 SHALL 在列表自身内容一步都没移动时显式带 `moved: false`，
并在能给出证据时带 `end: true` 与 `reason`（能力 `ui.tree` v8）。`reason` 的取值：

- `container-at-end`：候选容器已不再声明该方向的动作（`ACTION_SCROLL_DOWN` / `PAGE_DOWN` /
  `ACTION_SCROLL_FORWARD` 或其反向动作不在），配 `end: true`；
- `gesture-no-effect`：容器接受了无障碍动作却一步没动，随后在容器区域下发的回退手势也没让整段内容
  指纹变化，配 `end: true`；
- `no-container`：窗口里没有可滚动容器、回退手势也没让内容变化。此时 SHALL NOT 报 `end`
  （「没动」不足以证明到头）。

带 `until` 时，某一步骤的回执带 `end: true` SHALL 让搜索立即以 `stopped: "end"` 收尾；
「连续两步内容不变」保留为步骤判不了时的兜底，兜底收尾时同样带 `end: true`（两条相同的读就是既有的
到头判据）。以 `stopped: "end"` 收尾的回执 SHALL 带 `end: true`，且一步都没移动时带 `moved: false`
与该步骤的 `reason`。`maxSteps` / `timeoutMs` / 整次 10 s 上限与 `timing` 的字段集合 SHALL NOT
因本变更改变；新字段全部可选，向后兼容。

#### Scenario: 已到底仍接受滚动动作
- **WHEN** 列表已到底、外层容器仍接受 `ACTION_SCROLL_FORWARD` 却一步没动，调用方发
  `scroll {dir: "down", until: "关于手机"}`
- **THEN** 搜索只跑一步即停，回执带 `found: false`、`stopped: "end"`、`end: true`、
  `moved: false`、`reason: "container-at-end"`
- **AND** 不向设备下发回退手势

#### Scenario: 接受了但没动，手势也没让屏幕变化
- **WHEN** 页面上有可滚动容器，它的滚动动作返回 true 但内容不变，回退手势之后内容指纹仍不变
- **THEN** 回执带 `method: "gesture"`、`moved: false`、`end: true`、
  `reason: "gesture-no-effect"`

#### Scenario: 没有可滚动容器时不说「到头」
- **WHEN** 窗口里没有可滚动节点，回退手势之后内容也不变
- **THEN** 回执带 `moved: false`、`reason: "no-container"`，且不带 `end`

#### Scenario: 还在滚的页面回执不变
- **WHEN** 列表每步都在移动，调用方发 `scroll {dir: "down", amount: 3}`
- **THEN** 回执的 `method` / `steps` / `via` 与 `timing` 字段集合和之前相同
- **AND** 不出现 `moved: false` 或 `end`
