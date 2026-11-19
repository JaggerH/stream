# android-settings-controls-scroll — tasks

## 1. Failing tests first

- [x] 1.1 Settings 类目：`invoke` 名为 `Decrease font size` / `Increase font size` 的步进按钮 → `approval-required`，
      `reasons` 含 `setting`，动作未执行。
- [x] 1.2 Settings 类目：与 `SeekBar` 同一行的 `＋` / `－` 图标按钮 → 含 `setting`。
- [x] 1.3 Settings 类目：点击滑杆（坐标落在 `SeekBar` 上）、`invoke` 滑杆、`setValue` 滑杆 → 含 `setting`。
- [x] 1.4 非 settings 类目（购物 App）的数量 ± 按钮、滑杆 → 不因本规则要求审批。
- [x] 1.5 滑杆读值：`int` 区间的 `range` 带 `stepCount`；`float` / `percent` 不带；三种类型原样回
      `now` / `min` / `max`；有 `stateDescription` / `text` 的控件带 `valueText`。
- [x] 1.6 折叠工具栏（`CollapsingToolbarLayout` + `AppBarLayout` + `RecyclerView`）：第一步只折叠 AppBar
      时不计步、不记住错误容器；同一次 `scroll` 继续滚列表，回执 `steps` 只算列表真实移动的步，且
      `method == "a11y"`、容器是列表。
- [x] 1.7 折叠工具栏上的 `until`：折叠后继续在列表上滑，找到目标；不把折叠当进度跳过列表。
- [x] 1.8 既有有界耗时与 `timing` 字段保持不变（既有 `ScrollLatencyTest` / `ScrollUntilTest` 全绿）。
- [x] 1.9 能力 `ui.tree` 声明 v6。

## 2. Implementation

- [x] 2.1 `assets/policy/words.json`：`stepperWords`（`increase`, `decrease`）与
      `cjkStepperPrefixes`（`增大`, `减小`, `加`, `减`）；`Words.kt` 读取。
- [x] 2.2 `Detect.isStepperLabel`（词表）与 `Gate.isIconStepper`（与滑杆相邻的 ＋/－））；`Gate.reasons`
      的 `click`/`invoke` 加步进与滑杆判定，新增 `setValue` 分支，`scroll` 加可滚动滑杆判定；`isSlider`
      覆盖 `Slider` 类名。
- [x] 2.3 `Values.valueFields`：`range` 带 `stepCount`（int 区间 = `max − min + 1`）；元素与行值带
      `valueText`（`stateDescription` 否则 `text`）。
- [x] 2.4 `Dispatcher`：`firstItemPrint` 以容器子树为范围、位置相对最近滚动祖先；`awaitMove` 区分列表
      移动 / 布局移动 / 无移动；布局移动不计步、对同一容器再发一步（`MAX_LAYOUT_SHIFTS` 上限）；整次
      上限与 `timing` 不变。
- [x] 2.5 `ui.tree` 能力升 v6 与注释；`src/replay/desktop-driver.ts` 的 `A11yRange` 加可选 `stepCount`。

## 3. Documentation and verification

- [x] 3.1 `docs/API.md`：`find` 的 `range.stepCount` / `valueText`；闸的设置判定（步进按钮与滑杆）；
      `scroll` 在折叠工具栏上的判步说明；能力清单 v6。
- [x] 3.2 Kotlin 单测（`PolicyGateTest`、`DetectTest`、`NodeValuesTest`、折叠工具栏滚动用例、能力断言）
      在 lean 上全绿（Robolectric 的 6 条已知环境性红单列）。
- [x] 3.3 Stream 全量与 `typecheck` 在 lean 上跑（整机锁 + `nice`），基线失败单列。
