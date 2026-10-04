import type { ReplayPage } from './browser-fetch.ts'
import type { GroupTab } from '../../shared/browser-relay/relay.ts'
import type { RecipeSessionSpec } from './recipe.ts'
import type { Transport } from './transport.ts'
import { actWithConfirm } from './run-action.ts'
import { detectLoginState } from './actions.ts'
import type { LoginCheck, LoginState } from './recipe.ts'
import {
  classifyAction,
  hostOf,
  needsConfirmation,
  type ActResult,
  type ActionSpec,
  type LaneMode,
} from './interactive-gate.ts'

/**
 * 这条 lane 正被**登录流程**占着（扫码面板开着、在等用户操作）。
 *
 * 采集撞上它要**当场返回**，不能排队：登录流程会一直占到用户扫完或超时（分钟级），而搜索
 * 给每个成员的预算是 25 秒——排队的结果一定是超时，而且报出来的是"这个源超时"，把"你需要
 * 登录"这个真正可操作的信息盖掉了。用户从始至终的要求也是这条：**没登录不该阻塞搜索**。
 */
export class LaneBusyForLoginError extends Error {
  constructor(readonly facility: string) {
    super(`facility "${facility}" is busy with a login flow`)
    this.name = 'LaneBusyForLoginError'
  }
}

export type RecipeSessionStatus = 'idle' | 'leased' | 'blocked'

/** rawPage 是 transport 私有的句柄（`unknown`），ext-cdp 那一档上面挂着 `tabId`。
 *  这里只做一次窄化，不假设别的 transport 也有——没有就是 undefined，对账时当作"这条 lane
 *  不占浏览器标签"处理。 */
function laneTabId(rawPage: unknown): number | undefined {
  const id = (rawPage as { tabId?: unknown } | undefined)?.tabId
  return typeof id === 'number' ? id : undefined
}

export interface RecipeSessionState {
  facility: string
  laneKey: string
  status: RecipeSessionStatus
  reason?: string
  /** 这条 lane 正骑着的浏览器标签 id（ext-cdp 档才有）。**这是「后端还认不认这个标签」的
   *  唯一凭据**——扩展拿它对账、回收后端重启后留下的孤儿标签（见 GET /api/ext/claimed-tabs）。 */
  tabId?: number
}

export interface RecipeSessionLease {
  facility: string
  page: ReplayPage
  rawPage?: unknown
  visibility: RecipeSessionSpec['visibility']
  /** true = riding a tab the user opened (see `adopt`); the page is live, not a parked copy. */
  adopted?: boolean
  markBlocked(reason: string): void
  release(): Promise<void>
}

/**
 * The lane budget. Both ceilings are best-effort: a lane is evicted to make room ONLY when it
 * is idle (no in-flight lease) — under genuine concurrent load the manager oversubscribes
 * rather than deadlock a live harvest.
 *
 * There is no memory ceiling here any more. It existed to bound CloakBrowser, a chromium tree
 * Stream launched INSIDE this container and therefore had to pay for and police. The tabs are
 * now in the user's own Chrome: not our process, not our RAM, and not ours to evict over — a
 * container-side RSS reading says nothing about them.
 */
export interface SessionBudget {
  /** per-facility lane cap — the behavioural/risk gate (a human opens few tabs on one site) */
  maxLanesPerFacility?: number
  /** global lane cap across all facilities */
  maxLanesGlobal?: number
  /** don't evict a lane whose last use is within this window — covers the birth→first-claim gap */
  graceMs?: number
  now?: () => number
  /**
   * keepAlive lane 的 lane→tabId 落盘处。lane 映射只在进程内存里，没有它，后端一重启：关停时
   * `closeAll` 把常驻标签关掉（连同里面用户的文档），就算没关，扩展重连对账也会把这张没人认领的
   * 自建标签当孤儿收走。有了它：关停不关常驻标签、启动就认领它（`pinnedTabIds`）、下一次 acquire
   * 原地骑回去（`launcher.adopt`）。缺席 = 只在本进程内常驻（测试、没有数据目录的宿主）。
   */
  keepAliveStore?: KeepAliveStore
}

/** lane key → tabId 的持久化（一个 JSON 文件就够：条目数 = 常驻 lane 数，个位数）。 */
export interface KeepAliveStore {
  load(): Record<string, number>
  save(pins: Record<string, number>): void
}

interface PersistentEntry {
  facility: string
  laneKey: string
  page: ReplayPage
  rawPage?: unknown
  /** the session's Transport — look/act/shot ride its primitives instead of Playwright semantics */
  transport: Transport
  close: () => Promise<void>
  tail: Promise<void>
  releaseTail: (() => void) | null
  status: RecipeSessionStatus
  reason?: string
  /** in-flight leases (held OR waiting on the tail). >0 ⇒ never evict — someone wants this lane. */
  leaseCount: number
  /** 谁占着它。'login' = 扫码流程（可能占几分钟），采集撞上要当场退，不排队。 */
  holder: LeasePurpose | null
  lastUsedAt: number
  /** spec.keepAlive：不闲置回收、不腾位置、blocked 不关——只有用户关掉标签才重开 */
  keepAlive: boolean
}

const DEFAULT_LANE = 'default'

/** 一次租借是为了什么。采集撞上 'login' 会当场退（见 LaneBusyForLoginError）。 */
export type LeasePurpose = 'harvest' | 'login'

/**
 * Owns browser lifetime, task serialization, AND the resource budget for the browsers Stream
 * itself launches — the single authority for their naming and memory. The Recipe runner
 * receives a lease and never decides whether the underlying tab closes.
 *
 * Keyed by (facility, lane): one facility can hold several tabs — a 'feed' lane and a
 * 'search' lane, say — that SHARE ONE logged-in context (the launcher is resolved by
 * `facility` alone, so every lane reuses the pooled context) yet run in PARALLEL, each on
 * its own task tail. A single-lane facility (the default) behaves exactly as before.
 *
 * Admission (per-facility maxLanes = risk gate; global maxLanes = tab-sprawl gate) evicts idle
 * lanes to make room; it never touches a lane with an in-flight lease and never blocks, so a
 * live harvest is never starved — the target is idle lanes piling up.
 */
export class RecipeSessionManager {
  private readonly persistent = new Map<string, PersistentEntry>()
  private readonly creating = new Map<string, Promise<PersistentEntry>>()

  private readonly maxLanesPerFacility: number
  private readonly maxLanesGlobal: number
  private readonly graceMs: number
  private readonly now: () => number
  private readonly keepAliveStore?: KeepAliveStore
  /** keepAlive lane → 它骑着的 tabId（跨进程：启动时从 store 读回，骑回去之前也算「后端认领」） */
  private readonly pinned = new Map<string, number>()

  constructor(
    // The ONE transport seam (CP1): the manager takes a whole Transport — launcher to open the
    // tab AND the primitives look/act/shot ride (evaluate / driverFactory / screenshot) — from a
    // single object, the same seam the executor reads (session-recipe-executor). Everything
    // browser-specific lives there, not here.
    private readonly resolveTransport: (spec: RecipeSessionSpec) => Transport,
    budget: SessionBudget = {},
  ) {
    this.maxLanesPerFacility = budget.maxLanesPerFacility ?? 4
    this.maxLanesGlobal = budget.maxLanesGlobal ?? 8
    this.graceMs = budget.graceMs ?? 250
    this.now = budget.now ?? Date.now
    this.keepAliveStore = budget.keepAliveStore
    try {
      for (const [k, id] of Object.entries(this.keepAliveStore?.load() ?? {})) if (typeof id === 'number') this.pinned.set(k, id)
    } catch {
      /* 读坏了就当没有：最坏多开一张标签 */
    }
  }

  private pin(k: string, tabId: number | undefined): void {
    if (tabId == null) this.pinned.delete(k)
    else this.pinned.set(k, tabId)
    try {
      this.keepAliveStore?.save(Object.fromEntries(this.pinned))
    } catch {
      /* 写不进就只在本进程内常驻 */
    }
  }

  /** 常驻 lane 的标签——含上一个进程留下、这个进程还没骑回去的。扩展对账时它们算「后端认领」，不收。 */
  pinnedTabIds(): number[] {
    return [...this.pinned.values()]
  }

  /**
   * 探活自带的死线。**不能吃中继的默认超时（30s）**——那比搜索给每个成员的上限（25s）还长，
   * 于是一条陈旧 lane 会把整个成员的预算烧光，用户拿到的是
   * `member "<成员名>" timed out after 25000ms`，而真正发生的事只是"上次那个标签没了"。
   *
   * 2026-07-29 活体：用户一次搜索里 xhs 和 douyin **同时**报 25s 超时——两条 lane 都是上一个
   * 后端进程留下的孤儿记录（lane 映射只在进程内存里，重启即孤儿）。看起来像"两个源都坏了"，
   * 其实是同一件事发生了两次。下一次搜索就正常，因为第一次已经把死记录清掉了。
   *
   * 2s 是宽给到离谱的：今晚实测一次裸中继往返 10ms。活着的标签答得起，答不起的就是死的。
   */
  private static readonly LIVENESS_PROBE_MS = 2_000

  /** composite key: lanes of one facility share a context but are tracked independently. */
  private key(facility: string, laneKey: string): string {
    return `${facility}\0${laneKey}`
  }

  /**
   * 这条 lane 的标签页还在浏览器里吗？
   *
   * 用 `transport.url()` 探，因为它读的是**浏览器进程自己的记录**（导航历史），标签不在了就抛；
   * 而且它本来就是最便宜的只读原语之一。不用页内 `evaluate`：那要页面有个活着的执行上下文，
   * 正在导航或刚崩过的标签会给出假阴性。
   *
   * 探不通一律当"没了"。这个方向是刻意的：误判成没了 = 多开一个标签（便宜、可见、可恢复）；
   * 误判成还在 = 把死记录递出去，后续每个 CDP 命令都失败且**永不自愈**。
   */
  private async isLaneAlive(entry: PersistentEntry): Promise<boolean> {
    try {
      await Promise.race([
        entry.transport.url(entry.rawPage),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('lane liveness probe timed out')), RecipeSessionManager.LIVENESS_PROBE_MS).unref?.(),
        ),
      ])
      return true
    } catch {
      return false
    }
  }

  /** The tabs in the session tab group for this spec's transport ([] when it cannot adopt). */
  async listTabs(spec: RecipeSessionSpec): Promise<GroupTab[]> {
    const launcher = this.resolveTransport(spec).launcher
    return launcher.listTabs ? launcher.listTabs() : []
  }

  /**
   * Ride a tab the user already has open in the session tab group.
   *
   * Deliberately NOT a lane: lanes are keyed by facility and shared by every recipe of that
   * facility — registering the user's tab as the `doubao` lane would let the next doubao-image
   * run `goto` a fresh chat on top of the conversation the user is working in. A ride is its own
   * lease, unqueued, and releasing it hands the tab back untouched: `markBlocked` never closes it
   * (a wall on the user's own page is theirs to deal with, not ours to reap).
   */
  async adopt(spec: RecipeSessionSpec, tabId: number): Promise<RecipeSessionLease> {
    const launcher = this.resolveTransport(spec).launcher
    if (!launcher.adopt) throw new Error(`facility "${spec.facility}": this transport cannot ride an existing tab`)
    const ridden = await launcher.adopt(tabId)
    let released = false
    return {
      facility: spec.facility,
      page: ridden.page,
      rawPage: ridden.rawPage,
      visibility: spec.visibility,
      adopted: true,
      markBlocked: () => {},
      release: async () => {
        if (released) return
        released = true
        await ridden.close()
      },
    }
  }

  async acquire(
    spec: RecipeSessionSpec,
    entryUrl: string,
    waitUntil: 'commit' | 'domcontentloaded' | 'load' | 'networkidle' = 'domcontentloaded',
    purpose: LeasePurpose = 'harvest',
  ): Promise<RecipeSessionLease> {
    // unattended → 后台标签（采集，不打扰）。interactive → 开在用户当前窗口里的可见标签，
    // 因为这一档的前提就是他要在上面动手（登录、扫码、自助建 key）。
    //
    // **这是标签开在哪，不是抢不抢焦点**——executor 那层一次都不抢（见 SessionRecipeExecutor）。
    //
    // 这里曾经写着「后台档的 recipe **不能**用 CDP Input：Chrome 只在聚焦的前台窗口处理可信输入，
    // 它的 scroll/click 会挂到 relay 超时，所以后台只能 render-independent 地采」。
    // **那句话是错的**（2026-07-28 活体推翻，见
    // `docs/superpowers/specs/2026-07-28-xhs-harvest-on-user-chrome-design.md`）：hidden 的 tab
    // 不拒绝可信输入，只是压着等合成器产帧；点击/滚动由 focus 仿真接住，而懒加载实测也不需要
    // 我们替它产帧——driver 一帧都不逼（见 `browser-ext-drive.ts` 的 `sleep`）。窗口有没有 OS 焦点
    // 从来不是可信输入的闸门——focus 仿真那个谎就够了（见 `browser-ext.ts` 的注释）。
    // **但要真帧的命令（截图/settle）另算**：那一格由 OS 那层"窗口显不显示"说了算，仿真救不了。
    const interactive = spec.visibility === 'interactive'
    // resolved by facility only — every lane of a facility reuses the pooled login context.
    const transport = this.resolveTransport(spec)
    const launcher = transport.launcher
    if (spec.lifecycle === 'one-shot') {
      const launched = await launcher.launch(entryUrl, waitUntil, { interactive })
      let released = false
      return {
        facility: spec.facility,
        page: launched.page,
        rawPage: launched.rawPage,
        visibility: spec.visibility,
        markBlocked: () => {}, // a one-shot tab closes on release regardless
        release: async () => {
          if (released) return
          released = true
          await launched.close()
        },
      }
    }

    const laneKey = spec.laneKey ?? DEFAULT_LANE
    const k = this.key(spec.facility, laneKey)

    let entry = this.persistent.get(k)
    // 这个 tab 还在吗？**它是用户的浏览器，用户随时可以把标签关掉**，而关掉这件事没有任何东西
    // 会通知我们——map 里的记录就此成了孤儿。不探活的后果不是"这次失败"，是**永远失败**：
    // 复用分支只看 map 里有没有记录，于是这条死记录会被一次次递出去，用户换个关键词重搜还是
    // 撞它（活体 2026-07-28 的症状）。单次失败合理（账本没了），永久失败不合理。
    //
    // 只在**空闲**的 lane 上探：正在被别人用着的 lane（leaseCount>0）显然活着，多打一次
    // 往返纯属浪费；而且此刻去动它有可能打断人家跑到一半的 recipe。
    if (entry && entry.leaseCount === 0 && !(await this.isLaneAlive(entry))) {
      this.persistent.delete(k)
      if (entry.keepAlive) this.pin(k, undefined)
      entry = undefined
    }
    if (!entry) {
      let creation = this.creating.get(k)
      if (!creation) {
        // Register the creation promise SYNCHRONOUSLY (before any await) so a racing acquire for
        // the same lane joins it instead of launching a second tab. Making room (evicting idle
        // lanes to stay under budget) happens INSIDE the promise, before the launch.
        creation = (async () => {
          await this.reapForRoom(spec.facility)
          const keepAlive = spec.keepAlive === true
          // 常驻 lane:上一个进程留下的那张标签还在就原地骑回去——不开新的、不导航(rideCurrentPage
          // 的 recipe 就接着用里面的东西)。骑不上 / 探活不过 = 那张没了,忘掉它、照常开新的。
          let launched: { page: ReplayPage; rawPage?: unknown; close: () => Promise<void> } | undefined
          const pinnedTab = keepAlive ? this.pinned.get(k) : undefined
          if (pinnedTab != null && launcher.adopt) {
            try {
              const ridden = await launcher.adopt(pinnedTab)
              const probe = { transport, rawPage: ridden.rawPage } as PersistentEntry
              if (await this.isLaneAlive(probe)) launched = ridden
            } catch {
              /* 组里没有它了 */
            }
            if (!launched) this.pin(k, undefined)
          }
          launched ??= await launcher.launch(entryUrl, waitUntil, { interactive })
          if (keepAlive) this.pin(k, laneTabId(launched.rawPage))
          const made: PersistentEntry = {
            facility: spec.facility,
            laneKey,
            page: launched.page,
            rawPage: launched.rawPage,
            transport,
            close: launched.close,
            tail: Promise.resolve(),
            releaseTail: null,
            status: 'idle',
            leaseCount: 0,
            holder: null,
            lastUsedAt: this.now(),
            keepAlive,
          }
          this.persistent.set(k, made)
          return made
        })().finally(() => {
          this.creating.delete(k)
        })
        this.creating.set(k, creation)
      }
      entry = await creation
    }

    // 登录流程占着就当场退，**在排队之前**：它会占到用户扫完（分钟级），而排队的尽头
    // 一定是成员超时，还会把"你需要登录"这个可操作的信息盖成一句"超时"。
    if (purpose === 'harvest' && entry.holder === 'login') throw new LaneBusyForLoginError(spec.facility)
    // Claim synchronously: leaseCount>0 makes this lane non-evictable for the whole acquire,
    // covering the window between obtaining the entry and marking it leased below.
    entry.leaseCount++
    entry.lastUsedAt = this.now()

    const previous = entry.tail
    let unlock!: () => void
    entry.tail = new Promise<void>((resolve) => { unlock = resolve })
    await previous
    entry.releaseTail = unlock
    entry.status = 'leased'
    entry.holder = purpose
    let released = false

    return {
      facility: spec.facility,
      page: entry.page,
      rawPage: entry.rawPage,
      visibility: spec.visibility,
      markBlocked: (reason) => {
        entry!.status = 'blocked'
        entry!.reason = reason
      },
      release: async () => {
        if (released) return
        released = true
        entry!.leaseCount = Math.max(0, entry!.leaseCount - 1)
        entry!.lastUsedAt = this.now()
        entry!.holder = null
        const wasBlocked = entry!.status === 'blocked'
        if (!wasBlocked) entry!.status = 'idle'
        const releaseTail = entry!.releaseTail
        entry!.releaseTail = null
        // 常驻 lane 撞墙也不关：关了下一轮就是一次整页重载，而标签里可能有用户的东西。
        // 页面真死了由 recipe 自己在下一轮认出来（或用户刷新那张标签）。
        if (wasBlocked && entry!.keepAlive) entry!.status = 'idle'
        else if (wasBlocked) {
          this.persistent.delete(k)
          await entry!.close()
        }
        releaseTail?.()
      },
    }
  }

  /**
   * Look at a live persistent tab — the SAME tab the recipes ride — without launching anything.
   *
   * This exists because debugging a harvest any other way means guessing: the alternative is
   * edit → restart → re-run → read whatever numbers you happened to log, and you never actually
   * SEE the page. Opening the same URL yourself is not the same page: harvesting rides a tab in
   * the user's own Chrome, mid-run, with that run's scroll position, ledger and login state. The
   * tab you want to see is this one, so here is the only place to look from.
   *
   * `expression` is evaluated in-page and flattened to JSON *inside* the page — an SPA store is a
   * reactive Proxy that V8's serializer hands back as `{}`, so a raw read looks empty when the data
   * is right there (same reason readStateExpr stringifies in-page). Queued behind the lane's task
   * tail, so a look can never interleave with a running recipe. Read-only by intent.
   *
   * Returns `null` for "this lane has no live tab" and `{ value }` for a result — wrapped so
   * that an expression which legitimately evaluates to null isn't mistaken for a missing tab.
   */
  /**
   * 「这个 facility 现在登录着吗」——**只在已有 lane 上问，绝不为此开标签**。
   *
   * 这是登录横幅对账的最准一档证据：判据跑在用户那个真页面上，页面上有没有登录墙它说了算。
   * 没有 lane 就返回 undefined（不是 UNKNOWN）——两者对调用方是不同的信息：「没标签可问」
   * 该退到 cookie 证据，「问了但看不出来」是页面本身给不出结论。
   *
   * 开标签的代价（一次导航 + 渲染 + 一次落到站点上的访问）远超"撤一个横幅"值的钱，而且会
   * 绕过频率闸门去打站点——对账是后台行为，不该给用户的账号增加任何足迹。
   */
  async loginStateOf(
    facility: string,
    check: LoginCheck,
    laneKey: string = DEFAULT_LANE,
  ): Promise<LoginState | undefined> {
    const entry = this.persistent.get(this.key(facility, laneKey))
    if (!entry || !(await this.isLaneAlive(entry))) return undefined
    const r = await this.onTail(facility, laneKey, async (e) =>
      detectLoginState(e.transport.driverFactory(e.rawPage), check),
    )
    return r ?? undefined
  }

  /**
   * 把这个 facility 的标签**放到用户面前**，让他自己在浏览器里把登录做完。
   *
   * 这是"平台又加了一步我们渲染不了的验证"时唯一的明路：Stream 不去理解那一步是什么
   * （滑块、短信、二次扫码、设备确认——追它们等于追平台的实现），只把用户送到能做那件事
   * 的地方。判定继续由采集侧的 loginCheck / 对账器负责，我们不需要知道他中间做了什么。
   *
   * **抢屏在这里是正当的**：它由用户点击触发，而且他点的就是"去浏览器里弄"。这正是
   * "前台只留给用户发起的动作"那条边界的正面用例。
   *
   * **不排队（不走 onTail）**：调用它的时候，这条 lane 大概率正被登录流程占着（它会占到
   * 用户扫完，分钟级）。排队等于这个按钮点了没反应。把标签提到前面不改页面状态、不与
   * 正在跑的动作抢资源，所以插队是安全的。
   *
   * 没有 lane（还没开过标签）→ false，调用方据此告诉用户"先点重新登录"。
   */
  async focusFacilityTab(facility: string, laneKey: string = DEFAULT_LANE): Promise<boolean> {
    const entry = this.persistent.get(this.key(facility, laneKey))
    if (!entry?.transport.bringToFront) return false
    try {
      await entry.transport.bringToFront(entry.rawPage)
      return true
    } catch {
      return false // 标签没了/中继抽风 —— 是"没做到"，不是错误
    }
  }

  async look(facility: string, expression: string, laneKey: string = DEFAULT_LANE): Promise<{ value: unknown } | null> {
    return this.onTail(facility, laneKey, async (entry) => ({
      // Ride the session's Transport, not Playwright semantics — on ext-cdp `page.evaluate` only
      // takes a function and would TypeError on this string. The in-page JSON-flatten wrapper stays
      // here (transport-agnostic): an SPA store is a reactive Proxy V8 hands back as `{}`.
      value: await entry.transport.evaluate(
        entry.rawPage,
        `(()=>{try{const v=(${expression});return JSON.parse(JSON.stringify(v===undefined?null:v))}` +
          `catch(e){return{__error:String(e)}}})()`,
      ),
    }))
  }

  /** A JPEG of the live tab, base64 — "what does the page actually look like right now". */
  async shot(facility: string, laneKey: string = DEFAULT_LANE): Promise<string | null> {
    return this.onTail(facility, laneKey, async (entry) => {
      // Transport owns the capture (ext-cdp has no `page.screenshot`); null = unsupported / no frame.
      const buf = await entry.transport.screenshot(entry.rawPage)
      return buf ? buf.toString('base64') : null
    })
  }

  /**
   * Do something ON the live tab — the mirror of `look`, and the same shape `cdp_act` has on
   * the user's own Chrome: same gate (interactive-gate), same landing logic (run-action), only
   * the address differs (facility + lane here, tabId there).
   *
   * Why a harvest tab needs a gate at all: it is Stream's browser, but it carries the user's real
   * login for that facility. A submit here posts as them. "It's our own browser" bounds the blast
   * radius to one facility; it does not make the action safe.
   *
   * The domain re-check is not TOCTOU caution — **the gate's correctness rests on it**. `classify`
   * decides "is this goto cross-site?" by comparing the target against the caller-supplied
   * `action.domain`; a caller that names the wrong domain gets a cross-site goto waved through as
   * same-site. ext-cdp closes that with the extension's `chrome.tabs.get` check; with no extension
   * here, `Transport.url` (a browser-process record, not a page-world read) is what closes it.
   * Read-only actions skip it: reading a page that has navigated away just returns something
   * useless — it cannot land an action on a site you did not mean.
   *
   * `null` = this lane has no live tab, same as look/shot (a missing tab is not an error).
   */
  async act(
    facility: string,
    action: ActionSpec,
    opts?: { laneKey?: string; mode?: LaneMode; confirmed?: boolean },
  ): Promise<ActResult | null> {
    const cls = classifyAction(action)
    // Gate BEFORE the tail: a refused action should not queue behind a running recipe or pin the
    // lane against eviction — nothing is going to touch the page.
    if (!opts?.confirmed && needsConfirmation(action, opts?.mode)) {
      return { status: 'needs-confirmation', reason: cls.reason }
    }
    return this.onTail(facility, opts?.laneKey ?? DEFAULT_LANE, async (entry) => {
      if (!cls.readOnly) {
        const actual = hostOf(await entry.transport.url(entry.rawPage))
        if (actual !== action.domain) {
          throw new Error(
            `refuse to act on ${facility}: domain changed（域名不匹配）— expected ${action.domain}, tab is now on ${actual || '<unknown>'}`,
          )
        }
      }
      return actWithConfirm(entry.transport.driverFactory(entry.rawPage), action)
    })
  }

  /** run `fn` against a lane's live entry, serialized behind its task tail (null if no tab) */
  private async onTail<T>(facility: string, laneKey: string, fn: (entry: PersistentEntry) => Promise<T>): Promise<T | null> {
    const entry = this.persistent.get(this.key(facility, laneKey))
    if (!entry) return null
    entry.leaseCount++ // a look/act/shot must pin the lane against eviction while it runs
    const previous = entry.tail
    let unlock!: () => void
    entry.tail = new Promise<void>((resolve) => { unlock = resolve })
    await previous
    try {
      return await fn(entry)
    } finally {
      entry.leaseCount = Math.max(0, entry.leaseCount - 1)
      entry.lastUsedAt = this.now()
      unlock()
    }
  }

  state(facility: string, laneKey: string = DEFAULT_LANE): RecipeSessionState | null {
    const entry = this.persistent.get(this.key(facility, laneKey))
    if (!entry) return null
    return {
      facility,
      laneKey,
      status: entry.status,
      ...(entry.reason == null ? {} : { reason: entry.reason }),
    }
  }

  /** Every live lane — the registry is the single source of truth for what tabs exist. */
  lanes(): RecipeSessionState[] {
    return [...this.persistent.values()].map((e) => ({
      facility: e.facility,
      laneKey: e.laneKey,
      status: e.status,
      ...(e.reason == null ? {} : { reason: e.reason }),
      ...(laneTabId(e.rawPage) == null ? {} : { tabId: laneTabId(e.rawPage) }),
    }))
  }

  /**
   * 关掉闲置超过 `maxIdleMs` 的 lane，返回被关掉的 `facility/lane` 列表。
   *
   * **为什么需要它**：一条持久 lane 的正常收尾是使用者显式收的（前端离开频道 →
   * `POST /api/facilities/:id/close`）。但那条路只覆盖正常切换——**用户直接关掉浏览器标签、
   * Chrome 崩掉、或者人就这么走了，收尾回调根本不会跑**，于是 lane 挂在注册表里、标签一直开着。
   *
   * 在此之前唯一会关 lane 的是 `reapForRoom`，而它只在**新建 lane 且超预算**时才触发——
   * 一个孤儿 lane 可以就这么过夜。`browse-session` 里那个 300s 也不是回收器：它只在下一次
   * `loadMore` 时顺手判账本新不新，不关任何标签。所以这里补的是真正缺的那一环。
   *
   * 只碰 `leaseCount === 0` 的 lane——有人正在用就绝不动它，和 `lruEvictable` 同一条底线。
   *
   * **绝不会关到用户自己的标签**，两层保证、互相独立：(1) 这里只动 *lane*，而 lane 只因为
   * Stream 自己 `launch()` 建了标签才存在——用户的标签是按 tabId 临时寻址的（interactive-lane），
   * 从不进这张注册表；(2) 即便后端弄错了，扩展侧 `releaseTab` 也按出身分流，用户拖进来的标签
   * 只 `ungroup`（放掉控制），永远不 `chrome.tabs.remove`。别在这里加"顺手关标签"的逻辑。
   */
  async reapIdle(maxIdleMs: number): Promise<string[]> {
    const now = this.now()
    const victims = [...this.persistent.entries()]
      .filter(([, e]) => e.leaseCount === 0 && !e.keepAlive && now - e.lastUsedAt > maxIdleMs)
      .map(([k, e]) => ({ k, label: `${e.facility}/${e.laneKey}` }))
    for (const v of victims) await this.closeEntry(v.k)
    return victims.map((v) => v.label)
  }

  /** Close a single lane of a facility. */
  async closeLane(facility: string, laneKey: string = DEFAULT_LANE): Promise<void> {
    await this.closeEntry(this.key(facility, laneKey))
  }

  /** Close every lane of a facility (the whole facility's browser footprint). */
  async closeFacility(facility: string): Promise<void> {
    const prefix = `${facility}\0`
    await Promise.all([...this.persistent.keys()].filter((k) => k.startsWith(prefix)).map((k) => this.closeEntry(k)))
  }

  /** 关停：把采集标签还给用户。**常驻 lane 不关**——只从内存放掉，tabId 留在 store 里，下个进程骑回去
   *  （关掉它 = 删掉用户在里面的东西，再加一次整页重载）。显式的 closeLane / closeFacility 照关。 */
  async closeAll(): Promise<void> {
    await Promise.all([...this.persistent.entries()].map(async ([k, e]) => {
      if (!e.keepAlive) return this.closeEntry(k)
      await e.tail
      if (this.persistent.get(k) === e) this.persistent.delete(k)
    }))
  }

  /** Evict idle lanes (LRU) while adding one more lane for `facility` would exceed a ceiling.
   *  Only touches lanes with no in-flight lease; if none are evictable it returns and the new
   *  lane is admitted anyway (never deadlock a harvest under genuine concurrent load). */
  private async reapForRoom(facility: string): Promise<void> {
    for (;;) {
      if (!this.overBudget(facility)) return
      const victim = this.lruEvictable()
      if (!victim) return
      await this.closeEntry(victim)
    }
  }

  private overBudget(facility: string): boolean {
    const prefix = `${facility}\0`
    let facCount = 0
    for (const k of this.persistent.keys()) if (k.startsWith(prefix)) facCount++
    if (facCount >= this.maxLanesPerFacility) return true
    if (this.persistent.size >= this.maxLanesGlobal) return true
    return false
  }

  /** The least-recently-used lane with no in-flight lease and past the grace window, or null. */
  private lruEvictable(): string | null {
    const now = this.now()
    let bestKey: string | null = null
    let bestAt = Infinity
    for (const [k, e] of this.persistent) {
      if (e.leaseCount !== 0 || e.keepAlive) continue
      if (now - e.lastUsedAt <= this.graceMs) continue
      if (e.lastUsedAt < bestAt) { bestAt = e.lastUsedAt; bestKey = k }
    }
    return bestKey
  }

  private async closeEntry(k: string): Promise<void> {
    const entry = this.persistent.get(k)
    if (!entry) return
    await entry.tail
    if (this.persistent.get(k) !== entry) return
    this.persistent.delete(k)
    if (entry.keepAlive) this.pin(k, undefined)
    await entry.close()
  }
}
