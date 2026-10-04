import type { AuthSpec, Capability, Facility, RuntimeConfigSpec, SourceType } from '../manifest/types.ts'
import type { DesktopRecipe } from './desktop-recipe.ts'

/** One in-page fetch template. url/body/header values may contain {param} holes. */
export interface RecipeRequest {
  url: string
  method: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  /** Follow redirects (default) or surface the 3xx itself. 'manual' matters to a probe
   *  whose upstream plants session cookies on the redirect hop (baidu's share landing):
   *  following would swallow the Set-Cookie the next step depends on. */
  redirect?: 'follow' | 'manual'
}

/** Shared across both pagination modes. */
interface PaginationBase {
  /** dot-path to the array of raw items in the response, e.g. "data.items" */
  itemsAt: string
  /** optional dot-path to a boolean; when it resolves falsy, stop paging */
  hasMore?: string
  /** hard cap on pages fetched, regardless of cursor/hasMore */
  maxPages: number
}

/**
 * Cursor pagination: the response echoes an opaque token that the next request
 * carries (e.g. xhs `cursor`). Stops when the token is empty/absent.
 */
export interface CursorPagination extends PaginationBase {
  mode: 'cursor'
  /** dot-path to the next-page cursor value; when absent/undefined, stop paging */
  cursorFrom: string
  /** which {param} name receives the cursor on the next request, e.g. "cursor" */
  cursorParam: string
}

/**
 * Increment pagination: a numeric page-number or offset counter injected as a
 * param (e.g. `page=0,1,2…` or `offset=0,20,40…`). Stops at maxPages, a falsy
 * hasMore, or the first page that returns an empty item array.
 */
export interface IncrementPagination extends PaginationBase {
  mode: 'increment'
  /** which {param} name receives the counter, e.g. "page" or "offset" */
  param: string
  /** starting value, e.g. 0 or 1 */
  start: number
  /** amount added per page, e.g. 1 (page number) or 20 (offset by page size) */
  step: number
}

/** How to page. Cursor-token style or numeric page/offset style. */
export type RecipePagination = CursorPagination | IncrementPagination

/** A response-shape guard. Failing any assert = drift (the source needs repair). */
export interface RecipeAssert {
  /** dot-path that must resolve to a non-null, non-undefined value */
  path: string
  /** human-readable reason surfaced in the drift error and quarantine record */
  desc: string
}

/** target item field -> dot-path within a single raw item */
export type RecipeFieldMap = Record<string, string>

/**
 * A Recipe is the compiled, versioned unit a fallback source runs — establish a
 * logged-in page context, run this parameterized in-page fetch, map the response
 * to items. The interpreter "replays" a Recipe. `kind` discriminates a `fetch` recipe (a
 * canned, parameterized in-page API request — declarative request/pagination/assert) from a
 * `browser` recipe (drives the live logged-in page: scroll/click, then harvest via dom/xhr/eval/state).
 */
/**
 * Discovery metadata a recipe author (an agent, usually) supplies so the recipe
 * self-describes as a Source — the loader projects it into a SourceManifest via
 * `recipeToManifest`, so no separate manifest need be hand-written. Everything is
 * optional: a bare recipe still yields a valid Source (structural fields derive
 * from the recipe body, the rest default). Anything set here overrides the derived
 * default. See `src/replay/recipe-manifest.ts`.
 */
export interface RecipeMeta {
  /** one line for search/discovery; the only field really worth authoring */
  description?: string
  /**
   * `title` 不是新字段——它就是这条 Source 的显示名（投影进 manifest 的 `title`，见
   * `src/replay/recipe-manifest.ts`，也是 `/api/sources` 里的显示名），接管提示条第二行
   * （Windows 浮层，见 `desktop-runner.ts` 的 `stepStatusText`）复用它，缺省退回 sourceId。
   * `purpose` 才是提示条专有的：这一次目的的模板（「发给 {contact}」），占位只能引用
   * `params_schema` 里声明过的键（装载期拒，见 `recipe-store.ts`）。**purpose 是这条链路上
   * 唯一一处让参数值上屏的地方**——作者点名要露的才露，别的参数、步骤 label 里的 `{q}`
   * 一律原样留着。
   */
  title?: string
  purpose?: string
  /** 显式 opt-in：这条 recipe 是**动作**（跑完不产内容，只是把一件事做了，如发一条消息），
   *  而不是采集。默认（缺省/false）= 采集 recipe。**必须显式声明，不能从 `pick_in:[]` 之类
   *  的字段推**——那会让「以后每一条恰好没填 pick_in 的 recipe」悄悄变成可被 MCP 动作工具跑，
   *  没有任何一处会报错。只有这一格为 `true` 的 recipe 才能被 `run_action_recipe`（见
   *  `src/mcp/action-recipe.ts`）执行。见 `packages/qq/qq-send.recipe.json` 的 meta。 */
  action?: boolean
  /** 这条动作 recipe 跑完产出的是什么。今天只有 `'images'`：申报了它的 recipe 会以 sourceId 为
   *  模型名出现在 OpenAI 形状的 `/v1/models` 里（`src/http/image-generation-routes.ts`），条目要带
   *  `url`。宿主靠这一格认"谁能当生图模型"，不认包名。 */
  produces?: 'images'
  /**
   * 显式 opt-in：这条动作 recipe 的作用是**给它那个 facility 建立登录态**。
   *
   * 宿主据此回答"这个 facility 掉线了该跑哪条 recipe"（`PluginContext.login(facility)`）。
   * facility 从 `session.facility` 取，所以这一格只是个布尔——一个 facility 最多一条，
   * 命中多条是包作者的错，宿主抛错而不是挑一个（挑错了就是去登了别的账号）。
   *
   * **必须显式声明，不能从"它恰好是这个 facility 唯一一条 action recipe"推出来。** 那种推法
   * 在今天成立、在这个包多一条动作 recipe 的那天就会静默改指向，而且没有任何一处会报错。
   * 同 `action` 那一格的立场：**判据要有名字**。
   *
   * 蕴含 `action: true`（登录是有副作用的：会建立会话、踢掉同账号在别处的登录）。装载期查这
   * 一条，不让"声明了 login 却没声明 action"这种半开状态存在。
   */
  login?: boolean
  /**
   * 副作用申报。安装预览逐格亮牌（`recipe-install.ts`），运行期也按它放行——`call` 步骤
   * 没申报就不许跑（见 `RecipeActionKind` 里 `call` 那一格的第 3 条边界）。
   *
   * **这一格此前只有 zod 认识**（`recipe-manifest.ts`），TS 类型里没有，于是消费方一路
   * `as string[]` 强转。类型补上之后它才有编译期的守。取值与那份 schema 是同一套，改一边
   * 就得改另一边。
   */
  effects?: Array<'write' | 'send'>
  /**
   * 这一条 recipe 自己的频率闸，**叠在**它所属 facility 那道之上（两道都过才放行，见
   * `FacilityRateLimiter.take`）。不声明 = 只受 facility 那道管。
   *
   * 为什么单条 recipe 会需要自己的闸：facility 桶是按站点的一个桶，而同一个站点上读腿和写腿
   * 的安全速率能差一个数量级（闲鱼：查残值一次决策 4–10 发都没事，上架 15 分钟 6 发就把整站
   * 打成 404）。压 facility 桶等于把读腿一起压死。取值与 `SourceManifest.rateLimit` /
   * `FacilityRateLimit` 同一套，改一处就得改另两处。
   */
  rateLimit?: { burst: number; perMinute: number; perHour?: number; maxWaitMs?: number }
  categories?: string[]
  topics?: string[]
  example_queries?: string[]
  /** calling modes; defaults to ['timeline'] (a harvest feed) */
  capabilities?: Capability[]
  /** storage semantics; defaults to 'feed'. 'collection' = a bounded roster (award winners,
   *  a chart) stored as a snapshot and kept out of the inbox timeline. */
  mode?: 'feed' | 'collection'
  /** credential NEED for display only — replay ignores it at fetch time (the login is whatever
   *  the user's own Chrome holds, surfaced at runtime as NeedsLoginError). Default none. */
  auth?: AuthSpec
  cadence_hint_seconds?: number
  params_schema?: Record<string, unknown>
  /** RSSHub-Radar `source` patterns this source claims (e.g. 'xueqiu.com/u/:id') —
   *  becomes both manifest.radar (structured) and manifest.matchers (flattened). */
  radar?: string[]
  key_param?: string
  priority?: number
  discoverable?: boolean
  type?: SourceType
  /** 这个 Source 的产出依赖哪些别的 Source → `SourceManifest.uses`（那里有完整说明）。
   *  **同包内写局部名**（`'foo-detail'`），装载期由宿主拼成全名；要指别的包里的源就写全名
   *  （含 `/`，如 `'@scope/pkg/foo-detail'`）——局部名不许含 `/`，两者天然分得开。 */
  uses?: string[]
  /** grouping key; defaults to the package facility */
  facility?: Facility
  /** Source-owned runtime configuration (Source Config Sheet). Also the ONLY place a
   *  recipe's `extract` target can live — the sink is bound from `ref` + the fields
   *  declared `secret` here, so the recipe body never names a ref at run time. */
  runtime_config?: RuntimeConfigSpec
  /**
   * **宿主注入的凭据参数**：这几个字段的值由宿主从这份 recipe **自己的** `runtime_config`
   * 里取出来，运行前塞进参数袋，`type` 的 `{名字}` 于是能把它打进页面。
   *
   * 它开的是 `RecipeExtract` 那条头注明写「只写不读、也不要加」的反向口子，所以四道闸一起上，
   * 缺一条这一格就不该存在：
   *
   * 1. **只能读自己那一格。** ref 取自本 recipe 的 `runtime_config.ref`，recipe 体在运行期
   *    没有任何办法指名去读别处的配置——和写那一侧同一条规矩。
   * 2. **字段必须已在自己的 `runtime_config.fields` 里声明为 `secret`。** 不能凭空点一个名字。
   * 3. **只给内置包。** npm 装来的第三方 recipe 一律注入不到（判据是包的来源，不是它住哪个
   *    目录）。理由直白：把用户的凭据交给一份从网上装来的数据，没有任何守卫能补救。
   * 4. **与 `call` 互斥。** 一条 recipe 要么能拿到凭据、要么能问外面，不能两样都要——
   *    否则「把密钥打进一个可见输入框 → call 那一块的截图」就是一条两步走完的外泄链，
   *    而那正是「只写不读」当初要挡的东西。装载期就拒（`recipe-store.ts`），不留到运行期。
   *
   * **值绝不出现在**：`run_action_recipe` 的二次确认回执（它只回显**调用方**给的 params，
   * 而这些是宿主在那之后才注入的）、`ActionTrace`（`type` 只记选择器）、DebugBox、日志。
   */
  secret_params?: string[]
}

export interface FetchRecipe {
  version: number
  kind: 'fetch'
  sourceId: string
  /** which domain's login this fetch needs — the host resolves it and injects the cookie */
  cookieDomain: string
  /** page to establish logged-in context before the fetch (used by Plan 2) */
  entryUrl: string
  /**
   * How long to wait on the entry navigation before running the fetch. Default
   * 'domcontentloaded'. Use 'commit' for a same-origin API that needs no page JS
   * (fast, avoids SPA render stalls); use 'load'/'networkidle' for sites whose
   * request-signing JS must finish initializing first (e.g. xhs).
   */
  entryWait?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle'
  request: RecipeRequest
  pagination: RecipePagination
  assert: RecipeAssert[]
  mapping: RecipeFieldMap
  /** optional discovery metadata → synthesized SourceManifest (see RecipeMeta) */
  meta?: RecipeMeta
}

/**
 * Plain-HTTP recipe (kind:'http'): the cheapest rung of the acquisition ladder — send
 * the request from the host, no browser at all. It shares the whole
 * request/pagination/assert/mapping engine with FetchRecipe; the ONLY difference is who
 * sends the bytes, which is why `interpret` runs both unchanged.
 *
 * `kind` and not `transport`: hanging http under FetchRecipe.transport would force every
 * plain-HTTP recipe to declare browser-only fields (entryUrl/cookieDomain) it has no use
 * for. Those fields are absent here by design.
 */
export interface HttpRecipe {
  version: number
  kind: 'http'
  sourceId: string
  /**
   * OPTIONAL credential binding: when set, the broker's cookie for this domain rides the
   * request. It MUST cover the request host — enforced at runtime in http-fetch.ts, not
   * merely by convention. A recipe is shareable code-as-data, so an unbound cookieDomain
   * is a complete credential-exfiltration primitive requiring zero script.
   */
  cookieDomain?: string
  request: RecipeRequest
  /**
   * Hand a non-2xx response BODY to decode instead of throwing. The http twin of
   * `CanonicalBrowserRecipe.allowEmpty`, and for the same archetype: a PROBE recipe (ask about
   * one target, report what it is) gets its answer IN the upstream's error body — quark says
   * `403 41031 分享者用户封禁` / `404 41006 分享不存在`, which is the verdict, not a failure.
   *
   * Default (throwing) is right for a FEED: a 500 must not read as "no items today" and evict a
   * stream. But leaving a probe on that default conflates two things that must never merge —
   * "this share is dead" and "the network broke" would both arrive as exceptions, so an outage
   * would silently report every link as dead. A probe that opts in owns that distinction in its
   * decode (which still runs, and whose asserts still guard the shape).
   */
  acceptNonOk?: boolean
  /**
   * OPTIONAL cookie jar: remember upstream Set-Cookie for the rest of THIS run (spec §4.1).
   * Three iron rules, all enforced in the engine (HostCookieJar / http-fetch), never by
   * trusting the recipe: host-bucketed so cookies never cross sites; lives one run, never
   * persisted; separate ledger from the broker credential (merged by name at send, jar wins).
   */
  jar?: boolean
  /**
   * OPTIONAL compute hook. For a site whose request needs a computed signature and/or whose
   * response body is encrypted (zuna/toubiec — third-party mirror/unlock sites for a music
   * platform, NOT platforms themselves),
   * a recipe carries small PURE snippets that run in an isolated-vm heap with zero ambient
   * capability (see compute-sandbox.ts). I/O stays in the engine: the engine does the
   * prefetches and the main request; the sandbox only signs params and decrypts the body.
   */
  compute?: RecipeCompute
  /**
   * Result shape. 'items' (default): pagination + mapping produce a feed batch — today's
   * contract, untouched. 'object': decode's return value IS the member result, verbatim —
   * a probe answers a question, it does not produce a feed. The two field sets are mutually
   * exclusive; recipe-store enforces it at load, so `pagination`/`mapping` are optional
   * here ONLY for the object case (items recipes must still carry both).
   */
  output?: 'items' | 'object'
  pagination?: RecipePagination
  assert: RecipeAssert[]
  mapping?: RecipeFieldMap
  meta?: RecipeMeta
}

/** A request the engine runs once per recipe run, binding its JSON response under `as` so the
 *  sign/decode snippets — and `request` itself, via sign — can read it (zuna's /api/key and
 *  /api/ip; quark's pwd_id → stoken). I/O is the engine's; `url`/`body` template `{param}`
 *  holes exactly like the main request. */
export interface RecipePrefetch {
  as: string
  request: RecipeRequest
  /** How to read the response body into `pre[as]`. 'json' (default) keeps today's contract;
   *  'text' binds the raw text; 'none' binds null — the step exists for its side effect
   *  (planting cookies into the jar), and an HTML landing page must not fail a JSON parse
   *  it never asked for. */
  parse?: 'json' | 'text' | 'none'
}

export interface RecipeCompute {
  /** which sandbox capabilities the sign/decode snippets may call (whitelist). */
  capabilities: string[]
  /** Runs BEFORE any request — sign runs too late to feed a prefetch URL. A pure snippet;
   *  input = { params, now }; returns derived params (String()-ed) merged into the set,
   *  filling prefetch templates and any hole the main request's first substitution left
   *  literal (baidu: surl = pwd_id minus its leading '1', plus a ms timestamp). */
  params?: string
  /** GETs whose responses feed the snippets, bound under `pre[as]`. */
  prefetch?: RecipePrefetch[]
  /** runs BEFORE the request. input = { params, pre, now }; returns { body?, headers?, url? }
   *  merged into the outgoing request. `now` is passed in — the sandbox has no clock. */
  sign?: string
  /** runs on the response. input = { body, pre }; returns the object pagination/mapping read. */
  decode?: string
}

/**
 * Plain-HTML recipe (kind:'html'): the SAME cost-ladder rung as kind:'http' — a bare host
 * fetch, no browser — but the upstream serves HTML, not JSON. So instead of JSON dot-paths
 * it maps via CSS selectors (parsed with linkedom on the host). Completes the "cheap tier"
 * for server-rendered sites (forums, listings) that RSSHub used to cover with cheerio.
 */
export interface HtmlRecipe {
  version: number
  kind: 'html'
  sourceId: string
  /** OPTIONAL broker cookie binding, same contract as HttpRecipe.cookieDomain. A STATIC
   *  cookie (e.g. an anti-bot `visitor_test=human`) goes in request.headers instead. */
  cookieDomain?: string
  request: RecipeRequest
  /** how to pull the list rows and their fields off the list page. */
  list: HtmlList
  /** OPTIONAL per-row hydration: fetch each row's detail page and merge more fields over it
   *  (e.g. a forum thread's magnet/body live on the thread page, not the listing). */
  detail?: HtmlDetail
  /**
   * OPTIONAL per-row hop chain, run AFTER `detail`: each hop is one more request whose URL is
   * built from the fields gathered so far (list + detail + earlier hops), and whose extracted
   * fields merge over them. This is how a row follows evidence across sites — e.g. the
   * wikipedia award roster reads a work's Wikidata entity link off its article, then asks the
   * Wikidata API (a JSON hop) for the TMDb/IMDb ids that entity registers.
   *
   * Unlike `detail` (whose fetch failure fails the run — unchanged for the recipes that rely
   * on it), a hop is TOLERANT: a network error, a non-2xx, or a missing URL field only leaves
   * that hop's fields unset. Supplementary evidence must never take the row down with it.
   * Every hop goes through the same guarded `fetchHtml` as the list/detail fetches (SSRF +
   * cookieDomain coverage), and hops run sequentially — no fan-out against the upstream.
   */
  hops?: HtmlHop[]
  pagination: HtmlPagination
  /** selectors that MUST match ≥1 element on the list page, else drift (source needs repair). */
  assert: HtmlAssert[]
  /**
   * OPTIONAL：**页面外壳**的选择器（搜索框、页脚、导航——改版才会消失的那种，和列表行无关）。
   *
   * 它把两件长得一模一样的事分开：`assert` 落空 + 外壳**还在** = 站点在限流（回了一张空壳页，
   * 200 OK），瞬时、不是我们的 recipe 坏了，**不记漂移**；`assert` 落空 + 外壳**也没了** =
   * 真改版了，照旧记漂移、进隔离、走修复。
   *
   * 不给这一格就退回旧行为（一律记漂移）——对没有限流问题的源没有区别。给了才有分辨力，
   * 而分辨力正是这一格存在的理由：活体 2026-09-04 慢慢买因为限流被误判成改版关进隔离，
   * 之后 `price_search` 对所有查询静默返回 0 行（见 `ReplayThrottledError` 的头注）。
   */
  shell?: string
  meta?: RecipeMeta
}

/** Extract one field from an element. `selector` is relative to the element (omit → the
 *  element itself). Exactly one of text/attr/html chooses what to read (default: text). */
export interface HtmlField {
  /** a descendant selector, or an ordered list where the first one that matches wins. */
  selector?: string | string[]
  /** read textContent (trimmed). The default when neither attr nor html is set. */
  text?: boolean
  /** read this attribute, e.g. "href" or "src". */
  attr?: string
  /** read innerHTML (for a description body). */
  html?: boolean
  /** resolve a relative URL against the page URL. */
  resolve?: boolean
  /** optional regex run over the value; capture group 1 (or the full match) replaces it, no
   *  match drops the field. Same contract as DomFieldSpec.extract — it is both a slicer
   *  (peel a Q-number out of a wikidata href) and a shape guard (junk values never land). */
  extract?: string
}

export interface HtmlList {
  /** selector for each row element on the list page. */
  selector: string
  /** cap rows per page (bounds the per-row detail fetches too). */
  limit?: number
  /** target field name → how to extract it from a row. */
  fields: Record<string, HtmlField>
}

export interface HtmlDetail {
  /** which list field holds the detail-page URL to fetch. */
  urlFrom: string
  /** target field name → how to extract it from the detail document; merged over list fields. */
  fields: Record<string, HtmlField>
}

/** How a hop names its URL: either a `{field}` template composed from the row's fields so far
 *  (plus call params — same `{param}` vocabulary as RecipeRequest.url), or `urlFrom`, taking one
 *  field verbatim (HtmlDetail's word for the same thing). Exactly one of the two. A hole whose
 *  field is missing/empty skips the hop — that evidence simply is not there for this row. */
interface HtmlHopBase {
  url?: string
  urlFrom?: string
  /** optional request headers (values may contain the same `{field}` holes as `url`). Hops do
   *  NOT inherit the list request's headers — a hop usually talks to a different endpoint. */
  headers?: Record<string, string>
}

/** A hop whose response is HTML (the default): fields are CSS-selector extractions, exactly
 *  like `detail.fields`. */
export interface HtmlDocHop extends HtmlHopBase {
  parse?: 'html'
  fields: Record<string, HtmlField>
}

/** One field read out of a JSON hop's parsed body. */
export interface HtmlJsonField {
  /** dot-path into the parsed JSON (getPath semantics: numeric segments index arrays). */
  path: string
  /** same contract as HtmlField.extract: regex over the String()-ed value, group 1 or the full
   *  match wins, no match drops the field. Doubles as the shape guard for scraped ids. */
  extract?: string
}

/** A hop whose response is JSON: fields are dot-paths, not selectors. `parse` reuses
 *  RecipePrefetch's vocabulary rather than inventing a second dialect. */
export interface HtmlJsonHop extends HtmlHopBase {
  parse: 'json'
  fields: Record<string, HtmlJsonField>
}

export type HtmlHop = HtmlDocHop | HtmlJsonHop

/** HTML listings page by a numeric counter in the URL; stop at maxPages or the first empty page. */
export interface HtmlPagination {
  mode: 'increment'
  param: string
  start: number
  step: number
  maxPages: number
}

/** A list-page shape guard: this selector must match at least one element. */
export interface HtmlAssert {
  selector: string
  desc: string
}

// ── Browser recipe (kind:'browser'): drives the live logged-in page ──────────
/**
 * Two-signal login detection. A single "logged-in?" selector cannot tell a
 * transient blank render from an actual login wall, so a browser recipe carries
 * BOTH a positive logged-in signal and a positive wall signal. This lets the
 * interpreter abort the instant it is blocked instead of grinding noProgressStop
 * and mislabeling a login wall as drift.
 */
export interface LoginCheck {
  /** selector present on entryUrl ONLY when authenticated (positive logged-in signal) */
  loggedIn: string
  /** selector present ONLY when a login overlay is up (positive wall signal) */
  wall: string
  /**
   * 站方**风控挑战**的选择器（验证码遮罩之类），和 `wall` **分开声明**。
   *
   * 为什么不是把它并进 `wall`：这两件事**对用户的动作要求相反**——墙是"你得去登录"，
   * 挑战是"你什么都不用做，等冷却"。并在一起就只能给一句模糊话，而模糊话会把真的
   * "需要登录"一起藏掉（比现在更坏）。分开之后判据在源头就分叉，下游不用猜。
   *
   * 声明它之前先量一眼：**这个选择器在没被挑战的干净页面上必须不存在**。常驻 DOM 的
   * 容器要改用可区分的哨兵（可见性 / 尺寸 / 内层节点），否则每一轮都会误报成"被挑战"。
   * 实例见 `packages/douyin/douyin-search.recipe.json` 的 `_why_wall_vs_challenge`。
   */
  challenge?: string
  /**
   * **这份 recipe 的工作就是穿过这堵墙**（登录流程）：入场时命中 `wall` 不算失败，照跑。
   *
   * 为什么需要它：入场闸的默认语义是"墙在 = 这轮没法采，报 needsLogin 并停"，那对**所有
   * 跑在登录之后**的 recipe 都对。而登录 recipe 是唯一跑在登录**之前**的一类——它降落的
   * 那一页按定义就是墙，默认闸会在它动手之前就把它毙掉。
   *
   * **只有登录这一类该开。** 普通采集开了它，就把"该去登录"读成"接着采"，结果是一整轮
   * 空手而归却报 ok——而"没采到"和"没登录"本来是必须分开的两件事。
   *
   * 只影响**入场**那一次判定。跑完之后的复判照旧：登录失败的话人还留在登录页，墙照样命中，
   * 这一轮如实翻成 `needsLogin`——那正是想要的结论，不该被这个开关盖掉。
   * `challenge` 不受影响：站方风控挑战对登录同样是"停下等冷却"。
   */
  runAtWall?: boolean
}

/** Session classification from the LoginCheck signals. */
export type LoginState = 'LOGGED_IN' | 'WALLED' | 'CHALLENGED' | 'UNKNOWN'

/** stable structural fingerprint of the element a step touches (drift detection).
 *  Point at page chrome (nav/buttons/search box) — NEVER at feed-card text (changes every visit). */
export interface ActionFeature {
  selector: string
  role?: string
}

/**
 * 步骤级期望：**动作做完之后，等这件事发生**。语义取自 Playwright 的
 * `locator.waitFor({ state, timeout })`，不是新发明。
 *
 * 为什么挂在步骤上、而不是像 Playwright/Selenium 那样另起一个独立的 wait：它俩是命令式 API，
 * 下一行写个 wait 就行；我们是一张声明式的 step 表，挂在步骤上多给一样东西——**这一步自己的
 * 成败**。`cdp_act` 已经这么做了（`confirmed` / `acted-unconfirmed`），recipe 这边过去只有
 * "点了"和"没点着"。
 *
 * 它补的是一个真实的缺口：`step.feature` 只查一次（那是漂移检测），`observeOpened` /
 * `waitForFeature` 是真等待但一个写死在 openTarget 里、一个只服务 `cdp_act`——**recipe 的步骤
 * 词汇里当时没有"等某特征出现"**。于是遇到"下一个控件要等上一个 resolve 了才渲染"就只能往
 * click 上焊 timeout，而那说的是错的事：等的根本不是自己那次点击，是它引发的结果。
 *
 * **哪些步骤收 `expect`**：动作步骤（`click`/`type`/`goto`/`scroll`/…，走 `runActions`），外加
 * `locate` / `openTarget`（走 recipe-runner 里的 `gateStepExpect`，跑在它们的内建确认之后、
 * observers 读之前）。后两者**不收 `retryEvery`**，装载期报错——见下面 `retryEvery` 的说明。
 */
export interface StepExpect {
  selector: string
  /**
   * 动作**之前**这个判据就已经成立时，怎么办。默认（不写）= **报错**。
   *
   * 为什么默认是报错：一个动作前就成立的判据是**恒真的**——它永远不会失败，所以它看起来像监督，
   * 实际是装饰。活体代价（2026-07-30，zhipu-create-key）：建 key 那一步的 expect 写的是
   * "表格最后一行有复制图标"，可列表里本来就有一把旧 key、那图标一直都在。于是"确定"根本没建成
   * 也照样判过，下一步点到了**旧那一行**的复制按钮上，最后失败以"抽取命中 0 处"的面孔出现——
   * 离真正断掉的那一步隔了两步远。四步全绿、结果全错。
   *
   * 所以这一条守的是判据本身的**区分力**：动作前必须为假，动作后为真，它才配叫判据。
   * 引擎在动作前多读一次（一次即时读，不等待），已经成立就当场断，指名道姓地说这个 expect 恒真。
   *
   * `true` = 我知道它本来就在，照跑。**极少数才该用**：真正合法的场景是"这个元素两个状态都在、
   * 我要等的是它的别的性质"——那种情况下你多半应该换一个判据（比如 `countIncreases`），
   * 而不是把这道闸门关掉。
   */
  alreadyThere?: boolean
  /**
   * 判据换成**数量变多**：动作前数一次 `selector` 的命中数，之后等它**严格大于**那个数。
   *
   * 这是"列表里多了一行"「弹出了第二个卡片」这类结果的正确判据形状——用 present 去表达它必然
   * 恒真（那个选择器本来就命中着旧的那些），正是上面 `alreadyThere` 记的那次事故。
   * 与 `state` 互斥（数量变多本身已经蕴含"出现了"），装载期拒绝同时声明。
   */
  countIncreases?: boolean
  /**
   * 判据等待期间，**顺便盯着站点自己的报错面**（toast / 表单错误位的选择器，如 `.el-message`）。
   * 期间出现过的文本会被原样带进失败消息里。
   *
   * 为什么这是一等字段而不是"调试时加一下"：**站点几乎总会说清它为什么拒绝，而那句话活不过几秒。**
   * 活体（2026-07-30 `zhipu-create-key`）：建 key 失败，站点弹的是
   * 「创建失败，apiKey名称[…]重复」——一句话就能结案；而 toast 3 秒就自动消失，失败截图是判据
   * 超时（15s）之后才拍的，只拍到一个"弹窗还开着"的空壳。**证据在失败被确认之前就过期了**，
   * 于是排查退化成猜：是点击没到按钮，还是站点拒绝了？
   *
   * 它还顺带把这两个世界分开：等待期间**一条报错都没出现** = 动作大概没真正抵达（点击没落在按钮上）；
   * **出现了** = 动作到了、站点拒绝了，理由就在那句话里。
   */
  errorSurface?: string
  /**
   * `present`（默认）= 等它挂上 DOM；`gone` = 等它消失。
   *
   * 叫 `present` 不叫 Playwright 的 `visible`，是因为判据是两条 transport 共用的
   * `driver.exists`（挂没挂上），**不是 CSS 可见性**。名字得说实话。
   * "消失"不是凑数的一档：Cloudflare Turnstile 过了之后，那个隐藏 input 是直接从 DOM 移除的。
   */
  state?: 'present' | 'gone'
  /** 上限（ms），默认见 `EXPECT_DEFAULT_MS`。挑战类的慢步骤要显式调大。 */
  timeout?: number
  /**
   * 每隔这么久（ms）把动作**重做一遍**，直到 expect 满足或 timeout 到。缺省 = 只等不重做。
   *
   * 为什么需要它，而不是"等目标准备好了再点"：有些目标**准备好没有是观察不到的**。
   * Cloudflare Turnstile 的复选框实测要约 2 秒才可点，而这 2 秒里页面上没有任何东西在变——
   * DOM 连续 9.3 秒一个字节不动（widget 在 closed shadow root 里），`window.frames.length`
   * 也不动。既然没有可等的信号，就别假装有：**重做手势比盲等一个写死的秒数好**，因为那个
   * 秒数绑死在今天的挑战行为和这台机器的速度上，换个环境就废，而且没有任何东西会告诉你它废了。
   *
   * 只对**重做一次没有副作用**的动作有意义（click / type）。`scroll` / `openItems` 自带循环
   * 与 dwell，重做会把它们跑第二遍——装载时就拒（见 recipe-store 的 validateSteps）。
   * `locate` / `openTarget` 同样拒：它们各自已经有自己的重试（`fallbackUrl` / `maxScrolls`），
   * 而重做一次 locate = 重新滚动定位 + 一次拟人点击，是这条路径的耗时大头。
   */
  retryEvery?: number
}

/**
 * 动作**之前**的闸门：等 `selector` 占的那块区域**画完并停住**再动手。
 *
 * 存在的理由是一件 DOM 答不了的事：Cloudflare Turnstile 的 widget 活在 **closed shadow root**
 * 里，任何选择器都看不见它——实测对话框打开后 DOM 连续 9.3 秒一个字节不动，`window.frames.length`
 * 也不动，而那 2 秒里复选框正从"没有"变成"转圈"再变成"可点"。**页面不肯说,但它在画。**
 *
 * 而且早点不是白点，是**有害**的：在 widget 就绪之前点下去会把它打进失败态，之后再点几次都
 * 救不回来（实测重做 8 次全废）。所以这里必须是"等到"，不能是"先试试再说"。
 *
 * 判据是**"变过了 + 停住了"，不是"长得像某张参考图"**：开始等的时候截一帧当基线（此刻还是空的），
 * 之后连续截，直到出现一帧**与基线不同、且连续 `stableFrames` 帧字节完全一致**的画面。
 * 转圈时每帧都在变，自动被排除；还没开始画时和基线相同，也被排除。
 *
 * 这样就**不需要存任何参考图**：没有二进制资产要随 recipe 走、没有 DPI/主题/改版会让它失效，
 * 也不用把画面发给任何模型——截图裁到元素自己的盒子，逐帧比字节，全程本地、离线、零依赖。
 */
export interface StepSettle {
  /** 要盯的那块区域 = 这个选择器占的盒子。**DOM 说在哪，画面说什么时候。** */
  selector: string
  /** 连续多少帧字节一致才算"停住"（默认 3）。 */
  stableFrames?: number
  /** 两帧之间隔多久采一次（ms，默认 250）。 */
  intervalMs?: number
  /** 上限（ms，默认 `SETTLE_DEFAULT_MS`）。到点还没停住就照常执行动作，不阻断——
   *  它是闸门不是判决，真正的成败由这一步的 `expect` 说了算。 */
  timeout?: number
  /**
   * 放宽判据：**只要"停住了"，不要求"变过了"**。默认（不写）= 两条都要。
   *
   * ### 为什么需要它
   *
   * "变过了"那一半是**相对开始等的那一刻**取的基线。当变化由**上一步**触发（点一下按钮，
   * 它重新加载一张图），而上一步自己耗时又长于那次重绘时，等这一步开始看，画面**早就是终态
   * 了**——基线就是终态，此后永不改变，于是必然等满 `timeout` 再放行。
   *
   * 代价是实打实的，而且**全程静默**（timeout 不致命，照常往下走）：东财登录 recipe 的验证码
   * 那一步，活体连续三次都是 15.0s+，一条日志都没有；打开探针才看见
   * `settle timeout 15056ms/52帧`——52 帧截图，一次都没和基线不同过。而那一步真正干活只要
   * 2.7 秒，识别本身 10ms。它"能用"纯属巧合：等满 15 秒当然保证图加载完了。
   *
   * ### 什么时候可以开
   *
   * **只有当上一步的耗时可靠地长于那次重绘时**才对——否则"连着 N 帧不变"会在**旧画面**上
   * 立刻满足，你拿到的是上一张图。东财那条满足：step#0 那次可信点击活体实测 1.2–10.3s，
   * 而一张 101×36 的验证码远早于此就到了。
   *
   * 判据本身仍在：还是要连着 `stableFrames` 帧字节一致，转圈动画那种照样被排除。
   *
   * 与 `expect.alreadyThere` 是同一个立场的两处体现——**"我知道它本来就成立"必须显式说出来**，
   * 而不是把闸门悄悄放宽成恒真。同样地：**极少数才该用**。
   */
  alreadyStable?: boolean
}

type RecipeActionKind =
  | { kind: 'goto'; url: string }                 // within cookieDomain (runtime guard); url may contain {param} holes
  | { kind: 'scroll'; dwell_s: [number, number]; maxTimes: number; noProgressStop: number }
  | { kind: 'openItems'; selector: string; count: [number, number]; dwell_s: [number, number]; back: boolean; feature?: ActionFeature }
  /**
   * Trusted click of ONE named element. Distinct from `openItems`, which is "open the Nth
   * card of a feed" — this is the plain "press this button" that operating a form needs and
   * the feed vocabulary never had.
   *
   * `position` = CSS px from the element rect's top-left; omitted = its center (today's
   * behavior everywhere else). Field name and semantics are Playwright's
   * `locator.click({ position })` — not a Stream invention. It exists because the center is
   * the WRONG point for some real targets: a Cloudflare Turnstile widget is 300x72 with the
   * checkbox in the leftmost square and text across the middle, so a center click lands on
   * the label and does nothing.
   */
  | {
      kind: 'click'
      selector: string
      position?: { x: number; y: number }
      feature?: ActionFeature
      /**
       * **不发真鼠标，在页面里直接 `el.click()`。** 缺省（不写）= 可信点击，今天所有站的行为。
       *
       * ### 为什么它能快三个数量级
       *
       * 一次可信点击**不是一个动作，是 11 次往返**：1 次问元素在哪 + 8 次把鼠标一步步挪过去
       * （拟人轨迹）+ 按下 + 松开。而每一个鼠标事件浏览器都要先做**命中测试**（这个坐标下面
       * 压着哪个元素），命中测试要靠已经渲染出来的画面，所以它**等下一帧**——而 Chrome
       * 不给看不见的标签画帧（采集标签是后台开的）。于是每个事件干等 0.7–3.5 秒。
       *
       * 同一轮运行里的对照（2026-09-03，东财登录）：
       *
       * | | 发几条命令 | 总耗时 | 每条 |
       * |---|---|---|---|
       * | `type`（键盘） | 6 | 9–164ms | **2–27ms** |
       * | `click`（鼠标） | 11 | 7.0–35.1s | **700–3500ms** |
       *
       * 键盘事件不需要命中测试（直接送给获得焦点的那个元素，DOM 自己知道是哪个），所以毫秒级。
       * 这条对照同时排除掉了中继 / 扩展 / 网络——它们对两种事件是同一条路。
       *
       * 页内 `el.click()` 走的是**同一条 `Runtime.evaluate` 通道**（和键盘那侧一样不需要帧），
       * 一跳搞定：7–35 秒 → 毫秒级。
       *
       * ### 什么时候**不能**用
       *
       * 站点在手势上做反爬时。可信点击的存在理由就是这个，有活体代价背书：2026-07-25
       * console.groq.com 建 API key，人手点能过 Cloudflare Turnstile，瞬移点过不了。
       * 页内点击更弱一档——事件的 `isTrusted` 是 `false`，站点一查就知道。
       *
       * **判据不是"这个站看起来正不正规"，是"它查不查我们的手势"。** 判不出来就别开：
       * 默认那档只是慢，开错了是登录/提交被静默忽略。
       *
       * 失败长什么样：站点的 handler 根本不跑，页面毫无反应——和"选择器选错了"一模一样。
       * 所以这一格**只该配在有 `expect` 盯着结果的步骤上**，让它以"判据没满足"的形式暴露，
       * 而不是以"后面某一步莫名其妙失败"的形式。
       */
      synthetic?: boolean
    }
  | { kind: 'type'; selector: string; text: string; feature?: ActionFeature } // text may contain {param} holes
  | { kind: 'submit'; selector: string }
  /**
   * **把浏览器所在机器上的本地文件放进页面的 `<input type=file>`**（CDP `DOM.setFileInputFiles`）。
   *
   * 它存在的理由是**大文件不该走控制通道**。此前把图交给页面只有一条路：编成 data URL 塞进
   * params，而 `evaluate` 会把整个参数袋序列化进一条 `Runtime.evaluate` 表达式——20 层 PNG
   * 共 16MB 就是一条 21MB 的消息，还要挤在页内求值 30s 的预算里（photopea-run 自己写着
   * "图多就先缩小"）。走这一步，**文件由浏览器进程直接读盘**，一个字节都不经过扩展通道，
   * 页面拿到的 `File` 和用户在文件对话框里选中的一模一样。
   *
   * `paths`：按换行拼的绝对路径，通常写 `{files}`——一个 `format:'path', multiple:true` 的参数
   * 翻译后的形状（WSL 路径已经翻成 Windows 侧认的，见 `validate-params.ts`）。路径按**浏览器
   * 那台机器**解释。为空（参数缺席）就跳过并写进 trace，不算错：一份 recipe 可以同时收
   * "本地文件"和"小图 data URL"两种入口。元素不在 / 不是文件输入框 / CDP 拒绝都**抛**。
   */
  | { kind: 'setFiles'; selector: string; paths: string }
  /**
   * **问外面一件事，把答案绑成参数给后面的步骤用。**
   *
   * 在这一格之前，recipe 的词汇只有"对页面读"和"对页面写"——中途没有任何办法向外要一个
   * 东西。而"模拟人"这件事本来就包含它：人在填表时会去查一张表、认一张图、看一眼手机上的
   * 一次性口令。第一个用例是图形验证码（截图 → 识别服务 → 填回输入框），但这一格是**通用**
   * 的：让模型判一眼"这页是不是登录墙"、查一个换算、取一个口令，都是同一个形状。
   *
   * ### 三条焊死的边界（都不是洁癖，各自堵一个具体的洞）
   *
   * 1. **只能点名一个 `service`，给不了 URL。** recipe 是**能从 npm 装的第三方数据**
   *    （见 `share-recipes`）。一个能往任意地址发任意字节的步骤就是一个外泄原语：装了一条
   *    别人写的 recipe，它就能把你登录态页面上的东西打包送走。`service` 由宿主解析
   *    （`pluginTarget` → `/_p/<service>`），**类型上根本表达不出一个 URL**——这比"运行时
   *    校验 URL 白名单"强，因为后者迟早有人放宽。解析不到就是硬失败。
   *
   *    **范围是"这台机器上已装包声明过的某个服务"，不是"本包自己的服务"**（早先这行注释
   *    写成了后者，与实现不符——`callPluginService` 用的就是全局 `pluginTarget`）。而且后者
   *    是错的目标：`dfcf` 那条登录 recipe 要用的正是 `ddddocr` 包的服务，跨包组合恰恰是这
   *    一格的用途。真正挡住外泄的是"目的地必须是用户自己装过的容器"——想把数据送到作者的
   *    服务器，他就得让用户装一个自己的容器，那是一次显眼得多的安装决定。
   * 2. **送出去的只有"某个元素那一块的截图"，别的一律没有。** 不给 `text`、不给 `html`、
   *    更不给整页。这是今天这个用例需要的最小原语，同时把"把 DOM 发给我"这条路直接堵死。
   *    **将来要加一种新的 `input` 来源，得按同样的标准重审一次**——第 1 条只挡住了"发给谁"，
   *    挡不住"发什么"。
   * 3. **必须在 `meta.effects` 里申报 `call`。** 安装预览按 effects 亮牌
   *    （`recipe-install.ts`），"这条 recipe 会把页面上的东西发给一个服务"属于装它的人有权
   *    先知道的事。申报了才让跑。
   *
   * `bind` 把结果写进**本次运行的参数袋**，所以后面任何吃 `{param}` 的地方（`type` 的
   * `text`、`goto` 的 `url`）都能引用它。参数袋是逐步传下去的同一个对象，这一步是全词汇表里
   * 唯一会往里写的——写这一格时请留意，它是有意的，不是顺手。
   */
  | {
      kind: 'call'
      /** 某个已装包 `stream.backend` 声明的服务 id（可以是别的包的——跨包组合是本意）。
       *  **不是 URL**，见上面第 1 条。 */
      service: string
      /** 服务上的路径，必须以 `/` 开头且不含 host——拼 host 是宿主的事。 */
      path: string
      /** 送什么出去。今天只有这一种来源，理由见上面第 2 条。 */
      input: { shotOf: string }
      /**
       * 随请求一起发的**静态选项**，原样并进 body（键名不许是 `image`，那一格归 `input`）。
       *
       * 用途是"同一个通用服务，这个站要它换个档位跑"。第一个用例是 OCR 的字符集：
       * `{ charset: "0123456789" }`——**限字符集是通用机制（归服务），限成哪一套是站点知识
       * （归 recipe）**。东财的验证码是 4 位纯数字，而识别器默认那个模型是给字母数字混排调
       * 的，实测 12 张里错 3 张，错的全是把数字认成字母（`74Z1`/`4g94`/`3o79`）。既有实现
       * （Cockpit 的 `auth.py`）也是靠 `ocr.set_ranges("0123456789")` 解决的。
       *
       * ### 这一格为什么不违反上面第 2 条
       *
       * 第 2 条挡的是"**页面上的东西**被送出去"。这里只能写 recipe 文件里的**字面量**：
       * 引擎**绝不对它做 `{param}` 插值**，所以它表达不出参数袋里的任何东西——而参数袋里
       * 装着宿主注入的账号和密码（`secret_params`）。这不是洁癖：允许插值的话，一条第三方
       * recipe 只要写 `options: { note: "{jymm}" }` 就能把交易密码送到它指定的那个服务，
       * 而那条 recipe 在安装预览里看起来和现在一模一样。**能力上不给，比运行时拦截可靠**。
       */
      options?: Record<string, string | number | boolean>
      /** 从回来的 JSON 里取哪一格（`getPath` 语法，如 `text` / `result.code`）。 */
      from: string
      /** 绑成哪个参数名，后续步骤用 `{名字}` 引用。 */
      bind: string
      /**
       * 结果必须匹配这个正则（未锚定就是"包含"，要整串就自己写 `^…$`），不匹配 = 这一步失败。
       *
       * **这是安全闸，不是省一次往返。** 原型是 OCR 认验证码：识别器会时不时吐出一个明显
       * 不合法的结果（实测 8 张里出过一个 3 位数）。把它照样填进去提交，就是拿用户的账号去
       * 试一次注定失败的登录——而"连续几次失败登录"在券商那边是有后果的。既有实现
       * （Cockpit 的 `auth.py`）在这一点上是一样的立场：`len(code)!=4 or not isdigit()`
       * 直接刷新重来，绝不提交。
       *
       * 配这一步自己的 `retryFrom` 用：不匹配 → 整段重来（刷新那张图再认一次）。**重试要写在
       * 这一步上**——写在后面某一步的 `expect` 里是够不着的，那一步压根跑不到（见
       * `RecipeAction.retryFrom` 头注记的那次活体代价）。
       */
      match?: string
    }

/**
 * 任何一种动作都可以挂 `settle`（动作前的闸门）、`expect`（动作后的判据），以及
 * `retryFrom`/`retryTimes`（**这一步失败了就回到第 N 步整段重来**）。
 *
 * ### 为什么重试挂在**步骤**上，不挂在 `expect` 里
 *
 * 它管的是"这一步失败了怎么办"，而一步有**两种**失败法：`expect` 那个断言没满足，或者
 * 这一步自己拿回来的结果不合格（`call` 的 `match` 没过）。引擎从一开始就把两者一视同仁
 * （`StepExpectError` 与 `StepResultError` 都算可重试），**只有声明的位置放错了**：写在
 * `expect` 里，就等于要求一个 `call` 步为了声明重试而先编出一个 `expect.selector`——而
 * `selector` 是必填的，OCR 认完之后页面上根本没有东西可断言，编一个出来就是把恒真判据写
 * 进去，那正是 `alreadyThere` 那道闸门专门在防的事。
 *
 * 代价是实打实的（2026-09-03 活体）：东方财富登录的 recipe 把重试写在**提交**那一步的
 * `expect` 上，而识别失败发生在 step#1，那一步永远跑不到——注释信誓旦旦写着"不合格会被
 * retryFrom 接住"，实际一次都没重来过，整条流程当场终止。**注释描述了一个不存在的机制**，
 * 读起来毫无破绽。
 */
export type RecipeAction = RecipeActionKind & {
  settle?: StepSettle
  expect?: StepExpect
  /**
   * 这一步失败时，**从第几步整段重来**（0-based，必须小于当前步）。缺省 = 不重来。
   *
   * 和 `expect.retryEvery` 是两件事，别合并：那个重做**这一步**（点击没落到按钮上，再点
   * 一次），这个重做**一段**（第一次的输入本身就作废了，得从头再走一遍）。
   *
   * 存在的理由是一类"一次不一定成、而重来必须回到更早那一步"的流程，原型是**图形验证码**：
   * 识别不合格、或提交被拒 → 那张验证码已经作废 → 必须回到"刷新图 → 重新识别 → 重新填"，
   * 只重做提交是纯粹的空转。同一条流程的既有实现（Cockpit 的
   * `ashare_automation/dfcf/auth.py`）就是一个 `for attempt in range(1, 6)` 把
   * "认码 → 填码 → 提交 → 判导航"整段圈住，两种失败走同一条 `continue`，上限 5 次——
   * **它不是保险，是必需品**（实测单次识别命中率 75%）。
   *
   * 一段里允许多处各自宣告重来（登录那条就是：`call` 认码失败回 0，提交被拒也回 0），
   * 各记各的次数、互不扣减——它们是两种不同的失败，混在一起数会让"账密真错"提前耗光
   * 本该留给识别的重试。
   *
   * 与 `retryTimes` 成对：只给这一格而不给次数上限，等于把重试次数交给 timeout 去决定。
   */
  retryFrom?: number
  /** `retryFrom` 那段最多整体重来几次（含第一次尝试）。缺省 1 = 不重来。 */
  retryTimes?: number
}

/** Browser-session lifecycle is independent from the actions a Recipe performs. */
export interface RecipeSessionSpec {
  /** facility-scoped owner used to reuse a logged-in browser context */
  facility: string
  /** a lane WITHIN a facility: one facility can hold several tabs (e.g. a 'feed' lane and a
   *  'search' lane) that SHARE one logged-in context but run in parallel on their own task
   *  tails. Absent = the facility's default lane (the historical one-tab-per-facility). The
   *  launcher is still resolved by `facility` only, so all lanes reuse the pooled context. */
  laneKey?: string
  /** one-shot tabs close after the run; persistent tabs survive task leases */
  lifecycle: 'one-shot' | 'persistent'
  /**
   * 常驻：persistent lane **不被闲置回收、不被腾位置挤掉、跑出 blocked 也不关**，只在用户自己关掉
   * 标签时才重开（acquire 探活发现没了）。给「每开一次都是一次昂贵整页加载、而且页面里有用户的东西」
   * 的工作台用——Photopea：冷载一次 ~10MB，频繁重开会撞站点的连接限制；跑完的 PSD 就留在那张
   * 标签里给人看、给人改，回收它等于删人家的活。采集类 lane 别开它：闲置回收是它们的资源预算。
   */
  keepAlive?: boolean
  /**
   * 这次运行**要不要用户伸手**——不是"想不想看得见"。
   *
   *  - `unattended` — 采集。后台 tab，用户不必在场，**永远不抢屏幕**。所有 Source 都是这一档。
   *  - `interactive` — 用户得亲自动手的流程（登录、扫码、自助建 key）。开在他当前窗口里可见，
   *    因为他要在上面点。这类天然只可能由用户点出来，不存在被调度器触发的问题。
   *
   * **判据是"谁动手"，不是"谁想看"。** 早先分三档（silent/debug/foreground）是按后者分的，
   * 于是同一件事有了两个名字（`debug` 与 `foreground` 都是"让用户看着"），而"我开发时想看一眼"
   * 这种**一次运行**的临时需求被写进了随 git 走的 recipe 文件里——开发完必须记得改回去，忘了
   * 就是定时任务半夜抢屏。开发期要观察，用探针和失败留痕（`RECIPE_PROBE`、`data/failures`），
   * 别改这个字段。
   *
   * **看得见 ≠ 抢焦点。** 采集 tab 一直在标签栏里，用户随时能自己切过去看；`interactive` 只
   * 决定标签开在前台还是后台，executor 不碰焦点。把窗口提到最前只发生在用户**显式要求**时
   * （点「带我去看登录页」→ `RecipeSessionManager.focusFacilityTab`）。
   *
   * 后台档为什么点得动（2026-07-28 实测推翻旧结论，spec §3）：隐藏 tab **不拒绝**可信输入，
   * 只是压着等合成器产帧。2026-07-29 起 lane 建好就开 `Emulation.setFocusEmulationEnabled`，
   * 隐藏 tab 的可信点击一次 162–185ms，比它当活动标签时的 204–257ms 还快——所以
   * 「要可信点击」从来不是要前台的理由。对照见 write-recipe/references/session-runtime.md。
   */
  visibility: 'unattended' | 'interactive'
}

/** Canonical step name. `RecipeAction` remains the v1 on-disk compatibility shape. */
export type RecipeStep = RecipeAction | {
  /**
   * Call the site's OWN request client in the logged-in page, paging by its cursor.
   * Render-INDEPENDENT: no scroll, no focus, no trusted input — so it is the only
   * harvest that works in a silent background tab (Chrome does not process CDP Input
   * for a tab that is not in the focused foreground window). The call is
   * `async (cursor, num, params) => ({items, cursor})`; its items feed the recipe output.
   */
  kind: 'evaluate'
  call: string
  /** dot-path to the item array within the call's return value */
  itemsAt: string
  /** dot-path to the next-page cursor; empty/absent stops paging */
  cursorField?: string
  pageSize?: number
  maxPages?: number
  /**
   * dot-path 到「这一页只是还在等、不是空结果」的标记。为真的页**不进 harvest、不计空页**，
   * 只推进 cursor 接着调。给那些把分页当等待循环用的 recipe（页内一次求值有 relay 30s 上限，
   * 生图要 60s+ 就得分几页等）：没有它，等待页会被 assert 判成 malformed、连两页就 drift，
   * 所以慢一点的生成永远跑不完。
   */
  pendingField?: string
  /**
   * 动作前的闸门，和动作步骤上的 `settle` 同一契约（见 `StepSettle`）。
   * 这一步不操作页面、只调站点自己的 JS，所以**通常没必要声明它**——收下它只是因为
   * 「所有 step 都过同一道闸门」比「这一类是例外」少一条要记的规则，不声明就是零代价的空操作。
   */
  settle?: StepSettle
} | {
  kind: 'openTarget'
  selector: string
  /** call-time param whose identity must appear in the target element href */
  identityParam: string
  maxScrolls?: number
  /** explicit same-origin fallback when a virtualized card cannot be recovered */
  fallbackUrl?: string
  /**
   * 动作前的闸门，和动作步骤上的 `settle` 同一契约（见 `StepSettle`）：**点这张卡之前**，
   * 等它所在的那块区域画完并停住。虚拟列表还在重排时点下去，点着的往往是别的卡。
   */
  settle?: StepSettle
  /**
   * Restore the feed context after observers finish reading the opened target. `back` is
   * checked: if it does not land in `entryUrl`'s context the runner navigates there (see the
   * `restore()` comment in recipe-runner — `entryUrl` is this recipe's WORKING context, which
   * is not the same page as `fallbackUrl`).
   */
  restore?: 'back' | 'entry'
  /**
   * The author's EXTRA verdict, on top of this step's built-in open-confirmation (does the url
   * carry the identity). Built-in answers "did it open"; this answers "is what opened the thing
   * I wanted / is the page ready". Runs after the built-in confirmation and, crucially, BEFORE
   * the observers read — see the gate in recipe-runner.
   *
   * `retryEvery` is REJECTED at load here: it redoes the action, and this step already retries
   * via `maxScrolls`.
   */
  expect?: StepExpect
} | {
  /**
   * Closed-loop, anthropomorphic locate-then-click: read the viewport, use the ordered noteId
   * ledger (a run param) to decide direction/distance, scroll (or eval-jump) the target card into
   * view, then click it. Replaces openTarget's blind scroll-down for in-feed detail opens.
   */
  kind: 'locate'
  selector: string
  /** call-time param whose identity is the target note id */
  identityParam: string
  /** call-time param holding a JSON array of the ordered loaded note ids (the ledger) */
  orderedParam: string
  maxSteps?: number
  fallbackUrl?: string
  /** same contract as `openTarget.restore` — `back` confirms it landed in `entryUrl`'s context */
  restore?: 'back' | 'entry'
  /** 同 `openTarget.settle`：找卡、点卡**之前**等这块区域画完停住。 */
  settle?: StepSettle
  /**
   * Same contract as `openTarget.expect`: the author's extra verdict, run after the built-in
   * open-confirmation and before the observers read. It also gates the `fallback-nav` route —
   * `expect` judges the FINAL state, not which road got there.
   *
   * `retryEvery` is REJECTED at load: redoing this step means re-locating + another humanized
   * click (~1.8s, humanize being the dominant cost of this path), and it already falls back to
   * `fallbackUrl`.
   */
  expect?: StepExpect
}

/**
 * The dedupe/targetCount/drift core the HarvestAccumulator runs on, independent
 * of where each item batch comes from. Both an XHR response body and a DOM read
 * are shaped into `{ [itemsAt]: rawItem[] }` and fed through this.
 */
export interface AccumulatorInput {
  /** dot-path to the item array within a fed body (e.g. "data" for XHR, "items" for DOM) */
  itemsAt: string
  /** dot-path to a stable per-item id used for dedupe (e.g. "article_id" / "noteId") */
  dedupeBy: string
  /** stop once this many DEDUPED items are collected */
  targetCount: number
  /** target field -> dot-path within a single raw item */
  mapping: RecipeFieldMap
  /** existence guards on a fed body; see drift semantics in harvest.ts */
  assert?: RecipeAssert[]
}

/**
 * Browser-recipe harvest source A — passive XHR: listen to `page.on('response')`, match
 * urlPattern, read the JSON body. Rich structured data, but breaks if the site
 * encrypts/obfuscates its response bodies (calibrate on the live response).
 * `mode` is optional for backward compat (absent === 'xhr').
 */
export interface XhrHarvest extends AccumulatorInput {
  mode?: 'xhr'
  /** glob-ish pattern (contains '*') matched against response URLs, e.g. "*​/recommend_all_feed*" */
  urlPattern: string
  mapping: RecipeFieldMap
  assert: RecipeAssert[]
}

/** How to pull one field out of a rendered card element (runs in-page). */
export interface DomFieldSpec {
  /** sub-selector within the card; omit to read the card element itself */
  selector?: string
  /** attribute to read (e.g. "href", "data-note-id"); omit to read textContent */
  attr?: string
  /** optional regex; capture group 1 (or the full match) replaces the value —
   *  e.g. extract the note id out of an href like "/explore/(\\w+)" */
  extract?: string
}

/**
 * Browser-recipe harvest source B — DOM extraction: after each scroll tick, read the
 * rendered feed cards straight out of the DOM. Immune to request signing /
 * body encryption (reads what the session actually renders). Dedupe-per-tick
 * handles virtualized lists that recycle scrolled-past nodes.
 */
export interface DomHarvest {
  mode: 'dom'
  /** CSS selector matching each feed card in the rendered DOM */
  itemSelector: string
  /** output field name -> how to extract it from a card */
  fields: Record<string, DomFieldSpec>
  /** which `fields` key holds the stable per-card dedupe id (e.g. "noteId") */
  dedupeBy: string
  /** stop once this many DEDUPED cards are collected */
  targetCount: number
}

/**
 * Browser-recipe harvest source C — SSR state read: read a JSON blob the site already
 * server-rendered onto `window` (e.g. xhs `__INITIAL_STATE__.feed.feeds`) with ONE
 * Runtime.evaluate. No scroll, no focus, no input, no self-initiated request — the
 * data is in the document the moment it parses, so it works on a background/unfocused
 * tab and never trips the focus/render heuristics that get a logged-in session voided,
 * nor the request-signing an active fetch would need. First SSR batch only (~one
 * screenful); deeper pages come from the site's own homefeed XHR, which needs a
 * foreground render — a separate path. `actions` is empty for this mode.
 */
export interface StateHarvest {
  mode: 'state'
  /** dot-path FROM `window` to the item array, e.g. "__INITIAL_STATE__.feed.feeds" */
  statePath: string
  /** dot-path to a stable per-item id used for dedupe (e.g. "id") */
  dedupeBy: string
  /** stop once this many DEDUPED items are collected */
  targetCount: number
  /** target field -> dot-path (or `{path}`-template) within a single raw item */
  mapping: RecipeFieldMap
  /** existence guards on the read result; a miss (shape moved) trips drift */
  assert?: RecipeAssert[]
}

/**
 * Browser-recipe harvest source D — in-page eval: run a recipe-supplied JS function IN the
 * logged-in tab that calls the site's OWN request client (the module that already
 * assembles every signed header — x-s / x-t / x-s-common — in its interceptor), so
 * we reproduce the site's request byte-for-byte with ZERO reverse-engineering. Unlike
 * DOM/state this is render-INDEPENDENT: it neither scrolls nor reads the rendered feed,
 * so it works on a background/unfocused tab with no anti-throttle flags — a plain
 * `fetch` runs regardless of visibility. The `call` is `async (cursor, num) => ({items, cursor})`;
 * the engine invokes it per page, threading the returned cursor until targetCount.
 * `actions` is empty for this mode. (Hand-rolling headers ourselves instead of using
 * the site's client is exactly what trips risk control — e.g. xhs `300011 账号异常`.)
 */
export interface EvalHarvest {
  mode: 'eval'
  /** a JS function-expression string `async (cursor, num) => ({items, cursor})`, run in-page */
  call: string
  /** dot-path to the item array within the call's return value (e.g. "items") */
  itemsAt: string
  /** dot-path to the next-page cursor within the return value (e.g. "cursor"); empty/absent stops paging */
  cursorField: string
  /** dot-path to a stable per-item id used for dedupe (e.g. "id") */
  dedupeBy: string
  /** stop once this many DEDUPED items are collected */
  targetCount: number
  /** items requested per page (passed as `num` to the call); default 20 */
  pageSize?: number
  /** hard cap on pages, regardless of cursor; default 30 */
  maxPages?: number
  /** target field -> dot-path (or `{path}`-template) within a single raw item */
  mapping: RecipeFieldMap
  /** existence guards on each page's items; a miss (shape moved / risk-control body) trips drift */
  assert?: RecipeAssert[]
}

/** How a browser recipe harvests items. XHR body (default), rendered DOM, SSR state, or in-page eval. */
export type Harvest = XhrHarvest | DomHarvest | StateHarvest | EvalHarvest

export interface NetworkRecipeObserver {
  kind: 'network'
  urlPattern: string
  /** hard bounds keep the extension relay from becoming an unbounded packet logger */
  windowMs: number
  maxBodyBytes: number
  /** Optional observer-local shape; otherwise inherits recipe.output. */
  input?: RecipeOutput
}

export interface StateRecipeObserver {
  kind: 'state'
  statePath: string
  trigger: 'entry' | 'after-step' | 'final'
  /** Normalize a state value before it enters the accumulator. */
  collection?: 'array' | 'values' | 'single'
  /** when collection is values, copy each object-map key into this item field */
  keyField?: string
  /** when collection is values, only accept the map entry whose key equals this
   *  call-time param — a persistent tab's state map accumulates entries across
   *  runs, so an unfiltered read can return a PREVIOUS run's value */
  identityParam?: string
  /** bounded readiness wait for state populated after a trusted navigation/click */
  maxWaitMs?: number
  pollMs?: number
  /** dot-path ON A MATCHED ITEM that must be truthy before the snapshot is taken — a store
   *  fills in stages (the note lands, its comment list a beat later), so "the item exists"
   *  is not the same as "the item is complete". On timeout the partial item is taken anyway. */
  readyWhen?: string
  input?: RecipeOutput
}

export interface DomRecipeObserver {
  kind: 'dom'
  itemSelector: string
  fields: Record<string, DomFieldSpec>
  trigger: 'entry' | 'after-step' | 'final'
  fallback?: boolean
  input?: RecipeOutput
}

export type RecipeObserver = NetworkRecipeObserver | StateRecipeObserver | DomRecipeObserver

export interface RecipeOutput extends AccumulatorInput {
  /**
   * 条目时间戳从哪来。缺省 = mapping 给的 `pubDate`（上游的**发布时间**）。
   *
   * `'harvest-order'`：时间戳 = 本轮采集时刻 − 条目在本轮合并结果里的序号（秒），也就是
   * **按采到的先后排**，mapping 里的 `pubDate` 被盖掉（原值仍在 raw 上）。给「我的收藏」这类
   * 清单用：上游只给每条内容的发布时间、不给「我什么时候收藏的」，而页面顺序就是收藏顺序。
   * 照发布时间排的后果是昨天收藏的一条老视频沉到 150 条的第 142 位——收藏页前 30 条里看得见、
   * Stream 里翻不到，表现成「采集漏了」（2026-09-03 抖音收藏实测：前 30 条里 10 条是这种）。
   *
   * 盖章的地方只有一处：`stampHarvestOrder`（`src/adapters/replay/adapter.ts`），观察者拦到的
   * 首批和 evaluate 翻出来的后续批合并之后一起盖——recipe 自己算不了：network observer 的
   * mapping 是声明式 dot-path，算不出「现在减序号」。
   */
  timestampFrom?: 'harvest-order'
  /**
   * 哪些 mapping 字段是**文件**（页内以 base64 回来的二进制），落盘之后字段值换成绝对路径。
   *
   * 键 = mapping 里的字段名。`ext` 写死扩展名，或 `extFrom` 指向同一条 item 里装着格式的
   * 字段（如 photopea 的 `format`，值 `png` / `jpg:0.8` / `psd`，取冒号前那段）。
   *
   * 只对**动作 recipe** 生效（落盘在 `src/mcp/action-artifacts.ts`，目录 `<dataDir>/action-artifacts/`，
   * 7 天回收）。为什么不让 base64 留在结果里：结果会原样落进 `agent-runs.db`，而账本拒收超过
   * 1MB 的 result（`RESULT_MAX_BYTES`）——一张导出图就是几十 MB，编成文本塞进账本的下场是
   * 开机 OOM（2026-09-22）。
   */
  files?: Record<string, RecipeOutputFile>
}

export interface RecipeOutputFile {
  ext?: string
  extFrom?: string
}

export interface RecipePolicy {
  /** minimum spacing between task-level upstream-producing actions */
  minActionIntervalMs?: number
  /** stop a task rather than retrying forever */
  maxTaskMs?: number
}

/**
 * Canonical runtime form. V1 BrowserRecipe remains the accepted on-disk shape while
 * packages migrate; `canonicalizeBrowserRecipe` converts it before the new runner.
 */
export interface CanonicalBrowserRecipe {
  version: number
  kind: 'browser'
  sourceId: string
  cookieDomain: string
  entryUrl: string
  entryWait?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle'
  /**
   * Ride whatever page the persistent tab already holds instead of re-navigating to
   * `entryUrl` at run start. For an in-feed detail open: the tab already shows the home
   * OR search feed the note came from, so `openTarget` clicks the card there (opening the
   * SPA overlay that populates the same note state) rather than a slow standalone page
   * load. `entryUrl` is then used only as the cold-launch landing / openTarget fallback.
   */
  rideCurrentPage?: boolean
  /**
   * Ride a tab the USER already has open in the session tab group instead of Stream's own lane.
   *
   * A tab in the group is a tab the user handed to the AI ("拖入组即授权" — the extension will
   * attach to any group member, not only the ones it created). When the user is working in that
   * tab themselves, its render is live; Stream's own lane holding the same URL is a stale copy of
   * it and must be reloaded to catch up. Riding the user's tab needs no reload at all.
   *
   * `urlPrefix` picks candidates among group tabs. `param` names the run param holding the exact
   * URL: given → the tab with that URL is ridden (absent → own lane, as before); omitted → the ONE
   * matching tab is ridden and the param is filled from it — zero or several matches fail loudly
   * instead of guessing.
   */
  adoptTab?: { urlPrefix: string; param: string }
  loginCheck: LoginCheck
  session: RecipeSessionSpec
  steps: RecipeStep[]
  observers: RecipeObserver[]
  output: RecipeOutput
  policy?: RecipePolicy
  /**
   * Treat an empty harvest as a valid `ok` result instead of `blocked`. For a FEED source
   * zero items means something broke (page never loaded, shape moved, login wall), so the
   * runner blocks — the right default. A PROBE recipe (open one share URL, report whether it
   * has files) legitimately returns nothing when the target is dead/empty, and that must NOT
   * mark the source blocked / trip its health. Drift is still surfaced: a moved response shape
   * fails the observer's `assert` → `drift`, kept distinct from "the target is genuinely empty".
   */
  allowEmpty?: boolean
  /** 这份 recipe 的产出**同时也是一本有序账本** —— 见 RecipeLedger */
  ledger?: RecipeLedger
  /** one-shot secret capture — see RecipeExtract */
  extract?: RecipeExtract
  meta?: RecipeMeta
}

/**
 * 声明「这次运行在这条 lane 的页面上铺开了哪些条目、按什么顺序」。
 *
 * 账本是 locate 的**坐标系**：detail 要在 feed 上找到某张卡片、把它滚进视口、可信点击，靠的
 * 就是"这条 lane 现在铺着这批 id、目标排第几"。没有账本，locate 一开始就 MISS，每次 detail
 * 都退化成整页导航到详情页（`fallbackUrl`）——出得来数据所以不报错，但那是安全网不是正常路径
 * （见 `.claude/skills/write-recipe/references/pipeline.md` §4）。
 *
 * **谁是账本的来源，就由谁声明。** 从前它是 homefeed 那个长命浏览会话的私有产物（`BrowseSession`
 * 持有一份有序 noteId 列表）；homefeed 砍掉之后来源换成 **search feed**——用户搜什么，就在那批
 * 结果上找卡片。声明写在 recipe 里而不是在引擎里认某个 sourceId，是因为"哪个字段是身份"本来
 * 就是站点知识（recipe 是数据），引擎只负责按声明记账。
 *
 * 记账语义是**整本替换，不是追加**：一次 feed 运行 = 这条 lane 的页面被换成了这一批，旧的那本
 * 描述的是一个已经不存在的页面。lane 关掉（显式收尾 / 闲置回收）时账本一起丢——它描述的是那个
 * 标签，标签没了账本就是废纸。
 */
export interface RecipeLedger {
  /** 产出条目里哪个字段是身份（xhs 是 `noteId`）——要和消费方 locate 的 `identityParam` 对上 */
  idField: string
}

/**
 * 一次性抽取：把页面上**只显示一次**的明文（刚建好的 API key）落进这个 Source 自己的
 * `runtime_config` secret 字段。没有它，"让 recipe 自动去开一个账号的 key"就断在最后一步：
 * 值只在那一屏存在，关掉再也拿不到。
 *
 * 这是 recipe 第一次获得**写凭据存储**的能力，所以守卫写在类型里而不是靠自觉：
 *
 * - **没有 ref**。目标 ref 由调用方从这份 recipe **自己的 manifest** 取（`runtime_config.ref`），
 *   recipe 体在运行期没有任何办法指名去写别处的配置。
 * - **字段必须已在该 manifest 里声明为 secret**，否则拒写 —— 不能凭空塞一个键进凭据存储。
 * - **恰好命中一处才写**。0 处或多处一律不写：往凭据槽里写一个猜的值，比不写坏得多，
 *   而且下游只会以"key 无效"这种无关症状爆出来。
 * - **值不进 trace / outcome / 日志 / DebugBox**，只经 sink 直达存储；写完只记长度。
 * - **只写不读**：没有把 runtime_config secret 送回页面的路径，也不要加。
 */
export interface RecipeExtract {
  /** `runtime_config.fields` 里的字段名（如 `apiKey`） */
  field: string
  /** 匹配的正则（字符串形式，无 flags）。必须恰好命中一处。默认在页面可见文本上跑，
   *  声明了 `from.network` 则改在捕获到的响应正文上跑。 */
  pattern: string
  /**
   * 去哪儿找这个值。缺省 = 页面可见文本（含表单控件的 value）。
   *
   * `network` = 从 URL 命中这个 glob 的**响应正文**里找。捕获由**引擎自己挂**（`ObserverPipeline`
   * 的 `secretCapture`，只捕获不累积）——recipe 不需要、也不该为此声明一个 network observer：
   * 凭证不是 item，声明成 observer 会让它进 items 管线，抓到的响应被空 output 判成 malformed →
   * drift，而 drift 会盖住抽取本身的结论。
   * 为什么需要这一档：有的平台**从不把明文放进 DOM**。智谱建完 key，列表里永远是掩码
   * （`be11...dE4X`），明文只在点复制时由 `/api_keys/copy/<id>` 单独返回、直接进剪贴板——
   * 页面文本这条路对它是死的（活体实测：点复制会多出且仅多出这一条请求）。
   *
   * 只在这个字段出现时，运行期才会给 observer 装上「回传响应正文」的钩子；不声明 = 不装，
   * 所以默认路径下引擎不会碰任何响应正文。判据不变：仍要**恰好命中一处**才写。
   */
  from?: { network: string }
  /**
   * 等这个值出现的上限（ms），默认见 `EXTRACT_DEFAULT_MS`。
   *
   * 为什么抽取自带等待、而不是在上一步挂 `expect`：**要等的东西就是要抽的东西**。提交之后
   * key 要一个网络往返才渲染出来，用 `expect` 就得再猜一个"key 显示出来了"的选择器——而
   * 这个正则本身已经是那个判据了，更准，也不会因为站点换了个 class 名就失效。
   */
  timeout?: number
}

export interface BrowserRecipe {
  version: number
  kind: 'browser'
  sourceId: string
  cookieDomain: string
  entryUrl: string
  entryWait?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle'
  loginCheck: LoginCheck
  actions: RecipeAction[]
  harvest: Harvest
  /**
   * Does this recipe need an INTERACTIVE managed window — scroll / render / trusted CDP
   * input (DOM harvest, future click-simulation)? Default derives from `harvest.mode`
   * (`dom` → true). When false (eval/state — passive in-page JS / fetch), the ext-cdp
   * transport runs in a lightweight BACKGROUND TAB it opens-and-closes per harvest, so a
   * background harvest never pops a window or steals focus. Set true explicitly for a
   * recipe that must drive the rendered page.
   */
  interactive?: boolean
  /** optional discovery metadata → synthesized SourceManifest (see RecipeMeta) */
  meta?: RecipeMeta
}

export type Recipe = FetchRecipe | HttpRecipe | HtmlRecipe | BrowserRecipe | CanonicalBrowserRecipe | DesktopRecipe

export function isCanonicalBrowserRecipe(recipe: Recipe): recipe is CanonicalBrowserRecipe {
  return recipe.kind === 'browser' && 'steps' in recipe && 'observers' in recipe && 'output' in recipe
}

/**
 * Does this recipe run a BROWSER at all?
 *
 * There used to be a `transport` field here answering "which browser" (cloak vs the user's
 * Chrome). There is only one browser now — the user's own, over the extension relay — so the
 * only question left is whether a recipe needs it, which decides whether the adapter must wake
 * Chrome before the run. `http`/`html` run none (plain HTTP / linkedom); `desktop` runs the host
 * agent's a11y engine over the /api/host relay, which is not a browser either.
 */
export function needsBrowser(recipe: Recipe): boolean {
  return recipe.kind !== 'http' && recipe.kind !== 'html' && recipe.kind !== 'desktop'
}
