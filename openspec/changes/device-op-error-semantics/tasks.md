# device-op-error-semantics — tasks

## 计划 1：HostOpError 带结构化字段

- [x] 1. `HostOpError` 增加 `semantics?: DeviceOpSemantics`（设备帧给了才有）；`handleMessage` 从
       错误帧透传 `semantics`（原样对象）；类型声明按 device-sensitive-semantics 的回执 schema
- [x] 2. 单测：错误帧带 code+semantics → 异常两字段都在；只带 code → semantics 缺省；不带 code →
       两字段都缺省；成功帧与主动帧（abort / fwd-data）不受影响（既有测试覆盖主动帧路径）

## 计划 2：管理口 502 透传

- [x] 3. `/devices/:id/ops` 与 `/devices/:id/control` 的 catch：`e instanceof HostOpError` 时 body 带
       `code` / `semantics`（设备给了才有）；其他错误（排队超时、断连）仍只回 `{error}`
- [x] 4. 单测：ops 路由 approval-required 整链路（502 body 三字段）；stale-ref 带 code；
       无 code 帧 body 不变；断连 502 只有 error；control 路由同样透传

## 计划 3：类型导出与文档

- [x] 5. `src/engine/index.ts` 导出 `DeviceOpSemantics` 类型（`exports.guard` 快照同步）
- [x] 6. `docs/API.md`：`/devices/:id/ops` 与 `/control` 段落写清 502 body 的
       `{error, code?, semantics?}` 契约与向后兼容
- [x] 7. 受影响测试文件全绿 + `tsc --noEmit`
