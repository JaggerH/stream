# Device Execution — Extension Bindings Implementation Plan (3/4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **每个 commit 之后立刻 `git push`。** 这台机器的 home 被回滚过三次，没推送的提交全部丢失。推送失败马上告诉用户。

**Goal:** 扩展与 Stream 实例多对多绑定。一个 Chrome 同时服务本机 Stream 和远处的主实例；一个主实例同时驱动 PC、NAS 上的 Chrome。每条配对绑定挂在一台设备上，绑定到那台设备的执行——登录、cookie 拉取、浏览器类 recipe——都在那台设备的 Chrome 里跑。

**Architecture:** 实例侧新增扩展绑定表（`ExtBindingStore`，只存 token 哈希、配对码记着目标设备）与 `ExtRelayRegistry`（`Map<bindingId, ExtRelay>`；`local` 那条就是今天的单例）。`/api/ext` 的 WS 升级从「比对一把固定 token」改为「token → bindingId」，本机 token 解析为 `local`。执行上下文 `RunPlacement` 新增 `browser` 记号：本次执行第一次用浏览器时从设备的在线绑定里选一条并固定。`RecipeSessionManager` 的 lane 键加上 bindingId、`transportFor` 按 bindingId 取那条 relay 的 Transport；`CookiePuller` 按设备取。扩展侧把 `config` 从单个 `baseUrl` 改成一组绑定，`driver.ts` 的模块级会话状态收进按绑定的 `BindingRuntime`，每条绑定一条 WS、一个标签组、一本归属账本；配对绑定的 cookie 域名要用户批准。

**Tech Stack:** TypeScript（Node 22，backend `tsx`）、Hono、`ws`、vitest；扩展 WXT + React（MV3）。

**Spec:** `openspec/changes/device-execution/`——本计划实现 `specs/device-browser-relay/spec.md` 全部 Requirement，并解除计划 1 留下的「浏览器只通本机」限制（`assertLocalBrowser`）。设计依据 `design.md` D1、D4、D7、D9。

**本计划不含：**
- 计划 4（面板）：签发扩展配对码的按钮、设备的默认绑定选择、绑定列表与撤销按钮、运行记录显示绑定名。本计划只交付 HTTP 接口，面板之前用 `curl` 验证。
- 设备的「默认绑定」：本计划只按「最近连上」选；默认绑定的存储与选择在计划 4。
- 远程实例上的 `cdp_*` MCP 工具（look/act/shot）选绑定：它们不在执行上下文里，照旧走 `local`。
- 容器镜像、noVNC、agent 转发 8900（已从设计中删除）。

## Global Constraints

- **本机绑定的行为逐字节不变。** 现有 `extension/src/lib/driver.*.test.ts`、`src/http/ext-relay*.test.ts`、`src/http/app.ext-*.test.ts` 一个不改、全部通过，是本计划的回归闸门。新增参数一律放在**最后且可选**，缺省 = 本机绑定。
- 绑定 id：本机 = 字符串 `local`；配对 = `ext:<uuid>`。设备 id 沿用计划 1（`local`、`linux:<uuid>`、`android:<uuid>`）。
- 实例侧状态文件 `data/ext-bindings.json`，权限 0600，`{ "bindings": [ { bindingId, deviceId, name, browser?, platform?, tokenHash, pairedAt, lastSeenAt? } ] }`。读坏了拒绝启动（同 `DeviceStore.load`）。
- 扩展配对码：6 位数字、5 分钟、一次性、5 次失败作废全部（复用 `device-store.ts` 导出的 `PAIRING_TTL_MS`、`MAX_PAIR_FAILURES`）。**签发只对本机请求**（`isLocal`），且**不能为 `local` 签**（`local` 是后端本机，它的浏览器就是本机扩展）。
- 线上接口（逐字）：
  - `POST /api/devices/:id/ext-pairing-code` → `{ code, expiresAt }`。本机限定；设备不存在 404；`:id === 'local'` 400。
  - `POST /api/ext/pair`，body `{ code, name?, browser?, platform? }` → `{ bindingId, token, deviceId, deviceName }`；码不对 403 `{ error: 'invalid-code' }`。免 API token（加进 `TOKEN_EXEMPT_ROUTES`），仍受 Origin 门：只收 `chrome-extension://` Origin。
  - `GET /api/ext/bindings` → `{ bindings: [{ bindingId, deviceId, name, browser?, platform?, pairedAt, lastSeenAt?, online }] }`（受 API token 保护）。
  - `DELETE /api/ext/bindings/:id` → 204；不存在 404；随后以关闭码 **4003** 断开它的 WS。
  - `POST /api/ext/verify` 增加可选字段 `binding`：缺席 = 本机，proof = `HMAC(localToken, PREFIX+nonce)`（今天的行为）；给了 = 配对绑定，proof = `HMAC(tokenHash, PREFIX+nonce)`，`tokenHash` 是该绑定 token 的 SHA-256 小写 hex。绑定不存在时**照样回一个 proof**（用随机 key 算），不泄露「这个 id 存在与否」。
  - `GET /api/ext/claimed-tabs?binding=<id>`：缺席 = `local`。
- **为什么配对绑定的 proof 用 tokenHash 当 key**：实例只存哈希（与 `DeviceStore` 同规矩），算不出 `HMAC(token, …)`。哈希当 key 的代价：`ext-bindings.json` 泄露的人能冒充实例骗过扩展的挑战——但他随后拿到的 WS 握手里的 token 只对这一条绑定有效，而偷到这个文件的人本来就在实例机器上。写进 Review Focus。
- WS 升级：子协议仍是 `[EXT_RELAY_PROTOCOL, token]`；Origin 仍拒 http(s)。`token === localToken` → `local`；否则 `store.bindingForToken(token)` → 那条绑定；都不中 → 401。
- 撤销：`DELETE` 绑定，或其所挂设备被 `DELETE /api/devices/:id` 撤销 → 绑定行删除，在线连接以 4003 关闭。扩展收到 4003 → 该绑定标 `revoked: true`，不再重连。
- 选绑定（`ExtRelayRegistry.pick(deviceId)`）：设备上在线的绑定中 `connectedAt` 最大的那条；设备上有绑定但全离线 → `DeviceOffline`；一条都没有 → `DeviceIncapable(deviceId, 'browser')`。`local` 设备永远选 `local`（离线由现有 `ExtRelayDisconnected` 处理，不改）。
- 一次执行里第一次需要浏览器时选定，之后固定（`RunPlacement.browser` 记号）。选中的 bindingId 写进运行记录（`TaskRun.bindingId`，可选字段）。
- 扩展侧配对只接受 `https://` 或回环（`127.0.0.1`、`localhost`、`[::1]`）地址；否则在发出任何请求之前就拒绝。
- 扩展侧 `chrome.storage.local` 键：本机绑定沿用现有 `ownedTabs` / `tabGroup` / `tabGroupChecked`；配对绑定用 `<key>:<bindingId>`。**本机的键名不改**，升级后已有的组与账本原样认领。
- 配对绑定的 cookie 范围 = `domains` ∪ (`requiredDomains` ∩ `approvedDomains`)；`requiredDomains` 里没批准的列为 `pendingDomains` 给 popup 显示。本机绑定 = `domains` ∪ `requiredDomains`（不变）。
- 注释与日志沿用本仓风格：中文、解释「为什么」。编辑文件用 Edit；不用 `sed -i`。
- 测试命令：`pnpm vitest run <路径>`（后端，worktree 根目录）；`pnpm --dir extension vitest run <路径>`（扩展）。类型检查：`pnpm tsc --noEmit -p .` 与 `pnpm --dir extension tsc --noEmit`。

## Review Focus

1. **本机绑定回归。** 只有一条本机绑定的用户（今天的所有用户）升级后，标签组、归属账本、孤儿回收、cookie 拉取、`relay-status` 必须与升级前一致。闸门：现有 driver / relay / ext-* 测试原样通过（Task 0 记基线，每个 Task 收尾重跑）。
2. **实例 A 驱动实例 B 的 tab。** 同一个 Chrome 绑了两个实例，A 发来的 `Runtime.evaluate` 指向 B 组里的 tab（或用户拖进 B 组的私人 tab）。期望：扩展拒绝，错误文本带「not in the session tab group」。Task 8 的 `refuses a tab owned by another binding` 钉住。
3. **远程实例要走无关站点的 cookie。** 主实例的 `sync-config` 加上 `mail.google.com`。期望：`cookiePull` 把它放进 `refused`，popup 列为待批准；批准之后才给。Task 9 钉住。
4. **登录与下单分叉。** 绑定到 NAS 的执行触发 `ctx.login`，登录必须在 NAS 挂着的 Chrome 里跑，cookie 写进 `cookies/<nas>.json`，`local` 的 Chrome 一张 tab 都不开、`cookies/local.json` 不变。Task 6 的集成测试钉住。
5. **同一次执行中途换了 Chrome。** NAS 上挂了两个扩展，执行开始选了 A，中途 B 新连上（更「新」）。期望：本次执行仍用 A。Task 4 的 `keeps the first pick for the whole run` 钉住。
6. **ext-bindings.json 泄露的后果**（见 Global Constraints 中 proof 的说明）——审查时确认 token 本身从不落盘、不进日志。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/devices/ext-binding-store.ts`（新） | 扩展绑定表：配对码（带目标设备）、配对、token → 绑定、撤销、按设备列出 |
| `src/http/ext-relay-registry.ts`（新） | `Map<bindingId, ExtRelay>`；`local` 常驻；`pick(deviceId)`；按设备的在线判定 |
| `src/http/ext-binding-routes.ts`（新） | `ext-pairing-code`、`/api/ext/pair`、`/api/ext/bindings` 列表与撤销 |
| `shared/browser-relay/relay.ts` | `attachExtRelay` 接受 `resolveToken`，连接按 bindingId 交给 registry |
| `shared/browser-relay/verify.ts` | `extVerifyProofForBinding`（tokenHash 作 key） |
| `src/devices/run-context.ts` | `RunPlacement.browser` 记号 |
| `src/devices/placement.ts` | `assertLocalBrowser` 换成 `pickBrowser`（registry 判定） |
| `src/replay/session-manager.ts` | lane 键加 bindingId；`pinnedTabIds(binding)` |
| `src/kernel/plugins/harvest.ts` | 建 registry；`transportFor` 按绑定；暴露 `extRelays` |
| `src/kernel/plugins/auth.ts` | `cookiePullerFor(deviceId)`；`ctx.login` 在执行设备的浏览器里跑 |
| `src/http/app.ts`、`src/serve.ts` | verify 带 `binding`、claimed-tabs 带 `binding`、挂路由、撤销设备时连带撤绑定 |
| `extension/src/lib/config.ts` | `Binding` 类型、`bindings` 列表、旧配置迁移、按绑定的 cookie 范围 |
| `extension/src/lib/pair-code.ts`（新） | 用配对码配对：地址检查、`POST /api/ext/pair` |
| `extension/src/lib/backend-identity.ts` | `verifyBackend` 支持配对绑定（`binding` + tokenHash key） |
| `extension/src/lib/driver.ts` | `BindingRuntime`：会话状态按绑定；每条绑定一条连接；tab 归属按绑定判 |
| `extension/src/lib/sync.ts` | 按绑定同步；配对绑定的待批准域名 |
| `extension/src/entrypoints/popup/*` | 绑定列表、添加绑定（地址 + 码）、批准域名、撤销提示 |
| `docs/ARCHITECTURE.md`、`extension/README.md` | 扩展绑定一节 |

---

### Task 0: 基线

- [ ] **Step 1:** 跑后端与扩展的全量测试和类型检查，把通过数记进本 Task 的 commit 正文（不改代码则不提交，记在执行日志里）。

```bash
pnpm vitest run 2>&1 | tail -5
pnpm --dir extension vitest run 2>&1 | tail -5
pnpm tsc --noEmit -p . && pnpm --dir extension tsc --noEmit
```

- [ ] **Step 2:** 若基线有红，先停下报告，不在红基线上开工。

---

### Task 1: `ExtBindingStore` —— 扩展绑定表

**Files:** Create `src/devices/ext-binding-store.ts`, `src/devices/ext-binding-store.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// src/devices/ext-binding-store.test.ts
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExtBindingStore } from './ext-binding-store.ts'
import { MAX_PAIR_FAILURES, PAIRING_TTL_MS } from './device-store.ts'

const fresh = (now = () => 1_000) => new ExtBindingStore(join(mkdtempSync(join(tmpdir(), 'extb-')), 'ext-bindings.json'), { now })

describe('ExtBindingStore', () => {
  it('pairs a code onto the device it was minted for', () => {
    const s = fresh()
    const { code } = s.createPairingCode('linux:nas')
    const r = s.pair(code, { name: 'NAS Chrome', browser: 'chrome', platform: 'linux' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.bindingId).toMatch(/^ext:[0-9a-f-]{36}$/)
    expect(r.deviceId).toBe('linux:nas')
    expect(s.bindingForToken(r.token)?.bindingId).toBe(r.bindingId)
    expect(s.list()).toEqual([expect.objectContaining({ bindingId: r.bindingId, deviceId: 'linux:nas', name: 'NAS Chrome' })])
  })

  it('stores only a hash of the token, 0600', () => {
    const s = fresh()
    const r = s.pair(s.createPairingCode('linux:nas').code, {})
    if (!r.ok) throw new Error('pair failed')
    const file = (s as unknown as { file: string }).file
    expect(readFileSync(file, 'utf8')).not.toContain(r.token)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(s.tokenHashOf(r.bindingId)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a code is single-use and expires', () => {
    let t = 1_000
    const s = fresh(() => t)
    const { code } = s.createPairingCode('linux:nas')
    expect(s.pair(code, {}).ok).toBe(true)
    expect(s.pair(code, {}).ok).toBe(false)
    const second = s.createPairingCode('linux:nas').code
    t += PAIRING_TTL_MS + 1
    expect(s.pair(second, {}).ok).toBe(false)
  })

  it('too many wrong codes burn the live one', () => {
    const s = fresh()
    const { code } = s.createPairingCode('linux:nas')
    for (let i = 0; i < MAX_PAIR_FAILURES; i++) s.pair('000000' === code ? '111111' : '000000', {})
    expect(s.pair(code, {}).ok).toBe(false)
  })

  it('a device holds several bindings; revoking the device drops them all', () => {
    const s = fresh()
    const a = s.pair(s.createPairingCode('linux:nas').code, {})
    const b = s.pair(s.createPairingCode('linux:nas').code, {})
    const c = s.pair(s.createPairingCode('linux:pc').code, {})
    if (!a.ok || !b.ok || !c.ok) throw new Error('pair failed')
    expect(s.forDevice('linux:nas').map((x) => x.bindingId).sort()).toEqual([a.bindingId, b.bindingId].sort())
    expect(s.revokeDevice('linux:nas').sort()).toEqual([a.bindingId, b.bindingId].sort())
    expect(s.list().map((x) => x.bindingId)).toEqual([c.bindingId])
    expect(s.bindingForToken(a.token)).toBeUndefined()
  })

  it('refuses to start on an unreadable file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'extb-')), 'ext-bindings.json')
    writeFileSync(file, '{oops')
    expect(() => new ExtBindingStore(file)).toThrow(/ext-bindings\.json/)
  })
})
```

- [ ] **Step 2:** `pnpm vitest run src/devices/ext-binding-store.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// src/devices/ext-binding-store.ts
/**
 * 扩展绑定（design D7）：哪个 Chrome 扩展、挂在哪台设备上、凭哪把 token 连进来。
 *
 * 与 `DeviceStore` 同一套规矩，理由也相同：token 能驱动用户登录态浏览器，所以**只存哈希**、
 * 定长比较；配对码只在内存里，5 分钟一次性，连错 5 次全部作废。不同的是配对码**记着目标设备**——
 * 扩展自己说不清它和哪个 agent 在同一台机器上，这件事只有站在两台机器前的用户知道，签码那一刻说清楚。
 *
 * 本机绑定（`local`）不在这张表里：它的 token 是 `data/ext-relay-token`，经 native host 交给扩展。
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MAX_PAIR_FAILURES, PAIRING_TTL_MS, TOUCH_INTERVAL_MS } from './device-store.ts'

const MAX_FIELD = 64

export interface ExtBinding {
  bindingId: string
  deviceId: string
  name: string
  browser?: string
  platform?: string
  pairedAt: number
  lastSeenAt?: number
}

export type ExtPairResult =
  | { ok: true; bindingId: string; token: string; deviceId: string }
  | { ok: false; reason: 'invalid-code' }

interface Row extends ExtBinding {
  tokenHash: string
}

const sha256 = (s: string) => createHash('sha256').update(s).digest()
const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_FIELD) : undefined)

export class ExtBindingStore {
  private rows: Row[]
  private readonly codes = new Map<string, { expiresAt: number; deviceId: string }>()
  private failures = 0
  private readonly now: () => number
  private readonly log?: (line: string) => void

  constructor(
    private readonly file: string,
    opts: { now?: () => number; log?: (line: string) => void } = {},
  ) {
    this.now = opts.now ?? Date.now
    this.log = opts.log
    this.rows = existsSync(file) ? ExtBindingStore.load(file) : []
  }

  private static load(file: string): Row[] {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { bindings?: unknown } | null
      if (!parsed || !Array.isArray(parsed.bindings)) throw new Error('"bindings" is not an array')
      return parsed.bindings as Row[]
    } catch (e) {
      throw new Error(`ext-bindings.json at ${file} is not readable: ${(e as Error).message}`, { cause: e })
    }
  }

  /** 每台设备各自一个码不够用——同一时刻只留一个活码，与设备配对同理：签码要人在机器前，不会并发。 */
  createPairingCode(deviceId: string): { code: string; expiresAt: number } {
    this.codes.clear()
    this.failures = 0
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const expiresAt = this.now() + PAIRING_TTL_MS
    this.codes.set(code, { expiresAt, deviceId })
    return { code, expiresAt }
  }

  pair(code: string, info: { name?: unknown; browser?: unknown; platform?: unknown }): ExtPairResult {
    const t = this.now()
    for (const [c, v] of this.codes) if (v.expiresAt <= t) this.codes.delete(c)
    const hit = this.codes.get(code)
    if (!hit) {
      if (++this.failures >= MAX_PAIR_FAILURES) {
        this.codes.clear()
        this.failures = 0
        this.log?.(`[ext-bindings] ${MAX_PAIR_FAILURES} failed pairing attempts — the live code was invalidated`)
      }
      return { ok: false, reason: 'invalid-code' }
    }
    this.codes.delete(code)
    this.failures = 0
    const bindingId = `ext:${randomUUID()}`
    const token = randomBytes(32).toString('hex')
    const browser = clean(info.browser)
    const platform = clean(info.platform)
    this.rows.push({
      bindingId,
      deviceId: hit.deviceId,
      name: clean(info.name) ?? 'Chrome',
      ...(browser ? { browser } : {}),
      ...(platform ? { platform } : {}),
      pairedAt: t,
      tokenHash: sha256(token).toString('hex'),
    })
    this.save()
    return { ok: true, bindingId, token, deviceId: hit.deviceId }
  }

  bindingForToken(token: string): ExtBinding | undefined {
    const h = sha256(token)
    let hit: Row | undefined
    // 走完每一行：耗时不随命中位置变
    for (const r of this.rows) {
      const stored = Buffer.from(r.tokenHash, 'hex')
      if (stored.length === h.length && timingSafeEqual(stored, h)) hit = r
    }
    return hit ? strip(hit) : undefined
  }

  /** verify 用它当 HMAC key（实例没有 token 明文，见计划 Global Constraints）。 */
  tokenHashOf(bindingId: string): string | undefined {
    return this.rows.find((r) => r.bindingId === bindingId)?.tokenHash
  }

  get(bindingId: string): ExtBinding | undefined {
    const r = this.rows.find((x) => x.bindingId === bindingId)
    return r ? strip(r) : undefined
  }

  list(): ExtBinding[] {
    return this.rows.map(strip)
  }

  forDevice(deviceId: string): ExtBinding[] {
    return this.rows.filter((r) => r.deviceId === deviceId).map(strip)
  }

  revoke(bindingId: string): boolean {
    const before = this.rows.length
    this.rows = this.rows.filter((r) => r.bindingId !== bindingId)
    if (this.rows.length === before) return false
    this.save()
    return true
  }

  /** 设备被撤销，挂在它上面的绑定一并撤销；返回被撤的 id，调用方据此断开连接。 */
  revokeDevice(deviceId: string): string[] {
    const gone = this.rows.filter((r) => r.deviceId === deviceId).map((r) => r.bindingId)
    if (!gone.length) return []
    this.rows = this.rows.filter((r) => r.deviceId !== deviceId)
    this.save()
    return gone
  }

  touch(bindingId: string): void {
    const r = this.rows.find((x) => x.bindingId === bindingId)
    if (!r) return
    const t = this.now()
    if (r.lastSeenAt !== undefined && t - r.lastSeenAt < TOUCH_INTERVAL_MS) return
    r.lastSeenAt = t
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ bindings: this.rows }, null, 2) + '\n', { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
  }
}

function strip({ tokenHash: _h, ...b }: Row): ExtBinding {
  return b
}
```

- [ ] **Step 4:** 测试通过；`pnpm tsc --noEmit -p .` 通过。
- [ ] **Step 5:** Commit `feat(devices): extension binding store — codes minted for a device, hashed tokens` 并 **push**。

---

### Task 2: `ExtRelayRegistry` —— 每条绑定一条 relay

**Files:** Create `src/http/ext-relay-registry.ts`, `src/http/ext-relay-registry.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// src/http/ext-relay-registry.test.ts
import { describe, expect, it } from 'vitest'
import { ExtRelay } from './ext-relay.ts'
import { ExtRelayRegistry } from './ext-relay-registry.ts'
import { DeviceIncapable, DeviceOffline } from '../devices/errors.ts'

const sock = () => ({ send: () => {} })
const make = (bindings: Record<string, string>) => {
  let t = 0
  const reg = new ExtRelayRegistry({
    local: new ExtRelay(),
    makeRelay: () => new ExtRelay(),
    deviceOf: (id) => bindings[id],
    bindingsOf: (dev) => Object.keys(bindings).filter((k) => bindings[k] === dev),
    now: () => ++t,
  })
  return reg
}

describe('ExtRelayRegistry', () => {
  it('local always picks local', () => {
    expect(make({}).pick('local')).toBe('local')
  })

  it('no binding on the device → device-incapable', () => {
    expect(() => make({}).pick('linux:nas')).toThrow(DeviceIncapable)
  })

  it('bindings exist but none online → device-offline', () => {
    expect(() => make({ 'ext:a': 'linux:nas' }).pick('linux:nas')).toThrow(DeviceOffline)
  })

  it('picks the most recently connected online binding of that device', () => {
    const reg = make({ 'ext:a': 'linux:nas', 'ext:b': 'linux:nas', 'ext:c': 'linux:pc' })
    reg.connect('ext:a', sock())
    reg.connect('ext:c', sock())
    reg.connect('ext:b', sock())
    expect(reg.pick('linux:nas')).toBe('ext:b')
    expect(reg.hasBrowser('linux:nas')).toBe(true)
  })

  it('a disconnected binding is skipped', () => {
    const reg = make({ 'ext:a': 'linux:nas', 'ext:b': 'linux:nas' })
    const a = sock()
    const b = sock()
    reg.connect('ext:a', a)
    reg.connect('ext:b', b)
    reg.disconnect('ext:b', b)
    expect(reg.pick('linux:nas')).toBe('ext:a')
  })

  it('relay(id) of an unknown binding throws instead of handing out a fresh relay', () => {
    expect(() => make({}).relay('ext:nope')).toThrow(/ext:nope/)
  })
})
```

- [ ] **Step 2:** 跑 → FAIL。

- [ ] **Step 3: 实现**

```ts
// src/http/ext-relay-registry.ts
/**
 * 每条扩展绑定一条 `ExtRelay`（design D7）。`local` 那条就是今天的单例，构造时交进来、永远在；
 * 配对绑定的 relay 在它第一次连上时建，之后常驻（断开只是 `connected=false`，pending 由 relay 自己 reject）。
 *
 * 「设备有浏览器」= 至少一条挂在它上面的绑定在线。选哪条：最近连上的那条——计划 4 的默认绑定落地前，
 * 这是唯一不需要用户配置就说得通的规则（刚开的那个 Chrome 最可能是用户正看着的）。
 */
import { DeviceIncapable, DeviceOffline } from '../devices/errors.ts'
import { LOCAL_DEVICE } from '../devices/run-context.ts'
import type { ExtHandshake } from '../../shared/browser-relay/handshake.ts'
import type { ExtRelay, ExtSocket } from './ext-relay.ts'

export const LOCAL_BINDING = 'local'

export interface ExtRelayRegistryDeps {
  local: ExtRelay
  makeRelay: (bindingId: string) => ExtRelay
  /** 绑定挂在哪台设备（`ExtBindingStore.get`）；`local` 不经它。 */
  deviceOf: (bindingId: string) => string | undefined
  bindingsOf: (deviceId: string) => string[]
  now?: () => number
}

export class ExtRelayRegistry {
  private readonly relays = new Map<string, ExtRelay>()
  private readonly connectedAt = new Map<string, number>()
  private readonly sockets = new Map<string, ExtSocket & { close?: (code: number, reason: string) => void }>()

  constructor(private readonly deps: ExtRelayRegistryDeps) {
    this.relays.set(LOCAL_BINDING, deps.local)
  }

  get local(): ExtRelay {
    return this.deps.local
  }

  connect(bindingId: string, socket: ExtSocket & { close?: (code: number, reason: string) => void }, info?: ExtHandshake): void {
    let r = this.relays.get(bindingId)
    if (!r) {
      r = this.deps.makeRelay(bindingId)
      this.relays.set(bindingId, r)
    }
    r.connect(socket, info)
    this.sockets.set(bindingId, socket)
    this.connectedAt.set(bindingId, (this.deps.now ?? Date.now)())
  }

  disconnect(bindingId: string, socket: ExtSocket): void {
    this.relays.get(bindingId)?.disconnect(socket)
    if (this.sockets.get(bindingId) === socket) {
      this.sockets.delete(bindingId)
      this.connectedAt.delete(bindingId)
    }
  }

  /** 撤销：断开并忘掉。返回它当时在不在线。 */
  kick(bindingId: string, code: number, reason: string): boolean {
    const s = this.sockets.get(bindingId)
    this.sockets.delete(bindingId)
    this.connectedAt.delete(bindingId)
    if (bindingId !== LOCAL_BINDING) this.relays.delete(bindingId)
    if (!s) return false
    try { s.close?.(code, reason) } catch { /* 已经断了 */ }
    return true
  }

  relay(bindingId: string): ExtRelay {
    const r = this.relays.get(bindingId)
    if (!r) throw new Error(`没有这条扩展绑定的中继：${bindingId}`)
    return r
  }

  isOnline(bindingId: string): boolean {
    return this.relays.get(bindingId)?.connected ?? false
  }

  hasBrowser(deviceId: string): boolean {
    if (deviceId === LOCAL_DEVICE) return this.deps.local.connected
    return this.deps.bindingsOf(deviceId).some((b) => this.isOnline(b))
  }

  pick(deviceId: string): string {
    if (deviceId === LOCAL_DEVICE) return LOCAL_BINDING
    const all = this.deps.bindingsOf(deviceId)
    if (!all.length) throw new DeviceIncapable(deviceId, 'browser')
    const online = all.filter((b) => this.isOnline(b))
    if (!online.length) throw new DeviceOffline(deviceId)
    return online.reduce((best, b) => ((this.connectedAt.get(b) ?? 0) > (this.connectedAt.get(best) ?? 0) ? b : best))
  }

  /** 面板与诊断用：每条已知 relay 的在线状态。 */
  statuses(): Array<{ bindingId: string; deviceId: string; online: boolean; since: string | null }> {
    return [...this.relays.entries()].map(([bindingId, r]) => ({
      bindingId,
      deviceId: bindingId === LOCAL_BINDING ? LOCAL_DEVICE : this.deps.deviceOf(bindingId) ?? '?',
      online: r.connected,
      since: r.status().since,
    }))
  }
}
```

（`DeviceOffline` 的构造签名照 `src/devices/errors.ts` 实际的来；若它要第二个参数，按现有调用点补。）

- [ ] **Step 4:** 测试通过、类型通过。
- [ ] **Step 5:** Commit `feat(ext-relay): a registry of relays, one per extension binding` 并 **push**。

---

### Task 3: WS 升级与 verify 认绑定

**Files:** Modify `shared/browser-relay/relay.ts`, `shared/browser-relay/verify.ts`, `src/http/app.ts`; Tests `src/http/ext-relay.test.ts`（新增用例）、`src/http/app.ext-verify.test.ts`（新增用例）

- [ ] **Step 1: 写失败的测试**
  - `verifyExtUpgrade` 旁新增纯函数 `resolveExtUpgrade(info, resolveToken)`：返回 `bindingId | null`。用例：本机 token → `'local'`；配对 token → `'ext:a'`；未知 token → `null`；http(s) Origin 即便 token 对也 → `null`；offer 了两个 token → `null`。
  - `attachExtRelay` 新签名 `attachExtRelay(server, target, opts)`，`target` 为 `ExtRelay | { connect(bindingId, socket, info); disconnect(bindingId, socket) }`，`opts` 接受 `token`（旧）或 `resolveToken`（新）。用例：用 `resolveToken` 起一个真 http server，`ws` 客户端以配对 token 握手 → registry 收到 `connect('ext:a', …)`；关闭 → `disconnect('ext:a', …)`。
  - `/api/ext/verify` body `{ nonce, binding: 'ext:a' }` → proof = `HMAC(tokenHashOf('ext:a'), PREFIX+nonce)`；`binding: 'ext:nope'` → 200 且 proof 与任何真 key 都对不上；`EXT_VERIFY_KEYS` 加 `binding` 后旧的 `{ nonce }` 请求原样通过（老测试不改）。

- [ ] **Step 2:** 跑 → FAIL。

- [ ] **Step 3: 实现**
  - `shared/browser-relay/verify.ts` 加：

```ts
/**
 * 配对绑定的挑战应答。实例只存 token 的 SHA-256（hex），所以 key 是那个哈希；扩展侧先算
 * `sha256hex(token)` 再签。见计划 3/4 Global Constraints 里对这一取舍的说明。
 */
export function extVerifyProofForBinding(tokenHashHex: string, nonce: string): string {
  return extVerifyProof(tokenHashHex, nonce)
}
```

  - `relay.ts`：`verifyExtUpgrade` 保留（老测试在用）；新增 `resolveExtUpgrade(info, resolveToken: (t: string) => string | null): string | null`，Origin 与「只 offer 一个 token」两条判据与 `verifyExtUpgrade` 共用一个内部函数取出 candidate。`attachExtRelay` 的 `opts` 改为 `{ token?: string; resolveToken?: (t: string) => string | null; path?; log? }`：给了 `token` 就 `resolveToken = (t) => tokenEqual(t, token) ? 'local' : null`。`target` 是 `ExtRelay` 时包一层 `{ connect: (_id, s, i) => relay.connect(s, i), disconnect: (_id, s) => relay.disconnect(s) }`。日志行加上 `binding=<id>`。
  - `app.ts`：`extRelayAuth` 增加可选 `tokenHashOf?: (bindingId: string) => string | undefined`；`EXT_VERIFY_KEYS = ['nonce', 'binding']`；`binding` 存在且为字符串时：`key = tokenHashOf?.(binding) ?? randomBytes(32).toString('hex')`，回 `extVerifyProofForBinding(key, nonce)`。
- [ ] **Step 4:** 新老测试全过。
- [ ] **Step 5:** Commit `feat(ext-relay): the /api/ext upgrade and verify recognise paired bindings` 并 **push**。

---

### Task 4: 执行上下文选浏览器，并固定一整次执行

**Files:** Modify `src/devices/run-context.ts`, `src/devices/placement.ts`; Tests `src/devices/placement.test.ts`

- [ ] **Step 1: 写失败的测试**（加在 `placement.test.ts`）

```ts
describe('pickBrowser', () => {
  const reg = (picks: string[]) => {
    let i = 0
    return { pick: () => picks[i++] ?? 'none' }
  }
  it('outside any run → local', () => {
    expect(pickBrowser(reg(['ext:a']))).toBe('local')
  })
  it('keeps the first pick for the whole run', async () => {
    const p = { deviceId: 'linux:nas', allowHosts: [], browser: {} }
    const r = reg(['ext:a', 'ext:b'])
    await runOnDevice(p, async () => {
      expect(pickBrowser(r)).toBe('ext:a')
      expect(pickBrowser(r)).toBe('ext:a')
    })
  })
  it('device-incapable from the registry propagates before anything is sent', async () => {
    const p = { deviceId: 'linux:nas', allowHosts: [], browser: {} }
    await expect(runOnDevice(p, async () => pickBrowser({ pick: () => { throw new DeviceIncapable('linux:nas', 'browser') } }))).rejects.toThrow(DeviceIncapable)
  })
})
```

  并把现有断言「绑定到远程设备的 browser recipe 抛 DeviceIncapable」改为：`assertRecipeRunnable(p, 'browser', ready, browsers)` 调 `browsers.pick(p.deviceId)`（有在线绑定则不抛）。

- [ ] **Step 2:** 跑 → FAIL。
- [ ] **Step 3: 实现**
  - `run-context.ts`：

```ts
export interface RunPlacement {
  // …现有字段…
  /**
   * 本次执行用哪个扩展绑定（design D7）。执行入口每次新建一个空对象；第一次需要浏览器时由
   * `pickBrowser` 填上，之后整次执行不变——中途新连上的 Chrome 不会把一半的登录切到另一个浏览器里。
   */
  browser?: { bindingId?: string }
}
```

  - `placement.ts`：删除 `assertLocalBrowser`；新增

```ts
export interface BrowserPicker {
  pick(deviceId: string): string
}

/** 本次执行的扩展绑定。没有执行上下文（采集面板、MCP 工具）= `local`。 */
export function pickBrowser(reg: BrowserPicker): string {
  const p = currentPlacement()
  if (p.deviceId === LOCAL_DEVICE && !p.browser) return 'local'
  if (p.browser?.bindingId) return p.browser.bindingId
  const id = reg.pick(p.deviceId)
  if (p.browser) p.browser.bindingId = id
  return id
}
```

  `assertRecipeRunnable(p, kind, ready?, browsers?)`：浏览器类分支改为 `browsers ? void pickBrowser(browsers) : (() => { throw new DeviceIncapable(p.deviceId, 'browser') })()`——没接 registry 的调用点保持旧的严格行为。
  - 执行入口（任务中心 `runAction`、调度器 `makeFacilityPlacement` 的使用处）新建 placement 时一并带上 `browser: {}`，与 `dispatch` 同处。用 `codegraph_callers` 找 `runOnDevice` 的每个调用点，逐个补上。
- [ ] **Step 4:** 全量后端测试通过（`assertLocalBrowser` 的老测试改为对 `pickBrowser` 的断言，不删场景）。
- [ ] **Step 5:** Commit `feat(devices): a run picks its extension binding once and keeps it` 并 **push**。

---

### Task 5: lane 与 Transport 按绑定

**Files:** Modify `src/replay/session-manager.ts`, `src/kernel/plugins/harvest.ts`; Tests `src/replay/session-manager.test.ts`（新增用例）

- [ ] **Step 1: 写失败的测试**
  - 两条绑定、同一 facility 同一 laneKey：在 `bindingOf = () => 'ext:a'` 下 acquire 一次，再在 `'ext:b'` 下 acquire 一次 → 两个不同 lane，`transportFor` 分别以 a、b 被调用。
  - 预算按绑定计：`maxLanesGlobal: 1`，a 下已有一条闲置 lane，b 下 acquire 不会回收 a 的那条（各自是一个 Chrome 的标签）。
  - keepAlive 旧格式迁移：store 里 `{ "photopea\u0000default": 42 }` 读进来视为 `local` 的；`pinnedTabIds('local')` = `[42]`，`pinnedTabIds('ext:a')` = `[]`。
- [ ] **Step 2:** 跑 → FAIL。
- [ ] **Step 3: 实现**
  - `SessionBudget` 增加 `bindingOf?: () => string`（缺省 `() => 'local'`）。`resolveTransport` 签名改为 `(spec, bindingId) => Transport`。
  - `key(facility, laneKey)` → `` `${this.bindingOf()}\0${facility}\0${laneKey}` ``；所有按 facility 计数的预算判定只数**同一绑定前缀**的 entry。`closeAll()` 不变（遍历全部）。
  - keepAlive 读入时：键里只有一个 `\0` 的，前面补 `local\0`。`pinnedTabIds(bindingId = 'local')` 只返回该前缀的。
  - `harvest.ts`：

```ts
const extRelays = new ExtRelayRegistry({
  local: extRelay,
  makeRelay: () => new ExtRelay({
    ...(config.onDebug && { onDebug: config.onDebug }),
    ...(config.notify && { onNotify: config.notify }),
  }),
  deviceOf: (id) => config.extBindings.get(id)?.deviceId,
  bindingsOf: (dev) => config.extBindings.forDevice(dev).map((b) => b.bindingId),
})
// 每条绑定一个 Transport，按需建、建了就留（Transport 无状态，留着只是省一次构造）。
const transports = new Map<string, Transport>([['local', transport]])
const transportOf = (bindingId: string): Transport => {
  let t = transports.get(bindingId)
  if (!t) {
    const relay = extRelays.relay(bindingId)
    t = resolveTransport({ extLauncher: makeExtensionLauncher(relay, { onDebug: config.onDebug }), extRelay: relay, onDebug: config.onDebug })
    transports.set(bindingId, t)
  }
  return t
}
const bindingOf = () => pickBrowser(extRelays)
const transportFor = (_spec: RecipeSessionSpec, bindingId = bindingOf()) => transportOf(bindingId)
```

    `RecipeSessionManager` 构造时传 `bindingOf`；`SessionRecipeExecutor` 的 `transportFor` 同一个函数。`HarvestService` 暴露 `extRelays`（`extRelay` 保留，= `extRelays.local`，serve.ts 现有十来处读它的地方不动）。`claimedTabs` 改为 `(bindingId = 'local') => …pinnedTabIds(bindingId) ∪ 该绑定 lane 的 tabId`。
  - `HarvestConfig` 新增 `extBindings: Pick<ExtBindingStore, 'get' | 'forDevice'>`，由 bootstrap 注入（Task 7 一起接）。
- [ ] **Step 4:** 全量后端测试通过。
- [ ] **Step 5:** Commit `feat(replay): lanes and transports are per extension binding` 并 **push**。

---

### Task 6: 登录与 cookie 拉取在执行设备上

**Files:** Modify `src/kernel/plugins/auth.ts`, `src/credentials/cookie-puller.ts`（不改逻辑，只确认接口够用）; Test `src/devices/e2e.test.ts`（新增场景）

- [ ] **Step 1: 写失败的集成测试**（照 `e2e.test.ts` 现有的装配方式）：NAS 设备、一条挂在 NAS 上的假扩展绑定（用 `ExtRelay` + 假 socket 回放 `cookiePull` / `newTab`）；绑定到 NAS 的执行调 `ctx.login('eastmoney')`：
  - 登录 recipe 的 `newTab` 打到 NAS 绑定那条 relay；`local` relay 一条命令都没收到。
  - 之后 `cookies/linux:nas.json` 里有东财的 cookie；`cookies/local.json` 内容不变。
  - NAS 绑定离线时同一调用以 `DeviceOffline` 失败，`local` relay 仍零命令。
- [ ] **Step 2:** 跑 → FAIL（今天会因 `assertLocalBrowser` 抛 `DeviceIncapable`）。
- [ ] **Step 3: 实现**
  - `auth.ts`：把单个 `cookiePuller` 换成

```ts
// 每台设备一个 puller：拉的是那台设备当前选中的绑定，写的是那台设备的快照（design D4）。
// puller 自带并发去重，所以必须按设备缓存，不能每次 new。
const pullers = new Map<string, CookiePuller>()
const cookiePullerFor = (deviceId: string): CookiePuller => {
  let p = pullers.get(deviceId)
  if (!p) {
    p = new CookiePuller({
      relay: deviceId === LOCAL_DEVICE ? extRelay : {
        get connected() { return ctx.harvest.extRelays.hasBrowser(deviceId) },
        cookiePull: (domains) => ctx.harvest.extRelays.relay(pickBrowser(ctx.harvest.extRelays)).cookiePull(domains),
      },
      store: ctx.credentials.cookieStores.forDevice(deviceId),
      requiredDomains: () => config.requiredCookieDomainsFor(deviceId),
      log,
      report: config.onDebug,
    })
    pullers.set(deviceId, p)
  }
  return p
}
const cookiePuller = cookiePullerFor(LOCAL_DEVICE) // 触发 ①②③ 照旧挂在本机这条上
```

  - `setFacilityLogin`：删掉 `assertLocalBrowser(currentPlacement())`，改为 `pickBrowser(ctx.harvest.extRelays)`（先判，失败不开任何 tab）；`adoptCookies` 里 `cookiePullerFor(currentDeviceId()).pull('facility-login')`。
  - `config.requiredCookieDomainsFor(deviceId)`：bootstrap 里实现 D4 的规则——`local` = 今天的全集减去绑到其他设备的 facility 的域；其他设备 = 只取绑到它的 facility 的域（`facilityDevices` + 包的 `stream.credentials`）。若计划 1 已有等价函数，复用它（先 `codegraph_search requiredCookieDomains`）。
  - 配对绑定一连上也触发一轮拉取：`extRelays.relay(id).onConnected(() => cookiePullerFor(deviceOf(id)).pull('relay-connected'))`——在 registry 建 relay 处挂（`makeRelay` 回调里）。
- [ ] **Step 4:** 集成测试与全量测试通过。
- [ ] **Step 5:** Commit `feat(auth): a facility login runs in the browser of the run's device` 并 **push**。

---

### Task 7: 配对与撤销的 HTTP 接口，serve 接线

**Files:** Create `src/http/ext-binding-routes.ts`, `src/http/ext-binding-routes.test.ts`; Modify `src/http/device-routes.ts`, `src/http/app.ts`, `src/serve.ts`, `src/bootstrap.ts`

- [ ] **Step 1: 写失败的测试**（用 Hono app 直测，照 `device-routes.test.ts` 的写法）
  - `POST /api/devices/linux:nas/ext-pairing-code`：非本机 → 403；`local` → 400；不存在的设备 → 404；本机 → 200 `{ code, expiresAt }`。
  - `POST /api/ext/pair`：Origin 不是 `chrome-extension://…` → 403；错码 → 403 `invalid-code`；对码 → 200 `{ bindingId, token, deviceId: 'linux:nas', deviceName }`；不带 API token 也能到（在 `TOKEN_EXEMPT_ROUTES` 里）。
  - `GET /api/ext/bindings`：列出、带 `online`（来自 registry）。
  - `DELETE /api/ext/bindings/ext:a` → 204，registry 收到 `kick('ext:a', 4003, 'revoked')`；再删 → 404。
  - `DELETE /api/devices/linux:nas` 之后，挂在 NAS 上的绑定从列表里消失，且每条都被 kick。
- [ ] **Step 2:** 跑 → FAIL。
- [ ] **Step 3: 实现**
  - `ext-binding-routes.ts`：`mountExtBindingRoutes(app, { store, registry, devices: { exists(id), name(id) }, isLocal })`，四条路由按 Global Constraints 的线上形状写。Origin 判据复用 `/api/ext/verify` 那一条（把它从 `app.ts` 抽成 `isExtensionOrigin(c, extId?)` 放在同文件导出，verify 与 pair 共用）。
  - `device-routes.ts`：`TOKEN_EXEMPT_ROUTES` 加 `{ method: 'POST', path: '/api/ext/pair' }`；`DELETE /api/devices/:id` 之后调可选的 `onRevoked?.(id)`。
  - `bootstrap.ts`：`new ExtBindingStore(join(dataDir, 'ext-bindings.json'), { log })`，注入 harvest（`extBindings`）与 app deps；`onRevoked = (id) => extBindings.revokeDevice(id).forEach((b) => harvest.extRelays.kick(b, 4003, 'revoked'))`。
  - `serve.ts`：`attachExtRelay(server, harvest.extRelays, { resolveToken: (t) => tokenEqual(t, extToken) ? 'local' : extBindings.bindingForToken(t)?.bindingId ?? null })`；连上时 `extBindings.touch(id)`。`extRelayAuth` 补 `tokenHashOf: (id) => extBindings.tokenHashOf(id)`。`claimedTabs` 透传 `?binding=`。
- [ ] **Step 4:** 全量后端测试通过；手工冒烟：本机起后端，`curl -X POST 127.0.0.1:8900/api/devices/<id>/ext-pairing-code` 拿到码。
- [ ] **Step 5:** Commit `feat(http): pair an extension onto a device, list and revoke bindings` 并 **push**。

---

### Task 8: 扩展 —— 配置变成一组绑定

**Files:** Modify `extension/src/lib/config.ts`, `extension/src/lib/config.test.ts`; Create `extension/src/lib/pair-code.ts`, `extension/src/lib/pair-code.test.ts`; Modify `extension/src/lib/backend-identity.ts`

- [ ] **Step 1: 写失败的测试**
  - `config.test.ts`：
    - 旧配置 `{ baseUrl: 'http://127.0.0.1:8900', domains: ['a.com'], requiredDomains: ['b.com'], autoSync: true }` 经 `getBindings()` → 一条 `{ id: 'local', kind: 'local', baseUrl: 'http://127.0.0.1:8900', domains: ['a.com'], requiredDomains: ['b.com'], autoSync: true }`；旧字段原样留在存储里（回滚到旧扩展还能用）。
    - `allowedDomains(local)` = domains ∪ requiredDomains；`allowedDomains(paired)` = domains ∪ (requiredDomains ∩ approvedDomains)；`pendingDomains(paired)` = requiredDomains − approvedDomains − domains。
    - `storageKey('tabGroup', 'local')` = `'tabGroup'`；`storageKey('tabGroup', 'ext:a')` = `'tabGroup:ext:a'`。
  - `pair-code.test.ts`（注入 `fetch`）：
    - `http://203.0.113.5:8900` → 抛 `PairAddressRefused`，`fetch` 一次没被调用。
    - `https://main.example`、`http://127.0.0.1:8900`、`http://localhost:8900` 放行。
    - 200 回复 → 返回 `{ bindingId, token, deviceId, deviceName }`；403 → 抛「配对码不对或已过期」；回复缺 `token` → 抛。
  - `backend-identity.test.ts`：`verifyBackend(url, token, { binding: 'ext:a' })` 的请求体含 `binding`，期望 proof 用 `sha256hex(token)` 作 key。
- [ ] **Step 2:** 跑 → FAIL。
- [ ] **Step 3: 实现**
  - `config.ts`：

```ts
export interface Binding {
  /** `local` 或实例发的 `ext:<uuid>`。 */
  id: string
  kind: 'local' | 'paired'
  baseUrl: string
  /** 只有配对绑定落盘 token；本机绑定每次经 native host 现取（见 native-host.ts）。 */
  token?: string
  label: string
  deviceName?: string
  domains: string[]
  requiredDomains?: string[]
  /** 配对绑定：用户批准过的 requiredDomains。远程实例新要的域名不自动生效。 */
  approvedDomains?: string[]
  autoSync: boolean
  revoked?: boolean
  lastSync?: number
}
```

    `getBindings()`：存储里有 `bindings` 就用；否则从旧 `config` 合成本机那一条（不写回——第一次 `setBinding` 时才写，旧字段保留）。`setBinding(id, patch)`、`addBinding(b)`、`removeBinding(id)`。`getConfig/setConfig` 保留为本机绑定的读写别名，现有调用点与测试不动。`allowedDomains`、`pendingDomains`、`storageKey` 按上面的测试写。
  - `pair-code.ts`：`isPairableAddress(url)`（`https:` 或 hostname ∈ {`127.0.0.1`, `localhost`, `[::1]`}）；`pairWithCode(baseUrl, code, info, deps = { fetch })` → `POST <baseUrl>/api/ext/pair`。成功后由调用方 `addBinding({ id: bindingId, kind: 'paired', baseUrl, token, label: deviceName, deviceName, domains: [], approvedDomains: [], autoSync: true })`。
  - `backend-identity.ts`：`verifyBackend(baseUrl, token, opts?: { binding?: string })`——有 `binding` 时请求体带上它，key 用 `await sha256hex(token)`。
- [ ] **Step 4:** 扩展测试全过（老的 config / identity 测试不改）。
- [ ] **Step 5:** Commit `feat(extension): bindings in config, pairing with a code` 并 **push**。

---

### Task 9: 扩展 —— driver 按绑定

**Files:** Modify `extension/src/lib/driver.ts`; Create `extension/src/lib/driver.bindings.test.ts`

这是本计划最大的一块。原则：**本机绑定走的代码路径与今天相同**，所有新参数缺省为本机。

- [ ] **Step 1: 写失败的测试**（照现有 `driver.*.test.ts` 的 chrome mock 写法）
  - 两条绑定 `local`、`ext:a`：各自 `addTabToGroup` 一张 tab → 两个不同 groupId，存储键分别为 `tabGroup`、`tabGroup:ext:a`。
  - `refuses a tab owned by another binding`：`dispatch({ op: 'cdp', tabId: <local 组里的 tab>, … }, rtA)` → 错误含 `not in the session tab group`，`chrome.debugger.attach` 未被调用。
  - 用户把一张 tab 拖进 `ext:a` 的组 → 它归 `ext:a`，不归 `local`。
  - 被 `ext:a` 组里的 tab `window.open` 出来的新 tab 进 `ext:a` 的组。
  - `cookiePull` 对 `ext:a`：`requiredDomains: ['eastmoney.com', 'mail.google.com']`、`approvedDomains: ['eastmoney.com']` → `cookies` 只有 eastmoney，`refused` 含 `mail.google.com`。
  - 一条绑定的 WS 收到关闭码 4003 → 该绑定 `revoked: true`，不再 `scheduleRetry`；另一条绑定的连接不受影响。
  - `ext:a` 连接失败的退避不影响 `local` 的退避值。
- [ ] **Step 2:** 跑 → FAIL。
- [ ] **Step 3: 实现**
  - 新增

```ts
/**
 * 一条绑定的会话状态（design D7）。今天模块级的那几样——组、归属账本、它们的串行队列与
 * 水合闸、事件 socket、订阅、退避、重试句柄、在线标记——每条绑定一份。
 * **按 tab 的状态（childSessions、autoAttached、closingTabs、memberBornAt）不进来**：一张 tab
 * 至多属于一条绑定，按 tabId 记本来就不会串。
 */
class BindingRuntime {
  groupMem: GroupState | null = null
  groupQueue: Promise<unknown> = Promise.resolve()
  hydratingGroup: Promise<GroupState> | null = null
  ownedMem: Set<number> | null = null
  mutateQueue: Promise<unknown> = Promise.resolve()
  hydratingOwned: Promise<Set<number>> | null = null
  eventSocket: WebSocket | null = null
  subscriptions = new Map<number, { tabId: number; domains: Set<string> }>()
  backoff = 1000
  pendingRetry: { timer: ReturnType<typeof setTimeout>; run: () => void } | null = null
  relayUp = false
  constructor(readonly id: string) {}
  key(base: string): string { return storageKey(base, this.id) }
}
const runtimes = new Map<string, BindingRuntime>()
export function runtime(id = 'local'): BindingRuntime { /* get-or-create */ }
```

  - 把上述模块级变量逐个搬进 `BindingRuntime`，读写它们的函数加**最后一个可选参数** `rt = runtime()`；`GROUP_KEY` / `OWNED_KEY` / `LEDGER_CHECKED_KEY` 的每处读写改成 `rt.key(…)`。一次搬一个变量、每搬一个跑一遍 `pnpm --dir extension vitest run src/lib/driver`，保持全绿。
  - 「这个 groupId 是谁的」：新增 `ownerOfGroup(gid): BindingRuntime | undefined`，遍历 `runtimes` 用 `isOurGroup`。拖入监听、`onTabCreated`（opener 所在组）、`reconcileOnWake` 都先问它，再在那个 runtime 上操作。
  - `dispatch(msg, rt = runtime())`：所有按 tab 的 op 已经在用 `inGroup(tabId)` 做闸——改成 `inGroup(tabId, rt)`，别的绑定的 tab 就自然被拒。`cookiePull` 的范围改用 `allowedDomains(binding)`，`refused` 照旧明说。`cookieNames` 同样只回 `allowedDomains` 内的域（远程实例不该能探测任意站点的登录与否）。
  - 连接：`connect(rt, binding)` 取代 `connect(wsUrl, baseUrl)`。token：本机 = `nativeHostToken()`；配对 = `binding.token`；身份验证都走 `verifyBackend(baseUrl, token, binding.kind === 'paired' ? { binding: binding.id } : undefined)`。`close` 事件 `code === 4003` → `setBinding(id, { revoked: true })`，不排重试。`reclaimOrphanTabs(baseUrl, rt)` 打 `claimed-tabs?binding=<id>`。
  - `start()`：本机绑定照旧走 `findPairedPeer` 候选表（逻辑不动）；之后对每条 `kind: 'paired' && !revoked` 的绑定各起一条 `connect`。`starting` 闸保持「每个 SW 实例只启动一次」；新加绑定时（popup 配对成功）走 `startBinding(id)`，同样按 id 去重。
  - `isRelayUp(id = 'local')`、`forceReconnect(id = 'local')` 按绑定。
- [ ] **Step 4:** 扩展全量测试通过（老 driver 测试一个不改）；`pnpm --dir extension tsc --noEmit` 通过。
- [ ] **Step 5:** Commit `feat(extension): the driver keeps a session per binding and refuses other bindings' tabs` 并 **push**。（这一步可能拆成几次 commit：每搬完一组变量全绿就提交并推送一次。）

---

### Task 10: 扩展 —— 同步与 popup

**Files:** Modify `extension/src/lib/sync.ts`, `extension/src/lib/sync-now.ts`, `extension/src/entrypoints/popup/*`, `extension/src/entrypoints/background.ts`

- [ ] **Step 1: 写失败的测试**
  - `sync.runsync.test.ts` 新增：`runSync('ext:a')` 打的是 `ext:a` 的 `baseUrl` 的 `/api/ext/sync-config`，回来的 `requiredDomains` 写进 `ext:a` 的绑定，不碰本机绑定；新出现的域进 `pendingDomains`。
  - cookie 变更触发：只叫醒范围内（`allowedDomains`）包含该域的那些绑定。
- [ ] **Step 2:** 跑 → FAIL。
- [ ] **Step 3: 实现**
  - `sync.ts` / `sync-now.ts`：函数加最后一个可选参数 `bindingId = 'local'`；通知走对应 runtime 的 `eventSocket`。
  - popup：绑定列表（标签、实例地址、设备名、在线 / 离线 / 已撤销）；「添加 Stream」表单（地址 + 6 位码，地址不合格当场提示「只能配对 HTTPS 或本机地址」）；每条配对绑定下的「待批准的网站」列表，逐个批准或拒绝（拒绝 = 从 pending 里隐藏，`approvedDomains` 不变）；已撤销的绑定显示「已被该 Stream 撤销」与「移除」按钮。
  - `background.ts`：`chrome.cookies.onChanged` 按绑定分发。
- [ ] **Step 4:** 扩展测试与类型检查通过；`pnpm --dir extension build` 成功。
- [ ] **Step 5:** Commit `feat(extension): per-binding sync, pending domains and a bindings list in the popup` 并 **push**。

---

### Task 11: 文档、tasks.md、实机冒烟

**Files:** Modify `docs/ARCHITECTURE.md`（执行位置一节）、`extension/README.md`、`openspec/changes/device-execution/tasks.md`

- [ ] **Step 1:** `ARCHITECTURE.md`：扩展绑定一节——两种绑定、绑定挂在设备上、选绑定规则、隔离、撤销、配对 proof 的 key 取舍。
- [ ] **Step 2:** `extension/README.md`：「绑定另一个 Stream」——在 Stream 面板（计划 4 前用 `curl`）为设备签码 → popup 填地址与码 → 批准网站。
- [ ] **Step 3:** `tasks.md` 计划 3 的条目展开为本计划的 Task 1–10，逐条打勾。
- [ ] **Step 4: 实机冒烟**（记录结果到 commit 正文）：
  1. 本机后端 + 本机 Chrome：升级后采集照常（回归）。
  2. 同一个 Chrome 用配对码绑定第二个实例（另一个 worktree 起在别的端口，以回环地址配对，挂在一台已配对的 Linux agent 上）。两边各自开出自己的标签组。
  3. 第二个实例对第一个实例组里的 tab 发命令 → 被拒。
  4. 第二个实例的 `sync-config` 要一个新域 → popup 出现待批准；批准前 `cookiePull` 的 `refused` 含它。
  5. `DELETE /api/ext/bindings/<id>` → popup 显示已撤销，本机绑定不受影响。
- [ ] **Step 5:** Commit `docs(device-execution): extension bindings` 并 **push**。

---

## 执行记录：与上文的偏离（2026-10-21）

- **扩展配置不迁移。** 原 `config` 原样就是本机那条绑定，配对绑定另存 `bindings` 键——没有迁移步骤，回滚到旧扩展也照常能用（Task 8）。
- **配对绑定拿不到 `/api/ext/sync-config`**：那一口对非本机来源要 API token。远程实例要哪些域，改由它在 `cookiePull` 里请求的域记成待批准；批准前照样 `refused`（Task 10）。
- **`run_action_recipe` 不接 registry**：MCP 动作 recipe 在远程设备上的浏览器类仍 `device-incapable`（Task 4/5 只给 `ReplayAdapter` 与 facility 登录接了）。
- **本机绑定的常驻标签文件形状不变**：键里绑定前缀只对配对绑定落盘（Task 5）。
- **4003 撤销的扩展侧只有单测覆盖路径以外的逻辑**：`driver.bindings.test.ts` 没模拟 WebSocket 关闭码；后端的 4003 由实机冒烟验证。
- **测试环境**：box 的系统 node 是 20，pnpm 11 需要更新的 node——装到 `~/.local/node22`。全量后端套件在本机负载下偶发 5 个计时类用例超时（与本计划无关，单独跑全过）。

## 计划 3 之后（计划 4：面板）

- 设备卡片上「添加浏览器」→ 调 `ext-pairing-code`，显示码与倒计时。
- 设备的默认绑定（存 `ext-bindings.json` 行上的 `default: true`），`pick` 先看它。
- 绑定列表、撤销按钮；运行记录显示设备名与绑定名。
- facility 默认设备选择、任务的设备覆盖。
