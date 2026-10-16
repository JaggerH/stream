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

## 计划 2：Linux 无界面 agent

- [ ] 待写（`http.fetch` 的设备侧实现、主机校验与私网拒绝、配对启动）

## 计划 3：浏览器转发与 NAS 镜像

- [ ] 待写（`channel: 'browser'` 帧、`ExtRelay` 按设备、`stream-node` 镜像、`docs/ops/nas-device.md`）

## 计划 4：面板

- [ ] 待写（facility 默认设备选择、任务覆盖、运行记录显示设备名）
