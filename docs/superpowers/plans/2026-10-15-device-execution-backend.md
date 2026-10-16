# Device Execution — Backend Implementation Plan (1/3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主实例能把一条任务（及其中的 HTTP 请求、登录态读取）放到用户绑定的设备上执行；设备不在线就失败，绝不回落本机。

**Architecture:** 一个 AsyncLocalStorage 承载「这次执行在哪台设备、允许访问哪些主机」（`RunPlacement`）。任务入口与 recipe 采集入口按「任务覆盖 → facility 默认设备 → local」解析出 placement 并 `runOnDevice` 包住整次执行。出站统一走 `fetchFor`：`local` 用 `ownedFetch`，其他设备经 host-relay 新 op `http.fetch`。登录态按（设备，域名）分文件存，`CookieProvider` 按当前 placement 读。

**Tech Stack:** TypeScript (Node 22, ESM, `tsx`)、vitest 4、better-sqlite3、hono、ws、sidequest 1.16。

**Spec:** `openspec/changes/device-execution/`（`proposal.md`、`design.md`、`specs/*/spec.md`）。本计划实现 design D1–D6、D9 的后端部分与 D8 的后端配对改动。

**本计划不含（后续计划）：**
- 计划 2/3 — Linux agent（Rust）：agent 侧 `http.fetch`、私网拒绝、`ALLOW_HOSTS`、`linux` 构建与无人值守配对、镜像。
- 计划 3/3 — 浏览器转发（D7）：agent 本机 8900 转发、按设备的 ExtRelay、远程设备的 cookie 拉取与登录。
- 计划 4 — 面板：facility 卡片默认设备、任务编辑器设备覆盖、运行记录设备列。本计划只交付 HTTP API。

在计划 3 落地前，绑定到远程设备的执行里 `ctx.login` 会以 `device-incapable` 失败（远程设备还没有浏览器通道）——这是 fail-closed 的预期行为，不是缺陷。

## Global Constraints

- 后端本机的设备 id 是字面量 `local`；它不出现在配对列表里，绑定为 `local` 等于清除绑定。
- 解析顺序：`task.device` → 动作所属包的 facility 默认设备 → `local`；在执行开始时解析一次，整次执行内不变。
- 非 `local` 设备上的任何失败 **不得** 调用 `ownedFetch`，不得回落本机。
- `http.fetch` 响应体上限 10MB（`10 * 1024 * 1024` 字节），超出为 `too-large`。
- `http.fetch` 不占 UI 会话租约；每设备在途上限 4。
- 允许主机：包的 `stream.network.hosts`，缺省 = `stream.credentials`；按主机名后缀匹配（`h === d || h.endsWith('.' + d)`），不是子串匹配。
- 设备 fetch 的 debug 记录只含 `deviceId / method / host / status / ms`，不含任何 header 或 body。
- 错误码字面量：`device-offline`、`device-incapable`、`host-not-allowed`、`device-lost`、`device-fetch-queue-timeout`，以及 agent 回报的 `private-target`、`too-large`、`network`、`timeout`。
- `device-offline` 与 `device-fetch-queue-timeout` 可按 `maxAttempts` 重试；其余设备错误与 `HostAbortedByUser` 不自动重试。
- 登录态文件：`<dataDir>/cookies/<deviceId 的安全文件名>.json`，0600；旧 `<dataDir>/cookies.json` 首启改名为 `<dataDir>/cookies/local.json`，失败保留原文件并告警。
- 配对设备 id 形如 `<platform>:<uuid>`，platform ∈ `android | linux`；device token 连上来时 `hello.deviceId` 必须以 `hello.platform + ':'` 开头。
- 注释与日志沿用本仓风格：中文、解释「为什么」，不写装饰性注释。
- 编辑文件用 Edit；不用 `sed -i`。测试命令：`pnpm exec vitest run <file>`。

## Review Focus

1. **ALS 漏传**——任务中心之外的入口（MCP/HTTP 触发的 action run、recipe 采集）没包 `runOnDevice`，静默落到 `local`。期望：绑定到设备 X 的 recipe 源采集时 `currentDeviceId()` 为 X。Task 10 的测试钉住采集入口。
2. **执行中途设备断连**——申购下到一半 NAS 掉线。期望：`device-lost`、不重试、通知里写「状态未知」。Task 2 测 disposition，Task 7 测断连映射为 `DeviceLost`。
3. **主机后缀伪装**——`evil-eastmoneysec.com` 或 `eastmoneysec.com.evil.io` 不得匹配 `eastmoneysec.com`。Task 1 的 `hostAllowed` 测试钉住。
4. **调用方的 AbortSignal**——eastmoney 每个请求带 `AbortSignal.timeout(15s)`；设备路径必须尊重它（超时即拒，不挂住）并把剩余时间作为 `timeoutMs` 下发。Task 7 测。
5. **升级不掉登录**——已有 `cookies.json` 的用户升级后，未绑定的东财任务读到同一份登录态。Task 5 测迁移。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/devices/run-context.ts`（新） | `RunPlacement`、`runOnDevice`、`currentPlacement`、`hostAllowed` |
| `src/devices/errors.ts`（新） | 设备错误类与 `failureDisposition` |
| `src/devices/facility-devices.ts`（新） | `facility_devices` 表（facility → deviceId） |
| `src/devices/placement.ts`（新） | `resolvePlacement` 与 `assertDeviceReady` |
| `src/devices/fetch.ts`（新） | `fetchFor` 唯一出站入口、`installFetchFor` 接线 |
| `src/devices/device-store.ts` | 配对带平台 |
| `src/http/host-registry.ts` | 平台 `linux`；`DeviceDirectory` 视图 |
| `src/http/host-relay.ts` | `fetchOp`（并行、不占租约）；错误帧带 `code`；device token 平台规则 |
| `src/http/device-routes.ts` | 配对带平台；facility 绑定 API |
| `src/tasks/task-store.ts` / `src/http/task-routes.ts` | `device` 列与校验 |
| `src/tasks/user-tasks.ts` | 动作执行包 `runOnDevice`；运行记录带设备 |
| `src/tasks/stream-task-job.ts` | 不可重试错误走 `fail` |
| `src/credentials/pushed-cookie-store.ts` / `cookie-provider.ts` / `src/kernel/plugins/credentials.ts` | 按设备的登录态 |
| `src/packages/descriptor.ts` / `src/replay/recipe-install.ts` | `stream.network.hosts` 与安装预览 |
| `src/kernel/plugins/packages.ts` / `src/packages/activate.ts` / `sdk/plugin-sdk/index.ts` | `ctx.fetch`；`networkFor` 索引 |
| `src/replay/http-fetch.ts` / `src/replay/html-fetch.ts` | 缺省发送器改为 `fetchFor` |
| `src/adapters/replay/adapter.ts` | recipe 采集按 facility 解析 placement |
| `src/kernel/plugins/auth.ts` | 远程设备上 `ctx.login` fail-closed |
| `packages/eastmoney/client.ts` / `activate.ts` | 注入的 fetch |
| `src/no-bare-fetch-in-packages.guard.test.ts`（新） | code 包禁止直接调全局 `fetch` |
| `src/serve.ts` | 接线 |

---

### Task 0: 环境

- [ ] **Step 1: 安装依赖**

Run: `pnpm install --frozen-lockfile`
Expected: 成功结束，`node_modules/.bin/vitest` 存在。

- [ ] **Step 2: 基线**

Run: `pnpm exec vitest run src/http/host-relay.test.ts src/devices/device-store.test.ts src/tasks src/credentials`
Expected: 全部 PASS。若基线就有失败，记下失败用例名，后续任务只对比新增失败。

- [ ] **Step 3: 确认 sidequest 的不重试失败 API**

Run: `grep -rn "fail(" node_modules/sidequest/dist/*.d.ts node_modules/@sidequest/core/dist/*.d.ts | head`
Expected: 看到 `Job` 上的 `fail(error: string | Error)`（返回一个 transition 对象）。Task 2 用它；若签名不同，按实际签名调用，语义不变（标记失败且不重试）。

---

### Task 1: 执行上下文

**Files:**
- Create: `src/devices/run-context.ts`
- Test: `src/devices/run-context.test.ts`

**Interfaces:**
- Produces:
  - `LOCAL_DEVICE = 'local'`
  - `interface RunPlacement { deviceId: string; allowHosts: readonly string[] }`
  - `runOnDevice<T>(p: RunPlacement, fn: () => Promise<T>): Promise<T>`
  - `currentPlacement(): RunPlacement`（无上下文 → `{ deviceId: 'local', allowHosts: [] }`）
  - `currentDeviceId(): string`
  - `hostAllowed(host: string, allow: readonly string[]): boolean`

- [ ] **Step 1: 写失败测试**

```ts
// src/devices/run-context.test.ts
import { describe, it, expect } from 'vitest'
import { LOCAL_DEVICE, currentDeviceId, currentPlacement, hostAllowed, runOnDevice } from './run-context.ts'

const nas = { deviceId: 'linux:nas', allowHosts: ['eastmoneysec.com'] }

describe('run context', () => {
  it('没有上下文就是 local，允许清单为空', () => {
    expect(currentDeviceId()).toBe(LOCAL_DEVICE)
    expect(currentPlacement().allowHosts).toEqual([])
  })

  it('跨 await 与定时器保持', async () => {
    await runOnDevice(nas, async () => {
      await new Promise((r) => setTimeout(r, 5))
      expect(currentDeviceId()).toBe('linux:nas')
    })
    expect(currentDeviceId()).toBe(LOCAL_DEVICE)
  })

  it('并发的两次执行互不串台', async () => {
    const seen: string[] = []
    const one = (id: string) => runOnDevice({ deviceId: id, allowHosts: [] }, async () => {
      await new Promise((r) => setTimeout(r, id === 'a' ? 10 : 1))
      seen.push(`${id}:${currentDeviceId()}`)
    })
    await Promise.all([one('a'), one('b')])
    expect(seen.sort()).toEqual(['a:a', 'b:b'])
  })

  it('内层覆盖外层', async () => {
    await runOnDevice(nas, () => runOnDevice({ deviceId: 'android:p', allowHosts: [] }, async () => {
      expect(currentDeviceId()).toBe('android:p')
    }))
  })
})

describe('hostAllowed', () => {
  const allow = ['eastmoneysec.com']
  it.each([
    ['jywg.eastmoneysec.com', true],
    ['eastmoneysec.com', true],
    ['EASTMONEYSEC.COM.', true],
    ['evil-eastmoneysec.com', false],
    ['eastmoneysec.com.evil.io', false],
    ['eastmoney.com', false],
  ])('%s → %s', (host, ok) => expect(hostAllowed(host, allow)).toBe(ok))

  it('空清单什么都不放行', () => expect(hostAllowed('example.com', [])).toBe(false))
  it('清单项带前导点也按后缀', () => expect(hostAllowed('a.b.cn', ['.b.cn'])).toBe(true))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run src/devices/run-context.test.ts`
Expected: FAIL，`Cannot find module './run-context.ts'`。

- [ ] **Step 3: 实现**

```ts
// src/devices/run-context.ts
/**
 * 「这一次执行在哪台设备上、允许访问哪些主机」——挂在 AsyncLocalStorage 上，跨 await 传播。
 *
 * 为什么不按参数透传：code 包的 `activate(ctx)` 拿到的 `ctx` 是长寿命对象，按次透传就要改
 * 所有包的签名；ALS 让 `ctx.fetch` / `ctx.cookieFor` 签名不变而行为按次变化。
 * 没有上下文 = `local`——现有调用路径一条不改就保持原样。
 * 权威设计：openspec/changes/device-execution/design.md D3。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export const LOCAL_DEVICE = 'local'

export interface RunPlacement {
  deviceId: string
  /** 本次执行所属包声明的主机名后缀（`stream.network.hosts`，缺省 = `stream.credentials`）。 */
  allowHosts: readonly string[]
}

const LOCAL: RunPlacement = Object.freeze({ deviceId: LOCAL_DEVICE, allowHosts: Object.freeze([]) as readonly string[] })
const store = new AsyncLocalStorage<RunPlacement>()

export function runOnDevice<T>(p: RunPlacement, fn: () => Promise<T>): Promise<T> {
  return store.run(p, fn)
}

export function currentPlacement(): RunPlacement {
  return store.getStore() ?? LOCAL
}

export function currentDeviceId(): string {
  return currentPlacement().deviceId
}

const norm = (s: string) => s.trim().toLowerCase().replace(/^\./, '').replace(/\.$/, '')

/** 主机名后缀匹配。**不是子串**：`evil-eastmoneysec.com` 不算 `eastmoneysec.com`。 */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = norm(host)
  return allow.some((d) => {
    const s = norm(d)
    return s !== '' && (h === s || h.endsWith(`.${s}`))
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run src/devices/run-context.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/devices/run-context.ts src/devices/run-context.test.ts
git commit -m "feat(devices): run placement context"
```

---

### Task 2: 设备错误与失败处置

**Files:**
- Create: `src/devices/errors.ts`
- Modify: `src/tasks/stream-task-job.ts`
- Test: `src/devices/errors.test.ts`

**Interfaces:**
- Produces:
  - `abstract class DeviceError extends Error { readonly code: string; readonly deviceId: string; readonly retryable: boolean }`
  - `DeviceOffline(deviceId)` — code `device-offline`，retryable
  - `DeviceIncapable(deviceId, need: string)` — `device-incapable`
  - `HostNotAllowed(deviceId, host: string)` — `host-not-allowed`
  - `DeviceLost(deviceId, cause?: unknown)` — `device-lost`
  - `DeviceFetchQueueTimeout(deviceId)` — `device-fetch-queue-timeout`，retryable
  - `DeviceRefused(deviceId, code: string, detail: string)` — code 取 agent 回报值
  - `failureDisposition(e: unknown): 'retry' | 'final'`

- [ ] **Step 1: 写失败测试**

```ts
// src/devices/errors.test.ts
import { describe, it, expect } from 'vitest'
import {
  DeviceFetchQueueTimeout, DeviceIncapable, DeviceLost, DeviceOffline, DeviceRefused, HostNotAllowed,
  failureDisposition,
} from './errors.ts'
import { HostAbortedByUser } from '../http/host-relay.ts'

describe('failureDisposition', () => {
  it.each([
    [new DeviceOffline('linux:nas'), 'retry'],
    [new DeviceFetchQueueTimeout('linux:nas'), 'retry'],
    [new DeviceLost('linux:nas'), 'final'],
    [new DeviceIncapable('linux:nas', 'browser'), 'final'],
    [new HostNotAllowed('linux:nas', 'example.com'), 'final'],
    [new DeviceRefused('linux:nas', 'private-target', '192.168.1.1'), 'final'],
    [new HostAbortedByUser('hotkey'), 'final'],
    [new Error('boom'), 'retry'],
  ] as const)('%s → %s', (e, d) => expect(failureDisposition(e)).toBe(d))

  it('错误信息点名设备，device-lost 说明状态未知', () => {
    expect(new DeviceOffline('linux:nas').message).toContain('linux:nas')
    expect(new DeviceLost('linux:nas').message).toContain('状态未知')
    expect(new DeviceLost('linux:nas').code).toBe('device-lost')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run src/devices/errors.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现错误类**

```ts
// src/devices/errors.ts
/**
 * 设备执行的失败分类。分两档的判据只有一句：**有没有可能已经有动作发出去了。**
 * 没发出（设备离线、排队超时）→ 可以按任务的 `maxAttempts` 重试；可能发出了（中途断连、
 * 设备回报网络错）或者是配置错误（能力不足、主机不允许）→ 不重试。一个下了一半单的动作
 * 被自动重跑就是重复下单。权威设计：openspec/changes/device-execution/design.md D9。
 */
export abstract class DeviceError extends Error {
  abstract readonly code: string
  abstract readonly retryable: boolean
  constructor(readonly deviceId: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

export class DeviceOffline extends DeviceError {
  readonly code = 'device-offline'
  readonly retryable = true
  constructor(deviceId: string) {
    super(deviceId, `设备 ${deviceId} 不在线——这次执行没有发出任何请求，也不会改在主实例上执行`)
  }
}

export class DeviceFetchQueueTimeout extends DeviceError {
  readonly code = 'device-fetch-queue-timeout'
  readonly retryable = true
  constructor(deviceId: string) {
    super(deviceId, `设备 ${deviceId} 的请求排队超时（在途已满）——请求没有发出`)
  }
}

export class DeviceIncapable extends DeviceError {
  readonly code = 'device-incapable'
  readonly retryable = false
  constructor(deviceId: string, readonly need: string) {
    super(deviceId, `设备 ${deviceId} 没有 ${need} 能力——检查绑定，或在这台设备上启用它`)
  }
}

export class HostNotAllowed extends DeviceError {
  readonly code = 'host-not-allowed'
  readonly retryable = false
  constructor(deviceId: string, readonly host: string) {
    super(deviceId, `不允许经设备 ${deviceId} 访问 ${host}——它不在本次执行所属包声明的主机里（stream.network.hosts）`)
  }
}

export class DeviceLost extends DeviceError {
  readonly code = 'device-lost'
  readonly retryable = false
  constructor(deviceId: string, cause?: unknown) {
    super(deviceId, `执行途中与设备 ${deviceId} 失联——动作可能已部分发出，状态未知，需要人工核对；不会自动重试`, { cause })
  }
}

/** agent 拒绝或执行失败时回报的错误（`private-target` / `too-large` / `network` / `timeout` / `host-not-allowed`）。 */
export class DeviceRefused extends DeviceError {
  readonly retryable = false
  constructor(deviceId: string, readonly code: string, detail: string) {
    super(deviceId, `设备 ${deviceId} 拒绝或未能完成请求（${code}）：${detail}`)
  }
}

/** 任务失败后要不要按 `maxAttempts` 再来。`HostAbortedByUser` 是用户的明确意图，同样不重试。 */
export function failureDisposition(e: unknown): 'retry' | 'final' {
  if (e instanceof DeviceError) return e.retryable ? 'retry' : 'final'
  if (e instanceof Error && e.name === 'HostAbortedByUser') return 'final'
  return 'retry'
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run src/devices/errors.test.ts`
Expected: PASS。

- [ ] **Step 5: StreamTaskJob 对 `final` 不重试**

在 `src/tasks/stream-task-job.ts`：import `failureDisposition`，在 catch 里发完事件之后：

```ts
import { failureDisposition } from '../devices/errors.ts'
// ...
    } catch (e) {
      const msg = (e as Error).message
      deps.log(`[tasks] ${task.id} failed: ${msg}`)
      try {
        deps.events?.append({
          type: 'task.failed', severity: 'error',
          title: `任务失败：${task.label}`, body: msg,
          dedupeKey: `task-failed:${task.id}`,
        })
      } catch { /* 通知失败不遮蔽原始错误 */ }
      // 可能已经有动作发出去了（设备中途失联、用户按了中止）——再跑一遍就是重复下单。
      // 记 failed 但不进重试，见 src/devices/errors.ts 头注。
      if (failureDisposition(e) === 'final') return this.fail(e as Error) as unknown as TaskOutcome
      throw e
    }
```

文件头注第二行改为：`// 失败路径：先发通知事件（带 dedupeKey 防刷屏），再 rethrow 让引擎记 failed + 按 maxAttempts 重试；可能已发出动作的失败（failureDisposition=final）记 failed 不重试。`

- [ ] **Step 6: 跑任务相关测试**

Run: `pnpm exec vitest run src/tasks src/devices/errors.test.ts`
Expected: PASS（与 Task 0 基线一致）。

- [ ] **Step 7: Commit**

```bash
git add src/devices/errors.ts src/devices/errors.test.ts src/tasks/stream-task-job.ts
git commit -m "feat(devices): device error classes; non-retryable failures skip retries"
```

---

### Task 3: 配对带平台，host relay 接受 linux

**Files:**
- Modify: `src/devices/device-store.ts`、`src/http/device-routes.ts`、`src/http/host-registry.ts`、`src/http/host-relay.ts`
- Test: `src/devices/device-store.test.ts`、`src/http/device-routes.test.ts`、`src/http/host-relay.test.ts`

**Interfaces:**
- Produces:
  - `type PairedPlatform = 'android' | 'linux'`（`device-store.ts` 导出）
  - `DeviceStore.pair(code: string, name: string, platform: PairedPlatform = 'android'): PairResult`
  - `HostPlatform = 'windows' | 'macos' | 'android' | 'linux'`
  - `POST /api/devices/pair` body 新增可选 `platform`

- [ ] **Step 1: 写失败测试（store）**

在 `src/devices/device-store.test.ts` 末尾追加：

```ts
describe('pairing a linux device', () => {
  it('returns a linux:<uuid> id and remembers the platform', () => {
    const s = new DeviceStore(join(mkdtempSync(join(tmpdir(), 'devstore-linux-')), 'devices.json'))
    const { code } = s.createPairingCode()
    const r = s.pair(code, 'NAS', 'linux')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.deviceId).toMatch(/^linux:[0-9a-f-]{36}$/)
    expect(s.list()[0]).toMatchObject({ deviceId: r.deviceId, name: 'NAS', platform: 'linux' })
  })
})
```

（若文件顶部尚未 import `mkdtempSync` / `tmpdir` / `join`，按现有测试的写法补上。）

- [ ] **Step 2: 写失败测试（路由）**

在 `src/http/device-routes.test.ts` 的 `describe('device routes')` 内追加：

```ts
  it('pair accepts platform linux and rejects unknown platforms', async () => {
    const { code } = await (await post('/api/devices/pairing-code')).json() as { code: string }
    const bad = await post('/api/devices/pair', { code, name: 'x', platform: 'windows' })
    expect(bad.status).toBe(400)
    const ok = await post('/api/devices/pair', { code, name: 'NAS', platform: 'linux' })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { deviceId: string }).deviceId).toMatch(/^linux:/)
  })
```

- [ ] **Step 3: 写失败测试（relay 握手）**

先读 `src/http/host-relay.test.ts` 里现有的「device token for … claimed platform …」那组用例，照它的夹具（假 server + `deviceAuth`）追加两条：

```ts
  it('a linux device token with a linux hello connects', async () => {
    // deviceAuth 把 token 'tok-linux' 映射到 'linux:abc'；hello { deviceId: 'linux:abc', platform: 'linux', ... }
    // 期望：registry.devices() 里出现 linux:abc
  })
  it('a device token whose hello id does not start with its platform is closed 4003', async () => {
    // deviceAuth 把 'tok-linux' 映射到 'linux:abc'；hello { deviceId: 'linux:abc', platform: 'android' }
    // 期望：close code 4003
  })
```

按现有用例的连接/断言方式把注释写成真实代码（同一文件里已有逐字可抄的形状：建连、发 hello、等 close 事件）。

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm exec vitest run src/devices/device-store.test.ts src/http/device-routes.test.ts src/http/host-relay.test.ts`
Expected: 新增 4 条 FAIL。

- [ ] **Step 5: 实现**

`src/devices/device-store.ts`：

```ts
export type PairedPlatform = 'android' | 'linux'
export const PAIRED_PLATFORMS: ReadonlySet<string> = new Set<PairedPlatform>(['android', 'linux'])

export interface PairedDevice {
  deviceId: string
  name: string
  platform: PairedPlatform
  pairedAt: number
  lastSeenAt?: number
}
```

`pair` 签名改为 `pair(code: string, name: string, platform: PairedPlatform = 'android'): PairResult`，其中：

```ts
    const deviceId = `${platform}:${randomUUID()}`
    const deviceToken = this.random(32).toString('hex')
    const clean = name.trim().slice(0, MAX_NAME) || (platform === 'linux' ? 'Linux' : 'Android')
    this.rows.push({
      deviceId, name: clean, platform, pairedAt: this.now(),
      tokenHash: sha256(deviceToken).toString('hex'),
    })
```

文件头注第一行 `Paired phones and their tokens.` 改为 `Paired devices (phones, headless Linux agents) and their tokens.`

`src/http/device-routes.ts` 的 pair 路由：

```ts
    const { code, name, platform } = (body ?? {}) as { code?: unknown; name?: unknown; platform?: unknown }
    if (typeof code !== 'string' || (name !== undefined && typeof name !== 'string')) {
      return c.json({ error: 'code 必须是字符串，name 可选且必须是字符串' }, 400)
    }
    if (platform !== undefined && (typeof platform !== 'string' || !PAIRED_PLATFORMS.has(platform))) {
      return c.json({ error: 'platform 只能是 android 或 linux' }, 400)
    }
    const r = deps.store.pair(code, name ?? '', (platform ?? 'android') as PairedPlatform)
```

（import `PAIRED_PLATFORMS`, `type PairedPlatform` from `../devices/device-store.ts`。）

`src/http/host-registry.ts`：

```ts
export type HostPlatform = 'windows' | 'macos' | 'android' | 'linux'
const PLATFORMS: ReadonlySet<string> = new Set(['windows', 'macos', 'android', 'linux'])
```

`surfaceOf` 不变（linux 归 `desktop` surface 不影响调度：它不声明任何 UI op，`deviceFor('desktop')` 选中它时 driver 会因 op 缺席而拒绝——但为免误选，`deviceFor` 加一行过滤）：

```ts
  deviceFor(surface: HostSurface): HostDevice | undefined {
    let best: HostDevice | undefined
    for (const d of this.devices()) {
      // 无界面设备不承接任何 surface 的 UI recipe；它只经执行位置绑定被点名使用。
      if (d.hello.platform === 'linux') continue
      if (surfaceOf(d.hello.platform) !== surface) continue
      if (!best || d.connectedAt > best.connectedAt) best = d
    }
    return best
  }
```

`src/http/host-relay.ts` 的 hello 处理，把两处 `'android'` 判断换成配对平台集合 + id 前缀：

```ts
      if (boundDevice !== undefined && (!PAIRED_PLATFORMS.has(hello.platform) || !hello.deviceId.startsWith(`${hello.platform}:`))) {
        log(`[host-relay] device token for ${boundDevice} claimed platform ${hello.platform} — closing`)
        closing = true
        socket.close(4003, 'device token platform mismatch')
        return
      }
```

以及

```ts
      } else if (PAIRED_PLATFORMS.has(hello.platform)) {
        log(`[host-relay] shared secret claimed the ${hello.platform} platform — closing`)
        closing = true
        socket.close(4003, `${hello.platform} devices must pair`)
        return
      }
```

（import `PAIRED_PLATFORMS` from `../devices/device-store.ts`。现有断言 `'device tokens are android-only'` / `'android devices must pair'` 的测试按新文案更新。）

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm exec vitest run src/devices src/http/device-routes.test.ts src/http/host-relay.test.ts src/http/host-registry*.test.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/devices/device-store.ts src/devices/device-store.test.ts src/http/device-routes.ts src/http/device-routes.test.ts src/http/host-registry.ts src/http/host-relay.ts src/http/host-relay.test.ts
git commit -m "feat(devices): pair headless linux devices; relay accepts the linux platform"
```

---

### Task 4: facility 绑定表、任务 `device` 列、placement 解析

**Files:**
- Create: `src/devices/facility-devices.ts`、`src/devices/placement.ts`
- Modify: `src/tasks/task-store.ts`、`src/http/task-routes.ts`、`src/http/device-routes.ts`、`src/http/host-registry.ts`
- Test: `src/devices/facility-devices.test.ts`、`src/devices/placement.test.ts`、`src/tasks/task-store.test.ts`、`src/http/task-routes.test.ts`、`src/http/device-routes.test.ts`

**Interfaces:**
- Consumes: `LOCAL_DEVICE`, `RunPlacement`（Task 1）；`DeviceOffline`, `DeviceIncapable`（Task 2）
- Produces:
  - `class FacilityDeviceStore { constructor(dbPath: string); list(): { facility: string; deviceId: string }[]; get(facility: string): string | undefined; set(facility: string, deviceId: string): void; clear(facility: string): boolean; close(): void }`
  - `interface DeviceDirectory { isOnline(id: string): boolean; hasOp(id: string, op: string): boolean; fetchRelay(id: string): DeviceFetchRelay | undefined }`（`DeviceFetchRelay` 见 Task 6；本任务先在 `host-registry.ts` 声明 `directory()` 返回的前两个方法，`fetchRelay` 在 Task 6 补）
  - `interface PackageNetwork { packageId: string; facility: string; hosts: readonly string[] }`
  - `resolvePlacement(input: { taskDevice?: string; facility?: string; binding: (facility: string) => string | undefined; hosts: readonly string[] }): RunPlacement`
  - `assertDeviceReady(p: RunPlacement, dir: Pick<DeviceDirectory, 'isOnline' | 'hasOp'>, need: string): void`
  - `UserTaskRow.device?: string`

- [ ] **Step 1: 写失败测试（绑定表）**

```ts
// src/devices/facility-devices.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FacilityDeviceStore } from './facility-devices.ts'

const fresh = () => join(mkdtempSync(join(tmpdir(), 'facdev-')), 'stream.db')

describe('FacilityDeviceStore', () => {
  it('set / get / list / clear', () => {
    const s = new FacilityDeviceStore(fresh())
    expect(s.get('eastmoney')).toBeUndefined()
    s.set('eastmoney', 'linux:nas')
    expect(s.get('eastmoney')).toBe('linux:nas')
    s.set('eastmoney', 'android:p')
    expect(s.list()).toEqual([{ facility: 'eastmoney', deviceId: 'android:p' }])
    expect(s.clear('eastmoney')).toBe(true)
    expect(s.clear('eastmoney')).toBe(false)
  })

  it('绑定到 local 等于清除', () => {
    const s = new FacilityDeviceStore(fresh())
    s.set('eastmoney', 'linux:nas')
    s.set('eastmoney', 'local')
    expect(s.get('eastmoney')).toBeUndefined()
  })

  it('重开库还在', () => {
    const p = fresh()
    const a = new FacilityDeviceStore(p)
    a.set('eastmoney', 'linux:nas')
    a.close()
    expect(new FacilityDeviceStore(p).get('eastmoney')).toBe('linux:nas')
  })
})
```

- [ ] **Step 2: 写失败测试（placement）**

```ts
// src/devices/placement.test.ts
import { describe, it, expect } from 'vitest'
import { assertDeviceReady, resolvePlacement } from './placement.ts'
import { DeviceIncapable, DeviceOffline } from './errors.ts'

const bindings: Record<string, string> = { eastmoney: 'linux:nas' }
const binding = (f: string) => bindings[f]
const hosts = ['eastmoneysec.com']

describe('resolvePlacement', () => {
  it('任务覆盖优先', () => {
    expect(resolvePlacement({ taskDevice: 'windows:pc', facility: 'eastmoney', binding, hosts }).deviceId).toBe('windows:pc')
  })
  it('没有覆盖就跟随 facility', () => {
    expect(resolvePlacement({ facility: 'eastmoney', binding, hosts })).toEqual({ deviceId: 'linux:nas', allowHosts: hosts })
  })
  it('都没有就是 local', () => {
    expect(resolvePlacement({ facility: 'xueqiu', binding, hosts: [] }).deviceId).toBe('local')
    expect(resolvePlacement({ binding, hosts: [] }).deviceId).toBe('local')
  })
})

describe('assertDeviceReady', () => {
  const dir = {
    isOnline: (id: string) => id === 'linux:nas',
    hasOp: (id: string, op: string) => id === 'linux:nas' && op === 'http.fetch',
  }
  it('local 永远就绪', () => expect(() => assertDeviceReady({ deviceId: 'local', allowHosts: [] }, dir, 'browser')).not.toThrow())
  it('离线', () => expect(() => assertDeviceReady({ deviceId: 'android:p', allowHosts: [] }, dir, 'http.fetch')).toThrow(DeviceOffline))
  it('能力不足', () => expect(() => assertDeviceReady({ deviceId: 'linux:nas', allowHosts: [] }, dir, 'browser')).toThrow(DeviceIncapable))
  it('就绪', () => expect(() => assertDeviceReady({ deviceId: 'linux:nas', allowHosts: [] }, dir, 'http.fetch')).not.toThrow())
})
```

- [ ] **Step 3: 写失败测试（任务行与路由）**

在 `src/tasks/task-store.test.ts` 追加：

```ts
  it('device 列可存可清', () => {
    const s = new TaskStore(join(mkdtempSync(join(tmpdir(), 'ts-dev-')), 'stream.db'))
    const base = { id: 'em', label: 'x', schedule: '0 45 9 * * *', action: 'eastmoney:subscribe', args: [], serial: true, maxAttempts: 1, enabled: true }
    expect(s.upsert({ ...base, device: 'linux:nas' }).device).toBe('linux:nas')
    expect(s.upsert(base).device).toBeUndefined()
  })
```

在 `src/http/task-routes.test.ts` 追加（照该文件已有的 PUT/POST 夹具写法）：

```ts
  it('command 类任务不能设 device', async () => {
    // body: { id:'c', label:'c', schedule:'0 0 3 * * *', command:'echo', args:[], maxAttempts:1, device:'linux:nas' }
    // 期望 400，错误文案含「本地命令只能在主实例上执行」
  })
  it('action 任务的 device 原样落库，空串归一为不设', async () => {
    // body 带 action:'<已知动作名>', device:'linux:nas' → 200，GET 回来 device === 'linux:nas'
    // 再 PUT device:'' → GET 回来没有 device
  })
```

按该文件现有用例把注释写成真实请求与断言。

在 `src/http/device-routes.test.ts` 追加（`beforeEach` 里给 `mountDeviceRoutes` 加 `bindings: new FacilityDeviceStore(join(dir, 'stream.db'))`）：

```ts
  it('facility 绑定：PUT / GET / DELETE；未知设备 400；local 等于清除', async () => {
    const put = (f: string, deviceId: string) =>
      app.request(`/api/devices/bindings/${f}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId }) })
    expect((await put('eastmoney', 'linux:nope')).status).toBe(400)
    const { code } = await (await post('/api/devices/pairing-code')).json() as { code: string }
    const { deviceId } = await (await post('/api/devices/pair', { code, name: 'NAS', platform: 'linux' })).json() as { deviceId: string }
    expect((await put('eastmoney', deviceId)).status).toBe(200)
    expect(await (await app.request('/api/devices/bindings')).json()).toEqual({ bindings: [{ facility: 'eastmoney', deviceId }] })
    expect((await put('eastmoney', 'local')).status).toBe(200)
    expect(await (await app.request('/api/devices/bindings')).json()).toEqual({ bindings: [] })
    await put('eastmoney', deviceId)
    expect((await app.request('/api/devices/bindings/eastmoney', { method: 'DELETE' })).status).toBe(204)
  })
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm exec vitest run src/devices src/tasks/task-store.test.ts src/http/task-routes.test.ts src/http/device-routes.test.ts`
Expected: 新增用例 FAIL。

- [ ] **Step 5: 实现绑定表**

```ts
// src/devices/facility-devices.ts
/**
 * facility（账号）的默认执行设备。住 data/stream.db 用户侧，与 scheduled_tasks 同库。
 *
 * 为什么挂在 facility 而不是配置 row：facility 把登录 recipe（`session.facility`）、凭据域
 * （`stream.credentials`）和动作串在一起；配置 row 的 schema 归包所有，宿主不往里加字段。
 * 缺席 = `local`。见 openspec/changes/device-execution/design.md D2。
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { LOCAL_DEVICE } from './run-context.ts'

export class FacilityDeviceStore {
  private db: Database.Database
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facility_devices (
        facility TEXT PRIMARY KEY,
        device_id TEXT NOT NULL
      );
    `)
  }

  list(): { facility: string; deviceId: string }[] {
    return (this.db.prepare('SELECT facility, device_id FROM facility_devices ORDER BY facility').all() as { facility: string; device_id: string }[])
      .map((r) => ({ facility: r.facility, deviceId: r.device_id }))
  }

  get(facility: string): string | undefined {
    const r = this.db.prepare('SELECT device_id FROM facility_devices WHERE facility = ?').get(facility) as { device_id: string } | undefined
    return r?.device_id
  }

  /** 绑到 `local` 就是清除：本机本来就是缺省，存一行 `local` 只会多一个和「没绑」长得不一样的同义状态。 */
  set(facility: string, deviceId: string): void {
    if (deviceId === LOCAL_DEVICE) { this.clear(facility); return }
    this.db.prepare(`
      INSERT INTO facility_devices (facility, device_id) VALUES (?, ?)
      ON CONFLICT(facility) DO UPDATE SET device_id = excluded.device_id
    `).run(facility, deviceId)
  }

  clear(facility: string): boolean {
    return this.db.prepare('DELETE FROM facility_devices WHERE facility = ?').run(facility).changes > 0
  }

  close(): void { this.db.close() }
}
```

- [ ] **Step 6: 实现 placement**

```ts
// src/devices/placement.ts
/** 一次执行在哪台设备上：任务覆盖 → facility 默认设备 → local。执行开始时解析一次，之后不变。 */
import { DeviceIncapable, DeviceOffline } from './errors.ts'
import { LOCAL_DEVICE, type RunPlacement } from './run-context.ts'

/** 包的执行位置相关声明：它的 facility 与允许访问的主机（`stream.network.hosts` ?? `stream.credentials`）。 */
export interface PackageNetwork {
  packageId: string
  facility: string
  hosts: readonly string[]
}

export function resolvePlacement(input: {
  taskDevice?: string
  facility?: string
  binding: (facility: string) => string | undefined
  hosts: readonly string[]
}): RunPlacement {
  const deviceId = input.taskDevice
    ?? (input.facility !== undefined ? input.binding(input.facility) : undefined)
    ?? LOCAL_DEVICE
  return { deviceId, allowHosts: input.hosts }
}

/** 派发前就把「去不了」说出来，不发任何帧。`local` 是后端本机，永远就绪。 */
export function assertDeviceReady(
  p: RunPlacement,
  dir: { isOnline(id: string): boolean; hasOp(id: string, op: string): boolean },
  need: string,
): void {
  if (p.deviceId === LOCAL_DEVICE) return
  if (!dir.isOnline(p.deviceId)) throw new DeviceOffline(p.deviceId)
  if (!dir.hasOp(p.deviceId, need)) throw new DeviceIncapable(p.deviceId, need)
}
```

- [ ] **Step 7: 任务行 `device` 列**

`src/tasks/task-store.ts`：
- `UserTaskRow` 在 `configRef` 之后加：

```ts
  /**
   * 这条任务在哪台设备上执行（覆盖 facility 默认设备）。缺席 = 跟随 facility，再缺席 = 主实例本机。
   * 只对 `action` 任务有意义——`command` 是在主实例上起本地进程，路由层拒绝给它设设备。
   * 见 openspec/changes/device-execution/design.md D2。
   */
  device?: string
```

- `RawRow` 加 `device: string | null`；`hydrate` 加 `...(r.device === null || r.device === '' ? {} : { device: r.device }),`
- 构造函数里 `this.addExclusivityColumns()` 之后加 `this.addDeviceColumn()`，方法：

```ts
  /** `device` 是后加的一列（执行位置覆盖）。加可空列，同 `config_ref`。 */
  private addDeviceColumn(): void {
    const cols = this.db.prepare('PRAGMA table_info(scheduled_tasks)').all() as { name: string }[]
    if (cols.some((c) => c.name === 'device')) return
    this.db.exec('ALTER TABLE scheduled_tasks ADD COLUMN device TEXT')
  }
```

- 建表语句在 `group_name TEXT,` 之后加 `device TEXT,`
- `upsert` 的列清单、VALUES、`ON CONFLICT ... SET` 各加 `device`（`device=excluded.device`），参数加 `device: input.device ?? null`。

`src/http/task-routes.ts` 的 `validate`，在 whenBusy 校验之后：

```ts
  const hasDevice = typeof (b as { device?: unknown }).device === 'string' && (b as { device: string }).device.trim() !== ''
  // 本地命令是在主实例上起进程——派不到设备上。存下来的后果是一条看着绑了 NAS、实际在本机跑的任务。
  if (hasDevice && hasCommand) return { ok: false, why: 'command 类任务不能设 device：本地命令只能在主实例上执行' }
```

并在返回的 `value` 里 `group` 之后加 `...(hasDevice ? { device: (b as { device: string }).device.trim() } : {}),`

- [ ] **Step 8: 设备目录视图与绑定路由**

`src/http/host-registry.ts` 的 `HostRelayRegistry` 加：

```ts
  /** 调度用的窄视图：在不在线、声明了哪些 op。 */
  isOnline(id: string): boolean {
    return this.live.has(id)
  }

  hasOp(id: string, op: string): boolean {
    return this.live.get(id)?.ops.has(op) ?? false
  }
```

`src/http/device-routes.ts`：`DeviceRoutesDeps` 加 `bindings?: FacilityDeviceStore`，`mountDeviceRoutes` 末尾加：

```ts
  const bindings = deps.bindings
  if (!bindings) return
  const known = (id: string) =>
    id === LOCAL_DEVICE || deps.store.list().some((d) => d.deviceId === id) || deps.registry.devices().some((d) => d.hello.deviceId === id)

  app.get('/api/devices/bindings', (c) => c.json({ bindings: bindings.list() }))

  app.put('/api/devices/bindings/:facility', async (c) => {
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'body 不是合法 JSON' }, 400) }
    const deviceId = (body as { deviceId?: unknown } | null)?.deviceId
    if (typeof deviceId !== 'string' || deviceId.trim() === '') return c.json({ error: 'deviceId 必填' }, 400)
    // 绑到一台不认识的设备，表现是这个账号的每一次执行都 device-offline——当场拒比几小时后红一片好。
    if (!known(deviceId.trim())) return c.json({ error: `没有这台设备：${deviceId}` }, 400)
    bindings.set(c.req.param('facility'), deviceId.trim())
    return c.json({ facility: c.req.param('facility'), deviceId: bindings.get(c.req.param('facility')) ?? LOCAL_DEVICE })
  })

  app.delete('/api/devices/bindings/:facility', (c) => {
    bindings.clear(c.req.param('facility'))
    return c.body(null, 204)
  })
```

（import `FacilityDeviceStore` 类型与 `LOCAL_DEVICE`。）

- [ ] **Step 9: 跑测试确认通过**

Run: `pnpm exec vitest run src/devices src/tasks src/http/task-routes.test.ts src/http/device-routes.test.ts`
Expected: PASS。

- [ ] **Step 10: Commit**

```bash
git add src/devices src/tasks/task-store.ts src/tasks/task-store.test.ts src/http/task-routes.ts src/http/task-routes.test.ts src/http/device-routes.ts src/http/device-routes.test.ts src/http/host-registry.ts
git commit -m "feat(devices): facility default device, task device override, placement resolution"
```

---

### Task 5: 登录态按设备存储

**Files:**
- Modify: `src/credentials/pushed-cookie-store.ts`、`src/credentials/cookie-provider.ts`、`src/kernel/plugins/credentials.ts`
- Test: `src/credentials/pushed-cookie-store.test.ts`（若不存在则新建）、`src/credentials/cookie-provider.test.ts`

**Interfaces:**
- Consumes: `currentDeviceId`, `runOnDevice`, `LOCAL_DEVICE`（Task 1）
- Produces:
  - `CookieSource.fetch(deviceId?: string): Promise<Record<string, BrowserCookie[]>>`（缺省 = `local`）
  - `class DeviceCookieStores implements CookieSource { constructor(dataDir: string, log?: (l: string) => void); forDevice(deviceId: string): PushedCookieStore; fetch(deviceId?: string) }`
  - `PushedCookieStore` 构造函数改为 `(dataDir: string, deviceId: string = 'local', log?: (l: string) => void)`
  - `CookieProvider.refresh(deviceId?: string)`：缺省刷新当前 placement 的设备
  - `cookieFileName(deviceId: string): string`

- [ ] **Step 1: 写失败测试（存储与迁移）**

```ts
// src/credentials/pushed-cookie-store.test.ts（追加或新建）
import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceCookieStores, PushedCookieStore, cookieFileName } from './pushed-cookie-store.ts'

const c = (name: string) => ({ name, value: 'v', domain: 'eastmoneysec.com' }) as never

describe('per-device cookie snapshots', () => {
  it('两台设备各写各的文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cookies-'))
    const stores = new DeviceCookieStores(dir)
    stores.forDevice('linux:nas').replace({ 'eastmoneysec.com': [c('nas')] })
    expect(await stores.fetch('linux:nas')).toEqual({ 'eastmoneysec.com': [c('nas')] })
    expect(await stores.fetch('local')).toEqual({})
    expect(existsSync(join(dir, 'cookies', cookieFileName('linux:nas')))).toBe(true)
  })

  it('设备 id 里的冒号与斜杠不会逃出 cookies 目录', () => {
    expect(cookieFileName('linux:3f2a')).toBe('linux_3f2a.json')
    expect(cookieFileName('../../etc')).not.toContain('/')
  })

  it('旧 cookies.json 迁为 local，内容不变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cookies-mig-'))
    writeFileSync(join(dir, 'cookies.json'), JSON.stringify({ updatedAt: 1, cookies: { 'eastmoneysec.com': [c('old')] } }))
    const s = new PushedCookieStore(dir, 'local')
    expect(await s.fetch()).toEqual({ 'eastmoneysec.com': [c('old')] })
    expect(existsSync(join(dir, 'cookies.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'cookies', 'local.json'), 'utf8')).cookies['eastmoneysec.com'][0].name).toBe('old')
  })

  it('新旧都在时不覆盖新的', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cookies-both-'))
    new PushedCookieStore(dir, 'local').replace({ b: [c('new')] })
    // 迁移跑过之后旧文件又出现了（有人从备份放回来）：不能用它盖掉新的。
    writeFileSync(join(dir, 'cookies.json'), JSON.stringify({ updatedAt: 1, cookies: { a: [c('old')] } }))
    expect(await new PushedCookieStore(dir, 'local').fetch()).toEqual({ b: [c('new')] })
    expect(existsSync(join(dir, 'cookies.json'))).toBe(true)
  })
})
```

- [ ] **Step 2: 写失败测试（provider 按 placement 读）**

在 `src/credentials/cookie-provider.test.ts` 追加：

```ts
import { runOnDevice } from '../devices/run-context.ts'

describe('CookieProvider per device', () => {
  const perDevice: Record<string, Record<string, BrowserCookie[]>> = {
    local: { 'eastmoneysec.com': [{ name: 'who', value: 'local' } as BrowserCookie] },
    'linux:nas': { 'eastmoneysec.com': [{ name: 'who', value: 'nas' } as BrowserCookie] },
  }
  const src = { fetch: async (id = 'local') => perDevice[id] ?? {} }

  it('按当前设备取', async () => {
    const p = new CookieProvider(src)
    expect(await p.cookieString('eastmoneysec.com')).toBe('who=local')
    expect(await runOnDevice({ deviceId: 'linux:nas', allowHosts: [] }, () => p.cookieString('eastmoneysec.com'))).toBe('who=nas')
    expect(await runOnDevice({ deviceId: 'android:p', allowHosts: [] }, () => p.cookieString('eastmoneysec.com'))).toBeNull()
  })

  it('refresh 只刷新指定设备的缓存', async () => {
    const p = new CookieProvider(src)
    await runOnDevice({ deviceId: 'linux:nas', allowHosts: [] }, () => p.cookieString('eastmoneysec.com'))
    perDevice['linux:nas'] = { 'eastmoneysec.com': [{ name: 'who', value: 'nas2' } as BrowserCookie] }
    perDevice.local = { 'eastmoneysec.com': [{ name: 'who', value: 'local2' } as BrowserCookie] }
    await p.refresh('linux:nas')
    expect(await runOnDevice({ deviceId: 'linux:nas', allowHosts: [] }, () => p.cookieString('eastmoneysec.com'))).toBe('who=nas2')
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm exec vitest run src/credentials`
Expected: 新增用例 FAIL。

- [ ] **Step 4: 实现存储**

`src/credentials/pushed-cookie-store.ts`：

```ts
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { BrowserCookie } from '../types.ts'
import type { CookieSource } from './cookie-provider.ts'
import { LOCAL_DEVICE } from '../devices/run-context.ts'

/** 设备 id → 文件名。冒号换下划线，其余非 [A-Za-z0-9._-] 一律换掉——id 来自配对与 hello，不能让它拼出路径。 */
export function cookieFileName(deviceId: string): string {
  return `${deviceId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')}.json`
}
```

类头注在原有内容后补一段：

```
 * **按设备一份**（`data/cookies/<设备>.json`）：在 NAS 上登录得到的会话只给 NAS 上的执行用，
 * 否则「PC 登录、NAS 下单」的分叉又回来了。见 openspec/changes/device-execution/design.md D4。
```

构造函数：

```ts
  constructor(dataDir: string, deviceId: string = LOCAL_DEVICE, log: (line: string) => void = console.log) {
    this.file = join(dataDir, 'cookies', cookieFileName(deviceId))
    if (deviceId === LOCAL_DEVICE) migrateLegacy(join(dataDir, 'cookies.json'), this.file, log)
  }
```

模块级函数：

```ts
/**
 * 升级前只有一份 `data/cookies.json`。首启把它改名为 `local` 设备的快照——**只改名不改内容**。
 * 新文件已在就不动旧文件（那是迁移跑过之后有人又放回来的，不能覆盖新的）。
 * 改名失败保留原文件并告警：静默丢掉它的表现是用户「突然全站掉登录」。
 */
function migrateLegacy(legacy: string, target: string, log: (line: string) => void): void {
  if (!existsSync(legacy) || existsSync(target)) return
  try {
    mkdirSync(dirname(target), { recursive: true })
    renameSync(legacy, target)
    chmodSync(target, 0o600)
    log(`[cookies] 迁移：${legacy} → ${target}`)
  } catch (e) {
    log(`[cookies] WARN 迁移 ${legacy} 失败，保留原文件：${(e as Error).message}`)
  }
}
```

迁移失败时 `read()` 读不到新文件就会返回空快照；为了「升级不掉登录」，`read()` 在新文件不存在且自己是 `local` 时回退读旧文件：在类里存 `private readonly legacy?: string`（仅 local 设置为 `join(dataDir,'cookies.json')`），`read()` 中 `if (!existsSync(this.file))` 分支改为：若 `this.legacy && existsSync(this.legacy)` 则按同样方式解析 `this.legacy`，否则返回空。

`DeviceCookieStores`：

```ts
/** 每台设备一份快照的集合。`fetch(deviceId)` 实现 `CookieSource`，缺省是 local。 */
export class DeviceCookieStores implements CookieSource {
  private readonly stores = new Map<string, PushedCookieStore>()
  constructor(private readonly dataDir: string, private readonly log: (line: string) => void = console.log) {}

  forDevice(deviceId: string): PushedCookieStore {
    let s = this.stores.get(deviceId)
    if (!s) {
      s = new PushedCookieStore(this.dataDir, deviceId, this.log)
      this.stores.set(deviceId, s)
    }
    return s
  }

  async fetch(deviceId: string = LOCAL_DEVICE): Promise<Record<string, BrowserCookie[]>> {
    return this.forDevice(deviceId).fetch()
  }
}
```

- [ ] **Step 5: 实现 provider 按设备缓存**

`src/credentials/cookie-provider.ts`：

- `CookieSource` 改为 `fetch(deviceId?: string): Promise<Record<string, BrowserCookie[]>>`
- 类字段 `cookies` / `fetchedAt` 换成 `private readonly cache = new Map<string, { cookies: Record<string, BrowserCookie[]>; fetchedAt: number }>()`
- `reconfigure`：`this.source = source; this.cache.clear(); if (source) await this.refresh()`
- 方法：

```ts
  async refresh(deviceId: string = currentDeviceId()): Promise<void> {
    if (!this.source) { this.cache.delete(deviceId); return }
    this.cache.set(deviceId, { cookies: await this.source.fetch(deviceId), fetchedAt: Date.now() })
  }

  /** 当前执行所在设备的快照（见 `ensureFresh` 的冷热两档语义，逐设备各一份）。 */
  private async snapshot(): Promise<Record<string, BrowserCookie[]> | null> {
    const id = currentDeviceId()
    const hit = this.cache.get(id)
    if (hit && Date.now() - hit.fetchedAt <= this.ttlMs) return hit.cookies
    try {
      await this.refresh(id)
    } catch (err) {
      if (!hit) throw err
      hit.fetchedAt = Date.now()
    }
    return this.cache.get(id)?.cookies ?? null
  }
```

- 删除旧的 `ensureFresh`（其头注搬到 `snapshot` 上方保留）；`availableDomains`、`resolve`、`cookiesFor` 里 `await this.ensureFresh(); if (!this.cookies) …` 改为 `const cookies = await this.snapshot(); if (!cookies) …`，后续 `this.cookies` 改为 `cookies`。
- import `currentDeviceId` from `../devices/run-context.ts`。

- [ ] **Step 6: 接线**

`src/kernel/plugins/credentials.ts`：

```ts
    const cookieStores = new DeviceCookieStores(config.dataDir, config.log)
    const pushedCookies = cookieStores.forDevice(LOCAL_DEVICE)
    const cookieSource: CookieSource = cookieStores
```

并在 `ctx.provide('credentials', {...})` 里加 `cookieStores`。`pushedCookies` 仍提供（本机扩展的 cookie 拉取继续写它）。在该域的服务类型声明里给 `cookieStores: DeviceCookieStores` 加一格（找 `pushedCookies:` 的类型声明处，同处添加）。

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm exec vitest run src/credentials src/kernel`
Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add src/credentials src/kernel/plugins/credentials.ts
git commit -m "feat(credentials): cookie snapshots per device; migrate cookies.json to local"
```

---

### Task 6: host relay 的 `http.fetch` 通道

**Files:**
- Modify: `src/http/host-relay.ts`、`src/http/host-registry.ts`
- Test: `src/http/host-relay.fetch.test.ts`（新）

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface HttpFetchArgs { method: string; url: string; headers: [string, string][]; body?: string /* base64 */; redirect: 'manual' | 'follow'; timeoutMs: number; allowHosts: string[] }`
  - `interface HttpFetchResult { status: number; headers: [string, string][]; body: string /* base64 */; url: string }`
  - `class HostOpError extends Error { readonly code?: string }`（agent 回报的错误；`code` 来自回复帧的 `code` 字段）
  - `WsHostRelay.fetchOp(args: HttpFetchArgs): Promise<HttpFetchResult>`（不占会话租约、不进单发尾锁；在途上限 4，排队超过 `fetchQueueWaitMs`（缺省 30_000）抛 `HostFetchQueueTimeout`）
  - `class HostFetchQueueTimeout extends Error`
  - `type DeviceFetchRelay = Pick<WsHostRelay, 'fetchOp' | 'connected'>`
  - `HostRelayRegistry.fetchRelay(id: string): DeviceFetchRelay | undefined`（仅在线且声明了 `http.fetch` 时返回）

- [ ] **Step 1: 写失败测试**

```ts
// src/http/host-relay.fetch.test.ts
import { describe, it, expect } from 'vitest'
import { HostFetchQueueTimeout, HostOpError, HostRelayDisconnected, WsHostRelay } from './host-relay.ts'

function fakeSocket() {
  const sent: { id: number; op: string; args?: unknown }[] = []
  return { sent, socket: { send: (d: string) => { sent.push(JSON.parse(d)) } } }
}
const args = (url: string) => ({ method: 'GET', url, headers: [] as [string, string][], redirect: 'manual' as const, timeoutMs: 1_000, allowHosts: ['example.com'] })
const reply = (r: WsHostRelay, id: number, result: unknown) => r.handleMessage(JSON.stringify({ id, result }))

describe('WsHostRelay.fetchOp', () => {
  it('不等 UI 会话租约', async () => {
    const r = new WsHostRelay()
    const { socket, sent } = fakeSocket()
    r.connect(socket)
    let release!: () => void
    const held = r.withSession(() => new Promise<void>((res) => { release = res }))
    const p = r.fetchOp(args('https://example.com/a'))
    expect(sent.map((f) => f.op)).toEqual(['http.fetch'])
    reply(r, sent[0].id, { status: 200, headers: [], body: '', url: 'https://example.com/a' })
    await expect(p).resolves.toMatchObject({ status: 200 })
    release(); await held
  })

  it('最多 4 个在途，第 5 个等前面落定', async () => {
    const r = new WsHostRelay()
    const { socket, sent } = fakeSocket()
    r.connect(socket)
    const ps = [1, 2, 3, 4, 5].map((i) => r.fetchOp(args(`https://example.com/${i}`)))
    expect(sent).toHaveLength(4)
    reply(r, sent[0].id, { status: 200, headers: [], body: '', url: '' })
    await ps[0]
    expect(sent).toHaveLength(5)
    for (const f of sent.slice(1)) reply(r, f.id, { status: 200, headers: [], body: '', url: '' })
    await Promise.all(ps)
  })

  it('排队过久抛 HostFetchQueueTimeout，且没有发出', async () => {
    const r = new WsHostRelay({ fetchQueueWaitMs: 10 })
    const { socket, sent } = fakeSocket()
    r.connect(socket)
    for (let i = 0; i < 4; i++) void r.fetchOp(args(`https://example.com/${i}`)).catch(() => {})
    await expect(r.fetchOp(args('https://example.com/late'))).rejects.toBeInstanceOf(HostFetchQueueTimeout)
    expect(sent).toHaveLength(4)
  })

  it('帧带 abortEpoch，与 UI op 同一形状', async () => {
    const r = new WsHostRelay()
    const { socket, sent } = fakeSocket()
    r.connect(socket)
    void r.fetchOp(args('https://example.com/a')).catch(() => {})
    expect(sent[0]).toMatchObject({ op: 'http.fetch', abortEpoch: 0 })
  })

  it('错误帧带 code', async () => {
    const r = new WsHostRelay()
    const { socket, sent } = fakeSocket()
    r.connect(socket)
    const p = r.fetchOp(args('https://example.com/x'))
    r.handleMessage(JSON.stringify({ id: sent[0].id, error: 'resolved to 192.168.1.1', code: 'private-target' }))
    const e = await p.catch((x) => x)
    expect(e).toBeInstanceOf(HostOpError)
    expect(e.code).toBe('private-target')
  })

  it('断连时在途的 fetch 以 HostRelayDisconnected 拒绝', async () => {
    const r = new WsHostRelay()
    const { socket } = fakeSocket()
    r.connect(socket)
    const p = r.fetchOp(args('https://example.com/x'))
    r.disconnect(socket)
    await expect(p).rejects.toBeInstanceOf(HostRelayDisconnected)
  })

  it('fetch 在途时 UI op 照常走单发尾锁', async () => {
    const r = new WsHostRelay()
    const { socket, sent } = fakeSocket()
    r.connect(socket)
    void r.fetchOp(args('https://example.com/x')).catch(() => {})
    const ui = r.send({ op: 'click', args: {} })
    expect(sent.map((f) => f.op)).toEqual(['http.fetch', 'click'])
    reply(r, sent[1].id, { ok: true })
    await expect(ui).resolves.toEqual({ ok: true })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run src/http/host-relay.fetch.test.ts`
Expected: FAIL（`fetchOp` 不存在）。

- [ ] **Step 3: 实现**

`src/http/host-relay.ts`：

1. 新错误类（放在 `HostAbortedByUser` 之后）：

```ts
/** agent 回了一个错误帧。`code` 是 agent 给的机器可读分类（`private-target` 等），旧 agent 不带。 */
export class HostOpError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = 'HostOpError'
  }
}

/** 设备 HTTP 通道排队等在途名额等太久——请求**没有**发出。与 UI 会话租约的排队超时分开报。 */
export class HostFetchQueueTimeout extends Error {
  constructor() {
    super('device http.fetch queue wait timed out（在途名额已满，请求没有发出）')
    this.name = 'HostFetchQueueTimeout'
  }
}

export interface HttpFetchArgs {
  method: string
  url: string
  headers: [string, string][]
  /** base64 */
  body?: string
  redirect: 'manual' | 'follow'
  timeoutMs: number
  allowHosts: string[]
}

export interface HttpFetchResult {
  status: number
  headers: [string, string][]
  /** base64 */
  body: string
  url: string
}

/** 每台设备的 HTTP 在途上限。一次采集不该把 NAS 打满，也不该被 UI 租约挡住。 */
export const DEVICE_FETCH_CONCURRENCY = 4
```

2. `handleMessage` 里 `if (msg.error !== undefined) p.reject(new Error(msg.error))` 改为 `if (msg.error !== undefined) p.reject(new HostOpError(msg.error, typeof msg.code === 'string' ? msg.code : undefined))`；`msg` 的类型声明加 `code?: unknown`。（`HostOpError extends Error`，现有按 `Error` 判的调用方不受影响。）

3. 构造参数加 `fetchQueueWaitMs?: number`，字段 `private readonly fetchQueueWaitMs: number`（缺省 30_000），以及：

```ts
  /** HTTP 通道：在途数与排队者。与 `inFlight`/`queue`（UI 单发尾锁）、`sessionHolder`（UI 会话租约）完全分开。 */
  private fetchInFlight = 0
  private readonly fetchWaiters: Array<{ grant: () => void }> = []
```

4. 方法：

```ts
  /**
   * 经设备代发一个 HTTP 请求（`http.fetch` op）。**不占 UI 会话租约、不进单发尾锁**：
   * 一条在跑的 UI recipe 不该挡住同一台设备上的 HTTP，HTTP 也不该被 recipe 的十几个 op 夹住。
   * 并发由 `DEVICE_FETCH_CONCURRENCY` 限住。op 超时 = 请求自己的超时再宽 5 秒（agent 侧先到点）。
   */
  async fetchOp(args: HttpFetchArgs): Promise<HttpFetchResult> {
    if (!this.socket) throw new HostRelayDisconnected()
    await this.acquireFetchSlot()
    try {
      return (await this.dispatchParallel({ op: 'http.fetch', args: args as unknown as Record<string, unknown> }, args.timeoutMs + 5_000)) as HttpFetchResult
    } finally {
      this.releaseFetchSlot()
    }
  }

  private acquireFetchSlot(): Promise<void> {
    if (this.fetchInFlight < DEVICE_FETCH_CONCURRENCY) { this.fetchInFlight++; return Promise.resolve() }
    return new Promise((resolve, reject) => {
      const waiter = { grant: () => { clearTimeout(timer); this.fetchInFlight++; resolve() } }
      const timer = setTimeout(() => {
        const i = this.fetchWaiters.indexOf(waiter)
        if (i >= 0) this.fetchWaiters.splice(i, 1)
        reject(new HostFetchQueueTimeout())
      }, this.fetchQueueWaitMs)
      timer.unref?.()
      this.fetchWaiters.push(waiter)
    })
  }

  private releaseFetchSlot(): void {
    this.fetchInFlight--
    this.fetchWaiters.shift()?.grant()
  }

  /** 发一个 op、按 id 配回复，**不碰** `inFlight`/`advance`——那是 UI 单发尾锁的。断连由 `rejectAll` 统一拒。 */
  private dispatchParallel(op: HostOp, timeoutMs: number): Promise<unknown> {
    const socket = this.socket
    if (!socket) return Promise.reject(new HostRelayDisconnected())
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HostRelayTimeout(op.op))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { op: op.op, resolve, reject, timer })
      try {
        // 与 `dispatch` 同一条帧形：总是带 `abortEpoch`，设备据此拒收中止之前发出、还在路上的请求
        // （见 `dispatch` 里那段注释）。HTTP 通道不该在用户按了停止之后还把单子送出去。
        socket.send(JSON.stringify({ id, op: op.op, args: op.args, abortEpoch: this.abortEpoch }))
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(e)
      }
    })
  }
```

5. `rejectAll` 不需要改（它遍历 `pending`，并行的也在里面）。但它末尾 `this.inFlight = false` 之前，`pending` 里并行 op 的 reject 不会触发 `advance`（它们的 `reject` 是原生的，不是 `settle`），无副作用。

`src/http/host-registry.ts` 加：

```ts
export type DeviceFetchRelay = Pick<WsHostRelay, 'fetchOp' | 'connected'>

  /** 一台在线且声明了 `http.fetch` 的设备的 HTTP 通道；否则 undefined。 */
  fetchRelay(id: string): DeviceFetchRelay | undefined {
    if (!this.hasOp(id, 'http.fetch')) return undefined
    return this.relays.get(id)
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run src/http/host-relay.fetch.test.ts src/http/host-relay.test.ts src/http/host-relay.attach.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/http/host-relay.ts src/http/host-registry.ts src/http/host-relay.fetch.test.ts
git commit -m "feat(host-relay): http.fetch channel outside the UI session lease"
```

---

### Task 7: `fetchFor` 唯一出站入口

**Files:**
- Create: `src/devices/fetch.ts`
- Test: `src/devices/fetch.test.ts`

**Interfaces:**
- Consumes: `currentPlacement`, `hostAllowed`, `LOCAL_DEVICE`（Task 1）；错误类（Task 2）；`DeviceFetchRelay`, `HttpFetchArgs`, `HttpFetchResult`, `HostOpError`, `HostRelayDisconnected`, `HostRelayTimeout`, `HostFetchQueueTimeout`（Task 6）；`ownedFetch`（`src/http/owned-outbound.ts`）；`DebugEntry`（`src/debug.ts`）
- Produces:
  - `MAX_DEVICE_BODY = 10 * 1024 * 1024`
  - `interface FetchForDeps { directory: { isOnline(id: string): boolean; hasOp(id: string, op: string): boolean; fetchRelay(id: string): DeviceFetchRelay | undefined }; local?: typeof fetch; debug?: (e: DebugEntry) => void; now?: () => number }`
  - `makeFetchFor(deps: FetchForDeps): typeof fetch`
  - `installFetchFor(f: typeof fetch): void`
  - `fetchFor: typeof fetch`（模块级委托：未接线时 `local` 走 `ownedFetch`，非 `local` 抛 `DeviceOffline`）

- [ ] **Step 1: 写失败测试**

```ts
// src/devices/fetch.test.ts
import { describe, it, expect, vi } from 'vitest'
import { makeFetchFor, fetchFor, MAX_DEVICE_BODY } from './fetch.ts'
import { runOnDevice } from './run-context.ts'
import { DeviceIncapable, DeviceLost, DeviceOffline, DeviceRefused, HostNotAllowed } from './errors.ts'
import { HostOpError, HostRelayDisconnected, type HttpFetchArgs } from '../http/host-relay.ts'

const NAS = { deviceId: 'linux:nas', allowHosts: ['eastmoneysec.com'] }
const b64 = (s: string) => Buffer.from(s).toString('base64')

function setup(over: { online?: boolean; ops?: string[]; reply?: (a: HttpFetchArgs) => Promise<unknown> } = {}) {
  const calls: HttpFetchArgs[] = []
  const local = vi.fn(async () => new Response('local'))
  const debug = vi.fn()
  const relay = {
    connected: true,
    fetchOp: async (a: HttpFetchArgs) => { calls.push(a); return (over.reply ?? (async () => ({ status: 200, headers: [['content-type', 'text/plain']], body: b64('nas'), url: a.url })))(a) as never },
  }
  const online = over.online ?? true
  const ops = new Set(over.ops ?? ['http.fetch'])
  const f = makeFetchFor({
    local,
    debug,
    directory: {
      isOnline: () => online,
      hasOp: (_id, op) => ops.has(op),
      fetchRelay: () => (online && ops.has('http.fetch') ? relay : undefined),
    },
  })
  return { f, calls, local, debug }
}

describe('fetchFor', () => {
  it('local 走本机通道', async () => {
    const { f, local, calls } = setup()
    expect(await (await f('https://example.com/')).text()).toBe('local')
    expect(local).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(0)
  })

  it('远程设备：请求经 relay，响应还原成标准 Response', async () => {
    const { f, calls, local } = setup()
    const res = await runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/Trade/Buy', {
      method: 'POST', headers: { cookie: 'a=1', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ x: '1' }), redirect: 'manual',
    }))
    expect(await res.text()).toBe('nas')
    expect(res.headers.get('content-type')).toBe('text/plain')
    expect(res.url).toBe('https://jywg.eastmoneysec.com/Trade/Buy')
    expect(local).not.toHaveBeenCalled()
    expect(calls[0]).toMatchObject({ method: 'POST', redirect: 'manual', allowHosts: ['eastmoneysec.com'] })
    expect(calls[0].headers).toContainEqual(['cookie', 'a=1'])
    expect(Buffer.from(calls[0].body!, 'base64').toString()).toBe('x=1')
  })

  it('302 原样回传', async () => {
    const { f } = setup({ reply: async (a) => ({ status: 302, headers: [['location', '/Login']], body: '', url: a.url }) })
    const res = await runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/Trade/Buy', { redirect: 'manual' }))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/Login')
  })

  it('多值 set-cookie 都在', async () => {
    const { f } = setup({ reply: async (a) => ({ status: 200, headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2']], body: '', url: a.url }) })
    const res = await runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/'))
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
  })

  it('主机不在声明里：HostNotAllowed，不发帧', async () => {
    const { f, calls } = setup()
    await expect(runOnDevice(NAS, () => f('https://example.com/'))).rejects.toBeInstanceOf(HostNotAllowed)
    expect(calls).toHaveLength(0)
  })

  it('设备离线：DeviceOffline，本机通道一次都没被调', async () => {
    const { f, local } = setup({ online: false })
    await expect(runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/'))).rejects.toBeInstanceOf(DeviceOffline)
    expect(local).not.toHaveBeenCalled()
  })

  it('设备没有 http.fetch：DeviceIncapable', async () => {
    const { f } = setup({ ops: ['click'] })
    await expect(runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/'))).rejects.toBeInstanceOf(DeviceIncapable)
  })

  it('途中断连：DeviceLost', async () => {
    const { f, local } = setup({ reply: async () => { throw new HostRelayDisconnected() } })
    await expect(runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/'))).rejects.toBeInstanceOf(DeviceLost)
    expect(local).not.toHaveBeenCalled()
  })

  it('agent 拒绝：DeviceRefused 带 code', async () => {
    const { f } = setup({ reply: async () => { throw new HostOpError('resolved to 10.0.0.5', 'private-target') } })
    const e = await runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/')).catch((x) => x)
    expect(e).toBeInstanceOf(DeviceRefused)
    expect(e.code).toBe('private-target')
  })

  it('调用方的 signal：剩余时间作为 timeoutMs 下发；已中止则不发', async () => {
    const { f, calls } = setup()
    await runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/', { signal: AbortSignal.timeout(15_000) }))
    expect(calls[0].timeoutMs).toBeGreaterThan(0)
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(30_000)
    const ac = new AbortController(); ac.abort()
    await expect(runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/', { signal: ac.signal }))).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('调用方中止时不等设备回复', async () => {
    const { f } = setup({ reply: () => new Promise(() => {}) })
    const ac = new AbortController()
    const p = runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/', { signal: ac.signal }))
    ac.abort()
    await expect(p).rejects.toThrow()
  })

  it('响应体超限：DeviceRefused too-large', async () => {
    const big = Buffer.alloc(MAX_DEVICE_BODY + 1).toString('base64')
    const { f } = setup({ reply: async (a) => ({ status: 200, headers: [], body: big, url: a.url }) })
    const e = await runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/')).catch((x) => x)
    expect(e.code).toBe('too-large')
  })

  it('debug 记录不含 header 与 body', async () => {
    const { f, debug } = setup()
    await runOnDevice(NAS, () => f('https://jywg.eastmoneysec.com/x', { headers: { cookie: 'secret=1' }, method: 'POST', body: 'pw=hunter2' }))
    const entry = JSON.stringify(debug.mock.calls[0][0])
    expect(entry).toContain('linux:nas')
    expect(entry).toContain('jywg.eastmoneysec.com')
    expect(entry).not.toContain('secret')
    expect(entry).not.toContain('hunter2')
  })

  it('未接线的模块级 fetchFor：非 local 一律 DeviceOffline（fail-closed）', async () => {
    await expect(runOnDevice(NAS, () => fetchFor('https://jywg.eastmoneysec.com/'))).rejects.toBeInstanceOf(DeviceOffline)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run src/devices/fetch.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

```ts
// src/devices/fetch.ts
/**
 * 出站 HTTP 的唯一入口。按执行上下文的设备选实现：`local` 走 owned 通道（`ownedFetch`），
 * 其他设备经 host-relay 的 `http.fetch` op 由那台设备发出。调用方拿到的是同一个 fetch 签名。
 *
 * **非 local 的分支里没有任何一条路通向 `ownedFetch`**——设备离线、断连、拒绝都只会抛，
 * 不会改在主实例上发。这是 spec device-execution「绝不回落到 local」的实现本身，不是约定。
 * 权威设计：openspec/changes/device-execution/design.md D5、D6、D9。
 */
import { ownedFetch } from '../http/owned-outbound.ts'
import {
  HostFetchQueueTimeout, HostOpError, HostRelayDisconnected, HostRelayTimeout,
  type HttpFetchArgs, type HttpFetchResult,
} from '../http/host-relay.ts'
import type { DeviceFetchRelay } from '../http/host-registry.ts'
import type { DebugEntry } from '../debug.ts'
import { DeviceFetchQueueTimeout, DeviceIncapable, DeviceLost, DeviceOffline, DeviceRefused, HostNotAllowed } from './errors.ts'
import { LOCAL_DEVICE, currentPlacement, hostAllowed } from './run-context.ts'

export const MAX_DEVICE_BODY = 10 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

export interface FetchForDeps {
  directory: {
    isOnline(id: string): boolean
    hasOp(id: string, op: string): boolean
    fetchRelay(id: string): DeviceFetchRelay | undefined
  }
  local?: typeof fetch
  debug?: (e: DebugEntry) => void
  now?: () => number
}

async function encodeBody(body: RequestInit['body']): Promise<string | undefined> {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.from(body).toString('base64')
  if (body instanceof URLSearchParams) return Buffer.from(body.toString()).toString('base64')
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('base64')
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('base64')
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer()).toString('base64')
  // 流式 body / FormData：设备通道第一版不做流（spec Non-Goals）。说清楚，不悄悄丢。
  throw new TypeError('device fetch: 只支持 string / URLSearchParams / ArrayBuffer / TypedArray / Blob 作为请求体')
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304])

function toResponse(r: HttpFetchResult): Response {
  const headers = new Headers()
  for (const [k, v] of r.headers) headers.append(k, v)
  const bytes = Buffer.from(r.body, 'base64')
  const res = new Response(NULL_BODY_STATUS.has(r.status) ? null : bytes, { status: r.status, headers })
  // 构造出来的 Response 没有 url；调用方（重定向判断、日志）要它。
  Object.defineProperty(res, 'url', { value: r.url })
  return res
}

/** 调用方 signal 的剩余时间。`AbortSignal.timeout` 没有公开剩余时间，所以只能取默认上限，由下面的竞速兜底。 */
function timeoutFor(_signal: AbortSignal | null | undefined): number {
  return DEFAULT_TIMEOUT_MS
}

function abortRace<T>(p: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

export function makeFetchFor(deps: FetchForDeps): typeof fetch {
  const local = deps.local ?? ownedFetch
  const now = deps.now ?? Date.now

  return async function fetchFor(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const p = currentPlacement()
    if (p.deviceId === LOCAL_DEVICE) return local(input, init)

    const req = input instanceof Request ? input : undefined
    const url = new URL(req ? req.url : String(input))
    const deviceId = p.deviceId
    if (!hostAllowed(url.hostname, p.allowHosts)) throw new HostNotAllowed(deviceId, url.hostname)
    if (!deps.directory.isOnline(deviceId)) throw new DeviceOffline(deviceId)
    const relay = deps.directory.fetchRelay(deviceId)
    if (!relay) throw new DeviceIncapable(deviceId, 'http.fetch')

    const signal = init?.signal ?? req?.signal
    if (signal?.aborted) throw signal.reason

    const headers: [string, string][] = []
    new Headers(init?.headers ?? req?.headers).forEach((v, k) => headers.push([k, v]))
    const args: HttpFetchArgs = {
      method: (init?.method ?? req?.method ?? 'GET').toUpperCase(),
      url: url.toString(),
      headers,
      ...(init?.body !== undefined ? { body: await encodeBody(init.body) } : {}),
      redirect: (init?.redirect ?? req?.redirect) === 'manual' ? 'manual' : 'follow',
      timeoutMs: timeoutFor(signal),
      allowHosts: [...p.allowHosts],
    }

    const started = now()
    let status = 0
    try {
      const result = await abortRace(relay.fetchOp(args), signal)
      if (Buffer.byteLength(result.body, 'base64') > MAX_DEVICE_BODY) {
        throw new DeviceRefused(deviceId, 'too-large', `响应体超过 ${MAX_DEVICE_BODY} 字节`)
      }
      status = result.status
      return toResponse(result)
    } catch (e) {
      if (e instanceof DeviceRefused) throw e
      if (e instanceof HostFetchQueueTimeout) throw new DeviceFetchQueueTimeout(deviceId)
      if (e instanceof HostOpError) throw new DeviceRefused(deviceId, e.code ?? 'network', e.message)
      if (e instanceof HostRelayDisconnected || e instanceof HostRelayTimeout) throw new DeviceLost(deviceId, e)
      throw e // 调用方自己的 abort reason 原样抛
    } finally {
      deps.debug?.({
        id: `device-fetch:${deviceId}@${started}`,
        at: started,
        channel: 'device-fetch',
        key: deviceId,
        title: `${args.method} ${url.hostname}`,
        summary: `${deviceId} ${args.method} ${url.hostname} → ${status || 'error'} (${now() - started}ms)`,
        ok: status >= 200 && status < 400,
        fields: [
          { label: 'device', value: deviceId },
          { label: 'method', value: args.method },
          { label: 'host', value: url.hostname },
          { label: 'status', value: String(status || 'error') },
          { label: 'ms', value: String(now() - started) },
        ],
      })
    }
  }
}

/** 未接线时的缺省：local 照常，非 local 一律离线——宁可报错，不可在本机悄悄发出去。 */
let impl: typeof fetch = async (input, init) => {
  const p = currentPlacement()
  if (p.deviceId === LOCAL_DEVICE) return ownedFetch(input, init)
  throw new DeviceOffline(p.deviceId)
}

/** serve 装配时调用一次，把带设备目录的实现装进来。 */
export function installFetchFor(f: typeof fetch): void {
  impl = f
}

/** 模块级委托：调用点不需要接线就能 import，现取 `impl`。 */
export const fetchFor: typeof fetch = (input, init) => impl(input, init)
```

注意 `timeoutFor`：`AbortSignal.timeout()` 没有可读的剩余时间，这里下发固定 30s 上限，调用方的更短超时由 `abortRace` 兑现（`调用方中止时不等设备回复` 那条测试钉住）。测试里 `timeoutMs ≤ 30_000` 的断言与此一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run src/devices/fetch.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/devices/fetch.ts src/devices/fetch.test.ts
git commit -m "feat(devices): fetchFor — one outbound entry, device-routed, fail-closed"
```

---

### Task 8: 包声明主机、`ctx.fetch`、recipe 执行器走 `fetchFor`

**Files:**
- Modify: `src/packages/descriptor.ts`、`src/replay/recipe-install.ts`、`src/packages/activate.ts`、`sdk/plugin-sdk/index.ts`、`src/kernel/plugins/packages.ts`、`src/replay/http-fetch.ts`、`src/replay/html-fetch.ts`
- Test: `src/packages/descriptor.test.ts`（或该文件现有的测试文件）、`src/replay/recipe-install.test.ts`、`src/packages/network-index.test.ts`（新）

**Interfaces:**
- Consumes: `fetchFor`（Task 7）、`PackageNetwork`（Task 4）
- Produces:
  - `StreamDescriptor.network?: { hosts: string[] }`
  - 安装预览 `networkHosts?: string[]`
  - `PluginContext.fetch: typeof fetch`
  - `packageNetwork(pkg: Pick<StreamPackage, 'id' | 'facility' | 'credentials' | 'network'>): PackageNetwork`（`src/packages/network-index.ts`，新）
  - `PackagesService.networkFor(pkgId: string): PackageNetwork | undefined` 与 `networkForFacility(facility: string): PackageNetwork | undefined`

- [ ] **Step 1: 写失败测试**

```ts
// src/packages/network-index.test.ts
import { describe, it, expect } from 'vitest'
import { packageNetwork } from './network-index.ts'

describe('packageNetwork', () => {
  it('hosts 缺省 = credentials，facility 缺省 = id', () => {
    expect(packageNetwork({ id: 'eastmoney', credentials: ['eastmoneysec.com'] }))
      .toEqual({ packageId: 'eastmoney', facility: 'eastmoney', hosts: ['eastmoneysec.com'] })
  })
  it('显式声明优先', () => {
    expect(packageNetwork({ id: 'x', facility: 'xf', credentials: ['a.com'], network: { hosts: ['b.com'] } }))
      .toEqual({ packageId: 'x', facility: 'xf', hosts: ['b.com'] })
  })
  it('什么都没声明 = 空清单（这样的包派不到远程设备）', () => {
    expect(packageNetwork({ id: 'y' }).hosts).toEqual([])
  })
})
```

在 descriptor 的测试文件追加：`stream.network.hosts` 合法域名通过；`'*.com'`、`'http://a.com'`、空串被拒（复用 `credentialDomainProblem` 的同一把尺）。在 `recipe-install.test.ts` 追加：带 `network.hosts` 的包的预览里有 `networkHosts`；没声明时该格缺席。按两文件现有夹具写成真实断言。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run src/packages src/replay/recipe-install.test.ts`
Expected: 新增用例 FAIL。

- [ ] **Step 3: 实现声明与预览**

`src/packages/descriptor.ts`：
- `StreamDescriptor` 在 `credentials?: string[]` 之后加：

```ts
  /** 这个包会访问的主机名后缀。缺省 = `credentials`。派到远程设备的请求只放行这里的主机
   *  （openspec/changes/device-execution/design.md D6），安装确认页把它列给用户看。 */
  network?: { hosts: string[] }
```

- schema：在 `credentials: credentialsSchema.optional(),` 之后加 `network: z.object({ hosts: credentialsSchema }).strict().optional(),`（同一把域名校验尺）
- 投影处 `credentials: stream.credentials,` 之后加 `network: stream.network,`

`src/replay/recipe-install.ts`：预览类型在 `credentials?: string[]` 之后加

```ts
  /** 这个包会访问的主机（`stream.network.hosts`）。没声明就整格缺席——缺省等于 credentials，确认页已经列了那一格。 */
  networkHosts?: string[]
```

预览构造处 `credentials` 那行之后加 `...(r.stream.network?.hosts.length && { networkHosts: r.stream.network.hosts }),`

`src/packages/network-index.ts`（新）：

```ts
import type { PackageNetwork } from '../devices/placement.ts'

/** 包的执行位置相关声明投影。hosts 缺省 = credentials：能拿到哪个站的登录态，就能访问哪个站。 */
export function packageNetwork(pkg: { id: string; facility?: string; credentials?: string[]; network?: { hosts: string[] } }): PackageNetwork {
  return {
    packageId: pkg.id,
    facility: pkg.facility ?? pkg.id,
    hosts: pkg.network?.hosts ?? pkg.credentials ?? [],
  }
}
```

（`StreamPackage` 若不直接带 `facility` / `network`，从其描述符字段取；先 `grep -n "facility\|credentials" src/packages/scan.ts` 确认 `StreamPackage` 上的字段名，按实际字段传。）

- [ ] **Step 4: `ctx.fetch` 与索引**

`src/packages/activate.ts` 的 `PluginContext` 在 `cookieFor` 之后加：

```ts
  /**
   * 出站 HTTP。**包里别用全局 `fetch`**（守卫测试会拦）：这一格按本次执行绑定的设备发出——
   * 绑到 NAS 的账号，请求就从 NAS 出去。签名与标准 fetch 相同。
   * 见 openspec/changes/device-execution/design.md D5。
   */
  fetch: typeof fetch
```

`sdk/plugin-sdk/index.ts` 的镜像接口同位置加同一格（`plugin-sdk-compat.test.ts` 双向钉着，两边必须同时改）。

`src/kernel/plugins/packages.ts`：
- 构造 ctx 的对象里 `cookieFor` 之后加 `fetch: fetchFor,`（import from `../../devices/fetch.ts`）
- 在 `picked` 计算之后建索引：

```ts
    // 执行位置要的两张小表：包 id → 声明、facility → 声明。热装包后 serve 会重建 kernel，这里不做增量。
    const networkIndex = new Map<string, PackageNetwork>()
    const facilityIndex = new Map<string, PackageNetwork>()
    for (const p of [...picked.builtin, ...userCodePackages]) {
      const n = packageNetwork(p)
      networkIndex.set(n.packageId, n)
      if (!facilityIndex.has(n.facility)) facilityIndex.set(n.facility, n)
    }
```

（若 `picked.builtin` / `userCodePackages` 只含代码包而 recipe-only 包不在其中，改用 `packages` 与 `userPackages` 的并集——以「每个声明了 facility 或 credentials 的包都在索引里」为准，`grep -n "userPackages" src/kernel/plugins/packages.ts` 确认变量名。）
- `PackagesService` 加：

```ts
  /** 包 id → 执行位置声明（facility、允许主机）。 */
  networkFor: (pkgId: string) => PackageNetwork | undefined
  /** facility → 执行位置声明（recipe 源按 facility 找到它的包）。 */
  networkForFacility: (facility: string) => PackageNetwork | undefined
```

- `ctx.provide('packages', {...})` 加 `networkFor: (id) => networkIndex.get(id), networkForFacility: (f) => facilityIndex.get(f),`

- [ ] **Step 5: recipe 执行器缺省发送器**

`src/replay/http-fetch.ts`：`const send = doFetch ?? ownedFetch` 改为 `const send = doFetch ?? fetchFor`，import 换成 `fetchFor` from `../devices/fetch.ts`（若 `ownedFetch` 在该文件别处没有用到就删掉那条 import）。
`src/replay/html-fetch.ts`：`const send = doFetch ?? fetch` 改为 `const send = doFetch ?? fetchFor`，同样 import。

两处的 SSRF 前置（`publicHttpUrl`）不动——它在 local 与远程两条路上都先判，远程设备的私网判定在 agent 侧另做（计划 2）。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm exec vitest run src/packages src/replay src/kernel sdk`
Expected: PASS（含 `plugin-sdk-compat.test.ts`）。

- [ ] **Step 7: Commit**

```bash
git add src/packages src/replay/recipe-install.ts src/replay/recipe-install.test.ts src/replay/http-fetch.ts src/replay/html-fetch.ts src/kernel/plugins/packages.ts sdk/plugin-sdk/index.ts
git commit -m "feat(packages): stream.network.hosts, ctx.fetch, recipe fetchers route through fetchFor"
```

---

### Task 9: 动作执行包 `runOnDevice`；eastmoney 用注入的 fetch；守卫

**Files:**
- Modify: `src/tasks/user-tasks.ts`、`packages/eastmoney/client.ts`、`packages/eastmoney/activate.ts`、`src/kernel/plugins/auth.ts`
- Create: `src/no-bare-fetch-in-packages.guard.test.ts`
- Test: `src/tasks/user-tasks.test.ts`、`packages/eastmoney/client.test.ts`（新）

**Interfaces:**
- Consumes: `resolvePlacement`, `assertDeviceReady`, `PackageNetwork`（Task 4）；`runOnDevice`, `currentPlacement`, `LOCAL_DEVICE`（Task 1）；`DeviceIncapable`（Task 2）
- Produces:
  - `CompileOptions.placement?: (row: UserTaskRow) => RunPlacement`
  - `CompileOptions.ready?: (p: RunPlacement) => void`（抛 `DeviceOffline` 等）
  - eastmoney：`openSession(cookie: string, send: typeof globalThis.fetch)`；`EastmoneySession` 加 `send` 字段；`getRepoBid1(code: string, send: typeof globalThis.fetch)`

- [ ] **Step 1: 写失败测试（动作执行）**

在 `src/tasks/user-tasks.test.ts` 追加：

```ts
import { currentDeviceId } from '../devices/run-context.ts'
import { DeviceOffline } from '../devices/errors.ts'

describe('action tasks run on their placement', () => {
  const row = { id: 'em', label: 'x', schedule: '0 45 9 * * *', action: 'eastmoney:calendar', args: [], serial: true, maxAttempts: 1, enabled: true, createdAt: 0, updatedAt: 0 }

  it('动作在解析出的设备上下文里跑，结果带设备', async () => {
    let seen = ''
    const t = compileUserTask(row, {
      actions: () => async () => { seen = currentDeviceId(); return { summary: 'ok', detail: { n: 1 } } },
      placement: () => ({ deviceId: 'linux:nas', allowHosts: ['eastmoneysec.com'] }),
      ready: () => {},
    })
    const out = await t.run({} as never)
    expect(seen).toBe('linux:nas')
    expect(out).toEqual({ summary: 'ok', detail: { device: 'linux:nas', detail: { n: 1 } } })
  })

  it('local 时结果原样', async () => {
    const t = compileUserTask(row, {
      actions: () => async () => ({ summary: 'ok', detail: { n: 1 } }),
      placement: () => ({ deviceId: 'local', allowHosts: [] }),
      ready: () => {},
    })
    expect(await t.run({} as never)).toEqual({ summary: 'ok', detail: { n: 1 } })
  })

  it('设备不就绪：动作一次都不调', async () => {
    const fn = vi.fn()
    const t = compileUserTask(row, {
      actions: () => fn,
      placement: () => ({ deviceId: 'linux:nas', allowHosts: [] }),
      ready: () => { throw new DeviceOffline('linux:nas') },
    })
    await expect(t.run({} as never)).rejects.toBeInstanceOf(DeviceOffline)
    expect(fn).not.toHaveBeenCalled()
  })
})
```

（若文件未 import `vi` / `compileUserTask`，补上。）

- [ ] **Step 2: 写失败测试（eastmoney 走注入的 fetch）**

```ts
// packages/eastmoney/client.test.ts
import { describe, it, expect, vi } from 'vitest'
import { openSession, getRepoBid1, SessionExpired } from './client.ts'

describe('eastmoney client uses the injected fetch', () => {
  it('openSession 读 validatekey，用的是传入的 fetch', async () => {
    const f = vi.fn(async () => new Response('<input id="em_validatekey" value="k-123">'))
    const s = await openSession('c=1', f as never)
    expect(s.validatekey).toBe('k-123')
    expect(f).toHaveBeenCalledOnce()
    expect((f.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: 'manual' })
  })

  it('302 → SessionExpired', async () => {
    const f = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/Login' } }))
    await expect(openSession('c=1', f as never)).rejects.toBeInstanceOf(SessionExpired)
  })

  it('getRepoBid1 用传入的 fetch', async () => {
    const f = vi.fn(async () => Response.json({ name: 'GC001', fivequote: { buy1: '1.85' } }))
    expect(await getRepoBid1('204001', f as never)).toBe(1.85)
    expect(f).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 3: 写守卫测试**

```ts
// src/no-bare-fetch-in-packages.guard.test.ts
/**
 * code 包里直接调全局 `fetch` 的请求永远从主实例发出——绑到 NAS 的账号会悄悄从加州下单，
 * 而一切测试照样绿。包的出站只许经 `ctx.fetch`（或接收注入的 fetch 参数）。
 * 见 openspec/changes/device-execution/specs/device-http-fetch/spec.md。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { repoRoot } from './http/build-identity.ts'

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.|\.guard\./.test(name)) out.push(p)
  }
  return out
}

// 调用形状的裸 fetch：`await fetch(`、`return fetch(`、`= fetch(`、作为实参 `(fetch(` / `, fetch(`，
// 以及任何 `globalThis.fetch`。**不**按「前面不是点」判：adapter 的 `async fetch(...) {` 是方法声明，
// 那样会被误拦。`ctx.fetch(`、`s.send(` 前面是点或别的名字，不命中。
const BARE = /(?:\bawait|\breturn|[=(,])\s*fetch\s*\(|globalThis\.fetch\b/

describe('code 包不直接调全局 fetch', () => {
  it('packages/** 源码里没有裸 fetch(', () => {
    const files = walk(join(repoRoot, 'packages'))
    const hits = files
      .filter((f) => BARE.test(readFileSync(f, 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')))
      .map((f) => relative(repoRoot, f))
    expect(hits, '改用 ctx.fetch 或接收注入的 fetch 参数').toEqual([])
  })
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm exec vitest run src/tasks/user-tasks.test.ts packages/eastmoney src/no-bare-fetch-in-packages.guard.test.ts`
Expected: FAIL——动作测试（缺 placement）、eastmoney 测试（签名不符）、守卫列出 `packages/eastmoney/client.ts` 以及其他用裸 `fetch(` 的包文件。

- [ ] **Step 5: 动作执行包 `runOnDevice`**

`src/tasks/user-tasks.ts`：`CompileOptions` 加

```ts
  /** 这条任务在哪台设备上执行（任务覆盖 → facility 默认 → local）。缺席 = local。见 src/devices/placement.ts。 */
  placement?: (row: UserTaskRow) => RunPlacement
  /** 派发前检查设备就绪（在线、有 http.fetch）；不就绪就抛，动作一次都不调。 */
  ready?: (p: RunPlacement) => void
```

`runAction` 返回的闭包改为：

```ts
  return async () => {
    const fn = opts.actions?.(name)
    if (!fn) {
      throw new Error(
        `没有这个动作：${name}——提供它的包可能被关掉了、装载失败了，或者这个名字打错了`,
      )
    }
    const params = row.configRef !== undefined ? (opts.paramsFor?.(row.configRef) ?? {}) : {}
    const p = opts.placement?.(row) ?? { deviceId: LOCAL_DEVICE, allowHosts: [] }
    opts.ready?.(p)
    const out = await runOnDevice(p, () => fn(params))
    // 运行记录要看得出在哪台设备上跑的；local 原样返回，存量任务的明细形状不变。
    return p.deviceId === LOCAL_DEVICE ? out : { ...out, detail: { device: p.deviceId, detail: out.detail } }
  }
```

import `LOCAL_DEVICE`, `runOnDevice`, `type RunPlacement` from `../devices/run-context.ts`。

- [ ] **Step 6: eastmoney 改用注入的 fetch**

`packages/eastmoney/client.ts`（参数名用 `send` 而不是 `fetch`：守卫按 `await fetch(` 拦裸调用，参数叫 `fetch` 会被误拦）：
- `EastmoneySession` 加 `send: typeof globalThis.fetch`
- `openSession(cookie: string, send: typeof globalThis.fetch)`：体内 `await fetch(` 改为 `await send(`；返回 `{ cookie, validatekey: m[1]!, send }`
- `post` 与 `batchCancel` 里 `await fetch(` 改为 `await s.send(`
- `getRepoBid1(code: string, send: typeof globalThis.fetch)`：体内 `await fetch(` 改为 `await send(`
- 文件头注第一段末尾补一句：`请求一律走调用方传进来的 send（宿主的 ctx.fetch）——账号绑在哪台设备，请求就从哪台设备发出。`

`packages/eastmoney/activate.ts`：
- `openOnce`：`return await openSession(cookie, ctx.fetch)`
- `broker` 里 `repoBid1: (code) => getRepoBid1(code, ctx.fetch),`

- [ ] **Step 7: 其他包的裸 fetch**

Run: `pnpm exec vitest run src/no-bare-fetch-in-packages.guard.test.ts`，对列出的每个文件：
- 在 `activate(ctx)` 能拿到 `ctx` 的地方，把 `fetch(` 改为 `ctx.fetch(`；
- 在纯函数模块里，加一个 `send: typeof globalThis.fetch` 参数并由调用方传 `ctx.fetch`。
每改一个包，跑该包目录下的测试：`pnpm exec vitest run packages/<包名>`。

- [ ] **Step 8: 远程设备上的 `ctx.login` fail-closed**

`src/kernel/plugins/auth.ts` 的 `setFacilityLogin` 回调最前面加：

```ts
    ctx.packages.setFacilityLogin(async (facility) => {
      const p = currentPlacement()
      // 远程设备的浏览器通道在计划 3 接上（device-browser-relay）。在那之前，绑定到远程设备的执行
      // 若在本机 Chrome 里登录，就是「PC 登录、NAS 下单」——宁可失败。
      if (p.deviceId !== LOCAL_DEVICE) throw new DeviceIncapable(p.deviceId, 'browser')
      return loginToFacility(
        {
          // ……原有内容不变……
        },
        facility,
      )
    })
```

补测：在 `src/kernel/plugins/auth*.test.ts` 里找现有 `setFacilityLogin` / `loginToFacility` 的夹具，加一条「在 `runOnDevice({deviceId:'linux:nas'})` 里调 `ctx.login` → 抛 `DeviceIncapable`，登录 recipe 没被执行」。若该层没有现成夹具，把判断抽成 `src/devices/placement.ts` 里的 `assertLocalBrowser(p: RunPlacement): void`（抛 `DeviceIncapable(p.deviceId, 'browser')`）并在 `placement.test.ts` 测它，`auth.ts` 只调用它。

- [ ] **Step 9: 跑测试确认通过**

Run: `pnpm exec vitest run src/tasks packages src/no-bare-fetch-in-packages.guard.test.ts src/kernel src/devices`
Expected: PASS。

- [ ] **Step 10: Commit**

```bash
git add src/tasks/user-tasks.ts src/tasks/user-tasks.test.ts packages src/no-bare-fetch-in-packages.guard.test.ts src/kernel/plugins/auth.ts src/devices
git commit -m "feat(tasks): run actions on their bound device; packages use ctx.fetch"
```

---

### Task 10: recipe 采集按 facility 解析 placement

**Files:**
- Modify: `src/adapters/replay/adapter.ts`
- Test: `src/adapters/replay/adapter.test.ts`

**Interfaces:**
- Consumes: `resolvePlacement`, `assertDeviceReady`（Task 4）；`runOnDevice`（Task 1）
- Produces: `ReplayAdapterDeps.placementFor?: (facility: string | undefined) => RunPlacement`、`ReplayAdapterDeps.ready?: (p: RunPlacement, need: string) => void`

- [ ] **Step 1: 读入口**

Run: `grep -n "async fetch\|facilityOf\|interface .*Deps" src/adapters/replay/adapter.ts | head`
确认 adapter 对外的采集入口方法名（下文称 `fetch(manifest, params)`）与 `facilityOf(manifest)` 的返回形状（它在 `NeedsLoginError(manifest.id, ...facilityOf(manifest))` 里被展开，取第一个元素作为 facility 名）。

- [ ] **Step 2: 写失败测试**

在 `src/adapters/replay/adapter.test.ts` 追加（照该文件构造 adapter 与 http 类 recipe 的现有夹具）：

```ts
  it('绑定到设备的 facility：采集在该设备上下文里跑', async () => {
    let seen = ''
    // 用一个 kind:'http' 的 recipe，deps 里注入 placementFor: () => ({ deviceId: 'linux:nas', allowHosts: ['example.com'] })、
    // ready: () => {}，并让 recipe 的 doFetch / runFetch 桩在被调用时记录 currentDeviceId() 到 seen。
    // 期望 seen === 'linux:nas'
  })
  it('设备离线：采集抛 DeviceOffline，桩没被调用', async () => {
    // ready: () => { throw new DeviceOffline('linux:nas') }
  })
```

按现有夹具写成真实代码。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm exec vitest run src/adapters/replay/adapter.test.ts`
Expected: 新增用例 FAIL。

- [ ] **Step 4: 实现**

在采集入口方法体最外层：

```ts
    const facility = facilityOf(manifest)[0]
    const p = this.deps.placementFor?.(facility) ?? { deviceId: LOCAL_DEVICE, allowHosts: [] }
    // 需要的能力随 recipe 种类：http/html → http.fetch；浏览器类 → browser（计划 3 之前远程设备都没有）；
    // 桌面类沿用 surface 判定，不在这里判。
    if (p.deviceId !== LOCAL_DEVICE && (recipe.kind === 'http' || recipe.kind === 'html')) this.deps.ready?.(p, 'http.fetch')
    else if (p.deviceId !== LOCAL_DEVICE && recipe.kind !== 'desktop') this.deps.ready?.(p, 'browser')
    return runOnDevice(p, async () => { /* 原方法体 */ })
```

（`recipe` 变量在方法体里解析出来的位置以实际代码为准：若 recipe 在方法中段才解析，把 `ready` 判断放到解析之后、第一次出站之前，`runOnDevice` 仍包住整个方法体。）

`ReplayAdapterDeps` 加两格（带中文头注，说明缺席 = local）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm exec vitest run src/adapters/replay`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/adapters/replay/adapter.ts src/adapters/replay/adapter.test.ts
git commit -m "feat(replay): recipe sources follow their facility's device"
```

---

### Task 11: serve 接线与端到端

**Files:**
- Modify: `src/serve.ts`、`src/kernel/plugins/adapters.ts`（ReplayAdapter 的 deps 构造处）
- Test: `src/devices/e2e.test.ts`（新）

**Interfaces:**
- Consumes: 前面所有任务

- [ ] **Step 1: 写端到端测试**

```ts
// src/devices/e2e.test.ts
/**
 * 端到端：一条绑定到 NAS 的东财风格动作，经真的 WsHostRelay（假 socket）把请求发到「设备」，
 * 设备离线时零请求经本机发出。不打网络。
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostRelayRegistry } from '../http/host-registry.ts'
import { makeFetchFor } from './fetch.ts'
import { FacilityDeviceStore } from './facility-devices.ts'
import { assertDeviceReady, resolvePlacement } from './placement.ts'
import { compileUserTask } from '../tasks/user-tasks.ts'
import { DeviceOffline } from './errors.ts'

const hello = { deviceId: 'linux:nas', platform: 'linux' as const, name: 'NAS', agentVersion: '0.1.0', ops: ['http.fetch'] }

function world() {
  const registry = new HostRelayRegistry()
  const local = vi.fn(async () => new Response('local'))
  const fetchFor = makeFetchFor({ directory: registry, local })
  const bindings = new FacilityDeviceStore(join(mkdtempSync(join(tmpdir(), 'e2e-')), 'stream.db'))
  bindings.set('eastmoney', 'linux:nas')
  const row = { id: 'em', label: 'x', schedule: '0 45 9 * * *', action: 'eastmoney:calendar', args: [], serial: true, maxAttempts: 1, enabled: true, createdAt: 0, updatedAt: 0 }
  const task = compileUserTask(row, {
    actions: () => async () => {
      const r = await fetchFor('https://jywg.eastmoneysec.com/Trade/Buy', { redirect: 'manual' })
      return { summary: await r.text() }
    },
    placement: (r) => resolvePlacement({ taskDevice: r.device, facility: 'eastmoney', binding: (f) => bindings.get(f), hosts: ['eastmoneysec.com'] }),
    ready: (p) => assertDeviceReady(p, registry, 'http.fetch'),
  })
  return { registry, local, task }
}

describe('device execution end to end', () => {
  it('请求从设备发出', async () => {
    const { registry, local, task } = world()
    const sent: { id: number; op: string; args: { url: string } }[] = []
    const relay = registry.connect({ send: (d) => {
      const f = JSON.parse(d)
      sent.push(f)
      queueMicrotask(() => relay.handleMessage(JSON.stringify({ id: f.id, result: { status: 200, headers: [], body: Buffer.from('from-nas').toString('base64'), url: f.args.url } })))
    } }, hello)
    const out = await task.run({} as never)
    expect(out.summary).toBe('from-nas')
    expect(sent[0].op).toBe('http.fetch')
    expect(local).not.toHaveBeenCalled()
  })

  it('设备离线：失败且本机零请求', async () => {
    const { local, task } = world()
    await expect(task.run({} as never)).rejects.toBeInstanceOf(DeviceOffline)
    expect(local).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试**

Run: `pnpm exec vitest run src/devices/e2e.test.ts`
Expected: PASS（前面各任务已提供全部零件；若失败，修的是零件之间的接口，不是测试）。

- [ ] **Step 3: serve 接线**

在 `src/serve.ts`：
1. `harvest.hostRelays`（`HostRelayRegistry`）就绪之后：

```ts
  // 出站唯一入口接上设备目录。之前（装配早期）的 fetchFor 对非 local 一律报离线，这一步之后才能派到设备。
  installFetchFor(makeFetchFor({ directory: harvest.hostRelays, debug: (e) => debugBus.push(e) }))
```

（`debugBus.push` 换成本文件里其他模块往 debug bus 写条目时用的那个函数——`grep -n "channel:" src/serve.ts | head` 找到现有写法。）
2. 打开 `taskStore` 的同一个 `stream.db` 路径建 `const facilityDevices = new FacilityDeviceStore(<同一 dbPath>)`；
3. `mountDeviceRoutes(app, { ..., bindings: facilityDevices })`；
4. `compileOpts` 加：

```ts
    placement: (row: UserTaskRow) => {
      const pkgId = row.action?.split(':')[0]
      const net = pkgId ? pkgs.networkFor(pkgId) : undefined
      return resolvePlacement({ taskDevice: row.device, facility: net?.facility, binding: (f) => facilityDevices.get(f), hosts: net?.hosts ?? [] })
    },
    ready: (p: RunPlacement) => assertDeviceReady(p, harvest.hostRelays, 'http.fetch'),
```

5. `src/kernel/plugins/adapters.ts` 构造 ReplayAdapter deps 的地方加 `placementFor` 与 `ready`（`placementFor: (facility) => { const net = facility ? ctx.packages.networkForFacility(facility) : undefined; return resolvePlacement({ facility, binding: (f) => facilityDevices.get(f), hosts: net?.hosts ?? [] }) }`）。`facilityDevices` 需要从 serve 传进 kernel：沿用该域已有的「serve 构造、经 config 传入」方式（看 `adapters.ts` 的 config 类型里 `cookieProvider` 是怎么进来的，同法加一格 `facilityDevices`）。

- [ ] **Step 4: 全量测试**

Run: `pnpm test`
Expected: 与 Task 0 基线一致，无新增失败。

- [ ] **Step 5: 手工冒烟（本机，无设备）**

Run: `pnpm serve`（另一个终端），然后：

```bash
curl -s -X PUT localhost:8900/api/devices/bindings/eastmoney -H 'content-type: application/json' -d '{"deviceId":"linux:nope"}'
```
Expected: `{"error":"没有这台设备：linux:nope"}`，HTTP 400。

```bash
curl -s localhost:8900/api/devices/bindings
```
Expected: `{"bindings":[]}`。现有东财任务照常在本机执行（看任务页历次执行，明细形状与升级前相同）。

- [ ] **Step 6: 文档**

- `docs/ARCHITECTURE.md`：新增「执行位置」一节（设备 = 执行位置、两层绑定、`fetchFor`、按设备的登录态、失败语义表，链接 `openspec/changes/device-execution/design.md`）；出站一节补「包的出站经 `ctx.fetch` / `fetchFor`」。
- `docs/PACKAGE.md`：`stream.network.hosts` 与 `ctx.fetch`（含「包里不要用全局 fetch」与守卫测试名）。
- `docs/API.md`：`POST /api/devices/pair` 的 `platform`；`GET/PUT/DELETE /api/devices/bindings[/:facility]`；任务行 `device` 字段与 400 情形。

- [ ] **Step 7: Commit**

```bash
git add src/serve.ts src/kernel/plugins/adapters.ts src/devices/e2e.test.ts docs/ARCHITECTURE.md docs/PACKAGE.md docs/API.md
git commit -m "feat(devices): wire device execution into serve; docs"
```

- [ ] **Step 8: 勾掉 openspec 任务**

在 `openspec/changes/device-execution/` 新建 `tasks.md`，列出三份计划各自的任务，本计划的全部勾上，并注明计划 2、3、4 的文件路径（写好后再补）。

```bash
git add openspec/changes/device-execution/tasks.md
git commit -m "docs(openspec): device-execution task list"
```
