## Context

主实例常驻在一台始终在线的机器（例：美国加州）。执行端是若干已配对的设备：用户的 PC、手机、家里的
NAS。驱动场景是 `@streamapp/eastmoney`：登录要在大陆网络里的真浏览器里做（图形验证码、站点安全控件
算密码），会话最长 3 小时、掉了由 `ctx.login('eastmoney')` 自动重登，之后的动作是纯 HTTP。

今天后端的几个事实约束了设计：

1. **多设备骨架已在。** `host-registry.ts` 按 `deviceId` 维护 relay，重连是同一台设备，设备之间不互相
   阻塞；`hello` 声明 op 集，driver 只发声明过的 op；设备配对发放专属 device token。
2. **扩展与后端同机绑死。** 扩展只连 `127.0.0.1:8900`；token 经 nativeMessaging 由本机 `stream-desktop`
   读 `data/ext-relay-token` 取得；用之前先挑战应答确认对端知道 token（`backend-identity.ts`）。
3. **登录态按域名一份。** `PushedCookieStore` 落 `data/cookies.json`，整份替换；`CookieProvider.cookieString(domain)`
   是所有取 cookie 处的接缝。
4. **包没有 fetch 注入点。** `PluginContext` 有 `cookieFor`、`login`，没有 `fetch`；eastmoney 的 `client.ts`
   直接调全局 `fetch`。plain-HTTP recipe 走 `ownedFetch`（`owned-outbound.ts`，快照原始 undici fetch）。
5. **任务行通过 `configRef` 指向账号配置 row**，只用于导航，不参与执行；配置 row 的 schema 归包所有。
6. **Rust host-agent 的核心平台无关。** WS 客户端、协议、op 分发在 Linux 上可编译可测；平台相关的
   UIA / AX / 输入在 `cfg` 段里。

## Goals / Non-Goals

**Goals**
- 一个主实例管理所有账号与任务；任务在用户指定的设备上执行。
- 东财的登录、cookie、下单都落在同一台大陆设备上；设备不在线时**零个**请求经 `local` 发往券商。
- 用户 PC 上的 Chrome 在主实例远离 PC 后仍可用，扩展不改。
- 开源用户默认不需要在设备上手工配置任何安全清单。

**Non-Goals**
见 proposal。要点：不探测地区、不自动选设备、不做多账号、不做卫星运行时、RSSHub 不经设备。

## Decisions

### D1. 设备 = 执行位置；能力 = 声明的 op 集

- 后端本机是一个虚拟设备 `local`：始终在线，能力是后端进程自己的（`ownedFetch`、本机 ExtRelay、
  本机 host agent 若有）。它不出现在配对列表里，但出现在绑定下拉里，作为缺省项。
- `HostPlatform` 增加 `linux`。平台只用于展示与默认图标，**调度只看 op**：要派 HTTP 就要求 `http.fetch`，
  要派浏览器类 recipe 就要求设备上有在线的扩展绑定（D7），要派桌面 / 安卓 recipe 沿用 `android-phone-surface`
  的 surface 判定。
- 能力不满足在**派发前**就报出，错误说明「设备 X 没有 Y 能力」，不发任何帧。

**为什么不按平台分支**：手机以后也可能声明 `http.fetch`（用手机网络发请求），PC 也可能。平台分支会
在每加一种设备时改调度。

### D2. 两层绑定与解析顺序

存储：
- 宿主表 `facility_devices(facility TEXT PRIMARY KEY, device_id TEXT NOT NULL)`，住 `data/stream.db`
  用户侧。缺席 = `local`。
- `UserTaskRow.device?: string`，新列。缺席 = 跟随 facility。

解析（每次执行开始时一次，之后不变）：

```
task.device                               // 任务覆盖
  ?? facilityDevice(packageOf(task.action)) // 动作所属包的 facility 默认
  ?? 'local'
```

- 动作所属的 facility：包的 `stream.id`（eastmoney 的包 id 与 facility 同名）。一个包对应多个 facility
  的情况今天不存在；出现时由包在 `package.json#stream` 显式声明 `facility`，本 change 不做。
- `command` 类任务（起本地进程）设置 `device` 时，路由层以 400 拒绝。它只能在 `local` 执行。
- 属于某 facility 的 recipe 源（Stream 采集）按同一顺序解析（没有任务覆盖这一层），所以绑定 facility
  后其采集源自动跟随。

**为什么挂在 facility 而不是配置 row**：facility 把登录 recipe（`session.facility`）、凭据域
（`stream.credentials`）和动作串在一起；配置 row 的 schema 归包所有，宿主不该往里加字段。

**为什么任务覆盖不会造成登录与动作分叉**：见 D3、D4——覆盖改变的是整次执行的设备，登录跟着走，
登录态也按设备分开。

### D3. 执行上下文

- 新模块 `src/devices/run-context.ts`：`AsyncLocalStorage<{ deviceId: string; runId: string; packageId?: string }>`。
  `packageId` 是本次执行所属的包（动作的包、recipe 源的包），供 D6 的主机校验使用。
- 任务中心执行动作、Scheduler 执行采集、MCP / HTTP 触发的 action run，在入口处 `run(ctx, fn)`。
- 上下文内的读取点：`fetchFor()`（D5）、`cookieFor` / `cookiesFor`（D4）、`ctx.login`（在上下文设备上跑
  登录 recipe）、浏览器类 recipe 的 driver 解析（D6）、桌面 recipe 的 driver 解析（已有的 `desktopDriver()`
  改为优先读上下文设备）。
- 没有上下文 = `local`。保证现有调用路径不变。

**为什么用 AsyncLocalStorage 而不是参数透传**：code 包的 `activate` 拿到的 `ctx` 是长寿命对象，按次透传
会改所有包的签名；ALS 让 `ctx.fetch` / `ctx.cookieFor` 的签名不变而行为按次变化。`host-relay.ts` 已在用 ALS。

### D4. 登录态按（设备，域名）

- `PushedCookieStore` 由 `data/cookies.json` 变为 `data/cookies/<deviceId>.json`，每台设备一份，仍整份替换、
  仍 0600。首启迁移：旧文件存在且新目录无 `local.json` 时改名为 `cookies/local.json`。
- `CookiePuller` 按设备实例化：每台有浏览器的设备一个 puller，经该设备当前选中的扩展绑定（D7）拉、写自己的快照。
  `requiredDomains` 只取**绑定到这台设备**的 facility 的域（`local` 取未绑定的全部），避免 NAS 上的 Chrome
  被要求交出与它无关的站点。
- `CookieProvider.cookieString(domain)` 读执行上下文的设备快照。签名不变。
- `ctx.login(facility)` 在上下文设备的浏览器里跑登录 recipe，结束后强制刷新**该设备**的快照。

**为什么不把 cookie 只留在设备上**：那要求 agent 维护 cookie jar 并参与登录态刷新、过期判定，agent 不再薄；
后端本来就是 cookie 的消费端（`pushed-cookie-store.ts` 头注），按设备分文件已足以消除分叉。

### D5. `http.fetch` 与 `fetchFor`

线上协议（host-relay v2 新 op，agent 在 `hello.ops` 里声明 `http.fetch` 才可派）：

```
args:   { method, url, headers: [string, string][], body?: base64, redirect: 'manual' | 'follow',
          timeoutMs, allowHosts: string[] }
result: { status, headers: [string, string][], body: base64, url }
error:  { code: 'host-not-allowed' | 'private-target' | 'timeout' | 'network' | 'too-large', message }
```

- headers 用数组对，保留多值（`set-cookie`）与顺序。响应体上限 10MB，超出报 `too-large`。
- `redirect: 'manual'` 必须原样回 3xx——东财靠 302 判会话失效。
- 后端 `src/devices/fetch.ts`：`fetchFor()` 读执行上下文，`local` → `ownedFetch`；其他设备 → 构造标准
  `Response` 返回。调用方拿到的是同一个 fetch 签名。
- 接入点：`PluginContext.fetch`（新增）、`makeHttpFetch` / `makeHtmlFetch`、eastmoney `client.ts`（各函数
  接收 `fetch` 参数，由 `activate.ts` 传 `ctx.fetch`；`getRepoBid1` 的匿名行情请求同样走它）。
- **不占 UI 会话租约**；每设备独立的 fetch 并发上限 4，排队超时沿用 `HostSessionQueueTimeout` 的语义
  但用独立错误名 `DeviceFetchQueueTimeout`，以免与 UI 租约混淆。
- 可观测：每次设备 fetch 在 debug bus 频道 `device-fetch` 记 `{deviceId, method, host, status, ms}`，
  不记 header 与 body。

### D6. 允许的主机：包声明 + 双重校验 + 设备侧私网拒绝

- `package.json#stream.network.hosts: string[]`（主机名后缀）；缺席 = `stream.credentials`。
  `recipe-package.ts` 白名单与校验；安装闸门的权限展示加一行「会访问这些网站」。
- **后端派发前**：目标主机须匹配**本次执行所属包**（执行上下文里的 `packageId`）的声明。不匹配 →
  `host-not-allowed`，不发帧。随请求下发 `allowHosts`（同一份声明）。没有所属包的执行（宿主自己的出站）
  不能派到非 `local` 设备：它的允许主机为空，任何出站都在派发前以 `host-not-allowed` 失败
  （例如任务行显式设了 `device`、但动作所属的包已经不在——解析出设备，却没有任何主机声明）。
- **agent 收到后**：
  1. 若设备配置了 `ALLOW_HOSTS`，以它为准（覆盖下发的 `allowHosts`）；否则以下发的为准。不匹配 → `host-not-allowed`。
  2. 解析 DNS，任一结果落在 loopback / RFC1918 / 链路本地 / CGNAT（含 Tailscale `100.64/10`）/ ULA → `private-target`。
     **始终开启，不可关闭。** 连接用解析出的那个地址，防 DNS rebinding。
  3. 重定向（`follow` 时）的每一跳重复 1、2。
- `local` 设备不经 agent，沿用后端既有 SSRF 守卫（`owned-outbound-http`），语义不变。

**威胁模型的取舍**：多数用户的后端就是他们自己的机器；后端被攻破时它已握有全部 cookie 与交易密码，
设备被当代理是增量很小的风险。所以默认防护针对「包越界」与「用户内网被打」，不要求用户在设备上配清单；
不信任后端的运维者用 `ALLOW_HOSTS`。

### D7. 扩展绑定：扩展与 Stream 实例多对多，每条绑定挂在一台设备上

```
 用户 PC 的 Chrome + Stream 扩展
   ├ 绑定 A：本机 Stream  ws://127.0.0.1:8900   token 经 native host   → 设备 local（该实例的）
   └ 绑定 B：主实例      wss://main.example     token 经配对码         → 设备 PC（主实例上已配对的 agent）

 主实例
   ExtRelayRegistry: Map<bindingId, ExtRelay>
     ├ local      ← 本机扩展（native host 信任链，今天的行为）
     ├ ext:<uuid> → 设备 PC
     └ ext:<uuid> → 设备 NAS（NAS 上用户自己开着的 Chrome）
```

一个扩展可以绑定多个 Stream 实例；一个 Stream 实例可以绑定多个扩展。**扩展直连每个实例**，agent 不转发浏览器。

**绑定的两种来源**
- **本机绑定**：今天的路径原样保留——探测 `127.0.0.1:8900/8907`，token 由 native host 带外交出，挑战应答通过才连。
  在该实例上它挂在 `local`，不落盘，`bindingId = 'local'`。
- **配对绑定**：用户在 Stream 面板上**为某台设备**签发一次性扩展配对码（码里记着目标 `deviceId`，5 分钟、一次性，
  与设备配对码同一套限流），在扩展 popup 里填实例地址 + 码，`POST /api/ext/pair` 换回 `{ bindingId, token }`。
  一台设备可以挂多个扩展。签发同设备配对码一样只对实例本机请求开放。

**存储**
- 实例侧：`data/ext-bindings.json`，行 `{ bindingId: 'ext:<uuid>', deviceId, name, browser, platform, tokenHash, pairedAt, lastSeenAt }`，
  只存 token 的哈希，定长比较——与 `DeviceStore` 同样的规矩。设备被撤销时，挂在它上面的绑定一并撤销。
- 扩展侧：`config.bindings: [{ id, baseUrl, token, label, kind: 'local' | 'paired', domains, requiredDomains, autoSync, revoked? }]`，
  取代单个 `baseUrl` / `domains`。旧配置首启迁成一条本机绑定。本机绑定的 token 不落盘（每次经 native host 取）。

**信任**
- 配对绑定的 token 经配对得到之后，**每次连之前仍先挑战应答**（`verifyBackend` 用该绑定的 token），对端证明不了就不连、不推 cookie。
  地址被劫持也拿不到 token。
- 配对时 token 走网络一次：扩展接受 `http://` 与 `https://`。远程明文地址照配，但 popup 明说不加密（token 与之后交出的 cookie 路上可见）；内网 / Tailscale 下代价基本不存在，公网请用 HTTPS。
- 远程实例能要的东西必须由用户点头：**配对绑定的 `requiredDomains` 不自动生效**——实例新要一个域名，扩展把它挂成「待批准」，
  用户在 popup 里批准之后才同步、才允许经 relay 拉取该域 cookie。本机绑定照旧自动生效（同机、同用户，信任不变）。

**隔离：一个 Chrome 同时服务几个实例**
- 扩展的 driver 从模块级单例改成**每条绑定一个会话**：自己的 WS、退避、会话标签组（组名带绑定的 label）、tab 归属账本。
- 一张 tab 至多属于一条绑定的组。命令里引用了不属于本绑定组的 tab，扩展以错误拒绝——实例 A 驱动不了实例 B 的 tab，也借不走用户
  拖进 B 组的 tab。`chrome.debugger` 的附着天然按 tab，组不相交就不冲突。
- cookie 按绑定取：实例经该绑定的 relay `cookiePull`，扩展只交出该绑定范围内（批准过）的域、其余明说 `refused`；
  实例收下后写入**绑定所挂设备**的快照 `data/cookies/<deviceId>.json`（D4）。`cookieNames` 同样限在范围内。
- 撤销：实例删掉绑定后以专用关闭码断开 WS；扩展把该绑定标 `revoked`、停止重连，popup 里显示「已被撤销」。

**实例侧**
- `ExtRelay` 从单例变为 `ExtRelayRegistry`；每条在线绑定一条 relay，hop timing、标签组、tab 归属逻辑不变。
- 浏览器能力：**设备 X 有浏览器 ⇔ 至少一条挂在 X 上的绑定在线**。不再是 agent 的 `hello` op（D1 的「浏览器通道」即指此）。
- 选哪一个：执行上下文设备上在线的绑定里，取设备的默认绑定（面板设置，计划 4），没设则取最近连上的那条；选中的 `bindingId`
  在本次执行内固定，写进运行记录。设备上没有在线绑定 → 派发前 `device-incapable`（绑定存在但都离线 → `device-offline`）。
- 现有 `extRelayStatus` / `browserCapability` 等状态接口保留 `local` 那条的语义，另加一个列出全部绑定的接口给面板用。

**为什么扩展直连而不经 agent 转发**：多对多之后，经 agent 转发要让 agent 也扇出到多个实例，并在本机抢 8900（与本机 Stream 冲突）；
扩展本来就要改成存一组绑定，直连少一跳、少一套帧封装。**为什么绑定挂在设备上而不是自成设备**：东财要求登录与之后的
`http.fetch` 从同一个网络发出，设备是唯一的执行位置单位（D1、D2）；让扩展自成设备会把一台 PC 拆成两台，这条保证就要靠用户自己对齐。
代价是：没有 agent 的机器上的 Chrome 不能单独作为执行位置——要先在那台机器上配对 agent。

### D8. Linux 无界面 agent

- `app/host-agent` 新增 Linux 构建：只编入 relay 与 `http.fetch`（`reqwest` + rustls，自定义 resolver 做 D6 的地址检查）。
  `hello.platform = 'linux'`，`ops = ['http.fetch']`。浏览器不经 agent（D7）：那台机器上用户自己开的 Chrome 以配对绑定挂到这台设备。
- 设备 id 与配对：配对请求体增加 `platform`，返回 `<platform>:<uuid>`；首次启动读环境变量
  `STREAM_MAIN_URL` 与 `STREAM_PAIRING_CODE` 完成配对，device token 写 agent 数据卷，之后不再需要配对码。
  开关不叫 `STREAM_BACKEND_URL`：那个名字已经是 CLI/MCP 的本机后端地址，且会被后端 spawn 的本机 agent 继承，
  拿它触发设备模式会让本机工作台的 agent 误入设备模式（非 Linux 上直接退出）。
- 不发布容器镜像。agent 与浏览器各自由用户装在设备上；agent 以 `STREAM_MAIN_URL` + 配对码起，Chrome 装扩展后配对绑定。
- 网络可达交给部署：设备与扩展都主动外连，设备侧不开入站端口；主实例须对它们可达（Tailscale 或公网 HTTPS + token）。

### D9. 失败语义

| 时机 | 错误 | 是否已发出动作 | 自动重试 |
|---|---|---|---|
| 派发前设备不在线 | `device-offline` | 否 | 按任务 `maxAttempts` |
| 派发前能力不足 | `device-incapable` | 否 | 否（配置错误） |
| 派发前主机不允许 | `host-not-allowed` | 否 | 否（配置错误） |
| 执行中途断连 / 设备 fetch 超时 | `device-lost` | 可能 | **否**，发通知，运行记录标「状态未知」 |
| 用户在设备上中止 | `HostAbortedByUser`（已有） | 可能 | 否 |

- **任何一种都不回落 `local`。** 实现上 `fetchFor` 在非 `local` 设备上没有任何调用 `ownedFetch` 的分支。
- `device-lost` 与 `HostAbortedByUser` 同理：动作可能已下了一半单，重跑就是重复下单。
- 运行记录增加 `deviceId`；面板运行记录显示设备名。

## Risks / Trade-offs

- **跨洋延迟**：设备 fetch 每次多一个往返（加州↔大陆约 200ms）；CDP 交互频繁，一次登录预计数十秒。
  登录每 3 小时最多一次，可接受；远程设备的 op 超时阈值需放宽，按设备 RTT 计。
- **ALS 漏传**：某条执行路径忘了 `run(ctx)` 会静默落到 `local`。缓解：任务中心与 Scheduler 的入口各一个测试，
  断言绑定到设备 X 的执行里 `fetchFor` 解析为 X；守卫测试禁止 code 包直接调全局 `fetch`。
- **cookie 迁移**：迁移失败会让用户看起来「掉登录」。迁移只改名不改内容，失败时保留旧文件并告警。
- **远程实例拿 cookie**：配对绑定的实例能请求任意域名。缓解：配对绑定的新域名需在 popup 里逐个批准（D7），
  relay 的 cookie 拉取同受此限；撤销绑定立刻断开。
- **一个 Chrome 多个实例抢焦点**：交互式 recipe 开前台 tab，两个实例同时跑会互抢窗口焦点。组与 tab 已隔离，
  焦点不隔离；先接受，运行记录里能看到是哪条绑定。
- **扩展 SW 常驻多条 WS**：每条绑定一条，退避各自独立；一条绑定反复失败不影响其他绑定。
- **扩展 driver 重构面大**：`driver.ts` 的模块级状态（标签组、归属账本、socket、退避）要收进按绑定的会话对象。
  本机绑定的行为必须与今天逐字节一致——现有 driver 测试全部按 `local` 那条绑定继续跑，作为回归闸门。

## Migration

1. 首启：`data/cookies.json` → `data/cookies/local.json`；`facility_devices` 建表为空；`user_tasks` 加 `device` 列为空。
   所有行为与升级前一致（全部解析为 `local`）。
2. 扩展首启：旧的单个 `baseUrl` / `domains` 迁成一条本机绑定，行为不变。
3. 用户配对 NAS 的 agent，再在 NAS 的 Chrome 里用为 NAS 签发的扩展配对码绑定主实例，在东财卡片上选「默认设备：NAS」。
   下一次东财任务在 NAS 上执行；首次需要在 NAS 的 Chrome 上登录一次（或等自动重登）。
4. 删除 `openspec/changes/package-egress-proxy/`。

## Open Questions

- 设备 RTT 的测量方式（WS ping 往返）与超时放宽的系数，留给实施计划定具体数值。
- ~~配对只接受 HTTPS 或回环~~（2026-10-22 放开）：自建的 Stream 多半没有证书，只收 HTTPS 把它们全挡住了。改为 HTTP 也配、远程明文时在 popup 提示不加密，不设开关。
