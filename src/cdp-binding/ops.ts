/**
 * 把扩展中继的那套命令，落到一台**没有装扩展**的 Chromium 上。
 *
 * 对照基准是 `extension/src/lib/driver.ts` 的 `dispatchInner`：输入输出与边界行为对齐它，
 * 实现手段按 CDP 自己的形状来（**不是逐行翻译**）。
 *
 * 两处 CDP 没有对应物、必须自己表达语义：
 *
 * - **标签组 → 认领集合。** 扩展里「AI 可操作范围」是浏览器里那个可见的 Stream 标签组；
 *   CDP 没有标签组。这里换成一张进程内的认领表：`newTab` / `openTab` 建出来的标签、
 *   以及认领标签自己 `window.open` 出来的标签（`Target.targetCreated` 的 `openerId`，页面
 *   伪造不了）才算「在组内」。组外的一律拒——与扩展同一条红线。
 * - **tabId。** 中继协议里的 tabId 是数字，CDP 的 targetId 是字符串。这里发一套自己的数字，
 *   进程内稳定（同一个 target 永远是同一个数）。绑定重启后数字会变——服务端那边的 lane
 *   本来就是按这一轮的执行重新建的。
 *
 * 日志只记命令名，不记参数与返回（`Input.insertText` 的值、cookie 值都不许进日志）。
 */
import type { CdpConnection, CdpEvent } from './cdp-connection.ts'

export type TabOrigin = 'created' | 'probe' | 'adopted'

export interface FrameSession {
  sessionId: string
  targetId: string
  url: string
  parentSessionId?: string
}

export interface GroupTab {
  tabId: number
  url: string
  title: string
  origin: TabOrigin
  grouped: boolean
  active: boolean
  openerTabId?: number
  popup?: boolean
}

export type CdpBindingInbound =
  | { id: number; tabId: number; method: string; params?: unknown; expectDomain?: string; sessionId?: string }
  | { id: number; op: 'frames'; tabId: number }
  | { id: number; op: 'newTab'; url: string; waitUntil?: string; background?: boolean }
  | { id: number; op: 'closeTab'; tabId: number }
  | { id: number; op: 'openTab'; url: string }
  | { id: number; op: 'subscribe'; tabId: number; domains: string[] }
  | { id: number; op: 'unsubscribe'; subscriptionId: number }
  | { id: number; op: 'list' }
  | { id: number; op: 'cookieNames'; domain: string }
  | { id: number; op: 'cookiePull'; domains: string[] }
  | { id: number; op: 'activeTab' }
  | { id: number; op: 'activateTab'; tabId: number }
  | { id: number; op: 'holdProfile' }
  | { id: number; op: 'releaseProfile' }

export interface RelayReply {
  id: number
  result?: unknown
  error?: string
  /** 这一侧处理这条命令花了多久（后端用它减出 WS 那两段；跨侧减法一律不做）。 */
  swMs: number
}

interface TargetInfo {
  targetId: string
  type: string
  title: string
  url: string
  openerId?: string
}

/** 要合成器真的产出一帧才回执的命令（同扩展的 NEEDS_REAL_FRAME）。 */
const NEEDS_REAL_FRAME = new Set(['Page.captureScreenshot'])
/** 发了就算、不等回执（同扩展的 FIRE_AND_FORGET；理由见那边的头注）。 */
const FIRE_AND_FORGET = new Set(['Input.dispatchMouseEvent'])
/** 与扩展同一个数（`SCREENSHOT_BUDGET_MS`）：正常一帧 286–392ms，1.5s 是约 4 倍。 */
export const SCREENSHOT_BUDGET_MS = 1_500
/** 慢命令门槛：与中继两侧同一个数（5s），两侧的记账才配得起对。 */
export const SLOW_COMMAND_MS = 5_000
const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: 'iframe', exclude: false }],
}

export interface CdpRelayOpsOptions {
  /** 只写命令名与生命周期，绝不写参数 / 返回。 */
  log?: (line: string) => void
  sleep?: (ms: number) => Promise<void>
}

export class CdpRelayOps {
  private nextTabId = 1
  private nextSubscriptionId = 1
  private readonly tabByTarget = new Map<string, number>()
  private readonly targetByTab = new Map<number, string>()
  private readonly claimed = new Map<number, TabOrigin>()
  private readonly pageSession = new Map<number, string>()
  private readonly tabBySession = new Map<string, number>()
  private readonly childSessions = new Map<number, Map<string, FrameSession>>()
  private readonly autoAttached = new Set<number>()
  private readonly subscriptions = new Map<number, { tabId: number; domains: Set<string> }>()
  private active: number | null = null
  private holding = false
  private readonly outbound = new Set<(msg: unknown) => void>()
  private readonly offEvent: () => void
  private readonly sleep: (ms: number) => Promise<void>
  private readonly log: (line: string) => void

  constructor(
    private readonly cdp: CdpConnection,
    opts: CdpRelayOpsOptions = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.log = opts.log ?? (() => {})
    this.offEvent = cdp.onEvent((e) => this.onCdpEvent(e))
    // 浏览器级目标事件：认领标签自己开出来的标签、以及用户/脚本关掉的标签。
    void cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {})
  }

  /** 主动往服务端发的帧（`cdp-event` / `tab-opened`）。绑定把这接到 WS 上。 */
  onMessage(fn: (msg: unknown) => void): () => void {
    this.outbound.add(fn)
    return () => this.outbound.delete(fn)
  }

  dispose(): void {
    this.offEvent()
    this.outbound.clear()
    this.claimed.clear()
    this.subscriptions.clear()
    this.pageSession.clear()
    this.tabBySession.clear()
    this.childSessions.clear()
    this.autoAttached.clear()
    this.tabByTarget.clear()
    this.targetByTab.clear()
    this.active = null
  }

  /** 认领集合此刻的样子（诊断 / 测试）。 */
  get claimedTabs(): Array<{ tabId: number; origin: TabOrigin }> {
    return [...this.claimed].map(([tabId, origin]) => ({ tabId, origin }))
  }

  /** 处理一条中继命令。不是命令（没有数字 id / 没有 op 也没有 method）→ `null`（不回执）。 */
  async dispatch(raw: unknown): Promise<RelayReply | null> {
    const msg = raw as { id?: unknown; op?: unknown; method?: unknown } | null
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'number') return null
    if (typeof msg.op !== 'string' && typeof msg.method !== 'string') return null
    const label = typeof msg.op === 'string' ? msg.op : String(msg.method)
    const started = Date.now()
    try {
      const result = await this.dispatchInner(msg as CdpBindingInbound)
      return { id: msg.id, result, swMs: Date.now() - started }
    } catch (e) {
      const elapsed = Date.now() - started
      const error = String(e instanceof Error ? e.message : e)
      // 只记命令名与耗时；错误文本来自 CDP / 我们自己的判据，不含参数。
      if (elapsed >= SLOW_COMMAND_MS) this.log(`[cdp-binding] ${label} 失败（${elapsed}ms）：${error}`)
      return { id: msg.id, error, swMs: elapsed }
    } finally {
      const elapsed = Date.now() - started
      if (elapsed >= SLOW_COMMAND_MS) this.log(`[cdp-binding] 慢命令 ${label}（${elapsed}ms）`)
    }
  }

  private async dispatchInner(msg: CdpBindingInbound): Promise<unknown> {
    if ('op' in msg) {
      switch (msg.op) {
        case 'newTab': {
          const { targetId } = await this.cdp.send('Target.createTarget', {
            url: msg.url,
            background: msg.background === true,
          })
          const tabId = this.claim(targetId, msg.background === true ? 'probe' : 'created')
          if (msg.background !== true) this.active = tabId
          await this.attach(tabId)
          await this.waitForNav(tabId, msg.waitUntil, msg.url)
          return { tabId }
        }
        case 'openTab': {
          // find-or-open：先在所有页面里找同一个 URL，找到就切过去（created:false），
          // 那是用户自己的标签，**不认领**——与扩展同一条分界（拖入 = 授权，我们不替他做）。
          const all = await this.pageTargets()
          const hit = [...all.values()].find((t) => sameUrl(t.url, msg.url))
          if (hit) {
            const tabId = this.tabIdOf(hit.targetId)
            await this.cdp.send('Target.activateTarget', { targetId: hit.targetId }).catch(() => {})
            this.active = tabId
            return this.openReceipt(tabId, hit.targetId, false)
          }
          const { targetId } = await this.cdp.send('Target.createTarget', { url: msg.url, background: false })
          const tabId = this.claim(targetId, 'created')
          await this.cdp.send('Target.activateTarget', { targetId }).catch(() => {})
          this.active = tabId
          return this.openReceipt(tabId, targetId, true)
        }
        case 'closeTab': {
          if (!this.claimed.has(msg.tabId)) throw new Error(`refuse to close tab ${msg.tabId}: not in the session tab group`)
          await this.closeClaimed(msg.tabId)
          return {}
        }
        case 'list': {
          const targets = await this.pageTargets()
          const tabs: GroupTab[] = []
          for (const [tabId, origin] of this.claimed) {
            const targetId = this.targetByTab.get(tabId)
            const info = targetId ? targets.get(targetId) : undefined
            if (!info) continue // 标签已经不在（用户关了）——跳过，不整条失败
            const opener = info.openerId ? this.tabByTarget.get(info.openerId) : undefined
            tabs.push({
              tabId,
              url: info.url,
              title: info.title,
              origin,
              grouped: true, // 认领集合里的都算「在组内」（CDP 没有真的组）
              active: tabId === this.active,
              ...(opener !== undefined ? { openerTabId: opener } : {}),
            })
          }
          return { tabs }
        }
        case 'holdProfile': {
          this.holding = true
          return {}
        }
        case 'releaseProfile': {
          this.holding = false
          let closedTabs = 0
          for (const tabId of [...this.claimed.keys()]) {
            try {
              await this.closeClaimed(tabId)
              closedTabs++
            } catch {
              /* 一张关不掉不挡其余 */
            }
          }
          // CDP 这一侧没有「profile 会不会卸载」这回事：浏览器是一个长期进程，绑定只管标签。
          return { closedTabs, userWindows: 0, unloading: false }
        }
        case 'activeTab': {
          return { tabId: this.active }
        }
        case 'activateTab': {
          // 礼貌闸门同扩展：只有当前 active 标签还是我们认领的（= 焦点确实是采集抢来的），才还。
          if (this.active == null || !this.claimed.has(this.active)) return { restored: false }
          const targetId = this.targetByTab.get(msg.tabId)
          if (!targetId) return { restored: false }
          try {
            await this.cdp.send('Target.activateTarget', { targetId })
            this.active = msg.tabId
            return { restored: true }
          } catch {
            return { restored: false }
          }
        }
        case 'cookieNames': {
          const all = await this.cookies()
          return { names: all.filter((c) => domainMatches(c.domain, msg.domain)).map((c) => c.name) }
        }
        case 'cookiePull': {
          const all = await this.cookies()
          const wanted = [...new Set(msg.domains ?? [])]
          const cookies: Record<string, Array<Record<string, unknown>>> = {}
          for (const domain of wanted) {
            const hit = all.filter((c) => domainMatches(c.domain, domain))
            if (hit.length) cookies[domain] = hit.map(serializeCookie)
          }
          // 扩展在这里按它申报过的同步域拒答范围外的域。CDP 绑定没有「申报范围」这一层：
          // 它就是这台机器上唯一的浏览器，配对的 token 已经允许驱动它（见 openspec 的边界说明）。
          return { cookies, refused: [] }
        }
        case 'subscribe': {
          if (!this.claimed.has(msg.tabId)) throw new Error(`refuse to subscribe tab ${msg.tabId}: not in the session tab group`)
          const domains = new Set((msg.domains ?? []).filter((d) => /^[A-Z][A-Za-z]+$/.test(d)))
          if (domains.size === 0) throw new Error('subscribe requires at least one valid CDP domain')
          const sessionId = await this.attach(msg.tabId)
          for (const domain of domains) await this.cdp.send(`${domain}.enable`, {}, sessionId)
          const subscriptionId = this.nextSubscriptionId++
          this.subscriptions.set(subscriptionId, { tabId: msg.tabId, domains })
          return { subscriptionId }
        }
        case 'unsubscribe': {
          const sub = this.subscriptions.get(msg.subscriptionId)
          if (!sub) return {}
          this.subscriptions.delete(msg.subscriptionId)
          const sessionId = this.pageSession.get(sub.tabId)
          if (sessionId) {
            for (const domain of sub.domains) {
              const stillUsed = [...this.subscriptions.values()].some((s) => s.tabId === sub.tabId && s.domains.has(domain))
              if (!stillUsed) await this.cdp.send(`${domain}.disable`, {}, sessionId).catch(() => {})
            }
          }
          return {}
        }
        case 'frames': {
          const fresh = !this.autoAttached.has(msg.tabId)
          await this.attach(msg.tabId)
          // 刚开 auto-attach 的那一刻，已存在的 OOPIF 的 attachedToTarget 事件还在路上——
          // 等一小会儿再答（同扩展的 300ms）。
          if (fresh) await this.sleep(300)
          const sessions = [...(this.childSessions.get(msg.tabId)?.values() ?? [])]
          // 子会话的 attachedToTarget 里 url 常常是空的（会话先建、导航后到）。从目标表补一次：
          // 一个空 url 的 frame 让调用方分不清"这是哪一帧"，而它正是要在 iframe 里动手的那个人。
          if (sessions.some((s) => !s.url)) {
            const r = (await this.cdp.send('Target.getTargets')) as { targetInfos?: TargetInfo[] }
            const byId = new Map((r.targetInfos ?? []).map((t) => [t.targetId, t]))
            for (const s of sessions) {
              const info = byId.get(s.targetId)
              if (info?.url) s.url = info.url
            }
          }
          return { sessions }
        }
      }
    }
    // CDP 命令透传
    const sessionId = await this.attach(msg.tabId)
    if (msg.expectDomain) await this.assertDomain(msg.tabId, msg.expectDomain)
    const target = msg.sessionId
    if (target) {
      const known = this.childSessions.get(msg.tabId)?.has(target)
      if (!known) throw new Error(`session ${target} is not an iframe session of tab ${msg.tabId}（iframe 可能已被移除/导航走——重新列 frame）`)
    }
    return this.sendCdp(msg.method, msg.params as Record<string, unknown> | undefined, target ?? sessionId)
  }

  // ── 标签 / 会话 ────────────────────────────────────────────────────────────────

  private tabIdOf(targetId: string): number {
    let id = this.tabByTarget.get(targetId)
    if (id == null) {
      id = this.nextTabId++
      this.tabByTarget.set(targetId, id)
      this.targetByTab.set(id, targetId)
    }
    return id
  }

  private claim(targetId: string, origin: TabOrigin): number {
    const tabId = this.tabIdOf(targetId)
    this.claimed.set(tabId, origin)
    return tabId
  }

  private async pageTargets(): Promise<Map<string, TargetInfo>> {
    const r = (await this.cdp.send('Target.getTargets')) as { targetInfos?: TargetInfo[] }
    const out = new Map<string, TargetInfo>()
    for (const t of r.targetInfos ?? []) if (t.type === 'page') out.set(t.targetId, t)
    return out
  }

  /** 认领内的标签才 attach（组外一律拒，与扩展同一条红线）。 */
  private async attach(tabId: number): Promise<string> {
    if (!this.claimed.has(tabId)) {
      throw new Error(`refuse to attach tab ${tabId}: not in the session tab group (拖入组即授权)`)
    }
    const existing = this.pageSession.get(tabId)
    if (existing) return existing
    const targetId = this.targetByTab.get(tabId)
    if (!targetId) throw new Error(`refuse to attach tab ${tabId}: target is gone`)
    const r = (await this.cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string }
    this.pageSession.set(tabId, r.sessionId)
    this.tabBySession.set(r.sessionId, tabId)
    // 尽力缓解后台节流（同扩展的 mitigateThrottle）；失败不挡主流程。
    void this.cdp.send('Page.setWebLifecycleState', { state: 'active' }, r.sessionId).catch(() => {})
    await this.ensureAutoAttach(tabId, r.sessionId)
    return r.sessionId
  }

  private async ensureAutoAttach(tabId: number, sessionId: string): Promise<void> {
    if (this.autoAttached.has(tabId)) return
    this.autoAttached.add(tabId)
    await this.cdp.send('Target.setAutoAttach', AUTO_ATTACH, sessionId).catch((e) => {
      this.autoAttached.delete(tabId)
      this.log(`[cdp-binding] Target.setAutoAttach 失败（iframe 子会话不可用）：${String(e instanceof Error ? e.message : e)}`)
    })
  }

  private async detach(tabId: number): Promise<void> {
    const sessionId = this.pageSession.get(tabId)
    this.pageSession.delete(tabId)
    if (sessionId) {
      this.tabBySession.delete(sessionId)
      await this.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {})
    }
    this.autoAttached.delete(tabId)
    this.childSessions.delete(tabId)
  }

  private async closeClaimed(tabId: number): Promise<void> {
    const targetId = this.targetByTab.get(tabId)
    this.clearTabSubscriptions(tabId)
    if (targetId) {
      // `Target.closeTarget` 是调试器层面的关闭：**不弹 beforeunload 确认框**（那是 `Page.close`
      // 与用户手动关标签的行为），所以这里不需要替页面按「离开」。
      await this.cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    }
    await this.detach(tabId)
    this.forget(tabId)
  }

  private forget(tabId: number): void {
    const targetId = this.targetByTab.get(tabId)
    this.claimed.delete(tabId)
    this.clearTabSubscriptions(tabId)
    this.targetByTab.delete(tabId)
    if (targetId) this.tabByTarget.delete(targetId)
    if (this.active === tabId) this.active = null
  }

  private clearTabSubscriptions(tabId: number): void {
    for (const [id, sub] of this.subscriptions) if (sub.tabId === tabId) this.subscriptions.delete(id)
  }

  // ── 等待 / 校验 ────────────────────────────────────────────────────────────────

  private async waitForNav(tabId: number, waitUntil: string | undefined, url: string | undefined): Promise<void> {
    if (url === 'about:blank') return // 目标就是空白页：等"离开 about:blank"必然空转满 30 秒
    const want = waitUntil === 'load' ? ['complete'] : ['interactive', 'complete']
    const sessionId = this.pageSession.get(tabId)
    if (!sessionId) return
    const deadline = Date.now() + 30_000
    let errors = 0
    while (Date.now() < deadline) {
      try {
        // **不能只看 readyState**：`Target.createTarget({url})` 返回时标签里还是初始空文档，
        // 而空文档的 readyState 天生就是 'complete' —— 只看它会在目标页提交前放行，紧接着的
        // 读拿到 about:blank 的 DOM，还把结果当成目标页报上去。判据必须是「已经离开
        // about:blank 且 readyState 到位」（同扩展 driver.ts 的 waitForNav）。
        const r = (await this.cdp.send(
          'Runtime.evaluate',
          { expression: 'JSON.stringify({ rs: document.readyState, href: location.href })', returnByValue: true },
          sessionId,
        )) as { result?: { value?: string } }
        const parsed = JSON.parse(r.result?.value ?? '{}') as { rs?: string; href?: string }
        if (parsed.href && parsed.href !== 'about:blank' && want.includes(parsed.rs ?? '')) return
        errors = 0
      } catch {
        // 导航瞬间的上下文销毁也会抛，属预期；连续 10 次（约 1s）才放弃，让上层命令去失败。
        if (++errors >= 10) return
      }
      await this.sleep(100)
    }
  }

  /** 逐动作域名校验：用浏览器自己记的 URL（`Target.getTargetInfo`），不在页面里求值。 */
  private async assertDomain(tabId: number, expected: string): Promise<void> {
    const targetId = this.targetByTab.get(tabId)
    if (!targetId) throw new Error(`refuse action on tab ${tabId}: target is gone`)
    const r = (await this.cdp.send('Target.getTargetInfo', { targetId })) as { targetInfo?: { url?: string } }
    const url = r.targetInfo?.url ?? ''
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      /* 非法/空 url → host 留空，必然不等于 expected → 拒 */
    }
    if (host !== expected) {
      throw new Error(`refuse action on tab ${tabId}: domain changed（域名不匹配）— expected ${expected}, tab is now on ${host || url || '<unknown>'}`)
    }
  }

  private async openReceipt(tabId: number, targetId: string, created: boolean): Promise<{ tabId: number; title: string; url: string; created: boolean }> {
    const info = async () => {
      const r = (await this.cdp.send('Target.getTargetInfo', { targetId })) as { targetInfo?: { title?: string; url?: string } }
      return { title: r.targetInfo?.title ?? '', url: r.targetInfo?.url ?? '' }
    }
    let now = await info()
    const deadline = Date.now() + 2_000
    while (!now.title && Date.now() < deadline) {
      await this.sleep(50)
      now = await info()
    }
    return { tabId, title: now.title, url: now.url, created }
  }

  private async sendCdp(method: string, params: Record<string, unknown> | undefined, sessionId: string): Promise<unknown> {
    if (FIRE_AND_FORGET.has(method)) {
      void this.cdp.send(method, params, sessionId).catch(() => {})
      return {}
    }
    if (!NEEDS_REAL_FRAME.has(method)) return this.cdp.send(method, params, sessionId)
    try {
      return await withBudget(this.cdp.send(method, params, sessionId), method)
    } catch {
      // 遮挡 / 最小化 / 锁屏时渲染器不产帧；captureBeyondViewport 走另一条捕获路径。
      return withBudget(this.cdp.send(method, { ...params, captureBeyondViewport: true }, sessionId), method)
    }
  }

  private async cookies(): Promise<Array<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; session: boolean; sameSite?: string }>> {
    const r = (await this.cdp.send('Storage.getCookies')) as { cookies?: Array<Record<string, unknown>> }
    return (r.cookies ?? []) as never
  }

  // ── CDP 事件 ──────────────────────────────────────────────────────────────────

  private onCdpEvent(e: CdpEvent): void {
    if (e.method === 'Target.targetDestroyed') {
      const targetId = (e.params as { targetId?: string })?.targetId
      const tabId = targetId ? this.tabByTarget.get(targetId) : undefined
      if (tabId != null) this.forget(tabId)
      return
    }
    if (e.method === 'Target.targetCreated') {
      this.onTargetCreated((e.params as { targetInfo?: TargetInfo })?.targetInfo)
      return
    }
    if (e.method === 'Target.attachedToTarget') {
      this.onAttachedToTarget(e)
      return
    }
    if (e.method === 'Target.detachedFromTarget') {
      const sessionId = (e.params as { sessionId?: string })?.sessionId
      if (!sessionId) return
      // 子会话（OOPIF）走了：从它所属标签的名单里删掉。找不到 = 它本来就不是我们记的
      // （主会话由 `pageSession` 管，不在这里）。
      for (const m of this.childSessions.values()) if (m.delete(sessionId)) break
      return
    }
    // 订阅只转**标签主会话**的事件；iframe 子会话的同名事件混进来会让消费者把别的文档当成这一页。
    if (!e.sessionId) return
    const tabId = this.tabBySession.get(e.sessionId)
    if (tabId == null) return
    if (this.childSessions.get(tabId)?.has(e.sessionId)) return
    const domain = e.method.split('.')[0]
    for (const [subscriptionId, sub] of this.subscriptions) {
      if (sub.tabId !== tabId || !sub.domains.has(domain)) continue
      this.emit({ type: 'cdp-event', subscriptionId, tabId, method: e.method, params: e.params })
    }
  }

  /**
   * 认领标签自己开出来的标签（`window.open` / `target=_blank`）也是我们的——与扩展的
   * `adoptOpenedTab` 同一条语义：`openerId` 由浏览器记，页面伪造不了；只认 created / probe
   * 开启者（用户自己的标签不在认领表里，碰不到）。收下后报一声 `tab-opened`，
   * 点击回执靠它说出「这一下开了新标签」。
   */
  private onTargetCreated(info: TargetInfo | undefined): void {
    if (!info || info.type !== 'page' || !info.openerId) return
    const openerTabId = this.tabByTarget.get(info.openerId)
    if (openerTabId == null) return
    const origin = this.claimed.get(openerTabId)
    if (!origin || origin === 'adopted') return
    const tabId = this.claim(info.targetId, origin)
    this.emit({ type: 'tab-opened', tabId, openerTabId, url: info.url })
  }

  private onAttachedToTarget(e: CdpEvent): void {
    const p = e.params as { sessionId?: string; targetInfo?: { type?: string; targetId?: string; url?: string } } | undefined
    if (!p?.sessionId || p.targetInfo?.type !== 'iframe' || !p.targetInfo.targetId) return
    const parentTab = e.sessionId ? this.tabBySession.get(e.sessionId) : undefined
    if (parentTab == null) return
    let m = this.childSessions.get(parentTab)
    if (!m) this.childSessions.set(parentTab, (m = new Map()))
    m.set(p.sessionId, {
      sessionId: p.sessionId,
      targetId: p.targetInfo.targetId,
      url: p.targetInfo.url ?? '',
      ...(e.sessionId ? { parentSessionId: e.sessionId } : {}),
    })
    // auto-attach 不递归：嵌套的 OOPIF 要在子会话上再开一次。
    void this.cdp.send('Target.setAutoAttach', AUTO_ATTACH, p.sessionId).catch(() => {})
  }

  private emit(msg: unknown): void {
    for (const fn of this.outbound) {
      try {
        fn(msg)
      } catch {
        /* 连接正在断——少一条事件不该掀翻中继 */
      }
    }
  }
}

/** 同扩展的 `sameUrl`：协议 / 主机 / 路径 / 查询 / 片段一致（尾斜杠不算差别）。 */
export function sameUrl(a: string, b: string): boolean {
  const x = a.trim()
  const y = b.trim()
  if (x === y) return true
  let ua: URL
  let ub: URL
  try {
    ua = new URL(x)
    ub = new URL(y)
  } catch {
    return false
  }
  const path = (u: URL) => (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''))
  return ua.protocol === ub.protocol && ua.host === ub.host && path(ua) === path(ub) && ua.search === ub.search && ua.hash === ub.hash
}

/** `chrome.cookies.getAll({domain})` 的匹配口径：同域或它的子域。 */
export function domainMatches(cookieDomain: string, domain: string): boolean {
  const d = cookieDomain.replace(/^\./, '').toLowerCase()
  const q = domain.replace(/^\./, '').toLowerCase()
  return d === q || d.endsWith(`.${q}`)
}

/**
 * CDP 的 cookie → 扩展 `serializeCookie` 的形状（`cookie-shape.ts`）。两份要能互换：
 * 服务端按同一套字段读，`hostOnly` / `session` 丢了会改变注入回去的语义。
 */
export function serializeCookie(c: {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  session: boolean
  sameSite?: string
}): Record<string, unknown> {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: sameSiteOf(c.sameSite),
    expirationDate: c.expires > 0 ? c.expires : undefined,
    hostOnly: !c.domain.startsWith('.'),
    session: c.session === true,
  }
}

/** CDP 的 `Strict|Lax|None` → `chrome.cookies` 的 `strict|lax|no_restriction`。 */
function sameSiteOf(v: string | undefined): string | undefined {
  if (v === 'Strict') return 'strict'
  if (v === 'Lax') return 'lax'
  if (v === 'None') return 'no_restriction'
  return undefined
}

function withBudget(cmd: Promise<unknown>, method: string): Promise<unknown> {
  cmd.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${method} 在 ${SCREENSHOT_BUDGET_MS}ms 内没有回执：这个标签没有产出帧（浏览器窗口没有真的显示在屏幕上）`)),
      SCREENSHOT_BUDGET_MS,
    )
  })
  return Promise.race([cmd, budget]).finally(() => clearTimeout(timer))
}
