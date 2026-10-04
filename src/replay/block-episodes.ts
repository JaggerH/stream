import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * **撞墙台账：用自然流量把「多久才凉」量出来，不刻意去探。**
 *
 * 起因是一个答不出来的问题：Google 回了 `/sorry/index` 之后，多久才恢复？翻遍所有账本都没有——
 * `source-health.json` 只记失败，冷却的 strikes / until 全在内存里、重启即清。能框出的最紧上界是
 * 「撞墙 15 小时后有一次成功」，等于没有。
 *
 * ## 形状：区间删失（interval censoring），不是一个点
 *
 * 每次撞墙开一条 episode，之后的每一次尝试都在收窄这条 episode 的两端：
 *
 * - **又被拦** → 下界：「到这会儿还没凉」（`lastBlockedAt`）
 * - **跑成了** → 上界：「这会儿之前已经凉了」（`recoveredAt`），episode 就此封口
 *
 * 尝试从哪来：**不刻意造**。冷却到期本来就会放行一发，用户随手一搜也算一次。区间紧不紧由自然
 * 流量决定——他一整晚不搜，那条 episode 就只框出个 15 小时，弱但不是错的。攒几条自然收紧。
 *
 * ## 两条不能省的判断
 *
 * 1. **别对恢复时间取平均。** 同一张 `/sorry` 页底下是两种墙：打太密的**瞬时拦截**（2026-08-13
 *    实测，拦完紧接着单发就有结果，秒级恢复）和一小时累计打爆（2026-08-15 抖音实测，**3h10m
 *    后单发仍被挑战**，下界都没测到上界）。页面长得一模一样，分不出来——但数据自己会分成两堆，
 *    一平均就得到一个对两种都不对的数。所以这里存**原始 episode**，取数时取分位不取均值。
 *
 * 2. **底数取「见过的最短一次成功等待」，不取最长。** 低估的代价是白撞一次，而冷却本来就翻倍，
 *    一撞就自动climb回去；高估的代价是站点早就凉了我们还在罚站，白丢可用性，而且没有任何信号
 *    能把它纠回来。两边的代价不对称，所以偏向短的那头。上限（`capMs`）反过来——它由**下界**
 *    喂养：既然实测见过"到 3h10m 还没凉"，那 30 分钟封顶就是在假装退让。
 */

/** 一次撞墙。`at` 之后的每一次尝试都在收窄 [lastBlockedAt, recoveredAt] 这个区间。 */
export interface BlockEpisode {
  /** 撞墙时刻（墙钟毫秒） */
  at: number
  /** 撞墙时上游给的原因，原文（排错用；给人看的那句在 `forHumans`） */
  because: string
  /**
   * **撞墙前那一小时我们自己发了几发**（限流器的记账，`FacilityRateLimiter.drainBudget` 给的）。
   *
   * 这一格是白捡的，也是这份台账第二个用处：`perHour` 那个闸门今天是照**一次**观察定的
   * （「一小时约一百发之后开始稳定回 /sorry」），零余量。撞墙多几次，这一列就是它的实测分布，
   * 不必再去跑那个要占着用户浏览器一小时的低速压测。
   */
  spentLastHour?: number
  /** 最近一次确认「还在被拦」的时刻 —— 恢复时间的**下界** */
  lastBlockedAt?: number
  /** 第一次跑成的时刻 —— 恢复时间的**上界**，episode 封口 */
  recoveredAt?: number
}

/** 学不到东西时的兜底底数：和这套机制诞生时的固定值一样，见 `FacilityCooldown`。 */
export const FALLBACK_BASE_MS = 60_000
/** 学不到东西时的封顶。 */
export const FALLBACK_CAP_MS = 30 * 60_000
/**
 * 底数的地板。比这更短的"恢复"和一次抖动分不开（拦截页判错、并发的另一发刚好过去），
 * 拿它当冷却底数等于没有冷却。
 */
export const FLOOR_BASE_MS = 15_000
/**
 * 封顶的硬顶。台账再怎么长也不许把一个源锁掉超过这个时长——冷却期内没有任何请求会发出去，
 * 也就没有任何信号能把它纠回来，所以这里必须有一个不由数据说了算的上限。
 */
export const HARD_CAP_MS = 12 * 3600_000

/** 从台账里学到的退避参数。`samples` 是封口的 episode 数，0 = 还没学到东西。 */
export interface LearnedBackoff {
  baseMs: number
  capMs: number
  samples: number
}

interface Snapshot {
  version: 1
  facilities: Record<string, BlockEpisode[]>
}

/**
 * 落盘的撞墙台账。**跨重启活着是重点**——今天 strikes / until 全在内存，重启就把刚学到的扔了。
 */
export class BlockEpisodeLog {
  private readonly facilities = new Map<string, BlockEpisode[]>()
  private readonly now: () => number
  private readonly keep: number

  constructor(
    private readonly path: string,
    opts: { now?: () => number; keep?: number } = {},
  ) {
    this.now = opts.now ?? Date.now
    this.keep = opts.keep ?? 30
    this.load()
  }

  /**
   * 记一次撞墙。**开新 episode 还是续上一条，由「有没有封口的那条」决定**：
   * 只要还没有任何一次成功，就说明站点从 `at` 起一直没消气，这一发只是把下界往后推。
   */
  blocked(facility: string, because: string, ctx: { spentLastHour?: number } = {}): void {
    const list = this.listOf(facility)
    const open = list.at(-1)
    if (open && open.recoveredAt == null) {
      open.lastBlockedAt = this.now()
      // 原因取最新的一次：同一条 episode 里站点的说法可能从"登录墙"变成"风控挑战"。
      open.because = because
      if (ctx.spentLastHour != null) open.spentLastHour = ctx.spentLastHour
    } else {
      list.push({ at: this.now(), because, ...(ctx.spentLastHour != null && { spentLastHour: ctx.spentLastHour }) })
      if (list.length > this.keep) list.splice(0, list.length - this.keep)
    }
    this.save()
  }

  /**
   * 记一次跑成 → 给还开着的那条 episode 封口。**没有开着的就什么都不做**（也不落盘）——
   * 这个方法挂在每一次成功运行上，绝大多数时候是空转。
   */
  recovered(facility: string): void {
    const open = this.facilities.get(facility)?.at(-1)
    if (!open || open.recoveredAt != null) return
    open.recoveredAt = this.now()
    this.save()
  }

  /**
   * 从这个 facility 的历史里学退避参数。
   *
   * - `baseMs` = **见过的最短一次成功等待**（上界的最小值），地板 `FLOOR_BASE_MS`。低估自动被
   *   翻倍纠回来，高估没有信号能纠——所以偏短。
   * - `capMs` = 见过的**最长一次「还没凉」**（下界的最大值）的两倍，不低于 `FALLBACK_CAP_MS`、
   *   不高于 `HARD_CAP_MS`。抖音那次实测 3h10m 仍被挑战，30 分钟封顶就是在假装退让。
   */
  learn(facility: string): LearnedBackoff {
    const list = this.facilities.get(facility) ?? []
    const uppers = list.filter((e) => e.recoveredAt != null).map((e) => e.recoveredAt! - e.at).filter((d) => d > 0)
    const lowers = list.filter((e) => e.lastBlockedAt != null).map((e) => e.lastBlockedAt! - e.at).filter((d) => d > 0)
    const baseMs = uppers.length ? Math.max(FLOOR_BASE_MS, Math.min(...uppers)) : FALLBACK_BASE_MS
    const capMs = lowers.length
      ? Math.min(HARD_CAP_MS, Math.max(FALLBACK_CAP_MS, Math.max(...lowers) * 2))
      : FALLBACK_CAP_MS
    // 底数不许超过封顶——学到一个很长的"最短成功等待"时（只有长的那堆样本），第一次撞墙也不该
    // 一步跨到封顶之外。
    return { baseMs: Math.min(baseMs, capMs), capMs, samples: uppers.length }
  }

  /** 这个 facility 的全部 episode（新的在后）。给排查 / 以后的展示用。 */
  episodes(facility: string): readonly BlockEpisode[] {
    return this.facilities.get(facility) ?? []
  }

  private listOf(facility: string): BlockEpisode[] {
    let list = this.facilities.get(facility)
    if (!list) {
      list = []
      this.facilities.set(facility, list)
    }
    return list
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Snapshot
      for (const [facility, list] of Object.entries(raw.facilities ?? {})) {
        if (Array.isArray(list)) this.facilities.set(facility, list.filter((e) => typeof e?.at === 'number'))
      }
    } catch {
      // 没有文件 / 文件坏了都当空台账起步：这份数据是"锦上添花"，绝不能因为它读不出来就让采集起不来。
    }
  }

  private save(): void {
    const snapshot: Snapshot = { version: 1, facilities: Object.fromEntries(this.facilities) }
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(snapshot, null, 2))
    } catch {
      // 同上：写不进去也不该把一次采集变成失败。
    }
  }
}
