/** `host` is the domain itself or a subdomain of it — never a suffix lookalike.
 *  A bare `endsWith('example.com')` would happily accept `evil-example.com`.
 *  (Moved here from http-fetch.ts so the jar and the send gate share one matcher;
 *  http-fetch re-exports it, existing importers are unmoved.) */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase()
  const d = domain.toLowerCase().replace(/^\./, '')
  return h === d || h.endsWith(`.${d}`)
}

/**
 * One recipe run's cookie memory — the engine-owned half of "a procedure over a cookie
 * jar" (capability-normalization spec §4.1). Host-bucketed like a browser, so a cookie
 * earned from one site can never ride to another: a recipe whose first step visits
 * evil.com cannot smuggle that cookie onto a quark.cn request. A `Domain` attribute is
 * honoured only when it covers the responding host (the browser rule) — a response
 * claiming someone else's domain degrades to host-only instead of planting there.
 * Lives exactly as long as one makeHttpFetch closure: never persisted, never written back
 * into the user's cookie store.
 */
export class HostCookieJar {
  /** bucket key: bare domain for honoured Domain-attr cookies, `@host` for host-only. */
  private readonly buckets = new Map<string, Map<string, string>>()

  absorb(host: string, setCookies: string[]): void {
    const h = host.toLowerCase()
    for (const sc of setCookies) {
      const [pair, ...attrs] = sc.split(';')
      const eq = pair.indexOf('=')
      if (eq <= 0) continue // no '=' or empty name — not a cookie
      let key = `@${h}`
      for (const attr of attrs) {
        const ai = attr.indexOf('=')
        if (ai < 0) continue
        if (attr.slice(0, ai).trim().toLowerCase() !== 'domain') continue
        const d = attr.slice(ai + 1).trim().toLowerCase().replace(/^\./, '')
        if (d && hostMatchesDomain(h, d)) key = d
      }
      let bucket = this.buckets.get(key)
      if (!bucket) {
        bucket = new Map()
        this.buckets.set(key, bucket)
      }
      bucket.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }

  /** Every cookie this host may see: its own host-only bucket + Domain buckets covering it. */
  cookiesFor(host: string): Map<string, string> {
    const h = host.toLowerCase()
    const out = new Map<string, string>()
    for (const [key, bucket] of this.buckets) {
      const hit = key.startsWith('@') ? key === `@${h}` : hostMatchesDomain(h, key)
      if (hit) for (const [n, v] of bucket) out.set(n, v)
    }
    return out
  }
}
