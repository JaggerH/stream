# device-op-error-semantics

## Why

设备端对 gated op 的失败帧（`device-sensitive-semantics`）已经带机器可读的 `code`（`approval-required`、
`stale-ref`、`credential-field-denied`、`app-denied`、`approval-mismatch` …）和 `approval-required` 的
结构化回执 `semantics`（op、app、control、reasons、bindingDigest、screenDigest、snapshotRef），但后端
只保留错误字符串：`HostOpError` 收下 `code`、丢掉 `semantics`；管理口 `POST /devices/:id/ops` 失败时
502 body 只有 `{error}`。把 Stream 嵌进宿主进程的调用方（`deviceGateway` 的管理类端口正是给嵌入方的
审批 UI 用的）拿不到结构化回执，只能靠错误字符串的前缀去猜——字符串是给人读的，格式不是契约。

## What Changes

- **`HostOpError` 带上设备给的结构化字段。** 设备错误帧 `{id, error, code?, semantics?}` 里的
  `semantics`（原样 JSON 对象）在 reject 时挂在异常上：`error` 与 `code` 行为不变，新增
  `semantics?: DeviceOpSemantics`（设备给了才有）。
- **管理口 `POST /devices/:id/ops` 的 502 body 透传结构化字段。** `{error}` 变为
  `{error, code?, semantics?}`——设备给了才带，老字段不变，老调用方不受影响。
  `POST /devices/:id/control` 的 502 同步透传（同一组路由、同一消费方）。
- 类型声明（`DeviceOpSemantics`）从 `@streamapp/engine` 公共入口导出，嵌入方拿到类型与值。

## Capabilities

### Modified Capabilities

- `embeddable-device-gateway`：管理口 `/devices/:id/ops` 与 `/devices/:id/control` 的 502 body 带上
  设备错误帧的 `code` 与 `semantics`（ADDED Requirement）。

## Impact

- `src/http/host-relay.ts`（`HostOpError` + `handleMessage` 透传）、`src/http/device-routes.ts`
  （502 body）、`src/engine/index.ts`（类型导出）、`docs/API.md`（502 契约一段）。
- 兼容性：`error` 字段与状态码不变；`code`/`semantics` 是新增可选字段，仅在设备帧带了对
  应字段时出现。现有 `host-relay` / `device-routes` / `devices/fetch` 测试全绿为证据。
