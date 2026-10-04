import { NeedsLoginError, SiteChallengeError } from './adapters/replay/adapter.ts'
import { CoolingDownError } from './replay/facility-cooldown.ts'
import { isEnvironmentUnavailable } from './failure.ts'
import { LaneBusyForLoginError } from './replay/session-manager.ts'

/**
 * Why a member produced nothing when the cause is a **missing precondition** rather than a
 * failure — something the user can fix, and the UI can offer a button for.
 *
 * `login`    — the facility's session is gone; the fix is scanning a QR / logging in.
 * `extension` — the browser extension is not connected; the fix is installing/connecting it.
 * `cooldown`  — **没有 fix，也不该有按钮**：站方在限流/挑战，我们的闸门正在退让，到点自动重试。
 *               它和 `login` 是这份联合里唯一一对会被搞混的——搞混的代价是把用户支去重登一个
 *               完全正常的账号，所以它们必须是两个 kind，而不是同一个 kind 配两句文案。
 */
export type BlockedReason =
  | { kind: 'login'; facility: string; label: string }
  | { kind: 'extension' }
  /**
   * 站方在限流/挑战我们，**我们自己的闸门正在退让**——用户什么都不用做，到点自动重试。
   *
   * 它**故意不带任何可点的动作**：这一档的正确 UI 是一句说得出"还剩多久"的话，不是按钮。
   * "不画登录按钮"因此是**类型层面的事实**，不是渲染处的一个 `if`——少一个将来会被漏掉的条件。
   * `facility`/`label` 只为把话说具体（"抖音 正在限流"），不是登录流程的入口。
   */
  | { kind: 'cooldown'; facility: string; label: string; retryAfterMs?: number }

/**
 * Read a blocked reason off a thrown error, or `undefined` if it is an ordinary failure.
 *
 * Typed markers only — deliberately NOT message matching. `classifyError` sniffs text because it
 * has to work on errors from every upstream in the world, and it is fine for it to be
 * approximately right about a health colour. This is not that: a false positive here renders a
 * "log in" button with no login flow behind it, because the whole point is that the caller acts
 * on the answer. An error is blocked only if it says so in its own type.
 */
export function blockedOf(e: unknown): BlockedReason | undefined {
  if (e instanceof NeedsLoginError) {
    // No facility ⇒ nothing `startLogin` could target ⇒ no actionable button. Let it read as an
    // ordinary failure instead of offering an action that would do nothing.
    if (!e.facility) return undefined
    return { kind: 'login', facility: e.facility, label: e.label ?? e.facility }
  }
  // 登录面板正开着、占着这个 facility 的浏览器 —— 对搜索来说这就是"需要登录"，而且是**同一个
  // 按钮**能解决的事。让它读作普通失败会把唯一可操作的信息盖掉（用户看到的会是"这个源超时"）。
  if (e instanceof LaneBusyForLoginError) return { kind: 'login', facility: e.facility, label: e.facility }
  // 站方在挑战：登录态好好的，不给登录按钮（见 `cooldown` 那一档的注释）。
  if (e instanceof SiteChallengeError && e.facility) {
    return { kind: 'cooldown', facility: e.facility, label: e.label ?? e.facility, retryAfterMs: e.retryAfterMs }
  }
  // **这一条必须排在 `isEnvironmentUnavailable` 前面。** `CoolingDownError` 继承
  // `EnvironmentUnavailableError`，落到下一行就会被报成"扩展没连接"——而真相是**我们自己的闸门
  // 在等**，跟扩展毫无关系。那句话会把用户支去查一个完全正常的扩展，比"需要重新登录"还离谱。
  // `remainingMs` 是它自己早算好的数，直接用，别在别处重算一个。
  if (e instanceof CoolingDownError) {
    return { kind: 'cooldown', facility: e.facility, label: e.facility, retryAfterMs: e.remainingMs }
  }
  if (isEnvironmentUnavailable(e)) return { kind: 'extension' }
  return undefined
}
