import { EnvironmentUnavailableError } from '../failure.ts'
/**
 * 每个 facility 一个令牌桶，单位是**一次 recipe 运行**（一次搜索 / 一次 detail / 一次互动）。
 *
 * **为什么是这个机制，而不是更拟人**（2026-07-29，用户亲历后拍板）：那次 xhs 登录墙是
 * 连续高频打 detail 打出来的——每次点击的拟人光标轨迹、900ms 动作间隔全程都开着，一样撞墙。
 * 站点数的是**频率**，不是像不像人。所以治理封号的正解是限速；humanize 管的是单次动作长
 * 什么样，管不了「一分钟来了三十次」。
 *
 * 形状选令牌桶而不是固定间隔：真人就是一阵一阵的——连点五条笔记，然后去读十分钟。固定间隔
 * 会把这种正常节奏也压住（每条都要等），而令牌桶允许攒下来的额度一次用掉（burst），只把
 * **持续速率**压在 perMinute 上。攒也有上限：放一天假不等于攒到无限次。
 */
export interface FacilityRateLimit {
  /** 可以一次性用掉的额度（桶容量）。0 = 不限速。 */
  burst: number
  /** 持续速率：每分钟补几个令牌。0 = 不限速。 */
  perMinute: number
  /**
   * **长时窗累计预算：一小时最多发几次。** 省略 = 没有累计上限（老包行为一字不变）。
   *
   * **为什么 burst/perMinute 管不住它**：那两个数管的是**瞬时形状**（一阵能打多密），而有的站点
   * 数的是**累计量**。Google 就是：一小时约一百发之后稳定回 `/sorry/index`，IP 级（换查询、
   * 单发都一样）。2026-08-15 亲历——一个 agent 15 分钟连打约 40 发就吃到拦截页，而令牌桶
   * 从头到尾一次都没拒绝过（40 发摊 15 分钟 ≈ 2.7 次/分，离 30 的闸门差一个数量级）。
   * 反过来说：完全合规地跑满 `perMinute: 30`，一小时就是 1800 发，比撞墙门槛高 18 倍。
   *
   * **形状同样是令牌桶**（容量 = perHour，每 3600s/perHour 回一格），不是整点清零的固定窗口：
   * 固定窗口在窗口边界上允许两倍量挤在一起（59:59 打满 + 00:01 再打满），而这里要挡的正是
   * 累计量。连续回血还有个好处——撞满之后不必干等一整个小时，等一格就能再发一次。
   *
   * **撞满的处置是立刻抛，不受 `maxWaitMs` 那条「宁可等」的支配**：等下一格是几十秒起步，
   * 而这条腿长在对话热路径上。抛出去之后由 `src/search/web-search-ladder.ts` 接住——它把
   * 「这条腿没跑成」软化成走备胎 / 当它不存在，用户看到的是结果少了一条腿，不是一个 error。
   */
  perHour?: number
  /**
   * 最长愿意等多久。超过就直接拒（抛 `RateLimitedError`），不挂在那儿。
   *
   * 存在的理由是**前台**：用户点开一条笔记，等 3 秒是加载，等 90 秒是坏了。宁可告诉他
   * "太快了，X 秒后再试"，也不要一个转不完的圈。省略 = 无限等（后台定时采集适用）。
   */
  maxWaitMs?: number
  /**
   * 只对 recipe 那道（第二道）有意义：几条腿**共用一个桶**的桶名。不给 = 桶按 recipe 自己的
   * sourceId 各开一个。
   *
   * **为什么要有它**：站点看到的是「这个账号一小时写了几次」，不分是上架、编辑还是擦亮。
   * 三条写腿各自「每小时 6 件」，加起来就是 18 件——2026-09-14 亲历：一小时里删 2、发 3、改 6，
   * 闲鱼弹滑块、接口超时、整个 facility 进冷却。三条腿写同一个 `bucket`，预算就是账号级的一份。
   */
  bucket?: string
}

/** 注入时钟/等待，便于测试（真实时钟的测试要么慢要么假绿）。 */
export interface FacilityRateLimitClock {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * 桶空且预计等待超过 `maxWaitMs`——**不是故障，是节流**，所以带上还要多久，让 UI 能说人话。
 *
 * 继承 `EnvironmentUnavailableError` 是**语义上就对**，不是图省事复用分支：那个类的判据写着
 * 「只有确定没跑成才算——命令根本没发出去」，而被限速时我们连标签都没开。它带来的处理正是
 * 我们要的三选一——**不记失败、不记成功、什么都不记**，只出声。
 *
 * 反面很具体：把限速记成失败，等于用户手快点了几下就把小红书这个源点成红的、连点几次掉档，
 * 而源一点毛病都没有；记成成功则会把真坏掉的源永久掩盖。
 */
export class RateLimitedError extends EnvironmentUnavailableError {
  constructor(
    readonly facility: string,
    readonly retryAfterMs: number,
  ) {
    super(`rate limited on "${facility}" — retry in ${Math.ceil(retryAfterMs / 1000)}s`)
    this.name = 'RateLimitedError'
  }
}

/**
 * 两份 facility 限流声明取最严——分享包驱动的是用户自己的登录态浏览器，限流是站点属性，
 * 不由单个包说了算：同 facility 多个包同时声明 rateLimit 时，不能让后加载的那份覆盖掉更严的那份。
 */
export function clampRateLimit(
  a?: FacilityRateLimit,
  b?: FacilityRateLimit,
): FacilityRateLimit | undefined {
  if (!a) return b
  if (!b) return a
  const maxWaitMs = Math.min(a.maxWaitMs ?? Infinity, b.maxWaitMs ?? Infinity)
  // perHour 缺席 = 无累计上限，所以缺席那一侧永远是更松的那份 —— 同 maxWaitMs 的处理。
  const perHour = Math.min(a.perHour ?? Infinity, b.perHour ?? Infinity)
  return {
    burst: Math.min(a.burst, b.burst),
    perMinute: Math.min(a.perMinute, b.perMinute),
    ...(Number.isFinite(perHour) && { perHour }),
    ...(Number.isFinite(maxWaitMs) && { maxWaitMs }),
  }
}

interface Bucket {
  /** 当前令牌数（可以是小数：按经过的时间连续补，不按整秒跳） */
  tokens: number
  /** 上次补充的时刻 */
  at: number
  /** 剩余的**小时预算**（同样是连续补的小数，见 `FacilityRateLimit.perHour`） */
  hourTokens: number
  /** 小时预算上次补充的时刻 */
  hourAt: number
}

/** 一次 `take` 要同时过的一道闸：桶 + 它自己的那份声明。 */
interface Gate {
  key: string
  cfg: FacilityRateLimit
  b: Bucket
}

export class FacilityRateLimiter {
  /** facility 桶：一个站点一只。 */
  private readonly buckets = new Map<string, Bucket>()
  /** 源桶：`facility → (sourceId → 桶)`。**分两层存，不拼 key** —— 拼出来的 key 要两处
   *  （建桶处、排空处）各自记得同一个分隔符，而它们一旦写岔就是「闸门看着加了、实际从没
   *  生效」这种静默失效（本文件真栽过一次：建桶用分隔符、排空用空格前缀，源桶永远排不空）。 */
  private readonly sourceBuckets = new Map<string, Map<string, Bucket>>()
  /** 排队尾**按 facility 一条**：每次 take 都要过这个 facility 的闸，一条队就够，
   *  也避免两条队各自持有一半的闸互相等（源级桶没有自己的队）。 */
  private readonly tails = new Map<string, Promise<void>>()
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  /**
   * @param configFor 每个 facility 自己声明限速（`packages/<facility>/package.json` 的
   *   `stream.rateLimit`）。返回 undefined = 这个 facility 不限速。**默认不限速是刻意的**：闸门是
   *   针对具体站点的实测结论，不该由一个凭空的全局默认值替所有站点做主。
   */
  constructor(
    private readonly configFor: (facility: string) => FacilityRateLimit | undefined,
    clock: FacilityRateLimitClock = {},
  ) {
    this.now = clock.now ?? Date.now
    this.sleep = clock.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()))
  }

  /**
   * 拿一个令牌；不够就等到有，等太久就抛 `RateLimitedError`。
   *
   * **`source` 是这条腿自己再加的一道闸**（recipe 的 `meta.rateLimit`，由执行器直接从 canonical
   * recipe 上读了递进来）。不给 = 只受 facility 那道管，也就是这一格加进来之前的行为。
   *
   * **为什么需要第二道**：facility 桶是**按站点**的一个桶，而一个站点上的几条腿节奏能差一个数量级。
   * 闲鱼就是：`goofish-search`（购买决策查残值，一次决策 4–10 台）要 burst 12，而 `goofish-publish`
   * （上架）15 分钟 6 发就把整站打成 404（2026-09-08 亲历）。把 facility 桶压到能保护上架的档位 =
   * 顺手把残值查询也压死（它 `maxWaitMs 3000`，排不上就抛）——`packages/baidu-search/package.json`
   * 里记的正是这个坑。所以危险的那条腿要一道**自己的**闸。
   *
   * **配置随 recipe 递进来，不按 id 去查表**：recipe 体里的 `sourceId` 是**局部名**，而 registry
   * 装的是全名，拿局部名去查恒为 undefined——那是个静默失效（闸门看起来加了，其实一发都没拦），
   * 同一个坑执行器的 `builtinPackage` 那一格已经栽过一次（见它的头注）。
   *
   * **两道闸都过才放行，且同一次结算**：先把两边都算清楚，再一起扣。分两次 take 会出现"扣了源的、
   * facility 那边却拒了"这种半拉子消费——被拒的那次连标签都没开，不该记账。
   *
   * **两道闸门，处置不同**：小时预算（`perHour`）撞满 → **立刻抛**（等一格是几十秒起步，
   * 而这条路长在对话热路径上）；分钟速率撞满 → 按 `maxWaitMs` 决定等还是抛。
   *
   * **桶挂在这个实例上，所以同一个后端进程里的所有调用方共用同一份预算**——对话 agent、
   * search agent、MCP 各自「没超速」但加起来撞墙，正是 2026-08-15 翻车那次的形状，这里
   * 自动覆盖。（多个后端进程各有一份，不在射程内：活体只有一份后端。）
   */
  async take(facility: string, source?: { id: string; limit?: FacilityRateLimit }): Promise<void> {
    const gates: Gate[] = []
    const pushInto = (into: Map<string, Bucket>, key: string, cfg?: FacilityRateLimit): void => {
      if (!cfg) return
      // burst/perMinute 与 perHour 都没开 = 这份声明什么都不限，别为它建桶。
      if (!(cfg.burst > 0 && cfg.perMinute > 0) && !((cfg.perHour ?? 0) > 0)) return
      gates.push({ key, cfg, b: this.bucketOf(into, key, cfg) })
    }
    pushInto(this.buckets, facility, this.configFor(facility))
    if (source?.limit) {
      let perSource = this.sourceBuckets.get(facility)
      if (!perSource) this.sourceBuckets.set(facility, (perSource = new Map()))
      pushInto(perSource, source.limit.bucket ?? source.id, source.limit)
    }
    if (!gates.length) return

    // 串行化：三个并发请求必须逐个结算，否则它们会在同一时刻各自看到"还有 1 个令牌"。
    // 排队本身不能被 maxWaitMs 拒——被拒的是"结算时算出来要等太久"，前面排的人是真实占用。
    // 队按 facility 排（不按闸），所以同 facility 的搜索腿与写腿也互相排队——本来就该如此：
    // 它们打的是同一个站点。
    const previous = this.tails.get(facility) ?? Promise.resolve()
    let unlock!: () => void
    this.tails.set(facility, new Promise<void>((resolve) => { unlock = resolve }))
    await previous
    try {
      // 先判小时预算：撞满了就没必要再去分钟闸门那里排队等了。**任何一道**撞满就抛。
      for (const g of gates) {
        if (!(g.cfg.perHour ?? 0)) continue
        const budgetIntervalMs = 3600_000 / (g.cfg.perHour ?? 1)
        this.refillBudget(g.b, g.cfg, budgetIntervalMs)
        if (g.b.hourTokens < 1) {
          throw new RateLimitedError(g.key, Math.ceil((1 - g.b.hourTokens) * budgetIntervalMs))
        }
      }
      // 分钟闸门：等的时长取**最长的那道**，愿意等多久取**最短的那条 maxWaitMs**（都要过，
      // 所以两边都取最严）。睡醒后重算一次；理论上一次就够，循环只是兜住时钟抖动。
      for (let pass = 0; pass < 4; pass++) {
        let waitMs = 0
        let maxWaitMs = Infinity
        for (const g of gates) {
          if (!(g.cfg.burst > 0 && g.cfg.perMinute > 0)) continue
          const intervalMs = 60_000 / g.cfg.perMinute
          this.refill(g.b, g.cfg, intervalMs)
          if (g.b.tokens < 1) waitMs = Math.max(waitMs, Math.ceil((1 - g.b.tokens) * intervalMs))
          maxWaitMs = Math.min(maxWaitMs, g.cfg.maxWaitMs ?? Infinity)
        }
        if (waitMs === 0) break
        if (waitMs > maxWaitMs) throw new RateLimitedError(facility, waitMs)
        await this.sleep(waitMs)
      }
      // 全部算清楚了才一起扣——半拉子消费（扣了这道、那道却拒了）等于给一次没发生的访问记了账。
      // 预算同样只在真正放行时扣：被分钟闸门拒掉的那次连标签都没开。
      for (const g of gates) {
        if (g.cfg.burst > 0 && g.cfg.perMinute > 0) g.b.tokens -= 1
        if ((g.cfg.perHour ?? 0) > 0) g.b.hourTokens -= 1
      }
    } finally {
      unlock()
    }
  }

  /**
   * **撞墙了：把这个 facility 的小时预算清空，并回报撞墙前那一小时我们发了几发。**
   *
   * 为什么必须排空：撞墙的意思就是站点认为我们这一小时打太多了，而桶里还剩多少是**我们自己的
   * 记账**，和它的判决无关。不排空的话，冷却一过就按原速接着打——`perHour` 那道闸门管不了这一格，
   * 它只知道我们发了几发，不知道我们已经被拦下过。2026-08-13 活体就是这个形状：对着拦截页
   * 一发接一发地继续打。
   *
   * 排空之后**不是永久锁死**：小时桶照常按 `3600s/perHour` 连续回血（perHour 100 就是每 36s
   * 回一格），所以冷却到期时手里恰好有一两发可用——正好够那次"还凉了没"的自然探测。
   *
   * 返回值是给台账的（`BlockEpisode.spentLastHour`）：没声明 `perHour`、或这个 facility 这轮
   * 进程里一发都没经过闸门 → `undefined`，意思是"这项没记到"，别拿 0 当"一发都没发"。
   */
  drainBudget(facility: string): number | undefined {
    // 源级桶一并排空：站点是把**整个账号/站点**拦下了（闲鱼那次连首页都 404），
    // 不排空的话冷却一过，那条腿手里还攥着自己的额度，照样能立刻再打一发。
    for (const b of this.sourceBuckets.get(facility)?.values() ?? []) {
      // 直接清零就够：这里不需要它们的 cfg（要 cfg 只是为了算"发了几发"，而台账问的是
      // facility 那一格，不是某条腿）。回血照旧由 `refillBudget` 在下次 take 时按 cfg 补。
      b.hourTokens = 0
      b.hourAt = this.now()
    }
    // 回给台账的仍是 **facility** 那一格的量（`BlockEpisode.spentLastHour` 问的是"这个站点这一
    // 小时挨了我们几发"，不是某条腿的）。
    const cfg = this.configFor(facility)
    if (!cfg?.perHour) return undefined
    const b = this.buckets.get(facility)
    if (!b) return undefined
    this.refillBudget(b, cfg, 3600_000 / cfg.perHour)
    const spent = Math.max(0, Math.round(cfg.perHour - b.hourTokens))
    b.hourTokens = 0
    b.hourAt = this.now()
    return spent
  }

  private bucketOf(into: Map<string, Bucket>, key: string, cfg: FacilityRateLimit): Bucket {
    let b = into.get(key)
    if (!b) {
      // 冷启动给满桶：Stream 刚起来时用户点第一条笔记，不该先罚站。
      const t = this.now()
      b = { tokens: cfg.burst, at: t, hourTokens: cfg.perHour ?? 0, hourAt: t }
      into.set(key, b)
    }
    return b
  }

  /** 按经过的时间连续补，封顶 burst —— 攒有上限，放一天假不等于攒到无限次。 */
  private refill(b: Bucket, cfg: FacilityRateLimit, intervalMs: number): void {
    const t = this.now()
    const gained = (t - b.at) / intervalMs
    if (gained > 0) {
      b.tokens = Math.min(cfg.burst, b.tokens + gained)
      b.at = t
    }
  }

  /** 小时预算同一套算法、另一把尺子：封顶 perHour，闲置一天也只攒回一小时的量。 */
  private refillBudget(b: Bucket, cfg: FacilityRateLimit, budgetIntervalMs: number): void {
    const t = this.now()
    const gained = (t - b.hourAt) / budgetIntervalMs
    if (gained > 0) {
      b.hourTokens = Math.min(cfg.perHour ?? 0, b.hourTokens + gained)
      b.hourAt = t
    }
  }
}
