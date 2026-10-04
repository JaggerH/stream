import { isSessionAuth, type AuthSpec } from '../manifest/types.ts'

/**
 * `GONE` = 会话确定不在（当场 decline，连标签都不用开）。
 * `PRESENT` = 声明的会话 cookie **在**。注意它**不等于"已登录"**——服务端可能早把会话作废了；
 *   它只是"值得去真页面确认一次"。
 * `UNKNOWN` = 问不出来（没声明 / 读失败 / 扩展没连）。**绝不能当成任何一边。**
 *
 * 为什么要把 PRESENT 和 UNKNOWN 分开（原来两个都叫 MAYBE）：撤掉「需要登录」横幅时，
 * 「cookie 回来了」是证据，「我问不出来」不是。合成一个值，撤横幅就会在扩展离线时误撤。
 */
export type SessionPrecheck = 'GONE' | 'PRESENT' | 'UNKNOWN'

/**
 * The cheap half of login detection: does the browser still hold ANY of the cookies this facility
 * declared as carrying its session?
 *
 * It is deliberately lopsided. A missing cookie proves there is no session, so `GONE` lets the
 * caller decline before paying for a tab + navigation + render. A present cookie proves nothing —
 * the server may have killed the session — so the positive case is only ever `PRESENT`, and the
 * authoritative answer stays with the recipe's `loginCheck` on a real page.
 *
 * Everything that is not a proven absence returns `PRESENT`/`UNKNOWN`, never `GONE`. Turning "the
 * extension is not connected" into "logged out" is exactly the mistake `isEnvironmentUnavailable`
 * exists to prevent in the scheduler: the user closes their laptop for a night and wakes up to
 * every ext-cdp facility reported as signed out.
 */
export async function sessionPrecheck(
  auth: AuthSpec,
  cookieNames: (domain: string) => Promise<string[]>,
): Promise<SessionPrecheck> {
  if (!isSessionAuth(auth) || auth.login !== 'qr') return 'UNKNOWN'
  const { cookieDomain, sessionCookies } = auth
  // Not configured — an empty list means "nobody told me what to look for", NOT "nothing is
  // there". The fast path is an optimisation; a facility that skips it just pays full price.
  if (!cookieDomain || !sessionCookies?.length) return 'UNKNOWN'
  try {
    const present = new Set(await cookieNames(cookieDomain))
    return sessionCookies.some((n) => present.has(n)) ? 'PRESENT' : 'GONE'
  } catch {
    return 'UNKNOWN' // can't ask ⇒ don't know ⇒ don't claim
  }
}
