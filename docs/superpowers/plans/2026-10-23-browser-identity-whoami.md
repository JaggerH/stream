# Browser Identity — Site Identity Implementation Plan (计划 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream 知道每个节点上各 facility 登着哪个账号。包声明 `whoami`（`http` / `page` / `login` 三种形状），宿主在节点上探测，结果写进 `site_identities` 表；节点连上、会话 cookie 变了、手动刷新、`ctx.login` 成功之后各触发一次。

**Architecture:** `whoami` 是 facility 级知识，声明在 `package.json#stream.whoami`（与 `facility`、`credentials`、`network` 同一层；类型 `WhoamiSpec` 住 `src/manifest/types.ts`）。描述符解析时校验形状与 `url` 主机（必须落在 `network.hosts ?? credentials` 内），装载 / 安装时再校验 `login.param` 是该包登录 recipe 的 `secret_params` 之一。纯逻辑在 `src/identity/whoami.ts`（取路径自动解 Vue ref、三态判定、页内表达式、`login` 的哈希与打码）；`src/identity/prober.ts` 按节点串行地跑 `http`（`runOnDevice` 钉住该节点的绑定 → 拉该节点的快照 → `fetchFor` 带 Cookie 头）与 `page`（该节点 relay 上开后台标签、`load` 后读路径、关标签）；`src/identity/identity-store.ts` 是表；`src/identity/identity-service.ts` 是三个触发与「没有 whoami 的 facility 记 `node:<nodeId>`」；`src/kernel/plugins/identity.ts` 接线，`src/http/identity-routes.ts` 出 `GET /api/identities`、`POST /api/identities/refresh`。

**Tech Stack:** TypeScript（Node 22，`tsx`）、zod、better-sqlite3、Hono、vitest。

**Spec:** `openspec/changes/browser-identity/specs/site-identity/spec.md`；`design.md` D5、D6、D10，Spike S3。

**本计划不含：** 执行前核对与按身份路由（计划 4）、面板（计划 5）。

## Global Constraints

- **`unknown` 绝不写表、绝不当成登出。** 打不开、不是 JSON、节点断了、快照里这个域一个 cookie 都没有（没同步过）——都是 `unknown`。
- **`signed-out` 写表并保留上次的账号 id**（显示为「已登出」由界面负责）。
- **`login` 形状不落明文。** 账号 id = 账号 SHA-256 的前 16 位十六进制；显示名 = 打码（`12****78`）。它不探测，只在 `ctx.login` 成功那一刻写。
- **按节点串行**：同一节点上同时只有一个探测在跑（一次一个标签）。
- **说不出节点的连接不进表**：兼容槽 `local` 与没记过节点的配对绑定没有 `nodeId`，身份表以（facility，节点）为键，跳过它们。
- 会话 cookie 变化的触发**不在每次 `cookies-changed` 上开标签**：有会话 cookie 声明的 facility 比对那几个 cookie 值的指纹，变了才探；没有声明的退到最短间隔（10 分钟）。xhs 采集时 cookie 一直在轮换，按事件开标签就是每分钟一张探测标签。
- 测试：`flock /tmp/stream-heavy.lock node_modules/.bin/vitest run <路径>`；全量基线 17 文件 / 34 测试（环境类）。类型检查：根 `node_modules/.bin/tsc --noEmit`、`app/`。

---

### Task 0: 基线

- [x] 全量跑一次，记下失败集（17 文件 / 34 测试，与计划 1 记录一致）。

### Task 1: `whoami` 声明与校验

**Files:** `src/manifest/types.ts`、`src/identity/whoami.ts`(+test)、`src/packages/descriptor.ts`(+test)、`src/replay/recipe-package.ts`、`src/replay/recipe-install.ts`(+test)、`src/replay/recipe-package.declares-knowledge.test.ts`

- [ ] 失败的测试：三种形状解析通过；未知 `kind`、`http` 缺 `id`、`html` 的 `id` 不是带捕获组的正则被拒；`url` 主机不在允许主机内 → 报 `stream.whoami.url`；`login.param` 不在登录 recipe 的 `secret_params` 内（或没有登录 recipe）→ 装载与安装都拒。
- [ ] 实现。Commit `feat(identity): packages declare whoami`。

### Task 2: 探测器

**Files:** `src/identity/whoami.ts`(+test)、`src/identity/prober.ts`(+test)

- [ ] 失败的测试：`readPath` 解 `_value` / `_rawValue`；B 站 `nav` 返回 `mid=123`、`uname=某某` → `signed-in {123, 某某}`；`isLogin:false` → `signed-out`；非 JSON / 5xx / 抛错 → `unknown`；小红书 `userId` 有值但 `loggedIn:false` → `signed-out`；页内表达式在假 `window` 上读出 Vue ref 包着的值；`page` 探测开后台标签、读完关掉（读失败也关）；节点中途断开 → `unknown`；同一节点两次探测串行、不同节点并行；`login` 的哈希与打码。
- [ ] 实现。Commit `feat(identity): probe whoami on a node`。

### Task 3: 身份表与触发

**Files:** `src/identity/identity-store.ts`(+test)、`src/identity/identity-service.ts`(+test)、`src/kernel/plugins/identity.ts`、`src/kernel/plugins/packages.ts`、`src/http/identity-routes.ts`(+test)、`src/bootstrap.ts`、`src/serve.ts`

- [ ] 失败的测试：表——`signed-in` 写入、`signed-out` 保留账号 id、`unknown` 不写、同一账号可在两个节点上；服务——节点连上只探 precheck 为 `PRESENT` 的 facility（`http` 形状没有 cookie 声明时照探，不开标签）、`GONE` 把已有记录标登出、没有 whoami 的 facility 记 `node:<nodeId>` 与「<profile> 上的账号」；cookie 变化——会话 cookie 指纹变了才探、没变不探；手动刷新按节点 / facility 收窄；路由。
- [ ] 实现。Commit `feat(identity): site_identities and its triggers`。

### Task 4: `ctx.login` 之后

**Files:** `src/kernel/plugins/auth.ts`、`src/identity/identity-service.ts`(+test)

- [ ] 失败的测试：登录成功后 `login` 形状直接写（哈希 + 打码，不探测）；`http` / `page` 形状在登录用的那个节点上重新探测；登录失败不写。
- [ ] 实现：`AuthService.onFacilityLogin(fn)`，登录成功后带上这次执行钉住的绑定叫它。Commit `feat(identity): re-identify after ctx.login`。

### Task 5: 三个包补 `whoami`

**Files:** `packages/bilibili/package.json`、`packages/xhs/package.json`、`packages/eastmoney/package.json`、`src/identity/builtin-whoami.test.ts`

- [ ] 失败的测试：三个内置包的描述符带上 S3 结论里的 `whoami`，且过装载校验（eastmoney 的 `zjzh` 在 `eastmoney-login` 的 `secret_params` 里）。
- [ ] 实现：xhs 补 `network.hosts`（它此前没有允许主机，`whoami.url` 无处可落）。Commit `feat(identity): bilibili, xhs and eastmoney say who is signed in`；tasks.md 勾掉计划 3，design.md D5 记下声明位置。
