# device-capability-manifest — tasks

- [x] 1. 后端：`parseHello` 解析 `capsVersion` + `caps`（缺失 = 无；未知版本或容器类型错 = 整体忽略；坏条目逐条丢弃并每连接记一行日志；从不拒 hello）；`HostHello.caps`
- [x] 2. 后端：`HostChange` / `DeviceChange`（online）与 `DeviceSnapshot` 带 `caps`；`GET /api/devices` 在线行带 `caps`
- [x] 3. 类型从 `@streamapp/engine` 导出，`exports.guard` 快照同步
- [x] 4. Android：`Frames.hello` 带 `capsVersion` / `caps`，`RelayClient` 发 `ANDROID_CAPS`
- [x] 5. host-agent：`with_caps` / `caps_for_ops`；本机 hello 由 op 推出能力，设备模式空清单
- [x] 6. 测试：TS parseHello（合法 / 无清单 / 未知版本 / 坏条目丢弃 / 坏容器忽略）、attach（握手成功 + 一行日志）、注册表事件、网关整链路（旧设备无 caps、带 caps 的重连）；
       Kotlin Frames / RelayClient；Rust relay / device
- [x] 7. `docs/API.md` 协议说明
