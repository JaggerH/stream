/** 每源一个熔断器（spec §5）：只回答"这个成员这一下试不试"。
 *  - 永远不重排——顺序是用户在 Provider 行里定的，这里无权动它。
 *  - 只有错/超时触发（账本里 lastOutcome === 'error'；超时在管道里也记成 error+category:timeout）。
 *    **空永不触发**：空是业务信号（"这个 key 在这个源没有答案"），很快返回空的源恰恰证明它活着。
 *  - 冷却随连败递增、有封顶。封顶是"不会永久降级"的数学保证：最坏情况死源每个封顶周期被真实
 *    试探一次；探针 = 冷却到期后的下一次正常调用，没有独立探针机制、没有后台定时器。
 *  - 状态零新增：冷却从账本现成字段（lastAt/consecutiveError）推算。成功即复位也由账本承担
 *    （record ok 时 consecutiveError 清零）。 */
export const BREAKER_COOLDOWN_LADDER_MS: readonly number[] = [30_000, 120_000, 600_000]
export const BREAKER_COOLDOWN_CAP_MS = 1_800_000

export type Admission = { allow: true } | { allow: false; retryInMs: number }

/** 兜底不变量本体（spec §5）：一表裁决里**全员冷却**时，强行放行冷却剩余最短的那一格——
 *  一次调用至少真实试一个成员，绝不"什么都没试就回空"。取"剩余最短"而不是"原序第一个"：
 *  原序第一个可能还要等 30min，而末档 3s 后就到期，探它才是最快拿到答案的那一下。并列取靠前的。
 *
 *  就地改传进来的数组并返回它。**这是这条不变量唯一的实现**——`SourceBreaker.plan()`（
 *  ResolveEngine 走它）与顺次策略（它自己逐成员 admit，因为组合成员要豁免）都吃这一份；
 *  两边曾各写一份逐字相同的代码，不变量靠"两处都记得"维持。 */
export function forceProbeShortest(admissions: Admission[]): Admission[] {
  if (!admissions.length || admissions.some((a) => a.allow)) return admissions
  let probe = 0
  for (let i = 1; i < admissions.length; i++) {
    if ((admissions[i] as { retryInMs: number }).retryInMs < (admissions[probe] as { retryInMs: number }).retryInMs) probe = i
  }
  admissions[probe] = { allow: true }
  return admissions
}

export interface BreakerHealthView {
  get(sourceId: string): { lastOutcome: 'ok' | 'empty' | 'error'; consecutiveError: number; lastAt: string } | undefined
}

export class SourceBreaker {
  constructor(
    private readonly health: BreakerHealthView | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  admit(sourceId: string): Admission {
    const h = this.health?.get(sourceId)
    if (!h || h.lastOutcome !== 'error' || h.consecutiveError < 1) return { allow: true }
    const idx = h.consecutiveError - 1
    const cooldown = idx < BREAKER_COOLDOWN_LADDER_MS.length ? BREAKER_COOLDOWN_LADDER_MS[idx] : BREAKER_COOLDOWN_CAP_MS
    const elapsed = this.now() - Date.parse(h.lastAt)
    if (!(elapsed < cooldown)) return { allow: true } // NaN（坏时间戳）按放行处理——宁可多试不可锁死
    return { allow: false, retryInMs: cooldown - elapsed }
  }

  /** 一整条梯子/成员表的裁决预计算：输入按序的 source id，输出同序的裁决数组，内含兜底不变量
   *  （`forceProbeShortest`——全员冷却时强行探剩余最短那一格）。ResolveEngine 走这一条；
   *  顺次策略因为要豁免组合成员（不进源健康账本）而自己逐成员 `admit`，再吃同一份不变量。
   *  策略语义不进熔断器。 */
  plan(sourceIds: readonly string[]): Admission[] {
    return forceProbeShortest(sourceIds.map((id) => this.admit(id)))
  }
}
