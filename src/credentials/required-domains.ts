import type { AuthSpec } from '../manifest/types.ts'

/** The cookie domain an auth spec needs, if any. `cookie:` states it directly; `session:login=cookie`
 *  carries it as `cookieDomain` (the session lives in the cookie snapshot, read from the user's Chrome).
 *  `session:login=qr` also names one, but only as a cheap "is the session gone" probe — it is a
 *  domain we READ, so it must be synced too. */
export function authCookieDomain(auth: AuthSpec | undefined): string | undefined {
  if (!auth) return undefined
  if (auth.type === 'cookie') return auth.domain
  if (auth.type === 'session') return auth.cookieDomain
  return undefined
}

const normalize = (d: string): string => d.trim().toLowerCase().replace(/^\.+/, '')

/**
 * Which cookie domains this Stream instance needs synced, derived from what it actually has
 * installed instead of a hand-kept list.
 *
 * Why this exists: the companion extension decides WHICH domains to read out of Chrome, and until
 * this it did so from a hardcoded default list. Stream already knows the answer — every manifest
 * declares its own `auth` — but nothing carried it to the other end, so adding a login-gated
 * facility (quark) left the extension reading four unrelated domains and the broker answering
 * "no cookie for domain" forever. The failure is silent by construction: a missing domain looks
 * exactly like a logged-out user, and nothing anywhere reports the mismatch.
 *
 * Callers pass the manifests worth syncing for — curated + subscribed, NOT the full RSSHub
 * catalog: the catalog names hundreds of login-gated sites the user never asked for, and this list
 * becomes an instruction to read those cookies out of their browser.
 *
 * `extra` 是**不来自 manifest 的那一类需求**。今天有两个来源，判据是同一条：**谁在消费登录态，
 * 谁就该在这儿有一行**——因为漏掉的表现完全一样，都是拿到空 cookie，而那和"用户没登录"
 * 一字不差，没有任何一处会报错。
 *
 *  1. `config.session_exports`（登录态导出，`session-export.ts`）——它声明的域不是任何
 *     Source 的 auth。
 *  2. **已挂载的能力包**在 `package.json#stream.credentials` 申报的域（收在
 *     `CapabilityHost.credentialDomains()`，接线在 bootstrap 的 `extraCookieDomains`）。
 *     能力包是**一等的登录态消费者**：它在后端进程内经 `streamBrowserCookies` 取 cookie，
 *     与 manifest 的 `auth` 同级，只是申报点是包描述符那一格而不是 manifest。
 *     那一格过安装门（schema 校验 + 确认页逐域点名），所以这里读到的正是用户批准过的名单。
 *
 * 往这里加第四个来源之前先问：那份声明是不是也该在这儿有一行。
 */
export function requiredCookieDomains(
  manifests: Array<{ auth?: AuthSpec } | undefined>,
  extra: string[] = [],
): string[] {
  const out = new Set<string>()
  for (const m of manifests) {
    const d = authCookieDomain(m?.auth)
    if (d) out.add(normalize(d))
  }
  for (const d of extra) if (d) out.add(normalize(d))
  out.delete('')
  return [...out].sort()
}
