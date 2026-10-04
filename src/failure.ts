import { ReplayDriftError } from './replay/interpret.ts'
import { SiteChallengeError } from './adapters/replay/adapter.ts'


// 这两个搬去了 shared/failure/environment.ts（叶子，零 import）——中继要用它，而本文件为了
// classifyError 值引用了 replay 引擎，谁 import 本文件就背上整条引擎。此处保留同名转出，
// 13 个既有消费者的 import 一行不用改。
export { EnvironmentUnavailableError, isEnvironmentUnavailable } from '../shared/failure/environment.ts'

/** Coarse failure class so alerts/Doctor/a future repair agent can act by type. */
export type FailureCategory = 'drift' | 'auth' | 'timeout' | 'network' | 'blocked' | 'empty' | 'unknown'

/** One recorded failure — kept in a rolling per-source history (the "track"). */
export interface FailureRecord {
  at: string
  category: FailureCategory
  message: string
  stack?: string
}

/**
 * Classify a thrown error into a category, preserving BOTH the message and the full
 * stack. `ReplayDriftError` is always `drift` (a recipe/site change, not a blip).
 *
 * Node's `fetch()` throws a terse `TypeError: fetch failed` and hides the ACTUAL reason
 * (ECONNREFUSED / ENOTFOUND / connect-timeout / TLS …) in `error.cause`. We walk the whole
 * cause chain so the recorded message names the real failure instead of "fetch failed",
 * and classify on the enriched text. Order matters: cookie/login (auth) is checked before
 * the generic 4xx (blocked) so an expired-cookie failure reads as `auth`, not `blocked`.
 */
const CATEGORIES: readonly FailureCategory[] = ['drift', 'auth', 'timeout', 'network', 'blocked', 'empty', 'unknown']

/**
 * 一个错误可以**自报分类**：带 `failureCategory` 就按它说的算，不进下面那串正则。
 *
 * 这是个通用接缝：任何"我们自己知道答案"的错误都能跳过嗅探，不必再往 `classifyError` 里堆
 * import——`CoolingDownError`（`facility-cooldown.ts`）就是这么接的。
 *
 * **别改成在这里 `instanceof` 各家错误类**：那需要本文件反向 import 它们，而这类"错误类定义在
 * 下游、分类逻辑在上游"的结构一旦成环，是在模块初始化期求值的，运行时直接炸
 * 「Class extends value undefined」（真炸过一次）。自报字段没有这个风险。
 */
export interface DeclaresFailureCategory { readonly failureCategory: FailureCategory }

function declaredCategory(e: unknown): FailureCategory | undefined {
  const c = (e as Partial<DeclaresFailureCategory> | null | undefined)?.failureCategory
  return typeof c === 'string' && CATEGORIES.includes(c) ? c : undefined
}

export function classifyError(e: unknown): { category: FailureCategory; message: string; stack?: string } {
  const err = e instanceof Error ? e : new Error(String(e))
  const parts: string[] = []
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur)
    const code = (cur as { code?: unknown }).code
    const seg = typeof code === 'string' && !cur.message.includes(code) ? `${cur.message} (${code})` : cur.message
    if (seg && seg !== parts[parts.length - 1]) parts.push(seg)
    cur = (cur as { cause?: unknown }).cause
  }
  const message = parts.join(': ') || String(e)
  const hay = parts.join(' ')

  let category: FailureCategory = 'unknown'
  if (e instanceof ReplayDriftError) category = 'drift'
  // **按类型判，排在所有正则前面。** 下面那串嗅探是给"世界上任何一个上游"用的近似判断，
  // 而这一档我们自己知道答案，不该去猜——更要命的是猜会猜反：`auth` 那条正则里有 `登录`
  // 和 `login`，而一句诚实的挑战文案（"不是登录失效，无需重新登录"）恰好含这两个词，
  // 于是会被 `auth` 先抢走，落进重登面板（`facility-auth-view` 收人的判据正是 category==='auth'），
  // 请用户去扫一个根本没问题的码。`blocked`（"被拦截/限流"）本来就是它该去的那一档。
  //
  // `CoolingDownError` 同理，而且它更阴：它的消息里嵌着**上一次被拦的原因**，那句话说什么
  // 完全不由我们控制——`because` 里只要出现"登录墙"三个字（`needsLogin` 那一档的默认理由
  // 就是「撞上登录墙/拦截页」），整条冷却错误就会被判成 auth，把一个"我们自己在等"的状态
  // 送进重登面板。活体里它这次侥幸落对了 `blocked`，仅仅因为 `because` 恰好含"风控"二字
  // ——**靠运气对的判据等于没有判据**。
  else if (e instanceof SiteChallengeError) category = 'blocked'
  else if (declaredCategory(e)) category = declaredCategory(e)!
  else if (/timeout|timed out|ETIMEDOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT/i.test(hay)) category = 'timeout'
  else if (/non-JSON|登录|登陆|cookie|login|sign in|unauthor|\b401\b|\b403\b|\b422\b|forbidden/i.test(hay)) category = 'auth'
  else if (/HTTP 4\d\d|\b429\b|\b412\b|blocked|captcha|rate.?limit|风控|verify/i.test(hay)) category = 'blocked'
  else if (/net::|ECONN|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|fetch failed|socket hang up|UND_ERR/i.test(hay)) category = 'network'
  return { category, message, stack: err.stack }
}
