# device-ops-and-control — tasks

## 计划 1：设备声明随快照与事件给出

- [x] 1. `HostRelayRegistry`：online 事件载荷（`HostChange`）增加 `ops?: string[]`，`connect` 时带上当次 hello 的 ops
- [x] 2. `src/engine/devices.ts`：`DeviceChange` device 支与 `DeviceSnapshot.devices` 增加 `ops?: string[]`；`wireDeviceChanges` 转发 online 事件的 ops，`online()` 从 `hello.ops` 取
- [x] 3. 单测：快照带 ops；重连换 op 集合后 online 事件带新集合；offline 事件不带

## 计划 2：管理口控制帧路由

- [x] 1. `WsHostRelay.sendControl(frame)`：带外发送 `{type:'control',...frame,id}`，按 id 配回复（复用 pending 表），不等会话租约、不占单发尾锁；断连与超时语义与 op 一致
- [x] 2. `device-routes.ts`：`POST /devices/:id/control`——`isAdmin`；body 校验（type=`control`，`control` 只收 `setBusy`/`exemptions`；`busy` 必须布尔、`reason` 可选字符串、`ask`/`financeVisible` 按 device-sensitive-semantics 格式校验）；离线 404 `{error:"device-offline"}`；设备回执转 200/502
- [x] 3. 单测：两种控制帧整链路（发出帧形、回执转 200）；设备错误回执 502；格式不合法 400；非管理员 403；离线 404 `device-offline`；busy 期间控制帧不等 recipe 租约

## 计划 3：host-agent 声明转发 op + 单实例锁（Rust，app/host-agent）

- [ ] 1. `device.rs`：`DEVICE_OPS` 加 `http.forward` / `ws.forward`；op 名收拢成常量（与 `main.rs` 会话循环共用）；更新钉死的 hello 测试；补「声明与会话循环实际处理的 op 一致」守卫测试
- [ ] 2. `device.rs` + `main.rs`：设备模式进门前对状态目录 flock（非阻塞）；拿不到锁一行日志退出（非零码）；补单实例锁测试
- [ ] 3. `cargo test` + `cargo clippy` 全绿

## 计划 4：文档与收尾

- [x] 1. `docs/API.md`：`POST /api/devices/:id/control` 文档段落（帧格式、校验、错误码、与 hello ops 的关系）
- [x] 2. `openspec` 两个 capability 的 delta 归档口径核对
- [x] 3. 全量受影响包测试 + `tsc --noEmit`；rebase、push
