# android-agent-library

## Why

Android 执行端今天整个长在 `app/android` 唯一的 `:app` 模块里：协议、op 派发、无障碍服务、提示条、敏感动作闸门、
中继连接、配对与凭据，和配对页 / 设置清单混在一个应用模块里。另一个 App 想把同一个执行端装进自己的 APK
（同一进程、一个 APK、只单向依赖 Stream），只能复制代码——没有可依赖的库，也没有一个说得清「哪些是承诺」的入口。

## What Changes

- **拆成两个 Gradle 模块。** `:agent`（`com.android.library`）装执行端的全部：`protocol/`、`agent/`（Dispatcher 与 op）、
  `a11y/`（无障碍服务、提示条、唤醒 Activity）、`policy/`（含数据资产 `policy/*.json`）、`net/`（中继服务、配对）、
  `store/`（凭据）与 `BootReceiver`；它的 manifest 自带这些组件与所需权限，无障碍配置 XML 留在库里。
  `:app` 只剩 Stream 自己的壳：`MainActivity` 与资源，applicationId、组件类名、行为不变。
- **一个公共入口 `com.streamapp.android.StreamAgent`。** `pair` / `isReachable` / `pairedBackend` / `unpair` /
  `start` / `stop` / `state` / `observe`，外加实验性的挂钩 `indicatorProvider`（默认即现有提示条）、
  `userStopListener`（用户点停止后通知）、`occupancyHint`（占位，本版不读）。库开启 Kotlin explicit API，
  其余声明一律 `internal`。`:app` 的配对页只经由 `StreamAgent` 与 `PairPayload` 用库。
- **用户可见文字改为库的字符串资源**（无障碍服务名与描述、连接通知的频道 / 标题 / 文字、后台启动被拒的提示、
  提示条的「停止」），宿主用同名资源覆盖；默认值与今天逐字相同。
- **连接状态带结构化阶段。** 中继客户端在每条状态文字旁给出 `AgentConnection`（连接中 / 已连接 / 重连中 / 被移除 /
  后台启动被拒 / 空闲），供 `StreamAgent.state()` 使用；状态文字本身不变。
- **最小宿主样例 `app/android/sample-host`**：独立的 Gradle 构建，经 composite build 以坐标依赖 `:agent` 并能编译，
  证明可嵌入。
- `scripts/build-android.sh` 照旧产出同一个 APK，并把库模块的单测一起跑。

## Capabilities

### New Capabilities
- `android-agent-library`：Android 执行端作为可嵌入的库，及其公共入口。

## Impact

- `app/android/settings.gradle.kts`、`build.gradle.kts`、`agent/**`（自 `app/` 移入）、`app/**`、`sample-host/**`、
  `scripts/build-android.sh`、`docs/API.md`、`docs/ARCHITECTURE.md`。
- Stream APK：applicationId、组件全名、权限、资产、字符串取值不变；合并后 manifest 只差无障碍服务 label 的资源名
  （取值同为 `Stream`）。原有 199 个 JVM 单测全部原样通过（移入 `:agent`）。
