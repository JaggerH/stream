/**
 * 这个库的运行时 import 闭包是自包含的：不倒着依赖 `src/` 的任何值——`tokenEqual`、
 * `EnvironmentUnavailableError`、`parseExtHandshake` 都是 `shared/` 下的叶子模块，可以被
 * 独立进程（未来的 DSH 插件）单独 import，不会拖进 replay 引擎（`isolated-vm`、
 * `playwright-core` 等）。
 *
 * 唯二剩下的 `src/` 引用（`DebugEntry`、`EventInput`）都是 `import type`：对**运行时**（含插件
 * bundle 体积）零成本，编译期即被擦除。但它们出现在 `ExtRelay` 构造函数的公开签名上，会进
 * 生成的 `.d.ts`——只 vendor `shared/` 单独跑 `tsc`/`tsdown --dts` 的独立包，**类型检查期**仍要
 * 能解析到 `src/debug.ts`、`src/events/store.ts` 这两个文件。留着它们而不是把类型定义抄一份进
 * 库里，是刻意的：抄一份就多了一处要跟这两个文件保持同步的定义，那才是真正的漂移源；而这两个
 * 文件本身是廉价的叶子（`src/debug.ts` 只有类型、零 import，`src/events/store.ts` 只 import
 * `node:fs`/`node:path`），随包带上的代价可以忽略。
 */
import { WebSocketServer } from 'ws'
import type { Server } from 'node:http'
import { tokenEqual } from './token.ts'
import { EnvironmentUnavailableError } from '../failure/environment.ts'
import { parseExtHandshake, type ExtHandshake } from './handshake.ts'
import type { DebugEntry } from '../../src/debug.ts'
import type { EventInput } from '../../src/events/store.ts'
import { RELAY_PROTOCOL } from './wire.ts'

/** WS 子协议名。客户端 offer [EXT_RELAY_PROTOCOL, token]，服务端只回选协议名 —— token 不回显。
 *  值来自 shared/browser-relay/wire.ts（两侧唯一真相源）。 */
const EXT_RELAY_PROTOCOL = RELAY_PROTOCOL
export { EXT_RELAY_PROTOCOL }

/** One member of the session tab group, as the extension reports it (see `ExtRelay.list`). */
export interface GroupTab {
  tabId: number
  url: string
  title: string
  origin?: 'created' | 'probe' | 'adopted'
  /** 此刻真的在 Chrome 的会话标签组里（tab.groupId === 账本 groupId）。旧扩展不带这一格。 */
  grouped?: boolean
  /** 哪张标签把它开出来的（`window.open` / `target=_blank`）。浏览器记的，页面伪造不了。 */
  openerTabId?: number
  /** 是它那扇窗当前显示的标签——原生窗口档按窗口标题寻址，只有 active 的那张对得上。 */
  active?: boolean
  /** 开在一扇 popup 窗里（那种窗不能放标签组，所以它在册却不在组里）。 */
  popup?: boolean
}

/** 一个 OOPIF（跨站 iframe，另一个渲染进程）的 CDP 子会话——扩展 `Target.setAutoAttach` 挂上的。 */
export interface FrameSession {
  sessionId: string
  /** 等于那个 iframe 的 frameId（OOPIF 的 target id 就是它的 frame id）。 */
  targetId: string
  url: string
  /** 嵌套 OOPIF 的父会话；缺席 = 挂在 tab 的主会话下。 */
  parentSessionId?: string
}

/** 扩展报上来的「某张在册标签开出了一张新标签」。 */
export interface TabOpened {
  tabId: number
  openerTabId: number
  url: string
  /** 后端收到这条的时刻（**后端钟**）——只和同侧的 Date.now() 比。 */
  at: number
}

/** 假 socket 只需实现 send —— 便于不接真 WebSocket 就能单测 ExtRelay。 */
export interface ExtSocket {
  send(data: string): void
}

export interface ExtCdpEvent {
  type: 'cdp-event'
  subscriptionId: number
  tabId: number
  method: string
  params: unknown
}

/** 中继没连（socket 为 null）：命令**根本没发出去**。继承 EnvironmentUnavailableError，让调度侧
 *  把它识别成"这一轮跳过"而不是"这个源坏了"——用户关了 Chrome 不是源的错。
 *  注意 ExtRelayTimeout 故意**不**继承它：那是连着的、某条命令挂了，可能是真故障。 */
export class ExtRelayDisconnected extends EnvironmentUnavailableError {
  constructor() {
    super('ext-relay socket disconnected')
    this.name = 'ExtRelayDisconnected'
  }
}
export class ExtRelayTimeout extends Error {
  constructor(method: string) {
    super(`ext-relay command timed out: ${method}`)
    this.name = 'ExtRelayTimeout'
  }
}

/** ExtRelay 只需要能力缓存的这一个动作 —— 结构类型，单测里塞个记账数组就够。 */
export interface CapabilitySink {
  markSeen(info?: ExtHandshake): unknown
}

interface Pending {
  method: string
  /** 这条命令发出的时刻（**后端钟**）。只和同侧的 `Date.now()` 相减，见 RELAY_SLOW_COMMAND_MS。 */
  sentAt: number
  /** 命令打给哪个 tab（没有 tab 的 op 缺席）—— 记账时要它才对得上扩展侧那条。 */
  tabId?: number
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 一条命令慢到该记账的门槛。
 *
 * **和扩展侧的 `SLOW_COMMAND_MS` 取同一个数（5s），是故意的**：两侧同时越线才配得起对——
 * 一侧记、一侧不记，"哪一跳慢"就又没法读了（两条记录靠 `command` + 时间邻近对齐，
 * 不引入跨侧关联 id，理由见 spec §4）。
 */
export const RELAY_SLOW_COMMAND_MS = 5_000

/**
 * 单条 extension WS 连接上的命令/响应配对器。只按 `id` 路由，不懂 recipe、不懂 CDP 语义。
 * 单连接假设：单用户单机一个浏览器。失败语义（断线 / 超时 / 最新连接顶替）见各方法。
 */
export class ExtRelay {
  private socket: ExtSocket | null = null
  /** 当前这条连接的建立时刻（epoch ms）；没连时 null。只服务诊断（status()）。 */
  private connectedAt: number | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private readonly timeoutMs: number
  private readonly eventListeners = new Set<(event: ExtCdpEvent) => void>()

  /** 「装过没」的落盘缓存（可选）。写入点全局只有这一个：下面的 connect()。 */
  private readonly capability: CapabilitySink | null

  /** 慢命令账本的出口（debug bus）。没接就不记——记账通道没资格掀翻一条能用的 relay。 */
  private readonly onDebug: ((entry: DebugEntry) => void) | null

  /**
   * 通知中心的出口。**只有「挂满闸门」那一档走这里**，慢命令不走（5s 门槛在活体上频繁越线，
   * 通知它等于把铃铛按住不放）。必须是调用时才解引用的那种（`lazyNotify`）：事件层比采集
   * 运输面晚建，装配期取到的一律是 undefined。见 spec 2026-08-19-silent-failure-notifications §2.2。
   */
  private readonly onNotify: ((input: EventInput) => void) | null

  constructor(opts?: {
    timeoutMs?: number
    capability?: CapabilitySink
    onDebug?: (entry: DebugEntry) => void
    onNotify?: (input: EventInput) => void
  }) {
    this.timeoutMs = opts?.timeoutMs ?? 30_000
    this.capability = opts?.capability ?? null
    this.onDebug = opts?.onDebug ?? null
    this.onNotify = opts?.onNotify ?? null
  }

  /**
   * 往 debug bus 的 `ext-cdp` channel 记一条。**绝不抛**：这是一条诊断通道，
   * 它出问题不该让一条正在跑的采集命令跟着死。
   */
  private record(key: string, summary: string, fields: Array<[string, string]>): void {
    if (!this.onDebug) return
    const at = Date.now()
    try {
      this.onDebug({
        id: `ext-cdp:${key}@${at}`,
        at,
        channel: 'ext-cdp',
        key,
        title: `中继：${key}`,
        summary,
        ok: false,
        fields: fields.map(([label, value]) => ({ label, value })),
      })
    } catch {
      /* 听众的问题不是中继的问题 */
    }
  }

  /**
   * 往通知中心发「浏览器没回应」。正文写给**只做架构把关、不读术语**的人：什么受影响了、
   * 能读出什么结论、要看详情去哪。severity 用 `warn` 而不是 `error`——这条路有重试/备胎，
   * 可能已经自愈，诚实比整齐重要。
   *
   * `dedupeKey` 按**命令**：`Page.navigate` 一直挂和 `Runtime.evaluate` 一直挂是两个故事。
   * **tabId 不进 key** —— tab id 每次运行都变，编进去等于关掉去重。
   */
  private notifyTimeout(method: string, tabId: number | undefined): void {
    if (!this.onNotify) return
    const seconds = Math.round(this.timeoutMs / 1000)
    try {
      this.onNotify({
        type: 'ext-cdp.timeout',
        severity: 'warn',
        title: '浏览器没有回应，这一轮采集中断',
        body: `Stream 让浏览器做一件事（${method}），等满 ${seconds} 秒一点回音都没有，这次只能算失败——通常会自动重试或退到备用方式。浏览器卡住、或扩展被系统挂起时会这样。详情看诊断面板的 ext-cdp 频道。`,
        detail: this.timeoutDetail(method, tabId),
        dedupeKey: `ext-relay-timeout:${method}`,
      })
    } catch {
      /* 通知通道没资格再补一刀 */
    }
  }

  /**
   * 超时那一刻后端手里到底有什么 —— 复制出去贴给 AI 的那一段。
   *
   * **五个分跳数字必然全是 `unknown`，而且必须写成 `unknown`**：它们（`cdpIssued`/`preCdpMs`/
   * `cdpMs`/`swMs`/`wireMs`）全部在扩展侧产生、随回执带回来，而这次**根本没有回执**。填 0 会
   * 读成"这一跳很快"，于是"扩展压根没走到 SW"和"SW 秒回了"被抹成同一句话——那恰好是这条记录
   * 唯一要回答的分界（判法在 summary 里：同一条命令在扩展侧有没有 slow-command）。
   *
   * `扩展连接` 是第一问：断了 = 命令根本没送出去，那和"送到了却挂住"是两条完全不同的排查路。
   */
  private timeoutDetail(method: string, tabId: number | undefined): string {
    const rows: Array<[string, string]> = [['command', method]]
    if (tabId != null) rows.push(['tabId', String(tabId)])
    rows.push(
      ['waitedMs', String(this.timeoutMs)],
      ['扩展连接', this.socket != null
        ? `在线（自 ${this.connectedAt != null ? new Date(this.connectedAt).toISOString() : '未知时刻'}）`
        : '已断开'],
      ['cdpIssued', 'unknown'],
      ['preCdpMs', 'unknown'],
      ['cdpMs', 'unknown'],
      ['swMs', 'unknown'],
      ['wireMs', 'unknown'],
    )
    rows.push(['为什么这五个是 unknown', '命令没有回执，这些数只在扩展侧产生（诊断面板 ext-cdp 频道的 slow-command 那条），后端一个都没收到。unknown ≠ 0。'])
    return rows.map(([k, v]) => `${k}=${v}`).join('\n')
  }

  /** 扩展 WS 是否在线 —— 诊断探针用（DebugBox 平台推荐）。 */
  get connected(): boolean {
    return this.socket != null
  }

  /**
   * 只读诊断快照：`GET /api/ext/relay-status` 的数据源。`since` 是**当前这条**连接的建立时刻
   * （ISO 8601），未连时 null —— 顶替（新连接接管）会刷新它，报的是现役连接的年龄而不是"首次连上"。
   * 存在的理由：relay 以前日志和 API 双盲，"扩展现在连着吗"只能靠麻烦用户点浏览器猜。
   */
  status(): { connected: boolean; since: string | null } {
    return {
      connected: this.socket != null,
      since: this.socket != null && this.connectedAt != null ? new Date(this.connectedAt).toISOString() : null,
    }
  }

  /**
   * 新连接接入：以最新为准 —— 顶替旧 socket，旧连接在途命令全 reject（fail-fast）。
   *
   * 顺带把「这台机器装过 Chrome + 扩展」记进能力缓存：**扩展跑在 Chrome 里，它连上来这一刻
   * 两个问题同时被回答**（spec §5），所以检测不需要探测任何东西，只需要在这里记一笔。
   * `info` 是扩展自报的版本/浏览器/平台，老版本扩展不带 —— 缺失是正常情况。
   * 记账失败**绝不影响连接**：一份诊断缓存没资格掀翻一条能用的 relay。
   */
  connect(socket: ExtSocket, info?: ExtHandshake): void {
    if (this.socket && this.socket !== socket) this.rejectAll(new ExtRelayDisconnected())
    this.socket = socket
    this.connectedAt = Date.now()
    try {
      this.capability?.markSeen(info)
    } catch {
      /* 缓存写不进去也照常服务 —— everSeen 只服务诊断，不参与任何采集判定 */
    }
    // 「浏览器又能用了」是个别处要知道的事实（登录态对账就挂在这儿）。中继只负责说一声，
    // 不知道听众要拿它干什么 —— 监听器自己吞掉异常，绝不能让它把一次连接建立搞砸。
    for (const fn of this.connectedListeners) {
      try {
        fn()
      } catch {
        /* 监听器的问题不是中继的问题 */
      }
    }
  }

  private readonly connectedListeners: Array<() => void> = []
  private readonly cookiesChangedListeners: Array<(domains: string[]) => void> = []

  /** 每次扩展连上（含重连）时叫一声。 */
  onConnected(fn: () => void): void {
    this.connectedListeners.push(fn)
  }

  /** 扩展报「同步域里的 cookie 变了」时叫一声（带它认为变了的那些域，仅供日志/收窄）。 */
  onCookiesChanged(fn: (domains: string[]) => void): void {
    this.cookiesChangedListeners.push(fn)
  }

  /** 当前 socket 断开：reject 全部 pending，清空 socket（在途命令不永久挂起）。 */
  disconnect(socket: ExtSocket): void {
    if (this.socket !== socket) return // 已被更新的连接顶替，旧 close 不影响现状
    this.socket = null
    this.connectedAt = null
    this.rejectAll(new ExtRelayDisconnected())
  }

  /** 收 {id,result} | {id,error}，按 id resolve/reject 并清 timer。未知 id 忽略。 */
  handleMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: string; type?: string; swMs?: number }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    // 扩展主动报「同步域里的 cookie 变了」。**只报事、不带值**——真要取还是这边发 cookiePull，
    // 好让写入口径只有一个（整份替换）。这条是 quark __puus 那类轮换后能秒级自愈的信号。
    if (msg.type === 'cookies-changed') {
      const domains = (msg as unknown as { domains?: unknown }).domains
      for (const listener of this.cookiesChangedListeners) {
        try {
          listener(Array.isArray(domains) ? domains.filter((d): d is string => typeof d === 'string') : [])
        } catch {
          /* 监听器的问题不是中继的问题 */
        }
      }
      return
    }
    if (msg.type === 'tab-opened') {
      const m = msg as unknown as { tabId?: unknown; openerTabId?: unknown; url?: unknown }
      if (typeof m.tabId !== 'number' || typeof m.openerTabId !== 'number') return
      this.recordOpened({ tabId: m.tabId, openerTabId: m.openerTabId, url: typeof m.url === 'string' ? m.url : '', at: Date.now() })
      return
    }
    if (msg.type === 'cdp-event') {
      const event = msg as unknown as ExtCdpEvent
      if (
        typeof event.subscriptionId !== 'number' || typeof event.tabId !== 'number' ||
        typeof event.method !== 'string'
      ) return
      for (const listener of this.eventListeners) listener(event)
      return
    }
    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    this.recordIfSlow(p, msg.swMs)
    if (msg.error !== undefined) p.reject(new Error(msg.error))
    else p.resolve(msg.result)
  }

  /**
   * 命令回来了但很慢 → 记一条带分段的账。
   *
   * **这里是整条线上唯一一处跨侧的算术，写法是刻意的**：后端和扩展是两个进程、两个钟
   * （本机后端跑在 WSL 里，墙钟还会偶发回退），所以**绝不做 `t扩展 - t后端` 这种跨钟减法**
   * ——那种数看起来像耗时，其实是耗时 + 两钟偏差，可能比要测的量还大，而且读起来毫无破绽。
   *
   * `wireMs` 由**两个同侧时长相减**得到：后端自己量的总耗时，减去扩展**自报**的它那一侧
   * 耗时（`swMs`，随回执带回来）。减号两边都是时长不是时刻，各自在自己的钟上量完。
   * 代价是去程和回程混在一起分不开——明确接受，要拆开就只能做那个假的减法。
   *
   * 两个不许做的化简：
   * - 老扩展不带 `swMs` → 报 `unknown`，**不用 0 顶替**（0 会把整段时间栽给 SW）。
   * - `wireMs` 可以是负数（两侧时钟分辨率 + 序列化开销），**原样报，不 clamp 成 0**
   *   ——clamp 会把"这个量本来就有噪声"这件事藏起来，而 -3ms 和 +28000ms 是两码事。
   */
  private recordIfSlow(p: Pending, swMs: unknown): void {
    const backendTotalMs = Date.now() - p.sentAt
    if (backendTotalMs < RELAY_SLOW_COMMAND_MS) return
    const sw = typeof swMs === 'number' && Number.isFinite(swMs) ? swMs : null
    this.record(
      'relay-slow',
      `${p.method} 回来了，后端这侧总共等了 ${backendTotalMs}ms` +
        (sw != null ? `（扩展自报占 ${sw}ms，WS 那两段合计 ${backendTotalMs - sw}ms）` : '（扩展没报它那一侧的耗时）'),
      [
        ['command', p.method],
        ...(p.tabId != null ? [['tabId', String(p.tabId)] as [string, string]] : []),
        ['backendTotalMs', String(backendTotalMs)],
        ['swMs', sw != null ? String(sw) : 'unknown'],
        ['wireMs', sw != null ? String(backendTotalMs - sw) : 'unknown'],
      ],
    )
  }

  /**
   * Send a CDP command to a tab in the session group.
   * `expectDomain` (optional) is the domain captured when the action was decided: the
   * extension re-checks the tab's current domain right before the command lands and refuses
   * if the page has navigated elsewhere in the meantime. Pass it for mutating actions;
   * read-only ones are not domain-gated.
   */
  sendCommand(tabId: number, method: string, params: unknown, expectDomain?: string, sessionId?: string): Promise<any> {
    // `sessionId`：打给这张标签里某个 OOPIF 的子会话（见 `frameSessions`）。缺席 = tab 的主会话。
    return this.send(method, {
      tabId,
      method,
      params,
      ...(expectDomain ? { expectDomain } : {}),
      ...(sessionId ? { sessionId } : {}),
    })
  }

  /**
   * 这张标签里跨站 iframe（OOPIF）的 CDP 子会话。**同站的 iframe 不在这里**——它们和主文档同一个
   * 渲染进程，在主会话的 `Page.getFrameTree` 里就有；只有另一个进程里的 frame 才需要一条子会话。
   * 旧扩展不认这个 op，会回 error——调用方把它当"只有主会话"处理。
   */
  frameSessions(tabId: number): Promise<FrameSession[]> {
    return this.send('frames', { op: 'frames', tabId }).then((r) => (r as { sessions?: FrameSession[] }).sessions ?? [])
  }

  /** 最近被在册标签开出来的标签（环形，只留最近这些）。 */
  private readonly opened: TabOpened[] = []
  private readonly openedWaiters = new Set<() => void>()

  private recordOpened(e: TabOpened): void {
    this.opened.push(e)
    if (this.opened.length > 50) this.opened.shift()
    for (const w of [...this.openedWaiters]) w()
  }

  /**
   * `openerTabId` 从 `since`（后端钟）起开出来的标签；一张都还没有就最多等 `waitMs`，**第一张一到
   * 就返回**（不必等满）。一张都没开的动作要白等满 `waitMs`——这是"点完之后告诉你开了新标签"的
   * 价钱，调用方只对会开标签的动作（click/submit）付它。
   */
  async openedSince(openerTabId: number, since: number, waitMs = 0): Promise<TabOpened[]> {
    const pick = () => this.opened.filter((e) => e.openerTabId === openerTabId && e.at >= since)
    if (pick().length || waitMs <= 0) return pick()
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.openedWaiters.delete(check)
        resolve()
      }
      const check = () => {
        if (pick().length) done()
      }
      const timer = setTimeout(done, waitMs)
      this.openedWaiters.add(check)
    })
    return pick()
  }

  newTab(url: string, waitUntil?: string, background?: boolean): Promise<number> {
    // background=true → the extension opens a lightweight background tab (passive
    // fetch/eval); false/undefined → a dedicated window (interactive render/scroll).
    return this.send('newTab', { op: 'newTab', url, waitUntil, background }).then(
      (r) => (r as { tabId: number }).tabId,
    )
  }

  /**
   * Open a page for the user — find-or-open, and nothing else: no debugger attached, no script
   * injected, so `chrome://*` privileged pages open fine (the newTab path dies attaching to them
   * *after* the tab already exists, leaving an orphan window behind).
   * A tab this CREATES joins the session tab group like every other tab the extension opens —
   * group membership means "Stream opened this", not "this can be driven". A tab that was
   * already open (`created:false`) is the user's own and is only activated, never pulled in.
   * The receipt's `title` is the bridge to the native-window address space: a Chrome window is
   * titled "<tab title> - Google Chrome", so `app:chrome.exe/<title>` addresses the very page
   * this returned.
   */
  openTab(url: string, opts: { ownWindow?: boolean } = {}): Promise<{ tabId: number; title: string; url: string; created: boolean }> {
    // ownWindow 只在为 true 时才铺进去（exactOptionalPropertyTypes，同本文件另两处）
    return this.send('openTab', { op: 'openTab', url, ...(opts.ownWindow ? { ownWindow: true } : {}) }) as Promise<{
      tabId: number
      title: string
      url: string
      created: boolean
    }>
  }

  closeTab(tabId: number): Promise<void> {
    return this.send('closeTab', { op: 'closeTab', tabId }).then(() => undefined)
  }

  /**
   * Enumerate the tabs inside the session tab group — {tabId, url, title, origin} each.
   * This is how the AI identifies a target tab (by url/title) instead of guessing;
   * every acting op then takes an explicit tabId. Tabs outside the group never appear.
   * `origin` says who put the tab in the group: `adopted` = the user dragged it in (a live page
   * of theirs), `created`/`probe` = we opened it. Absent from an extension that predates it.
   */
  list(): Promise<GroupTab[]> {
    return this.send('list', { op: 'list' }).then((r) => (r as { tabs: GroupTab[] }).tabs)
  }

  /**
   * The cookie NAMES a domain currently has in the user's Chrome — never the values. Not because
   * values may not cross the relay (`cookiePull` above carries them), but least privilege: login
   * detection only needs "is the session cookie there", so that is all this hands over.
   *
   * This is the cheap half of login detection: if a facility's declared `sessionCookies` are all
   * absent, the session is definitively gone and the caller can decline without opening a tab.
   * It can only ever say NO — a name being present does not mean the server still honours the
   * session, so a positive answer still has to be confirmed on a real page.
   */
  cookieNames(domain: string): Promise<string[]> {
    return this.send('cookieNames', { op: 'cookieNames', domain }).then(
      (r) => (r as { names: string[] }).names,
    )
  }

  /**
   * 把这些域的 cookie **值**取回来。取代了扩展定时往后端推的那条路。
   *
   * 为什么调度权该在这边：只有后端知道什么时候要用登录态（要采集了、快照多旧、刚刚是不是
   * 吃了个 401）。扩展一样都不知道，所以它只能按时间猜——猜的代价就是"cookie 轮换之后干等
   * 一整个周期，期间每次取流都 412"。
   *
   * **范围不由这边说了算**：扩展只应答它自己申报过的同步域，范围外的原样退回 `refused`。
   * 拿到 `refused` 非空要当成配置问题喊出来，别当成"用户没登录"——那正是静默失真。
   */
  cookiePull(domains: string[]): Promise<{ cookies: Record<string, unknown[]>; refused: string[] }> {
    return this.send('cookiePull', { op: 'cookiePull', domains }) as Promise<{
      cookies: Record<string, unknown[]>
      refused: string[]
    }>
  }

  /** 用户这会儿在看哪个标签（当前窗口）。没有窗口 → null。前台采集动手前问一次。 */
  activeTab(): Promise<number | null> {
    return this.send('activeTab', { op: 'activeTab' }).then((r) => (r as { tabId: number | null }).tabId)
  }

  /**
   * 把焦点还回 `tabId`。礼貌闸门在扩展那边：只有当前 active 标签还是会话组成员（= 焦点确实
   * 是采集抢来的）才切；用户中途自己切走了就什么都不做。目标标签已被关掉也不是错误，回 `false`。
   */
  activateTab(tabId: number): Promise<boolean> {
    return this.send('activateTab', { op: 'activateTab', tabId }).then(
      (r) => (r as { restored: boolean }).restored,
    )
  }

  subscribe(tabId: number, domains: string[]): Promise<number> {
    return this.send('subscribe', { op: 'subscribe', tabId, domains }).then(
      (r) => (r as { subscriptionId: number }).subscriptionId,
    )
  }

  unsubscribe(subscriptionId: number): Promise<void> {
    return this.send('unsubscribe', { op: 'unsubscribe', subscriptionId }).then(() => undefined)
  }

  onEvent(listener: (event: ExtCdpEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  private send(method: string, body: Record<string, unknown>): Promise<any> {
    const socket = this.socket
    if (!socket) return Promise.reject(new ExtRelayDisconnected())
    const id = this.nextId++
    const tabId = typeof body.tabId === 'number' ? body.tabId : undefined
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // 闸门到点、命令**根本没回**。这条记录要能自己回答下一个问题：命令到底送没送到扩展？
        // 判据不在这条记录里，在扩展侧那条 —— 所以把判法写进 summary，半夜看它的人手里只有它。
        this.record(
          'relay-timeout',
          `${method} 等满 ${this.timeoutMs}ms 没有回执。判「送到没送到」：` +
            `同一条命令在扩展侧有没有 slow-command —— 有=送到了、SW 手里挂着；没有=根本没走到 SW`,
          [
            ['command', method],
            ...(tabId != null ? [['tabId', String(tabId)] as [string, string]] : []),
            ['waitedMs', String(this.timeoutMs)],
          ],
        )
        // 通知中心：debug bus 是 200 条的内存 ring，重启即失，用户感知到「刷不出来」时现场
        // 早没了。这一条必然意味着一次采集/操作失败了，值得主动出现在他面前。
        this.notifyTimeout(method, tabId)
        reject(new ExtRelayTimeout(method))
      }, this.timeoutMs)
      // exactOptionalPropertyTypes（`@streamapp/desktop` 那份更严的 tsconfig 会拿这一行较真）：
      // `tabId` 是可选字段，显式赋 `undefined` 与"没有这个字段"在这个选项下是两回事——只在真有
      // 值时才把它铺进去，没有就干脆不带这个键。
      this.pending.set(id, { method, sentAt: Date.now(), resolve, reject, timer, ...(tabId !== undefined ? { tabId } : {}) })
      socket.send(JSON.stringify({ id, ...body }))
    })
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}

/**
 * WS 升级请求的鉴权判定（纯函数，便于单测）。两层都过才放行：
 * 1. Origin 不得是 http(s)://（网页来源一律拒 —— 就算它持有 token，持有即泄露）；
 *    扩展 SW 的 WS Origin 是 chrome-extension:// 或空，均放行到第 2 层。
 * 2. Sec-WebSocket-Protocol 里必须带与共享 secret 常数时间相等的 token
 *    （客户端 offer [EXT_RELAY_PROTOCOL, token]，token 走头部而非 URL，不进访问日志）。
 */
export function verifyExtUpgrade(
  info: { origin?: string; protocolHeader?: string },
  token: string,
): boolean {
  if (/^https?:\/\//i.test(info.origin ?? '')) return false
  const offered = (info.protocolHeader ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((p) => p && p !== EXT_RELAY_PROTOCOL)
  // noUncheckedIndexedAccess（同上，`@streamapp/desktop` 那份更严的 tsconfig 会较真）：
  // 数组下标访问的类型天然带 `| undefined`，即便上一行已经确认了 length===1——TS 不会替我们
  // 把这层收窄传导到 `offered[0]`，所以显式取一次值再判。
  if (offered.length !== 1) return false
  const candidate = offered[0]
  if (candidate === undefined) return false
  return tokenEqual(candidate, token)
}

/**
 * 在现有 node http server 上挂 `/api/ext` WS 端点，喂给 ExtRelay。仿 attachWs（ws.ts）。
 * loopback（Caddy 绑定 127.0.0.1）只是第一层；本端点能力等价「驱动用户登录态浏览器」，
 * 而 loopback WS 对用户浏览器里的任意网页同样可达，故握手强制 verifyExtUpgrade（拒 http(s)
 * Origin + subprotocol 承载的共享 token）。扩展手里那份 token 不是后端给的——它经 native
 * messaging 从 `data/ext-relay-token` 自取，并在握手前打 `/api/ext/verify` 确认对端也知道它。
 * 每条新连接：connect(socket, 自报字段)（顶替旧连接）；message → handleMessage；close/error → disconnect。
 * 自报字段来自升级请求 URL 的 query（`?extVersion=&browser=&platform=`），喂给能力缓存；缺就是缺。
 * 建立与断开各打一行日志（含 origin）；连不连得上的实时答案另见 `GET /api/ext/relay-status`。
 * 后端侧 ~20s 发 WS ping 帮 MV3 SW 续命；连接关闭时清 interval。
 */
export function attachExtRelay(
  server: Server,
  relay: ExtRelay,
  opts: { token: string; path?: string; log?: (line: string) => void },
): WebSocketServer {
  const { token, path = '/api/ext', log = console.log } = opts
  // noServer + 自路由：`{ server, path }` 模式下同一 http server 上的多个 WSS 会互相
  // 对不匹配路径的 upgrade 回 400（/ws 的实例会抢先拒掉发往 /api/ext 的握手）。
  // 各自只认领自己的路径，其余 upgrade 留给其他监听器。
  const wss = new WebSocketServer({
    noServer: true,
    // 只回选协议名 —— 绝不把 token 那一项回显进响应头
    handleProtocols: (protocols: Set<string>) => (protocols.has(EXT_RELAY_PROTOCOL) ? EXT_RELAY_PROTOCOL : false),
  })
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '', 'http://localhost').pathname
    if (pathname !== path) return // 不是自己的路径：留给其他 WSS 的 upgrade 监听器
    // exactOptionalPropertyTypes：req.headers.* 天然是 `string | undefined`，直接铺给一个
    // `origin?: string` 的可选字段会被判成"显式赋了 undefined"而不是"没给"——同上一处的坑，
    // 只在真有值时才带这个键。
    const origin = req.headers.origin
    const protocolHeader = req.headers['sec-websocket-protocol']
    const ok = verifyExtUpgrade(
      {
        ...(origin !== undefined ? { origin } : {}),
        ...(protocolHeader !== undefined ? { protocolHeader } : {}),
      },
      token,
    )
    if (!ok) {
      log(`[ext-relay] rejected upgrade (origin=${req.headers.origin ?? '<none>'})`)
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  wss.on('connection', (socket, req) => {
    // 连接建立/断开各一行 —— 这条链路以前只记 rejected upgrade，"扩展到底连没连上"日志里查不到，
    // 误诊一次要靠反复麻烦用户点浏览器（见 GET /api/ext/relay-status 的同批修）。
    const origin = req?.headers?.origin ?? '<none>'
    // 扩展自报的 extVersion/browser/platform 走升级请求的 query（token 仍走 subprotocol —— 那个是
    // secret，不进 URL）。不带 query 的老版本扩展照常连上，只是缓存里那三格空着。
    relay.connect(socket, parseExtHandshake(req?.url))
    log(`[ext-relay] connected (origin=${origin})`)
    const ping = setInterval(() => {
      try {
        socket.ping()
      } catch {
        /* socket 关闭时 ping 抛错，close 处理器会清理 */
      }
    }, 20_000)
    socket.on('message', (data) => relay.handleMessage(data.toString()))
    // close + error 可能都触发：只放行第一次，断开日志一条连接只出一行。
    let torndown = false
    const teardown = () => {
      if (torndown) return
      torndown = true
      clearInterval(ping)
      relay.disconnect(socket)
      log(`[ext-relay] disconnected (origin=${origin})`)
    }
    socket.on('close', teardown)
    socket.on('error', teardown)
  })
  return wss
}

/**
 * 关掉一个中继的 WebSocketServer。**两条中继（`/api/ext`、`/api/host`）共用这一个**——
 * 它们的 wss 生命周期一模一样，两处各写一遍迟早只改一处。
 *
 * 先 `terminate()` 每条还连着的连接，再 `close()` 服务器：单靠 `wss.close()` 不动已有连接，
 * 而每条连接身上挂着一个 20s 的 ping `setInterval`——那个 interval 只在 socket 的 close/error
 * 上清。不主动断连的话，关停后事件循环里还钉着几个定时器，进程该退的时候退不干净。
 *
 * 断开是**正常关停**，不是故障：扩展那侧看到的就是一次普通断线，它自己会重连。
 */
export function closeRelayServer(wss: WebSocketServer): void {
  for (const client of wss.clients) {
    try {
      client.terminate()
    } catch {
      /* 已经死掉的连接 terminate 会抛；关停路径不该因为它中断 */
    }
  }
  wss.close()
}
