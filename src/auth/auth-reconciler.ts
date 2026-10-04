import type { LoginState } from '../replay/recipe.ts'
import type { SessionPrecheck } from './session-precheck.ts'

/** 一个当前挂着「需要登录」横幅的 facility，连同它名下要一起撤标记的源。 */
export interface AuthNeedRow {
  facility: string
  sourceIds: string[]
}

export interface AuthReconcileDeps {
  /** 现在有哪些 facility 挂着横幅（健康账本的投影）。空 → 直接返回，一次远程都不发。 */
  needs(): AuthNeedRow[]
  /**
   * 这个 facility 的 lane 还活着的话，在**那个真页面**上跑一次 loginCheck 三态判定。
   * 没有 lane（或探不通）→ undefined，交给下面的 cookie 证据。
   */
  liveVerdict(facility: string): Promise<LoginState | undefined>
  /** cookie 证据：`PRESENT`=声明的会话 cookie 在，`GONE`=确定不在，`UNKNOWN`=问不出来。 */
  cookieEvidence(facility: string): Promise<SessionPrecheck>
  /** 撤掉这个源的 auth 失败标记；返回是否真的撤了（本来就不在 → false）。 */
  clear(sourceId: string): boolean
  /** 有任何一个标记真的被撤掉时调一次，用来把新状态推给前端。 */
  onChanged(): void
}

/**
 * 不跑采集，只核对一次「这些 facility 是不是其实已经登录回来了」。
 *
 * **为什么需要它**：横幅原来只在一次采集跑完时更新（bootstrap 的 `onOutcome`）。定时采集的源
 * 靠下一轮 tick 自己翻过来；但**只有搜索才跑的源没有任何东西会自己跑**——用户在浏览器里登录
 * 回来了，Stream 一直挂着旧结论，用户必须先搜一次才会发现横幅是陈的。判据是活的，展示是缓存
 * 的，中间这段空窗期在骗人。
 *
 * **证据阶梯，贵的优先**（都很便宜，但准确度差一档）：
 *
 * 1. lane 还活着 → 在真页面上跑 `loginCheck`。这是**证明**：页面上有没有登录墙，它说了算。
 * 2. 没有 lane → 只剩 cookie。cookie 回来了是**证据不是证明**（服务端可能早把会话作废了）。
 *
 * **撤错了会怎样**：下一次真正采集撞上登录墙，横幅自己重新点亮——自愈，代价是一次白跑。
 * 反过来（不撤）的代价是横幅永远挂着。**所以这个方向是刻意选的**：宁可偶尔早撤一次，
 * 不要一个永远撤不掉的提示。
 *
 * **但「问不出来」绝不能当成登录成功**（`UNKNOWN` 一律保持横幅）：那等于用户一夜没开电脑、
 * 第二天所有登录提示自己消失，而会话其实全过期了。这一格和 `isEnvironmentUnavailable` 守的是
 * 同一条边界——不知道就是不知道，不能拿它当任何一边的结论。
 */
export async function reconcileAuth(deps: AuthReconcileDeps): Promise<void> {
  const rows = deps.needs()
  if (!rows.length) return
  let changed = false
  for (const row of rows) {
    let loggedIn = false
    try {
      const live = await deps.liveVerdict(row.facility)
      if (live === 'LOGGED_IN') loggedIn = true
      else if (live === 'WALLED') continue // 真页面说还在墙上 —— 不用再问 cookie
      else loggedIn = (await deps.cookieEvidence(row.facility)) === 'PRESENT'
    } catch {
      continue // 探测本身出错 = 不知道 = 保持横幅
    }
    if (!loggedIn) continue
    for (const id of row.sourceIds) if (deps.clear(id)) changed = true
  }
  if (changed) deps.onChanged()
}
