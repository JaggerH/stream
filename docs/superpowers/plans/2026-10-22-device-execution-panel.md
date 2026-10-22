# Device Execution — Panel Implementation Plan (4/4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **每个 commit 之后立刻 `git push`。** 这台机器的 home 被回滚过三次，没推送的提交全部丢失。推送失败马上告诉用户。

**Goal:** 计划 1–3 的能力今天只能用 `curl` 用。本计划把它们放进面板：看到所有设备（含 Linux agent）、在设备上「添加浏览器」（签扩展配对码）、看与撤销挂在设备上的浏览器、指定设备的默认浏览器、给 facility 指定默认设备、给任务覆盖设备、在运行记录里看到在哪台设备上跑的。

**Architecture:** 后端补三处小缺口——设备的默认扩展绑定（`ext-bindings.json` 行上的 `default`，`pick` 先看它）、列出全部 facility 及其默认设备的接口、运行记录带 `deviceId` / `bindingId`。面板侧：`PhoneDevicesSettings` 升级为 `DevicesSettings`（设备卡片 + 卡片下的浏览器列表 + 添加浏览器），新增 `FacilityDevicesSettings`（每个 facility 一个设备下拉），`TaskEditor` 加「执行设备」下拉，`RunRow` 显示设备名。

**Tech Stack:** TypeScript（Node 22，backend `tsx`）、Hono、vitest；面板 React + Vite（`app/`），`@testing-library/react`。

**Spec:** `openspec/changes/device-execution/`——`specs/device-execution/spec.md`「facility 默认设备与任务覆盖」「运行记录带设备」，`specs/device-browser-relay/spec.md` 的绑定列表 / 撤销 / 默认绑定；`design.md` D2、D7。

**本计划不含：**
- 远程实例上的 `cdp_*` MCP 工具选绑定（仍走 `local`）。
- `run_action_recipe` 接 registry（计划 3 的偏离记录，仍 `device-incapable`）。
- 扩展 popup 的改动（加密提示的样式另议）。

## Global Constraints

- **面板只调已有或本计划新增的接口，不在前端拼业务规则。** 「哪些设备能选」「command 任务不能设设备」由后端判，前端只把后端的 400 原样显示；下拉里能预先排除的就排除（command 任务隐藏设备下拉），但不复刻校验。
- 新增 / 改动的线上接口（逐字）：
  - `GET /api/devices` 的 `platform` 取值加 `linux`（后端早已返回，前端类型补上）。
  - `POST /api/devices/:id/ext-pairing-code` → `{ code, expiresAt, backends }`：`backends` = 本机可达地址（同 `/api/devices/pairing-code` 的 `backendUrls`），面板据此告诉用户扩展里填什么。
  - `GET /api/ext/bindings` 每行加 `default: boolean`。
  - `PUT /api/ext/bindings/:id/default` → 204：把它设为所在设备的默认（同设备其余行清掉）。不存在 404。
  - `DELETE /api/ext/bindings/:id/default` → 204：清掉（回到「最近连上」）。
  - `GET /api/devices/facilities` → `{ facilities: [{ facility, packageId, deviceId }] }`：所有已装包声明的 facility，`deviceId` 缺席绑定时为 `local`。按 `facility` 排序。
  - `GET /api/tasks/:id/runs` 每行加 `deviceId: string`（缺席 = `local`）与可选 `bindingId`。
- 选绑定（`ExtRelayRegistry.pick`）：设备的默认绑定在线 → 选它；否则照旧（在线里最近连上的）。默认绑定离线**不报错**，退回最近连上——默认是偏好，不是约束。
- `ext-bindings.json` 行新增可选 `default?: true`。旧文件没有这个字段，读入照常；撤销一条默认绑定时字段随行删除。
- 运行记录的设备：成功 run 从 `result.detail.device` 取（`user-tasks.ts` 已写）；失败 run 从错误文本前缀 `[设备 <id>] ` 取（`nameDevice` 已写）。两处都没有 = `local`。`bindingId` 只在成功 run 的 `detail.browser` 里有（本计划在 `user-tasks.ts` 写入）。
- 面板文案：中文。设备平台显示：`android` 安卓、`windows` / `macos` 电脑、`linux` Linux。
- 测试命令：后端 `pnpm vitest run <路径>`（仓库根）；面板 `pnpm --dir app vitest run <路径>`。类型检查：`pnpm tsc --noEmit -p .` 与 `pnpm --dir app tsc --noEmit`。
- 面板改完要构建才生效：`cd app && npm run build:panel -- main`（见 `scripts/dev.sh` 头注）。
- 编辑文件用 Edit；不用 `sed -i`。注释与日志沿用本仓风格：中文、解释「为什么」。

## Review Focus

1. **默认绑定离线时不能让执行失败。** 设备有两条绑定，默认那条离线、另一条在线 → `pick` 选在线那条。Task 1 钉住。
2. **facility 列表与 `knownFacility` 同源。** 面板能选的 facility 必须是 `PUT /api/devices/bindings/:facility` 认的那些，否则用户选了却 400。两处都读 `facilityIndex`。
3. **运行记录的设备解析不误伤存量。** 本计划之前的成功 run 没有 `detail.device`（local 原样返回），失败 run 没有前缀 → 都是 `local`。Task 3 用存量形状的行钉住。
4. **配对码只对本机请求。** 面板从远处打开（经 API token）时「添加浏览器」会 403；按钮照常显示，点了把后端的话原样提示，不在前端猜。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/devices/ext-binding-store.ts` | 加 `setDefault(bindingId)` / `clearDefault(bindingId)` / `defaultOf(deviceId)`；`list()` 带 `default` |
| `src/http/ext-relay-registry.ts` | `pick` 先看默认绑定 |
| `src/http/ext-binding-routes.ts` | 默认绑定的 PUT / DELETE；配对码回 `backends` |
| `src/kernel/plugins/packages.ts` | 暴露 `facilities(): PackageNetwork[]` |
| `src/http/device-routes.ts` | `GET /api/devices/facilities` |
| `src/tasks/user-tasks.ts` | 成功 run 的 `detail` 带 `browser`（选中的 bindingId） |
| `src/tasks/run-history.ts` | `TaskRun.deviceId` / `bindingId` |
| `app/src/lib/api.ts` | 类型与调用 |
| `app/src/components/DevicesSettings.tsx`（由 `PhoneDevicesSettings.tsx` 改名） | 设备卡片、浏览器列表、添加浏览器、默认、撤销 |
| `app/src/components/FacilityDevicesSettings.tsx`（新） | facility → 设备 |
| `app/src/components/tasks/TaskEditor.tsx` | 执行设备下拉 |
| `app/src/components/tasks/TasksPage.tsx` | `RunRow` 显示设备 |

---

### Task 0: 基线

- [ ] 后端全量 `pnpm vitest run`、面板 `pnpm --dir app vitest run` 各跑一次，记下失败数（已知：负载下偶发计时类超时，单跑全过）。

### Task 1: 设备的默认扩展绑定

**Files:** `src/devices/ext-binding-store.ts`(+test)、`src/http/ext-relay-registry.ts`(+test)、`src/http/ext-binding-routes.ts`(+test)

- [ ] 失败的测试：
  - store：`setDefault(b2)` 后 `list()` 里 b2 `default: true`、同设备 b1 `false`；再 `setDefault(b1)` 互换；`clearDefault`；撤销默认行后 `defaultOf(device)` 为 undefined；落盘后重新 load 仍在；旧文件（无字段）读入全 `false`。
  - registry：默认在线 → 选默认（即使另一条更晚连上）；默认离线 → 选最近连上的在线那条；没有默认 → 行为不变。
  - routes：PUT 204 / 不存在 404；DELETE 204；`GET /api/ext/bindings` 带 `default`；`ext-pairing-code` 回 `backends`。
- [ ] 实现；registry 的 deps 加 `defaultOf(deviceId)`，serve 接线传 store 的。
- [ ] Commit `feat(devices): a device's default browser` + push。

### Task 2: 列出全部 facility 及其设备

**Files:** `src/kernel/plugins/packages.ts`、`src/http/device-routes.ts`(+test)、`src/serve.ts`

- [ ] 失败的测试：`GET /api/devices/facilities` 列出注入的 facility，已绑的带 `deviceId`，未绑的为 `local`，按名排序；没注入 `facilities` → 空列表。
- [ ] 实现：packages 域 `facilities: () => [...facilityIndex.values()]`；device-routes deps 加 `facilities?: () => Array<{ facility; packageId }>`。
- [ ] Commit `feat(http): list facilities with their device` + push。

### Task 3: 运行记录带设备与浏览器

**Files:** `src/tasks/user-tasks.ts`(+test)、`src/tasks/run-history.ts`(+test)

- [ ] 失败的测试：
  - user-tasks：远程设备上的动作用过浏览器 → 结果 `detail.browser === <bindingId>`；没用浏览器 → 没有 `browser`。
  - run-history：成功行 `detail.device` → `deviceId`；失败行 errors 文本 `[设备 linux:x] …` → `deviceId: 'linux:x'`；存量成功行（detail 无 device）与存量失败行（无前缀）→ `'local'`；`detail.browser` → `bindingId`。
- [ ] 实现。`detail` 的取法：`run-history` 读到的是 `{ device, browser?, detail }` 的外层。
- [ ] Commit `feat(tasks): runs say which device and browser they ran on` + push。

### Task 4: 面板 API 层

**Files:** `app/src/lib/api.ts`

- [ ] `DeviceRow.platform` 加 `'linux'`；新增 `ExtBindingRow`、`FacilityDeviceRow`；`api.devices` 加 `extPairingCode`、`facilities`、`setFacilityDevice`（PUT）、`clearFacilityDevice`（DELETE）；新增 `api.extBindings`：`list`、`revoke`、`setDefault`、`clearDefault`；`TaskRunView` 加 `deviceId`、`bindingId?`；任务行类型加 `device?`。
- [ ] `pnpm --dir app tsc --noEmit` 通过。Commit 与 Task 5 合并。

### Task 5: 设备卡片与浏览器

**Files:** `app/src/components/DevicesSettings.tsx`（`git mv` 自 `PhoneDevicesSettings.tsx`，测试同改名）、`BackendSettings.tsx`、`panel/manage-entry.tsx`

- [ ] 失败的测试（沿用现有测试的 fetch mock 方式）：
  - Linux 设备显示平台「Linux」；
  - 非安卓的已配对设备有「添加浏览器」；点了显示 6 位码、倒计时、`backends` 里的地址；过期后提示重新生成；后端 403 时 toast 后端原话；
  - 设备下列出它的浏览器（名称、平台、在线点、「默认」标记）；「设为默认」调 PUT、「撤销」调 DELETE 后刷新；
  - 有码在屏时轮询，出现新绑定 → toast「已添加浏览器」并收起码。
- [ ] 实现：设备列表与浏览器列表并行取（`/api/devices`、`/api/ext/bindings`），按 `deviceId` 归组。原「添加手机」保留。节标题由「手机」改「设备」。
- [ ] Commit `feat(panel): devices with their browsers, add and revoke a browser` + push。

### Task 6: facility 的默认设备

**Files:** `app/src/components/FacilityDevicesSettings.tsx`(+test)、`BackendSettings.tsx`

- [ ] 失败的测试：每个 facility 一行，下拉 = 本机 + 已配对设备（离线的也列、标「离线」）；改选调 PUT，选回本机调 DELETE；后端 400 原话 toast 并回滚下拉。
- [ ] 实现，挂在「设备」节下面一个子节「账号在哪台设备上执行」。
- [ ] Commit `feat(panel): pick the device a facility runs on` + push。

### Task 7: 任务覆盖设备、运行记录显示设备

**Files:** `app/src/components/tasks/TaskEditor.tsx`(+test)、`TasksPage.tsx`(+test)

- [ ] 失败的测试：
  - action 任务有「执行设备」下拉：「跟随账号默认」（不发 `device`）/ 本机 / 各设备；保存带 `device`；command 任务不显示这个下拉；
  - `RunRow` 在 `deviceId !== 'local'` 时显示设备名（取不到名字显示 id），有 `bindingId` 时附浏览器名。
- [ ] 实现。设备名从 `/api/devices` 取一次，TasksPage 级缓存。
- [ ] Commit `feat(panel): override a task's device, show it on runs` + push。

### Task 8: 文档、tasks.md、构建与实机看一眼

- [ ] `docs/ARCHITECTURE.md` 执行位置一节：默认绑定、facilities 接口、运行记录字段；`extension/README.md` 把「面板按钮在计划 4；之前用接口」改成面板路径。
- [ ] `tasks.md` 计划 4 展开为本计划 Task 1–7 逐条勾。
- [ ] `cd app && npm run build:panel`；起一个测试实例打开面板截图确认设备节、facility 节、任务编辑器。
- [ ] Commit `docs(device-execution): panel` + push。
