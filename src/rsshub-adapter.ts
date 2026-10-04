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

// One worker for the whole process. Lazy-spawns on first init/request; respawns if it crashes.
//
// 解析注入点（其中就有 `dataDir`）住在**一个稳定的对象**里，由第一个建出来的 adapter 填进去。
// 传对象而不是传值，是因为这个 client 是模块级单例、可能比 adapter 先被 back-compat 助手碰到：
// 那时若把当时的 deps 拷贝一份存下来，dataDir 就永远是空的，发行形态下每条源都跑不了
// （client 每次 spawn 会重读这个对象，所以后填进来的一样算数）。
const clientDeps: RsshubResolveDeps = {}
let client: RsshubClient | null = null
function getClient(): RsshubClient {
  client ??= new RsshubClient({ resolveDeps: clientDeps })
  return client
}

/** 只给测试用：把单例 worker 收掉、注入点清空，下一次调用重建。 */
export async function __disposeRsshubClient(): Promise<void> {
  const c = client
  client = null
  initialized = false
  for (const k of Object.keys(clientDeps)) delete (clientDeps as Record<string, unknown>)[k]
  if (c) await c.dispose()
}

let initialized = false
// Cookie env we've already handed the worker. RSSHub snapshots its config once and never re-reads
// env on its own, so a cookie that first arrives AFTER init (e.g. some facility, when an earlier fetch
// was a public/cookieless route) would otherwise never reach it. We track what we sent and re-run
// init whenever an incoming value differs — cheap, no restart. (This dedup keeps us from firing an
// init RPC on every fetch; the client separately replays accumulated env if the worker respawns.)
const appliedCreds: Record<string, string> = {}

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

  constructor(
    opts: {
      resolveDeps?: RsshubResolveDeps
      log?: (msg: string) => void
      install?: (dataDir: string, log: (m: string) => void) => Promise<unknown>
      catalog?: CatalogRefreshHooks
      /** 取数注入点（默认走那个模块级 worker）。测试用它把 worker 整个摘掉。 */
      request?: (path: string) => Promise<unknown>
    } = {}
  ) {
    this.resolveDeps = opts.resolveDeps ?? {}
    this.log = opts.log ?? (() => {})
    this.install = opts.install ?? ((dataDir, log) => ensureRsshubInstalled({ dataDir, log }))
    this.catalog = opts.catalog
    this.request = opts.request ?? fetchRoute
    Object.assign(clientDeps, this.resolveDeps)
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
    // Re-init when a cookie value changed vs what we last sent — client.init() re-runs RSSHub's
    // setConfig() in the worker with the updated env. Empty overrides (auth:none) never count as
    // "changed", so public routes still trigger only the one-time first init.
    const changed = Object.entries(envOverrides).some(([k, v]) => appliedCreds[k] !== v)
    if (initialized && !changed) return
    await getClient().init(envOverrides)
    initialized = true
    Object.assign(appliedCreds, envOverrides)
  }

  async fetch(params: Record<string, unknown>, manifest: SourceManifest): Promise<{ items: unknown[]; title?: string }> {
    await this.ensureAvailable()
    const route = resolveRoute(manifest, params)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await this.request(route)) as any
    await this.refreshCatalogIfStale()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = (data?.item ?? data?.items ?? []) as any[]
    const title = typeof data?.title === 'string' ? data.title : undefined
    return { items: stampFeedFields(items, data), title }
  }
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
  if (initialized) return
  await getClient().init(envOverrides)
  initialized = true
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchRoute(path: string): Promise<any> {
  return getClient().request(path)
}
