import { WebSocketServer } from 'ws'
import type { Server } from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'
import { PAIRED_PLATFORMS } from '../devices/device-store.ts'
import { tokenEqual } from './secrets.ts'
import { keepRelayAlive, type RelayHandler, type RelayUpgradeHandle } from './ext-relay.ts'
import type { HostRelay, HostOp } from '../replay/desktop-driver.ts'
import { parseHello, parseState, type HostDeviceState, type HostRelayRegistry } from './host-registry.ts'

/**
 * The `/api/host` relay — the backend end of the `host-desktop` Engine. It pairs the
 * DesktopDriver's ops with the replies of Stream Desktop's native process (the
 * `stream-desktop` binary) over ONE WebSocket, by `id`.
 * It mirrors `ext-relay.ts` (the browser transport's relay): recipe logic stays in the
 * backend, the agent is a thin executor, and a fake socket makes it unit-testable with no
 * real WS. See `docs/superpowers/specs/2026-07-19-desktop-uia-engine-telegram-design.md`.
 */

/** WS subprotocol name. Client offers [HOST_RELAY_PROTOCOL, token]; server echoes only the name. */
export const HOST_RELAY_PROTOCOL = 'host-relay.v2'
/** The previous protocol. It is refused with a message naming the fix, never accepted. */
export const STALE_HOST_PROTOCOL = 'host-relay.v1'

/** A fake socket only needs `send`; `close` lets the registry drop a revoked device. */
export interface HostSocket {
  send(data: string): void
  close?(code?: number, reason?: string): void
}

export class HostRelayDisconnected extends Error {
  constructor() {
    // 这句会被端到面板顶部，所以说的是产品名（Stream Desktop），不是那个二进制的名字。
    super('Stream Desktop not connected')
    this.name = 'HostRelayDisconnected'
  }
}

export class HostRelayTimeout extends Error {
  constructor(op: string) {
    super(`host op timed out: ${op}`)
    this.name = 'HostRelayTimeout'
  }
}

/** 排队等会话租约等太久——**不是** agent 没响应（那是 `HostRelayTimeout`）。处置不同：
 *  op 超时说明 agent 本身可能挂了；排队超时只说明"前面那趟 recipe 占得太久"，agent 本身
 *  是健康的。调用方要能分得开这两种，才能给用户说清"该等还是该查 agent"。 */
export class HostSessionQueueTimeout extends Error {
  constructor() {
    super('host session queue wait timed out（排队等待会话租约超时——不是 agent 没响应，是前面占着的一趟还没让出来）')
    this.name = 'HostSessionQueueTimeout'
  }
}

/** 用户按了 agent 的全局中止热键（`Ctrl+Alt+Esc`）。**必须和另外三档分开**：
 *  `HostRelayTimeout` = agent 可能挂了、去查 agent；`HostRelayDisconnected` = 断连；
 *  `HostSessionQueueTimeout` = 健康但被占着、稍后重试。这一档是**用户的明确意图**，
 *  任何一层都不许自动重试——重试会把用户刚刚亲手叫停的动作再做一遍。 */
export class HostAbortedByUser extends Error {
  /** 手机横幅上的「停止」（abort 帧 `reason:'phone-stop'`；更早的手机 App 发 `'user'`——桌面热键
   *  一直是 `'user-hotkey'`），不是电脑上的热键——两处说法不同。 */
  readonly byPhone: boolean
  constructor(reason?: string) {
    const byPhone = reason === 'phone-stop' || reason === 'user'
    super(byPhone
      ? `Phone aborted by user (${reason})——用户在手机上点了停止，不要自动重试`
      : `Stream Desktop aborted by user${reason ? ` (${reason})` : ''}——用户在本机按下了中止热键，不要自动重试`)
    this.name = 'HostAbortedByUser'
    this.byPhone = byPhone
  }
}

/**
 * 交互路径（`cdp_act`/`cdp_look` 等 / `run_action_recipe`）排队等会话租约的等待上界——
 * 远小于默认的 `sessionWaitMs`（180s）。
 *
 * I1：排队没有取消——调用方（MCP 客户端）对一次工具调用的超时通常远小于 180s，超时后排在
 * 队里的那份 op **照样会在轮到它时真的执行**：调用方早已报错、上层很可能已经重试过一次，
 * 结果同一个动作（尤其是像"发消息"这类不可撤销的一次性副作用）被真的做了两遍。
 *
 * 两条路都能堵住这个洞：给 `withSession` 接一个真正的 `AbortSignal`，或者让交互路径自己的
 * 等待上界主动比客户端超时更短，"排不上"在客户端放弃之前就先失败。选后者——`AbortSignal`
 * 要贯穿 MCP 工具入口 → cdp-router → desktop-surface → 这里好几层，而这条链路今天没有任何
 * 一层在传 signal（`stdio-entry.ts` 之外没人接 abort），补一条端到端的取消链比这个洞本身
 * 更大；调小等待上界只改这一处、不改调用链形状，且效果等价——两者都是"讲清楚现在别等了"，
 * 差别只在于讲清楚的时机是"客户端放弃那一刻"还是"排队本身先一步认输"。
 *
 * 具体数字：MCP 工具调用的客户端超时常见档位在 30s–60s，取比这个区间下限还要窄一截的 20s，
 * 让我们自己先喊停——调用方看到的会是"排队超时，稍后重试"而不是沉默地等一个已经没人在等
 * 的结果。**这不消灭重复执行本身**（调用方仍可能在收到超时后自己重试一次，把动作做成两遍）
 * ——它消灭的是"调用方以为没发生、其实排队里悄悄发生了"这个更隐蔽的形状；重试是调用方
 * 知情做出的决定，静默执行不是。
 */
export const INTERACTIVE_SESSION_WAIT_MS = 20_000

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

export interface FetchOpOptions {
  /**
   * 调用方的中止信号。只在**排队等名额**这一段生效：中止就摘出队列、以 `signal.reason` 拒绝，
   * 这个请求永远不会发出（因此可重试）。帧已发出之后的中止由调用方自己处理（`fetchFor` 判成 device-lost）。
   */
  signal?: AbortSignal | null
  /** 帧即将写上 socket 时同步调用——调用方据此记下「本次执行已有请求发出」（见 run-context 的 dispatch 标记）。 */
  onSent?: () => void
}

/** 每台设备的 HTTP 在途上限。一次采集不该把 NAS 打满，也不该被 UI 租约挡住。 */
export const DEVICE_FETCH_CONCURRENCY = 4

interface Pending {
  op: string
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

interface SessionWaiter {
  token: symbol
  /** 排到我了——真的把会话交给我（设置 sessionHolder），再放行等着的 promise。 */
  grant: () => void
  reject: (e: unknown) => void
}

/** 会话租约持有者的身份，挂在 AsyncLocalStorage 上——`send()` 靠它分辨"这个 op 是租约持有者
 *  自己发的"（跳过排队，直接走底层单发尾锁）还是"外人插队"（必须先排队等租约）。放在模块作用域
 *  而不是类字段：`AsyncLocalStorage` 本来就是跨 await 传播上下文用的，不需要、也不该每个
 *  relay 实例各建一份。 */
const sessionContext = new AsyncLocalStorage<symbol>()

/**
 * Command/response pairer over one host-agent WS connection. Routes purely by `id`; knows
 * nothing about UIA or recipe semantics. One relay per device; the registry (`host-registry.ts`) holds one per `deviceId`.
 * Failure semantics — disconnect / timeout / latest-connection-wins — mirror ExtRelay.
 */
export class WsHostRelay implements HostRelay {
  private socket: HostSocket | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private readonly timeoutMs: number
  private readonly sessionWaitMs: number
  /** 是否有一个 op 正在途中（已发到 socket，等回复）。这是**单发 op 配对**的尾锁——保证同一
   *  时刻只有一个 op 在物理连接上等回复，纯粹是"一条 WS 连接、一份 id→pending 映射"这件事本身
   *  要求的，跟下面的会话租约是两回事：它不区分这个 op 是谁发的，落定就放行队首。 */
  private inFlight = false
  /** 上面那把尾锁的排队区：`inFlight` 时新来的 op 先在这里等，上一个 op 落定才轮到它真的发。 */
  private readonly queue: Array<{ op: HostOp; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = []

  /**
   * 会话租约——**真正防跨 recipe 交错的那道闸**（`inFlight`/`queue` 只保证单个 op 的收发不
   * 串台，不保证"一整趟 recipe 的十几个 op 不被另一条 recipe 的 op 插进来"）。
   *
   * 物理机只有一个鼠标/键盘焦点，desktop recipe 靠 scopeWindow/focusApp 抢的是**全局**前台。
   * 一条 recipe 是十几个 op（focus → find → click → type → read，每个都是一次 relay round-trip）；
   * 只在单个 op 粒度上尾锁，两条并发 recipe 不是被排队，而是被**严格轮流交错**——A 的 op 落定
   * 后，`settle` 同步调 `advance()` 先发 B 排队的那个，A 的下一个 op 才回来排队，于是发到 socket
   * 的顺序变成 `focusApp{A} → focusApp{B} → type{A的字} → type{B的字}`，字被打进了别人的窗口。
   * 这在 2026-08 的复评里是实测撞见的事故，不是理论推演。
   *
   * `withSession` 把"整趟 recipe"当一个不可分割的单元：持有期间，任何人（另一条 recipe、
   * `cdp_act`/`cdp_look` 的单发 op）的 `send()` 都必须先排队等释放，租约持有者自己的 op 则
   * 直接走底层的单发尾锁（靠 `sessionContext` 这个 AsyncLocalStorage 识别"是不是我自己"，
   * 不需要每次显式传 token）。公平：`sessionQueue` 先到先得。有等待上界：`sessionWaitMs`，
   * 排太久拒绝并报 `HostSessionQueueTimeout`（跟 op 本身超时的 `HostRelayTimeout` 分得开）。
   */
  private sessionHolder: symbol | null = null
  private readonly sessionQueue: SessionWaiter[] = []

  /** 中止的世代号：每收到一帧 abort 就 +1。**排队等租约的单发 op 靠它判自己该不该还执行**。
   *
   *  为什么需要它：`rejectAll` 够不着 `sessionQueue`——一个在别人持租约时发出的 `send()`，
   *  排的是**租约队列**而不是单发尾锁的 `queue`。热键按下时它还没发出去，看起来"没受影响"，
   *  可持有者被拒之后租约立刻让给它，于是它把那个动作照做不误——**热键只停了一半，而且
   *  停掉的是已经做完的那半**。判据是"这个 op 是在中止之前提交的吗"，不是"它发出去了吗"。
   *
   *  只管单发 op，不管 `withSession` 的排队者：后者是**还没开始**的另一趟活（另一条 recipe
   *  等着用桌面），把它一并拒掉等于一按热键就把桌面通道锁死，那是另一种坏。 */
  private abortEpoch = 0
  private abortReason: string | undefined
  /** 当前 `withSession` 持有者拿到租约时的 `abortEpoch`。中止落在这趟会话的两个 op 之间时，
   *  没有挂起的 op 可拒，持有者的下一个 `send()` 靠它发现"中止发生在我开始之后"，整趟停下——
   *  否则用户按了停止，横幅消失，动作却接着做。中止之后才拿到租约的会话不受影响。 */
  private holderEpoch = 0

  /** HTTP 通道：在途数与排队者。与 `inFlight`/`queue`（UI 单发尾锁）、`sessionHolder`（UI 会话租约）完全分开。 */
  private fetchInFlight = 0
  private readonly fetchWaiters: Array<{ grant: () => void; reject: (e: unknown) => void }> = []
  private readonly fetchQueueWaitMs: number

  constructor(opts?: { timeoutMs?: number; sessionWaitMs?: number; fetchQueueWaitMs?: number }) {
    this.timeoutMs = opts?.timeoutMs ?? 30_000
    this.fetchQueueWaitMs = opts?.fetchQueueWaitMs ?? 30_000
    // 一趟桌面 recipe 十几个 op、每个最多等 timeoutMs——排在它后面的默认给足够宽的窗口
    // （比单个 op 的超时宽一个数量级），不然长 recipe 天然会把后面排队的人挤到超时。
    this.sessionWaitMs = opts?.sessionWaitMs ?? 180_000
  }

  /** Whether Stream Desktop's WS is online — for diagnostics probes. */
  get connected(): boolean {
    return this.socket != null
  }

  /** New connection: latest wins — supersede the old socket and reject its in-flight ops (fail-fast). */
  connect(socket: HostSocket): void {
    if (this.socket && this.socket !== socket) this.rejectAll(new HostRelayDisconnected())
    this.socket = socket
  }

  /** Current socket closed: reject all pending, clear socket (no in-flight op hangs forever). */
  disconnect(socket: HostSocket): void {
    if (this.socket !== socket) return // already superseded by a newer connection
    this.socket = null
    this.rejectAll(new HostRelayDisconnected())
  }

  /** Receive {id,result} | {id,error}, resolve/reject by id and clear its timer. Unknown id ignored. */
  handleMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: string; code?: unknown; type?: string; reason?: string }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    // agent 主动发起的一帧（没有 id）：用户在本机按了中止热键。把挂起的和排队的 op 全部
    // 以 HostAbortedByUser 拒掉——只拒挂起的那一个是"热键只停了一半"，排在后面的 op 会
    // 在下一格继续把动作做下去。租约不在这里动：拒绝会冒泡回 withSession 的 finally，
    // 由它照常释放并交给下一个排队者（和断连那条路完全同构）。
    if (msg.type === 'abort') {
      this.abortEpoch++
      this.abortReason = msg.reason
      this.rejectAll(new HostAbortedByUser(msg.reason))
      return
    }
    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error !== undefined) p.reject(new HostOpError(msg.error, typeof msg.code === 'string' ? msg.code : undefined))
    else p.resolve(msg.result)
  }

  /**
   * Implements HostRelay: send one op, await its correlated reply.
   *
   * 会话租约优先于单发尾锁：
   *  - 调用方就是当前租约持有者（`sessionContext` 命中且等于 `sessionHolder`）→ 跳过排队，
   *    直接走底层单发尾锁——这是租约持有者自己顺序发出的第 N 个 op，不该等自己。
   *  - 没人持有租约 → 这一个 op 当"一次性租约"：同步拿锁、同步发出（保持"发送是同步的"这条
   *    既有行为不变，不因为加了租约机制而给未竞争的调用多插一次事件循环等待），落定后
   *    （无论成败）立刻释放，把租约交给下一个排队者。
   *  - 租约被别人占着 → 排队等释放，轮到我再真正发（`HostSessionQueueTimeout` 兜底）。
   *
   * 没连 socket 时照旧立刻拒绝（不占队列、不占租约、不用等）。
   */
  send(op: HostOp): Promise<unknown> {
    if (!this.socket) return Promise.reject(new HostRelayDisconnected())
    const currentToken = sessionContext.getStore()
    if (currentToken !== undefined && currentToken === this.sessionHolder) {
      if (this.abortEpoch !== this.holderEpoch) return Promise.reject(new HostAbortedByUser(this.abortReason))
      return this.sendLocked(op)
    }
    if (this.sessionHolder === null) {
      const token = Symbol('host-op-lease')
      this.sessionHolder = token
      const p = this.sendLocked(op)
      const release = () => this.releaseSession(token)
      p.then(release, release)
      return p
    }
    const epoch = this.abortEpoch
    return this.queueSession(Symbol('host-op-lease')).then((token) => {
      // 排队期间用户按了中止热键：这个 op 是**中止之前**提交的，轮到它了也不许再做——
      // 见 `abortEpoch` 头注。租约照常还回去，下一个排队者不受牵连。
      if (this.abortEpoch !== epoch) {
        this.releaseSession(token)
        throw new HostAbortedByUser(this.abortReason)
      }
      const p = this.sendLocked(op)
      const release = () => this.releaseSession(token)
      p.then(release, release)
      return p
    })
  }

  /** 会话级：把 `fn` 整体当一个不可分割的单元跑——持有期间，别人的 `send()`（另一条并发
   *  recipe、单发 op）一律排队等释放。`runDesktopRecipe` 用它把一整趟 recipe 包起来；见类头注。
   *  异常路径也释放：`try/finally` 兜底 `fn` 抛错、超时、agent 中途断开各种情形。
   *
   *  `opts.waitMs` 覆盖默认的 `sessionWaitMs`——交互路径（`cdp_act`/`run_action_recipe`）传
   *  `INTERACTIVE_SESSION_WAIT_MS`，让排队本身先于调用方的客户端超时认输（见该常量头注的 I1）。
   *
   *  **可重入保护**：持有者自己的上下文里再调一次 `withSession` 会直接跑 `fn`，不会去排自己
   *  的队——排自己的队永远等不到自己释放，会稳定卡满 `waitMs` 才报一个看起来像"被别人占着"
   *  的错，而真因是嵌套调用，两者对不上号，极难归因。今天没有嵌套调用点，这行是防御性的。 */
  async withSession<T>(fn: () => Promise<T>, opts?: { waitMs?: number }): Promise<T> {
    const currentToken = sessionContext.getStore()
    if (currentToken !== undefined && currentToken === this.sessionHolder) {
      return fn()
    }
    const token = Symbol('host-session')
    if (this.sessionHolder === null) {
      this.sessionHolder = token
    } else {
      await this.queueSession(token, opts?.waitMs)
    }
    this.holderEpoch = this.abortEpoch
    try {
      return await sessionContext.run(token, fn)
    } finally {
      this.releaseSession(token)
    }
  }

  /** 把 `token` 排进会话租约队列，等轮到它（`sessionHolder` 被交给它）才 resolve。等太久
   *  （`waitMs` ?? `sessionWaitMs`）自动出队并拒绝——不许无限期占着队列。`timer.unref()`：
   *  一个排队中的等待者不该把 Node 事件循环多吊住一整个等待窗口，影响进程优雅退出
   *  （同仓库 `scheduler.ts`/`member-pipeline.ts` 的长 timer 都这么处理）。 */
  private queueSession(token: symbol, waitMs?: number): Promise<symbol> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.sessionQueue.findIndex((w) => w.token === token)
        if (idx >= 0) this.sessionQueue.splice(idx, 1)
        reject(new HostSessionQueueTimeout())
      }, waitMs ?? this.sessionWaitMs)
      timer.unref?.()
      this.sessionQueue.push({
        token,
        grant: () => {
          clearTimeout(timer)
          this.sessionHolder = token
          resolve(token)
        },
        reject,
      })
    })
  }

  /** 释放会话租约。只有真正的持有者能释放（防御性检查——每次 acquire 都配一次 finally/`.then`
   *  release，理论上不该触发别的路径）。队列里有人等就直接把租约交给他（不经过"先清空再抢"
   *  那个窗口，抢不到别人插队的可能）；没人等就真的清空。 */
  private releaseSession(token: symbol): void {
    if (this.sessionHolder !== token) return
    const next = this.sessionQueue.shift()
    if (next) {
      next.grant()
      return
    }
    this.sessionHolder = null
  }

  /**
   * 经设备代发一个 HTTP 请求（`http.fetch` op）。**不占 UI 会话租约、不进单发尾锁**：
   * 一条在跑的 UI recipe 不该挡住同一台设备上的 HTTP，HTTP 也不该被 recipe 的十几个 op 夹住。
   * 并发由 `DEVICE_FETCH_CONCURRENCY` 限住。op 超时 = 请求自己的超时再宽 5 秒（agent 侧先到点）。
   */
  fetchOp(args: HttpFetchArgs, opts: FetchOpOptions = {}): Promise<HttpFetchResult> {
    const { signal } = opts
    // 已经中止的调用不进队列、不发出：调用方放弃了，就不该在之后某个名额空出来时被补发。
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (!this.socket) return Promise.reject(new HostRelayDisconnected())
    // 有空位就同步占位、同步发出（与 `send()` 同样"未竞争时发送是同步的"）；满了才排队。
    // 不能写成 `await acquire` 再发：那会给未竞争的调用平白多一次微任务延迟。
    const run = () => this.runFetch(args, opts.onSent)
    if (this.fetchInFlight < DEVICE_FETCH_CONCURRENCY) { this.fetchInFlight++; return run() }
    return this.waitFetchSlot(signal).then(run)
  }

  /** 调用方已占好名额；无论成败都释放（成功、op 错误、超时、断连各条路都经过这里）。 */
  private async runFetch(args: HttpFetchArgs, onSent?: () => void): Promise<HttpFetchResult> {
    try {
      return (await this.dispatchParallel({ op: 'http.fetch', args: args as unknown as Record<string, unknown> }, args.timeoutMs + 5_000, onSent)) as HttpFetchResult
    } finally {
      this.releaseFetchSlot()
    }
  }

  private waitFetchSlot(signal?: AbortSignal | null): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
      const drop = () => {
        const i = this.fetchWaiters.indexOf(waiter)
        if (i >= 0) this.fetchWaiters.splice(i, 1)
      }
      const waiter = {
        grant: () => { done(); this.fetchInFlight++; resolve() },
        // 中止/断连时由 `rejectAll` 调：没拿过名额，所以不动 `fetchInFlight`。
        reject: (e: unknown) => { done(); reject(e) },
      }
      // 调用方在排队时放弃：摘出队列，不然名额空出来时它会被 grant、帧照样发出——
      // 调用方以为"没发"（可重试），设备那边却收下了。
      const onAbort = () => { done(); drop(); reject(signal!.reason) }
      const timer = setTimeout(() => {
        done()
        drop()
        reject(new HostFetchQueueTimeout())
      }, this.fetchQueueWaitMs)
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      this.fetchWaiters.push(waiter)
    })
  }

  private releaseFetchSlot(): void {
    this.fetchInFlight--
    this.fetchWaiters.shift()?.grant()
  }

  /** 发一个 op、按 id 配回复，**不碰** `inFlight`/`advance`——那是 UI 单发尾锁的。断连由 `rejectAll` 统一拒。 */
  private dispatchParallel(op: HostOp, timeoutMs: number, onSent?: () => void): Promise<unknown> {
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
        // （见 `dispatch` 里那段注释）。中止/断连时 `rejectAll` 连排队等名额的也一起拒了，
        // HTTP 通道不会在用户按了停止之后还把单子送出去。
        // 先记「已发出」再写 socket：send 同步抛时也宁可当作可能发出了（不重试），不可反过来。
        onSent?.()
        socket.send(JSON.stringify({ id, op: op.op, args: op.args, abortEpoch: this.abortEpoch }))
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(e)
      }
    })
  }

  /** 底层单发尾锁：`inFlight` 时排队，不立刻发到 socket——见 `queue` 头注。 */
  private sendLocked(op: HostOp): Promise<unknown> {
    if (this.inFlight) {
      return new Promise((resolve, reject) => { this.queue.push({ op, resolve, reject }) })
    }
    return this.dispatch(op)
  }

  /** 真的把一个 op 发到 socket 上，落定后（无论成败）串行链前进一格。第一个 op 在 `send()`
   *  里同步调用它——保持既有的"发送是同步的"行为不变，只有排在后面的 op 才经过排队等待。 */
  private dispatch(op: HostOp): Promise<unknown> {
    const socket = this.socket
    if (!socket) {
      this.inFlight = false
      return Promise.reject(new HostRelayDisconnected())
    }
    this.inFlight = true
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const settle = (fn: (v: unknown) => void, v: unknown) => {
        fn(v)
        this.inFlight = false
        this.advance()
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        settle(reject, new HostRelayTimeout(op.op))
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        op: op.op,
        resolve: (v) => settle(resolve, v),
        reject: (e) => settle(reject, e),
        timer,
      })
      // args omitted when absent — keeps the wire shape minimal and matches the driver's ops
      // `abortEpoch`（总是带，从 0 起）：设备记下自己发出 abort 时见过的世代，拒收更旧的请求——
      // 那是中止之前发出、还在路上的 op，后端已经把它判成 HostAbortedByUser 了。总是带，是让
      // 设备分得清"后端会数中止"和"老后端不带这个字段"：后者设备一律不拒，免得一按停止就锁死。
      const frame: Record<string, unknown> = { id, op: op.op }
      if (op.args !== undefined) frame.args = op.args
      frame.abortEpoch = this.abortEpoch
      const payload = JSON.stringify(frame)
      try {
        socket.send(payload)
      } catch (e) {
        // I3: send 同步抛（序列化失败、ws 状态异常）不能留着 inFlight=true 干等 30s 超时才
        // 自愈——那段时间整条桌面通道全停。当场落定，跟真的发出去又失败/超时走同一条 settle 路。
        this.pending.delete(id)
        clearTimeout(timer)
        settle(reject, e)
      }
    })
  }

  /** 放行队列里下一个 op（若有）。 */
  private advance(): void {
    const next = this.queue.shift()
    if (!next) return
    this.dispatch(next.op).then(next.resolve, next.reject)
  }

  private rejectAll(err: Error): void {
    // 先把还没真的发出去的排队项摘出来，防止下面 pending 那条的 reject 触发 advance() 时，
    // 把它们派发到一个已经清空的 socket 上（此刻 this.socket 已经是 null 了）。
    const queued = this.queue.splice(0)
    // HTTP 通道同样一并停掉：排队等名额的 fetch 也摘出来拒绝。必须在拒 pending 之前摘——
    // 否则在途 fetch 的 finally 释放名额时会把排队者放行，在仍然活着的 socket 上以中止之后的
    // abortEpoch 发出去，设备会收下，热键又只停了一半。
    const fetchQueued = this.fetchWaiters.splice(0)
    for (const w of fetchQueued) w.reject(err)
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
    this.inFlight = false
    for (const q of queued) q.reject(err)
    // 断连不清空会话租约状态：持有者自己的下一个 send() 会因为 !this.socket 立刻拒绝，
    // 冒泡回 withSession 的 fn，其 finally 照常 releaseSession——租约会自然让给下一个排队者，
    // 排队者的第一个 send() 同样立刻因无 socket 而拒绝，如此级联清空，不需要在这里手动介入。
  }
}

/** The single non-protocol entry of a `Sec-WebSocket-Protocol` offer, which is the token. `null`
 *  when the offer does not carry exactly one. */
export function offeredToken(protocolHeader: string | undefined, protocol: string): string | null {
  const rest = (protocolHeader ?? '').split(',').map((s) => s.trim()).filter((p) => p && p !== protocol)
  return rest.length === 1 ? rest[0] : null
}

/**
 * WS upgrade auth (pure, unit-testable). Two gates:
 * 1. Origin must NOT be http(s):// — a web page origin is always rejected (holding the token
 *    is itself a leak). Stream Desktop is a native process — its WS origin is empty, allowed on.
 * 2. Sec-WebSocket-Protocol must carry a token constant-time-equal to the shared secret
 *    (client offers [HOST_RELAY_PROTOCOL, token]; token rides the header, never the URL).
 */
export function verifyHostUpgrade(
  info: { origin?: string; protocolHeader?: string },
  token: string,
  protocol: string = HOST_RELAY_PROTOCOL,
): boolean {
  if (/^https?:\/\//i.test(info.origin ?? '')) return false
  const t = offeredToken(info.protocolHeader, protocol)
  return t !== null && tokenEqual(t, token)
}

/**
 * Mount the `/api/host` WS endpoint and feed a {@link HostRelayRegistry}.
 *
 * Handshake order: (1) a `host-relay.v1` offer gets **426** with a message that names the fix. A
 * stale agent must not look like a token problem or like a backend that is down. (2) Then
 * `verifyHostUpgrade` checks the origin and the token. (3) After the upgrade, the **first frame must
 * be a `hello`** within `helloTimeoutMs`. Anything else closes with 4001. Only then is the device
 * registered and frames routed to its relay. A ~20s WS ping keeps the connection warm; a peer that
 * misses a pong for two periods (a frozen VM, a closed lid) is dropped ({@link keepRelayAlive}).
 */
export function hostRelayHandler(
  registry: HostRelayRegistry,
  opts: {
    token: string
    deviceAuth?: (token: string) => string | undefined
    onDeviceSeen?: (deviceId: string) => void
    path?: string
    /**
     * 额外认领的路径（同一条中继、同一套握手）。host agent 把 `/api/host` **写死**在自己代码里
     * （`app/host-agent/src/device.rs` 的 `ws_url`），网关挂在别的 basePath 上时也必须答得出这一条。
     * 缺省空。与扩展中继的 `alsoPaths`（`shared/browser-relay/relay.ts`）同一个先例。
     */
    alsoPaths?: readonly string[]
    log?: (line: string) => void
    helloTimeoutMs?: number
    /** Heartbeat period, default 20s; for tests. */
    pingIntervalMs?: number
    onDeviceState?: (deviceId: string, prev: HostDeviceState | undefined, next: HostDeviceState) => void
  },
): RelayHandler {
  const { token, deviceAuth, onDeviceSeen, onDeviceState, path = '/api/host', log = console.log, helloTimeoutMs = 5_000, pingIntervalMs } = opts
  const owned = new Set([path, ...(opts.alsoPaths ?? [])])
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols: Set<string>) =>
      protocols.has(HOST_RELAY_PROTOCOL) ? HOST_RELAY_PROTOCOL : false,
  })
  // 可组合的认领函数（openspec embeddable-device-gateway）：自己的路径完成整套握手并返回 true，
  // 别人的路径返回 false 且不碰 socket。老用法（自挂 server）见 attachHostRelay，共用这份逻辑。
  const handle: RelayUpgradeHandle = (req, socket, head) => {
    const pathname = new URL(req.url ?? '', 'http://localhost').pathname
    if (!owned.has(pathname)) return false // not our path: leave for other WSS upgrade listeners
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim())
    if (offered.includes(STALE_HOST_PROTOCOL)) {
      const body = `Stream Desktop is too old — update it (this backend speaks ${HOST_RELAY_PROTOCOL})`
      log(`[host-relay] refused a ${STALE_HOST_PROTOCOL} agent — ${body}`)
      socket.write(
        `HTTP/1.1 426 Upgrade Required\r\nContent-Type: text/plain; charset=utf-8\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      )
      socket.destroy()
      return true
    }
    let boundDevice: string | undefined
    let deviceToken: string | undefined
    const shared = verifyHostUpgrade(
      { origin: req.headers.origin, protocolHeader: req.headers['sec-websocket-protocol'] },
      token,
    )
    if (!shared) {
      const t = /^https?:\/\//i.test(req.headers.origin ?? '')
        ? null
        : offeredToken(req.headers['sec-websocket-protocol'], HOST_RELAY_PROTOCOL)
      try {
        boundDevice = t ? deviceAuth?.(t) : undefined
      } catch (e) {
        // An internal failure is not a revoke: 401 makes a phone forget its pairing, 503 makes it retry.
        log(`[host-relay] deviceAuth threw at upgrade — refusing: ${String(e)}`)
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return true
      }
      deviceToken = t ?? undefined
      if (!boundDevice) {
        log(`[host-relay] rejected upgrade (origin=${req.headers.origin ?? '<none>'})`)
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return true
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, { boundDevice, deviceToken }))
    return true
  }
  wss.on('connection', (socket, _req, bound: { boundDevice?: string; deviceToken?: string } = {}) => {
    const { boundDevice, deviceToken } = bound
    let deviceId: string | null = null
    let closing = false
    const helloTimer = setTimeout(() => {
      if (deviceId === null) {
        closing = true
        socket.close(4001, 'expected hello')
      }
    }, helloTimeoutMs)
    helloTimer.unref?.()
    const stopPing = keepRelayAlive(socket, {
      ...(pingIntervalMs ? { intervalMs: pingIntervalMs } : {}),
      onDead: () => log(`[host-relay] no pong — dropping ${deviceId ?? 'an unidentified peer'}`),
    })
    socket.on('message', (data) => {
      if (closing) return
      const raw = data.toString()
      if (deviceId !== null) {
        const state = parseState(raw)
        if (state) {
          const prev = registry.setState(deviceId, state)
          onDeviceState?.(deviceId, prev, state)
          return
        }
        registry.devices().find((d) => d.hello.deviceId === deviceId)?.relay.handleMessage(raw)
        return
      }
      const hello = parseHello(raw)
      if (!hello) {
        log('[host-relay] first frame was not a hello — closing')
        closing = true
        socket.close(4001, 'expected hello')
        return
      }
      if (boundDevice !== undefined && hello.deviceId !== boundDevice) {
        log(`[host-relay] device token for ${boundDevice} sent a hello for ${hello.deviceId} — closing`)
        closing = true
        socket.close(4003, 'device id does not match its token')
        return
      }
      if (boundDevice !== undefined && (!PAIRED_PLATFORMS.has(hello.platform) || !hello.deviceId.startsWith(`${hello.platform}:`))) {
        log(`[host-relay] device token for ${boundDevice} claimed platform ${hello.platform} — closing`)
        closing = true
        socket.close(4003, 'device token platform mismatch')
        return
      }
      if (boundDevice !== undefined) {
        // Revocation can land between the upgrade and the hello; kick only reaches registered sockets.
        let still: string | undefined
        try {
          still = deviceToken ? deviceAuth?.(deviceToken) : undefined
        } catch (e) {
          // Not a revoke: 4003 makes the phone forget its pairing. 1011 lets it retry.
          log(`[host-relay] deviceAuth threw at hello — closing: ${String(e)}`)
          closing = true
          socket.close(1011, 'device check failed, retry')
          return
        }
        if (still !== boundDevice) {
          log(`[host-relay] device token for ${boundDevice} no longer valid at hello — closing`)
          closing = true
          socket.close(4003, 'revoked')
          return
        }
      } else if (PAIRED_PLATFORMS.has(hello.platform)) {
        log(`[host-relay] shared secret claimed the ${hello.platform} platform — closing`)
        closing = true
        socket.close(4003, `${hello.platform} devices must pair`)
        return
      }
      clearTimeout(helloTimer)
      deviceId = hello.deviceId
      // 顶掉旧连接时把这件事写进日志：挂起醒来后「重连了但没有 online 事件」的排查看的就是这一行。
      const replaced = registry.isOnline(hello.deviceId)
      registry.connect(socket, hello)
      if (boundDevice !== undefined) onDeviceSeen?.(boundDevice)
      log(
        `[host-relay] device connected ${hello.deviceId} (${hello.platform}, ${hello.name}, v${hello.agentVersion}, ${hello.ops.length} ops)` +
          (replaced ? ' — replaced a live connection' : ''),
      )
    })
    const teardown = () => {
      clearTimeout(helloTimer)
      stopPing()
      if (deviceId !== null) registry.disconnect(socket, deviceId)
    }
    socket.on('close', teardown)
    socket.on('error', teardown)
  })
  return { path, wss, handle }
}

/** 老用法（自己挂 server）：行为与抽出 handler 之前逐字节一致。 */
export function attachHostRelay(
  server: Server,
  registry: HostRelayRegistry,
  opts: {
    token: string
    deviceAuth?: (token: string) => string | undefined
    onDeviceSeen?: (deviceId: string) => void
    path?: string
    log?: (line: string) => void
    helloTimeoutMs?: number
    /** Heartbeat period, default 20s; for tests. */
    pingIntervalMs?: number
    onDeviceState?: (deviceId: string, prev: HostDeviceState | undefined, next: HostDeviceState) => void
  },
): WebSocketServer {
  const h = hostRelayHandler(registry, opts)
  server.on('upgrade', (req, socket, head) => { h.handle(req, socket, head) })
  return h.wss
}
