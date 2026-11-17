# android-nav-gestures — tasks

- [x] 1. `focusApp` 的 `fresh`：`Device.launch(pkg, fresh)`，`launchFlags`（CLEAR_TASK / RESET_TASK_IF_NEEDED）；
       本就在前台时等窗口集合变化；回复带 `fresh: true`；`ANDROID_CAPS` 的 `app.launch` 升 v2
- [x] 2. `scroll` 无障碍优先：`scrollContainer`（可见、非横向、屏幕上面积最大）、`Device.scrollNode`
       （`SCROLL_DOWN/UP` 优先，否则 `FORWARD/BACKWARD`）；回复 `method` / `steps` / `end` / `a11y`
- [x] 3. 手势回退：`swipeGeometry`（右缘 48dp 边带、70%→30%、不足 4 倍 touch slop 拒绝）；`swipe(holdMs)`
       以续接笔画停 100 ms 再抬手
- [x] 4. `windows` 带宿主窗口行 `self: true`；派发器内部窗口解析排除宿主行
- [x] 5. 单测：JVM（`NavGesturesTest`、`ScrollAxisTest`、既有 Dispatcher / RelayClient 测试更新）
- [x] 6. `docs/API.md` 与 `WindowInfo.self?` 类型
- [x] 7. 真机修正（关于手机页滚不动）：`scrollCandidates`（内层列表优先于外层包裹、按序试最多三个）、
       每步比对内容指纹（`contentPrint`，无效 = 第一步退回手势 `a11y: "no-effect"`、后续步 `end: true`）、
       `scrollNode` 只发节点提供的动作；只声明反方向 = 已到头（`steps: 0, end: true`，不发手势）；JVM 单测与真机验证（关于手机、设置首页）
