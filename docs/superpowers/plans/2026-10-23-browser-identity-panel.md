# Browser Identity — Panel & Popup Implementation Plan (计划 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 计划 1–4 的节点、认领、身份表、按身份路由今天只能用 `curl` 用。本计划把它们放进面板与扩展 popup：设备页每台设备下列出节点（profile、环境、在线、默认），可「识别 profile」，有身份表，列出「Stream 在后台打开着的 profile」；facility 默认目标与任务覆盖可以选设备 / 身份 / 环境；运行记录显示 profile、环境、账号；popup 顶部显示「<环境> · <profile 名>」。

**Architecture:** 后端只补一口读：`GET /api/devices/nodes` → `{ nodes: [BrowserNode & { online }], claimable: string[] }`（`claimable` = 此刻能「识别 profile」的扩展设备 id：host agent 在线且声明了 `browser.claim`；本机的桌面 agent 记作 `local`）。面板：`DevicesSettings` 顶上加「本机」卡（本机节点 + 识别 profile），配对设备卡下的浏览器行并上节点信息；节点行可改名字与环境（预置「工作」「个人」+ 自定义）；新组件 `ProfileClaimButton`（start → 轮询 → 每个 profile 一行结果）、`IdentitiesSettings`（身份表 + 刷新）、`WokenProfiles`。目标选择器统一成一个带分组的下拉（`TargetSelect`：设备 / 身份 / 环境），`FacilityDevicesSettings` 与 `TaskEditor` 共用。`runWhere` 并上 profile / 环境 / 账号。popup 读自己的 `chrome.storage.local.node`，再问本机后端的节点表取环境。

**Tech Stack:** TypeScript、Hono、vitest；面板 React（`app/`）+ testing-library；扩展 WXT + React + vitest。

**Spec:** `openspec/changes/browser-identity/`——`design.md` D3、D4、D7、D8（看得见）、D12、D13；`specs/browser-node`、`specs/site-identity`、`specs/identity-routing`。

## Global Constraints

- **不留一个点了没反应的键。** 「识别 profile」只在 `claimable` 里有这台设备时出现；身份 / 环境在下拉里没有可选项时整组不出现；身份表的「刷新」在身份服务不可用（503）时不画。
- **前端不复刻后端判据。** 身份目标是否合法、环境是否存在、任务三选一，后端 400 原话显示。
- **身份 / 环境目标的行没有 `deviceId`**（计划 4：带个 `local` 就是在说它在本机跑）。面板据此判「绑到了哪」，不把缺席的 `deviceId` 当本机。
- 任务整行回写（`saveTask`）必须带上 `device` / `identity` / `environment`——漏了就是一次「暂停」把执行位置清掉（今天 `device` 就漏了，顺手修）。
- 认领与发现只认本机请求：远处打开面板点「识别 profile」得 403，按钮照常显示，后端原话显示在卡片下。
- 面板文案中文。测试：后端 `flock /tmp/stream-heavy.lock node_modules/.bin/vitest run <路径>`；面板 `app/node_modules/.bin/vitest run`；扩展 `extension/node_modules/.bin/vitest run`；三处 tsc。构建：`PANEL_ENTRY=manage|main … vite build --config vite.panel.config.ts`、扩展 `wxt build`。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/http/node-routes.ts`(+test) | `GET /api/devices/nodes` |
| `src/serve.ts` | 接线：`online` 判据、`claimable` |
| `app/src/lib/api.ts` | `NodeRow`、`ClaimSnapshot`、`IdentityRow`、`FacilityTargetRow`；`api.nodes`、`api.identities`、`setFacilityTarget` |
| `app/src/lib/api.tasks.ts` | `identity` / `environment` 两格；`TaskRunView` 加 profile / 环境 / 账号；`saveTask` 带上三格 |
| `app/src/components/devices/NodeRow.tsx`（新） | 一个节点：名字、profile、环境编辑、在线、默认 |
| `app/src/components/devices/ProfileClaimButton.tsx`（新） | 识别 profile |
| `app/src/components/devices/IdentitiesSettings.tsx`（新） | 身份表 |
| `app/src/components/devices/WokenProfiles.tsx`（新） | Stream 在后台打开着的 profile |
| `app/src/components/devices/TargetSelect.tsx`（新） | 设备 / 身份 / 环境 下拉 |
| `app/src/components/DevicesSettings.tsx` | 本机卡、节点并进浏览器行、识别按钮 |
| `app/src/components/FacilityDevicesSettings.tsx` | 用 `TargetSelect` |
| `app/src/components/tasks/TaskEditor.tsx` | 「执行位置」用 `TargetSelect` |
| `app/src/components/tasks/TasksPage.tsx` | `runWhere` 并上 profile / 环境 / 账号 |
| `app/src/panel/manage-entry.tsx` | 设备页挂身份表、后台 profile |
| `extension/src/lib/profile-line.ts`(+test)（新） | popup 顶行文案 |
| `extension/src/entrypoints/popup/App.tsx` | 顶行 |

---

### Task 0: 基线

- [x] 后端全量（17 文件 / 34 测试，环境类）、面板全量、扩展全量、三处 tsc，记下失败集。

### Task 1: 节点列表接口 + 面板 API 层

- [x] 失败的测试：`GET /api/devices/nodes` 回全部节点、每行带 `online`、`claimable` 原样；没注入 `claimable` → `[]`。
- [x] 实现、接线；`api.ts` / `api.tasks.ts` 类型与调用。Commit `feat(panel): api for nodes, claim, identities and targets`。

### Task 2: 设备页

- [x] 失败的测试：本机卡列出本机节点（名字取 label → profile 名 → 「未识别的 profile」，带 profile 目录）；配对设备的浏览器行带上节点的 profile 与环境；环境下拉选「工作」→ PATCH `{environment:'工作'}`，选「自定义…」出输入框、回车 PATCH，选「未标」→ `null`；改名 PATCH `label`；本机节点「设为默认」→ PUT `/api/ext/bindings/local:<nodeId>/default`；`claimable` 里没有的设备不出「识别 profile」；点了 → POST claim → 轮询到 `done`，每个 profile 一行（已识别 / 扩展未安装或未连上 / 失败原因），结束后重读节点；403 原话显示。身份表：按（facility，账号）归组，列节点名与在线点、上次核对、已登出标记；刷新 → POST refresh → 重读。后台 profile：有 `wokenAt` 的节点才出这一节，带说明。
- [x] 实现。Commit `feat(panel): browser nodes, profile claim, identities and woken profiles on the devices page`。

### Task 3: 目标选择器

- [x] 失败的测试：facility 行是身份目标（无 `deviceId`）→ 下拉显示该身份、不当成本机；身份组只列该 facility 身份表里的账号；环境组列节点上用到的环境；选身份 → PUT `{accountId}`、选环境 → PUT `{environment}`、选本机 → DELETE；400 原话。任务编辑器：动作任务下拉有身份（该动作所属 facility 的账号）/ 环境组；选了只发那一格；command 任务照旧不显示；`saveTask` 带回三格。
- [x] Commit `feat(panel): pick an identity or environment for a facility or a task`。

### Task 4: 运行记录

- [x] 失败的测试：`runWhere` 本机 + profile / 环境 / 账号 → `工作 · Profile 1 · 张三`；远程设备 + profile → 设备名在前、不再重复浏览器名；只有设备 → 与今天一致；本机且没有任何节点信息 → null。
- [x] Commit `feat(panel): runs show the profile, environment and account`。

### Task 5: popup

- [x] 失败的测试（纯函数）：有环境 + 名字 → `工作 · Profile 1`；只有名字 → `Profile 1`；没认领 → 「未识别的 profile」+ 说明「在 Stream 面板：管理 → 设备 → 识别 profile」。
- [x] 实现：popup 读 `chrome.storage.local.node`，再 `GET /api/devices/nodes` 找自己那一行的环境 / 名字（读不到就只用存储里的）。`wxt build`。
- [x] Commit `feat(extension): popup says which profile and environment it is`。

### Task 6: 文档

- [x] `docs/ARCHITECTURE.md` 执行位置一节：节点、身份、目标、唤起与收回、一个绑定一个 Stream 标签组；`docs/PACKAGE.md`：`stream.whoami`；`extension/README.md`：节点、认领页、4004。tasks.md 勾计划 5 的 1–5，第 6 项标「文档已完成，冒烟待做」。
- [x] 构建面板与扩展；起一个测试实例截图设备页。
- [x] Commit `docs(browser-identity): panel, popup, whoami`。

## 执行记录：与上文的偏离（2026-10-23）

- **本机卡**：本机节点不在扩展绑定表里（`local:<nodeId>` 不经配对），原设备列表里根本看不见它们。设备页顶上加「本机」卡；用本机 secret 连进来的 Stream Desktop（未配对的 windows / macos 行，没有任何可点的动作）并进这张卡，不再单列。老后端（没有 `/api/devices/nodes`）一切照旧。
- **`claimable` 由后端给**：`/api/devices` 不带 agent 的 ops，面板判断不了「这台能不能识别」。节点列表接口顺带回 `claimable`（本机 = `local`，配对设备 = 它的 id），判据与 `agentFrom` 同一个。
- **选择器是一个带分组的下拉**（设备 / 身份 / 环境），不是「先选类型再选值」两个控件：值编码成 `d:` / `i:` / `e:` 前缀，facility 行与任务编辑器共用 `TargetSelect`。任务编辑器那一格从「执行设备」改名「执行位置」。facility 节标题从「账号在哪台设备上执行」改为「账号在哪里执行」。
- **顺手修**：`saveTask`（暂停 / 改排期的整行回写）原先漏了 `device`，一次暂停就把任务的设备覆盖清掉；现在连同 `identity` / `environment` 一起带回。
- **身份表的纯函数单独成文件**（`devices/identities.ts`）：任务编辑器在主 bundle 里，不把设备页的组件拖进去。
- **popup 的环境**问本机 Stream 的 `/api/devices/nodes`（本机请求免 token、扩展 Origin 受信）；只配对了远处 Stream 的扩展说不出环境，只显示 profile 名。
- 面板全量里 `panel-split.build.test.ts` 的主 bundle 体积断言在开工前就超（1,677,138 > 1,650,000），与本计划无关。
- 实机截图：`STREAM_PORT=8931` 的测试实例，往 scratch `stream.db` 塞了三个本机节点、四条身份、两条 facility 目标。Windows 真机冒烟（tasks.md 6b）未做。
