# android-settings-controls-scroll

## Why

真机（Android 16 原生系统设置）上的三处问题，都出在「设备没把动作的后果说清」：

- **步进按钮与滑杆不过闸。** 只读任务（「告诉我屏幕超时和字号」）里，调用方在 Display size & text
  页依次 `invoke` 了字号滑杆两侧的步进按钮，其中一个名为「Decrease font size」——执行端没有要求审批，
  直接执行了。现在的 `setting` 判定只认 settings 类目里的开关（`isSwitch`）与设置词表命中
  （`isSettingLabel`）；步进按钮（Increase/Decrease…、＋/－）与滑杆（`setValue`、
  `ACTION_SCROLL_FORWARD/BACKWARD`、点击轨道）都不在判定里，于是修改系统设置的按钮被当成普通按钮放行。
- **滑杆的值读不全。** 同一页，执行端报回滑杆「0 of 0–3」，调用方据此答「小」；设备上
  `settings get system font_scale` 实为 1.3。`RangeInfo` 的 `current / min / max` 是原样报的，但回执里
  没有说明这是「第几档 / 共几档」，也没有把节点自己说的值（`stateDescription` / `text`）带出来，调用方
  无法判断读到的是哪个滑杆、滑杆自己在说什么。
- **设置主列表滚动回归。** 系统设置主列表（`CollapsingToolbarLayout` + `AppBarLayout` + `RecyclerView`）
  上 `scroll`（含 `until`）回执 `steps ≥ 1`，但屏幕内容在 0 / 250 / 500 ms 三次读里都没有变。上一版滚动改动（`5662897`）的
  「首个可见项判步」把 AppBar 折叠（整列表随之上移）当成了列表滚动：第一步就确认移动、记住容器，后续
  步骤继续发在同一个动作上，列表内容实际从未滚动。

## What Changes

- **步进按钮与滑杆在 settings 类目里判 `setting`。**
  - 命中步进词表的控件：名字（或 contentDescription）以 `increase` / `decrease` / `增大` / `减小` /
    `加` / `减` 开头；
  - 或与滑杆相邻的 `＋` / `－` 图标按钮（可点击、同一行、与滑杆的水平间距很小）；
  - 或滑杆本身（点击轨道、`invoke` 上的滚动动作）；
  - 或在滑杆上 `setValue`；
  - 或在 settings 类目里 `scroll` 会落到一个可滚动的滑杆上。
  以上任一命中，按 `setting` 要求审批；非 settings 类目的步进（购物 App 的数量 ±）不受影响。
- **滑杆读值补全（可选字段，向后兼容）。** `find` / `ui.tree` 的 `range` 在既有
  `{type, now, min, max}` 之外带：
  - `stepCount`：整数档位区间的档数（`max − min + 1`），仅 `type == "int"` 时出现；
  - 元素与行 `values` 带 `valueText`：节点 `stateDescription`（非空时）否则其 `text`，即「这个控件
    自己说它是什么值」。`RangeInfo` 的 `current / min / max` 仍原样报出，不做换算。
- **折叠工具栏上「折叠不是列表移动」。** 判步以「列表自己的第一项相对其滚动容器变了」为准：容器整体
  上移（AppBar 折叠）不算移动。折叠消耗掉的那一步不计入步数，执行端继续对同一个列表发下一个滚动动作；
  容器自身矩形反复变化而无列表移动时有次数上限。既有的单步 800 ms、整次 10 s 上限与 `timing` 字段
  不变。
- **能力 `ui.tree` 升到 v6。** 新字段全部可选；老调用方不看即可。滚动判步的行为变化向后兼容：
  动的是列表时照旧确认，动的是布局时不再误报。

## Capabilities

### Modified Capabilities

- `device-sensitive-semantics`：settings 类目里的步进按钮与滑杆动作判 `setting`；词表与结构判据。
- `android-recipe-replay`：`find` 的滑杆读值（`stepCount` / `valueText`）；折叠工具栏上的滚动判步。

## Impact

- `app/android/agent/src/main/java/com/streamapp/android/policy/{Gate,Detect}.kt`、
  `assets/policy/words.json`（步进词表）。
- `app/android/agent/src/main/java/com/streamapp/android/agent/{Dispatcher,Values}.kt`（滑杆读值、判步）、
  `a11y/NodeAdapter.kt`（如需要）。
- `docs/API.md`：`find` 的 `range` / `valueText`、闸的设置判定、`scroll` 的折叠工具栏判步。
- 测试：`PolicyGateTest`、`DetectTest`、`NodeValuesTest`、新增折叠工具栏滚动用例、能力版本断言；
  `src/replay/desktop-driver.ts` 的 `A11yRange` 类型加可选 `stepCount`。
