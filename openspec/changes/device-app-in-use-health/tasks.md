# device-app-in-use-health — tasks

## 计划 1：执行端占用判定（app-in-use）

- [x] 1. `Device` 接口增加 `lastUserInputMs(): Long?`（无障碍观察到的最近一次非自注入用户触摸，epoch ms，
       没有事实 = null）；`FakeDevice` 与 `AndroidDevice` 实现
- [x] 2. 自注入手势排除：`UserInputTracker`（纯 Kotlin，JVM 可测）——手势注入时刻 + 时长 + 2 秒余量内的
       触摸事件不计入；`AndroidDevice.gesture` 与无障碍服务（XML 事件类型 + `onAccessibilityEvent`）接入
- [x] 3. `Dispatcher`：`focusApp`（目标包名）、`scopeWindow`（目标窗口进程）、gated 动作 op 与 `press`
       （落点 App）执行前判定「前台 + 最近 10 秒内有用户输入」；命中抛 `app-in-use`（code + semantics
       `{op, app:{id,name}}`），动作一个不做；读 op 不判定
- [x] 4. 单测：占用时 focusApp/scopeWindow/click/press 拒绝且无动作；旧触摸、别家前台、无事实放行；
       UserInputTracker 的注入窗口排除

## 计划 2：health 上报（state 帧 + time 帧）

- [x] 5. `DeviceState` 增加 `networkOk`（`RelayService` 经 ConnectivityManager 的
       `NET_CAPABILITY_VALIDATED`）；`Frames.state` 增加 `health` 对象（`networkOk` 恒有，
       `clockSkewMs` 有事实才带）；`Frames.time` 解析 `{type:"time", serverTime}`
- [x] 6. `RelayClient`：收到 `time` 帧记偏差（本机时钟 − serverTime，注入 `now` 便于单测）并立即回发
       带 `health` 的 `state`；hello 后的第一条 `state` 无偏差
- [x] 7. 后端：android `hello` 注册后向该连接发 `{type:"time", serverTime: Date.now()}`（只发 android，
       桌面 agent 不发）；`HostDeviceState` 增加可选 `health`，`parseState` 校验（缺省缺失、类型不符
       整帧丢弃）；`GET /api/devices` 行随 `state` 自动带出
- [x] 8. 单测：Kotlin Frames/RelayClient（偏差计算、缺省缺失、垃圾帧忽略）；TS parseState（合法/畸形/
       缺省）、attach 测试（android hello 后收到 time 帧、桌面 hello 不发）、devices 列表带 health

## 计划 3：透传、类型导出与文档

- [x] 9. `HostOpSemantics = DeviceOpSemantics | AppInUseSemantics` 并集放宽 `HostOpError.semantics`；
       `src/engine/index.ts` 导出两个新类型（exports.guard 快照同步）；502 透传机制不变，补一条
       `app-in-use` 整链路单测
- [x] 10. `docs/API.md`：`state` 帧契约补 `health` 与 `time` 帧；`/ops` 502 段补 `app-in-use` 回执形状
- [x] 11. 受影响测试全绿 + `tsc --noEmit`；交付前跑受影响包全量 + `pnpm -r typecheck`
