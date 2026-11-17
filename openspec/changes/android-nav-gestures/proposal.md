# android-nav-gestures

## Why

安卓执行端在三处让调用方多花步骤、或做出错事：

- `focusApp` 只会「把 App 叫到前台」，App 回到上次停留的页面（上一轮留在某个设置子页，这一轮就从那里开始）。
  调用方想「从首页开始」只能一路按返回猜。
- `scroll` 一律注入滑动手势：起点在窗口正中，正好落在列表行的主点击区；抬手前没有停顿，列表会继续惯性滑；
  窗口很矮时滑动距离接近触摸阈值，可能被当成一次点击。而绝大多数可滚动容器本来就接受无障碍滚动动作。
- `windows` 把宿主 App 自己的窗口过滤掉了：宿主在前台时列表里看不到任何前台窗口，调用方无法区分
  「宿主在前台」与「读不到」，只能再发一次 `url` 之类的查询。

## What Changes

- **`focusApp` 可选 `fresh: true`。** 以清空任务栈的方式（`FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK`）
  从启动页打开 App，回复带 `fresh: true` 表示已按此执行；目标 App 本就在前台时，等窗口集合变化后才算到达。
  缺省（不带或 `false`）行为不变：`NEW_TASK | RESET_TASK_IF_NEEDED`，回到上次的页面。能力清单里
  `app.launch` 升到 `v: 2`，调用方据此协商是否可用 `fresh`（v1 的执行端忽略这一格）。
- **`scroll` 先走无障碍动作。** 在目标窗口（限定的窗口，否则前台窗口；宿主自己的窗口除外）里取可见、
  非横向的可滚动容器中屏幕上面积最大的一个，逐步发 `ACTION_SCROLL_DOWN`/`UP`（节点提供时），否则
  `ACTION_SCROLL_FORWARD`/`BACKWARD`。没有这样的容器、或容器第一步就拒绝时，才退回手势。回复带
  `method`（`a11y` / `gesture`）与 `steps`（实际滚了几步）；无障碍滚动中途被拒（到头）时停下并带 `end: true`；
  第一步被拒而退回手势时带 `a11y: "refused"`。无障碍滚动回复的 `via` 是 `a11y`。
- **手势回退加固。** 起点 x 在区域右缘内 48dp 的边带（不在行的主点击区，也避开系统边缘返回手势区）；
  抬手前停 100 ms（无惯性）；滑动距离不足 4 倍触摸阈值时拒绝（`action-failed`），一个手势都不发。
- **`windows` 带出宿主自己的窗口行**，标 `self: true`（照常带 `foreground`）。这些窗口只出现在 `windows`
  里：`scopeWindow`、`find`、动作与截图的落点判定一律不认它们（与之前一样）。

## Capabilities

### Modified Capabilities

- `android-recipe-replay`：`focusApp` 的 `fresh`、`scroll` 的执行方式与回复、`windows` 的宿主行（ADDED Requirements）。

## Non-Goals

- 不新增 op；横向滚动不在本次范围（`dir` 仍只有 `up` / `down`）。
- 不改桌面执行端。

## Impact

- `app/android/agent`：`Device`（`launch(fresh)`、`scrollNode`、`swipe(holdMs)`、`touchSlop`、`density`）、
  `AndroidDevice`、`NodeAdapter`（`isVisible`、`scrollAxis`）、`Dispatcher`（`ANDROID_CAPS`、`focusApp`、
  `scroll`、`windows`）。
- `src/replay/desktop-driver.ts`：`WindowInfo.self?`（类型补一格，行为不变）。
- `docs/API.md`：安卓 op 表与能力清单段。
