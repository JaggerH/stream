# android-agent-library — tasks

## 计划 1：拆模块

- [x] 1. `:agent` 库模块：源码、单测、`policy/*.json` 资产、无障碍配置 XML 自 `:app` 移入；库 manifest 声明服务 / 接收器 / Activity（全名）与权限
- [x] 2. `:app` 只留 `MainActivity`、应用名与网络安全配置；依赖 `project(":agent")`；applicationId 与版本不变
- [x] 3. 用户可见文字改为库字符串资源（默认值逐字不变）；通知打开宿主启动 Activity；`agentVersion` 读库的 `AGENT_VERSION`
- [x] 4. `scripts/build-android.sh` 同时跑 `:agent` 与 `:app` 的单测，产物路径不变

## 计划 2：公共入口

- [x] 1. `StreamAgent`：pair / isReachable / pairedBackend / unpair / start / stop / state / observe
- [x] 2. `AgentConnection` 阶段：中继客户端随状态文字给出；服务停止回 IDLE（被移除时保持 REVOKED）
- [x] 3. 挂钩接口与默认实现：`indicatorProvider`（默认提示条）、`userStopListener`、`occupancyHint`（占位）
- [x] 4. explicit API；其余声明 `internal`；`MainActivity` 只经 `StreamAgent` / `PairPayload` 用库
- [x] 5. 单测：连接阶段序列；`AgentState.displayStatus`

## 计划 3：样例与文档

- [x] 1. `sample-host`：独立构建，composite build 以坐标依赖 `:agent`，覆盖两条字符串资源，能编译
- [x] 2. `docs/API.md` 增加嵌入一节；`docs/ARCHITECTURE.md` 更新模块划分
- [x] 3. 合并后 manifest、APK 条目、dex 类清单与拆分前比对
