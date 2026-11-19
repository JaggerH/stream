## ADDED Requirements

### Requirement: find 的滑杆读值带档数与控件自述值

`find`（`ui.tree` v6）元素的 `range` SHALL 继续原样报 `RangeInfo` 的 `{type, now, min, max}`
（`now` 即 `RangeInfo.current`，不做单位换算）。当 `type == "int"` 且 `min` / `max` 有限时，`range`
SHALL 另带 `stepCount = max − min + 1`（区间档数）；`float` / `percent` / `indeterminate` SHALL NOT 带。

元素自身与它的行 `values` 条目 SHALL 带可选 `valueText`：节点的 `stateDescription` 非空时用它，否则用
节点的 `text`；两者都没有时不带。`valueText` 是控件自己说的值（Android 16 设置的滑杆把
「Default / Large」放在 `stateDescription`），供调用方按行标题挑滑杆、读它当前说自己是哪档。只有
带值的控件（`checked` / `range` / `stateDescription` 至少有一个）SHALL 带 `valueText`，普通标签不带。

#### Scenario: 整数滑杆带档数
- **WHEN** 一个 `type: "int"`、`now: 0`、`min: 0`、`max: 3` 的滑杆出现在 `find` 结果中
- **THEN** 它的 `range` 带 `stepCount: 4`，其余字段原样不变

#### Scenario: 浮点与百分比不造档数
- **WHEN** 滑杆的 `range.type` 是 `float` 或 `percent`
- **THEN** `range` 不带 `stepCount`，`now` / `min` / `max` 原样报出

#### Scenario: 控件自述值
- **WHEN** 滑杆节点的 `stateDescription` 是「Default」（或没有 stateDescription 但有文本）
- **THEN** 元素与行 `values` 带 `valueText: "Default"`（或该文本）

### Requirement: 折叠工具栏上判步以列表自身移动为准

`scroll` 在 `CollapsingToolbarLayout` + `AppBarLayout` + `RecyclerView` 这类结构上 SHALL 把「容器首
可见项相对其滚动容器（列表）的位置变化」作为列表移动的判据；容器整体上移（AppBar 折叠）SHALL NOT
算作列表移动。只有布局移动、列表内容未滚动的一步 SHALL NOT 计入回执的 `steps`，执行端 SHALL 对同一
容器继续发下一个滚动动作（次数有上限）；列表真正滚动时才计步。既有约束 SHALL 保持不变：单步等待上限
800 ms、整次 `scroll` 总上限 10 s 与 `stopped: "time"`、回执的 `timing`
`{a11yMs, gestureMs, settleMs, checkMs, steps}`、`until` 的 `maxSteps` / `timeoutMs` 语义。

#### Scenario: 折叠不算一步
- **WHEN** 在折叠工具栏页面上发 `scroll {dir: "down", amount: 1}`，第一步只让 AppBar 折叠、列表内容未滚
- **THEN** 回执的 `steps` 是列表真实滚动的步数，`method` 是 `a11y`，且 `scrollNode` 只落在列表上

#### Scenario: until 不被折叠带偏
- **WHEN** 同一页面上发 `scroll {dir: "down", until: <目标>}`，折叠后列表仍需滚动才能看到目标
- **THEN** 执行端在列表上继续滑，找到时 `found: true`，`scrolls` 是实际滑动步数

#### Scenario: 单步与整次上限不变
- **WHEN** 页面内容持续变化或动作很慢
- **THEN** 单步不超过 800 ms、整次不超过 10 s，到上限带 `stopped: "time"` 与已完成步数，`timing` 照旧
