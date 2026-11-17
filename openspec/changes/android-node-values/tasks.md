# android-node-values — tasks

- [x] 1. 控件的值：`UiNode.checked` / `range` / `stateDescription`（`NodeAdapter` 从 `isCheckable`/`isChecked`、
       `rangeInfo`、`stateDescription` 读）；`find` 元素带 `checked` / `range` / `state`；`rowValues` 给自身无值的元素带
       `values`（ref 并入同一快照）；`ANDROID_CAPS` 的 `ui.tree` 升 v2
- [x] 2. 前台窗口：`WindowKinds.canBeForeground` / `pickForeground`；`AndroidDevice.windows` 的 `foreground` 与
       `foregroundPackage` 改用它
- [x] 3. ref 失效：窗口签名用 `countsForChanges` 去掉输入法与悬浮层；`stateChangeCounts` 丢掉输入法与悬浮层的换页事件；
       `ChangeLog.pageEvent` 不把同窗口同类名的重发算换页；服务连上时记窗口基线
- [x] 4. 触摸来源：`isOwnSurface`（事件窗口 / 触摸浏览时的 active 窗口 / 事件包名）；`UserInputTracker.ownSurfaceTouched`
       与 `onTouchInteraction(ownSurface)`；`Overlay` 用 `OwnTouchFrame` 包住指示器视图；`StreamAgent.ownSurfaceTouched()`
- [x] 5. 单测：`NodeValuesTest`、`WindowKindsTest`、`UserInputTrackerTest`、`ChangeLogTest`，能力版本断言更新；vitest
       `desktop-driver` 新字段透传
- [x] 6. `docs/API.md` 与 `A11yElement` 类型
- [x] 7. 真机验证（Android 16）：字体大小滑块的值；键盘出收两轮、可获焦悬浮层开关五轮 ref 不失效；悬浮层获焦时前台仍是
       下面的应用；指示器被点时上报自家触摸
- [x] 8. 指示器的窗口根带宿主视图的 view-tree owner：`OwnTouchFrame` 包住时与挂上窗口时（子视图挂上之前）各拷一次
       `copyViewTreeOwners`（lifecycle、ViewModelStore、SavedStateRegistry、OnBackPressedDispatcher、FullyDrawnReporter；
       androidx 库 compileOnly，宿主没有的那一种跳过）；否则 Compose 指示器挂窗时找不到 lifecycle owner，整个宿主进程崩溃、
       无障碍服务失效。Robolectric `OwnTouchFrameTest`；sample-host 的指示器改用 Compose；真机先在旧版本复现崩溃、再验证修好
