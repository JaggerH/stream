# Browser Identity — Nodes Implementation Plan (计划 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一台机器上多个 Chrome profile 的扩展同时连本机 Stream、互不顶替；Stream 记下每个扩展实例（节点）在哪台设备上；一次执行选定一个节点后，浏览器命令与登录态读取整次执行都落在它上面；登录态从按设备一份变成按节点一份。

**Architecture:** 扩展在 `chrome.storage.local.node` 生成 `nodeId`，WS 升级请求的 query 带上它（与 `extVersion` 那三格同一条路）。后端 `/api/ext` 的本机 token 带 `nodeId` → 绑定 `local:<nodeId>`，不带 → 兼容槽 `local`；配对 token 第一次带 `nodeId` 时记进绑定行，之后换一个来连以 4004 拒绝。`ExtRelayRegistry` 本机按节点各一条 relay，`pick('local')` 与远程设备同一套「默认节点 → 最近连上」，没有在线的退回兼容槽（不抛，行为同今天）。`registry.local` 变成 `LocalExtRelay` 门面：每次调用经 `pickBrowser` 解析到具体 relay，执行内钉住。新表 `browser_nodes`（`NodeStore`）在节点连上时建行，承接「设备默认浏览器」。登录态的槽位从 `deviceId` 变成 `deviceId/nodeId`（`data/cookies/<deviceId>/<nodeId>.json`），`CookieProvider` 经一个回填的解析器读本次执行选定节点的槽位。

**Tech Stack:** TypeScript（Node 22，backend `tsx`）、better-sqlite3、vitest；扩展 WXT + vitest。

**Spec:** `openspec/changes/browser-identity/`——`specs/browser-node/spec.md`（节点、本机多节点、配对绑定只属于一个节点）、`specs/device-browser-relay/spec.md`、`specs/device-scoped-credentials/spec.md`（按节点的快照）、`specs/device-execution/spec.md`（整次执行留在同一节点、运行记录）；`design.md` D1、D2、D10、D12。

**本计划不含：** profile 认领（计划 2）、`whoami` 与身份表（计划 3）、身份 / 环境目标（计划 4）、面板的节点列表与 popup 的 profile 显示（计划 5）。`profileDir` / `profileName` 只打通管道：扩展存储里有就带上，后端有就记下。

## Global Constraints

- **兼容槽的行为一字不变。** 不带 `nodeId` 的连接落 `local`，`ExtRelay.connect` 照旧以最新为准；没有任何节点时，所有调用路径与升级前一致（`pick('local')` 返回 `local`、`cookies/local.json`）。
- **`nodeId` 进文件路径和绑定 id**：后端只收 `^node_[A-Za-z0-9-]{1,59}$`，不合格按「没带」处理。
- **门面只经 `pickBrowser` 解析**，不缓存结果。执行内（上下文在 `local`）第一次解析钉在 `browser.bindingId` 上；执行外取本机默认节点。上下文在远程设备上时门面仍只解析本机（`registry.pick('local')`，不钉）——「local」不因为在远程执行里被调用就变成远程。
- **钉住只钉在线的。** 本机没有在线节点时 `pick('local')` 回 `local`（兼容槽），这一刻不钉：`ensureHarvestBrowser` 唤起 Chrome 之后连上来的节点要能接住这次执行。
- 关闭码：`4004` = 这条配对绑定属于另一个节点。扩展收到后停止重连，popup 显示「这条绑定属于另一个 profile」。
- `claimed-tabs` 本机节点带 `?node=<nodeId>`（不是 `binding=local:…`）：老后端不认 `node`，回它的本机全集，不会把在跑的标签当孤儿收掉。新后端对本机节点的回答里并上兼容槽认领的标签（宁可漏关不可误关）。
- 快照不迁移（D10）：节点连上时 `CookiePuller` 全量拉一次。槽位解析在节点都离线时退到该设备的默认节点、再退到最近见过的节点，都没有才读按设备的旧文件——Chrome 关着时纯 HTTP 执行照常有登录态。
- 测试：后端 `flock /tmp/stream-heavy.lock node_modules/.bin/vitest run <路径>`；扩展 `extension/node_modules/.bin/vitest run`。类型检查：根 `node_modules/.bin/tsc --noEmit`、`extension/` 与 `app/` 各自 `tsc --noEmit`。

## Review Focus

1. **一次执行内所有 relay 调用落在同一节点**（Risks）：Task 4 用两个本机节点、执行到一半第二个连上，断言门面的每次调用、cookie 读取都落在第一个。
2. **兼容槽不变**：只有老扩展时，`pick` / 门面 / cookie 槽位与今天逐条一致（Task 3、6 钉住）。
3. **4004 不误伤**：同一节点重连、老扩展不带 `nodeId` 照常放行；只有已记节点且带了不同 `nodeId` 才拒（Task 5）。
4. **cookie 槽位的离线回退**：本机节点全离线时不读兼容槽的旧文件，而读默认 / 最近见过的节点（Task 6）。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `shared/browser-relay/handshake.ts` | `ExtHandshake` 加 `nodeId` / `profileDir` / `profileName`；`cleanNodeId` |
| `shared/browser-relay/relay.ts` | `attachExtRelay` 的 `resolveToken(token, handshake)` 可回 `{ close, reason }`（升级后以该码关闭） |
| `extension/src/lib/node.ts`（新） | `getNode()`：生成 / 读 `chrome.storage.local.node`；`nodeQuery()` |
| `extension/src/lib/driver.ts` | WS URL 带 query；`claimed-tabs?node=`；4004 → `foreignNode` |
| `extension/src/lib/config.ts`、`entrypoints/popup/BindingsPanel.tsx` | `Binding.foreignNode`；popup 文案 |
| `src/devices/node-store.ts`（新） | `browser_nodes` 表；`seen` / `get` / `forDevice` / `byBinding` / 默认节点 |
| `src/devices/ext-binding-store.ts` | 行加 `nodeId`；`recordNode` |
| `src/http/ext-relay-registry.ts` | 本机按节点；`bindingsOf` / `pick('local')`；`nodeOf`；`LocalExtRelay` 门面 |
| `src/devices/placement.ts` | `pickBrowser` 在 `local` 上走 `reg.pick`，只钉在线的 |
| `src/kernel/plugins/harvest.ts` | 兼容槽 relay + 门面；本机节点 relay 接能力缓存；`ensureHarvestBrowser` 按设备判 |
| `src/serve.ts` | `resolveToken` 按 `nodeId` 给绑定、记节点、4004；`NodeStore` 接线；默认浏览器路由 |
| `src/http/ext-binding-routes.ts` | 默认浏览器落到节点 |
| `src/credentials/pushed-cookie-store.ts` | 槽位 `deviceId/nodeId` → `cookies/<deviceId>/<nodeId>.json` |
| `src/credentials/cookie-slot.ts`（新） | 本次执行读哪个槽位 |
| `src/credentials/device-cookie-pullers.ts` | 按槽位缓存 puller，经该节点的绑定拉 |
| `src/credentials/cookie-provider.ts` | 缓存按槽位；`setSlotResolver` |
| `src/kernel/plugins/auth.ts` | 每条绑定连上 / cookie 变了 → 拉它那个槽位 |
| `src/tasks/user-tasks.ts`、`src/tasks/run-history.ts` | 运行记录带 `nodeId` / `profileName` / `environment` |

---

### Task 0: 基线

- [ ] 后端全量、扩展全量、三处 tsc 各跑一次，记下失败集（后端已知 17 个文件 / 34 个测试，环境类）。

### Task 1: 扩展的 nodeId 与握手

**Files:** `shared/browser-relay/handshake.ts`(+test)、`extension/src/lib/node.ts`(+test)、`extension/src/lib/driver.ts`

- [ ] 失败的测试：`parseExtHandshake('/api/ext?nodeId=node_x&profileDir=Default&profileName=工作')` 三格都在；`nodeId=../etc` 被丢掉；`getNode()` 首次生成 `node_<uuid>` 并落盘、第二次读回同一个；`nodeQuery` 只带存储里有的格。
- [ ] 实现；`connect` 的 wsUrl 拼 query（本机与配对都带）。
- [ ] Commit `feat(extension): a node id per profile, sent on every handshake`。

### Task 2: `browser_nodes` 与 `NodeStore`

**Files:** `src/devices/node-store.ts`(+test)

- [ ] 失败的测试：`seen` 建行 / 再见更新 `last_seen_at` 与绑定、不清掉已有的 profile 字段；`forDevice`；`setDefault` 同设备互斥；`defaultOf`；`seen({ legacyDefault: true })` 把默认迁到节点（同设备已有默认节点时不抢）；重新打开库数据仍在；列含 `woken_at` / `label` / `environment`。
- [ ] Commit `feat(devices): browser_nodes`。

### Task 3: 本机多节点

**Files:** `shared/browser-relay/relay.ts`、`src/http/ext-relay-registry.ts`(+test)、`src/devices/placement.ts`(+test)、`src/serve.ts`、`src/kernel/plugins/harvest.ts`、`src/http/app.ts`

- [ ] 失败的测试：registry——两个 `local:*` 同时在线互不顶替、各自在途命令不受影响；`bindingsOf('local')` = 全部 `local:*` + `local`；`pick('local')` 默认节点 → 最近连上 → 都不在线回 `local`；`hasBrowser('local')` 任一在线；`deviceOf('local:x') = local`。attachExtRelay——`resolveToken` 拿到握手、回 `{ close: 4004 }` 时升级后以 4004 关闭且不 connect。pickBrowser——`local` 上钉在线的、不钉离线兜底。
- [ ] 实现；serve 的 `resolveToken` 按 `nodeId` 给 `local:<nodeId>`；registry 连上时回调 `onNodeSeen` 写 `NodeStore`；`claimed-tabs?node=`。
- [ ] Commit `feat(devices): one relay per local node`。

### Task 4: `registry.local` 门面

**Files:** `src/http/ext-relay-registry.ts`(+test)、`src/kernel/plugins/harvest.ts`、`src/kernel/plugins/auth.ts`

- [ ] 失败的测试：门面每次调用经 `pickBrowser` 解析；执行外取默认节点；**一次执行里第二个节点中途连上，门面的每一次调用都落在第一个**；`onConnected` / `onCookiesChanged` / `onEvent` 扇出到全部本机 relay（含之后才连上的）；`connected` / `status` 按解析结果。
- [ ] 实现；harvest 的 `extRelay` = 门面，`transport` / `extLauncher` 建在门面上，兼容槽的 relay 只交给 registry。
- [ ] Commit `feat(devices): registry.local resolves a node per call`。

### Task 5: 配对绑定只属于一个节点

**Files:** `src/devices/ext-binding-store.ts`(+test)、`src/serve.ts`、`extension/src/lib/driver.ts`、`extension/src/lib/config.ts`、popup

- [ ] 失败的测试：store `recordNode` 落盘；serve 的 token 解析（抽成 `resolveExtToken` 纯函数）：首次记、同节点放行、换节点 4004、不带 `nodeId` 放行；扩展收到 4004 标 `foreignNode`、不再重连。
- [ ] Commit `feat(devices): a paired binding belongs to one node`。

### Task 6: 登录态按节点

**Files:** `src/credentials/pushed-cookie-store.ts`(+test)、`cookie-slot.ts`(+test)、`device-cookie-pullers.ts`(+test)、`cookie-provider.ts`(+test)、`src/kernel/plugins/auth.ts`、`src/kernel/plugins/credentials.ts`、`src/bootstrap.ts`

- [ ] 失败的测试：槽位 `local/node_a` 落 `cookies/local/node_a.json`、0600；`local` 仍是 `cookies/local.json`；两个节点的快照互不覆盖；槽位解析——执行内钉住的节点、执行外默认节点、全离线退到默认 / 最近见过的节点、没有节点读设备旧文件、兼容槽读旧文件；puller 按槽位缓存、经该节点的绑定拉；`CookieProvider` 按槽位缓存。
- [ ] 实现；auth 的「连上 / cookie 变了」改为按绑定拉它的槽位。
- [ ] Commit `feat(credentials): one cookie snapshot per node`。

### Task 7: 运行记录带节点

**Files:** `src/tasks/user-tasks.ts`(+test)、`src/tasks/run-history.ts`(+test)、`src/serve.ts`

- [ ] 失败的测试：用过浏览器的执行（本机节点或远程节点）明细带 `node` / `profileName` / `environment`；兼容槽 / 没用浏览器的本机执行明细形状不变；run-history 读出三格。
- [ ] Commit `feat(tasks): run records name the node`，tasks.md 勾掉计划 1。
