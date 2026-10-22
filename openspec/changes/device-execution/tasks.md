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

实施计划：`docs/superpowers/plans/2026-10-21-device-execution-extension-bindings.md`。不做镜像。

- [x] 1. 扩展绑定表 `ExtBindingStore`：为设备签的配对码、只存 token 哈希、撤销设备连带撤绑定
- [x] 2. `ExtRelayRegistry`：每条绑定一条 relay、按设备选绑定（最近连上）、撤销断开 4003
- [x] 3. `/api/ext` 升级按 token 认绑定；`/api/ext/verify` 带 `binding` 用 token 哈希签
- [x] 4. 执行上下文的 `browser` 记号：一次执行第一次用浏览器时选定、整次不变（`pickBrowser`）
- [x] 5. lane 与 Transport 按绑定；预算按绑定计；常驻标签文件本机形状不变
- [x] 6. 登录与 cookie 拉取在执行设备上（按设备的 `CookiePuller`，远程设备只取绑到它的 facility 的域）
- [x] 7. 配对 / 列表 / 撤销接口与 serve 接线；`claimed-tabs?binding=`
- [x] 8. 扩展：一组绑定（本机那条就是原 `config`，不迁移）、配对码配对（HTTP / HTTPS 都认，远程明文时提示不加密）
- [x] 9. 扩展：driver 按绑定的会话（`BindingRuntime`），别的绑定的 tab 一律拒
- [x] 10. 扩展：按绑定同步、待批准域名（远程实例经 `cookiePull` 申报）、popup 的 Streams 页签
- [x] 11. ARCHITECTURE / 扩展 README；后端实机冒烟（配对、验身份、连上、列表、撤销 4003、撤销后 401）
- [x] 两端真机冒烟：同一个 Chrome 绑本机与另一个实例、各自开组、跨组命令被拒、新域待批准（2026-10-22：无头 Chrome 跑全五条；Windows 真机 Chrome 经 tailnet `http://` 配对、待批准、批准、撤销）

## 计划 4：面板

实施计划：`docs/superpowers/plans/2026-10-22-device-execution-panel.md`。

- [x] 1. 设备的默认扩展绑定（`pick` 先看它，离线退回最近连上）；配对码回 `backends`
- [x] 2. `GET /api/devices/facilities`：全部 facility 及其默认设备
- [ ] 3. 运行记录带 `deviceId` / `bindingId`
- [ ] 4. 面板 API 层
- [ ] 5. 设备卡片：Linux 设备、添加浏览器（码 + 倒计时 + 地址）、浏览器列表、设为默认、撤销
- [ ] 6. facility 的默认设备
- [ ] 7. 任务覆盖设备、运行记录显示设备
- [ ] 8. 文档、构建、实机看一眼
