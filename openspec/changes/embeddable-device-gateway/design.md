# embeddable-device-gateway — design

## 现状

`src/engine/routes.ts` 里长着四组设备相关路由与两条中继的挂载：

- `mountDeviceRoutes`（配对、设备列表、撤销、facility 绑定、对设备下 op）与 `mountExtBindingRoutes`
  （扩展一次性码换 token、绑定增删）、`mountNodeRoutes`（浏览器节点 / profile 认领，含 `ProfileClaims`
  与两条注册表的接线）、`mountIdentityRoutes`（站点身份）。
- `attachRelayServers` 里 `attachExtRelay`（`/api/ext`）与 `attachHostRelay`（`/api/host`）各自
  `server.on('upgrade')` 自路由。

写死的地方：管理类端口的判据 `isLocal = 回环`；配对码里的地址 `backendUrls = 局域网地址`。

## 形状

```ts
interface DeviceGatewayOptions {
  basePath?: string                                    // 缺省 '/api'
  isAdmin: (c: Context) => boolean                     // false = 403
  backendUrls: () => string[]
}
interface DeviceGateway {
  readonly basePath: string
  app: Hono                                            // 管理面（相对 basePath）
  extApp: Hono                                         // 扩展写死的 /api/ext/*（相对 '/api'）
  hostApp: Hono                                        // host agent 写死的 /api/devices/pair（相对 '/api'）
  mounts: Array<{ path: string; app: Hono }>           // 宿主逐条 app.route(m.path, m.app)
  handleUpgrade(req, socket, head): boolean            // 宿主 server 'upgrade' 里调；false = 不是自己的路径
  close(): void
}
deviceGateway(stream: Stream, opts: DeviceGatewayOptions): DeviceGateway
```

### 关键决定

1. **子 app 用相对路径。** 四个 mount 函数的路由串从 `/api/...` 改成相对形式（`/devices/...` 等），
   网关把它们挂在一个内部 Hono 上，宿主 `app.route(basePath, sub)`。serve 的 `basePath` 是 `/api`，
   最终绝对路径逐字节不变；`TOKEN_EXEMPT_ROUTES`（访问守卫的豁免表，键是完整路径）因此不用动。
   四个 mount 的测试改为挂到 `/api` 子 app 上再请求，断言原样。
1b. **扩展那几口另走一套固定路径（X2-R1）。** 扩展把 `/api/ext/pair|verify|claimed-tabs|debug-log`
   与 WS `/api/ext` 写死在自己代码里（`extension/src/lib/*`），不跟着宿主的 basePath 走：网关挂在
   `/api/stream` 上时，扩展仍会去打 `/api/ext/verify`，只挂 `app` 就 404、永远连不上。所以网关另出
   一份 `extApp`（`ext-public-routes.ts` 的相对路由 + `extPairHandler`），宿主挂到 `/api`；
   `handleUpgrade` 除 `${basePath}/ext` 外也认 `/api/ext`。`mounts` 把这两份收成一个数组，
   宿主逐条挂就不会漏（serve 的 basePath 就是 `/api`，那几口由 `app.ts` 注册在访问门之前，
   `mounts` 因此只有一条）。桌面端不在其中：它的地址是可配的（`STREAM_HOST_URL`），不需要固定路径。
1b-2. **host agent 的配对口另走一套固定路径（HA）。** host agent 把 `POST /api/devices/pair` 与
   WS `/api/host` 写死在自己代码里（`app/host-agent/src/device.rs` 的 `pair` / `ws_url`），同样不认
   宿主的 basePath——但设备模式的前提恰恰是「机器上只有 agent、没有本机 Stream」，所以不能像桌面端
   那样靠可配地址打发：网关挂在 `/api/stream` 上时，agent 打的就是根上的 `/api/devices/pair` 与
   `/api/host`。照 1b 同一个先例：`devicePairHandler` 从 `mountDeviceRoutes` 提成导出（码即凭据、
   不经 isAdmin、与设备面共用同一份 PairingGuard），网关另出一份 `hostApp`（相对 `/api` 只挂这一条）
   挂到 `/api`；`hostRelayHandler` 加 `alsoPaths`（与扩展中继同名同形），`handleUpgrade` 也认
   `/api/host`。`mounts` 收成三条，宿主逐条挂就不会漏。
2. **握手逻辑不复制。** `attachExtRelay` / `attachHostRelay` 的 upgrade 监听器各抽出一个内部
   `handle(req, socket, head): boolean`（false = 路径不归我），原来的「自挂 server」用法变成
   `server.on('upgrade', (req, s, h) => handle(req, s, h))`，网关的 `handleUpgrade` 直接调两个
   handle。对外导出 `extRelayHandler` / `hostRelayHandler`（回 `{ path, wss, handle }`），
   `attachExtRelay` / `attachHostRelay` 保持原签名不变（别的调用方零改动）。
3. **网关不建存储、不建注册表。** 设备表、绑定表、节点表、身份表来自 `stream.devices`；
   两条注册表来自 `kernel.harvest`——同一个实例里 recipe 派活走的就是它们。
   `ProfileClaims` 的接线（认领码、`onClaim` / `onBindingConnected`）随节点路由一起搬进网关，
   `close()` 一并关。
4. **serve 侧唯一实例。** serve.ts 建一次网关，同一个 io 对象递给 `routes()`（挂 HTTP）与
   `attachRelayServers`（挂 upgrade + 登记 `close()` 的内核 effect）。两个 io 字面量会造成
   两份 claims 接线，所以 serve.ts 改为共享一个 io。
5. **设备自己调的口不经 `isAdmin`**：`/devices/pair` 与 `/ext/pair` 只认一次性配对码，两条 WS
   只认 token——与今天一致；`isAdmin` 只落在签码 / 列设备 / 撤销 / 改绑定 / 对设备下 op 这些
   管理类端点上（原来的 `isLocal` 逐处替换）。

## 上下线事件

两条注册表各加一个监听点：

- `HostRelayRegistry`：`connect()` 时该设备**原来不在线**才发 online（新连接顶掉旧连接不发中间
  offline / 重复 online）；`disconnect()` 只在 live 槽位真的被这条 socket 让出时发 offline
  （被顶掉的旧 socket 关闭是 no-op）。心跳判死走 close → `disconnect`，自然发 offline。
- `ExtRelayRegistry`：同一形状——`connect()` 时 `sockets` 里没有这条绑定才发 online；
  `disconnect()` / `kick()` 在 socket 槽位真的被删时发 offline。

`src/engine/devices.ts` 提供汇点：`openDevices` 建一个 change hub，`wireDeviceChanges(devices, harvest)`
（`createStream` 在 bootstrap 之后调一次）把两条注册表的监听折进统一形状：

```ts
type DeviceChange =
  | { kind: 'device'; deviceId; name; platform; online; at }
  | { kind: 'binding'; bindingId; deviceId; nodeId?; online; at }
```

`stream.devices.onChange(listener) → off`：监听器抛错只记日志，不影响连接。
`stream.devices.online()`：host 侧取注册表 `devices()`（在线的那批），binding 侧取 `statuses()` 里
在线的行。网关未接线前（理论不可达：`createStream` 返回前已接线）回空快照。

## device:<id>/chrome 档

- `cdp-target.ts`：新 scheme `device`，地址 `<deviceId>/chrome[:<tabId>]`（deviceId 含 `:` 不含
  `/`，按第一个 `/` 切）。解析器 `parseDeviceChrome` 校验 `/chrome` 段。
- `cdp-router.ts`：`CdpRouterDeps` 新增 `deviceChrome?: (deviceId) => ChromeSurfaceDeps`——按设备
  给一套 chrome 档依赖；缺席（没有注册表的宿主）时报「这一档不存在」。四个动词在 `device` 档先解析
  设备与 chrome 地址，再走共享库既有的 `chrome*Verb`。读取锁键 `device:${address}`，即
  `device:<id>/chrome[:<tabId>]`；`kind:'login'` 走同一把锁与同一套 stuck 处理。
- `mcp-extras.ts`：`deviceChrome` 按设备取绑定（`extRelays.pick`，选取规则 = 注册表 `pick`：
  默认绑定在线用默认，否则最近连上的）→ `relay(bindingId)` → 按 bindingId 缓存一条
  `InteractiveLane`（骑那条 relay）与 launcher。`DeviceOffline` / `DeviceIncapable` 一律折成
  固定错误码 `device-browser-offline`（`src/devices/errors.ts` 新错误类，嵌入方据此挂起等设备）。
  转发表加一格 `extRelays`（MCP_EXTRAS_DEP_COUNT 51 → 52，agent.test 断言同步）。
- `tool-specs.ts`：`CdpTier` 加 `'device'`，`TARGET_FORM` 与四条 bullet 跟上；chrome-only 的宿主
  不给这一档（现有守卫测试兜着）。

## 测试

网关：挂到测试自建的 http server + Hono（basePath `/api/stream`）走完整链路（签码 → pair → WS
握手 → onChange；替换连接只发一次 online；心跳判死；`handleUpgrade` 对别人的路径返回 false 且不碰
socket；`isAdmin=false` 管理口 403）。serve 不回归靠现有套件。注册表监听点各有单测。cdp 路由：
两台假设备各一条绑定，`device:A/chrome` 只碰 A 的 relay；A 不在线报 `device-browser-offline`；
锁键按新形状生效。
