## 计划 1：后端（device-execution-backend）

- [x] 1. 运行上下文 `run-context`（`LOCAL_DEVICE`、`runOnDevice`、`currentPlacement`）
- [x] 2. 设备错误类与失败处置（`failureDisposition`；`device-offline` / `device-fetch-queue-timeout` 可重试，其余不重试）
- [x] 3. 配对设备支持 `linux` 平台，设备 id 形如 `<platform>:<uuid>`
- [x] 4. facility 默认设备（`facility_devices`）、任务行 `device` 覆盖、`resolvePlacement`
- [x] 5. 登录态按设备分文件（`data/cookies/<deviceId>.json`），旧 `cookies.json` 首启迁移
- [x] 6. host-relay `http.fetch` 通道（不占 UI 租约、每设备在途上限 4）
- [x] 7. `fetchFor`：唯一出站入口，非 `local` 设备不回落本机
- [x] 8. `stream.network.hosts`、`ctx.fetch`、recipe fetcher 经 `fetchFor`、守卫测试
- [x] 9. 任务中心在绑定设备上执行动作
- [x] 10. recipe 采集源跟随 facility 的设备
- [x] 11. serve 接线、端到端测试、文档（ARCHITECTURE / PACKAGE / API）

## 计划 2：Linux 无界面 agent（device-execution-linux-agent）

- [x] 1. 设备侧主机后缀匹配、`ALLOW_HOSTS`、私网地址判定（`netguard.rs`）
- [x] 2. `http.fetch` 设备侧实现：逐跳主机与私网检查、10MB 上限、超时、不走代理（`httpfetch.rs`）
- [x] 3. 会话复用同一份 WS 客户端与协议；`http.fetch` 并发执行；撤销结束监督循环
- [x] 4. 设备模式：无人值守配对、device token 持久化、撤销后重配、被拒的码不重试（`device.rs`）
- [x] 5. CI 跑 `cargo test`；README 设备模式一节

## 计划 3：扩展绑定（扩展 ↔ 实例多对多，绑定挂在设备上）

- [ ] 待写实施计划。范围：实例侧扩展绑定表与 `/api/ext/pair`、按设备签发扩展配对码、`ExtRelayRegistry`、
  按设备选绑定与能力判定、cookie 按绑定落到设备快照、撤销；扩展侧一组绑定与迁移、配对码配对、driver 按绑定的会话与组隔离、
  按绑定的 cookie 同步与待批准域名、popup。不做镜像。

## 计划 4：面板

- [ ] 待写（facility 默认设备选择、任务覆盖、运行记录显示设备名）
