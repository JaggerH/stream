# android-agent-library — design

## 模块

```
app/android/
  agent/        com.android.library，namespace com.streamapp.android.agentlib
  app/          com.android.application，applicationId / namespace com.streamapp.android
  sample-host/  独立 Gradle 构建（composite build），不在主构建的 settings 里
```

Kotlin 包名保持 `com.streamapp.android.*` 不动，只换了所在模块；库的 namespace 另起
（`…agentlib`），避免与应用的 `R` / `BuildConfig` 同包冲突。

## 关键决定

1. **组件类名不变。** 无障碍服务的启用状态按组件全名记在系统设置里；类名一变，升级后用户得重新打开无障碍。
   库 manifest 因此写全名（`com.streamapp.android.a11y.StreamAccessibilityService` 等），Kotlin 的 `internal`
   类在字节码里仍是 public，系统照常实例化。
2. **公共面只有一个入口。** `StreamAgent` 与它用到的值类型（`AgentState`、`AgentConnection`、`DeviceHealth`）、
   挂钩接口（`AgentIndicator`、`IndicatorProvider`、`UserStopListener`、`OccupancyHint`、`AgentStateListener`），
   以及配对码解析 `PairPayload` / `PairChoice` / `pairChoices`（宿主自己扫码时要用）。其余全部 `internal`，
   由 `kotlin { explicitApi() }` 守住：新增 public 声明必须显式写出。
3. **版本号。** 原来 `hello` 里的 `agentVersion` 读应用的 `BuildConfig.VERSION_NAME`；库里改读库自己的
   `BuildConfig.AGENT_VERSION`，两者都来自根构建的 `streamVersionName`，Stream APK 上报的值不变。
4. **通知点开的目标。** 原来写死 `MainActivity`；库里取宿主的启动 Activity 组件，只按组件构造 Intent
   （无 action / category / flags），对 Stream 等价于原来的 `Intent(this, MainActivity::class.java)`。
5. **状态观察。** 原来是 `RelayService.onStatus` 单槽回调；改为 `StreamAgent.observe(context, listener)`，
   多监听者，订阅时立即回一次当前状态，之后在连接状态、配对、无障碍服务变化时回调（在发生变化的线程上）。
   不引入 kotlinx.coroutines：Stream APK 的依赖集合不变。
6. **配对。** `StreamAgent.pair` 成功即落盘凭据（原来由页面在回到主线程后落盘），不自动连接；页面照旧随后 `start`。
   差别只在页面已销毁的边角：原来凭据会丢、配对码已用掉；现在凭据保留，下次打开即连。
7. **挂钩的范围。** 本变更只定义接口并保持现有行为：`indicatorProvider` 默认构造原来的提示条；
   `userStopListener` 在原有中止流程之后通知；`occupancyHint` 只占位、不被读取。完整的指示器、占用、停止回调行为留给后续变更。
8. **健康读数。** `state()` 读设备健康时吞掉运行时异常（返回 `health = null`），不让宿主的查询崩溃；
   中继心跳走的仍是原来的同一段读数逻辑（未改行为）。

## 验证

- JVM 单测：原 199 个原样迁入 `:agent` 全绿；新增连接阶段 1 个、`AgentState.displayStatus` 3 个。
- `:app:assembleDebug` / `:app:assembleRelease`、`:agent:assembleRelease`、`sample-host :app:assembleDebug` 成功。
- 合并后 manifest（release）逐元素比对：只有无障碍服务 `label` 的资源名不同（取值同为 `Stream`）；
  `aapt2 dump badging` 只有行序差异；APK 内文件条目一致；dex 里 `com.streamapp` 下的类只增不减。
- lint：与拆分前同样的 2 个 error（`MissingPermission`，`ACCESS_NETWORK_STATE`，随代码移入 `:agent`）与 5 个 warning，无新增。
