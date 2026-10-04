import type { Adapter, AdapterSidecar } from '../../../src/adapters/types.ts'
import type { SourceManifest } from '../../../src/manifest/types.ts'
import type { VideoResolved } from '../../../src/video/play.ts'
import type { DouyinAweme, DouyinAwemeListData, DouyinItem, DouyinResponse } from './douyin-types.ts'
import type { BiliResponse } from './bilibili-types.ts'
import type { TiktokResponse } from './tiktok-types.ts'
import { isDeclarative, runDeclarative, type Normalizer } from './executor.ts'
import { toDouyinItem } from './normalize.ts'
import { parseDanmakuXml } from './danmaku.ts'
import { playAddrOf, type MediaPlatform } from './play-addr.ts'
import { fetchUrlFor } from '../fetch-url.ts'
import { readDouyinAweme } from '../douyin-detail.ts'
import type { PackageReadSource } from '../../../src/packages/read-source.ts'

/**
 * The single adapter for the Douyin_TikTok_Download_API plugin — a thin HTTP client over
 * the EXTERNAL, already-running video-service backend that fronts three facilities
 * (douyin / bilibili / tiktok) behind one image. Stream does NOT own that process'
 * lifecycle (no sidecar): it just calls it over HTTP at `baseUrl`.
 *
 * Routing is DECLARATIVE, not code: each source declares its `api` binding in the
 * manifest — either `{endpoint, query, unwrap}` run by the generic executor, or
 * `{handler: <name>}` for logic a declaration can't express (multi-step, pagination,
 * conditional routing, browser sidecar, injected-credential query). This replaces the
 * old three-adapter `switch(params.mode)` design (see the adding-external-api-plugin skill).
 *
 * TikTok's personalized feed gets its login cookie host-injected through the standard credential
 * seam (manifest `auth: cookie:tiktok.com` → CredentialResolver → init/sidecar env), never
 * resolved here. **抖音那半不经这条缝**：它的个性化源与作品详情都在用户自己的 Chrome 里跑 recipe
 * （`douyin-user` / `douyin-follow` / `douyin-detail`），用的就是浏览器自己那份登录态。
 */
/** compose service 名（本包 `package.json` 的 `stream.backend.service`）——`withAwake` 的唤醒键。
 *  单一真相源，别再散落字面量。 */
export const DOUYIN_SERVICE = 'douyin-tiktok-download-api'

/** 宿主经 `ctx` 递进来的两样运行时能力（包不 import 宿主的运行时单例，见 `PluginContext`）：
 *  - `backendUrl`：本包容器此刻的地址（compose 档容器 DNS / host 档醒着的容器的 loopback
 *    origin），**thunk 不是值**——host 档下 origin 只在容器醒着时存在，构造期快照必得空。
 *  - `withAwake`：打容器前先唤醒（standby 管着的容器闲置会停）。 */
export interface AdapterDeps {
  backendUrl: () => string | undefined
  withAwake: <T>(service: string, fn: () => Promise<T>) => Promise<T>
  /** 跑本包自己的源（裸名按本包限定）。抖音作品详情**只**经它走 —— 见 `hybridVideoData`。 */
  readSource: PackageReadSource
}

/** 这条链接归抖音（含 `iesdouyin.com` 分享域）还是 TikTok —— `hybridVideoData` 的分路判据。
 *  抽成具名函数而不是内联正则：它决定「走 recipe 还是走容器」，得能被搜到、能被测试钉住。 */
export function isDouyinUrl(url: string): boolean {
  return /(^|\.)(douyin|iesdouyin)\.com([/?]|$)/.test(url.replace(/^https?:\/\//, ''))
}

/** Named normalizers a declarative source may reference via `api.normalize`. bilibili/tiktok
 *  return raw items (their presenter reads them); douyin bridges each aweme to StreamItem. */
const NORMALIZERS: Record<string, Normalizer> = { douyin: (raw) => toDouyinItem(raw as DouyinAweme) }

/** 作品 id → 主站作品页链接，交给容器的 `/api/hybrid/video_data`（它按 URL 认平台、抠 id）。 */
function pageUrlOf(platform: MediaPlatform, vid: string): string {
  return platform === 'douyin'
    ? `https://www.douyin.com/video/${vid}`
    : `https://www.tiktok.com/video/${vid}`
}

/** 容器 `/api/douyin/web/fetch_video_comments` 里一条评论——只声明映射用得上的字段
 *  （活体 2026-09-19 核过：`create_time` 是 unix 秒，`avatar_thumb.url_list` 首条可能为空串）。 */
export interface RawDouyinComment {
  cid?: string
  text?: string
  digg_count?: number
  create_time?: number
  ip_label?: string
  user?: { nickname?: string; avatar_thumb?: { url_list?: string[] } }
}

/** 一页评论。`cursor` 是站方的翻页游标（数字，下一页原样递回），`hasMore` 已从站方的 `0/1` 翻成布尔。 */
export interface VideoCommentsPage {
  comments: RawDouyinComment[]
  total: number
  cursor: number
  hasMore: boolean
}

export class DouyinTiktokDownloadApiAdapter implements Adapter {
  readonly id = 'Douyin_TikTok_Download_API'
  /** host-injected login cookie for the personalized TikTok feed (freshest from the broker → env).
   *  **抖音那一格没有了**：它的两个个性化源（user / follow）已经改成在用户自己的 Chrome 里跑 recipe，
   *  登录态是浏览器自己的那一份，不经这条注入缝。只写不读的凭据字段比没有更坏——它让读代码的人
   *  以为登录态还在这条路上流动。 */
  private tiktokCookie = ''

  constructor(private readonly deps: AdapterDeps) {}

  /** 容器地址：环境变量 `DOUYIN_API_URL`（显式覆盖，比如用户自己跑的一份 http://10.0.0.21:3007）
   *  > 宿主托管的容器地址；两个都没有 → 空串（fetch 报 URL 解析失败，宿主 plugin-target 频道负责喊）。
   *  惰性：host 档下 origin 是容器醒着时才存在的（standby Cell 缓存），构造期快照必得空串。
   *  每次求值现解析；fetch 都在 withAwake 回调里，求值时容器已醒。compose 档恒定，无行为差。 */
  private get baseUrl(): string {
    return (process.env.DOUYIN_API_URL ?? this.deps.backendUrl() ?? '').replace(/\/$/, '')
  }

  async init(env: Record<string, string>): Promise<void> {
    if (env.TIKTOK_COOKIE) this.tiktokCookie = env.TIKTOK_COOKIE
  }

  /** No process to own — the video-service runs as its own container. The sidecar seam is
   *  used only to receive the freshest login cookies for the personalized HTTP feeds. */
  sidecar: AdapterSidecar = {
    start: async (creds) => {
      if (creds.TIKTOK_COOKIE) this.tiktokCookie = creds.TIKTOK_COOKIE
    },
    health: async () => true,
    shutdown: async () => {},
  }

  async fetch(params: Record<string, unknown>, manifest: SourceManifest): Promise<unknown[]> {
    const api = manifest.api
    if (isDeclarative(api)) {
      return runDeclarative(api, params, (path, query) => this.get(path, query), NORMALIZERS)
    }
    if (api && 'handler' in api) return this.dispatch(api.handler, params)
    throw new Error(`[Douyin_TikTok_Download_API] source "${manifest.id}" has no api binding`)
  }

  private dispatch(handler: string, params: Record<string, unknown>): Promise<unknown[]> {
    switch (handler) {
      // douyin-user / douyin-follow 不在这里了：两个源都迁成了本包的 recipe（`douyin-user.recipe.json`
      // / `douyin-follow.recipe.json`，源 id 没变）。前者的 HTTP 端点被 Argus 挡死，后者的容器端点
      // 在 fork 里压根不存在（恒 404）——两条都不是「再修一修」能救的，理由写在各自 recipe 的
      // `_why_recipe_at_all` 里。
      case 'douyin-resolve': return this.resolveMember('douyin', params)
      case 'tiktok-resolve': return this.resolveMember('tiktok', params)
      // 贴链接抓媒体：`douyin-url` / `tiktok-url` Provider 行的成员（manifest `output: object`，
      // 回单个对象）。容器错误由 fetchUrlFor **装进结果**而不是抛——认领了这个站却失败，要把
      // 原话带给调用方，而不是让梯子以为没人认领。
      case 'douyin-fetch-url': return fetchUrlFor(this, 'douyin', String(params.url ?? '')).then((r) => [r])
      case 'tiktok-fetch-url': return fetchUrlFor(this, 'tiktok', String(params.url ?? '')).then((r) => [r])
      case 'bilibili-comments': return this.bilibiliComments(params)
      case 'bilibili-danmaku': return this.bilibiliDanmaku(params)
      case 'tiktok-comments': return this.tiktokComments(params)
      case 'tiktok-user-collect': return this.tiktokUserCollect(params)
      default: throw new Error(`[Douyin_TikTok_Download_API] unknown handler "${handler}"`)
    }
  }

  // ---------------------------------------------------------------- bilibili handlers
  private async bilibiliComments(params: Record<string, unknown>): Promise<unknown[]> {
    const bvId = String(params.bv_id ?? '')
    if (!bvId) throw new Error('[bilibili] comments needs `bv_id`')
    const pn = Number(params.pn ?? 1)
    const rpid = params.rpid ? String(params.rpid) : ''
    const path = rpid ? '/api/bilibili/web/fetch_comment_reply' : '/api/bilibili/web/fetch_video_comments'
    const query: Record<string, string | number> = rpid ? { bv_id: bvId, pn, rpid } : { bv_id: bvId, pn }
    // video-service 透传 bilibili 官方 envelope → 内层再包一层 data (同其它 bilibili 端点).
    const res = await this.get<BiliResponse<{ data?: { replies?: unknown[] } }>>(path, query)
    return Array.isArray(res.data?.data?.replies) ? res.data.data.replies : []
  }

  private async bilibiliDanmaku(params: Record<string, unknown>): Promise<unknown[]> {
    const bvId = String(params.bv_id ?? '')
    if (!bvId) throw new Error('[bilibili] danmaku needs `bv_id`')
    // fetch_one_video wraps bilibili's official envelope → the cid sits at data.data.cid.
    const detail = await this.get<BiliResponse<{ data?: { cid?: number } }>>('/api/bilibili/web/fetch_one_video', { bv_id: bvId })
    const cid = detail.data?.data?.cid
    if (!cid) return []
    const xml = await this.getText('/api/bilibili/web/fetch_video_danmaku', { cid })
    return parseDanmakuXml(xml)
  }

  // ------------------------------------------------------------------ tiktok handlers
  private async tiktokComments(params: Record<string, unknown>): Promise<unknown[]> {
    const awemeId = String(params.aweme_id ?? '')
    if (!awemeId) throw new Error('[tiktok] comments needs `aweme_id`')
    const commentId = params.comment_id ? String(params.comment_id) : ''
    const path = commentId ? '/api/tiktok/web/fetch_post_comment_reply' : '/api/tiktok/web/fetch_post_comment'
    const query: Record<string, string | number> = commentId
      ? { item_id: awemeId, comment_id: commentId, cursor: Number(params.cursor ?? 0) }
      : { aweme_id: awemeId, cursor: Number(params.cursor ?? 0) }
    // ⚠️ unwrap PROVISIONAL — not curl-verified (needs a real aweme_id); video-service may
    // wrap tiktok's envelope like bilibili's (data.data.*). Re-verify with real data.
    const res = await this.get<TiktokResponse<{ comments?: unknown[] }>>(path, query)
    return Array.isArray(res.data?.comments) ? res.data.comments : []
  }

  private async tiktokUserCollect(params: Record<string, unknown>): Promise<unknown[]> {
    const secUid = String(params.sec_uid ?? '')
    if (!secUid) throw new Error('[tiktok] user-collect needs `sec_uid`')
    if (!this.tiktokCookie) throw new Error('[tiktok] user-collect mode needs a login cookie — declare auth: cookie:tiktok.com or set TIKTOK_COOKIE')
    // this endpoint (unlike user-like) takes the cookie as an explicit query param.
    // ⚠️ unwrap PROVISIONAL — not curl-verified (needs a login cookie). Re-verify.
    const res = await this.get<TiktokResponse<{ itemList?: unknown[] }>>('/api/tiktok/web/fetch_user_collect', {
      cookie: this.tiktokCookie,
      secUid,
      cursor: Number(params.cursor ?? 0),
      count: Number(params.count ?? 30),
    })
    return Array.isArray(res.data?.itemList) ? res.data.itemList : []
  }

  // ------------------------------------------------------------------ follow (douyin)
  async follow(userId: string): Promise<void> {
    if (!userId) throw new Error('[douyin] userId required for follow')
    const r = await this.deps.withAwake(DOUYIN_SERVICE, () =>
      fetch(`${this.baseUrl}/douyin/follow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
        signal: AbortSignal.timeout(15000),
      })
    )
    if (!r.ok) throw new Error(`[douyin] follow failed: HTTP ${r.status}`)
  }

  async unfollow(userId: string): Promise<void> {
    if (!userId) throw new Error('[douyin] userId required for unfollow')
    const r = await this.deps.withAwake(DOUYIN_SERVICE, () =>
      fetch(`${this.baseUrl}/douyin/unfollow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
        signal: AbortSignal.timeout(15000),
      })
    )
    if (!r.ok) throw new Error(`[douyin] unfollow failed: HTTP ${r.status}`)
  }

  // ------------------------------------------------------------------ douyin helpers

  // ------------------------------------------------------------------ comments (enricher)
  /** 一条作品的一页评论（`douyin-comments` enricher 的唯一数据源）。信封 `data.{comments,total,cursor,has_more}`
   *  ——活体 2026-09-19 核过：`has_more` 是 `0/1` 数字不是布尔，`cursor` 是数字（首页回 30）。
   *  容器 4xx / 非 200 code 由 `get` 抛出，这里不吞：评论区拿不到就说拿不到，别回一页空的假装没人评论。 */
  async videoComments(awemeId: string, cursor: number): Promise<VideoCommentsPage> {
    const res = await this.get<DouyinResponse<{ comments?: RawDouyinComment[]; total?: number; cursor?: number; has_more?: number | boolean }>>(
      '/api/douyin/web/fetch_video_comments', { aweme_id: awemeId, cursor, count: 30 }
    )
    const d = res.data
    const comments = Array.isArray(d?.comments) ? d.comments : []
    return {
      comments,
      total: typeof d?.total === 'number' ? d.total : comments.length,
      cursor: typeof d?.cursor === 'number' ? d.cursor : cursor + comments.length,
      hasMore: !!d?.has_more,
    }
  }

  // ------------------------------------------------------------------ resolve members
  /** `douyin-resolve` / `tiktok-resolve`：`video-douyin` / `video-tiktok` Provider 行的唯一成员。
   *  入参是执行器摊开的 `{ vid, format }`（非 builtin 源的对象输入进 params），`vid` 是作品 id
   *  （抖音 `aweme_id` / TikTok 作品 `id`——它是派发键的后半截、进度键、DebugBox 的 key，所以用
   *  最短的稳定形状，不用带签名参数的分享链接）。按 id 拼一条主站链接交给容器的
   *  `/api/hybrid/video_data`——容器认这种最短形状。
   *
   *  `format`：`progressive` / `audio`（缺省）都给整片——抖音没有独立音轨，转写那条腿本来就先问
   *  audio 再退 progressive；`dash` 如实回 `[]`（播放器拿到 dash 的空结果自己回落 progressive）。
   *  `[]` = decline；作品被删 / 私密**抛** `ContentUnavailableError`，不吞成空。 */
  private async resolveMember(platform: MediaPlatform, params: Record<string, unknown>): Promise<VideoResolved[]> {
    const vid = String(params.vid ?? '')
    if (!vid) return []
    if (params.format === 'dash') return []
    const r = await this.resolveVideoPlayAddr(pageUrlOf(platform, vid), platform)
    return r ? [{ kind: 'progressive', url: r.url, headers: r.headers }] : []
  }

  // ------------------------------------------------------------------ http
  /**
   * 一条作品链接（主站 / 分享 / 短链）→ 整条作品数据（抖音 aweme / TikTok itemStruct）。
   * 贴链接抓媒体与解析成员都吃它，两家的形状差异归 `playAddrOf` / `fetchUrlFor` 管。
   *
   * **两家走两条路，这不是对称的**：
   * - **抖音 → 本包的 `douyin-detail` recipe**（用户自己的 Chrome，页面自己算签名）。容器那条路
   *   对详情已经死了：`/api/hybrid/video_data` 落在 `/aweme/v1/web/aweme/detail/` 上，站方把它挪
   *   到 Argus 签名头后面，站外打恒 403，而容器把 403 包成一句无信息量的
   *   `HTTP 400: An error occurred.`。完整证据链在 `douyin-detail.recipe.json` 的 `_why_recipe_at_all`。
   * - **TikTok → 照旧打容器**。那半没有被这道闸挡（同期实测），而且我们没有 TikTok 的采集会话。
   *
   * 容器那条路：非 200 / 信封非 200 由 `get` 抛；HTTP 200 却没有 `data` 也**抛**——「回了但是空的」
   * 和「回了一条作品」得分得开，调用方拿到 `{}` 只会静默产出一条没媒体的成功。
   */
  async hybridVideoData(url: string): Promise<Record<string, unknown>> {
    if (isDouyinUrl(url)) return readDouyinAweme(this.deps.readSource, url)
    const r = await this.get<{ data?: Record<string, unknown> }>('/api/hybrid/video_data', { url, minimal: 'false' })
    if (!r.data || typeof r.data !== 'object') {
      throw new Error('[Douyin_TikTok_Download_API] /api/hybrid/video_data 没有回 data（链接不是一条作品，或站方没给内容）')
    }
    return r.data
  }

  /** Resolve a share/video url to its direct CDN play address + the Referer the CDN gate demands.
   *  The play route range-proxies this url so the <video> streams + seeks. Returns null if
   *  unresolvable. Internal implementation behind `resolveMember`; the per-platform shape of the
   *  payload (aweme vs itemStruct) is `playAddrOf`'s business. */
  async resolveVideoPlayAddr(url: string, platform: MediaPlatform = 'douyin'): Promise<{ url: string; headers: Record<string, string> } | null> {
    // 作品被删 / 私密的那一档由 `hybridVideoData` 自己说清楚：抖音那条路上，recipe 在页内看到
    // 「站方回了 status_code 0 却没有 aweme_detail」就抛，`readDouyinAweme` 把它翻成
    // `ContentUnavailableError`（调用点据此回 404 而不是 502）。
    //
    // 这里以前还有一层兜底探针（拿 aweme_id 去打容器的 `fetch_one_video` 读站方的
    // `filter_detail.detail_msg`）——**已经删掉**：那个端点和 `aweme/detail` 是同一道 Argus 闸，
    // 今天对任何抖音作品都恒 403。留着它只会在每次失败时多唤醒一次容器、多等一个来回，然后
    // 照样答不出为什么，而代码读起来却像还有一条退路。
    const d = await this.hybridVideoData(url)
    return playAddrOf(platform, d)
  }

  private async get<T>(path: string, query: Record<string, string | number>): Promise<T> {
    // The failure signatures we must name precisely (else a red dot says only "fetch
    // failed" / "HTTP 4xx" / an empty list): (1) network — fetch() rejects, enriched with
    // its .cause at capture (see classifyError); (2) HTTP 4xx — expired/missing cookie is a
    // 401/403/422; (3) HTTP 200 with a non-200 envelope `code` — the upstream's own error
    // (risk-control / login required), which otherwise slips through as a silent empty feed.
    // withAwake：host 档睡着的容器先唤醒；URL（含 baseUrl getter）在回调里现拼，醒来才有值。
    const r = await this.deps.withAwake(DOUYIN_SERVICE, () => fetch(this.urlFor(path, query)))
    if (!r.ok) throw new Error(this.httpError(path, r.status, await r.text().catch(() => '')))
    const text = await r.text()
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error(`[Douyin_TikTok_Download_API] ${path} 上游返回非 JSON（疑似风控拦截或登录页）: ${text.slice(0, 200)}`)
    }
    const code = (json as { code?: unknown }).code
    if (typeof code === 'number' && code !== 200) {
      const msg = String((json as { message?: unknown }).message ?? (json as { detail?: unknown }).detail ?? '')
      const authy = code === 401 || code === 403 || /login|登录|cookie|risk|风控|verify/i.test(msg)
      const hint = authy ? '（登录态失效，请刷新 cookie）' : ''
      throw new Error(`[Douyin_TikTok_Download_API] ${path} 上游错误 code=${code}${hint}${msg ? `: ${msg}` : ''}`)
    }
    return json as T
  }

  private async getText(path: string, query: Record<string, string | number>): Promise<string> {
    const r = await this.deps.withAwake(DOUYIN_SERVICE, () => fetch(this.urlFor(path, query)))
    if (!r.ok) throw new Error(this.httpError(path, r.status, await r.text().catch(() => '')))
    return r.text()
  }

  private urlFor(path: string, query: Record<string, string | number>): string {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) if (v !== '') qs.set(k, String(v))
    return `${this.baseUrl}${path}?${qs.toString()}`
  }

  /** A non-2xx from the video-service. 401/403/422 almost always means the login cookie is
   *  missing or expired, so say so; otherwise include a body snippet for the real reason. */
  private httpError(path: string, status: number, body: string): string {
    const hint = status === 401 || status === 403 || status === 422
      ? '（登录态失效或缺少 cookie，请在浏览器里重新登录）' : ''
    const snippet = body ? `: ${body.slice(0, 200)}` : ''
    return `[Douyin_TikTok_Download_API] ${path} → HTTP ${status}${hint}${snippet}`
  }
}
