export interface ReplayCookie {
  name: string
  value: string
  domain: string
  path: string
}

/**
 * Strip douyin's `__ac_*` anti-bot tokens (`__ac_nonce` / `__ac_signature`) from a raw Cookie
 * header. Those are session/nonce-bound and short-lived — the snapshot carries a STALE pair, and
 * injecting it makes douyin serve a 验证码中间页 (captcha). Dropping them lets the page's own JS
 * mint a fresh pair on load. Harmless for sites without `__ac_*` (a no-op). See the douyin
 * cookie-injection login path.
 */
export function stripAcTokens(header: string): string {
  return header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('__ac_'))
    .join('; ')
}

/**
 * Split a raw "a=b; c=d" Cookie header into domain-scoped cookie objects (path "/").
 *
 * The domain gets a LEADING DOT. Without it Chromium stores a HOST-ONLY cookie, which it
 * sends only to the apex itself — never to the subdomain the site actually runs on. A
 * `cookieDomain: 'quark.cn'` injection was therefore invisible to `pan.quark.cn` and
 * `drive-pc.quark.cn`: every page loaded as a guest (drive API answered `401 require login
 * [guest]`) even though the jar looked correctly populated. `.quark.cn` matches the apex AND
 * every subdomain, which is what a broker cookie for a facility always means. Playwright's
 * `context.cookies(url)` filter does NOT model host-only scoping and reports such cookies as
 * visible to subdomains — so trust `document.cookie` / a real request, not that read-back.
 */
export function parseCookieHeader(header: string, domain: string): ReplayCookie[] {
  const scoped = domain.startsWith('.') ? domain : `.${domain}`
  const cookies: ReplayCookie[] = []
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (!name) continue
    cookies.push({ name, value, domain: scoped, path: '/' })
  }
  return cookies
}
