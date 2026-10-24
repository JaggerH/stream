/**
 * RSSHub adapter — execution backend #1.
 *
 * RSSHub itself runs in a worker thread (see rsshub-worker.ts); this adapter only maps our
 * manifests to routes and shapes the Data back into items. It reaches the worker through
 * RsshubClient — the whole cross-thread surface is two calls, init(env) and request(path).
 *
 * Why a worker and not an in-process import: RSSHub's request-rewriter replaces the global fetch
 * (which used to rewrite OUR outbound too) and its routes compile on first hit on the main thread
 * (~200ms stalls). Both now live on the worker's own globals + event loop. See rsshub-worker.ts.
 */
import type { Adapter } from './adapters/types.ts'
import type { SourceManifest } from './manifest/types.ts'
import { RsshubClient, rsshubUnavailableReason, type RsshubResolveDeps } from './rsshub-client.ts'
import { ensureRsshubInstalled } from './rsshub-install.ts'

/** 长尾目录的两个钩子：什么时候该重取、取回来交给谁（实现在 `kernel/plugins/sources.ts`）。 */
export interface CatalogRefreshHooks {
  needsRefresh: () => boolean
  apply: (raw: Record<string, unknown>) => unknown
}

/**
 * 一个 RSSHub worker 线程及它的初始化状态。**进程级共享资源**（openspec `embeddable-engine` D4）：由
 * `StreamRuntime` 持有一份、传给共用它的所有实例——一个进程里只该有一个 RSSHub（它改写的是 worker 自己的全局
 * fetch / node:http，起一个 +168MB RSS）。懒起：第一次 init / request 才 spawn；崩了自己重起。
 *
 * **共用一个 worker = 共用一份 RSSHub 凭证环境**：RSSHub 只认它进程级的 config，cookie 按「最后一次 init 的值」生效。
 * 要两个实例的 RSSHub 登录态互不相干，就给它们各自的 runtime（各一个 worker）。
 */
export class RsshubWorker {
  // 解析注入点（其中就有 `dataDir`）住在**一个稳定的对象**里，由第一个用到它的 adapter 填进去。
  // 传对象而不是传值：client 每次 spawn 会重读这个对象，后填进来的一样算数（否则发行形态下 dataDir 永远是空的，
  // 每条源都跑不了）。
  readonly deps: RsshubResolveDeps = {}
  private client: RsshubClient | null = null
  private initialized = false
  // Cookie env we've already handed the worker. RSSHub snapshots its config once and never re-reads
  // env on its own, so a cookie that first arrives AFTER init (e.g. some facility, when an earlier fetch
  // was a public/cookieless route) would otherwise never reach it. We track what we sent and re-run
  // init whenever an incoming value differs — cheap, no restart. (This dedup keeps us from firing an
  // init RPC on every fetch; the client separately replays accumulated env if the worker respawns.)
  private readonly appliedCreds: Record<string, string> = {}

  private getClient(): RsshubClient {
    this.client ??= new RsshubClient({ resolveDeps: this.deps })
    return this.client
  }

  /** worker 起过没有（双实例测试用：共用 runtime 时只该有一个）。 */
  get spawned(): boolean { return this.client !== null }

  /** 只在凭证变了（或从没 init 过）时才真发一次 init。 */
  async init(envOverrides: Record<string, string>): Promise<void> {
    // Re-init when a cookie value changed vs what we last sent — client.init() re-runs RSSHub's
    // setConfig() in the worker with the updated env. Empty overrides (auth:none) never count as
    // "changed", so public routes still trigger only the one-time first init.
    const changed = Object.entries(envOverrides).some(([k, v]) => this.appliedCreds[k] !== v)
    if (this.initialized && !changed) return
    await this.getClient().init(envOverrides)
    this.initialized = true
    Object.assign(this.appliedCreds, envOverrides)
  }

  /** 只 init 一次（spike 脚本的 back-compat 语义）。 */
  async ensureInit(envOverrides: Record<string, string>): Promise<void> {
    if (this.initialized) return
    await this.getClient().init(envOverrides)
    this.initialized = true
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request(path: string): Promise<any> {
    return this.getClient().request(path)
  }

  /** 收掉 worker、注入点清空；之后再用会重起一个。 */
  async dispose(): Promise<void> {
    const c = this.client
    this.client = null
    this.initialized = false
    for (const k of Object.keys(this.deps)) delete (this.deps as Record<string, unknown>)[k]
    for (const k of Object.keys(this.appliedCreds)) delete this.appliedCreds[k]
    if (c) await c.dispose()
  }
}

/**
 * 没递 runtime 的那些老入口（spike 脚本、`stream-pipeline.ts`、不带 `worker` 构造的 adapter）共用的那一个。
 * 懒建：库入口的实例都从自己的 runtime 拿，走不到这里。
 */
let fallbackWorker: RsshubWorker | undefined
function processWorker(): RsshubWorker {
  fallbackWorker ??= new RsshubWorker()
  return fallbackWorker
}

/** 只给测试用：把缺省 worker 收掉，下一次调用重建。 */
export async function __disposeRsshubClient(): Promise<void> {
  const w = fallbackWorker
  fallbackWorker = undefined
  if (w) await w.dispose()
}

/** Query keys forwarded from fetch params onto the resolved route. Allowlist, not "all
 *  non-path params": the resolve engine injects keys like `url` into params that must never
 *  leak into the route. `limit` is an RSSHub framework-level param (every route honors it). */
const QUERY_PASSTHROUGH = ['limit']

/** Substitute {key} placeholders in a route from params; error on anything left unresolved.
 *  Then append allowlisted query params not already declared by the template. */
export function resolveRoute(manifest: SourceManifest, params: Record<string, unknown>): string {
  const template = manifest.route ?? (params.route as string | undefined)
  if (!template) {
    throw new Error(`[rsshub] ${manifest.id}: no route (manifest.route or params.route required)`)
  }
  const has = (k: string) => params[k] !== undefined && params[k] !== null && params[k] !== ''
  const filled = template
    // {key} templating (our curated manifests)
    .replace(/\{(\w+)\}/g, (_m, key) => {
      if (!has(key)) throw new Error(`[rsshub] ${manifest.id}: missing route param "${key}"`)
      return String(params[key])
    })
    // RSSHub/Hono path param: :key, optionally carrying a {regex} constraint (e.g. :tags{.+})
    // and/or a trailing ? (optional). The constraint is Hono routing syntax, never part of the
    // value, so it must be stripped — not left in the fetched path. Optional-and-absent collapses
    // the whole "/segment" (drops the leading slash); required-and-missing errors.
    .replace(/(\/?):([a-zA-Z0-9_]+)(?:\{[^}]*\})?(\?)?/g, (_m, lead, key, opt) => {
      if (has(key)) return `${lead}${params[key]}`
      if (opt) return ''
      throw new Error(`[rsshub] ${manifest.id}: missing route param "${key}"`)
    })
  let route = filled
  for (const key of QUERY_PASSTHROUGH) {
    if (!has(key)) continue
    if (new RegExp(`[?&]${key}=`).test(template)) continue // template-declared query wins
    route += `${route.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(String(params[key]))}`
  }
  return route
}

export class RssHubAdapter implements Adapter {
  readonly id = 'rsshub'
  /** 解析注入点，只用于「本机有没有 RSSHub」这一问；测试把三个来源都掐掉来走安装 / decline 分支。 */
  private readonly resolveDeps: RsshubResolveDeps
  private readonly log: (msg: string) => void
  /** 注入点：测试**必须**换掉它，绝不能让用例真敲 npm。 */
  private readonly install: (dataDir: string, log: (m: string) => void) => Promise<unknown>

  /** 长尾目录的重取钩子。不接 = 不取（源码形态照旧读检出那个 routes.json）。 */
  private readonly catalog?: CatalogRefreshHooks
  private readonly request: (path: string) => Promise<unknown>
  readonly worker: RsshubWorker

  constructor(
    opts: {
      resolveDeps?: RsshubResolveDeps
      log?: (msg: string) => void
      install?: (dataDir: string, log: (m: string) => void) => Promise<unknown>
      catalog?: CatalogRefreshHooks
      /** 取数注入点（默认走 `worker`）。测试用它把 worker 整个摘掉。 */
      request?: (path: string) => Promise<unknown>
      /** 这个 adapter 用哪个 RSSHub worker（实例从 runtime 递）。缺省 = 进程缺省那一个。 */
      worker?: RsshubWorker
    } = {}
  ) {
    this.resolveDeps = opts.resolveDeps ?? {}
    this.log = opts.log ?? (() => {})
    this.install = opts.install ?? ((dataDir, log) => ensureRsshubInstalled({ dataDir, log }))
    this.catalog = opts.catalog
    this.worker = opts.worker ?? processWorker()
    const worker = this.worker
    this.request = opts.request ?? ((path) => worker.request(path))
    Object.assign(worker.deps, this.resolveDeps)
  }

  /**
   * 一次取数之后**顺手**把 RSSHub 的长尾目录重取一遍（只在缓存缺席 / 过期时）。
   *
   * 时机是这条的全部要点：worker 这会儿已经热着，`/api/namespace` 只要 67ms；而单独为它拉起
   * 一个 worker 是 +168MB RSS 且不会自己退。发行安装上目录本来是**整段缺席**的
   * （`routes.json` 是检出的构建产物、不在 npm tarball 里），这是它唯一的来源。
   *
   * **绝不让它影响这次取数**：失败只记一行日志。目录旧几天没人会死，一条源因为刷目录失败而
   * 取不到数才是真的坏。
   */
  private async refreshCatalogIfStale(): Promise<void> {
    const hooks = this.catalog
    if (!hooks?.needsRefresh()) return
    try {
      const raw = (await this.request('/api/namespace')) as Record<string, unknown> | null
      if (!raw || typeof raw !== 'object' || !Object.keys(raw).length) return
      hooks.apply(raw)
    } catch (e) {
      this.log(`[rsshub] 长尾目录这次没刷成（${(e as Error).message}）——不影响取数，下次再试`)
    }
  }

  /**
   * 确保这台机器上有 RSSHub —— 没有就**现装**（`rsshub-install.ts`：装到 `<dataDir>/rsshub/`，
   * 约 40 秒）。发行安装第一次跑到 RSSHub 源必然走这一趟，这是设计，不是异常。
   *
   * 装不动就抛错，且**在 spawn 之前**抛：让 worker 去撞 ERR_MODULE_NOT_FOUND 的那条路会以
   * unhandled rejection 的形式把整个后端带走（见 `RsshubClient.setReady`）。一个源取不到数是
   * 常态，不该是 fatal。
   */
  private async ensureAvailable(): Promise<void> {
    if (!rsshubUnavailableReason(this.resolveDeps)) return
    const { dataDir } = this.resolveDeps
    if (dataDir) {
      await this.install(dataDir, this.log)
      const after = rsshubUnavailableReason(this.resolveDeps)
      if (!after) return
      throw new Error(`[rsshub] 装完之后仍然找不到 RSSHub：${after}`)
    }
    throw new Error(
      `[rsshub] 这个源跑不了，因为${rsshubUnavailableReason(this.resolveDeps)}，而本机也没有可以装它的落点。` +
        `源码形态下 \`pnpm install\` 一次，或用 RSSHUB_PKG 指向本机的 RSSHub 检出。`
    )
  }

  async init(envOverrides: Record<string, string>): Promise<void> {
    await this.ensureAvailable()
    await this.worker.init(envOverrides)
  }

  async fetch(params: Record<string, unknown>, manifest: SourceManifest): Promise<{ items: unknown[]; title?: string }> {
    await this.ensureAvailable()
    const route = resolveRoute(manifest, params)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await this.request(route)) as any
    await this.refreshCatalogIfStale()
    // pkg.request() returns JSON even for non-2xx responses. An error envelope is
    // a failed harvest, never an authoritative empty collection.
    if (data?.error != null) {
      const message = typeof data.error === 'string' ? data.error : data.error.message
      throw new Error(`[rsshub] ${route}: ${typeof message === 'string' ? message : 'request failed'}`)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = data?.item ?? data?.items
    if (!Array.isArray(items)) throw new Error(`[rsshub] ${route}: invalid feed (expected item array)`)
    const title = typeof data?.title === 'string' ? data.title : undefined
    return { items: stampFeedFields(cleanFeedItems(items), data), title }
  }
}

/**
 * 清洗层：RSSHub 给的是**站点作者想让人看到的整页**，我们要的是**这一条内容本身**。两者之差
 * 在这里剥掉，下游（入库、intent 判相关、归堆、摘要）只见干净正文。
 *
 * 这里只放**站点无关**的通用规则；只对某一个站成立的规则不进这里（那是站点知识，归包）。
 *
 * 现有规则：
 * - **上一篇/下一篇导航**。CMS 详情页常在正文末尾带两段导航，各含邻居条目的标题。活体
 *   （0818团，2026-10-13）：50 条里 48 条带它，intent 按正文判相关时读到邻居的商品，
 *   「运动短裤」被判成「金典鲜奶好价」。只剥**整段就是"标签：一个链接/一行字"**的块，
 *   正文里顺嘴提到的「接着上一篇：…」不动。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cleanFeedItems(items: any[]): any[] {
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    if (typeof it.description === 'string') it.description = stripNavHtml(it.description)
    if (it.content && typeof it.content === 'object') {
      if (typeof it.content.html === 'string') it.content.html = stripNavHtml(it.content.html)
      if (typeof it.content.text === 'string') it.content.text = stripNavText(it.content.text)
    }
  }
  return items
}

const NAV_LABEL = '(?:上一篇|下一篇|上一条|下一条|上一则|下一则)'
const NAV_BLOCK_HTML = new RegExp(
  `<(p|div|li|span)\\b[^>]*>\\s*${NAV_LABEL}\\s*[:：]\\s*(?:<a\\b[^>]*>[\\s\\S]*?</a>|[^<]*)\\s*</\\1>`,
  'g',
)
/** 纯文本里只认**尾巴**上的导航：前面得有正文、前面隔着空白，一直到结尾。 */
const NAV_TAIL_TEXT = new RegExp(`(?<=\\S)\\s+${NAV_LABEL}\\s*[:：][\\s\\S]*$`)

function stripNavHtml(html: string): string {
  return html.replace(NAV_BLOCK_HTML, '')
}

function stripNavText(text: string): string {
  return text.replace(NAV_TAIL_TEXT, '')
}

/** A single-author feed (one creator's dynamics on a video platform, one site's articles, one iqiyi album) has
 *  ONE work identity: RSSHub sets `data.image` = the work poster/face and `data.description` = the
 *  work synopsis. Stamp both onto the items (author_avatar = poster; __feedSynopsis = synopsis) so
 *  the reader / video work-detail can show them — the projection reads them for followed works.
 *  Multi-author feeds (followings / popular) carry per-item authors but one channel image, so
 *  stamping either on every row would be wrong — detect that by >1 distinct author and skip. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stampFeedFields(items: any[], data: any): any[] {
  if (items.length === 0) return items
  const authors = new Set(items.map((it) => (it?.author == null ? '' : JSON.stringify(it.author))))
  if (authors.size !== 1) return items
  const image = typeof data?.image === 'string' ? data.image : undefined
  const synopsis = typeof data?.description === 'string' ? data.description.trim() : ''
  for (const it of items) {
    if (!it) continue
    if (image && it.author_avatar == null) it.author_avatar = image
    if (synopsis && it.__feedSynopsis == null) it.__feedSynopsis = synopsis
  }
  return items
}

// --- back-compat helpers used by the spike scripts ---

export async function ensureInit(envOverrides: Record<string, string>): Promise<void> {
  await processWorker().ensureInit(envOverrides)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchRoute(path: string): Promise<any> {
  return processWorker().request(path)
}
