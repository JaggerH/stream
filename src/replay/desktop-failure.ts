/** 桌面动作**为什么没成**——五档，互不混淆。
 *
 *  这是本 change 的承重条。2026-08-01 那次真实故障里，两种完全不同的失败从外面看一模一样：
 *  一次点击落到了别的标签上（返回 `errors: []`，看起来成功），另一次是桌面锁着（底层只丢出
 *  一句 `blocked by UIPI`）。**混成一种，调用方就只能靠反推**——那次反推了两轮。
 *
 *  `acted-unconfirmed` 刻意不是错误：动作确实发出去了，只是预期没兑现。它既不能算成功，
 *  也不该 throw——调用方要能据此决定是重试、换定位方式，还是停下来问人。 */
export type DesktopFailure =
  /** Stream Desktop 没连上——桌面能力整个不可用（不是"这次动作失败"） */
  | 'agent-disconnected'
  /** 桌面锁着/UAC 安全桌面挡着。**读仍然可能成功**——这个不对称是它必须独立成档的原因 */
  | 'desktop-locked'
  /** 按 AppMatch 找不到窗口 */
  | 'no-window-match'
  /** 多个窗口都匹配，需要用 title 指名 */
  | 'ambiguous-window'
  /** 还没确立目标窗口就要发坐标输入（坐标是投给屏幕的，没有收件人） */
  | 'no-foreground-target'
  /** 目标窗口在动作前丢了前台，输入没有发出 */
  | 'foreground-lost'
  /** 打字**打到一半**目标窗口丢了前台——输入**可能已经发出去一部分**。
   *  跟 `foreground-lost` 分开是因为下一步相反：那一档直接重试，这一档必须先看目标应用的
   *  实际状态，否则重试会把同一条消息发两遍（判据在 host-agent 的 `guard_typing_landed`） */
  | 'foreground-lost-midway'

/** agent 侧用 `<code>: <人话>` 的形状回错误（见 host-agent 的 protocol.rs）。
 *  这里只认前缀，认不出的原样归为 undefined——**不猜**：把一个陌生错误归到某一档，
 *  比不归类更坏（调用方会照着一个错误的判断去重试或放弃）。 */
export function classifyDesktopError(message: string): DesktopFailure | undefined {
  const code = message.split(':', 1)[0]?.trim()
  const known: DesktopFailure[] = [
    'agent-disconnected',
    'desktop-locked',
    'no-window-match',
    'ambiguous-window',
    'no-foreground-target',
    // 顺序有意义：`split(':')` 只取前缀，两个码互不为前缀（`-midway` 是独立一段），
    // 所以谁先谁后都对——但别把它改成 `startsWith` 匹配，那样 `foreground-lost` 会先吞掉
    // `foreground-lost-midway`，两档静默并成一档。
    'foreground-lost-midway',
    'foreground-lost',
  ]
  return known.find((k) => k === code)
}

/** 排队等桌面会话租约超时之后，说给调用方（模型/UI）听的那句「下一步」。
 *
 *  它跟 `DesktopFailure` 那六档是**两件事**：那六档说的是"这次动作发出去了但没成"，这句说的是
 *  "根本没轮到你发"——agent 是健康的，前面那趟还没让出租约。分不开的代价是调用方会去查 agent
 *  （那是 `HostRelayTimeout` 才该做的事），而正确动作只是稍后重试。
 *
 *  **两条交互路径共用同一句**（`run_action_recipe` 走 `src/mcp/action-recipe.ts`，四个 `cdp_*`
 *  动词走 `src/mcp/cdp-router.ts`）：同一件事分头写两句话，就会漂成"一条有归类一条没有"——
 *  那正是这条常量存在的原因。 */
export const SESSION_BUSY_REASON =
  '桌面通道正被另一条 recipe/操作占用，排队等待超时——这一次大概率还没开始执行（不是执行中途断开），稍后重试即可。'

/** 用户在本机按下 agent 的中止热键之后，说给调用方（模型/UI）听的那句「下一步」。
 *
 *  和上面那句的关键差别是**谁该动**：排队超时该由系统自己稍后重试；这一句必须明确说"不重试"，
 *  因为重试就是把用户刚刚亲手叫停的那个动作再做一遍。 */
export const USER_ABORTED_REASON =
  '你在本机按下了中止热键（Ctrl+Alt+Esc），这趟动作已被停下——动作可能已部分执行，先看目标应用的实际状态，需要的话手动重来一次。系统不会自动重试。'

export class DesktopUnavailable extends Error {
  constructor(
    readonly reason: DesktopFailure,
    message: string,
  ) {
    super(message)
    this.name = 'DesktopUnavailable'
  }
}

/**
 * 一趟 `see` 的失败现场：每步的靶子走了哪一段（`seeVia`）、这一趟消化过哪些打断
 * （`dismissed`）。漂移时随记录一起留档（今天的消费方是 `ReplayAdapter.recordSeeContext`，
 * 落 debug bus 的 `host-agent` 频道）。
 *
 * **它不参与判档**（上面那六档只回答"这次动作发出去了但没成"的成因）——这两样是给人事后
 * 重建现场用的：桌面这一侧没有 DevTools、没有 DOM 快照，一步做完屏幕上就什么都不剩了，
 * 而"模板命中却点空"和"模型指错了"的下一步完全不同，光看 driftReason 分不出来。
 *
 * **形状是 `DesktopRunOutcome` 的子集**（结构上兼容，直接传得进来），有意如此：runner 交出
 * 什么，这里就只认什么。曾经这里还有一格 per-step 的 `cacheKey`，而 outcome 里根本没有那个
 * 数——留着它只会让人以为查得到某个模板键，实际永远是 undefined。
 */
export interface SeeFailureContext {
  seeVia?: Record<string, string>
  dismissed?: string[]
}
