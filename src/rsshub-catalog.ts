import { readFileSync } from 'fs'
import type { SourceManifest, Facility, RadarRule, AuthSpec } from './manifest/types.ts'
import type { NamespaceClaim } from './replay/recipe-package.ts'

/**
 * Ingest RSSHub's built route catalog (assets/build/routes.json) into browsable
 * source manifests — so the Channels picker can offer RSSHub's full catalog
 * (~3000 routes) instead of just our hand-written ones, without forking RSSHub.
 *
 * Routes that require Puppeteer are skipped: our runtime has no Chromium, so
 * they would be dead channels.
 */

interface RawRoute {
  path: string | string[]
  name?: string
  categories?: string[]
  parameters?: Record<string, unknown>
  // requireConfig is a boolean in older RSSHub, an array of config descriptors in current builds.
  features?: { requirePuppeteer?: boolean; requireConfig?: boolean | unknown[]; nsfw?: boolean }
  example?: string
  /** the route's markdown usage notes (param help, login caveats, column lists) */
  description?: string
  /** the source site homepage (e.g. "81rc.81.cn") */
  url?: string
  /** RSSHub Radar rules — which site URLs this route claims (`source`) and the route it maps to.
   *  We ingest the union of `source` strings into manifest.matchers for {mode:'auto', matches} expansion.
   *  Real RSSHub data is loose: `radar` may be a single rule object (not an array), and a rule's
   *  `source` may be a bare string (not an array). Both are normalized below. */
  radar?: RawRadarRule | RawRadarRule[]
}

interface RawRadarRule {
  source?: string | string[]
  target?: string
}

/** Normalize RSSHub's loose `radar` field to an array of rules (object → single-element array). */
function radarRules(radar: RawRoute['radar']): RawRadarRule[] {
  if (!radar) return []
  return Array.isArray(radar) ? radar : [radar]
}

/** Normalize a rule's loose `source` (string | string[] | absent) to a clean string[]. */
function ruleSources(source: RawRadarRule['source']): string[] {
  if (Array.isArray(source)) return source.filter((s): s is string => typeof s === 'string')
  return typeof source === 'string' ? [source] : []
}

/** Union of all radar `source` patterns on a route (deduped). Empty → omit matchers. */
function collectMatchers(radar: RawRoute['radar']): string[] | undefined {
  const set = new Set<string>()
  for (const rule of radarRules(radar)) for (const s of ruleSources(rule.source)) if (s) set.add(s)
  return set.size ? [...set] : undefined
}

/** Keep the full radar rules (source + target) — the structured form the radar matcher needs.
 *  `collectMatchers` (the flattened source strings) stays for Provider `{mode:'auto', matches}`
 *  grouping. Rules with no usable source string are dropped; empty → omit. */
function collectRadar(radar: RawRoute['radar']): RadarRule[] | undefined {
  const rules = radarRules(radar)
    .map((r) => ({ source: ruleSources(r.source), target: r.target }))
    .filter((r) => r.source.length > 0)
  return rules.length ? rules : undefined
}

/** Strip RSSHub's markdown container directives (`::: tip` … `:::`) so the notes read as
 *  plain prose in our (no-markdown) detail panel; collapse blank runs. */
function cleanNotes(s: string | undefined): string | undefined {
  if (!s) return undefined
  const out = s
    .replace(/^:::\s*\w+.*$/gm, '') // opening ::: tip / ::: warning fences
    .replace(/^:::\s*$/gm, '') // closing fences
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return out || undefined
}
interface RawNamespace {
  name?: string
  routes?: Record<string, RawRoute>
}

/** Build params_schema from a route path's `:token` / `:token?` + parameter docs. */
function pathParams(path: string, parameters: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const re = /:([a-zA-Z0-9_]+)(\??)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(path))) {
    const [, name, opt] = m
    const p = parameters[name]
    if (typeof p === 'string') {
      out[name] = { type: 'string', required: opt !== '?', description: p }
      continue
    }
    const spec = p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : {}
    out[name] = {
      type: 'string',
      required: opt !== '?',
      description: typeof spec.description === 'string' ? spec.description : '',
      ...(typeof spec.default === 'string' ? { default: spec.default } : {}),
      ...(Array.isArray(spec.options) ? { options: spec.options } : {}),
    }
  }
  return out
}

const SEARCH_PARAMS = new Set(['query', 'keyword', 'q', 'search', 'word', 'searchword', 'kw', 'key'])

/** 宿主自带的命名空间 normalizer。**今天是空的**——一个 facility 的渲染规则住在它自己的包里
 *  （`package.json#stream.rsshubNamespaces`），由 `CatalogOptions.namespaceNormalizers` 传进来。
 *  机制留着：宿主将来要自己认领某个命名空间时往这里加一行，`hostClaimsNamespace` 同一张表，
 *  加一行不会漏掉那道「包认领撞上宿主一律拒」的闸。 */
const NS_NORMALIZER: Record<string, string> = {}

/**
 * 宿主自己已经认领的命名空间——**包认领它一律拒**，不许静默盖过去。
 *
 * 为什么必须拒而不是"包优先"：宿主那条 normalizer 是**代码**，它对应的渲染实现就在仓库里；
 * 一个包只要在 `rsshubNamespaces` 里写上同一个 ns，整批路由就换了一套看不见的渲染规则，
 * 而没有任何一处会喊——表现是"这个源今天渲染对、明天不对"。两个**包**撞同一个 ns 会抛
 * （`rsshubNamespaceNormalizersOf`）；包撞宿主则丢掉那条认领并出声，不掀翻启动。
 *
 * 一个真相源：这个谓词和 `NS_NORMALIZER` 同一张表——默认就是那张表的键集合。第二个参数**只为
 * 测试**开的口子：真实调用（`parseRsshubCatalog`）永远吃默认值，所以生产行为仍然只由
 * `NS_NORMALIZER` 一张表决定；测试借它在表空的今天也能从外部构造出"宿主已认领"的场景，钉住
 * 这道闸的拒绝逻辑本身（拒 + `onRefusedClaim` 出声），不必等宿主往表里加真行的那一天。
 */
export function hostClaimsNamespace(
  ns: string,
  hostNamespaces: ReadonlySet<string> = new Set(Object.keys(NS_NORMALIZER))
): boolean {
  return hostNamespaces.has(ns)
}

/** 一条被拒的命名空间认领（调用方负责出声）。 */
export interface RefusedNamespaceClaim { ns: string; normalizer: string }

/** True when a route declares config requirements (boolean legacy shape or the
 *  array-of-descriptors current shape). Drives the display-only `requireConfig` flag. */
function hasRequireConfig(r: RawRoute): boolean {
  const rc = r.features?.requireConfig
  return Array.isArray(rc) ? rc.length > 0 : rc === true
}

/** The env-var names a route's requireConfig declares (array-of-descriptors shape only —
 *  the legacy boolean shape carries no name, so a boolean-true route can't derive an env
 *  var and stays auth:none). Order-preserving; first name is the cookie env var. */
function requireConfigNames(r: RawRoute): string[] {
  const rc = r.features?.requireConfig
  if (!Array.isArray(rc)) return []
  return rc
    .map((d) => (d && typeof d === 'object' ? (d as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
}

/** True when EVERY config descriptor is `optional` — the route runs without any of them
 *  (youtube's YOUTUBE_KEY: absent → it falls back to scraping). Drives AuthSpec.optional. */
function requireConfigOptional(r: RawRoute): boolean {
  const rc = r.features?.requireConfig
  if (!Array.isArray(rc) || rc.length === 0) return false
  return rc.every((d) => d && typeof d === 'object' && (d as { optional?: unknown }).optional === true)
}

/** Is this config env var fed by a COOKIE (the broker can supply it), or is it an API key /
 *  token / server-policy flag that a cookie must NEVER be stuffed into?
 *
 *  RSSHub's requireConfig mixes both kinds under one field. Feeding a browser cookie string
 *  into `YOUTUBE_KEY` (a Google API key) or `GITHUB_ACCESS_TOKEN` (a PAT) would send garbage
 *  upstream — and declaring them "cookie for domain youtube.com" produces a nonsense error for
 *  a route that needs no cookie at all. Cookie-fed names carry COOKIE / SESSION / AUTH
 *  (ZHIHU_COOKIES, JAVDB_SESSION, TWITTER_AUTH_TOKEN); key-fed ones don't (YOUTUBE_KEY,
 *  SPOTIFY_CLIENT_ID, ALLOW_USER_HOTLINK_TEMPLATE). */
function isCookieFed(name: string): boolean {
  return /COOKIE|SESSION|AUTH/i.test(name)
}

/** Apex domain of one radar `source` host: strip the path (`space.example.com/:uid` →
 *  `space.example.com`), then take the last two labels (`space.example.com` →
 *  `example.com`). Cookie domains are all simple two-label apexes; multi-part public
 *  suffixes (e.g. `*.gov.cn`) collapse imperfectly but are never cookie domains. */
function sourceApex(source: string): string | undefined {
  const host = source.split('/')[0]?.trim().toLowerCase()
  if (!host) return undefined
  const labels = host.split('.').filter(Boolean)
  if (labels.length < 2) return undefined
  return labels.slice(-2).join('.')
}

/** The single apex domain a set of radar `source` strings points at. Dedups by apex,
 *  picks the majority; an empty set or a tie yields undefined (→ auth:none, never a guess).
 *  Exported for unit tests over real radar shapes. */
export function radarApex(sources: string[]): string | undefined {
  const counts = new Map<string, number>()
  for (const s of sources) {
    const apex = sourceApex(s)
    if (apex) counts.set(apex, (counts.get(apex) ?? 0) + 1)
  }
  if (counts.size === 0) return undefined
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return undefined
  return sorted[0][0]
}

/** Derive a route's cookie AuthSpec from its requireConfig name + the namespace's
 *  aggregated radar domain. No requireConfig name → none. Name with `*` (dynamic-key
 *  convention, e.g. `SITE_COOKIE_*`) → transform ref = namespace. Plain name →
 *  env inject. Underivable domain → none + warn (never throw — one messy namespace
 *  must not fail the whole catalog build). */
function deriveCookieAuth(ns: string, r: RawRoute, nsDomain: string | undefined): AuthSpec {
  const names = requireConfigNames(r)
  if (names.length === 0) return { type: 'none' }
  // Only carry `optional` when true — a required credential's AuthSpec keeps its exact prior shape.
  const opt = requireConfigOptional(r) ? { optional: true as const } : {}
  const name = names[0]

  // An API key / token / policy flag is NOT a cookie: never point the cookie broker at it. It resolves
  // from env via TokenProvider when the user configures it, and (when optional) is simply skipped.
  if (!isCookieFed(name)) return { type: 'token', name, ...opt }

  if (!nsDomain) {
    console.warn(`[rsshub-catalog] ${ns}: requireConfig ${names.join(',')} but no derivable domain → auth:none`)
    return { type: 'none' }
  }
  if (name.includes('*')) return { type: 'cookie', domain: nsDomain, inject: { kind: 'transform', ref: ns }, ...opt }
  return { type: 'cookie', domain: nsDomain, inject: { kind: 'env', name }, ...opt }
}

/** 这条 catalog 路由是不是已退役（表由包声明并成，见 CatalogOptions.retired）。 */
export function isRetiredRoute(sourceId: string, retired: ReadonlyMap<string, string>): boolean {
  return retired.has(sourceId)
}

/** A route is "searchable" (can answer a question) if it takes a query-like param
 *  or its path is a search endpoint — vs a plain timeline feed. */
function isSearchRoute(path: string, parameters: Record<string, unknown> = {}): boolean {
  if (/\/search(\/|$|:)/i.test(path)) return true
  return Object.keys(parameters).some((p) => SEARCH_PARAMS.has(p.toLowerCase()))
}

function routeDefinitionKey(ns: string, routePath: string, route: RawRoute): string {
  const paths = Array.isArray(route.path) ? route.path : undefined
  if (!paths || paths.length === 0) return `${ns}:${routePath}`
  return `${ns}:${paths.join('|')}`
}

function joinRoutePath(ns: string, routePath: string): string {
  return `/${ns}${routePath.startsWith('/') ? routePath : `/${routePath}`}`
}

export interface CatalogOptions {
  /** skip routes needing a browser (default true — we have no Chromium) */
  skipPuppeteer?: boolean
  /**
   * `skipPuppeteer` 的例外：上游给这些命名空间的路由标了 `requirePuppeteer`，但它们带 cookie 走纯
   * HTTP 就能跑（Stream 会把它们解析成 cookie 注入，见 `deriveCookieAuth`）。照标记丢掉等于把一批
   * 能用的源整个藏起来，而且没有一处会喊。「这个标记是虚的」是关于**那个站**的事实，所以由认领
   * 它的包声明（`package.json#stream.rsshubNoBrowserNamespaces`），装配层用 `rsshubNoBrowserNamespacesOf`
   * 并成 Set 传进来；宿主不点名任何站。
   */
  noBrowserNamespaces?: ReadonlySet<string>
  /**
   * 退役路由：上游已经让它跑不通、而某个包有自己的实现顶上（那个包在 `package.json#stream.retires`
   * 里声明，装配层用 `retiredRoutesOf` 并表传进来）。命中的路由不进 registry——否则它和包的实现
   * **同名并排**出现在候选里（顶上去的包和被顶掉的路由标题一模一样，比如都叫「某站 — 用户音频」那种），选错就订上一条永远采不到东西、
   * 又不报错的流。名单只放"上游已使它失效"的；"我们更喜欢自己那份"归 `priority`，不归这里。
   */
  retired?: ReadonlyMap<string, string>
  /**
   * 包认领的 RSSHub 命名空间 → normalizer 键（= 认领它的包 facility）。装配层用
   * `rsshubNamespaceNormalizersOf` 并表传进来；与宿主自带的 `NS_NORMALIZER` 合并。
   * **宿主已认领的 ns 上包认领一律被丢弃**（见 `hostClaimsNamespace`），经 `onRefusedClaim` 报出去。
   */
  namespaceNormalizers?: ReadonlyMap<string, NamespaceClaim>
  /** 被丢弃的包认领（撞了宿主表）。不给 = 静默丢，所以装配层必须给。 */
  onRefusedClaim?: (refused: RefusedNamespaceClaim) => void
  /**
   * **只为测试**开的口子——真实调用（装配层）永远不传，落到 `hostClaimsNamespace` 自己的默认值
   * （`NS_NORMALIZER` 的键集合，今天是空集）。宿主表空了之后，「包认领撞上宿主一律拒」这道闸
   * 没法再靠真实数据从外部构造出一次撞车；测试借这个参数在表空的今天也能钉住拒绝逻辑本身
   * （见 `hostClaimsNamespace` 头注）。
   */
  hostNamespaces?: ReadonlySet<string>
}

/** 从**文件**读一份 catalog（检出的 `assets/build/routes.json`，或我们自己落的那份缓存）。 */
export function loadRsshubCatalog(routesJsonPath: string, opts: CatalogOptions = {}): SourceManifest[] {
  return parseRsshubCatalog(JSON.parse(readFileSync(routesJsonPath, 'utf8')) as Record<string, RawNamespace>, opts)
}

/**
 * 从**已经在内存里的那个对象**解析 catalog。
 *
 * 它和上面那个文件版吃的是同一份数据：RSSHub 的 `request('/api/namespace')` 返回的就是
 * `routes.json` 的同一个对象（`scripts/workflow/build-routes.ts` 正是把它 JSON.stringify 出来的）。
 * 发行安装里根本没有 `routes.json`（它是检出的构建产物、不在 npm tarball 里），所以那一档只能
 * 走这条现取的路。
 */
export function parseRsshubCatalog(
  data: Record<string, RawNamespace>,
  opts: CatalogOptions = {}
): SourceManifest[] {
  const skipPuppeteer = opts.skipPuppeteer ?? true
  const retired = opts.retired ?? new Map<string, string>()
  const declaredClaims = opts.namespaceNormalizers ?? new Map<string, NamespaceClaim>()
  // 宿主已认领的 ns 上把包的认领摘掉（先摘再用，两个消费点 label / normalizer 才不会分家）。
  const nsClaims = new Map<string, NamespaceClaim>()
  for (const [ns, claim] of declaredClaims) {
    if (hostClaimsNamespace(ns, opts.hostNamespaces)) { opts.onRefusedClaim?.({ ns, normalizer: claim.normalizer }); continue }
    nsClaims.set(ns, claim)
  }
  const out: SourceManifest[] = []

  for (const [ns, nsObj] of Object.entries(data)) {
    const claim = nsClaims.get(ns)
    const nsName = claim?.label ?? nsObj.name ?? ns
    // Aggregate radar sources across the whole namespace: the requireConfig (login) route
    // frequently carries radar:null while a sibling route holds the site's radar, so the
    // cookie domain must be derived from the namespace union, not the single route.
    const nsRadarSources: string[] = []
    for (const r of Object.values(nsObj.routes ?? {})) {
      for (const rule of radarRules(r.radar)) for (const s of ruleSources(rule.source)) nsRadarSources.push(s)
    }
    const nsDomain = radarApex(nsRadarSources)
    const seenRouteDefinitions = new Set<string>()
    for (const [routePath, r] of Object.entries(nsObj.routes ?? {})) {
      if (skipPuppeteer && r.features?.requirePuppeteer && !opts.noBrowserNamespaces?.has(ns)) continue
      const definitionKey = routeDefinitionKey(ns, routePath, r)
      if (seenRouteDefinitions.has(definitionKey)) continue
      seenRouteDefinitions.add(definitionKey)
      const fullPath = joinRoutePath(ns, routePath) // e.g. /example/link/news/:product
      // 退役路由到此为止：上游已经让它跑不通，留着只会和我们自己的实现并排出现在候选里，
      // 而两者标题一模一样、没人分得出该选哪个（见 CatalogOptions.retired）。
      if (isRetiredRoute(`rsshub:${fullPath.slice(1)}`, retired)) continue
      const categories = r.categories ?? []
      const searchable = isSearchRoute(routePath, r.parameters)
      const requireConfig = hasRequireConfig(r)
      // Login-gated route → derive cookie auth from route data: env var = requireConfig
      // name, domain = namespace radar apex, wildcard name → transform. Underivable → none.
      const auth = deriveCookieAuth(ns, r, nsDomain)
      out.push({
        schema_version: 1,
        id: `rsshub:${fullPath.slice(1)}`,
        adapter: 'rsshub',
        type: 'post',
        description: r.name ? `${nsName} — ${r.name}` : `${nsName} ${routePath}`,
        topics: [ns, ...categories],
        categories,
        facility: { key: ns, label: nsName } as Facility,
        example_queries: r.example ? [r.example] : [],
        capabilities: searchable ? ['search'] : ['timeline'],
        auth,
        params_schema: pathParams(routePath, r.parameters),
        route: fullPath,
        normalizer: claim?.normalizer ?? NS_NORMALIZER[ns],
        // 动态 RSSHub 路由目录的统一默认采集周期：2d（源未自带 hint 时的推荐值）
        cadence_hint_seconds: 172800,
        discoverable: true,
        // RSSHub-catalog enrichment (display-only): usage notes, config/nsfw flags, homepage
        notes: cleanNotes(r.description),
        docsMarkdown: r.description?.trim() || undefined,
        requireConfig,
        nsfw: r.features?.nsfw === true,
        homepage: typeof r.url === 'string' ? r.url : undefined,
        matchers: collectMatchers(r.radar),
        radar: collectRadar(r.radar),
      })
    }
  }
  return out
}
