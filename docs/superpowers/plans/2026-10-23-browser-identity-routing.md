# Browser Identity — Routing by Identity Implementation Plan (计划 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** facility 的默认目标与任务覆盖可以是设备、身份或环境。身份 / 环境目标在执行开始时解析到一个节点（在线优先、最近核对优先），节点决定设备与扩展绑定；节点都离线时经 host agent 静默唤起 profile；派发任何动作前在该节点上核对身份；用完把唤起的 profile 收回去。没有可用节点就 `identity-offline`，**没有任何回落分支**。

**Architecture:** `Target`（`src/devices/target.ts`）三种；`facility_devices` 重建为 `device_id` / `account_id` / `environment` 三选一（CHECK 约束），`scheduled_tasks` 加 `identity` / `environment` 两列。解析分两层：`placement.ts` 的 `placeRun` 把目标变成 `RunPlacement`——设备目标照旧同步，身份 / 环境目标交给 `IdentityRouter`（`src/identity/identity-router.ts`）。路由器选节点、唤起（单节点单飞、等 30 秒）、按住 profile（`holdProfile`）、核对（新鲜度窗口：采集 10 分钟、动作 60 秒，经 `ctx.siteIdentities.verify`）、交出 `release`。`RunPlacement` 多三格：`facility`（嵌套执行复用同一 placement 的判据）、`identity`（`{facility, accountId, accountName, nodeId}`）、`release`（`runOnDevice` 在 finally 里叫）。`makeFacilityPlacement` 改为异步；调度器、ReplayAdapter、任务中心都 `await` 它。扩展加两个 op：`holdProfile`（执行期间关最后一张标签不关窗：换成 about:blank 留着）与 `releaseProfile`（关自己的标签与只装着自己标签的窗；一扇窗都没有就造一扇不聚焦的再关，换 profile 卸载；报告用户窗口数）。

**Tech Stack:** TypeScript（Node 22，`tsx`）、better-sqlite3、Hono、vitest；扩展 WXT + vitest。

**Spec:** `openspec/changes/browser-identity/specs/identity-routing/spec.md`、`specs/device-execution/spec.md`、`specs/device-browser-relay/spec.md`；`design.md` D7、D8、D9、D11、D12，Spike S2。

**本计划不含：** 面板与 popup（计划 5）。MCP 的 `run_action_recipe` 不做身份路由：它今天只拿 placement 判「能不能在本机跑」、不进执行上下文，所以 facility 目标是身份 / 环境时它 fail closed（`identity-offline`，不在默认节点上顶替）。

## Global Constraints

- **没有回落分支。** 身份 / 环境目标的候选为空、唤不起、没装路由器（身份表打不开）——一律 `identity-offline`，不读设备默认、不回 `local`。测试断言另一个在线节点上一条帧都没有。
- **S2 已在 Windows 通过**：定时执行也唤起，`--no-startup-window` 显式写进 `args`（带 `exe` 时 host agent 不补默认参数）。
- **三种错误都在派发前**：`identity-offline`（可重试，并声明「环境没就绪」——采集本轮跳过）、`identity-mismatch` / `identity-signed-out`（`failureDisposition` = final）。`identity-signed-out` 声明 `failureCategory: 'auth'`，采集里落进已有的「需要登录」。
- **核对只在 `http` / `page` 形状上做**；没有 `whoami` 与 `login` 形状不核对（D9）。`unknown` 不写表，按 `identity-offline`。
- **只碰 Stream 的东西。** `releaseProfile` 只关会话组里出身为 created / probe 的标签；`adopted` 只交还；含非 Stream 标签的窗一律不关，计为用户窗口，`woken_at` 随之清空。
- **唤起的 profile 按节点计数**：同一节点上并发的执行全部结束才 `releaseProfile`。核对失败也要放掉。
- 测试：`flock /tmp/stream-heavy.lock node_modules/.bin/vitest run <路径>`；全量基线 17 文件 / 34 测试（环境类，本计划开工时复核一致）。类型检查：根 `node_modules/.bin/tsc --noEmit`、`app/`、`extension/`。

---

### Task 0: 基线

- [x] 后端全量：17 文件 / 34 测试失败（与计划 1、3 记录一致）。

### Task 1: 三种目标

**Files:** `src/devices/target.ts`(+test)、`src/devices/facility-devices.ts`(+test)、`src/devices/placement.ts`、`src/tasks/task-store.ts`(+test)、`src/http/task-routes.ts`(+test)、`src/http/device-routes.ts`(+test)、`src/serve.ts`

- [x] 失败的测试：`facility_devices` 旧表（`device_id NOT NULL`）原地升级、数据还在；三选一（CHECK）；`target()` / `targets()`；`list()` 只列设备目标（cookie 域反查不变）；任务行 `identity` / `environment` 读写；路由——任务给两个以上目标 400、`command` 任务给任一 400；`PUT /api/devices/bindings/:facility` 收 `{deviceId}` / `{accountId}` / `{environment}`（恰好一个），老的 `{deviceId}` 照旧；身份必须在身份表里见过，环境必须是某个节点的环境。
- [x] Commit `feat(devices): identity and environment targets`。

### Task 2: 解析器

**Files:** `src/devices/errors.ts`(+test)、`src/devices/run-context.ts`(+test)、`src/devices/placement.ts`(+test)、`src/identity/identity-router.ts`(+test)、`src/scheduler.ts`、`src/adapters/replay/adapter.ts`、`src/tasks/user-tasks.ts`、`src/kernel/plugins/{identity,adapters,scheduling}.ts`、`src/bootstrap.ts`、`src/serve.ts`

- [x] 失败的测试：身份候选 = 该身份 `signed-in` 的节点，在线优先、同为在线取最近核对；环境候选 = 该环境里该 facility `signed-in` 的节点；选中节点预填 `browser.bindingId` 与 `identity`；候选为空 / 都离线且唤不起 / 没装路由器 → `IdentityOffline`；`runOnDevice` 在 finally 叫 `release`、同一 placement 再进不叫第二次；`makeFacilityPlacement` 在同 facility 的执行里复用外层 placement；`failureDisposition` 认身份错误。
- [x] Commit `feat(identity): resolve identity and environment targets to a node`。

### Task 3: 按需唤起

**Files:** `src/identity/identity-router.ts`(+test)、`src/devices/node-store.ts`(+test)、`src/kernel/plugins/harvest.ts`

- [x] 失败的测试：候选全离线、有 `profile_dir`、设备 agent 在线且有 `ensureApp` → 发 `{profileDirectory, force:true, args:['--no-startup-window']}`，本机带采集浏览器的 `exe`；等到节点连上就用它、记 `woken_at`；30 秒没连上 → `IdentityOffline`；同一节点并发两次只唤起一次；没有 `profile_dir` / agent 离线 / 没有 `ensureApp` → 不唤起。
- [x] Commit `feat(identity): wake a profile that is not open`。

### Task 3a: 收尾

**Files:** `extension/src/lib/driver.ts`、`extension/src/lib/driver.release.test.ts`（新）、`shared/browser-relay/relay.ts`、`src/identity/identity-router.ts`(+test)、`src/devices/node-store.ts`

- [x] 失败的测试（扩展）：`holdProfile` 后关最后一扇窗里的最后一张自建标签 → 标签留着换成 about:blank、窗不关；没 hold 照旧关；`releaseProfile`：只装着自建标签的窗被关、用户窗里只关自建标签、`adopted` 只交还；一扇窗都没有 → 造一扇不聚焦的窗再关；回 `{closedTabs, userWindows, unloading}`。
- [x] 失败的测试（后端）：`woken_at` 非空的节点在执行开始时 hold、全部执行结束后 release；并发两次只在最后一次结束时 release；release 报用户窗口或 unloading → 清 `woken_at`；release 失败 → `woken_at` 留着；从没被唤起的节点不 hold 不 release。
- [x] Commit `feat(identity): put a woken profile back`。

### Task 4: 执行前核对

**Files:** `src/identity/identity-router.ts`(+test)、`src/identity/identity-service.ts`(+test)

- [x] 失败的测试：记录在窗口内（采集 10 分钟、动作 60 秒）不核对；窗口外核对——一致放行并带上显示名、另一个账号 → `IdentityMismatch`、登出 → `IdentitySignedOut`、`unknown` → `IdentityOffline`；没有 whoami / `login` 形状不核对；核对失败时 hold 过的 profile 照样放掉；`service.verify` 只问一个 facility 并落表。
- [x] Commit `feat(identity): verify who is signed in before a run`。

### Task 5: 通知与运行记录

**Files:** `src/identity/identity-router.ts`(+test)、`src/tasks/user-tasks.ts`(+test)、`src/tasks/run-history.ts`(+test)

- [x] 失败的测试：换号发 `identity.mismatch`，标题指名 profile 与环境；登出发 `auth.needed`（与「需要登录」同一类事件、按节点去重），指名 profile；运行记录明细带 `accountId` / `accountName`，run-history 读出。
- [x] Commit `feat(identity): name the profile in identity notices; runs record the account`。

### Task 6: 端到端

**Files:** `src/identity/routing.e2e.test.ts`（新）

- [x] 两个本机节点（真 `ExtRelayRegistry` + 真 `ExtRelay`，假 socket）、两个账号（真 `SiteIdentityStore` / `NodeStore`）、真路由器 + 真 `compileUserTask`：指定身份的任务经门面开标签，帧落在对的节点上；把那个 profile 里的账号换掉（核对回另一个账号）→ `identity-mismatch`，动作没被调用、两个节点都没收到帧；身份所在节点离线且唤不起 → `identity-offline`，另一个在线节点上没有任何帧。
- [x] Commit `test(identity): route by identity end to end`；tasks.md 勾掉计划 4。
