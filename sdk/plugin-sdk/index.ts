/**
 * @streamapp/plugin-sdk — SDK for Stream third-party package authors: the `activate(ctx)`
 * type contract, plus the small runtime toolkit a package is allowed to bundle.
 *
 * TYPES ARE A LEAF: every type below is declared independently, on purpose. Nothing here
 * imports a type from the Stream host (`src/**`). A third-party package cannot resolve
 * host modules at all — the release backend is a single esbuild-bundled `server.mjs` with
 * no importable path — so `ctx` (see `PluginContext`) is the *entire* host surface a package
 * gets. If this file ever re-exported host types instead of redeclaring them, the `.d.ts`
 * it produces would drag every type those host types reference along with it, and the
 * public surface Stream is promising to package authors would no longer be something
 * anyone decided on purpose.
 *
 * RUNTIME IS A RE-EXPORT OF `shared/package-sdk/`: the error classes (`ValidationError`,
 * `ContentUnavailableError`), pure helpers (`mediaPlayUrl`, the html helpers, `BROWSER_UA`,
 * `compareVersions`). `shared/` is the one place host and packages consume the *same source*;
 * a package bundles these into its own `dist/index.js` (tsdown, `noExternal`), so the host
 * process ends up holding a second copy of each class. That is why the host never checks
 * `instanceof` — the errors carry duck-type markers (`validation: true` / `unavailable: true`)
 * and the host only reads the marker (`isValidationError` / `isUnavailable`). The compat test
 * pins that an SDK-constructed error passes the host's duck check.
 *
 * Because the types are copies, not the source of truth, they CAN drift from the host's real
 * definitions (`src/packages/activate.ts`, `src/adapters/types.ts`, `src/manifest/types.ts`).
 * That drift is caught by a guard test — see `src/packages/plugin-sdk-compat.test.ts` — which
 * asserts bidirectional structural assignability between this file's `PluginContext` and the
 * host's. If you change either side, run that test (and `tsc --noEmit`) before shipping.
 *
 * This package is `private` and consumed as source inside the repo (`types: index.ts`). Publishing
 * it would need `shared/package-sdk/` bundled in (the `files` list is just `index.ts`); that is a
 * separate decision.
 *
 * Design reference: docs/superpowers/specs/2026-08-05-package-unification-design.md §5;
 * runtime surface: docs/superpowers/specs/2026-09-20-code-packages-prebuilt-dist-design.md §2.6.
 */

// ── Runtime (re-exported from shared/package-sdk — host and packages share this source) ──

export {
  ValidationError,
  isValidationError,
  ContentUnavailableError,
  isUnavailable,
  mediaPlayUrl,
  extractImages,
  extractLinks,
  firstLink,
  toText,
  stripImages,
  BROWSER_UA,
  compareVersions,
  isStrictlyHigher,
  parseVersion,
  type ParsedVersion,
} from '../../shared/package-sdk/index.ts'

// ── Manifest types (mirrors src/manifest/types.ts) ─────────────────────────

export type Capability = 'search' | 'timeline' | 'anchor' | 'discover'

export type SourceType = 'post' | 'conversation' | 'email' | 'calendar'

export interface FanOut {
  dimension: string
  strategy: 'batch' | 'window' | 'scatter'
  batch_key: string[]
  window_size?: number
  max_concurrent?: number
}

export interface RadarRule {
  source: string[]
  target?: string
}

export type CookieInject =
  | { kind: 'env'; name: string }
  | { kind: 'transform'; ref: string }

export type SessionAuthSpec =
  | {
      type: 'session'
      facility: string
      login: 'qr'
      loginUrl: string
      qrSelector: string
      cookieDomain?: string
      sessionCookies?: string[]
    }
  | { type: 'session'; facility: string; login: 'cookie'; cookieDomain: string }

export type AuthSpec =
  | { type: 'none' }
  | { type: 'cookie'; domain: string; inject: CookieInject; optional?: boolean }
  | { type: 'token'; name: string; optional?: boolean }
  | SessionAuthSpec

export interface Facility {
  key: string
  label: string
}

export interface ApiQueryParam {
  from: string
  default?: string | number
  required?: boolean
}

export type ApiBinding =
  | { endpoint: string; query?: Record<string, ApiQueryParam>; unwrap?: string; normalize?: string }
  | { handler: string }

export interface RuntimeConfigField {
  type: 'secret' | 'string' | 'boolean'
  label: string
  description?: string
  helpUrl?: string
  required?: boolean
  default?: string | boolean
}

export interface RuntimeConfigSpec {
  ref: string
  fields: Record<string, RuntimeConfigField>
  perInstance?: boolean
  instanceNamespace?: string
}

/** A source manifest — same shape as `SourceManifest` in `src/manifest/types.ts`.
 *  A package's `activate()` never constructs one of these itself (that stays in
 *  `stream.code`'s declarative manifest files); this exists so an `Adapter.fetch`
 *  implementation can type its `manifest` parameter. */
export interface SourceManifest {
  schema_version: number
  id: string
  title?: string
  pluginId?: string
  pluginName?: string
  adapter: string
  type: SourceType
  description: string
  topics: string[]
  categories?: string[]
  facility?: Facility
  example_queries: string[]
  capabilities: Capability[]
  output?: 'items' | 'object'
  auth: AuthSpec
  params_schema: Record<string, unknown>
  runtime_config?: RuntimeConfigSpec
  route?: string
  cadence_hint_seconds: number
  discoverable: boolean
  normalizer?: string
  /** @deprecated legacy alias for `normalizer` */
  presenter?: string
  fan_out?: FanOut
  mode?: 'feed' | 'collection'
  notes?: string
  docsMarkdown?: string
  requireConfig?: boolean
  nsfw?: boolean
  homepage?: string
  matchers?: string[]
  radar?: RadarRule[]
  provides?: string[]
  priority?: number
  key_param?: string
  fixed_params?: Record<string, unknown>
  api?: ApiBinding
}

// ── Adapter types (mirrors src/adapters/types.ts) ──────────────────────────

export interface SourceExecutionContext {
  runtimeConfig: Record<string, unknown>
}

export interface AdapterFetchResult {
  items: unknown[]
  title?: string
  authoritative?: boolean
}

/** An auxiliary long-lived process an adapter owns (e.g. a signing/harvesting browser).
 *  Stream's own scheduler starts/health-gates/tears it down; a third-party package's
 *  adapter may leave this undefined if it doesn't need one. */
export interface AdapterSidecar {
  start(creds: Record<string, string>): Promise<void>
  health(): Promise<boolean>
  shutdown(): Promise<void>
}

/** An adapter is an execution backend. `ctx.log`/`ctx.cookieFor`/etc. (see `PluginContext`)
 *  are how it reaches anything outside its own package. */
export interface Adapter {
  /** matches `SourceManifest.adapter` */
  id: string
  /** apply credential env overrides before any fetch (idempotent) */
  init(envOverrides: Record<string, string>): Promise<void>
  fetch(
    params: Record<string, unknown>,
    manifest: SourceManifest,
    context?: SourceExecutionContext,
  ): Promise<unknown[] | AdapterFetchResult>
  sidecar?: AdapterSidecar
  follow?(userId: string): Promise<void>
  unfollow?(userId: string): Promise<void>
}

// ── Normalizer (mirrors src/content/normalize.ts's Normalizer shape) ───────

/** Maps one adapter-raw item (plus the manifest it came from) to Stream's Content shape.
 *  Kept as `unknown` in/out deliberately — `RawItem` and `Content` are host-internal
 *  types, and a normalizer is data-in/data-out with no other host surface, so nothing
 *  is lost by not typing them more tightly than that. */
export type Normalizer = (raw: unknown, manifest: SourceManifest) => unknown

// ── activate() contract (mirrors src/packages/activate.ts) ────────────────

/** A web page's extracted body, as `ctx.readArticle` returns it (mirrors the host's
 *  `ReadArticleResult`). `html` is not guaranteed clean — the host sanitizes whatever an
 *  enricher hands back, so pass it through as-is. */
export interface ArticleContent {
  sourceUrl: string
  title?: string
  author?: string
  /** ISO-ish publish date string as reported by the page metadata */
  published?: string
  html?: string
  text?: string
  excerpt?: string
  leadImage?: string
  wordCount?: number
  domain?: string
}

/**
 * The entire capability surface a Stream package gets. There is no other door — a
 * third-party package cannot `import` anything from the host, so whatever this
 * interface doesn't expose, the package cannot do.
 */
export interface PluginContext {
  /** This package's declared backend service's reachable address (compose-network
   *  container DNS, or a host-mode loopback port). Packages with no backend get
   *  `undefined`. */
  backendUrl: (service?: string) => string | undefined
  /** Standby wake: the backend container may be asleep — wake it before calling. */
  withAwake: <T>(service: string, fn: () => Promise<T>) => Promise<T>
  /** This domain's Cookie header. Only domains this package declared in its
   *  manifest's `credentials` are allowed; anything else throws. */
  cookieFor: (domain: string) => Promise<string | undefined>
  /**
   * Log a facility back in: the host finds that facility's `meta.login` recipe, runs it in the
   * user's own browser, and force-refreshes the cookie snapshot. Resolves on success, throws
   * on any failure (including "this facility has no login recipe").
   *
   * Call it around **establishing a session**, not around your whole action. The host
   * deliberately does NOT auto-retry actions for you: whether an action is safe to redo is
   * something only your package knows, and re-running one that already had an effect (an order
   * placed, a message sent) does that thing twice. Narrow the retry to the side-effect-free part:
   *
   * ```ts
   * const open = async () => await openSession(await ctx.cookieFor(DOMAIN))
   * try { return await open() }
   * catch (e) {
   *   if (!isSessionExpired(e)) throw e
   *   await ctx.login('my-facility')
   *   return await open()   // establishing a session has no side effect — safe to redo
   * }
   * ```
   */
  login: (facility: string) => Promise<void>
  /**
   * Run one of **this package's own** sources (a recipe or manifest entry) and get its raw
   * items back. A bare name is qualified with this package's npm name (`'x-detail'` →
   * `<npm name>/x-detail`, the same rule a recipe's `meta.uses` follows); a full name
   * (containing `/`) must start with this package's prefix, anything else throws — a package
   * may only run its own sources.
   *
   * No `userInitiated`: package code is not a user's click, so an action recipe
   * (`meta.action: true`) is still gated here. `signal` propagates to the recipe run.
   * A recipe with a `locate` step needs no `ordered` param — the host fills it from the
   * facility's feed ledger.
   */
  readSource: (
    sourceId: string,
    params: Record<string, string>,
    opts?: { signal?: AbortSignal },
  ) => Promise<unknown[]>
  /**
   * A public web page's article body — the host's own extractor (the same one behind
   * `/api/enrich?source=link`, same cache). `null` when nothing could be extracted. No
   * login state involved; don't bundle a second extractor into your package.
   */
  readArticle: (url: string) => Promise<ArticleContent | null>
  log: (msg: string) => void
  /** This package's own resolved deployment config. */
  config: Record<string, unknown>
}

// ── Actions (mirrors src/tasks/package-actions.ts + src/tasks/types.ts) ────

/** What one run reports back. `summary` is the one line shown in the task list. */
export interface TaskOutcome {
  summary: string
  detail?: unknown
}

/**
 * An action this package offers. A user's scheduled task can point at it by its global
 * name `<package id>:<key>`; Stream then runs it on that task's schedule, records the
 * outcome in the task's run history, and turns a thrown error into a failed run.
 *
 * A package offers actions, not schedules. When it runs, whether it runs at all, and
 * which credentials it uses all belong to the user's task row — those live in the
 * database and are edited in the UI, no restart, no release. Your package only answers
 * "what can be done".
 *
 * `params` come from the config row that task is bound to (its `configRef`) — never from
 * argv or the environment, which are echoed back by the task list API. Everything else
 * you need, close over from the `ctx` your `activate(ctx)` received: that is still the
 * entire surface you get.
 */
export type PackageAction = (params: Record<string, unknown>) => Promise<TaskOutcome>

// ── Enricher / connect (mirror src/packages/activate.ts) ──────────────────

/**
 * A named enrichment handler: when `/api/enrich?source=<declared name>` hits it, the host
 * hands over the whole query bag and sends the return value back as JSON verbatim.
 *
 * The host does not validate params — only the package knows what is legal. A thrown error
 * carrying the duck-type marker `validation: true` (the shape of `ValidationError` in
 * `shared/package-sdk/errors.ts`) becomes a 400; any other throw becomes a 502. The host
 * checks the marker, not `instanceof`, so a class bundled into your own dist is recognised
 * just the same. The second argument is the caller's abandon
 * signal (the WS live-fetch protocol aborts a superseded click through it); the HTTP
 * surface calls with one argument.
 */
export type Enricher = (query: Record<string, string>, signal?: AbortSignal) => Promise<unknown>

/**
 * One-click subscribe: `POST /api/credentials/<domain>/connect` calls it once; it returns
 * the Stream to subscribe (the host does the `subscribe`) and `extra` is merged into the
 * receipt JSON. `stream` is kept as `unknown` here for the same reason `Normalizer` is —
 * the host's `Stream` is an internal type.
 *
 * The key is a domain, and it MUST appear in this package's `credentials` — "I can
 * one-click subscribe this domain" presupposes "I get this domain's login state".
 */
export type ConnectFn = () => Promise<{ stream: unknown; extra?: Record<string, unknown> }>

/** What `activate()` hands back. Adapter/normalizer/enricher/connect keys are registration
 *  names and must match the matching lists this package declared in `stream.code`;
 *  `actions` needs no declaration (action names are namespaced by package id). */
export interface PackageActivation {
  adapters?: Record<string, Adapter>
  normalizers?: Record<string, Normalizer>
  actions?: Record<string, PackageAction>
  /** Named enrichment handlers, key = the `/api/enrich?source=` name. Declared in `stream.code.enrichers`. */
  enrichers?: Record<string, Enricher>
  /** Per-domain one-click subscribe, key = domain. Declared in `stream.code.connect` and listed in `credentials`. */
  connect?: Record<string, ConnectFn>
}

export type ActivateFn = (ctx: PluginContext) => PackageActivation
