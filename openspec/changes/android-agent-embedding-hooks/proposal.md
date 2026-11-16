# android-agent-embedding-hooks

## Why

`android-agent-library` 把执行端拆成了可嵌入的库，并定义了三个挂钩接口，但只保留了现有行为：
指示器可替换却没有统一的挂载方式，截图会把指示器自己拍进去，`occupancyHint` 只占位不被读取，
停止回调接在一段不可测的内联代码里。宿主 App 把执行端装进自己的 APK 之后，需要这几处真正可用：
画自己的指示器、截图里不出现它、在用户正在用（包括正在用宿主 App 本身）时不被抢屏、知道用户点了停止。

## What Changes

- **可替换的指示器，端到端生效。** `StreamAgent.overlayIndicator(service, onStop, view)` 把宿主的
  `IndicatorView` 作为 `TYPE_ACCESSIBILITY_OVERLAY` 窗口挂上（与默认提示条同一套：手势穿透、截图隐藏、位置、
  60 秒自动隐藏）；默认提示条改为同一实现上的一种内容。`indicatorProvider` 换了之后，下一次显示时旧指示器被销毁、
  用新的 provider 重建（服务换了也一样）。`AgentIndicator` 增加两个带默认实现的成员：`hideForCapture(hidden)`、
  `bounds()`，以及值类型 `IndicatorBounds`。
- **截图不含指示器。** 每次截图（`screenshot` op 与审批回执背后的快照）前叫 `hideForCapture(true)`，返回 `false`
  时把 `bounds()` 涂黑；截图后无论成败都叫 `hideForCapture(false)`。顺带修正：全黑重试之前的第一次截图没有遮盖凭据区域，
  现在两次都遮盖。
- **占用提示被读取。** `focusApp`、`scopeWindow` 与动作类 op 在执行前先问 `occupancyHint`：目标 App，再问前台 App
  （宿主在前台时就是宿主自己）；`true` 即回 `app-in-use`（与执行端自己的拒绝同一 code 与 `semantics {op, app}`），
  `false` / `null` / 抛异常交给执行端自己的判定。新增策略开关 `anyRecentTouchOccupies`（缺省关）：开了之后，
  前台 App 最近 10 秒内被用户触摸过即算占用，不论 op 的目标。
- **用户停止回调。** 指示器的停止先发既有的中止，再调 `userStopListener`；监听者抛错不影响中止。
- 样例宿主演示自定义指示器与「宿主在前台时占用」的提示。

## Capabilities

### Modified Capabilities

- `android-agent-library`：挂钩从占位变为生效（ADDED Requirement）。

## Non-Goals

- 不改执行端自己的占用判定与 `app-in-use` 回执形状；不改中止协议。
- 不提供跨进程的指示器或占用来源：挂钩都在宿主进程内。

## Impact

- `app/android/agent`：`StreamAgent`（公共面新增 `overlayIndicator`、`defaultIndicator`、`anyRecentTouchOccupies`、
  `IndicatorView`、`IndicatorBounds`，`AgentIndicator` 两个默认成员）、`a11y/Overlay`、`a11y/AndroidDevice`、
  `agent/Dispatcher`、`agent/IndicatorSlot`（新）、`net/RelayService`。
- `app/android/sample-host`、`docs/API.md`。
- Stream 自己的应用：缺省值下行为不变（默认提示条、无提示、策略关）；唯一可见变化是截图里不再有提示条。
