/**
 * Source manifest — the declarative contract every source-provider satisfies.
 * This is the single thing the registry, search, scheduler, and MCP depend on.
 */

export const MANIFEST_SCHEMA_VERSION = 1

export type Capability = 'search' | 'timeline' | 'anchor' | 'discover'

/** 选择面：`stream` = 给频道加一条流（订阅面），`provider` = 给 Provider 行挑一个成员。
 *  语义与判据在 `src/manifest/pick.ts`（`pickableIn`）。 */
export const PICK_SURFACES = ['stream', 'provider'] as const
export type PickSurface = (typeof PICK_SURFACES)[number]

/** Declares a source's fan-out dimension so the executor planner can group N
 *  logical calls into 1 physical fetch. Transport property. */
export interface FanOut {
  dimension: string
  strategy: 'batch' | 'window' | 'scatter'
  batch_key: string[]
  window_size?: number
  max_concurrent?: number
}

/** One RSSHub-Radar rule (shape adopted verbatim from routes.json `radar[]`): which site
 *  URLs a source claims (`source`, "host/path" strings with `:params`) and the route template
 *  the params map into (`target`; absent = the source's own route/params). */
export interface RadarRule {
  source: string[]
  target?: string
}

/** Flow classification — groups sources in the UI; orthogonal to capabilities. */
export type SourceType = 'post' | 'conversation' | 'email' | 'calendar'

/** How a domain's scoped cookies become adapter env overrides. Self-describing so the
 *  resolver never consults a domain→env table:
 *  - `env`: join the cookies into one `name=value; …` string under the given env var name.
 *  - `transform`: hand the cookies to the named entry in the transform registry
 *    (`src/cookie-mapper.ts`) for per-source logic a single join can't express
 *    (e.g. some facility's per-session-id key, github's single-cookie value pick). */
export type CookieInject =
  | { kind: 'env'; name: string }
  | { kind: 'transform'; ref: string }

/** `optional: true` mirrors RSSHub's own `requireConfig[].optional` — the route WORKS without
 *  the credential (it just does more/better with it, e.g. youtube falls back to scraping when
 *  YOUTUBE_KEY is absent). The resolver injects the credential when one resolves and proceeds
 *  unauthenticated when none does, instead of failing the fetch. */
export type SessionAuthSpec =
  // login:qr — scan a QR into the facility profile (single-session sites).
  //
  // `cookieDomain` + `sessionCookies` are the CHEAP half of login detection: if none of the named
  // cookies exist in the user's Chrome, the session is definitively gone and we can decline
  // without opening a tab at all. They can only ever say NO — a cookie being present does not
  // mean the server still honours the session, so a positive answer still has to be confirmed by
  // the recipe's `loginCheck` selectors on a real page. Which cookie carries the session is
  // per-facility knowledge, exactly like the `wall` / `loggedIn` selectors, so it is declared
  // here rather than hard-coded anywhere.
  //
  // Both are OPTIONAL and travel together: the fast path is an optimisation, not a requirement.
  // A facility whose author does not know which cookie carries the session simply omits them and
  // falls back to opening a page and reading `loginCheck` — correct, just slower. Making them
  // mandatory would gate onboarding a new facility on knowledge that is nice-to-have.
  | { type: 'session'; facility: string; login: 'qr'; loginUrl: string; qrSelector: string
      cookieDomain?: string
      /** ANY of these existing ⇒ the browser still holds a session (weak, optimistic). */
      sessionCookies?: string[] }
  // login:oauth — 骑用户自己 Chrome 里已有的第三方登录态（今天只有 Google）走 OAuth。
  //
  // 我们**不碰用户的密码**：用户自己在浏览器里登好 Google，Stream 只负责在账号选择器上
  // 选中哪一个。中途平台可能要一次人机验证（通行密钥/二次验证），那一步交还给用户——
  // 它存在的全部意义就是"此刻有个人在"，绕过它等于把门拆了（spec 2026-09-01 §5.1）。
  //
  // `accountSelector` 用 **data 属性**而不是文本：Google 账号选择器的文字跟着用户的界面
  // 语言走（中文机器上是「继续前往Groq」），文本匹配换台机器就空手；`data-identifier`
  // 是语言无关的。
  | { type: 'session'; facility: string; login: 'oauth'
      loginUrl: string
      /** 登录页上那个第三方入口按钮，如 '#oauth-google' */
      oauthButton: string
      /** 账号行选择器，带 {email} 洞，如 '[data-identifier="{email}"]' */
      accountSelector: string
      /**
       * 用哪个账号登。**可选，且不该在 manifest/recipe 里出现**——它是每个用户各一份的
       * Google 邮箱，而 recipe 是随包分发给所有用户的，包里写死某人的邮箱是荒谬的。
       * 真正的值来自用户在设置页填的 runtime_config 字段（如 `googleAccount`），调用方
       * （`src/kernel/plugins/auth.ts` 的 `startLogin`）在每次发起登录时现取现填。
       *
       * 缺席是合法的常态：语义是「不替用户自动选账号，让他自己在账号选择器上点」——
       * Google 只有一个登录账号时本来就会跳过选择器，这条路径与之对齐。
       */
      account?: string
      cookieDomain?: string
      sessionCookies?: string[] }
  // login:cookie — inject a fresh broker cookie for cookieDomain; no scan (session lives in
  // the cookie snapshot, read from the user's own Chrome). See the launcher's cookieProvider path.
  | { type: 'session'; facility: string; login: 'cookie'; cookieDomain: string }

export type AuthSpec =
  | { type: 'none' }
  | { type: 'cookie'; domain: string; inject: CookieInject; optional?: boolean }
  | { type: 'token'; name: string; optional?: boolean }
  | SessionAuthSpec

export function isSessionAuth(a: AuthSpec): a is SessionAuthSpec {
  return a.type === 'session'
}

/** The external site/API a Source belongs to, e.g. `{ key: 'example', label: 'Example Site' }`.
 *  Distinct from Plugin: one Plugin (e.g. rsshub) can span many facilities; one facility
 *  (e.g. a given video site) can have both curated and RSSHub-catalog Sources. Never inferred from
 *  `id`/`adapter` client-side — always server-declared or catalog-derived. */
export interface Facility {
  key: string
  label: string
}

/** One upstream query key's binding: which source param supplies it, an optional
 *  default when that param is blank, and whether a blank value should reject the fetch. */
export interface ApiQueryParam {
  from: string
  default?: string | number
  required?: boolean
}

/** Declarative upstream-HTTP-API binding for external API plugins (see the
 *  adding-external-api-plugin skill). Either a declaration the generic executor runs —
 *  `endpoint` + a `query` map + a response `unwrap` dot-path (+ optional named `normalize`) —
 *  or a `handler` escape hatch naming adapter code for logic a declaration can't express
 *  (multi-step, pagination, conditional routing, browser sidecar, injected-credential query). */
export type ApiBinding =
  | { endpoint: string; query?: Record<string, ApiQueryParam>; unwrap?: string; normalize?: string }
  | { handler: string }

/** Source-owned configuration needed to execute a facility but unrelated to one invocation.
 * `ref` permits multiple Sources (for example TMDb metadata and images) to share one record. */
export interface RuntimeConfigField {
  /**
   * `boolean` 是给**开关**用的。一个开关不该因为引擎只认字符串就被存成 `"true"`：那样每个
   * 消费者都要自己解析一遍，而 `"TRUE"` / `"1"` / `" true"` 里总有一个会被判成 false，
   * 且不报错——对"要不要真下单"这种字段，判错的方向还恰好是危险的那一边。
   * SchemaForm 本来就渲染 boolean（复选框），这一格只是把它接上。
   */
  type: 'secret' | 'string' | 'boolean'
  label: string
  /** Short source-author guidance rendered below this field in Source Config Sheet. */
  description?: string
  /** Optional official setup or application page for this value. */
  helpUrl?: string
  required?: boolean
  default?: string | boolean
}

export interface RuntimeConfigSpec {
  ref: string
  fields: Record<string, RuntimeConfigField>
  /**
   * 跑一趟这份 Source，它**自己能填上**这一格里的哪几个字段。
   *
   * **不是手写的**：recipe 那条路上由 `recipeToManifest` 从 `provisionedConfigSlot(recipe)`
   * （`src/replay/recipe-provisioner.ts`，全仓唯一判据，同时也是抽取写口 sink 的绑定条件）
   * 投影下来；包作者在 `meta.runtime_config` 里抄一份会被静默剥掉——一条判据只有一个真相源。
   * 它之所以要在 manifest 上存在，是因为这一侧读不到 recipe 体。
   *
   * 消费方（`src/auth/self-provision.ts`）**只认它**。别拿
   * 「声明了同一个 `ref`」当判据：那只说明这份 Source 和那格配置**有关系**，方向可以是反的——
   * `eastmoney-login` 声明 ref `eastmoney` 是为了**读**用户填的账号密码（`secret_params`），
   * 跑它一万遍也变不出那两个值。把它当成"能补"，agent 就会去劝用户跑一条根本补不了的 recipe，
   * 而这比不给建议更坏（同 `unblock` 只认 miss 不认 error 的理由）。
   *
   * 缺席 = 这份 Source 补不了任何东西，只是用户手填的那格配置的消费方。
   */
  provisions?: string[]
  /** This Source's config is per-member-instance (see `{source, name?, params}` member addressing)
   *  rather than one shared record keyed by `ref` alone: each instance owns its own record, keyed
   *  by that member's `params.tokenName` (a complete ref, e.g. `llm:<实例名>`). Drives both the
   *  Source Config Sheet's instance field and keyState's layer lookup — see credentials/key-state.ts. */
  perInstance?: boolean
  /**
   * `perInstance` 源的实例 key ref 前缀（`<namespace>:<实例名>`）。**必填**（loader 强制）。
   *
   * 为什么要显式声明、而不是拿 `ref` 推：写 key 的端点收的是**调用方给的字符串**，不限定就等于
   * "任意 ref 写入"——一个源能改掉别的源（乃至 `alist`/`tmdb`）的 key。而命名空间又不等于 `ref`：
   * `llm-openai` 的实例 ref 一直是 `llm:<实例名>`，拿 `ref` 推会变成 `llm-openai:*`，把存量配置
   * 全打断。所以它是一条独立声明，每个 perInstance 源自己说自己的命名空间。
   */
  instanceNamespace?: string
}

export interface SourceManifest {
  /** schema version for forward-compat; defaults to MANIFEST_SCHEMA_VERSION */
  schema_version: number
  /** unique id across the registry */
  id: string
  /** Human display title, e.g. '我的收藏' instead of deriving from description */
  title?: string
  /** owner plugin ID, populated when loaded from plugin descriptors */
  pluginId?: string
  /** Plugin display name — derived at load time by registry/seal.ts (never hand-written
   *  in manifests). Present on every manifest that came through sealManifests(). */
  pluginName?: string
  /** which adapter executes this source, e.g. 'rsshub' */
  adapter: string
  /** flow classification for UI grouping; defaults to 'post' */
  type: SourceType
  /** load-bearing for discovery — search matches on this */
  description: string
  /** discovery facets */
  topics: string[]
  /** content categories (RSSHub-style: social-media / news / programming / finance …) — used for search routing */
  categories?: string[]
  /** grouping key for the Channels picker's facility → sources → detail nav (see Facility).
   *  Absent = this Source doesn't belong to a declared facility. */
  facility?: Facility
  /** sample intents that should retrieve this source */
  example_queries: string[]
  /** what calling modes this source supports */
  capabilities: Capability[]
  /** Result shape of this Source: 'object' = it answers with ONE verdict object (a probe /
   *  resolver), not an item batch — the provider executor unwraps accordingly. Absent =
   *  'items' (a feed batch), which is every pre-existing Source. */
  output?: 'items' | 'object'
  /** declares the credential need; never the value or its source */
  auth: AuthSpec
  /** JSON-schema-ish description of fetch params; validated before invocation */
  params_schema: Record<string, unknown>
  /** Runtime credentials and values, edited through Source Config Sheet; never call params. */
  runtime_config?: RuntimeConfigSpec
  /** adapter-specific binding (e.g. rsshub route template) */
  route?: string
  /** suggested polling cadence in seconds */
  cadence_hint_seconds: number
  /** 并发扇出里本源的单成员墙钟上限（ms），覆盖执行器默认（今 25s）。给**天然慢于默认闸**的
   *  源自己申报用——拟人采集从首页走完整套人肉路径就是比纯 HTTP 慢（douyin-search 实测 ~40s，
   *  2026-08-24），全局抬闸会让所有搜索陪慢源等，按源申报只让它自己的那一格慢。 */
  member_timeout_ms?: number
  /** false hides it from intent search (escape hatches like rsshub-raw).
   *
   *  **它只管"推荐/排名里出不出现"这一件事**（首页精选列表 + 按意图搜源），不回答"能不能被挑
   *  中"——那是 `pick_in` 的活。两者混用过，代价见 `pick_in` 的头注。 */
  discoverable: boolean
  /** 这个源在哪些**选择面**能被挑到（订阅面 / 能力成员面）。缺省 = 两个面都能。
   *  判据是具名函数 `pickableIn`（`src/manifest/pick.ts`），那里也写着为什么它不能从
   *  `capabilities` 推出来。 */
  pick_in?: PickSurface[]
  /** which normalizer maps this source's raw items to Content (default: generic) */
  normalizer?: string
  /** @deprecated legacy alias for `normalizer` — still resolved (`normalizer ?? presenter`)
   *  so manifests written before the rename (including user-owned data/ recipes outside
   *  this repo) keep working. New manifests should use `normalizer`. */
  presenter?: string
  /** optional fan-out declaration — when present the executor planner expands/groups
   *  the named `dimension` param (e.g. pansou 'channels') across flows. */
  fan_out?: FanOut
  /** upstream 形状。'collection' = 有界完整集合(歌单/播客全集/收藏),每采全量、按成员 source 分片
   *  覆盖(过 collection-replace-guard 的两道闸门)、不进时间线;
   *  'feed'(默认/缺失)= 无界时间线,增量+滑窗。存储语义的唯一权威(`scheduler.modeOf()`)。 */
  mode?: 'feed' | 'collection'
  /** RSSHub-catalog enrichment, ingested from routes.json (absent on curated manifests):
   *  the route's usage notes (markdown), whether it needs config (cookie/API key) to work,
   *  an nsfw flag, and the source site homepage. Display-only — surfaced in the picker's
   *  detail panel so a user knows what a route needs before subscribing. */
  notes?: string
  /** Raw RSSHub route markdown. Kept for docs-style rendering; `notes` remains a
   *  plain-text fallback for compact surfaces. */
  docsMarkdown?: string
  requireConfig?: boolean
  nsfw?: boolean
  homepage?: string
  /** RSSHub Radar `source` patterns this route claims (ingested from routes.json `radar[].source`).
   *  A Provider row's `{mode:'auto', matches}` member expands to every source whose `matchers`
   *  contains the exact pattern — capability ownership declared in the route, not hand-copied here. */
  matchers?: string[]
  /** RSSHub-Radar rules this source claims: which site URLs it ingests (`source`, "host/path"
   *  with :params) and the route template params map into (`target`). Producer A copies them
   *  from routes.json `radar[]`; native manifests (Producer B) declare them directly. Unlike the
   *  flattened `matchers` (used by Provider `{mode:'auto', matches}` grouping), this keeps the
   *  full structure the radar matcher needs. */
  radar?: RadarRule[]
  /** 这个 Source 的产出**依赖**哪些别的 Source（全名，或同包内的局部名——recipe 投影在装载期
   *  合成全名，见 `recipeToManifest`）。用来回答反向的那个问题：**一份 recipe 坏了会连累谁**
   *  （`src/registry/affected-sources.ts`，`Registry.affectedSources`）。
   *
   *  申报由**用的人**写，不由被用的人登记自己的用户——见那个模块的头注。今天的活体例子：
   *  小红书包的两个 feed 源都 `uses` 它的 detail 源，因为打开一条笔记要靠共用的 detail recipe
   *  转成文字与评论（包的 detail enricher 经 `ctx.readSource` 调的正是那条，见 `packages/xhs/detail.ts`）。
   *
   *  它**不影响调度**：宿主不会因为一格 `uses` 就去替你跑那个源。它是一份供诊断读的声明。 */
  uses?: string[]
  /** target-types this source can resolve (target-resolve model); empty = not a provider */
  provides?: string[]
  /** failover priority within a target-type (lower = tried first; absent = 100) */
  priority?: number
  /** which fetch param the Target key is placed into when resolving (default: url) */
  key_param?: string
  /** fixed params always merged into a resolve fetch (e.g. {mode: user}) */
  fixed_params?: Record<string, unknown>
  /** declarative upstream-API binding (external API plugins) — endpoint+query+unwrap or a named handler */
  api?: ApiBinding
}
