import { EnvironmentUnavailableError } from '../failure.ts'
import { FALLBACK_BASE_MS, FALLBACK_CAP_MS, type LearnedBackoff } from './block-episodes.ts'

/**
 * **被拦之后别再去打**——和限流是两件事，别混。
 *
 * `FacilityRateLimiter` 管的是**频率**（一分钟最多几次，桶空了等）。它管不了这一格：站点已经
 * 拦下我们了，此时"频率没超"仍然成立，于是下一次照打不误，而每一次都在加深那个拦截。
 * 2026-08-13 活体就是这个形状：连打约一百发之后 Google 开始回 `/sorry/index`，而我们对着
 * 拦截页一发接一发地继续打。
 *
 * **勉强顶着这个位置的 `RepairLedger` 检疫不合适**：它是二值且静默的——连着失败就永久隔离，
 * 之后 `ReplayAdapter.fetch` 直接 `return DECLINED`，连浏览器都不开、日志一个字都没有。
 * 那个判据回答的是「这条 recipe 坏了吗」，不是「这个站点这会儿高不高兴」。
 *
 * ## 三条决定
 *
 * 1. **判据只有一条：`needsLogin`（撞墙）**。它是全链路上唯一一个具名的"被站点挡住"信号
 *    （`loginCheck.wall` 命中 → `WalledError` → `outcome:'needsLogin'`），而且现在动作之后
 *    也会补探一次（见 `recipe-runner` 那段）。不去发明"失败几次算被拦"——那是检疫的活，
 *    而且量不出来。
 *
 * 2. **底数小、翻倍快**（60s → 2min → 4min…封顶 30min），成功一次就清零。这不是随手取的数，
 *    是这一格真实的取舍：撞墙既可能是"站点在拦机器"（该退让久一点），也可能是"用户就是没登录"
 *    （他这就去登，然后马上重试——罚他站十分钟是错的）。**底数小让后一种几乎无感，翻倍让
 *    前一种很快退到足够远。**
 *
 *    **底数和封顶现在由台账喂**（`BlockEpisodeLog`，每个 facility 各学各的）：撞墙、之后的每次
 *    尝试都在收窄「多久才凉」这个区间，学到什么就用什么，学不到就退回上面这两个固定值。
 *    每个 facility 各学各的是硬要求——Google 学出来的可能是小时级，套到"用户这就去登"那一档
 *    就是把体验搞坏。
 *
 * 3. **冷却期内必须说得出自己是冷却**。`CoolingDownError` 继承 `EnvironmentUnavailableError`，
 *    走的是「不记失败、不记成功、只出声」那一档——语义上就对：冷却期内我们连标签都没开，
 *    这既不是源坏了，也不是"这次没搜到"。消息本身带着原因和剩余时间，一路能传到给模型的
 *    那句 note 里。**这一格是关键**：如果冷却退化成一个空结果，"整条腿在冷却"和"这次没搜到"
 *    就长得一模一样了，而它们对下一步的意思完全相反。
 */

/** 台账还没学到东西时，第一次被拦冷却多久。小是刻意的——见上面第 2 条。 */
const BASE_MS = FALLBACK_BASE_MS
/** 台账还没学到东西时，连着被拦的封顶。 */
const MAX_MS = FALLBACK_CAP_MS

/**
 * 这个 facility 正在冷却。**不是故障，是退让**，所以带上剩余时间和原因。
 *
 * 措辞里**不放「稍后再试」**：这句话会一路传到模型面前，而它读到"再试"就真的会再打一次
 * 同一条查询——对话循环没有退避（实测一轮 22 条 web_search error 就是这么来的）。
 */
/**
 * 把「上一次为什么被拦」压成一句能给人看的话。
 *
 * **给用户看的那句话只该包含：发生了什么 + 你要不要做什么 + 大概多久。** 原始报错是给排错用的，
 * 它的家是日志 / debug 总线 / `data/failures`，不是这句提示——而 `because` 是从上游错误消息
 * 原样传下来的，里面什么都可能有。活体（2026-08-15）这句话就长成过：
 *   `刚被站点拦下：站方在动作之后弹出风控挑战：Error: douyin: search/item did not settle in 5s
 *    — risk-control challenge (captcha overlay) swallows the promise\n    at <anonymous>:1:1569`
 * ——一句人话后面拖着英文报错和一段 JS 栈。
 *
 * 三刀，都只砍展示、不动 `because` 字段本身（排错要看的原文一个字没少）：取第一行、切掉
 * 嵌进来的 `Error:` 之后的技术尾巴、按字数截断。
 */
export function forHumans(because: string, max = 40): string {
  const firstLine = because.split('\n')[0]!.trim()
  // 嵌套报错的形状是「人话：Error: 技术细节」——冒号前那半才是给人看的。
  const head = firstLine.split(/(?:^|：|:\s*)Error:/)[0]!.trim() || firstLine
  return head.length > max ? `${head.slice(0, max)}…` : head
}

export class CoolingDownError extends EnvironmentUnavailableError {
  /**
   * **自报分类**（`DeclaresFailureCategory`），别让 `classifyError` 去嗅探这条消息。
   *
   * 这条消息里嵌着**上一次被拦的原因**（`because`），而那句话说什么完全不由我们控制：
   * `needsLogin` 那一档的默认理由就是「撞上登录墙/拦截页」，含"登录"二字 —— 靠文本判会
   * 落进 `auth`，把一个"**我们自己在等**"的状态送进重登面板，请用户去扫一个没问题的码。
   * 活体里它侥幸落对过一次（`because` 恰好含"风控"），而靠运气对的判据等于没有判据。
   */
  readonly failureCategory = 'blocked' as const
  constructor(
    readonly facility: string,
    readonly remainingMs: number,
    readonly because: string,
  ) {
    super(
      `"${facility}" 正在冷却（刚被站点拦下：${forHumans(because)}），还剩约 ${Math.ceil(remainingMs / 1000)}s，这次不去打它`,
    )
    this.name = 'CoolingDownError'
  }
}

interface Entry {
  /** 冷却到什么时候（墙钟毫秒） */
  until: number
  /** 连着被拦几次——决定下一次冷却多久 */
  strikes: number
  /** 最近一次被拦的原因，说给上层听 */
  because: string
}

/**
 * 撞墙台账（`BlockEpisodeLog`）里这一层用得到的那两个动作 + 学到的退避参数。
 * 写成结构类型是为了测试能塞一个假的进来，不必碰文件系统。
 */
export interface CooldownLedger {
  blocked(facility: string, because: string, ctx?: { spentLastHour?: number }): void
  recovered(facility: string): void
  learn(facility: string): LearnedBackoff
}

export class FacilityCooldown {
  private readonly entries = new Map<string, Entry>()
  private readonly now: () => number

  /**
   * @param ledger 撞墙台账。**省略 = 退回固定的 60s/30min 阶梯**（老行为一字不变），所以测试和
   *   不关心这件事的调用方不必管它。
   */
  constructor(
    clock: { now?: () => number } = {},
    private readonly ledger?: CooldownLedger,
  ) {
    this.now = clock.now ?? Date.now
  }

  /**
   * 记一次被拦：进入冷却，连着被拦则翻倍（封顶见 `learn().capMs`）。
   *
   * `ctx.spentLastHour` 是撞墙前那一小时我们自己发了几发——只进台账，不参与这里的算术。
   * 它回答的是另一个问题（`perHour` 那个闸门该定在几），见 `BlockEpisode.spentLastHour`。
   */
  blocked(facility: string, because: string, ctx?: { spentLastHour?: number }): void {
    const prev = this.entries.get(facility)
    // 已经过了冷却期才算"新的一轮"——冷却期内又被拦（比如并发的另一发）不该额外加码，
    // 否则一次并发就能把 strikes 顶到封顶。
    const strikes = prev && this.now() < prev.until ? prev.strikes : (prev?.strikes ?? 0) + 1
    // 先记账再取数：这一发本身就是一个"到这会儿还没凉"的观察，它该参与到自己这次的退避里。
    this.ledger?.blocked(facility, because, ctx)
    const learned = this.ledger?.learn(facility)
    const waitMs = Math.min(learned?.capMs ?? MAX_MS, (learned?.baseMs ?? BASE_MS) * 2 ** (strikes - 1))
    this.entries.set(facility, { until: this.now() + waitMs, strikes, because })
  }

  /** 跑成了一次 → 清零，并给台账上还开着的那条 episode 封口（拿到恢复时间的上界）。 */
  cleared(facility: string): void {
    this.ledger?.recovered(facility)
    this.entries.delete(facility)
  }

  /** 冷却中就抛 `CoolingDownError`；否则什么都不做。**在开标签之前调**。 */
  assertReady(facility: string): void {
    const e = this.entries.get(facility)
    if (!e) return
    const remaining = e.until - this.now()
    if (remaining <= 0) return // 到点了：留着 strikes（连着被拦要接着翻倍），只是不再拦
    throw new CoolingDownError(facility, remaining, e.because)
  }
}
