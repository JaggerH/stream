import type { BrowserCookie } from '../types.ts'
import type { DebugEntry } from '../debug.ts'

/** 中继上这条能力的最小面（结构类型，单测塞个假的就行）。 */
export interface CookiePullTransport {
  readonly connected: boolean
  cookiePull(domains: string[]): Promise<{ cookies: Record<string, unknown[]>; refused: string[] }>
}

/** 快照的写入口。**只有整份替换**——按域合并会造出永不过期的僵尸登录态。 */
export interface CookieSnapshot {
  replace(cookies: Record<string, BrowserCookie[]>): void
  status(): { domains: string[]; updatedAt: number | null }
}

export interface CookiePullerDeps {
  relay: CookiePullTransport
  store: CookieSnapshot
  /** Stream 按已装 manifest 推出来的登录域全集。每次都拉**全量**，理由见 pull()。 */
  requiredDomains: () => string[]
  log?: (line: string) => void
  /** 每一轮的结果发一条到 debug bus 的 `cookie-pull` 频道。**这条不是可选的装饰**：
   *  这条链路所有的失败都长得一样（取不到 cookie → 采集变游客态），日志在 stdout 上
   *  谁也看不到，排查只能靠推。有了它，"上一次取成功没有、取回了几个域、被拒了哪些"
   *  是一个 `GET /api/debug/log?channel=cookie-pull` 就能回答的问题。 */
  report?: (entry: DebugEntry) => void
  now?: () => number
}

export interface PullOutcome {
  ok: boolean
  /** 没拉成的原因（人能读懂的一句话）。ok 时不出现。 */
  reason?: 'relay-down' | 'no-domains' | 'failed'
  domains: string[]
  refused: string[]
}

/**
 * 「去浏览器把登录态取回来」——**取数的调度方**。
 *
 * 这是方向反转的落点：以前扩展按 30 分钟的闹钟往后端推，现在后端在它真正需要的时刻来取。
 * 差别不在省了多少代码，在最坏延迟：cookie 轮换之后，推模型只能干等下一个周期（期间每次
 * 取流都 412），拉模型可以在吃到第一个 401 的当场换一份新的。
 *
 * 三个触发时机（接线在 bootstrap）：
 * 1. 中继一连上 —— Chrome 刚起来，手里那份最旧；
 * 2. 动手采集/取流前，发现快照太旧（`ensureFresh`）；
 * 3. 扩展报「同步域里的 cookie 变了」。
 *
 * **绝不挂在 `cookieString()` 上。** 那是热路径（媒体代理每个请求都过），而且"本地查得到"
 * 根本不等于"这份还有效"——过期的 cookie 一样查得到，按 miss 触发的话最该刷新的那一刻
 * 恰恰永远不刷新。
 */
export class CookiePuller {
  private inFlight: Promise<PullOutcome> | null = null

  constructor(private readonly deps: CookiePullerDeps) {}

  /**
   * 拉一次并整份写回。
   *
   * **永远拉全量，不拉"变了的那几个"。** 因为写入口是整份替换：只写变的那几个就得改成按域
   * 合并，而那正是被点名禁止的形状（用户退登之后，那个域会以僵尸的形式永远留在快照里）。
   * 全量的代价只是几个 `chrome.cookies.getAll`，很便宜。
   *
   * 并发去重：同一时刻只有一轮在飞。三个触发时机会撞在一起（中继连上的同时扩展也在报变更），
   * 不去重就是同一份数据来回覆盖。
   */
  pull(reason: string): Promise<PullOutcome> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.run(reason).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /**
   * 快照比 `maxAgeMs` 还旧就拉一次，否则原样返回。采集/取流动手前调它。
   * 中继没连时**不报错**——浏览器不在是环境问题，不是这条源坏了。
   */
  async ensureFresh(maxAgeMs: number, reason: string): Promise<void> {
    const { updatedAt } = this.deps.store.status()
    const now = this.deps.now?.() ?? Date.now()
    if (updatedAt != null && now - updatedAt <= maxAgeMs) return
    await this.pull(reason)
  }

  private async run(reason: string): Promise<PullOutcome> {
    const log = this.deps.log ?? console.log
    const domains = [...new Set(this.deps.requiredDomains())].filter(Boolean)
    if (!domains.length) {
      this.report(reason, false, '没有要同步的域', [])
      return { ok: false, reason: 'no-domains', domains: [], refused: [] }
    }
    if (!this.deps.relay.connected) {
      // 常态，不是故障：Chrome 关着。它下次连上时触发 ① 会自己补一轮。
      // 仍然记一条（ok:true）——「为什么快照是旧的」必须能查到答案，哪怕答案是"浏览器没开"。
      this.report(reason, true, 'Chrome 没连上，这一轮跳过（下次它连上会自己补）', [
        { label: '想取的域', value: String(domains.length), tone: 'muted' },
      ])
      return { ok: false, reason: 'relay-down', domains, refused: [] }
    }
    try {
      const { cookies, refused } = await this.deps.relay.cookiePull(domains)
      const normalized: Record<string, BrowserCookie[]> = {}
      for (const [domain, list] of Object.entries(cookies ?? {})) {
        if (Array.isArray(list) && list.length) normalized[domain] = list as BrowserCookie[]
      }
      this.deps.store.replace(normalized)
      const got = Object.keys(normalized)
      log(`[cookie-pull] ${reason}: 取回 ${got.length}/${domains.length} 个域`)
      // 被拒 = 后端要的域不在扩展申报的同步范围里。**必须喊**：它的表现和"用户没登录"
      // 一模一样（两者都是取不到 cookie），不喊就会被当成登录问题查上半天。
      if (refused?.length) log(`[cookie-pull] 扩展拒了这些域（不在它申报的同步范围内）：${refused.join(', ')}`)
      this.report(reason, !refused?.length, `取回 ${got.length}/${domains.length} 个域`, [
        { label: '取回', value: got.join(', ') || '(空)', tone: got.length ? 'ok' : 'warn' },
        ...(refused?.length
          ? [{ label: '被扩展拒了', value: refused.join(', '), tone: 'bad' as const }]
          : []),
      ])
      return { ok: true, domains: got, refused: refused ?? [] }
    } catch (err) {
      // 拉失败绝不清空快照：旧的登录态再旧也比没有强，而"清空"会把一次网络抖动放大成全站游客态。
      const message = err instanceof Error ? err.message : String(err)
      log(`[cookie-pull] ${reason} 失败（保留现有快照）：${message}`)
      this.report(reason, false, '取失败，保留现有快照（登录态可能是旧的）', [
        { label: '原因', value: message, tone: 'bad' },
        { label: '快照时间', value: describeAge(this.deps.store.status().updatedAt, this.deps.now), tone: 'warn' },
      ])
      return { ok: false, reason: 'failed', domains, refused: [] }
    }
  }

  private report(reason: string, ok: boolean, summary: string, fields: DebugEntry['fields']): void {
    const at = this.deps.now?.() ?? Date.now()
    this.deps.report?.({
      id: `cookie-pull:${reason}@${at}`,
      at,
      channel: 'cookie-pull',
      key: reason,
      title: `登录态：${reason}`,
      summary,
      ok,
      fields,
    })
  }
}

/** 「这份快照多旧了」——排查时最想知道的那一个数，别让人拿时间戳自己减。 */
function describeAge(updatedAt: number | null, now?: () => number): string {
  if (updatedAt == null) return '从来没取到过'
  const mins = Math.round(((now?.() ?? Date.now()) - updatedAt) / 60_000)
  return `${mins} 分钟前`
}
