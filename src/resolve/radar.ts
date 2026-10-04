import type { Registry } from '../registry/registry.ts'

/** Lowercase a host and drop a single leading `www.`. */
export function normHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '')
}

/** Parse a pasted URL into host/pathname/query. Folds a leading `#/` SPA hash
 *  (e.g. `example.com/#/song?id=1`) into pathname + query so hash-routed pages
 *  match. Returns null for anything that isn't an http(s) URL. */
export function parseUrl(input: string): { host: string; pathname: string; query: URLSearchParams } | null {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  let pathname = u.pathname
  const query = new URLSearchParams(u.search)
  if (u.hash.startsWith('#/')) {
    const h = u.hash.slice(1)
    const qi = h.indexOf('?')
    pathname = qi >= 0 ? h.slice(0, qi) : h
    if (qi >= 0) for (const [k, v] of new URLSearchParams(h.slice(qi + 1))) query.set(k, v)
  }
  return { host: normHost(u.hostname), pathname, query }
}

/** Split a radar `source` ("host/path") at the first slash; path defaults to "/". */
export function splitSource(source: string): { host: string; path: string } {
  const i = source.indexOf('/')
  if (i < 0) return { host: normHost(source), path: '/' }
  return { host: normHost(source.slice(0, i)), path: source.slice(i) || '/' }
}

/** Match a path template (`:name`, `:name?`) against a concrete pathname, extracting
 *  named params. Exact segment count; a trailing optional param may be absent.
 *  Returns the params, or null if it doesn't match. */
export function matchTemplate(template: string, pathname: string): Record<string, string> | null {
  const t = template.split('/').filter(Boolean)
  const p = pathname.split('/').filter(Boolean)
  const params: Record<string, string> = {}
  let pi = 0
  for (const seg of t) {
    const optional = seg.endsWith('?')
    if (seg.startsWith(':')) {
      const name = seg.slice(1, optional ? -1 : undefined).replace(/\{.*\}$/, '')
      if (pi < p.length) params[name] = decodeURIComponent(p[pi++])
      else if (!optional) return null
    } else {
      if (pi < p.length && p[pi] === seg) pi++
      else return null
    }
  }
  return pi === p.length ? params : null
}

export interface RadarMatch {
  sourceId: string
  params: Record<string, string>
  title: string
  /** the source's cookie-auth domain, when it needs login — lets the extension offer to
   *  sync that domain's cookie for a login-gated candidate. Absent for public sources. */
  authDomain?: string
}

export interface RadarResult {
  input: string
  matches: RadarMatch[]
  fallback: 'generic-url' | 'unknown'
}

interface RadarPattern {
  host: string
  path: string          // source path template, e.g. "/user/profile/:user_id"
  target?: string       // route-template specialization, e.g. "/user/:user_id/notes"
  ownerId: string       // manifest id this rule was declared on = the resolved source
  ownerRoute?: string   // manifest.route (for target-literal alignment)
  schema: Record<string, unknown>  // owner params_schema
  title: string
  authDomain?: string   // owner's cookie-auth domain (login-gated sources only)
  specificity: number   // static segments in the source path — higher ranks first
  native: boolean       // non-catalog (no `route`) → ranks before catalog
}

/** Align a `target` template to the owner route path and return the literal params
 *  (route seg is `:name`, target seg is a literal) — e.g. route
 *  `/xiaohongshu/user/:user_id/:category/:routeParams?` + target `/user/:user_id/notes`
 *  → { category: 'notes' }. The route's leading namespace segment is dropped so it
 *  aligns with the (namespace-less) target. */
function targetLiterals(ownerRoute: string | undefined, target: string | undefined): Record<string, string> {
  if (!ownerRoute || !target) return {}
  const r = ownerRoute.split('/').filter(Boolean).slice(1) // drop namespace segment
  const t = target.split('/').filter(Boolean)
  const out: Record<string, string> = {}
  for (let i = 0; i < r.length && i < t.length; i++) {
    if (r[i].startsWith(':') && !t[i].startsWith(':')) {
      out[r[i].slice(1).replace(/[?{].*$/, '')] = decodeURIComponent(t[i])
    }
  }
  return out
}

/** Build the host→patterns index from every manifest carrying radar (both producers). */
export function buildRadarIndex(registry: Registry): Map<string, RadarPattern[]> {
  const index = new Map<string, RadarPattern[]>()
  for (const m of registry.all()) {
    for (const rule of m.radar ?? []) {
      for (const source of rule.source) {
        const { host, path } = splitSource(source)
        const specificity = path.split('/').filter((s) => s && !s.startsWith(':')).length
        const pat: RadarPattern = {
          host, path, target: rule.target, ownerId: m.id, ownerRoute: m.route,
          schema: m.params_schema ?? {}, title: m.description || m.id,
          authDomain: m.auth.type === 'cookie' ? m.auth.domain : undefined,
          specificity, native: !m.route,
        }
        const bucket = index.get(host)
        if (bucket) bucket.push(pat)
        else index.set(host, [pat])
      }
    }
  }
  return index
}

/** Assemble the owner route's params from the source match ∪ query ∪ target literals.
 *  Returns null if a required param stays unbound (can't build a usable member).
 *  v1 limitation: params bind by NAME — a source capture (or query key) fills a route
 *  param only when their names match. `target` supplies literal specializations, not
 *  param renames, so a rule like source `/:mid` → target `/user/:uid` would leave `uid`
 *  unbound and drop the match. Real RSSHub rules use matching names, so this holds today. */
function assembleParams(
  pat: RadarPattern,
  sourceParams: Record<string, string>,
  query: URLSearchParams,
): Record<string, string> | null {
  const literals = targetLiterals(pat.ownerRoute, pat.target)
  const out: Record<string, string> = {}
  for (const [name, spec] of Object.entries(pat.schema)) {
    const required = !!(spec && typeof spec === 'object' && (spec as Record<string, unknown>).required === true)
    const v = literals[name] ?? sourceParams[name] ?? query.get(name) ?? undefined
    if (v != null) out[name] = String(v)
    else if (required) return null
  }
  return out
}

/** URL → the concrete Stream sources that can ingest it, across the whole registry. */
export class RadarMatcher {
  private readonly index: Map<string, RadarPattern[]>
  constructor(registry: Registry) {
    this.index = buildRadarIndex(registry)
  }

  match(input: string): RadarResult {
    const parsed = parseUrl(input)
    if (!parsed) return { input, matches: [], fallback: 'unknown' }
    const patterns = this.index.get(parsed.host) ?? []
    const matches: Array<RadarMatch & { _spec: number; _native: boolean }> = []
    for (const pat of patterns) {
      const sourceParams = matchTemplate(pat.path, parsed.pathname)
      if (!sourceParams) continue
      const params = assembleParams(pat, sourceParams, parsed.query)
      if (!params) continue
      matches.push({ sourceId: pat.ownerId, params, title: pat.title, ...(pat.authDomain ? { authDomain: pat.authDomain } : {}), _spec: pat.specificity, _native: pat.native })
    }
    // rank: native before catalog, then higher specificity; dedupe by sourceId
    matches.sort((a, b) => Number(b._native) - Number(a._native) || b._spec - a._spec || a.sourceId.localeCompare(b.sourceId))
    const seen = new Set<string>()
    const ranked: RadarMatch[] = []
    for (const m of matches) {
      if (seen.has(m.sourceId)) continue
      seen.add(m.sourceId)
      ranked.push({ sourceId: m.sourceId, params: m.params, title: m.title, ...(m.authDomain ? { authDomain: m.authDomain } : {}) })
    }
    return { input, matches: ranked, fallback: 'generic-url' }
  }
}
