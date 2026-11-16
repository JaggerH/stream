# android-agent-embedding-hooks — tasks

- [x] 1. `AgentIndicator.hideForCapture` / `bounds`（默认实现）、`IndicatorBounds`、`IndicatorView`、`StreamAgent.overlayIndicator`、`defaultIndicator`
- [x] 2. `Overlay` 改为通用的无障碍浮层，默认提示条是其内容；隐藏不移除窗口，位置随布局更新
- [x] 3. `IndicatorSlot`：服务或 provider 换了即销毁重建；`AndroidDevice` 的状态、手势、截图都经它取指示器
- [x] 4. `captureWithout`：截图前隐藏（否则涂黑 bounds），之后必恢复；全黑重试前后都遮盖凭据区域
- [x] 5. `Dispatcher` 的 `Occupancy`：提示（目标、前台）与 `anyRecentTouchOccupies` 策略；`RelayService` 接线
- [x] 6. `StreamAgent.userStopped`：先中止、再通知；`RelayService` 接线
- [x] 7. JVM 单测：占用提示与策略、指示器槽位与截图、停止顺序、缺省值、接线守卫
- [x] 8. 样例宿主使用自定义指示器与占用提示；`docs/API.md`
