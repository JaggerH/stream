# Browser Identity — Profile Claim Implementation Plan (计划 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在面板上点「识别 profile」，Stream 经那台机器的 host agent 列出 Chrome 的全部 profile、逐个用该 profile 打开扩展自己的认领页；页面里的扩展实例经它的绑定把一次性 `nonce` 交回，Stream 据此把 profile 目录名与显示名记进节点，扩展也记进自己的存储，之后每次握手都带上。节点的名称与环境可以由面板改。

**Architecture:** host agent 新增 `browser.profiles`（读 `<userDataDir>/Local State`）与 `browser.claim`（`<chrome> --profile-directory=<dir> <url>`），平台无关的核心在 `browser.rs`，文件读取与环境变量注入、spawn 复用 `launch.rs` 的 `ProcessWorld`。后端 `ProfileClaims`（`src/devices/profile-claim.ts`）管认领会话：每个 profile 一个 `nonce`（2 分钟、一次性），20 秒没交回标 `missing`；等待期间该设备上新连上一个未认领的节点，对仍在等的 profile 各补发一次 `browser.claim`（D3 的新 profile 竞态）。扩展经绑定发 `{type:'claim', nonce}`，`ExtRelayRegistry.handleMessage` 在交给 relay 之前截下这一帧、按绑定所在设备校验、回 `{type:'claim-result', …}`。扩展的 `claim.html` 把 `nonce` 交给 SW，SW 发给全部已连绑定，第一个 `ok` 写进 `chrome.storage.local.node`。

**Tech Stack:** Rust（host agent，`cargo test` 在 cortana 上跑）；TypeScript（Node 22、better-sqlite3、hono、vitest）；扩展 WXT + React + vitest。

**Spec:** `openspec/changes/browser-identity/`——`specs/browser-node/spec.md`（由 host agent 认领 profile、扩展记住自己的 profile、节点的环境标注）；`design.md` D3、D4、D12，spike S1、S4。

**本计划不含：** 面板 UI（计划 5）、`whoami` 与身份表（计划 3）、按身份路由与唤起（计划 4）。

## Global Constraints

- **只接受同设备交回的 `nonce`。** 会话记着执行 `browser.claim` 的 agent 所对应的扩展设备：用共享 secret 连进来的桌面 agent（windows / macos）就是后端这台机器 → `local`；配对设备 → 它自己的 `deviceId`。交回的绑定 `registry.deviceOf(bindingId)` 不等于它就拒，节点一个都不动。
- **兼容槽（不带 `nodeId` 的老扩展）不能认领**：它没有节点行可写，回 `ok:false`。
- `nonce` 一次性：交回成功即作废；过期（2 分钟）、未知、已用过一律 `ok:false`，原因不同但对扩展一视同仁。
- 同一台设备上一个 `profile_dir` 至多一个节点：认领写入时把同设备别的节点上相同的 `profile_dir` 清掉（扩展重装后的新节点接替旧节点）。
- `browser.claim` 的 `url` 只收 `chrome-extension://`：认领只需要这个；「在任意 profile 里打开任意网址」是更大的能力，不顺手给。
- 认领与发现路由只认 loopback（同 `/api/devices/pairing-code`、`/api/devices/:id/ops`）：会在那台机器上开窗口，也会回 profile 的 Google 邮箱。`PATCH /api/devices/nodes/:nodeId` 与其它设置类路由一样只过 API token。
- 测试：后端 `flock /tmp/stream-heavy.lock node_modules/.bin/vitest run <路径>`；扩展 `extension/node_modules/.bin/vitest run`；Rust 在 cortana 的 scratch 目录 `~/.cargo/bin/cargo test`。

## File Structure

| 文件 | 职责 |
|---|---|
| `app/host-agent/src/browser.rs`（新） | `ProfilesSpec` / `ClaimSpec`；用户数据目录默认位置；`Local State` 解析；`claim` 经 `ProcessWorld` spawn |
| `app/host-agent/src/protocol.rs` | `Desktop::browser_profiles` / `browser_claim`（默认实现走真实世界）；`OP_NAMES`；dispatch |
| `app/host-agent/src/overlay.rs` | 两个新 op 归 `QUIET` |
| `src/replay/desktop-driver.ts` | `DESKTOP_OPS` 与 `OP_NAMES` 同步 |
| `src/devices/node-store.ts` | `claimProfile`（写 profile、清同设备同 dir 的旧节点）、`update`（label / environment） |
| `src/devices/profile-claim.ts`（新） | `ProfileClaims`：discover / start / get / redeem / onNodeConnected |
| `src/http/ext-relay-registry.ts` | `onClaim(fn)`：截下 `claim` 帧、回 `claim-result` |
| `src/http/node-routes.ts`（新） | `/api/devices/:id/profiles`、`/profiles/claim`、`/profiles/claim/:claimId`、`PATCH /api/devices/nodes/:nodeId` |
| `src/serve.ts` | 接线 |
| `extension/src/lib/claim.ts`（新） | SW 侧：经全部已连绑定发 `claim`、等 `claim-result`、记 profile |
| `extension/src/lib/node.ts` | `rememberProfile` |
| `extension/src/lib/driver.ts` | 入站 `claim-result` 交给 `claim.ts`；导出已连绑定的 socket |
| `extension/src/entrypoints/claim/`（新） | `claim.html` 页面 |
| `extension/src/entrypoints/background.ts` | `claim` 消息 |

---

### Task 0: 基线

- [ ] 后端全量、扩展全量、三处 tsc 各跑一次，记下失败集（后端已知 17 个文件 / 34 个测试，环境类）。

### Task 1: host agent 的两个 op

**Files:** `app/host-agent/src/browser.rs`(+tests)、`protocol.rs`、`overlay.rs`、`main.rs`、`src/replay/desktop-driver.ts`

- [ ] 失败的测试：三个平台的默认用户数据目录（env 注入）；`userDataDir` 显式覆盖；`exe` 是 Chromium 时目录跟着换；`Local State` 解析出 `dir/name/gaiaEmail/gaiaName`（空串不带）、`lastActive`、`Default` 在前、`Profile 10` 排在 `Profile 2` 后；坏 JSON / 没有 `info_cache` 报可操作的错；`claim` 的参数是 `--profile-directory=<dir>` + url，`url` 不是 `chrome-extension://` 拒、`profileDirectory` 为空拒；dispatch 两个 op 的路由与回包；overlay 归类完整。
- [ ] 实现；cortana 上 `cargo test` + `cargo build`；用 Linux 二进制的解析逻辑读一次真 Windows `Local State`（只看 dir / name）。
- [ ] Commit `feat(host-agent): browser.profiles and browser.claim`。

### Task 2: 节点表的认领与编辑

**Files:** `src/devices/node-store.ts`(+test)

- [ ] 失败的测试：`claimProfile` 写两格、清同设备同 dir 的别的节点、不碰别的设备；`update` 改 label / environment，`null` 清空，没有这个节点回 undefined。
- [ ] Commit `feat(devices): nodes can be claimed and labelled`。

### Task 3: 认领会话

**Files:** `src/devices/profile-claim.ts`(+test)、`src/http/ext-relay-registry.ts`(+test)

- [ ] 失败的测试：start 对每个 profile 调一次 `browser.claim`，url 带各自的 nonce；本机 agent 签的 nonce 由 `local:<nodeId>` 交回 → 节点记下 dir / name、会话该 profile 变 `claimed`；别的设备的绑定交回 → 拒、节点不变；同一 nonce 第二次 → 拒；过 2 分钟 → 拒；20 秒没交回 → `missing`，其它 profile 不受影响；等待期间同设备新连上一个未认领节点 → 对仍在等的 profile 各补发一次（只一次），已认领的节点连上不补发；兼容槽交回 → 拒；agent 没声明 op → `DeviceIncapable` 形状的错。registry：`claim` 帧不进 relay，回 `claim-result`；没有处理器时回 `ok:false`。
- [ ] Commit `feat(devices): profile claim sessions`。

### Task 4: 路由与接线

**Files:** `src/http/node-routes.ts`(+test)、`src/serve.ts`

- [ ] 失败的测试：非 loopback 403；设备不在线 404；没有 op 409；discover 回 profile 列表并标出已认领的节点；claim start / poll；`PATCH /api/devices/nodes/:nodeId` 改 label / environment、字段类型错 400、没有节点 404。
- [ ] Commit `feat(devices): profile claim and node edit routes`。

### Task 5: 扩展

**Files:** `extension/src/lib/claim.ts`(+test)、`node.ts`(+test)、`driver.ts`、`entrypoints/claim/*`、`entrypoints/background.ts`

- [ ] 失败的测试：经全部已连绑定各发一次 `claim`；之后才连上的绑定也补发；第一个 `ok` 写进 `node` 存储（`nodeId` 不变）并返回；全部拒或超时回错误；`nodeQuery` 带上认领后的两格。
- [ ] 页面：读 `#n=`，发给 SW，显示「已识别：<name>（<dir>）」或错误。
- [ ] `wxt build` 产出 `claim.html`。
- [ ] Commit `feat(extension): claim page hands the nonce back over every binding`。

### Task 6: 收尾

- [ ] rebase、全量测试与类型检查、失败集对照基线；tasks.md 勾掉计划 2 的 1–4。
