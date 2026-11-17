# android-node-values

## Why

安卓执行端在真机（Android 16）上有四处让调用方多花步骤、或判断出错：

- **控件的值读不到。** 滑块、进度条、开关的当前值不在文字里，而在 `rangeInfo`、`stateDescription` 与勾选状态里；
  `find` 只回名字和位置，调用方想知道「字体大小现在是几档」只能截图。设置页的值控件还常常和标题分在两个节点里
  （设置 → 显示 → 显示大小与文字 → 「字体大小」：标题是一个 TextView，滑块在同一行的另一个框里，自己没有名字）。
- **前台应用会被认成执行端自己的悬浮层。** 宿主通过无障碍服务画的悬浮层一旦可获焦（里面有输入框），就成了
  active 窗口；`foregroundPackage()` 读 `rootInActiveWindow`，于是报出宿主自己是「前台应用」。
- **键盘一出一收，所有 ref 都过期。** 输入法窗口的出现与消失被记成窗口集合变化，调用方每打一次字都得重新 `find`。
  一个可获焦的悬浮层关掉、下面的页面拿回焦点时，页面会重发一次同类名的窗口状态事件，也被当成换了页。
- **碰一下宿主的悬浮层会被算成「用户在用前台应用」。** `app-in-use` 的触摸事实不分触摸落在哪个窗口。

## What Changes

- **`find` 带控件的值**（能力 `ui.tree` 升到 `v: 2`）：元素可带 `checked`（可勾选的节点）、`range`
  （`{type: int|float|percent|indeterminate, now, min, max}`，整数值出整数，其余保留三位小数）、`state`
  （`stateDescription`）；没有值的节点不带这些键。自身没有值的元素（多为一行的标题）带 `values`：同一行里带值的控件，
  近的在前，每个 `{ref, role, name?, rect, checked?, range?, state?}`，ref 与命中同属一次快照。「行」= 元素自己的子树，
  否则向上至多三层里第一个含带值控件的祖先；不越过可滚动的祖先（那是列表）与窗口根；一个祖先里多于三个算一组、不报；
  外层控件与其内层虚拟节点说的是同一个值时（滑块与滑块的拇指）只报内层。不看 `isVisibleToUser`（Android 16 设置页的
  Material 滑块在屏上也报不可见），面积为零的不报。
- **前台窗口从不是悬浮层或键盘**：active 窗口优先，其次 focused，再其次最上层的应用窗口；无障碍悬浮层（任何服务的）、
  输入法、分屏分隔条、放大框、宿主的非 Activity 窗口一律不算。`windows` 的 `foreground`、`url`、占用检查都按它读。
- **ref 只随内容窗口失效**：窗口集合签名不含输入法与无障碍悬浮层；来自输入法（窗口类型或输入法包名）或悬浮层的
  `TYPE_WINDOW_STATE_CHANGED` 不算换页；同一窗口重发与上次同类名的换页事件不算换页（拿回焦点）。服务（重）连时先记下
  当时的窗口集合作基线。
- **自家表面的触摸不算用户在用前台应用**：系统能指出窗口时（事件带窗口 id，或开着触摸浏览时的 active 窗口，否则看事件
  包名），落在无障碍悬浮层或宿主窗口上的不计；`overlayIndicator` 与缺省横幅的视图自己上报触摸；宿主自绘的其他窗口调
  新增的 `StreamAgent.ownSurfaceTouched()`。上报与系统事件谁先到都行（1 秒内互相抵消）。
- **包住指示器视图的框带上宿主视图的 view-tree owner**：框取代宿主视图成了窗口根，Compose 从窗口根找 lifecycle owner
  建窗口 recomposer，找不到就抛异常、整个进程崩溃。框在包住时与挂上窗口时把宿主视图的各个 owner 拷到自己身上。

## Capabilities

### Modified Capabilities

- `android-recipe-replay`：`find` 的值字段与行值、前台窗口的判定、ref 失效的窗口范围、占用检查的触摸来源（ADDED Requirements）。

## Non-Goals

- 不新增 op；`readSubtree` 不变。
- 不改桌面执行端。
- 不改占用判定本身（10 秒、目标在前台、`anyRecentTouchOccupies`）。

## Impact

- `app/android/agent`：`UiNode`（`checked`、`range`、`stateDescription`）、`NodeAdapter`、新 `Values.kt`
  （`valueFields`、`rowValues`）、`Dispatcher`（`find`、`ANDROID_CAPS`）、新 `a11y/WindowKinds.kt`、`AndroidDevice`
  （`windows`、`foregroundPackage`）、`StreamAccessibilityService`、`ChangeLog.pageEvent`、`UserInputTracker`、`Overlay`
  （`OwnTouchFrame`）、`StreamAgent.ownSurfaceTouched()`。
- `src/replay/desktop-driver.ts`：`A11yElement` 的可选字段与 `A11yRange`、`A11yRowValue`（类型补齐，行为不变）。
- `docs/API.md`：安卓 op 表、ref 有效期、能力清单、嵌入钩子。
