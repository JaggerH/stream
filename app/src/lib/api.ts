import type {
  HarvestBrowserStatus,
  BrowserCapabilitySnapshot,
  ExtensionInstallOutcome,
  Enrichment,
  StatusInfo,
  Item,
  ItemSnapshot,
  PreviewResult,
  CollectedItem,
  Collection,
  CollectionDomain,
  SummaryPromptStatus,
  Media,
  MusicSearchResult,
  Stream,
  StreamCreate,
  Conversion,
  ConversionKind,
  ConversionKindInfo,
  PickSurface,
  PluginSourceListResponse,
  PluginSourcesSearchResponse,
  PluginSummary,
  PluginStatus,
  ProviderView,
  ProviderCallsiteView,
  ProviderMemberRef,
  ProviderCategory,
  PresentView,
  ResolveTargetSource,
  SourceDetail,
  SourceCandidate,
  SourceInfo,
  ChannelView,
  SpaceView,
  ChannelRecordDto,
  ChannelCreate,
  VideoSearchEvent,
  VideoSearchResult,
  VideoWorkCandidate,
  MappingSet,
  MappingEntry,
  FollowView,
  FollowRunRecord,
  AlistFile,
  NetdiskMountEntry,
  NetdiskMountsView,
  NetdiskReconcileResult,
  AuthorityStats,
  ReconcileShowConfig,
  ReconcilePreview,
  ReconcileExecResult,
  SuggestionView,
  SuggestionSummary,
  VoicePerson,
  SpeakerCluster,
  WatchProgressRow,
  RecipePackageSearchHit,
  InstalledRecipePackage,
  PackageSummary,
  PackageLogs,
  PackageRestart,
  PendingChange,
  RestartBackendResult,
  RestartMode,
  RecipePackagePreview,
  RecipePackageInstallResult,
  RecipePackageUpdate,
} from './types.ts'

/** Why the user cannot get results from this source — a PRECONDITION they can supply, not a
 *  fault. Structured by the backend (see `blockedOf`) precisely so the UI can offer the matching
 *  action; never re-derive it by pattern-matching `reason`, or the button ends up leading nowhere. */
export type BlockedReason =
  | { kind: 'login'; facility: string; label: string }
  | { kind: 'extension' }
  /** 站方在限流/挑战，我们自己的闸门正在退让——**用户什么都不用做**，到点自动重试。
   *  这一档**故意没有可点的动作**：正确的 UI 是一句带"还剩多久"的话（`retryAfterMs`），
   *  不是按钮。别在渲染处给它加登录入口——登录态是好的，那正是要区分它的原因。 */
  | { kind: 'cooldown'; facility: string; label: string; retryAfterMs?: number }

/** A content-search member that failed — `reason` is the core one-liner shown to the user,
 *  `stack` the full backend stack for the copy-to-clipboard diagnostic, `blocked` present only
 *  when the member is waiting on the user rather than broken. */
export interface SearchWarning {
  source: string
  reason: string
  stack?: string
  blocked?: BlockedReason
}

/** 一个成员跑了多久、结果如何。搜索是并发扇出，**总耗时只等于最慢那个成员**——所以"谁慢"
 *  只有这份分源明细能回答。每个被尝试过的成员都有一条，包括失败的（慢到超时的那个正是你
 *  想看见的）。 */
export interface SearchTiming {
  source: string
  ms: number
  outcome: 'win' | 'miss' | 'error'
}

/** Params for the unified enrichment endpoint — one per source, mapped to query.
 *  第一条是通用变体：`Content.enrich` 原样透传（包的 normalizer 定 source 与 params，params 逐个进
 *  query；`prefetch` 只给前端自己判预取 / 传输用，不进 query）。其余是宿主自己认识的形状。判别用
 *  `'params' in p`——`source` 是开放字符串，按 `source === 'xxx'` 收窄时它总留在候选里。 */
export type EnrichParams =
  | { source: string; params: Record<string, string>; prefetch?: boolean }
  | { source: 'link'; url: string }
  | { source: `${string}-comments`; vid: string; page?: number }

/** `POST /api/recipes/action` 的回执（镜像后端 `ActionRecipeResult`）。`status` 是调用方要判的那一格：
 *  `done` 才是做成了；`running` 时拿 `runId` 去 `actionRun` 轮询；其余全是没做成，`reason` 说清哪一类。
 *  失败态**不折成 HTTP 状态码**（后端原样 200 回），所以 `post` 不会替你抛——调用方必须自己看 `status`。 */
export interface ActionResult {
  status:
    | 'done' | 'running' | 'needs-confirmation' | 'not-found' | 'not-action' | 'invalid-params'
    | 'unsupported-kind' | 'no-desktop' | 'no-browser' | 'needs-login' | 'blocked'
  sourceId: string
  reason?: string
  runId?: string
  items?: Record<string, string>[]
}

/** `GET /api/recipes/action/:runId`（镜像后端 `ActionRunView`）。**两层状态**：`status` 只说 run 跑没跑完
 *  （`done` / `error` 是终态），跑完后 `result.status` 才是动作的成败。 */
export interface ActionRunView {
  runId: string
  domain: 'action'
  status: 'queued' | 'running' | 'done' | 'error'
  sourceId: string
  result?: ActionResult
  error?: string
  note: string
}

/** A backend connection — local (default) or a remote self-hosted instance. */
/** How to name one netdisk share to the backend: a link (the thing every caller actually
 *  holds — a search hit, a link an agent extracted) or the already-parsed pair. The backend
 *  parses the link with the same regexes it dedupes by, so nobody writes a second parser. */
export type ShareRef = { link: string } | { netdisk: string; pwd_id: string }

export interface Connection {
  baseUrl: string
  token?: string
  /**
   * Explicit WS upstream — carries `ws://<upstream>` when the page talks to a
   * backend on another origin. Same-origin: undefined, and the ws url is derived
   * from baseUrl.
   */
  wsBase?: string
}

/**
 * 访问令牌（`/api/*` 与 `/ws` 的门，见 src/http/access-guard.ts）。
 *
 * **本机访问根本用不到它**——后端对 loopback 免密，所以在自己机器上打开页面全程无感。
 * 它只为一种场合存在：从手机/局域网访问。那时链接上带一次 `?token=`，这里存进 localStorage
 * 并把它从地址栏擦掉（URL 会进历史记录、会被分享出去，令牌不该跟着走）。
 */
const TOKEN_KEY = 'stream.accessToken'

function takeTokenFromUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const url = new URL(window.location.href)
  const t = url.searchParams.get('token')
  if (!t) return undefined
  url.searchParams.delete('token')
  window.history.replaceState(null, '', url.toString())
  try { window.localStorage.setItem(TOKEN_KEY, t) } catch { /* 隐私模式：这次会话内用着就行 */ }
  return t
}

function storedToken(): string | undefined {
  try {
    return takeTokenFromUrl() ?? window.localStorage.getItem(TOKEN_KEY) ?? undefined
  } catch {
    return undefined
  }
}

/** 用户手输/扫码得到令牌后写回（设置页与 401 引导都走这里）。 */
export function setAccessToken(token: string): void {
  LOCAL.token = token.trim() || undefined
  try {
    if (LOCAL.token) window.localStorage.setItem(TOKEN_KEY, LOCAL.token)
    else window.localStorage.removeItem(TOKEN_KEY)
  } catch { /* ignore */ }
}

export const LOCAL: Connection = { baseUrl: '', token: storedToken() }

/**
 * Point the shared LOCAL singleton at a discovered/configured backend (called by
 * the connection state machine once the discovery ladder finds a healthy backend).
 * `httpBase` is '' (same-origin) or the configured upstream; `wsBase` is ''
 * (relative same-origin) or `ws://<upstream>`. Mutates in place: every call site reads
 * `LOCAL.baseUrl`/`wsBase` at call time through the same object, so nothing else
 * needs to change — media `src` URLs re-route with the single baseUrl swap.
 */
export function applyBackend(httpBase: string, wsBase: string): void {
  LOCAL.baseUrl = httpBase
  LOCAL.wsBase = wsBase || undefined
}

/**
 * Discovery-ladder health probe — a plain same-process fetch of `/api/health`.
 * Returns false on any error so the ladder moves to the next candidate.
 */
export async function probeBackend(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/health`)
    return r.ok
  } catch {
    return false
  }
}

export function faviconUrl(baseUrl: string, pageUrl?: string): string | undefined {
  // 只有绝对 http(s) URL 才能解析出站点。相对路径（部分源产出的 item.url 只是路径，如
  // `/1247347556/404054602`）会让后端 resolveFavicon 的 new URL 抛错 → 404；在这里直接
  // 拒绝，调用方走字母 fallback，避免成片 404。
  if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) return undefined
  return `${baseUrl}/api/media/image?site=${encodeURIComponent(pageUrl)}`
}

// 图片代理判据住 `lib/imageUrl.ts`（纯模块，`videoPlan`/`audioTrack` 也要用它，不能让它们
// 反过来 import 网络层）。这里只再导出一次，组件侧的既有 import 和既有 mock 都不用改。
export { imgUrl, imageProxyBypass } from './imageUrl.ts'

function authHeaders(conn: Connection): Record<string, string> {
  return conn.token ? { Authorization: `Bearer ${conn.token}` } : {}
}

/** A non-2xx API response. Carries the HTTP status + the backend's `{error}` message so
 *  callers can show a precise reason (vs a generic "backend unreachable"). A network
 *  failure rejects with a plain TypeError instead (status stays 0). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 后端 `error.code`（如 `slot_broken`）——字符串 error 体没有 code,则为 undefined。 */
    readonly code?: string
  ) {
    super(message)
    this.name = 'ApiError'
    // 401 = 后端说"你不是本机、也没出示令牌"。**从这里发信号而不是在每个调用点判**：
    // 四个请求方法都经过这个构造函数，漏不掉；页面据此弹一次输入框（AccessTokenPrompt）。
    if (status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('stream:unauthorized'))
    }
  }
}

function apiErrorMessage(detail: unknown): string | undefined {
  if (!detail || typeof detail !== 'object' || !('error' in detail)) return undefined
  const error = (detail as { error?: unknown }).error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return undefined
}

function apiErrorCode(detail: unknown): string | undefined {
  if (!detail || typeof detail !== 'object' || !('error' in detail)) return undefined
  const error = (detail as { error?: unknown }).error
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  return undefined
}

/** 唯一的 GET 路径（含鉴权头 + ApiError 归一化）。研究 present 等新调用方需要独立取数函数
 *  （不适合塞进 `api` 命名空间对象）时应复用这个，而不是重写一份 fetch 封装。 */
export async function get<T>(conn: Connection, path: string): Promise<T> {
  const res = await fetch(conn.baseUrl + path, { headers: authHeaders(conn) })
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as unknown
    throw new ApiError(apiErrorMessage(detail) || `GET ${path} → ${res.status}`, res.status, apiErrorCode(detail))
  }
  return res.json() as Promise<T>
}

async function post<T>(conn: Connection, path: string, body: unknown): Promise<T> {
  const res = await fetch(conn.baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(conn) },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as unknown
    throw new ApiError(apiErrorMessage(detail) || `POST ${path} → ${res.status}`, res.status, apiErrorCode(detail))
  }
  return res.json() as Promise<T>
}

/** 只关心"做没做成"的 POST（后端回 204 无正文）。**不能用上面那个 `post`**：它无条件
 *  `res.json()`，空正文会抛一个和"请求失败"长得一模一样的解析错。 */
async function postNoContent(conn: Connection, path: string): Promise<void> {
  const res = await fetch(conn.baseUrl + path, { method: 'POST', headers: authHeaders(conn) })
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as unknown
    throw new ApiError(apiErrorMessage(detail) || `POST ${path} → ${res.status}`, res.status, apiErrorCode(detail))
  }
}

/** `opts.keepalive` lets a PUT outlive the page/component that issued it (unmount / navigation) —
 *  used by the ArtPlayer's "report progress once on unmount" report so an unexpected exit doesn't
 *  lose the last few seconds of position. */
async function put<T>(conn: Connection, path: string, body: unknown, opts?: { keepalive?: boolean }): Promise<T> {
  const res = await fetch(conn.baseUrl + path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders(conn) },
    body: JSON.stringify(body),
    ...(opts?.keepalive ? { keepalive: true } : {}),
  })
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as unknown
    throw new ApiError(apiErrorMessage(detail) || `PUT ${path} → ${res.status}`, res.status, apiErrorCode(detail))
  }
  return res.json() as Promise<T>
}

async function patch<T>(conn: Connection, path: string, body: unknown): Promise<T> {
  const res = await fetch(conn.baseUrl + path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...authHeaders(conn) },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as unknown
    throw new ApiError(apiErrorMessage(detail) || `PATCH ${path} → ${res.status}`, res.status, apiErrorCode(detail))
  }
  return res.json() as Promise<T>
}

async function del<T>(conn: Connection, path: string): Promise<T> {
  const res = await fetch(conn.baseUrl + path, { method: 'DELETE', headers: authHeaders(conn) })
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as unknown
    throw new ApiError(apiErrorMessage(detail) || `DELETE ${path} → ${res.status}`, res.status, apiErrorCode(detail))
  }
  // 204 No Content (e.g. DELETE /api/voiceprint/persons/:id) has no body to parse.
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

function itemsQuery(opts?: { stream?: string; limit?: number; order?: 'asc' | 'desc' }): string {
  const p = new URLSearchParams()
  if (opts?.stream) p.set('stream', opts.stream)
  if (opts?.limit) p.set('limit', String(opts.limit))
  if (opts?.order) p.set('order', opts.order)
  const s = p.toString()
  return s ? `?${s}` : ''
}

// —— 配置分享（stream-bundle）——
export interface ShareRoot { kind: 'channel' | 'stream' | 'provider'; id: string }
export interface StreamBundleView { format: string; meta: { title: string; [k: string]: unknown }; [k: string]: unknown }
export interface RecipeDecisionView { action: 'install' | 'upgrade' | 'reuse' | 'ask'; from?: string; to?: string; keep?: string }
export interface ActivationConflictView {
  providerId: string; kind: 'serves-overlap' | 'fallback-overlap' | 'binding-occupied'; category: string
  overlapKeys?: string[]; rivalProviderId?: string; callsiteId?: string
}
/** 一次导入的遗留事项（spec 2026-07-24-import-decision-ledger）：kind 决定 subject/mine/theirs 装什么。 */
export interface ImportItemView {
  id: string
  kind: 'parked-provider' | 'slot-conflict' | 'notice'
  status: 'open' | 'decided' | 'dismissed'
  choice?: string
  decidedAt?: string
  subject: Record<string, unknown>
  mine?: { providerIds: string[]; from?: string; providers?: { id: string; label: string; parked: boolean }[] }
  theirs?: { providerIds: string[]; providers?: { id: string; label: string; parked: boolean }[] }
  choices: string[]
  detail: string
  /** parked-provider 的 open item 附实时冲突体检（GET 投影时补）。 */
  conflicts?: ActivationConflictView[]
}
/** 一次导入 = 一个可寻址资源；items 是它的当前态（GET 实时投影）。 */
export interface ImportRunView {
  id: string
  at: string
  meta: { title: string; author?: string; revision: string }
  remaps: Record<string, string>
  recipeDecisions: Record<string, RecipeDecisionView>
  netdiskBindings: { id: string; title: string; shareUrl?: string }[]
  items: ImportItemView[]
}
export interface ImportRunSummaryView {
  id: string; at: string; meta: ImportRunView['meta']
  openCount: number; itemCount: number; netdiskBindings: number
}

/** 收藏项的键——同构后端 collections/store.ts 的 keyOf(),两边必须拼出一样的字符串。 */
export type CollectedItemKeyInput =
  | { kind: 'stream'; streamId: string }
  | { kind: 'tmdb'; id: string; media: 'movie' | 'tv' }
  | { kind: 'track'; platform: string; trackId: string }
  | { kind: 'episode'; streamId: string; itemId: string }

export function collectedItemKey(k: CollectedItemKeyInput): string {
  if (k.kind === 'stream') return `stream:${k.streamId}`
  if (k.kind === 'tmdb') return `tmdb:${k.media}:${k.id}`
  if (k.kind === 'episode') return `episode:${k.streamId}:${k.itemId}`
  return `track:${k.platform}:${k.trackId}`
}

/** Backend-agnostic API client — same calls for a local or remote backend. */
/** GET/PUT /api/config/:rowId 的响应（与后端 ConfigRowStatus 同形）。
 *  `schema` 是 schemastery 的 toJSON 序列化（refs 形式），`new Schema(json)` 复原。 */
export interface ConfigRowStatus {
  schema: unknown
  values: Record<string, unknown>
  secrets: Record<string, { configured: boolean }>
}

export const api = {
  streams: (c: Connection) => get<Stream[]>(c, '/api/streams'),
  // ── 配置 row（后端 src/settings/config-rows.ts；spec 2026-08-17-config-rows-slice1）──
  /** 一对通用端点管所有已注册 row：schema 由后端下发（schemastery toJSON），SchemaForm 渲染。 */
  config: {
    get: (c: Connection, rowId: string) => get<ConfigRowStatus>(c, `/api/config/${encodeURIComponent(rowId)}`),
    /** 密文字段留空 = 保留存量（判据在后端引擎，客户端不复刻）。回新 status。 */
    put: (c: Connection, rowId: string, values: Record<string, unknown>) =>
      put<ConfigRowStatus>(c, `/api/config/${encodeURIComponent(rowId)}`, values),
  },
  // ── 同质内容归堆（后端 src/story-fold/）─────────────────────────────────
  /** 一个堆里都有谁（展开时问）。 */
  storyFoldGroup: (c: Connection, groupId: string) =>
    get<{ members: Array<{ itemId: string; isRep: boolean; why: unknown[] }> }>(c, `/api/story-fold/${encodeURIComponent(groupId)}`),
  /** 人工拆堆。后端会同时记下这两条**永不再并**，否则下轮采集又给合回去。 */
  unfoldStory: (c: Connection, itemId: string) =>
    del<{ ok: true }>(c, `/api/story-fold/${encodeURIComponent(itemId)}`),
  /** **谁在同质内容上持续先发**——只统计同框过（进过同一堆）的源之间的先后。 */
  sourceLeaderboard: (c: Connection) =>
    get<{ sources: Array<{ streamId: string; leads: number; behinds: number; avgLeadS: number; rivals: number }> }>(c, '/api/story-fold/leaderboard'),
  providers: (c: Connection) =>
    get<{ items: ProviderView[] }>(c, '/api/providers').then((r) => r.items),
  createProvider: (c: Connection, body: { id: string; label: string; description: string; category: ProviderCategory; serves: string[]; strategy: 'sequential' | 'concurrent'; members: ProviderMemberRef[] }) =>
    post<ProviderView>(c, '/api/providers', body),
  patchProvider: (c: Connection, id: string, body: { members?: ProviderMemberRef[]; [k: string]: unknown }) =>
    patch<ProviderView>(c, `/api/providers/${encodeURIComponent(id)}`, body),
  providerCallsites: (c: Connection) => get<{ items: ProviderCallsiteView[] }>(c, '/api/provider-callsites').then((r) => r.items),
  /** Present descriptors (channel present → its provider-callsite slots), for the channel
   *  detail page's 能力槽位 section. */
  presents: (c: Connection) => get<{ items: PresentView[] }>(c, '/api/presents'),
  // ── 「包」页 ─────────────────────────────────────────────────────────────
  /** 「这台机器上装了什么」：内置 + 用户两层的全部 Stream 包 + 各自填的槽位 + 容器状态。
   *  不是 plugins()/listInstalledRecipePackages() 的替代——那两个各自只看得到一半。 */
  packages: (c: Connection) =>
    get<{ packages: PackageSummary[] }>(c, '/api/packages').then((r) => r.packages),
  /** 容器的最后 N 行日志。404 = 这个包没有容器 / 容器从没建起来；503 = 够不着 docker。
   *  两种是不同的事，调用方按状态码分支，别合成一句「读不到日志」。 */
  packageLogs: (c: Connection, id: string, tail = 200) =>
    get<PackageLogs>(c, `/api/packages/${encodeURIComponent(id)}/logs?tail=${tail}`),
  /** 重启一个包的容器。**成功返回也可能是 state:'error'** —— 那表示我们试过了、容器没起来，
   *  和「请求失败」是两件事，别只看有没有抛错。 */
  restartPackage: (c: Connection, id: string) =>
    post<PackageRestart>(c, `/api/packages/${encodeURIComponent(id)}/restart`, {}),
  /** 「装了 / 换了 / 卸了、但后端还在跑旧的那份」的清单。后端每次现算，不是账本。 */
  packagesPending: (c: Connection) =>
    get<{ pending: PendingChange[] }>(c, '/api/packages/pending').then((r) => r.pending),
  /** `/api/health` 的身份格：`started_at` 是进程启动那一刻——重启后的「它回来了」判据就是
   *  这个值变了（同一个 commit 重启前后哈希相同，只有它能分出前后两个进程）。 */
  health: (c: Connection) =>
    get<{ ok: boolean; commit?: string; started_at?: string; pending_restart?: number }>(c, '/api/health'),
  /** 重启后端本体（不是某个包的容器）。**409 不抛**：那是「有任务正在跑」的正常回答，
   *  正文里的 `running` 是给人看的，要列出来再给「强制」入口——走 ApiError 会把这份清单丢掉
   *  （它只带 message）。其余非 2xx（503 = 这台后端没配重启）照旧抛 ApiError。 */
  restartBackend: async (c: Connection, force: boolean): Promise<RestartBackendResult> => {
    const path = force ? '/api/restart?force=1' : '/api/restart'
    const res = await fetch(c.baseUrl + path, { method: 'POST', headers: authHeaders(c) })
    const detail = (await res.json().catch(() => null)) as unknown
    if (res.status === 202) return { status: 202, mode: (detail as { mode: RestartMode }).mode }
    if (res.status === 409) {
      const running = (detail as { running?: { id: string; label: string }[] } | null)?.running ?? []
      return { status: 409, running }
    }
    throw new ApiError(apiErrorMessage(detail) || `POST ${path} → ${res.status}`, res.status, apiErrorCode(detail))
  },
  // ── Recipe 包市场 ────────────────────────────────────────────────────────
  /** 按关键词搜 recipe 包。registry 地址与 `keywords:stream-recipe` 限定都由服务端固定，
   *  这里给不了、也不该给 URL。 */
  searchRecipePackages: (c: Connection, q: string) =>
    get<RecipePackageSearchHit[]>(c, `/api/recipes/packages/search?q=${encodeURIComponent(q)}`),
  listInstalledRecipePackages: (c: Connection) =>
    get<InstalledRecipePackage[]>(c, '/api/recipes/packages'),
  /** 重查询：后端会真的下载整个 tarball 并跑完门禁（白名单/schema/穿越/三道限额/integrity）。
   *  慢网络下数秒——调用方必须有进行中状态并防重复提交。 */
  previewRecipePackage: (c: Connection, name: string, version?: string) =>
    post<RecipePackagePreview>(c, '/api/recipes/packages/preview', { name, version }),
  /** confirm 只能来自 preview（tarball integrity）——不匹配后端会拒。 */
  installRecipePackage: (c: Connection, name: string, version: string | undefined, confirm: string) =>
    post<RecipePackageInstallResult>(c, '/api/recipes/packages/install', { name, version, confirm }),
  uninstallRecipePackage: (c: Connection, name: string) =>
    post<{ removed: boolean }>(c, '/api/recipes/packages/uninstall', { name }),
  recipePackageUpdates: (c: Connection) =>
    get<RecipePackageUpdate[]>(c, '/api/recipes/packages/updates'),
  // ── 动作 recipe（有副作用：写用户账户 / 发消息 / 下单）────────────────────────────
  /** 跑一条动作 recipe。**用户当场点的那一下就是二次确认**，界面按钮直接带 `confirmed: true`；
   *  不带时后端只回执"会做什么"（`needs-confirmation`），一步都不动。回执的 `status` 自己判——
   *  没做成的那几档也是 200。 */
  runAction: (c: Connection, body: { sourceId: string; params?: Record<string, unknown>; confirmed?: boolean }) =>
    post<ActionResult>(c, '/api/recipes/action', body),
  /** `runAction` 回 `running` 时（动作超过了后端的等待窗还没跑完）拿 `runId` 来这里等终态。 */
  actionRun: (c: Connection, runId: string) =>
    get<ActionRunView>(c, `/api/recipes/action/${encodeURIComponent(runId)}`),
  /** 后端 put 是**整体替换**（省略 params 即清空该覆盖），所以只换 Provider 行时也必须把已有的
   *  `binding.params` 原样传回来——否则换一次行就把迁移/用户配的 `model` 覆盖抹掉，且 UI 无从恢复。 */
  setProviderCallsiteBinding: (c: Connection, id: string, providerIds: string[], params?: Record<string, unknown>) =>
    put<{ callsiteId: string; providerIds: string[]; params?: Record<string, unknown> }>(
      c,
      `/api/provider-callsites/${encodeURIComponent(id)}/binding`,
      { providerIds, ...(params !== undefined ? { params } : {}) },
    ),
  patchStreamMembers: (c: Connection, id: string, members: StreamCreate['members']) =>
    patch<Stream>(c, `/api/streams/${encodeURIComponent(id)}`, { members }),
  /** Advance a followed stream's read watermark to its newest item (clears its 正在追的 badge). */
  markStreamSeen: (c: Connection, streamId: string) =>
    post<{ stream_id: string; seen_seq: number }>(c, `/api/streams/${encodeURIComponent(streamId)}/seen`, {}),
  channels: (c: Connection, kind?: string) => get<ChannelView[]>(c, `/api/channels${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`),
  createChannel: (c: Connection, body: ChannelCreate) => post<ChannelRecordDto>(c, '/api/channels', body),
  /** 返回**持久化后的 `ChannelView`**（与 `GET /api/channels` 同源投影）。前端别再手工合并
   *  自己那份可能陈旧的快照——直接拿这个返回体覆盖共享状态里那一条（见 lib/channels.tsx）。 */
  updateChannel: (
    c: Connection,
    id: string,
    body: { label?: string; stream_ids?: string[]; present?: ChannelView['present']; options?: Record<string, unknown>; space_id?: string },
  ) => patch<ChannelView>(c, `/api/channels/${encodeURIComponent(id)}`, body),
  deleteChannel: (c: Connection, id: string) =>
    del<{ ok: boolean }>(c, `/api/channels/${encodeURIComponent(id)}`),
  /** 空间（频道之上那一层，侧栏分组）。见 docs/API.md §Spaces。 */
  spaces: (c: Connection) => get<SpaceView[]>(c, '/api/spaces'),
  createSpace: (c: Connection, body: { label: string; position?: number }) =>
    post<SpaceView>(c, '/api/spaces', body),
  updateSpace: (c: Connection, id: string, body: { label?: string; position?: number }) =>
    patch<SpaceView>(c, `/api/spaces/${encodeURIComponent(id)}`, body),
  /** 删空间不删内容：成员频道被后端挪回默认空间。 */
  deleteSpace: (c: Connection, id: string) =>
    del<{ ok: boolean }>(c, `/api/spaces/${encodeURIComponent(id)}`),
  /** 「想接还接不了」清单（对话里接不上的站，见 src/onboard/wishlist-store.ts）。 */
  onboardWishlist: (c: Connection) =>
    get<{ entries: { id: string; url: string; goal: string; note?: string; at: string }[] }>(c, '/api/onboard/wishlist'),
  deleteWishlistEntry: (c: Connection, id: string) =>
    del<{ ok: boolean }>(c, `/api/onboard/wishlist/${encodeURIComponent(id)}`),
  /** Channel timeline page (Design D2 envelope): keyset-paginated, `cursor` = opaque
   *  next_cursor from the previous page; absent next_cursor = tail page. */
  channelItems: (c: Connection, channelId: string, opts?: { limit?: number; cursor?: string }) => {
    const qs = new URLSearchParams()
    if (opts?.limit) qs.set('limit', String(opts.limit))
    if (opts?.cursor) qs.set('cursor', opts.cursor)
    const q = qs.toString()
    return get<{ items: Item[]; next_cursor?: string }>(c, `/api/channels/${encodeURIComponent(channelId)}/items${q ? `?${q}` : ''}`)
  },

  /** Live preview of a whole Stream — normalized + merged, NOT persisted. */
  previewStream: (c: Connection, streamId: string, limit?: number) =>
    get<PreviewResult>(c, `/api/streams/${encodeURIComponent(streamId)}/preview${limit ? `?limit=${encodeURIComponent(String(limit))}` : ''}`),

  /** Live preview of ONE source with ad-hoc params (e.g. an unsaved config form). */
  previewSource: (c: Connection, sourceId: string, params: Record<string, unknown>) =>
    post<PreviewResult>(c, '/api/sources/preview', { sourceId, params }),

  /** Manually re-harvest a stream NOW (a real persisted tick). Returns { fetched, written }. */
  refreshStream: (c: Connection, streamId: string) =>
    post<{ fetched: number; written: number }>(c, `/api/streams/${encodeURIComponent(streamId)}/refresh`, {}),
  /** 频道级重新抓取：扇出到该频道的全部成员流。**部分失败仍是 200**（某个 facility 掉登录态是
   *  常态），失败逐条在 `streams[].error` 里，调用方据此讲「7 条里 1 条没成」。 */
  refreshChannel: (c: Connection, channelId: string) =>
    post<{
      streams: Array<{ streamId: string; fetched?: number; written?: number; error?: string }>
      fetched: number
      written: number
      failed: number
    }>(c, `/api/channels/${encodeURIComponent(channelId)}/refresh`, {}),
  items: (c: Connection, opts?: { stream?: string; limit?: number; order?: 'asc' | 'desc' }) =>
    get<Item[]>(c, '/api/items' + itemsQuery(opts)),
  /** source-CATALOG search (ranked manifests by intent) — a catalog query on /api/sources */
  search: (c: Connection, intent: string, k?: number, category?: string) =>
    get<SourceCandidate[]>(
      c,
      `/api/sources?q=${encodeURIComponent(intent)}${k ? `&k=${k}` : ''}${
        category ? `&category=${encodeURIComponent(category)}` : ''
      }`
    ),
  /** RSSHub catalog categories with source counts — drives browse-by-category */
  categories: (c: Connection) =>
    get<{ category: string; count: number; searchable: number }[]>(c, '/api/categories'),
  sources: (c: Connection) => get<SourceInfo[]>(c, '/api/sources'),
  /** Set (rules given) or clear (null) a stream's per-stream ad-filter override. */
  setStreamTitleFilter: (c: Connection, channelId: string, streamId: string, keywords: string[]) =>
    patch<Stream>(c, `/api/channels/${encodeURIComponent(channelId)}/streams/${encodeURIComponent(streamId)}/title-filter`,
      keywords.length ? { keywords } : null),
  setStreamAdFilter: (c: Connection, channelId: string, streamId: string, rules: { keywords?: string[]; domains?: string[] } | null) =>
    patch<Stream>(c, `/api/channels/${encodeURIComponent(channelId)}/streams/${encodeURIComponent(streamId)}/ad-filter`, rules),
  /** Re-run ad-filter classification (current effective rules) over a stream's already-
   *  stored, non-manually-labeled items. Returns how many items changed. */
  reclassifyStreamAdFilter: (c: Connection, channelId: string, streamId: string) =>
    post<{ changed: number }>(c, `/api/channels/${encodeURIComponent(channelId)}/streams/${encodeURIComponent(streamId)}/ad-filter/reclassify`, undefined),
  // target-resolve model (one-shot resolve endpoints stay live for MCP; the standing-subscription
  // frontend surface was removed with the harvest-path unification — only the tree view remains)
  /** Target tree: Stream → provider → source chain with live health + active marker */
  resolveTargets: (c: Connection) =>
    get<
      {
        id: string
        targetType: string
        key: string
        cadenceSeconds: number
        resolvers: {
          id: string
          sources: ResolveTargetSource[]
        }[]
      }[]
    >(c, '/api/resolve/targets'),
  /** 作者头像 / 主页现取：`source` + `params` 原样来自条目上的 `author_enrich`（包声明、后端投影），
   *  回的形状由那个包的 enricher 定，宿主只认 `{ name?, face?, url? }` 三格。 */
  enrichAuthor: (c: Connection, source: string, params: Record<string, string>) => {
    const q = new URLSearchParams({ source })
    for (const [k, v] of Object.entries(params)) q.set(k, v)
    return get<{ name?: string; face?: string; url?: string }>(c, `/api/enrich?${q.toString()}`)
  },
  /** unified on-demand enrichment: extracted article + normalized comments (any source) */
  enrich: (c: Connection, params: EnrichParams) => {
    const q = new URLSearchParams({ source: params.source })
    if ('params' in params) {
      for (const [k, v] of Object.entries(params.params)) q.set(k, v)
    } else if (params.source === 'link') q.set('url', params.url)
    else if ('vid' in params && params.source.endsWith('-comments')) {
      q.set('vid', params.vid)
      if (params.page) q.set('page', String(params.page))
    }
    return get<Enrichment>(c, `/api/enrich?${q.toString()}`)
  },
  /** merged multi-platform Discovery feed (xhs + douyin, …). `{ refresh:true }` forces
   *  a server-side re-harvest (the UI refresh button); otherwise served from the SWR cache. */
  /**
   * 「我不用这个 facility 了」——离开对应频道时调，后端关掉它名下所有采集标签（幂等）。
   *
   * 这是采集标签的**正常**终点：它绑在使用者的意图上（"我还在不在这个频道"），比超时/内存阈值
   * 干净——后两者都是在猜，猜出来要么关早了、要么一直挂着。异常路径（用户直接关标签 / 浏览器崩了
   * / 人走了）这个调用根本跑不到，那一档由后端的 browser-lane-reaper 定时任务兜底。
   */
  closeFacility: (c: Connection, facility: string) =>
    post<{ ok: boolean; facility: string }>(c, `/api/facilities/${encodeURIComponent(facility)}/close`, {}),
  /** live cross-platform keyword content search (all content-search members, merged).
   *  `warnings` = members that failed (e.g. a source whose cookie went stale) — surfaced, not hidden. */
  contentSearch: (c: Connection, q: string) =>
    get<{ items: Item[]; warnings?: SearchWarning[]; timings?: SearchTiming[] }>(c, `/api/search?scope=content&q=${encodeURIComponent(q)}`)
      .then((r) => ({ items: r.items, warnings: r.warnings ?? [], timings: r.timings ?? [] })),
  musicSearch: (c: Connection, q: string) =>
    get<{ items: MusicSearchResult[] }>(c, `/api/search?scope=music&q=${encodeURIComponent(q)}`).then((r) => r.items),
  /** Lyrics for a track: key is "<platform>:<trackId>" (known id) or "<title>::<artist>" (fuzzy
   *  search) — see NowPlayingBar's lyricsKey(). Reuses the generic resolve endpoint (no bespoke
   *  /api/lyrics route — design §3.4). result is null only if the `lyrics` targetType itself has
   *  no ladder configured (should never happen post Task 3); a normal miss is
   *  `result.items[0] = { matched: false }`. */
  lyrics: (c: Connection, key: string) =>
    get<{
      targetType: string
      key: string
      result: { source: string; items: Array<{ matched: boolean; songId?: string; lrc?: string }> } | null
    }>(c, `/api/resolutions?type=lyrics&key=${encodeURIComponent(key)}`),
  /** 影视片名搜索(TMDB;可插拔搜索源)——候选作品,点开走 tmdb 详情。warnings=失败的成员。 */
  videoTitleSearch: (c: Connection, q: string) =>
    get<{ candidates: VideoWorkCandidate[]; warnings?: SearchWarning[] }>(c, `/api/search?scope=video&q=${encodeURIComponent(q)}`)
      .then((r) => ({ candidates: r.candidates, warnings: r.warnings ?? [] })),
  /** 统一收藏系统(video「正在追」+ audio「我的喜欢」两个系统列表 + 用户自建列表)——见
   *  CollectedItem/Collection 类型头注、collectedItemKey() 的键拼法。 */
  collections: (c: Connection, domain?: CollectionDomain, anchor?: string) =>
    get<Collection[]>(
      c,
      `/api/collections${[domain && `domain=${domain}`, anchor && `anchor=${encodeURIComponent(anchor)}`]
        .filter(Boolean)
        .join('&')
        .replace(/^(.)/, '?$1')}`,
    ),
  createCollection: (c: Connection, domain: CollectionDomain, label: string, anchorStreamId?: string) =>
    post<Collection>(c, '/api/collections', { domain, label, ...(anchorStreamId ? { anchorStreamId } : {}) }),
  renameCollection: (c: Connection, id: string, label: string) =>
    patch<Collection>(c, `/api/collections/${encodeURIComponent(id)}`, { label }),
  deleteCollection: (c: Connection, id: string) =>
    del<{ ok: boolean }>(c, `/api/collections/${encodeURIComponent(id)}`),
  collectionItems: (c: Connection, id: string) =>
    get<CollectedItem[]>(c, `/api/collections/${encodeURIComponent(id)}/items`),
  /** 手动排序：**整份名单**进（后端只收全排列，缺一条就 400）。回执就是重排后的成员，
   *  所以调用方不必再拉一次 collectionItems。 */
  reorderCollection: (c: Connection, collectionId: string, keys: string[]) =>
    put<CollectedItem[]>(c, `/api/collections/${encodeURIComponent(collectionId)}/order`, { keys }),
  addToCollection: (c: Connection, collectionId: string, key: CollectedItemKeyInput, body: {
    title: string
    poster?: string
    artist?: string
    album?: string
    durationS?: number
    sourceUrl?: string
  }) =>
    put<CollectedItem>(c, `/api/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(collectedItemKey(key))}`, body),
  /** 批量落一批成员到某个播单——分集导入等一次多条场景,避免 N 次 addToCollection 网络往返。 */
  addToCollectionBatch: (c: Connection, collectionId: string, items: Array<{
    key: CollectedItemKeyInput
    title: string
    poster?: string
    artist?: string
    album?: string
    durationS?: number
    sourceUrl?: string
  }>) =>
    post<CollectedItem[]>(c, `/api/collections/${encodeURIComponent(collectionId)}/items`,
      { items: items.map(({ key, ...meta }) => ({ key: collectedItemKey(key), ...meta })) }),
  removeFromCollection: (c: Connection, collectionId: string, key: CollectedItemKeyInput) =>
    del<{ ok: boolean }>(c, `/api/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(collectedItemKey(key))}`),
  /** 这个东西现在在哪些列表里——收藏面板打开时用来决定复选框初始状态。 */
  whereCollected: (c: Connection, key: CollectedItemKeyInput) =>
    get<{ item: CollectedItem | null; collectionIds: string[] }>(c, `/api/collected/${encodeURIComponent(collectedItemKey(key))}`),
  // —— 「继续观看」服务端播放进度(取代视频频道的 localStorage,见 watch-progress-store.ts)——
  watchProgressGet: (c: Connection, key: string) =>
    get<WatchProgressRow | null>(c, `/api/watch-progress/${encodeURIComponent(key)}`),
  watchProgressPut: (
    c: Connection,
    key: string,
    body: { position: number; duration: number; workKey: string; workTitle: string; workPoster?: string; epLabel?: string; channelId?: string },
    opts?: { keepalive?: boolean },
  ) => put<WatchProgressRow>(c, `/api/watch-progress/${encodeURIComponent(key)}`, body, opts),
  /** 「继续观看」货架——已按 workKey 去重、已看完排除、按最近更新排序。`channels` 把货架切到
   *  这些频道（频道的意义就是把内容分开）；不传 = 整份，只有 `/video` 那个聚合入口该这么用。 */
  watchProgressList: (c: Connection, channels?: string[]) =>
    get<WatchProgressRow[]>(
      c,
      '/api/watch-progress' + (channels?.length ? `?${channels.map((id) => `channel=${encodeURIComponent(id)}`).join('&')}` : ''),
    ),
  watchProgressRemove: (c: Connection, key: string) =>
    del<{ ok: boolean }>(c, `/api/watch-progress/${encodeURIComponent(key)}`),
  /** aggregated video/torrent keyword search across RSSHub film/anime sources.
   *  nsfw flips the whole source set (regular ⇆ adult); returns the faceted tree. */
  videoSearch: (c: Connection, q: string, nsfw = false, channelId?: string) =>
    get<VideoSearchResult>(
      c,
      `/api/search?scope=resources&q=${encodeURIComponent(q)}${nsfw ? '&nsfw=1' : ''}${channelId ? `&channelId=${encodeURIComponent(channelId)}` : ''}`,
    ),
  /** streaming variant — NDJSON, one event per source as it completes. Calls
   *  onEvent for each (init/source/done); resolves when the stream ends. */
  videoSearchStream: async (
    c: Connection,
    q: string,
    nsfw: boolean,
    onEvent: (ev: VideoSearchEvent) => void,
    signal?: AbortSignal,
    channelId?: string,
  ) => {
    const res = await fetch(`${c.baseUrl}/api/search?scope=resources&stream=1&q=${encodeURIComponent(q)}${nsfw ? '&nsfw=1' : ''}${channelId ? `&channelId=${encodeURIComponent(channelId)}` : ''}`, {
      headers: authHeaders(c),
      signal,
    })
    if (!res.ok || !res.body) {
      const detail = (await res.json().catch(() => null)) as unknown
      throw new ApiError(apiErrorMessage(detail) || `video stream → ${res.status}`, res.status, apiErrorCode(detail))
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) onEvent(JSON.parse(line) as VideoSearchEvent)
      }
    }
  },
  /** resolve a needsResolve release: its link is a source-site page, not a direct
   *  download — the backend's download-resolve chain turns it into download options
   *  (usually one; first is preferred). */
  videoResolve: (c: Connection, url: string) =>
    get<{ options: { url: string; type: string; password?: string; name?: string }[] }>(
      c, `/api/download-options?url=${encodeURIComponent(url)}`),
  status: (c: Connection) => get<StatusInfo>(c, '/api/status'),
  topics: (c: Connection) => get<string[]>(c, '/api/topics'),
  /** subscribe = create the Stream row (POST /api/streams). Pass `channel_id` in the body to
   *  bind it to a channel **in the same request** — the ownerless intermediate state is what
   *  makes the backend judge it collectable and tick it once (wrong for live-present channels).
   *  Without it the stream schedules immediately and surfaces as an implicit single-member
   *  Target until grouped (entry-point rule) — the standalone-resource-stream path. */
  subscribe: (c: Connection, stream: StreamCreate) =>
    post<StreamCreate>(c, '/api/streams', stream),
  unsubscribe: (c: Connection, id: string) =>
    del<{ ok: boolean }>(c, `/api/streams/${encodeURIComponent(id)}`),
  /** Rename a Stream — sets its display name (`label` in storage, `description` in the API projection). */
  renameStream: (c: Connection, id: string, description: string) =>
    patch<Stream>(c, `/api/streams/${encodeURIComponent(id)}`, { label: description }),
  /** Update a Stream's schedule attributes — 抓取方式 (strategy) + 抓取时间 (cadence).
   *  A cadence change triggers a full reschedule server-side; strategy-only is metadata. */
  updateStream: (
    c: Connection,
    id: string,
    body: { strategy?: 'fanout' | 'exclusive'; cadence_seconds?: number; options?: Record<string, unknown> },
  ) => patch<Stream>(c, `/api/streams/${encodeURIComponent(id)}`, body),
  /** read-time ad label: 'ad'/'lottery' fold into 广告 channel; 'not-ad' clears */
  label: (c: Connection, id: string, label: 'ad' | 'lottery' | 'not-ad') =>
    patch<{ ok: boolean }>(c, `/api/items/${encodeURIComponent(id)}`, { label }),
  // 令牌走 query 而不是头：浏览器的 WebSocket 没有设请求头的口子。本机访问 token 是空的，
  // 这条 URL 就还是原来那个（后端对 loopback 免密）。
  wsUrl: (c: Connection) =>
    (c.wsBase ?? c.baseUrl.replace(/^http/, 'ws')) + '/ws' + (c.token ? `?token=${encodeURIComponent(c.token)}` : ''),
  /** plugin catalog (includes legacy configured/mode/health fields for the status panel) */
  plugins: (c: Connection) => get<Array<PluginSummary & Partial<PluginStatus>>>(c, '/api/plugins'),
  /** enable/disable a plugin — persisted; disabling fully lands on the next restart (its sources
   *  aren't registered). Returns the updated summary. Required plugins reject (409). */
  setPluginEnabled: (c: Connection, id: string, enabled: boolean) =>
    put<PluginSummary & Partial<PluginStatus>>(c, `/api/plugins/${encodeURIComponent(id)}/enabled`, { enabled }),
  /** 网盘底座（内置托管，没有可写的配置）——一条活探测，探的是现役那一份。 */
  alist: {
    test: (c: Connection) => post<{ ok: boolean; error?: string }>(c, '/api/settings/alist/test', {}),
  },
  pluginSources: (c: Connection, pluginId: string, opts?: { query?: string; category?: string; group?: string; limit?: number; cursor?: string; surface?: PickSurface }) => {
    const params = new URLSearchParams()
    if (opts?.query) params.set('query', opts.query)
    if (opts?.category) params.set('category', opts.category)
    if (opts?.group !== undefined) params.set('group', opts.group)
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.cursor) params.set('cursor', opts.cursor)
    if (opts?.surface) params.set('surface', opts.surface)
    const qs = params.toString()
    return get<PluginSourceListResponse>(c, `/api/plugins/${encodeURIComponent(pluginId)}/sources${qs ? `?${qs}` : ''}`)
  },
  pluginSourceDetail: (c: Connection, pluginId: string, sourceId: string) =>
    get<SourceDetail>(c, `/api/plugins/${encodeURIComponent(pluginId)}/sources/${encodeURIComponent(sourceId)}`),
  /** cross-plugin source-catalog search (faceted, grouped by plugin) */
  searchAllPluginSources: (c: Connection, opts?: { query?: string; category?: string; capability?: string; searchable?: boolean; limit?: number; cursor?: string; surface?: PickSurface }) => {
    const params = new URLSearchParams()
    if (opts?.query) params.set('query', opts.query)
    if (opts?.category) params.set('category', opts.category)
    if (opts?.capability) params.set('capability', opts.capability)
    if (opts?.searchable) params.set('searchable', '1')
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.cursor) params.set('cursor', opts.cursor)
    if (opts?.surface) params.set('surface', opts.surface)
    const qs = params.toString()
    return get<PluginSourcesSearchResponse>(c, `/api/plugins/sources${qs ? `?${qs}` : ''}`)
  },
  /** 采集用哪个 Chrome：列候选 / 选一个。后端只列不选（spec 2026-07-29 §4）。 */
  harvestBrowser: {
    get: (c: Connection) => get<HarvestBrowserStatus>(c, '/api/settings/harvest-browser'),
    set: (c: Connection, exe: string) => put<HarvestBrowserStatus>(c, '/api/settings/harvest-browser', { exe }),
  },
  /** 扩展安装引导（后端 spec 2026-08-30-extension-onboarding §8）。
   *  **"装好了"的判据是 `capability().state === 'ready'`**（= 扩展连上了中继），不是
   *  "install 回了 connected 之外的什么"，更不是页面上出现了卡片。 */
  extension: {
    capability: (c: Connection) => get<BrowserCapabilitySnapshot>(c, '/api/browser-capability'),
    onboarding: (c: Connection) => get<{ declinedAt?: string }>(c, '/api/extension/onboarding'),
    materialize: (c: Connection) => post<{ dir: string; source: string }>(c, '/api/extension/materialize', {}),
    install: (c: Connection) => post<ExtensionInstallOutcome>(c, '/api/extension/install', {}),
    decline: (c: Connection) => postNoContent(c, '/api/extension/decline'),
  },
  /** 局域网访问用的令牌 + 直接能点开的链接。后端只对本机回答这一口（非 loopback 一律 403）。 */
  accessToken: {
    get: (c: Connection) => get<{ token: string; urls: string[] }>(c, '/api/access-token'),
  },
  /** 摘要 prompt（settings 里唯一还归 LLM 的字段）+ 梯子就绪状态。连接与模型走 Providers 页
   *  （`llm` 行的成员实例 + 调用点绑定），不在这里写。 */
  summaryPrompt: {
    get: (c: Connection) => get<SummaryPromptStatus>(c, '/api/settings/summary-prompt'),
    set: (c: Connection, prompt: string) => put<SummaryPromptStatus>(c, '/api/settings/summary-prompt', { prompt }),
  },
  /**
   * 统一的转换资源（OCR / 转写 / 补说话人 / 摘要）——触发、轮询、取消全在这一族。
   * 契约见 docs/API.md「Conversions」。
   *
   * 重构前这里是 `transcribe.*` 和 `parse.*` 两套形状一样的方法（各自打 /api/transcripts、
   * /api/parses），外加一个 `transcribe.summarize` 打动词端点。现在一份，kind 判别。
   * `snapshot`/`media` 仍是可选提示，让不在 item store 里的瞬时（Discovery）条目也能转换、
   * 并且历史自包含。
   *
   * `start` / `forItem` / `remove` / `kinds` / `list` 今天没有前端消费者（前端只剩
   * `MovieChannel.tsx` 用 `latest`；转成文字走对话里的工具卡，不经这一族）。留着不删——
   * 这份客户端是后端契约的镜像，别当它已经死了。
   */
  conversions: {
    /** 起一次转换。命中缓存时后端回 200 + 既有记录（不会重复计费），新建回 201。 */
    start: (
      c: Connection,
      kind: ConversionKind,
      item: string,
      opts?: { media?: Media[]; snapshot?: ItemSnapshot; options?: Record<string, unknown>; input?: string; force?: boolean }
    ) =>
      post<Conversion>(c, '/api/conversions', {
        kind,
        item,
        media: opts?.media,
        snapshot: opts?.snapshot,
        options: opts?.options,
        input: opts?.input,
        force: opts?.force,
      }),
    /** 该 item 的全部转换（默认不驮正文；要正文传 expandResult）。一次取回转写 + OCR + 摘要。 */
    forItem: (c: Connection, item: string, opts?: { expandResult?: boolean }) =>
      get<{ items: Conversion[]; nextCursor?: string }>(
        c,
        `/api/conversions?item=${encodeURIComponent(item)}${opts?.expandResult ? '&expand=result' : ''}`
      ),
    /** 某个 item 某种 kind 的最新一条；没有就是 null（不再有 `status:'none'` 那种伪状态）。 */
    latest: async (c: Connection, item: string, kind: ConversionKind, opts?: { expandResult?: boolean }) => {
      const res = await get<{ items: Conversion[] }>(
        c,
        `/api/conversions?item=${encodeURIComponent(item)}&kind=${kind}${opts?.expandResult ? '&expand=result' : ''}`
      )
      return res.items[0] ?? null
    },
    /** 列表（任务面板/历史）：默认不驮正文，可按 kind 过滤。 */
    list: (c: Connection, opts?: { kind?: ConversionKind; limit?: number }) =>
      get<{ items: Conversion[]; nextCursor?: string }>(
        c,
        `/api/conversions?${new URLSearchParams({
          ...(opts?.kind ? { kind: opts.kind } : {}),
          ...(opts?.limit ? { limit: String(opts.limit) } : {}),
        })}`
      ),
    /** 取消并删除（在跑的中止、排队的出队、历史的直接删）。 */
    remove: (c: Connection, id: string) => del<{ ok: true }>(c, `/api/conversions/${encodeURIComponent(id)}`),
    /** 已注册的 kind 及其后端可用性——按钮显不显示读它，别用 POST 试探 503。 */
    kinds: (c: Connection) => get<{ items: ConversionKindInfo[] }>(c, '/api/conversion-kinds'),
  },
  // —— audio archive (download queue + sync) ——
  /** Enqueue one item or a whole playlist for download. Returns how many jobs were added, and how
   *  many were skipped for being already downloaded. Pass `skipArchived` from any BATCH call site —
   *  the queue only single-flights jobs that are queued/running, so without it a mostly-archived
   *  list gets re-downloaded whole. Leave it off for the row menu's explicit 「重新下载」，
   *  那一处要传的是 `force`：已归档的也真的重下一遍并重写标签，否则归档层会静默跳过、
   *  点了等于没点。`track.album` 必须带上——下载 provider 只解析播放地址，专辑名唯一的来源
   *  就是调用方手里这一份，丢了写进文件的 ID3 里专辑就是空的。 */
  download: (c: Connection, body: { itemId?: string; stream?: string; track?: { platform: string; trackId: string; title?: string; artist?: string; album?: string; pageUrl?: string }; skipArchived?: boolean; force?: boolean }) =>
    post<{ enqueued: number; skipped: number }>(c, '/api/downloads', body),
  /** Active + recently completed download jobs. */
  downloadJobs: (c: Connection, platform?: string) =>
    get<{ items: { id: number; platform: string; track_id: string; state: string; attempts: number; last_error?: string; downloaded_bytes?: number; total_bytes?: number; archived?: boolean }[] }>(
      c,
      `/api/downloads${platform ? `?platform=${encodeURIComponent(platform)}` : ''}`
    ).then((res) => ({ jobs: res.items })),
  /** Batch lookup whether tracks have an archived local asset. Chunked at 200 refs/request:
   *  one querystring for a 1000+-track playlist is ~20KB, past Node's 16KB maxHeaderSize → the
   *  whole request is rejected with HTTP 431 (bit "加入下载队列" on a 1156-song 歌单). 200/req
   *  keeps each URL ~3.6KB and mirrors the ncm route's own song/detail batching. */
  archiveStatus: async (c: Connection, tracks: { platform: string; trackId: string }[]) => {
    const CHUNK = 200
    const batches: { platform: string; trackId: string }[][] = []
    for (let i = 0; i < tracks.length; i += CHUNK) batches.push(tracks.slice(i, i + CHUNK))
    const results = await Promise.all(
      batches.map((batch) =>
        get<{ archived: Record<string, boolean> }>(
          c,
          `/api/media/assets?refs=${batch.map((t) => `${encodeURIComponent(t.platform)}:${encodeURIComponent(t.trackId)}`).join(',')}`
        )
      )
    )
    return { archived: Object.assign({}, ...results.map((r) => r.archived)) as Record<string, boolean> }
  },
  /** Delete an archived file + its DB row. */
  deleteArchived: (c: Connection, platform: string, trackId: string) =>
    del<{ ok: boolean }>(c, `/api/media/assets/${encodeURIComponent(platform)}/${encodeURIComponent(trackId)}`),
  /** Enable or disable auto-download sync for a playlist stream (a Stream option). */
  setSync: (c: Connection, stream: string, enabled: boolean) =>
    patch<{ options: Record<string, unknown> }>(c, `/api/streams/${encodeURIComponent(stream)}`, { options: { autoDownload: enabled } }),
  /** 生成/覆盖这个 Stream 对应的 m3u——只读 AudioArchive 现状,不触发下载。 */
  exportStreamPlaylist: (c: Connection, streamId: string) =>
    post<{ written: number; skipped: number; path?: string }>(c, `/api/streams/${encodeURIComponent(streamId)}/playlist-export`, {}),
  /** 同上,作用对象是一个 Collection(播单)。 */
  exportCollectionPlaylist: (c: Connection, collectionId: string) =>
    post<{ written: number; skipped: number; path?: string }>(c, `/api/collections/${encodeURIComponent(collectionId)}/playlist-export`, {}),
  // —— netdisk (AList) bindings: 对齐层绑定 CRUD / 同步 / 重绑 / entry 修正 / 目录浏览 ——
  netdisk: {
    // —— 分享验活 / 转存（netdisk.share.* 两个 Provider 调用点）——
    // 都是 POST 且慢（要驱动真浏览器打开分享页，单会话串行，数秒一条）：别在列表渲染时批量调，
    // 按用户意图逐条调。
    /** 一条分享 → 存活与否 + 里面的文件。给 link 即可（后端解析成 netdisk+pwd_id）。
     *  501 = 这个网盘还没接 —— 不是"链接死了"，别混。
     *  `unknown` 同理 = 后端试了但没查成（上游 5xx / 限流 / 网络故障），也不是"链接死了"。 */
    verifyShare: (c: Connection, body: ShareRef & { passcode?: string }) =>
      post<{
        validity: 'alive' | 'not-usable' | 'needs-login' | 'unknown' | 'unknown'
        files: Array<{ name: string; is_dir: boolean; size: number }>
        netdisk: string
        pwd_id: string
      }>(c, '/api/netdisk/share/verify', body),
    /** 转存进落点目录（默认取 Provider 行上的 dest）。转存失败是 200 + saved:false + stage，不是异常。 */
    /** 转存一条分享。带 `bind` 就走「转存 → 自动绑定」闭环：落进作品专属目录 + 绑成该作品的
     *  tmdb 绑定 + 同步配集，返回里带 `binding`（配上几集、哪些能播），前端刷新即可播。 */
    saveShare: (
      c: Connection,
      body: ShareRef & { dest?: string; passcode?: string; bind?: { id: string; media: 'movie' | 'tv'; title: string; year?: number } },
    ) =>
      post<{
        saved: boolean; stage: string; message: string; dest?: string; file_count?: number
        binding?: { id: string; dirPath: string; total: number; matched: number; unaired?: number; playable: { leftKey: string; title: string }[] } | { error: string }
      }>(c, '/api/netdisk/share/save', body),
    /** 列出所有绑定。 */
    list: (c: Connection) => get<MappingSet[]>(c, '/api/netdisk/mappings'),
    /** 单个绑定详情。 */
    get: (c: Connection, id: string) => get<MappingSet>(c, `/api/netdisk/mappings/${encodeURIComponent(id)}`),
    /** 追更（spec 2026-09-03-work-follow-loop）：查详情 / 开关 / 立即跑一轮 / 未绑时直接追一部剧。 */
    follow: {
      get: (c: Connection, id: string) => get<FollowView>(c, `/api/netdisk/mappings/${encodeURIComponent(id)}/follow`),
      set: (c: Connection, id: string, enabled: boolean) =>
        patch<MappingSet>(c, `/api/netdisk/mappings/${encodeURIComponent(id)}/follow`, { enabled }),
      run: (c: Connection, id: string) => post<FollowRunRecord>(c, `/api/netdisk/mappings/${encodeURIComponent(id)}/follow/run`, {}),
      create: (c: Connection, tmdb: { id: string; media: 'tv'; title: string; year?: number }) =>
        post<MappingSet>(c, '/api/netdisk/follow', { tmdb }),
    },
    /**
     * 建绑定 + 首次全量同步。左侧二选一：
     *   `streamId` —— 集清单来自订阅流
     *   `tmdb`     —— 集清单来自 TMDb 权威（作品不必是 Stream 也能绑）
     * `media` 不能省：TMDb 的 id 按媒体类型分命名空间（电影 1399 ≠ 剧集 1399）。
     */
    create: (
      c: Connection,
      body:
        | { streamId: string; title?: string; dirPath: string; autoSync?: boolean }
        | { tmdb: { id: string; media: 'movie' | 'tv'; title?: string }; dirPath: string; autoSync?: boolean },
    ) => post<MappingSet>(c, '/api/netdisk/mappings', body),
    /** 立即同步（重新 list 目录 diff 增量）。 */
    sync: (c: Connection, id: string) => post<MappingSet>(c, `/api/netdisk/mappings/${encodeURIComponent(id)}/sync`, {}),
    /** 重新绑定目录（旧目录进 rightHistory，confirmed 按指纹继承）。 */
    rebind: (c: Connection, id: string, dirPath: string) =>
      post<MappingSet>(c, `/api/netdisk/mappings/${encodeURIComponent(id)}/rebind`, { dirPath }),
    /** 删除绑定。 */
    remove: (c: Connection, id: string) => del<{ ok: boolean }>(c, `/api/netdisk/mappings/${encodeURIComponent(id)}`),
    /** 删除绑定 **连同网盘上那个目录**（夸克进回收站，约 10 天可捞）。不可逆，调用方必须先让人确认。
     *  路径不由这里传——后端从绑定记录里取，免得「删错目录」变成一个参数错误就能触发的事故。
     *  删文件失败会抛（502），且绑定原样保留。 */
    removeWithFiles: (c: Connection, id: string) =>
      del<{ ok: boolean; filesDeleted?: boolean; dirPath?: string }>(
        c,
        `/api/netdisk/mappings/${encodeURIComponent(id)}?files=1`,
      ),
    /** entry 人工订正：{rightFile} 选文件（后端落 confirmed + 记 corrected）、{rightFile:null} 清除配对。 */
    patchEntry: (
      c: Connection,
      id: string,
      leftKey: string,
      body: { rightFile?: string | null; status?: MappingEntry['status'] },
    ) => patch<MappingSet>(c, `/api/netdisk/mappings/${encodeURIComponent(id)}/entries/${encodeURIComponent(leftKey)}`, body),
    /** 列 AList 目录。recursive=true → 递归只列文件（文件选择框候选，name 为相对子路径）；
     *  否则单层含子目录（目录选择器逐级浏览）。dirs=true → 递归结果里**也带上目录行**
     *  （目录选择框跨子树搜索用；只在 recursive 下有意义，默认关——文件选择框的平铺列表
     *  以「没有可下钻的目录」为前提）。refresh=true → 绕过 AList 目录缓存看网盘现状。 */
    listFs: (
      c: Connection,
      path: string,
      opts?: { recursive?: boolean; refresh?: boolean; dirs?: boolean },
    ) =>
      get<{ path: string; files: AlistFile[] }>(
        c,
        `/api/netdisk/fs?path=${encodeURIComponent(path)}${opts?.recursive ? '&recursive=1' : ''}${opts?.dirs ? '&dirs=1' : ''}${opts?.refresh ? '&refresh=1' : ''}`,
      ),
    /** 建目录（幂等，已存在不报错）。**整理开局那四步已经归后端**（`reconcile_open`），前端这一格
     *  只剩零散用途；别拿它在前端重建一遍"建货架 → 建绑定 → 写配置"的编排。 */
    mkdir: (c: Connection, path: string) => post<{ ok: true }>(c, '/api/netdisk/fs/mkdir', { path }),
    // —— 挂载网盘：preset 目录 + 期望态覆盖 + 手动 reconcile ——
    /** preset 目录 + 当前期望态（UI 首屏一次拿全）。 */
    mounts: (c: Connection) =>
      get<NetdiskMountsView>(c, '/api/netdisk/mounts'),
    /** 覆盖期望态并立即 reconcile（missingCookie → UI 引导登录）。 */
    setMounts: (c: Connection, mounts: NetdiskMountEntry[]) =>
      put<NetdiskReconcileResult>(c, '/api/netdisk/mounts', { mounts }),
    /** 手动重跑（cookie 刚同步完 / AList 重启后自愈）。 */
    reconcileMounts: (c: Connection) =>
      post<NetdiskReconcileResult>(c, '/api/netdisk/mounts/reconcile', {}),
  },
  /** 归档器（spec §4「整理」面板）：show 配置 + 分流预览/执行 + 待定豁免。
   *  未装配（netdisk 整体未启用）→ 全端点 503,前端按 ApiError.status 判空态,别硬编码字符串比对。 */
  /** 移动网盘文件。整理面板「收进付费库」用——付费库 = 「要跟节目单配对的那些」,收而不删。 */
  netdiskFsMove: (c: Connection, srcDir: string, dstDir: string, names: string[]) =>
    post<{ ok: true; moved: number }>(c, '/api/netdisk/fs/move', { srcDir, dstDir, names }),
  /** 删除网盘文件（夸克进回收站,~10 天可捞）。整理面板「删网盘这份」用。 */
  netdiskFsRemove: (c: Connection, dir: string, names: string[]) =>
    post<{ ok: true; removed: number }>(c, '/api/netdisk/fs/remove', { dir, names }),
  reconcile: {
    config: (c: Connection) => get<{ shows: ReconcileShowConfig[] }>(c, '/api/netdisk/reconcile/config'),
    /** 整份替换 show 配置文档（后端语义是覆盖不是合并）——调用方必须把不改的 show 也原样带回，
     *  漏一个字段（尤其 `identity`）会被当成「用户要清空它」静默生效。400 = sourceDir 与库目录重叠
     *  或 identity 正则编译失败，message 里带具体原因，直接透传给用户。 */
    putConfig: (c: Connection, shows: ReconcileShowConfig[]) =>
      put<{ ok: true }>(c, '/api/netdisk/reconcile/config', { shows }),
    /** 这条订阅的节目单统计——**不要求它配过整理、也不要求它有绑定**。网盘入口靠 `stats.needsSupply`
     *  答「该用整理还是该挂载」：>0 说明源站有集放不出来（整理有活干），=0 说明每集都能放（网盘目录
     *  该当新节目源挂上来）。503 = netdisk 整体没启用。 */
    streamAuthority: (c: Connection, streamId: string) =>
      get<{ stats: AuthorityStats }>(c, `/api/netdisk/reconcile/streams/${encodeURIComponent(streamId)}/authority`),
    preview: (c: Connection, showId: string) =>
      post<ReconcilePreview>(c, `/api/netdisk/reconcile/${encodeURIComponent(showId)}/preview`, {}),
    execute: (c: Connection, showId: string) =>
      post<ReconcileExecResult>(c, `/api/netdisk/reconcile/${encodeURIComponent(showId)}/execute`, {}),
    /** 任意一条网盘绑定的原地整理预览（影视「一键去重」）——不需要在整理面板里配过 show，后端合成
     *  一份退化配置（无暂存区、无第二货架）走同一条管线。404 = 绑定不存在，400 = 配置问题（如绑定
     *  没有落地目录），message 原文就是用户该去补什么的指路，别翻译成「预览失败」。 */
    previewBinding: (c: Connection, bindingId: string) =>
      post<ReconcilePreview>(c, `/api/netdisk/reconcile/bindings/${encodeURIComponent(bindingId)}/preview`, {}),
    /** 执行上一步预览过的处置。**必须先 preview 给人看过**：删不可逆（夸克回收站约 10 天可捞）。 */
    executeBinding: (c: Connection, bindingId: string) =>
      post<ReconcileExecResult>(c, `/api/netdisk/reconcile/bindings/${encodeURIComponent(bindingId)}/execute`, {}),
    /** 整轮撤销：把 `runId` 那一整轮动作倒序搬回去（改名撤回、搬运搬回，删除跳过——回收站自己捞）。 */
    undoRun: (c: Connection, runId: string) =>
      post<{ undone: number; skipped: number }>(c, '/api/netdisk/reconcile/undo-run', { runId }),
    /** 待定行「豁免」：key 是集身份键（`makeIdentity()` 产出），不是文件名——取自 preview 响应里每条 plan action 的 `key`。 */
    setDecision: (c: Connection, key: string, verdict: 'exempt' | 'tombstone' | null, note?: string) =>
      post<{ ok: boolean }>(c, '/api/netdisk/reconcile/decisions', { key, verdict, note }),
    /** `duration-collision` 的出口「不是这一集」：两侧都取自预览那条行（`collidesWith` + `src.path`），
     *  组合键由后端拼。**只写决定不动文件**——下一轮它按"清单里没有它"走下架，那条 move 照样要人点执行。 */
    setNotEpisode: (c: Connection, leftKey: string, path: string, on = true) =>
      post<{ ok: boolean }>(c, '/api/netdisk/reconcile/decisions', { leftKey, path, verdict: on ? 'not-episode' : null }),
    /** 同一个问句的另一半答案「就是这一集」。落下去之后它是**匹配层的 pin**：下一轮这一对在任何
     *  判据跑之前就钉死，认领与搬运照常走匹配器 → 归档器那条唯一的路，move 仍要人点。 */
    setIsEpisode: (c: Connection, leftKey: string, path: string, on = true) =>
      post<{ ok: boolean }>(c, '/api/netdisk/reconcile/decisions', { leftKey, path, verdict: on ? 'is-episode' : null }),
    /** `pending(replace)` 的出口「留哪一份」：两个**文件路径**（第二货架那里没有集身份，只有两份文件）。
     *  只写决定不动文件——下一轮它变成一条 `delete-loser`/`replace`，照样进「将删清单」等人点确认。 */
    setPreferred: (c: Connection, keptPath: string, loserPath: string, on = true) =>
      post<{ ok: boolean }>(c, '/api/netdisk/reconcile/decisions', { keptPath, loserPath, verdict: on ? 'prefer' : null }),
    /**
     * 「AI 建议 vs 人最终选择」的对照账本。**只读**：两半都是别处的副作用（判读出结论时落前半截，
     * 写决定时回填后半截），这里没有、也不该有写入口。
     *
     * `summary` 永远是**全表**，不跟着筛选/分页变。看反例（AI 判错的实证）用 `agreement: 'disagree'`。
     */
    suggestions: (
      c: Connection,
      q: { state?: 'open' | 'answered'; agreement?: 'agree' | 'disagree' | 'inconclusive'; limit?: number; cursor?: number } = {},
    ) => {
      const p = new URLSearchParams()
      for (const [k, v] of Object.entries(q)) if (v != null) p.set(k, String(v))
      const qs = p.toString()
      return get<{ items: SuggestionView[]; nextCursor?: number; summary: SuggestionSummary }>(
        c, `/api/netdisk/reconcile/suggestions${qs ? `?${qs}` : ''}`,
      )
    },
  },
  /** 配置分享（stream-bundle）：导出编排为单 JSON；一次导入 = 一个 run，遗留事项逐条 decision。 */
  sharing: {
    exportBundle: (c: Connection, root: ShareRoot, meta?: Record<string, unknown>, caps?: { providerIds?: string[]; bindingCallsiteIds?: string[]; netdiskBindingIds?: string[] }) =>
      post<{ bundle: StreamBundleView; warnings: string[] }>(c, '/api/sharing/exports', { root, meta, ...caps }),
    importBundle: (c: Connection, payload: { url?: string; bundle?: unknown }) =>
      post<ImportRunView>(c, '/api/sharing/imports', payload),
    imports: (c: Connection) =>
      get<{ items: ImportRunSummaryView[] }>(c, '/api/sharing/imports').then((r) => r.items),
    importRun: (c: Connection, id: string) =>
      get<ImportRunView>(c, `/api/sharing/imports/${encodeURIComponent(id)}`),
    decide: (c: Connection, runId: string, itemId: string, choice: string) =>
      post<{ item: ImportItemView }>(c, `/api/sharing/imports/${encodeURIComponent(runId)}/decisions`, { itemId, choice }),
  },
  /** voiceprint speaker registry — named persons + per-item cluster listing/enroll.
   *  503s when the backend's speaker registry isn't configured (no ApiError special-casing
   *  needed here; callers see the plain ApiError like any other unavailable feature). */
  voiceprint: {
    listPersons: (c: Connection) => get<{ persons: VoicePerson[] }>(c, '/api/voiceprint/persons').then((r) => r.persons),
    createPerson: (c: Connection, name: string) => post<VoicePerson>(c, '/api/voiceprint/persons', { name }),
    deletePerson: (c: Connection, id: string) => del<void>(c, `/api/voiceprint/persons/${encodeURIComponent(id)}`),
    /** (Re)build the item's speaker clusters — a speaker-identification-only pass (STT is NOT
     *  re-run; 转写也不是前提). 202 = queued; the pass runs minutes (audio re-extraction),
     *  so poll /clusters until it turns non-empty (它读的是声纹库时间线，唯一存储). */
    recluster: (c: Connection, itemId: string) =>
      post<{ status: string }>(c, `/api/voiceprint/item/${encodeURIComponent(itemId)}/clusters`, {}),
    /** Diarized speaker clusters aggregated from the item's diarization timeline (声纹库). */
    listClusters: (c: Connection, itemId: string) =>
      get<{ clusters: SpeakerCluster[] }>(c, `/api/voiceprint/item/${encodeURIComponent(itemId)}/clusters`).then((r) => r.clusters),
    /** Bind a cluster to a person (enrolls the voiceprint + renames the cluster label in the
     *  stored transcript, so subsequent renders show the person's name). */
    enroll: (c: Connection, itemId: string, cluster: string, personId: string) =>
      post<{ ok: boolean }>(
        c,
        `/api/voiceprint/item/${encodeURIComponent(itemId)}/clusters/${encodeURIComponent(cluster)}/enroll`,
        { personId },
      ),
    /** 否决一条待确认的抽名（演职员表查无此人，用户点「不认」）：记 rejected，同名同作品不再问。 */
    rejectPending: (c: Connection, itemId: string, cluster: string) =>
      del<void>(c, `/api/voiceprint/item/${encodeURIComponent(itemId)}/pending/${encodeURIComponent(cluster)}`),
    /** Speech blocks (merged, gap-bridged, >= minSeconds) for ArtPlayer's timeline + skip logic.
     *  Omit `person` for every speaker's qualifying blocks (the 人物图谱). Default floor 60s. */
    blocks: (c: Connection, itemId: string, opts?: { person?: string; minSeconds?: number }) => {
      const qs = new URLSearchParams()
      if (opts?.person) qs.set('person', opts.person)
      if (opts?.minSeconds) qs.set('minSeconds', String(opts.minSeconds))
      const q = qs.toString()
      return get<{ blocks: { start: number; end: number; label: string }[] }>(
        c,
        `/api/voiceprint/item/${encodeURIComponent(itemId)}/blocks${q ? `?${q}` : ''}`,
      ).then((r) => r.blocks)
    },
  },
}
