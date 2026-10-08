import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { randomUUID } from 'node:crypto'
import type { CookieHealth } from '../credentials/pushed-cookie-store.ts'
import { buildIdentity, type BuildIdentity } from './build-identity.ts'
import { registerResolveRoutes } from './resolve-routes.ts'
import { registerLinkRoutes } from './links-routes.ts'
import { registerNetdiskRoutes } from './netdisk-routes.ts'
import { registerSharingRoutes, type SharingDeps } from './sharing-routes.ts'
import { registerOnboardRoutes, type OnboardDeps } from './onboard-routes.ts'
import { registerConversionsRoutes } from './conversions-routes.ts'
import { refreshStreams } from '../channels/refresh.ts'
import { parseShareLink } from '../video/parse.ts'
import { isObjectNotFound } from '../netdisk/alist-client.ts'
import { unknownKey, unknownKeyMessage } from './strict-input.ts'
import { PICK_SURFACES } from '../manifest/types.ts'
import { isPickSurface } from '../manifest/pick.ts'
import { videoWorkCover } from '../video/work-cover.ts'
import { SYSTEM_COLLECTIONS, type CollectedItemKey } from '../collections/store.ts'
import { streamRecordToStream } from '../store/compat.ts'
import { isProviderMemberRef } from '../store/member-ref.ts'
import { applyCollectionPolicy as applyCollectionPolicyTo } from '../store/collection-policy.ts'
import { BUILTIN_STRATEGY_NAMES } from '../providers/strategies/index.ts'
import { coercePresent } from '../store/present.ts'
import { cors } from 'hono/cors'
import { stream } from 'hono/streaming'
import { isValidationError } from '../packages/activate.ts'
import { GATEWAY_PREFIX } from '../plugins/gateway.ts'
import { mergeCapabilityTools, mergePackageRuntime } from '../packages/inventory.ts'
import type { PluginStatus } from '../plugins/status.ts'
import { resolveFavicon } from '../adapters/favicon.ts'
import { enrich, type EnrichRequest } from '../content/enrich/index.ts'
import { RenormalizeNotFoundError, type RenormalizeFilter, type RenormalizeResult } from '../content/renormalize.ts'
import { mergePersonSpans, filterBlocksByDuration } from '../voiceprint/resolve.ts'
import { revertPersonNaming } from '../voiceprint/unname.ts'
import { probeStreams, extractStream } from '../media/extract.ts'
import { matchSiblingSubtitles, siblingToVtt, decodeSubtitleText } from '../media/sibling-subtitles.ts'
import { isLikelyDanmaku } from '../media/subtitle-lang.ts'
import { servingPolicyFor, serveWithPolicy } from '../media/serving.ts'
import {
  searchSubtitles,
  labelScrapeCandidates,
  decodeScrapeTrackId,
  fetchSubtitleBytes,
  SubtitleSourceGone,
  type RangeReader,
  type ScrapeCandidate,
} from '../media/subtitle-scrape.ts'
import { readCachedSubtitle, writeCachedSubtitle } from './subtitle-cache.ts'
import { errText } from '../err-text.ts'
import { diagnoseCapability } from '../browser/capability-store.ts'
import { extractNetdiskAudio } from '../netdisk/extract-audio.ts'
import { netdiskKeyFor } from '../transcribe/source.ts'
import { netdiskBackendOf, NETDISK_PLAY_SERVING } from '../netdisk/backend.ts'
import { progressOf } from '../netdisk/follow/plan.ts'
import { transcodeCandidatesFor } from '../netdisk/transcode-candidates.ts'
import {
  pickAudioContainer, pickAudioTrack, transcodeContainer, trackLabel, effectiveBitrate,
  type AudioContainer,
} from '../media/audio-route.ts'

/** 播放解析失败的响应：文件在网盘侧已被删/移（AList `object not found`）是终局 → 404 +
 *  精准中文 detail（播放器分类器只把 4xx 当终局、并把 detail 直接显示，见 ArtPlayer 的 classify）；
 *  其余（超时 / CDN / cookie 失效）是可重试的临时故障 → 沿用 502 unavailable，让播放器静默重试一次。 */
const NETDISK_GONE_DETAIL = '该视频文件已从网盘中删除或移动'
/** `onGone` 只在「文件确实没了」的终局分类上触发（后台自愈同步的钩子）——临时故障不触发，
 *  免得一次超时就去重列整个目录。 */
function netdiskPlayFailure(c: Context, e: unknown, onGone?: () => void) {
  if (isObjectNotFound(String((e as Error).message))) {
    onGone?.()
    return c.json({ error: 'netdisk_file_gone', detail: NETDISK_GONE_DETAIL }, 404)
  }
  return c.json({ error: 'unavailable' }, 502)
}
const NETDISK_VIDEO_EXT = /\.(mkv|mp4|ts|avi|mov|flv|wmv|m2ts|webm)$/i
/** 浏览器 `<video>` 能原生直放的容器（mp4/m4v/webm），此时优先原始直链、不必走转码 HLS。 */
const BROWSER_NATIVE_CONTAINER = /\.(mp4|m4v|webm)$/i
/** 文件名里出现这些编码 = 浏览器多半解不了（HEVC / AC3 系 / DTS / TrueHD）→ 仍走夸克转码流。 */
const NEEDS_TRANSCODE_CODEC = /(?:^|[.\s_-])(?:x265|h\.?265|hevc|ac-?3|e-?ac-?3|eac3|dts(?:-?hd)?|truehd|flac)(?:$|[.\s_-])/i
/** 文件名判浏览器能否原生播（无需转码）：容器友好且未标注不兼容编码。best-effort——判错只是回退到
 *  转码 HLS（有声）或原生无声，不比现状差；标注清楚的 h264/aac mp4 命中最常见的「白赚原生直链」路径。 */
function browserPlayableByName(file: string): boolean {
  return BROWSER_NATIVE_CONTAINER.test(file) && !NEEDS_TRANSCODE_CODEC.test(file)
}
/** 把夸克转码 m3u8 里的分片 URI 重写成经后端 seg 代理的同源地址。分片是相对 m3u8 自身 URL 的，且夸克
 *  OSS 对浏览器跨源直取会 412/被 CORS 挡（同 m3u8 本身），所以 .ts 也必须经后端带 cookie+referer 代理。
 *  段行直接替换；`#EXT-X-KEY/MAP/MEDIA` 等标签里的 `URI="…"` 一并重写。baseUrl = 该 m3u8 的真实上游 URL。 */
function rewriteHlsPlaylist(text: string, baseUrl: string, backend: string): string {
  const proxy = (uri: string) => {
    let abs: string
    try {
      abs = new URL(uri, baseUrl).href
    } catch {
      return uri
    }
    return `/api/media/netdisk-play?seg=${encodeURIComponent(abs)}&backend=${encodeURIComponent(backend)}`
  }
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim()
      if (!t) return line
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${proxy(u)}"`)
      return proxy(t)
    })
    .join('\n')
}
import { fetchUrl, makeResolveByLink, type FetchUrlDeps } from './fetch-url.ts'
import { toClientItem, sortKeyOf, encodeCursor, decodeCursor, isAfterCursor } from './client-item.ts'
import { attachStoryGroups } from '../story-fold/project.ts'
import type { StoryFoldStore } from '../story-fold/store.ts'
import { EXT_RELAY_PROTOCOL } from './ext-relay.ts'
import { extVerifyProof } from './ext-verify.ts'
import { authorizeAccess, peerAddress, isLoopbackAddress, isTrustedHost, isTrustedOrigin, lanUrls } from './access-guard.ts'
import { tokenEqual } from './secrets.ts'
import { callSitesOf, PROVIDER_DEFAULT_SOURCE, PLANNED_PROVIDERS } from '../providers/seed.ts'
import { identityOf } from '../providers/identities.ts'
import { identityServes } from '../providers/system/types.ts'
import { PROVIDER_CALLSITES } from '../providers/callsites.ts'
import { PRESENTS } from '../providers/presents.ts'
import { SlotBrokenError, type ProviderBindings, type SlotContext } from '../providers/bindings.ts'
import { isParked } from '../providers/parked.ts'
import type { CookieProvider } from '../credentials/cookie-provider.ts'
import type { FacilityAuthNeed } from '../auth/facility-auth-view.ts'
import type { StreamService } from '../mcp/tools.ts'
import { posterOf } from '../mcp/item-poster.ts'
import { publicSource, fallbackSource } from '../registry/public.ts'
import { brokenDependencies } from '../registry/affected-sources.ts'
import { existsSync, statSync, createReadStream, accessSync, constants as fsConstants } from 'node:fs'
import { Readable } from 'node:stream'
import { getImageNoReferer } from './image-fetch.ts'
import { extractTrackRef } from '../audio/index.ts'
import type { TrackRef } from '../audio/resolver.ts'
import { rsshubItemsToTracks } from '../audio/music-search.ts'
import { sourceOf, type InvokeResult } from '../providers/executor.ts'
import { buildResolveEntry } from '../providers/debug-entry.ts'
import { proxyRangedStream, type VideoResolved } from '../video/play.ts'
import { allStreamUrls, buildDashMpd, isAllowedSegHost, proxyUrl, rememberSegHosts, segHeadersFor } from '../video/dash.ts'
import { makeVideoResolver } from '../video/resolve-video.ts'
import { resolveTrackSource, type AudioResolveFacts } from '../audio/track-source.ts'
import { exportPlaylistM3u } from '../audio/playlist-export.ts'
import type { DebugEntry, DebugField } from './debug-log.ts'
import type { Item } from '../content/types.ts'
import { gateResolveOnlyMedia } from '../content/paid-playability.ts'
import { gateResolveOnlyVideoMedia } from '../content/video-playability.ts'
import type { ItemStore, StoredItem } from '../item-store.ts'
import type { StreamSeenStore } from '../stream-seen-store.ts'
import { canonicalSourceId } from '../streams/store.ts'
import { classifyAd, type AdRules } from '../content/ad-filter.ts'
import { includeFold } from '../content/title-filter.ts'
import { mergeAdRules } from '../content/ad-rules.default.ts'
import { streamItemToFields } from '../content/ad-fixtures.ts'
import type { SourceBinding, StreamRecord, ChannelRecord } from '../store/types.ts'
import { VIDEO_RANKING_STREAMS, DEFAULT_VIDEO_CHANNEL_ID, DEFAULT_SPACE_ID } from '../store/types.ts'
import type { SourceHealthStore } from '../source-health-store.ts'
import type { Registry } from '../registry/registry.ts'
import type { SourceManifest } from '../manifest/types.ts'
import type { FailureCategory } from '../failure.ts'
import type { VideoDetailService } from '../video/detail-service.ts'
import type { VideoDetail } from '../video/types.ts'
import type { MappingSet } from '../netdisk/types.ts'
import { tmdbWorkRef, opaqueWorkDirName, type TmdbWorkRef } from '../video/work-binding.ts'
import { buildSeasons } from '../video/season-tree.ts'
import { planBinding, landingDirFor } from '../netdisk/save-binding.ts'
import { videoDiscoveryFallback } from '../video/discovery-fallback.ts'
import type { VideoLookupIdentity, VideoReference, VideoWorkCandidate } from '../video/types.ts'
import { videoDetailPreview, videoWorkLookupIdentity, videoTmdbLookupIdentity } from '../video/item-identity.ts'
import { provisionConfigSlot } from '../credentials/provision-slot.ts'

export interface HealthInfo {
  /** 登录态快照：现在握着哪些 cookie 域（已归一）、上一次取回是什么时候。
   *  `domains: []` 是"还没取过"，不是故障——见 credentials/pushed-cookie-store.ts。 */
  cookies: CookieHealth
  manifests: number
  streams: number
  /** ISO time of the most recent successful harvest across all streams (tray recency tooltip).
   *  Absent when no stream has harvested yet — never emitted as null (keeps /api/health's
   *  liveness-probe contract additive-only for existing unauthenticated pollers). */
  last_harvest_at?: string
}

/**
 * HTTP 层的依赖袋——**存量键冻结，不再加新键**。
 *
 * 每加一个键要在三处同改（本接口 / bootstrap 装配 / serve.ts 显式接线），漏掉 serve.ts 那处的表现是
 * 端点 503，而单测注入 dep 照样全绿——静默、且随键数线性增长。
 *
 * 新增能力一律挂 `ctx.<域>`（带域前缀，见 `src/kernel/context.ts` 头注）由 serve 侧注入，不走这个袋子。
 * 存量键的搬迁随各域解体走，见 `docs/superpowers/specs/2026-08-16-cordis-phase2-quick-wins-design.md`。
 */
export interface HttpDeps {
  service: StreamService
  itemStore: ItemStore
  /** 同质内容归堆的账本（`src/story-fold/`）。缺席 → item 不带 `storyGroup`、
   *  拆堆与领先榜路由不挂（列表本身完全不受影响，这是个纯附加能力）。 */
  storyFold?: StoryFoldStore
  /** 配置分享（stream-bundle）导出/导入/台账；absent → 分享路由不挂（如最小测试装配）。 */
  sharing?: SharingDeps
  /** 「想接还接不了」清单。缺省 = 不挂这两个端点（进程内测试）。 */
  onboard?: OnboardDeps
  /** Provider-enriched video detail cache and refresh service. */
  videoDetails?: VideoDetailService
  /** TMDb 分集索引取法（投影后 LeftEntry[]，含分集剧照 still + 播出日期 airDate）——详情页剧集分季分集懒加载时调，仅 media='tv'。 */
  episodeIndex?: (ref: { id: string; media: 'movie' | 'tv'; title: string }) => Promise<Array<{ leftKey: string; title: string; still?: string; airDate?: string }>>
  /** per-stream read watermark (unread / new-episode counts). Absent → newCount projection
   *  is omitted and POST …/seen returns 503. */
  seenStore?: StreamSeenStore
  health: () => Promise<HealthInfo>
  /** Sync, read-only, no-I/O accessor for the tray recency tooltip's last_harvest_at (task 2.3).
   *  Deliberately separate from `health()`: that closure is async and reads the cookie snapshot —
   *  /api/health is an unauthenticated liveness probe and must never fail or block on anything
   *  unrelated to liveness. Absent/throwing → field omitted, never surfaced as a 500. */
  lastHarvestAt?: () => string | undefined
  /** read a facility's live page (in-page eval / screenshot) — the only way to SEE what a harvest
   *  is actually looking at: opening the same URL yourself gives a different page, not the one
   *  mid-run with its scroll position, ledger and login state.
   *  Resolves to null when that facility has no live tab. */
  pageLook?: (facility: string, expression: string) => Promise<{ value: unknown } | null>
  /** 使用者显式收尾一个 facility（前端离开该频道）——关掉它名下所有标签。 */
  closeFacilityTabs?: (facility: string) => Promise<void>
  pageShot?: (facility: string) => Promise<string | null>
  /** normalize ONE raw content-search item via its producing source's manifest — injected from
   *  Scheduler.normalizeRaw so scope=content reproduces ingest normalization (per-item, per-scope
   *  at the call site). Absent → content items returned raw (degraded, e.g. minimal test harness). */
  normalizeSearchItem?: (sourceId: string, raw: unknown) => StoredItem
  /** 存量 content 重算（maintenance）：拿 item.raw 用当前 manifest 重跑 normalize 覆盖
   *  content。查无 scope 抛 RenormalizeNotFoundError（路由映射 404）。absent → 503。 */
  renormalizeItems?: (filter: RenormalizeFilter) => RenormalizeResult
  /** npm recipe 包安装(preview→install 两步;confirm=tarball integrity,preview 发放)。absent → 503。 */
  /**
   * 跑一条动作 recipe（`POST /api/recipes/action`）。**必须是 MCP 那侧用的同一个闭包**
   * （serve.ts 直接递 `mcpExtras.runActionRecipe`）——两条路各自装配一份 deps 就会各自长出
   * 一套行为，而这条路上挂着凭据注入、限速、冷却和两步确认。缺席 = 这条路由不挂（503）。
   */
  runAction?: (args: { sourceId: string; params?: Record<string, unknown>; confirmed?: boolean }) => Promise<unknown>
  /**
   * 读一条动作 run（`GET /api/recipes/action/:runId`）——`runAction` 回 `{status:'running', runId}`
   * 之后脚本靠它等结果（MCP 那侧对应 `get_agent_run`，投影同一份 `projectActionRun`）。
   * 不是 action 档的 runId / 不存在 → null（路由映射 404）。缺席 = 不挂（503）。
   */
  actionRun?: (runId: string) => unknown | null
  recipePackageOps?: {
    preview: (name: string, version?: string) => Promise<unknown>
    install: (name: string, version: string | undefined, confirm: string) => Promise<unknown>
    uninstall: (name: string) => Promise<boolean>
    updates: () => Promise<unknown>
    /** 按关键词搜 recipe 包。窄接口：只收一个查询词,registry 地址与 stream-recipe 关键词
     *  限定都由服务端固定(见 recipe-registry.ts 的 search)。 */
    search: (q: string) => Promise<unknown>
    /** 已装 recipe 包清单(市场页「已装」区用) */
    listInstalled: () => Promise<unknown>
  }
  /** aggregated video/torrent keyword search across RSSHub film/anime sources, not
   *  persisted. Returns the faceted VideoSearchResult { shows, loose, sources }. */
  videoSearch?: (q: string, opts?: { nsfw?: boolean }) => Promise<unknown>
  /** streaming video search — async generator of NDJSON events (init/source/done) */
  videoSearchStream?: (q: string, opts?: { nsfw?: boolean; providerId?: string }) => AsyncGenerator<unknown>
  /** Plan A: turn raw resource-search items (executor fan-out, per-item provenance) into the
   *  faceted {shows,loose,sources} shape — reuses src/video/* via Scheduler-scope closure. */
  facetResources?: (q: string, items: unknown[], misses: Array<{ member: string; reason: string }>, providerId?: string) => unknown
  /** 包交出来的富化处理器（`activate()` 的 `enrichers`）。`/api/enrich` 先查它，再落宿主自己的分支。 */
  packageEnrichers?: ReadonlyMap<string, import('../packages/activate.ts').Enricher>
  /** 包交出来的一键订阅（键 = 域名）。`POST /api/credentials/:domain/connect` 先查它。 */
  packageConnect?: ReadonlyMap<string, import('../packages/activate.ts').ConnectFn>
  /** 按域取 Cookie header。**只给宿主自己用**（媒体代理要带着用户登录态去取流）——
   *  没有任何一条路把它暴露给包：调度方永远是宿主，包不向宿主要凭证。 */
  credentialProvider?: Pick<CookieProvider, 'cookieString'>
  /**
   * `/api/*` 的门，两道判据（都在 access-guard.ts）：
   * 1. 浏览器维度 —— Origin/Host 白名单，挡住"本机上的任意网页 fetch 127.0.0.1"与 DNS rebinding；
   * 2. 来源维度 —— 本机 loopback 免密，其余必须出示 token。
   * 不注入 = 不设门（进程内测试的默认形态）；serve.ts 永远注入。
   */
  accessGuard?: {
    token: string
    extId?: string
    trustedHosts?: string[]
    /** **别的口上的页面**要打 `/api/*` 时登记的 origin 白名单（精确串匹配，见 access-guard.ts
     *  `isTrustedOrigin`）。今天的用途是用户自己 DSH 里装了 Stream UI 插件的那张页。
     *  别的什么都不放宽。 */
    trustedOrigins?: string[]
  }
  /** 后端自证身份用的那把 secret（`POST /api/ext/verify` 拿它签 proof）。**不外发**。
   *  Origin 门控；extId 固定后强校验单一扩展来源。 */
  extRelayAuth?: { token: string; extId?: string }
  /** **没有路由消费它，serve.ts 也不接线——这一格只为看门狗存在。**
   *  `src/http/app.ext-cookies.test.ts` 塞一个假的进来，断言已撤销的 `POST /api/ext/cookies`
   *  不但 404、而且没有偷偷往里写。删掉它就把那条断言的后半截拆了。 */
  pushedCookies?: { replace: (cookies: Record<string, import('../types.ts').BrowserCookie[]>) => void }
  /** ext-relay 的只读连接快照（`GET /api/ext/relay-status`）：扩展现在连着吗、从什么时候起。
   *  absent → 端点 404（后端根本没接 relay，别伪装成"扩展没连"）。 */
  extRelayStatus?: () => { connected: boolean; since: string | null }
  /** 后端此刻真正骑着的浏览器标签 id（`GET /api/ext/claimed-tabs`）。扩展拿它对账、
   *  回收后端重启后留在用户 Chrome 里的孤儿采集标签。 */
  claimedTabs?: () => number[]
  /** 浏览器采集能力的**快判**（`GET /api/browser-capability`）：relay 现状 + 落盘的 everSeen 缓存。
   *  纯读，**不探测、不等待、不唤醒**，永远秒回。全量诊断是另一个端点（见 harvestBrowser）。
   *  absent → 端点 404（同 relay-status：后端没接 relay 就别伪装成"扩展没连"）。 */
  browserCapability?: () => import('../browser/capability-store.ts').BrowserCapabilitySnapshot
  /** 扩展安装引导的三个动作（`POST /api/extension/{materialize,install,decline}`）。
   *  absent → 三个端点 404。**别伪装成"装不了"**：后端根本没接这条能力，和"试过了没成功"
   *  是两回事，前者要去看接线，后者要去看 Chrome。 */
  extensionOnboarding?: {
    /** 用户的引导态（`GET /api/extension/onboarding`）：拒绝过没有。**首启横幅的挂载条件
     *  是「never-seen 且没拒绝过」，而 `browser-capability` 只回答前半句**——后半句存在
     *  settings 里，得有一口读得到它，否则拒绝了也照样天天弹。 */
    state(): { declinedAt?: string }
    materialize(): { dir: string; source: string }
    install(): Promise<import('../browser/extension-install.ts').InstallOutcome>
    /** 反向那一趟（`POST /api/extension/uninstall`）：把扩展从用户的 Chrome 里移除。
     *  和 install 一样会**动用户的桌面**，所以同在门之后。 */
    uninstall(): Promise<import('../browser/extension-uninstall.ts').UninstallOutcome>
    /** 重载（`POST /api/extension/reload`）：在扩展详情页点「重新加载」，全程走 Stream Desktop、
     *  不经中继——扩展断连时它是唯一够得着扩展的路。同样动用户的桌面，所以同在门之后。 */
    reload(): Promise<import('../browser/extension-reload.ts').ReloadOutcome>
    /** 读扩展后台控制台（`POST /api/extension/console`）：扩展连不上时它往 debug bus 写日志的路也断了，
     *  这是唯一还在的现场。同样全程走 Stream Desktop、动用户的桌面，所以同在门之后。 */
    readConsole(): Promise<import('../browser/extension-console.ts').ConsoleOutcome>
    decline(): void
  }
  /** 「采集用哪个 Chrome」：列候选 / 选一个。全量诊断（POST /api/browser-capability/diagnose）
   *  和设置页（/api/settings/harvest-browser）共用它——**发现要摸文件系统，所以永远不进快判**。 */
  harvestBrowser?: {
    status(): Promise<import('../browser/harvest-browser.ts').HarvestBrowserStatus>
    select(exe: string): Promise<import('../browser/harvest-browser.ts').HarvestBrowserStatus>
  }
  /** called when an item is labeled 非广告 (false positive) — captures it as a
   *  negative ad-fixture. Injected so the route stays free of filesystem coupling. */
  recordNegative?: (item: StoredItem) => void
  /** voiceprint speaker registry (enroll/identify); absent → feature unavailable. */
  speakerRegistry?: import('../voiceprint/store.ts').SpeakerRegistryStore
  /** 统一的转换资源（OCR/转写/补说话人/摘要）。挂 /api/conversions 与 /api/conversion-kinds，
   *  声纹那几条路由也从它读写转写 segments。absent → 这些端点不注册（后端没配转换能力）。 */
  conversions?: import('../conversions/runner.ts').ConversionRunner
  /** read-only plugin status (configured / health) for the status panel. */
  pluginStatus?: () => Promise<unknown[]>
  /**
   * 填了能力槽位（`stream.capability`）的包此刻各自注册了哪些工具，按**包 id** 索引。
   *
   * **只有一个消费者：`/api/packages`**（用户看的那一页：两层全部的包）。`/api/plugins`
   * **刻意没有这一格**——它只列 `service.plugins()`（内置插件包），而可选能力包住
   * `<dataDir>/recipes/`，那条路上这一格恒为空数组，是死数据。
   *
   * **thunk**：能力包在启动的另一个时刻才挂上（可选包动态 import），装配期取一次那一列会
   * 永远是空的，而工具在 `/api/mcp` 里好好地活着——两边都不报错。
   * absent → 每个包都是空数组（后端没接这条能力，不是"这个包没工具"）。
   */
  capabilityTools?: () => Record<string, string[]>
  /** 「这台机器上装了什么」——两层（内置 + 用户）全部 Stream 包 + 各自填了哪几格槽位。
   *  `GET /api/packages` 的数据源；运行时状态由本文件那条路由用 `pluginStatus` 补上。
   *  absent → 该端点 503（空数组等于说"你什么都没装"）。 */
  packageInventory?: () => import('../packages/inventory.ts').PackageSummary[]
  /** 待生效清单（启动快照 vs 盘上现扫，见 packages/pending.ts）——每次调用现算，路由不缓存。
   *  三处露面：`GET /api/packages/pending`、`/api/packages` 每项的 `pending`、`/api/health.pending_restart`。
   *  absent = 这台后端没开包目录 → 端点 503、health 不出那一格。 */
  packagePending?: () => import('../packages/pending.ts').PendingChange[]
  /** 「包」页对一个容器能做的两件事：看日志 / 重启。absent → 那两个端点 503。
   *  三种失败（没容器 / docker 够不着 / 没授权替你建）由这一层分开，路由只做状态码映射。 */
  containerOps?: import('../packages/container-ops.ts').ContainerOps
  /** 重启后端（`POST /api/restart`）：`running` 报此刻真在跑的任务（闸门的判据，读 sidequest 账本），
   *  `trigger` 先把「按谁拉起我」判出的 mode 交出去、下一拍才开始优雅关（policy 在 `src/restart/policy.ts`）。
   *  absent → 该端点 503。 */
  restart?: {
    running: () => Promise<{ id: string; label: string }[]>
    trigger: () => Promise<import('../restart/policy.ts').RestartMode>
  }
  /** Provider 成员的 key 配置状态,给 providerView 的 resolvedMembers 拼字段用。参数是成员的
   *  source id **和它自己的 params**;返回 null 表示这个源的 manifest 根本没声明 secret（不该带
   *  keyState 字段）,否则返回 TokenProvider.layer() 报的层、层为空时映射成 'missing'（缺 key 仍要
   *  可见,不能悄悄伪装成健康）。只报层不报值。absent → 所有成员都不带 keyState 字段。
   *  为什么要 params：`perInstance` 源（llm-openai）的 key 存在成员自己的 `params.tokenName` 那一层,
   *  不在 manifest 的 `runtime_config.ref` 上——只给 sourceId 的话每个实例都读同一个（且恒 missing 的）
   *  层。见 credentials/key-state.ts。 */
  keyState?: (sourceId: string, memberParams?: Record<string, unknown>) => 'stored' | 'env' | 'missing' | null
  /** flip a plugin's enable flag (persist + live catalog); throws for required/unknown plugins. */
  setPluginEnabled?: (id: string, enabled: boolean) => unknown
  /** 网盘底座（内置托管，没有可写的配置）——只读状态（token 永不回显）和一条活探测。 */
  alist?: {
    status: () => { hasToken: boolean }
    test: () => Promise<{ ok: boolean; error?: string }>
    /** OpenList 的**永久** token（`x_setting_items.token`）；没铸出来时 undefined。见 `AlistFacet.permanentToken`。 */
    permanentToken: () => Promise<string | undefined>
  }
  /**
   * 扩展该读哪些域的 cookie（`GET /api/ext/sync-config`）。
   *
   * `requiredDomains` = 这台 Stream 装着的东西声明要哪些 cookie 域（见 bootstrap 的
   * requiredCookieDomainsNow）；扩展拿它决定去读浏览器里哪些域，与用户自填的取并集。
   * **漏接这一格 = 扩展只按自填清单同步**，而少一个域的表现和"用户没登录"一模一样。
   */
  extSyncConfig?: () => { requiredDomains: string[] }
  /** 摘要 prompt（settings 里唯一还归 LLM 的可写字段）+ 梯子就绪状态。连接与模型的配置面
   *  在 Providers 页：连接 = `llm` 行的成员实例，模型 = 调用点绑定的 params.model。 */
  summaryPrompt?: {
    status: () => import('../settings-store.ts').SummaryPromptStatus
    set: (prompt: string) => Promise<import('../settings-store.ts').SummaryPromptStatus>
  }
  /** API credentials for TMDb/OMDb builtin Sources. Keys are write-only. */
  videoSources?: {
    status: () => { hasTmdbApiKey: boolean; hasOmdbApiKey: boolean; language: string }
    set: (next: import('../settings-store.ts').VideoSourceSettings) => Promise<{ hasTmdbApiKey: boolean; hasOmdbApiKey: boolean; language: string }>
  }
  /** Manifest-declared runtime configuration; status never contains secret values. */
  /** 源 runtime_config 的读写——配置 row 引擎的 source family 转发（密文判定归 schema，
   *  不再显式传 secretKeys）。status 形状是 ConfigRowStatus 的超集兼容（多一格 schema）。 */
  sourceRuntimeConfig?: {
    status: (ref: string) => unknown
    set: (ref: string, values: Record<string, unknown>) => Promise<void>
    /** 「这一格有谁能替我申请」——Source 域的反查索引（`configProvisionerFor`）。 */
    provisioner?: (ref: string) => import('../kernel/plugins/sources.ts').ConfigProvisioner | null
    /** 真去跑那条 recipe（第一方 UI 触发，`userInitiated: true`）。 */
    provision?: (ref: string, params: Record<string, unknown>) => Promise<void>
    /** 这个 ref 的哪几格由部署环境变量兜得住（只回字段名）。面板的必填判据要认它，否则只靠
     *  环境变量配好的用户存不了盘。 */
    envCovered?: (ref: string) => string[]
  }
  /** adapter map for routing platform write actions (follow/unfollow) */
  adapters?: Map<string, import('../adapters/types.js').Adapter>
  /** offline audio archive (歌单 downloads); absent → download endpoints 503 */
  audioArchive?: import('../audio/archive.ts').AudioArchive
  downloadQueue?: import('../audio/queue.ts').DownloadQueue
  /** 统一收藏——video「正在追」+ audio「我的喜欢」两个系统列表 + 用户自建列表，见 collections/store.ts
   *  头注。未配置时 /api/channels 的 video newCount 富集整段跳过（回到"无收藏概念"，而非误报全员在追）。 */
  collections?: import('../collections/store.ts').CollectionsStore
  /** server-side video watch progress(「继续观看」)：上报/续播/移除。未配置时四个端点全 503。 */
  watchProgress?: import('../watch-progress-store.ts').WatchProgressStore
  /** target-resolve surface (intent/resolve/subscriptions/sources); additive */
  resolve?: import('./resolve-routes.ts').ResolveDeps
  /** 网盘直链后备（AList 对齐层）；未配置时 undefined，播放路由跳过 */
  netdisk?: import('../netdisk/sync.ts').NetdiskService
  /** 抽取出来的字幕落盘缓存目录（10 天 TTL，见 subtitle-cache.ts）；未配置 → 字幕提取端点 503。 */
  subtitleCacheDir?: string
  /** 网盘绑定管理面（CRUD/同步/重绑/修正/目录浏览）；未配置时不挂载 */
  netdiskRoutes?: import('./netdisk-routes.ts').NetdiskDeps
  /** named channel groups — read-layer navigation over streams.d */
  channelStore?: import('../store/user-store.ts').UserStore
  /** 「流—频道」关系 / 频道 present / 流成员表被改动了。装配层用它重建 research present 的
   *  fs-watcher 集合（见 live/research-watchers.ts）。**回调不是事件**：目前只有一个消费者，
   *  为它立一套频道变更事件是过度设计。缺席（最小测试装配）→ 只是没有实时推送，不影响写入本身。 */
  onChannelsChanged?: () => void
  /** built-in defaults ⊕ config.yaml global ad_filter — the baseline the per-stream
   *  ad-filter reclassify endpoint merges a stream's own ad_filter on top of. */
  baseAdRules?: import('../content/ad-filter.ts').AdRules
  /** Provider 模型运行时（invoke 执行器 + 调用计数）；行存储走 channelStore */
  providers?: {
    executor: import('../providers/executor.ts').ProviderExecutor
    stats: import('../providers/stats-store.ts').ProviderStatsStore
  }
  /** `GET /api/download-options` 的脑子（ProviderService.resolveDownloads，与 MCP video_resolve 共用
   *  同一条 download-resolve decline-chain）。缺席 → 503。 */
  resolveDownloads?: import('../kernel/plugins/provider.ts').ProviderService['resolveDownloads']
  /** User-configurable edge from code callsites to Provider implementations. */
  providerBindings?: ProviderBindings
  /** 网盘分享验活/转存（netdisk.share.* 调用点）。独立于 netdiskRoutes——那套被 AList token
   *  门控，而分享能力只要有网盘登录态就能用，不该被没配 AList 连累。 */
  netdiskShare?: import('../netdisk/share-capability.ts').NetdiskShareCapability
  netdiskPlay?: import('../netdisk/play-capability.ts').NetdiskPlayCapability
  /** shared debug bus: record() stores an entry in the ring AND broadcasts it over the WS;
   *  recent() reads the ring for GET /api/debug/log. Shared (created in serve.ts) so every
   *  producer — this app's routes and the download queue — lands in the same log. */
  debug?: {
    record: (entry: DebugEntry) => void
    recent: (opts: { channel?: string; key?: string; limit?: number }) => DebugEntry[]
    clear: () => void
  }
  /** Task-boundary attribution (op-track): wraps every request as `http:<METHOD> <path>` so
   *  loop-lag stall reports can name the request overlapping the stall window. Wired in serve.ts
   *  (NOT bootstrap — the tracker lives beside the debug bus); absent (tests) → no middleware. */
  track?: <T>(name: string, fn: () => Promise<T>) => Promise<T>
  /** live needs-login projection over source health (facilities showing an auth wall now).
   *  Wired in bootstrap from buildAuthFacilities(snapshot); absent → route not mounted. */
  authFacilities?: () => FacilityAuthNeed[]
  /** 回答「谁需要登录」之前先对一次账（缺席 = 直接答缓存的投影）。 */
  reconcileAuth?: () => Promise<void>
  /** 把某 facility 的登录标签放到用户面前（平台加了我们渲染不了的验证步骤时的兜底出口）。 */
  focusLoginTab?: (facility: string) => Promise<boolean>
  /** 意图跟踪服务；absent → /api/intents* 全部 503（如最小测试装配）。 */
  intents?: import('../intent/service.ts').IntentService
  /** 事件层（通知中心）：日志读取 + 已读回写。absent → 事件路由不挂（最小测试装配）。 */
  events?: {
    list: (opts?: { since?: number; types?: string[] }) => unknown[]
    markRead: (sel: { ids?: number[]; all?: boolean }) => void
    /** §5.1 双通道之一(Bell):槽位失效上报走这一个口子,和 bootstrap 里其余 events.emit 调用同一份 EventsService。
     *  可选——只在最小测试装配(如 app.test.ts 的裸 events 桩)没接 emit 时,槽位失效仍能 422 只是不进 Bell。 */
    emit?: (input: { type: string; severity: 'info' | 'warn' | 'error'; title: string; body?: string; dedupeKey?: string }) => unknown
  }
}

type ErrorCode = 'validation_error' | 'not_found' | 'conflict' | 'unavailable' | 'upstream_error' | 'slot_broken' | 'name_shadows_source' | 'unauthorized' | 'internal'

function errorBody(code: ErrorCode, message: string): { error: { code: ErrorCode; message: string } } {
  return { error: { code, message } }
}

/** `surface=` 拼错了就 400，别当成"没传"去发一份更宽的列表——那正是「写错的键被静默丢弃」
 *  的同一种失败，只不过发生在值上（见 `docs/API.md` §2）。 */
function badSurface(c: Context, given: string) {
  return c.json(
    errorBody('validation_error', `不认识的 surface '${given}'——这个接口接受的：${PICK_SURFACES.join(', ')}（不传 = 两个面的并集）`),
    400,
  )
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 实例名的字符集（`<namespace>:<实例名>` 的后半段）。 */
const INSTANCE_NAME = /^[\w-]+$/

/** 这次读写落到哪个 runtime_config ref：普通源恒是 manifest 的 `ref`（且不许调用方指定，
 *  否则任何源都成了任意写入口）；`perInstance` 源必须显式给出实例 ref（不给就会把某个实例的
 *  key 写进全源共享那一层——正是要修掉的那个假象）。
 *  两种拒绝的原因完全不同（"这个源不接受 ref" vs "这个 ref 不合法"），所以各自带自己的文案——
 *  一句话两用会让调用方拿着正确的 ref 去查一个根本不存在的格式问题。 */
function effectiveConfigRef(
  rc: { ref: string; perInstance?: boolean; instanceNamespace?: string },
  ref: string | undefined,
): { ref: string } | { error: string } {
  if (!rc.perInstance) {
    return ref === undefined ? { ref: rc.ref } : { error: 'this source does not accept a ref (its config is shared, not per-instance)' }
  }
  // 命名空间由**源自己声明**（manifest 的 runtime_config.instanceNamespace，loader 强制 perInstance
  // 必带）。这个端点收的是调用方给的字符串：不按源限定前缀，它就等于"任意 ref 写入"，一个源能
  // 改掉别的源（乃至 alist/tmdb）的 key。放宽正则会重新打开那个口子，所以是按源查、不是加一档。
  const ns = rc.instanceNamespace
  if (!ns) return { error: 'this source is per-instance but declares no instanceNamespace (manifest bug)' }
  const [got, ...rest] = typeof ref === 'string' ? ref.split(':') : []
  const instance = rest.join(':')
  if (typeof ref !== 'string' || got !== ns || rest.length !== 1 || !INSTANCE_NAME.test(instance)) {
    return { error: `invalid instance ref (expected \`${ns}:<instance>\`)` }
  }
  return { ref }
}

function stringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0)
}

function validateSourceBinding(v: unknown): v is SourceBinding {
  return isObject(v) && typeof v.plugin === 'string' && v.plugin.length > 0
    && typeof v.source === 'string' && v.source.length > 0
    && isObject(v.params)
}

function channelValidationError(body: unknown, partial = false): string | null {
  if (!isObject(body)) return 'body must be an object'
  if (partial && body.id !== undefined) return 'id cannot be changed'
  if (!partial && body.id !== undefined && typeof body.id !== 'string') return 'id must be a string'
  if (!partial || body.label !== undefined) {
    if (typeof body.label !== 'string') return 'label must be a string'
  }
  if (!partial || body.present !== undefined || body.variant !== undefined) {
    const raw = (body.present ?? body.variant) as unknown
    if (coercePresent(raw) === undefined) {
      return 'present must be timeline | search | audio | video | research | embed'
    }
  }
  if (!partial || body.stream_ids !== undefined) {
    if (!stringArray(body.stream_ids)) return 'stream_ids must be a string array'
  }
  if (!partial || body.options !== undefined) {
    if (!isObject(body.options)) return 'options must be an object'
  }
  // 建频道时不给 space_id = 落默认空间，所以它**只在显式给了**的时候校验（partial 与否都一样）。
  if (body.space_id !== undefined && typeof body.space_id !== 'string') return 'space_id must be a string'
  return null
}

/** 空间的形状校验。`position` 收数字（侧栏次序），不收字符串——排序按数值比，
 *  收了字符串就会变成字典序，"10" 排在 "9" 前面。 */
function spaceValidationError(body: unknown, partial = false): string | null {
  if (!isObject(body)) return 'body must be an object'
  if (partial && body.id !== undefined) return 'id cannot be changed'
  if (!partial && body.id !== undefined && typeof body.id !== 'string') return 'id must be a string'
  if (!partial || body.label !== undefined) {
    if (typeof body.label !== 'string' || body.label.trim() === '') return 'label must be a non-empty string'
  }
  if (body.position !== undefined && !Number.isFinite(body.position)) return 'position must be a number'
  return null
}

/** `options.url`（embed 外接面板的那一个 URL）：给了就必须是能解析的 http(s) 绝对地址。
 *  只验形状不验可达——可达是运行时的事，iframe 自己会说；这里拦的是把 `javascript:`、相对路径
 *  或一段文字存进去，然后面板里画出一张永远空白的 iframe。不看 present：别的 present 写了
 *  `options.url` 也没有别的含义，同一条规则更省一个分支。 */
function channelEmbedUrlError(options: unknown): string | null {
  if (!isObject(options) || options.url === undefined) return null
  if (typeof options.url !== 'string') return 'options.url must be a string'
  let parsed: URL
  try { parsed = new URL(options.url) } catch { return 'options.url must be an absolute http(s) URL' }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'options.url must be an absolute http(s) URL'
  return null
}

/** channel options.slots 逐键校验:callsite 存在 + providerIds 通过 ProviderBindings 的既有校验规则
 *  (validateSelection,与全局 binding 同一套约束,不另立规则)+ §5.1 写路径预防:拒绝 parked 行
 *  (只对槽位写入生效——全局 binding 的 put()/validateSelection 共用规则不动,parked 检查只在这加)。
 *  options.slots 不存在 → 不校验(null)。 */
function channelSlotsError(options: unknown, bindings: ProviderBindings | undefined, channelStore: Pick<import('../store/user-store.ts').UserStore, 'getProvider'> | undefined): string | null {
  if (!isObject(options) || options.slots === undefined) return null
  if (!isObject(options.slots)) return 'options.slots must be an object'
  if (!bindings) return 'providers not configured'
  for (const [callsiteId, ids] of Object.entries(options.slots)) {
    if (!stringArray(ids)) return `slots.${callsiteId} must be a string array`
    try { bindings.validateSelection(callsiteId, ids as string[]) } catch (e) { return `slots.${callsiteId}: ${(e as Error).message}` }
    const parked = channelStore ? (ids as string[]).filter((id) => isParked(channelStore.getProvider(id)!)) : []
    if (parked.length > 0) return `slots.${callsiteId}: parked provider(s) cannot be assigned to a slot: ${parked.join(',')}`
  }
  return null
}

function nextChannelId(): string {
  return `channel-${randomUUID()}`
}

function nextSpaceId(): string {
  return `space-${randomUUID()}`
}

/** 指过去的空间必须存在。**必须在写之前拦**：写进去一个不存在的空间 id，那个频道在侧栏里
 *  哪个空间下都不出现——一次静默的消失，用户只会觉得"频道没建成"。 */
function spaceRefError(store: { getSpace(id: string): unknown }, spaceId: unknown): string | null {
  if (spaceId === undefined) return null
  if (typeof spaceId !== 'string') return 'space_id must be a string'
  return store.getSpace(spaceId) ? null : `space not found: ${spaceId}`
}

/** `PATCH /api/streams/:id` 认识的字段。**加字段就要加这里**，否则新字段会被当成写错的名字挡掉
 *  （响亮地 400，不会静默生效——这正是要的方向）。与 `streamValidationError` 逐项同源。 */
const STREAM_PATCH_KEYS = ['label', 'strategy', 'cadence_seconds', 'members', 'contract', 'options'] as const

/** `GET /api/items` 认识的查询参数。前端只发这三个（`app/src/lib/api.ts` 的 `itemsQuery`）。 */
const ITEMS_QUERY_KEYS = ['stream', 'limit', 'order'] as const
const ITEM_REFS_QUERY_KEYS = ['ids'] as const
/** 一次问多少条封面。对话里一条消息通常只引 1–2 条，几十条已经远超实际；给上限是因为
 *  这条路由按 id 直查，不设限就等于开放一次任意长度的批量读。 */
const ITEM_REFS_MAX = 50

/** `GET /api/download-options` 认识的查询参数（channelId = 频道槽位上下文，见 API.md）。 */
const DOWNLOAD_OPTIONS_QUERY_KEYS = ['url', 'channelId'] as const

// —— 以下每份名单 = 对应 handler **实际读的那几个键**（docs/API.md §2）。加字段就要加进来。

/** `POST /api/streams` 认识的字段 = PATCH 那份 + `id`（建的时候才给得出身份）
 *  + `channel_id`（建的时候才给得出**归属**——见 handler 里那段注释；PATCH 没有它，
 *  改归属是 `PATCH /api/channels/:id` 的事）。 */
const STREAM_CREATE_KEYS = ['id', 'channel_id', ...STREAM_PATCH_KEYS] as const
/** `PATCH /api/channels/:id` 认识的字段。`variant` 是 `present` 的旧写别名，两个都还收。
 *  `id` 故意不在名单里——它由 `channelValidationError` 用一句更准的「id cannot be changed」挡下。 */
const CHANNEL_PATCH_KEYS = ['label', 'present', 'variant', 'stream_ids', 'options', 'space_id'] as const
/** `POST /api/spaces` / `PATCH /api/spaces/:id` 认识的字段。`id` 只在建的时候给得出。 */
const SPACE_PATCH_KEYS = ['label', 'position'] as const
const SPACE_CREATE_KEYS = ['id', ...SPACE_PATCH_KEYS] as const
/** `POST /api/channels` 认识的字段。 */
const CHANNEL_CREATE_KEYS = ['id', ...CHANNEL_PATCH_KEYS] as const
/** `PATCH …/streams/:streamId/ad-filter` 认识的字段（= `AdRules`）。 */
const AD_FILTER_KEYS = ['keywords', 'domains'] as const
/** `PATCH …/streams/:streamId/title-filter` 认识的字段。 */
const TITLE_FILTER_KEYS = ['keywords'] as const
/** `POST /api/netdisk/share/verify` 认识的字段（link 或 netdisk+pwd_id 二选一）。 */
const SHARE_VERIFY_KEYS = ['link', 'netdisk', 'pwd_id', 'passcode'] as const
/** `POST /api/netdisk/share/save` 认识的字段。 */
const SHARE_SAVE_KEYS = [...SHARE_VERIFY_KEYS, 'dest', 'subdir', 'bind'] as const

// —— 以下是同一张网铺到 app.ts 其余写入面的那一批。每份名单照旧 = 对应 handler **实际读的
//    那几个键**，多一个会把正常调用挡在门外、少一个会留下一处静默丢弃。

/** `POST /api/ext/verify` 认识的字段。 */
const EXT_VERIFY_KEYS = ['nonce'] as const
/** `POST /api/ext/debug-log` 认识的字段。 */
const EXT_DEBUG_LOG_KEYS = ['event', 'summary', 'fields', 'ok'] as const
/** `POST /api/events/read` 认识的字段（`EventsService.markRead` 的两种选法）。 */
const EVENTS_READ_KEYS = ['ids', 'all'] as const
/** `POST /api/sources/preview` 认识的字段。 */
const SOURCE_PREVIEW_KEYS = ['sourceId', 'params'] as const
/** Provider 行的字段。`POST /api/providers` 与 `PATCH /api/providers/:id` 同吃一份：
 *  PATCH 里 `id` 被显式解构丢弃（路径段才是身份），所以它是"认识"的键，不该被闸挡。
 *  与 `providerValidationError` 逐项同源。 */
const PROVIDER_KEYS = [
  'id', 'label', 'description', 'category', 'variant', 'serves', 'strategy', 'members', 'expand', 'contract', 'options',
] as const
/** `PUT /api/provider-callsites/:id/binding` 认识的字段。 */
const CALLSITE_BINDING_KEYS = ['providerIds', 'params'] as const
/** `PATCH /api/items/:id` 认识的字段。 */
const ITEM_PATCH_KEYS = ['label'] as const
/** `POST /api/items/renormalize` 认识的字段（两者互斥，都不给 = 全库）。 */
const RENORMALIZE_KEYS = ['streamId', 'sourceId'] as const
/** `POST /api/recipes/packages/preview` 认识的字段。 */
const RECIPE_PREVIEW_KEYS = ['name', 'version'] as const
/** `POST /api/recipes/packages/install` 认识的字段（confirm = preview 发的 integrity）。 */
const RECIPE_INSTALL_KEYS = [...RECIPE_PREVIEW_KEYS, 'confirm'] as const
/** `POST /api/recipes/action` 认识的字段。`confirmed` 与 MCP 那侧同名同义——两步确认只有一份
 *  实现（`runActionRecipe` 内部），这里不另加一道，也不替调用方省掉。 */
const ACTION_RUN_KEYS = ['sourceId', 'params', 'confirmed'] as const
/** `POST /api/recipes/packages/uninstall` 认识的字段。 */
const RECIPE_UNINSTALL_KEYS = ['name'] as const
/** `POST /api/facilities/:id/page/evaluations` 认识的字段。 */
const PAGE_EVAL_KEYS = ['expression'] as const
/** `POST /api/collections` 认识的字段。 */
const COLLECTION_CREATE_KEYS = ['domain', 'label', 'anchorStreamId'] as const
/** `PATCH /api/collections/:id` 认识的字段。 */
const COLLECTION_PATCH_KEYS = ['label'] as const
/** `POST /api/collections/:id/items` 的**顶层**字段。 */
const COLLECTION_ITEMS_KEYS = ['items'] as const
/** 一条收藏成员的元数据字段（`PUT …/items/:key` 的整个 body = 这些）。 */
const COLLECTED_ITEM_KEYS = ['title', 'poster', 'artist', 'album', 'durationS', 'sourceUrl'] as const
/** `POST /api/collections/:id/items` 里**每个数组元素**认识的字段：元数据 + 它自己的 key。
 *  批量加入写错的几乎总是元素里的键名（顶层只有一个 `items`），所以逐元素也要过闸。 */
const COLLECTION_ITEM_ENTRY_KEYS = ['key', ...COLLECTED_ITEM_KEYS] as const
/** `PUT /api/collections/:id/order` 认识的字段。 */
const COLLECTION_ORDER_KEYS = ['keys'] as const
/** `PUT /api/watch-progress/:key` 认识的字段。 */
const WATCH_PROGRESS_KEYS = ['position', 'duration', 'workKey', 'workTitle', 'workPoster', 'epLabel', 'channelId'] as const
/** `POST /api/intents` 认识的字段。 */
const INTENT_CREATE_KEYS = ['goal', 'streamIds', 'recruit'] as const
/** `POST /api/downloads` 认识的**顶层**字段（`track` 里那层由 provider 自己解释）。 */
const DOWNLOAD_ENQUEUE_KEYS = ['itemId', 'stream', 'track', 'skipArchived', 'force'] as const
/** `PUT /api/plugins/:pluginId/enabled` 认识的字段。 */
const PLUGIN_ENABLED_KEYS = ['enabled'] as const
/** `POST /api/source-runtime-config/status` 认识的字段。 */
const SOURCE_RUNTIME_STATUS_KEYS = ['pluginId', 'sourceId', 'ref'] as const
/** `PUT /api/source-runtime-config` 认识的字段（`values` 里那层另有 manifest 字段名的闸）。 */
const SOURCE_RUNTIME_SET_KEYS = [...SOURCE_RUNTIME_STATUS_KEYS, 'values'] as const
/** `POST /api/source-runtime-config/provision` 认识的字段（`params` 里那层由 recipe 的
 *  params_schema 解释，同 `POST /api/downloads` 的 `track`）。 */
const SOURCE_RUNTIME_PROVISION_KEYS = [...SOURCE_RUNTIME_STATUS_KEYS, 'params'] as const
/** `PUT /api/settings/harvest-browser` 认识的字段。 */
const HARVEST_BROWSER_KEYS = ['exe'] as const
/** `PUT /api/settings/summary-prompt` 认识的字段。 */
const SUMMARY_PROMPT_KEYS = ['prompt'] as const
/** `PUT /api/settings/video-sources` 认识的字段。 */
const VIDEO_SOURCES_KEYS = ['tmdbApiKey', 'omdbApiKey', 'language'] as const
/** `POST /api/settings/archive/{reconcile-formats,orphans}` 认识的字段。 */
const ARCHIVE_MAINTENANCE_KEYS = ['apply'] as const
/** `POST /api/settings/alist/test` 认识的字段：一个都没有（内置托管，探测的就是现役那一份）。 */
const ALIST_TEST_KEYS = [] as const
/** `POST /api/voiceprint/persons` 认识的字段。 */
const VOICEPRINT_PERSON_KEYS = ['name', 'aliases'] as const
/** `POST /api/voiceprint/item/:itemId/clusters/:cluster/enroll` 认识的字段。 */
const VOICEPRINT_ENROLL_KEYS = ['personId'] as const

/**
 * 严格输入闸的共用一行：body 是对象就查一遍键名，认不出的当场 400 并指出该写哪个。
 * 返回 `null` = 放行（body 不是对象时交给各 handler 自己的形状校验说话）。
 */
function strictBody(c: Context, body: unknown, allowed: readonly string[]): Response | null {
  if (!isObject(body)) return null
  const bad = unknownKey(Object.keys(body), allowed)
  return bad ? c.json(errorBody('validation_error', unknownKeyMessage('字段', bad, allowed)), 400) : null
}

function streamValidationError(body: unknown, partial = false): string | null {
  if (!isObject(body)) return 'body must be an object'
  if (!partial || body.label !== undefined) {
    if (typeof body.label !== 'string') return 'label must be a string'
  }
  if (!partial || body.strategy !== undefined) {
    if (body.strategy !== 'fanout' && body.strategy !== 'exclusive') return 'strategy must be fanout | exclusive'
  }
  if (!partial || body.cadence_seconds !== undefined) {
    if (typeof body.cadence_seconds !== 'number' || !Number.isFinite(body.cadence_seconds) || body.cadence_seconds <= 0) {
      return 'cadence_seconds must be > 0'
    }
  }
  if (!partial || body.members !== undefined) {
    if (!Array.isArray(body.members) || !body.members.every(validateSourceBinding)) {
      return 'members must be an array of { plugin, source, params }'
    }
  }
  if (body.contract !== undefined && !isObject(body.contract)) return 'contract must be an object'
  if (!partial || body.options !== undefined) {
    if (!isObject(body.options)) return 'options must be an object'
  }
  return null
}

function ensureChannelStreamsExist(channelStore: import('../store/user-store.ts').UserStore, streamIds: string[]): string | null {
  const missing = streamIds.find((id) => !channelStore.getStream(id))
  return missing ? `stream not found: ${missing}` : null
}

// ── Provider 行模型（docs/superpowers/plans/2026-07-02-provider-management.md）──

const PROVIDER_VARIANTS = ['search', 'resolve', 'download', 'transform', 'transcribe', 'llm', 'metadata', 'images', 'data'] as const

/** 实例名撞车检测：两个成员的**寻址键**相同、且至少一个是显式实例名 → 拒。
 *  寻址键的命名空间**只有一个**（executor 的 expandMembers 用同一个 `seen` 集合去重 source 成员和
 *  `{provider}` 组合成员），所以这里必须把两类成员放进同一张表判撞——否则
 *  `[{provider:'child'}, {source:'s', name:'child'}]` 能过校验、然后被 executor 静默吞掉一档。
 *  为什么在校验层拒而不靠 executor 去重：executor 的"先到者赢"去重是**功能**（前置 pin 压制后续
 *  auto 段展开出的同 id），它分不清"故意压制"和"实例名打错"；只有写入这一刻能分——两个显式实例名
 *  撞在一起必然是配置错，静默丢掉一档梯子是查不出来的那种坏。没写 name 的行一律不受这条影响
 *  （键都是 source / provider id，落回旧的静默去重语义，既有行为逐字节不变）。 */
function collidingMemberName(members: unknown[]): string | null {
  const seen = new Set<string>()
  const named = new Set<string>()
  for (const m of members) {
    if (!isObject(m)) continue
    const base = typeof m.source === 'string' ? m.source : typeof m.provider === 'string' ? m.provider : null
    if (base === null) continue // auto 段(provides/matches)展开出的成员不带实例名,不进这张表
    // 实例名只对 {source} 成员有意义：{provider} 成员的键恒是子行 id
    const explicit = typeof m.source === 'string' && typeof m.name === 'string' && m.name.length > 0
    const key = explicit ? (m.name as string) : base
    if (seen.has(key) && (explicit || named.has(key))) return key
    seen.add(key)
    if (explicit) named.add(key)
  }
  return null
}

/** 实例名遮蔽真实源检测（需要 registry，故在路由层调、不在纯函数校验里）：一个成员的实例名等于
 *  **另一个已注册源的 id** 时拒。原因：寻址键是一个平的命名空间，`[{source:'a', name:'b'}]` 加上
 *  某个 auto 段展开出的真源 `b`，真的 `b` 会被这个实例挤掉——行看起来有它、跑起来没有，而且从
 *  界面上完全看不出来。`name` 恰好等于自己的 `source` 是允许的（等价于不写 name，寻址键不变）。
 *  registry 不可达（未接线 / 测试注入）→ 跳过，不炸。 */
function shadowedSourceName(members: unknown[], registry: import('../registry/registry.ts').Registry | undefined): string | null {
  if (!registry) return null
  for (const m of members) {
    if (!isObject(m) || typeof m.source !== 'string') continue
    if (typeof m.name !== 'string' || !m.name.length) continue
    if (m.name === m.source) continue // 等价于不写 name
    if (registry.get(m.name)) return m.name
  }
  return null
}

const shadowedNameMessage = (name: string): string =>
  `member name "${name}" is already a registered source id — an instance name shares one namespace with source ids, ` +
  `so this member would shadow that source (it can never enter the ladder). Pick a name that is not a source id.`

/**
 * 这份 PATCH 有没有试图改动系统行的**身份**（category/serves/strategy/contract/expand）。
 * 返回撞上的字段名（多个用 `/` 连），没撞则 null。
 *
 * 判据是「传了、且值和代码身份不同」——前端把整行读回来再 PATCH 回去是常态，那里面必然带着
 * 这几个字段的**原值**，把「传了」本身当成冲突会把正常编辑一起拒掉。
 */
function systemIdentityConflict(id: string, patch: Record<string, unknown>): string | null {
  const identity = identityOf(id)
  if (!identity) return null
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  const conflicts: string[] = []
  const category = patch.category ?? patch.variant
  if (category !== undefined && category !== identity.category) conflicts.push('category')
  if (patch.serves !== undefined && !same(patch.serves, identityServes(identity))) conflicts.push('serves')
  if (patch.strategy !== undefined && patch.strategy !== identity.strategy) conflicts.push('strategy')
  if (patch.contract !== undefined && !same(patch.contract, identity.contract)) conflicts.push('contract')
  if (patch.expand !== undefined && !same(patch.expand, identity.expand)) conflicts.push('expand')
  return conflicts.length ? conflicts.join('/') : null
}

function providerValidationError(body: unknown, partial = false): string | null {
  if (!isObject(body)) return 'body must be an object'
  if (!partial) {
    if (typeof body.id !== 'string' || !body.id.length) return 'id must be a non-empty string'
  }
  if (!partial || body.category !== undefined || body.variant !== undefined) {
    const cat = (body.category ?? body.variant) as unknown
    if (!PROVIDER_VARIANTS.includes(cat as never)) return `category must be ${PROVIDER_VARIANTS.join(' | ')}`
  }
  if (body.label !== undefined && typeof body.label !== 'string') return 'label must be a string'
  if (body.description !== undefined && typeof body.description !== 'string') return 'description must be a string'
  if (body.serves !== undefined && !stringArray(body.serves)) return 'serves must be a string array'
  if (body.strategy !== undefined && !BUILTIN_STRATEGY_NAMES.includes(body.strategy as string)) {
    return `strategy must be ${BUILTIN_STRATEGY_NAMES.join(' | ')}`
  }
  if (body.members !== undefined) {
    if (!Array.isArray(body.members) || !body.members.every(isProviderMemberRef)) {
      return 'members must be an array of { source } | { provider } | { mode: "auto", provides } | { mode: "auto", matches }'
    }
    const dup = collidingMemberName(body.members)
    if (dup) return `duplicate member name: ${dup}`
  }
  // expand strategy 形状校验:恰好有序两 {source} 成员 [A,B] + expand.map/assemble;映射一律 $item.<field>
  // 字段取值(守红线:不引入任意求值),assemble.type 额外允许裸分类器名 'pathClassify'。
  if (body.strategy === 'expand') {
    const ms = body.members
    if (!Array.isArray(ms) || ms.length !== 2 || !ms.every((m) => isObject(m) && 'source' in m)) {
      return 'expand strategy requires exactly two { source } members [A, B]'
    }
    const ex = body.expand
    if (!isObject(ex) || !isObject(ex.map) || !isObject(ex.assemble)) {
      return 'expand strategy requires expand.map and expand.assemble'
    }
    const asm = ex.assemble as { url?: unknown; type?: unknown; desc?: unknown }
    const vals = [...Object.values(ex.map as Record<string, unknown>), asm.url, asm.desc]
    if (!vals.every((v) => typeof v === 'string' && v.startsWith('$item.'))) {
      return 'expand mapping values must be $item.<field> extractions'
    }
    if (!(asm.type === 'pathClassify' || (typeof asm.type === 'string' && asm.type.startsWith('$item.')))) {
      return 'expand assemble.type must be $item.<field> or pathClassify'
    }
  }
  if (body.contract !== undefined && body.contract !== null && !isObject(body.contract)) return 'contract must be an object or null'
  if (body.options !== undefined && !isObject(body.options)) return 'options must be an object'
  return null
}

/** Overlay carried alongside a member's `health` state so the UI can show WHY it failed
 *  (hover card). Latest error only; the store also keeps stack + rolling history, punted.
 *  Returned only for a non-healthy source that actually has a recorded error. */
export type HealthErrorView = { category: FailureCategory; message: string; at: string }

function healthErrorOf(
  sourceHealth: SourceHealthStore | undefined,
  id: string,
  state: string | undefined,
): HealthErrorView | undefined {
  if (!sourceHealth || !state || state === 'healthy') return undefined
  const h = sourceHealth.get(id)
  if (!h?.lastError) return undefined
  return { category: h.lastErrorCategory ?? 'unknown', message: h.lastError, at: h.lastAt }
}

/** 「这个源自己绿着，但它申报依赖的东西有问题」——`uses` 反着读的结果，挂在成员行上。
 *
 *  两种问题都要说出来，因为对用户的后果一样（产出是残的），而单看这个源本身都正常：
 *  - `broken`：那个依赖此刻非健康（它多半不是任何一条 Stream 的成员，界面上没有属于它的行）；
 *  - `unresolved`：那条 `uses` 边解析不到（第三方包没装 / id 打错）——答案里的洞，压掉它就是
 *    把「这条没验到」讲成「验过了」（同 `AffectedSourcesResult.unresolved`）。 */
export type DependencyIssueView =
  | { kind: 'broken'; id: string; title?: string; health: string; error?: HealthErrorView }
  | { kind: 'unresolved'; id: string }

/** `Registry.get` 在裸名歧义时会抛。一次投影没有资格因为某个第三方包重名就整个 500。 */
function quietGet(registry: Registry | undefined, id: string) {
  try {
    return registry?.get(id)
  } catch {
    return undefined
  }
}

/**
 * @param brokenDeps 消费方全名 → 连累它的坏源全名（`brokenDependencies`，整份请求算一次）
 * @param brokenLedgerKey 坏源全名 → 健康账本里那个 key。**不能拿全名直接查账本**：账本按取数时
 *        写下的 id 记（存量是 `xhs:xhs-detail` 这类形状），而这里的全名是注册表归一后的——
 *        两者对不上时 `stateOf` 会诚实地答 `healthy`，于是一条真坏的依赖被渲染成「正常」。
 */
function dependencyIssuesOf(
  registry: Registry | undefined,
  sourceHealth: SourceHealthStore | undefined,
  brokenDeps: ReadonlyMap<string, string[]>,
  brokenLedgerKey: ReadonlyMap<string, string>,
  manifest: SourceManifest,
): DependencyIssueView[] | undefined {
  const issues: DependencyIssueView[] = []
  for (const depId of brokenDeps.get(manifest.id) ?? []) {
    const key = brokenLedgerKey.get(depId) ?? depId
    const dep = quietGet(registry, depId)
    const state = sourceHealth?.stateOf(key)
    const error = healthErrorOf(sourceHealth, key, state)
    issues.push({
      kind: 'broken',
      id: depId,
      title: dep?.title ?? dep?.description,
      health: state ?? 'dead',
      ...(error ? { error } : {}),
    })
  }
  for (const raw of manifest.uses ?? []) {
    if (!quietGet(registry, raw)) issues.push({ kind: 'unresolved', id: raw })
  }
  return issues.length ? issues : undefined
}

/** 行 + 展开后的现役成员（plugin/health 归属）+ 调用计数 + 调用位置注记。 */
function providerView(deps: HttpDeps, record: import('../store/types.ts').ProviderRecord) {
  const registry = deps.resolve?.registry
  const resolvedMembers = deps.providers!.executor.resolvedMembers(record).map((m, i) => {
    const manifest = registry?.get(m.sourceId)
    // 成员一律是 Source：展示字段统一走 publicSource（唯一投影），原样嵌在 source 下 —
    // 与 plugin 目录、Stream 成员同一份投影，禁止摊平/改名。name 是寻址键（reorder/exclude
    // 按它操作，同源多实例时 = 实例名），priority/health 是绑定级信息，与 source 平级。
    // manifest / health 按 **sourceId** 查——同一个源的两个实例共享这两样。keyState 例外：
    // perInstance 源每个实例各自一份 key（存在成员 params.tokenName 那一层），所以连成员 params
    // 一起交给它判（普通源照旧只看 sourceId）。
    const sh = deps.resolve?.sourceHealth
    const health = sh?.stateOf(m.sourceId) ?? 'unknown'
    const healthError = healthErrorOf(sh, m.sourceId, health)
    const keyState = deps.keyState?.(m.sourceId, m.params) ?? null
    return {
      name: m.name,
      priority: i + 1,
      source: manifest ? publicSource(manifest) : fallbackSource(m.sourceId),
      health,
      ...(healthError ? { healthError } : {}),
      ...(keyState ? { keyState } : {}),
    }
  })
  // 默认来源：声明在 PROVIDER_DEFAULT_SOURCE，这里 join 成完整投影（前端要 pluginId 才取得到
  // detail）。装机没装到那个源就当没有——宁可退回目录，也别给前端一个点了会 404 的按钮。
  const defaultSourceId = PROVIDER_DEFAULT_SOURCE[record.id]
  const defaultManifest = defaultSourceId ? registry?.get(defaultSourceId) : undefined
  return {
    ...record,
    status: 'live' as const,
    callSites: callSitesOf(record.id),
    referencedBy: deps.providerBindings?.references(record.id) ?? [],
    resolvedMembers,
    ...(defaultManifest ? { defaultSource: publicSource(defaultManifest) } : {}),
    calls: deps.providers!.stats.of(record.id),
    // 顶层投影：前端槽位候选过滤靠它,别让前端下钻 options.parked。
    parked: isParked(record),
  }
}

const ZERO_CALLS = { total: 0, byMember: {}, lastCalledAt: null }

function plannedProviderViews() {
  return PLANNED_PROVIDERS.map((p) => ({
    ...p,
    status: 'planned' as const,
    variant: null,
    serves: [] as string[],
    strategy: null,
    members: [] as unknown[],
    resolvedMembers: [] as unknown[],
    calls: ZERO_CALLS,
  }))
}

/** Re-wrap a proxied video Response so the browser saves it instead of playing inline.
 *  A cross-origin `<a download>` can't set the filename, but `Content-Disposition` can —
 *  and it streams (the body passes straight through, no in-memory blob). Status/body/
 *  range headers (200 or 206) are preserved. `name` becomes the download filename. */
export function asDownload(resp: Response, name: string): Response {
  const safe =
    (name || 'video').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').trim().slice(0, 120) || 'video'
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_') // plain filename must be ASCII
  const h = new Headers(resp.headers)
  h.set(
    'Content-Disposition',
    `attachment; filename="${ascii}.mp4"; filename*=UTF-8''${encodeURIComponent(safe)}.mp4`
  )
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h })
}

function mergePluginStatus<T extends { id: string; status?: string; launch?: { health?: string } }>(
  plugins: T[],
  rows: unknown[]
): T[] {
  const byId = new Map(
    rows
      .filter((row): row is { id: string; configured?: boolean; health?: string; standby?: unknown } => !!row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string')
      .map((row) => [row.id, row])
  )
  return plugins.map((plugin) => {
    const row = byId.get(plugin.id)
    if (!row) return plugin
    const configured = row.configured ?? true
    const health = row.health === 'ok' ? 'healthy' : row.health === 'down' ? 'unhealthy' : 'unknown'
    return {
      ...plugin,
      configured,
      health: row.health,
      status: configured ? plugin.status : 'needs_config',
      launch: { ...plugin.launch, health },
      // 本函数是**挑字段重组**,不是展开 row —— 所以每个要给到客户端的状态字段都得在这里显式列出,
      // 漏一个就在 HTTP 边界悄悄消失、而直测 aggregatePluginStatus 的单测照样绿(standby 就这么
      // 漏过一次,活体才发现)。只有 standby 服务带这个键,其余插件的对象一个字段都不多。
      ...(row.standby ? { standby: row.standby } : {}),
    }
  })
}

const TIER_LABEL = ['未知', '标准', '较高', '高', '无损', 'Hi-Res']

/** Map audio-resolve facts → a generic DebugEntry (channel 'audio-resolve'). Keeps the plain-
 *  language summary + the ladder/quality/archive-probe detail the debug box renders uniformly. */
function buildAudioResolveEntry(f: AudioResolveFacts): DebugEntry {
  const at = Date.now()
  const tier = f.tier ?? 0
  const qtxt = [f.format?.toUpperCase(), f.bitrate ? `${f.bitrate}kbps` : null, TIER_LABEL[tier]].filter(Boolean).join(' ') || '未知音质'
  const summary =
    f.outcome === 'archive'
      ? `命中本地归档，直接播放 ${qtxt}`
      : f.outcome === 'unresolved'
        ? `解析失败：试了 ${f.rungs.length} 个源都没结果`
        : `在线解析：${f.via ?? '某源'} ${f.totalResolveMs}ms 拿到 ${qtxt}，${f.streamMode === 'proxy' ? '代理回源' : '302→CDN'}`
  const fields: DebugField[] = []
  if (f.outcome !== 'unresolved') fields.push({ label: '音质', value: qtxt, tone: tier >= 4 ? 'ok' : tier >= 3 ? 'ok' : tier > 0 ? 'muted' : 'warn' })
  if (f.via) fields.push({ label: '来源', value: f.via })
  fields.push({ label: '方式', value: f.streamMode })
  if (f.urlHost) fields.push({ label: 'CDN', value: f.urlHost, tone: 'muted' })
  fields.push({ label: '耗时', value: `${f.totalResolveMs}ms` })
  if (f.requestedLevel) fields.push({ label: '请求档位', value: f.requestedLevel, tone: 'muted' })
  if (f.archive) {
    const av = f.archive.hasRow ? (f.archive.fileExists ? '命中' : '有记录但文件缺失 → 走在线') : '无本地记录'
    fields.push({ label: '本地归档', value: av, tone: f.archive.hasRow && !f.archive.fileExists ? 'warn' : f.archive.fileExists ? 'ok' : 'muted' })
  }
  for (const r of f.rungs) {
    fields.push({
      label: r.member,
      value: `${r.ms}ms · ${r.outcome}${r.reason ? ' · ' + r.reason : ''}`,
      tone: r.outcome === 'win' ? 'ok' : r.outcome === 'error' ? 'bad' : r.outcome === 'rejected' ? 'muted' : 'warn',
    })
  }
  if (f.misses) {
    for (const m of f.misses) {
      if (m.stack) {
        fields.push({
          label: `${m.member} 调用栈`,
          value: m.stack,
          tone: 'muted',
        })
      }
    }
  }
  return {
    id: `audio-resolve:${f.platform}:${f.id}@${at}`,
    at,
    channel: 'audio-resolve',
    key: `${f.platform}:${f.id}`,
    title: `${f.platform}:${f.id}`,
    summary,
    ok: f.outcome !== 'unresolved',
    fields,
  }
}


/**
 * REST adapter over the same core the MCP adapter uses. Returned as a Hono app
 * so it's testable via `app.request()` and mountable on a node server.
 */
function videoLookupIdentity(stream: StreamRecord, items: StoredItem[]): VideoLookupIdentity {
  const options = stream.options as Record<string, unknown>
  const externalIds: Record<string, string> = {}
  // Source page payloads can contain unrelated schema.org/embedded IDs (an iQiyi episode
  // once exposed Iron Man 3's IMDb id). Only a user-declared Stream override is authoritative
  // for a followed work; ranking items use their own source URL parser instead.
  for (const [key, target] of [['tmdb', 'tmdb'], ['tmdbId', 'tmdb'], ['imdb', 'imdb'], ['imdbId', 'imdb']] as const) {
    const value = options[key]
    if (typeof value === 'string' && value.trim()) externalIds[target] = value.trim()
    if (typeof value === 'number') externalIds[target] = String(value)
  }
  const yearValue = options.year
  const labelledYear = stream.label.match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/)?.[1]
  const episodeYears = items.flatMap((item) => {
    const raw = item.raw && typeof item.raw === 'object' ? item.raw as Record<string, unknown> : undefined
    const candidate = raw?.pubDate ?? raw?.pubdate ?? item.timestamp
    const date = candidate ? new Date(String(candidate)) : null
    return date && Number.isFinite(date.getTime()) ? [date.getUTCFullYear()] : []
  }).filter((year) => year >= 1900 && year <= 2100)
  const year = typeof yearValue === 'number' ? yearValue : typeof yearValue === 'string' && /^\d{4}$/.test(yearValue) ? Number(yearValue) : labelledYear ? Number(labelledYear) : episodeYears.length ? Math.min(...episodeYears) : undefined
  const kind = options.kind
  return {
    title: typeof options.title === 'string' && options.title.trim() ? options.title.trim() : stream.label,
    ...(year ? { year } : {}),
    // A followed Stream with multiple episodes is a work/series (including variety shows),
    // not a standalone movie. Explicit Stream options always win.
    kind: kind === 'movie' || kind === 'series' || kind === 'season' || kind === 'episode' ? kind : items.length > 1 ? 'series' : 'unknown',
    ...(items[0]?.url ? { sourceUrl: items[0].url } : {}),
    externalIds,
  }
}

/** Build a provider identity for one ranking item. Unlike a followed Stream, a ranking is a
 * collection: its label is never the work title. Prefer provider IDs carried by the canonical
 * source URL, then use the already-normalized item title and release year as a constrained search. */
export function createHttpApp(deps: HttpDeps): Hono {
  const app = new Hono()

  // 未捕获错误必须有主人:不注册 onError 时走 Hono 默认打印——裸栈、没有方法/路径/时间,
  // 下次再出现照样查不到腿上(2026-08-24 一次 UND_ERR_BODY_TIMEOUT 只留下一段 undici 内部栈,
  // 归因只能靠时间线旁证)。这里只补上下文再交回同样的 500,不吞、不改任何路由的既有行为。
  app.onError((err, c) => {
    console.error(`[http] ${c.req.method} ${c.req.path} 未捕获错误:`, err)
    return c.json(errorBody('internal', err instanceof Error ? err.message : String(err)), 500)
  })

  // op-track gate: first middleware, so the span covers the whole route (auth, handler, body).
  // track() rethrows — Hono's error handling is untouched.
  const track = deps.track
  if (track) {
    app.use('*', async (c, next) => {
      await track(`http:${c.req.method} ${c.req.path}`, next)
    })
  }

  /** 频道内发起的调用点带 channelId → 槽位覆盖生效;无频道语境的调用点不传,行为不变。 */
  const slotCtx = (c: Context): SlotContext => ({ channelId: c.req.query('channelId') || undefined })

  /** §5.1:槽位废 = 显式报错,不 fallback。捕 SlotBrokenError → 422 + Bell 事件(双通道之一;
   *  前端 sonner toast 是另一通道,不在后端)。dedupeKey 编终态(channelId+callsiteId)——同一坏槽
   *  重复触发只刷新已有事件时间戳,不堆重复行(EventsService.emit 的 floor-level dedupe)。 */
  const slotBroken422 = (c: Context, e: SlotBrokenError) => {
    deps.events?.emit?.({
      type: 'provider.slot_broken', severity: 'warn', dedupeKey: `slot:${e.channelId}:${e.callsiteId}`,
      title: `频道槽位失效:${e.callsiteId}`,
      body: `频道 ${e.channelId} 的 ${e.callsiteId} 槽位指向的 Provider 已停用或删除,请到频道设置修复或清除`,
    })
    return c.json(errorBody('slot_broken', `频道 ${e.channelId} 的 ${e.callsiteId} 槽位指向的 Provider 已停用或删除`), 422)
  }

  // generic debug bus (created in serve.ts, shared with the download queue): record() stores +
  // broadcasts; GET /api/debug/log reads the ring for reconciliation (box opened mid-flow).
  const recordDebug = deps.debug?.record ?? (() => {})

  // Liveness probe: the MCP spawn path (`mcp/spawn-backend.ts`) polls this to know the backend
  // is up before talking to it. Unauthenticated on purpose (liveness only, no data) —
  // registered ahead of the token middleware below so a configured api_token doesn't block it.
  app.get('/api/health', (c) => {
    // Never call deps.health() here — it is async and does I/O. last_harvest_at comes from a
    // dedicated sync closure instead (see HttpDeps.lastHarvestAt doc); any failure there is
    // swallowed so this probe stays 200.
    let lastHarvestAt: string | undefined
    try {
      lastHarvestAt = deps.lastHarvestAt?.()
    } catch {
      lastHarvestAt = undefined
    }
    // commit / started_at / dirty_since_start：让"活体跑的是哪一份代码"这件事能被一眼核对，
    // 而不是靠"我改了、它应该重载了"的信念。语义与代价见 build-identity.ts 的头注。
    // 同样一律吞异常——这一口是探针，少几个字段可以，挂掉不行。
    let identity: Partial<BuildIdentity> = {}
    try {
      identity = buildIdentity()
    } catch {
      identity = {}
    }
    // pending_restart：有几项装完 / 换版后还没生效、要重启才生效。它要现扫一次包目录——同样吞
    // 异常：目录被删、扫到一半读不动，都只掉这一格，探针本身不能因此变 500。
    let pendingRestart: number | undefined
    try {
      pendingRestart = deps.packagePending ? deps.packagePending().filter((p) => p.needsRestart).length : undefined
    } catch {
      pendingRestart = undefined
    }
    return c.json({
      ok: true,
      ...identity,
      ...(lastHarvestAt ? { last_harvest_at: lastHarvestAt } : {}),
      ...(pendingRestart === undefined ? {} : { pending_restart: pendingRestart }),
    })
  })

  /**
   * 「证明你也知道那把 secret」——扩展在**交出 token 之前**打这一口。
   *
   * 这里曾经是 `POST /api/ext/token`，直接把 ext-relay secret 发给对方。**别把它加回来。**
   * 那条路的方向是反的：扩展向对端索取凭证，于是本机任何进程抢到这个口就拿到了这条通道的
   * 全部能力（任意页面 `Runtime.evaluate`）。现在 token 由扩展经 native messaging 从
   * `data/ext-relay-token` 自取（只有同一个用户读得到），这一口只负责让后端**证明**自己也
   * 知道它——回的是 `HMAC-SHA256(token, VERIFY_PREFIX + nonce)`，不是 token 本身。
   *
   * 仍然保留 Origin 门控：proof 虽然不是 secret，但没必要让任意扩展拿它当预言机。
   * 同 `/api/health` 注册在门之前——扩展拿不到 api_token，而网页伪造不了
   * `chrome-extension://` Origin（浏览器强制 Origin 头，fetch/XHR/WS 均不可自设）。
   * 必须是 POST：扩展带 host_permissions 时 GET 走非 CORS 路径、Chrome 不附 Origin 头
   * （实测 Sec-Fetch-Mode: cors 但无 Origin）；非 GET 请求浏览器强制带 Origin，两端才对得上。
   */
  app.post('/api/ext/verify', async (c) => {
    const auth = deps.extRelayAuth
    if (!auth) return c.json({ error: 'ext relay disabled' }, 404)
    const origin = c.req.header('Origin') ?? ''
    const ok = auth.extId
      ? origin === `chrome-extension://${auth.extId}`
      : /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
    if (!ok) return c.json({ error: 'forbidden' }, 403)
    const body = (await c.req.json().catch(() => null)) as { nonce?: unknown } | null
    const gate = strictBody(c, body, EXT_VERIFY_KEYS)
    if (gate) return gate
    // nonce 由客户端出，服务端只签不解释；但**必须是它自己给的那个**才防得住重放，
    // 所以空/非串一律拒，绝不用默认值兜底签一个可预测的挑战。
    if (!body || typeof body.nonce !== 'string' || body.nonce.length < 16) {
      return c.json({ error: 'nonce required (>=16 chars)' }, 400)
    }
    return c.json({ proof: extVerifyProof(auth.token, body.nonce), protocol: EXT_RELAY_PROTOCOL })
  })

  // ext-relay 连接状态探针：诊断"扩展现在连着吗"的第一步就该是打这个口，而不是让用户
  // 点图标/重启 gateway/重载扩展地猜（2026-07-27 一次误诊耗了四轮，真凶在别处）。
  // 只读、无副作用、不含任何数据 —— 同 /api/health 注册在门之前：
  // 连不上的时候正是要用它，不能反过来要求先拿到凭证。
  app.get('/api/ext/relay-status', (c) => {
    const status = deps.extRelayStatus
    if (!status) return c.json({ error: 'ext relay disabled' }, 404)
    return c.json(status())
  })

  // 后端此刻还骑着哪些浏览器标签。lane→tab 的映射只在进程内存里，后端一重启就全丢了——
  // 扩展靠这一口回收留在用户 Chrome 里的孤儿采集标签（它自己判断收不收、怎么收，红线在那边）。
  // **空集合和「问不到」必须分开**：空集合 = 一个都不认（后端刚重启的常态，该收就收），
  // dep 没接线 = 503，扩展见到非 200 一律什么都不做。同 relay-status 注册在门之前：
  // 扩展的对账不该依赖它先拿到凭证。
  app.get('/api/ext/claimed-tabs', (c) => {
    if (!deps.claimedTabs) return c.json(errorBody('unavailable', 'facility sessions not available'), 503)
    return c.json({ tabIds: deps.claimedTabs() })
  })

  /*
   * 这里曾经有 `POST /api/ext/cookies`：扩展定时把登录态推给后端。**别加回来**，方向已经反了
   * ——现在是后端在需要的时刻去取（`ExtRelay.cookiePull` → `CookiePuller`）。
   *
   * 为什么反：扩展不知道后端什么时候要用登录态，只能按时间猜（30 分钟一轮）。猜的代价是
   * cookie 轮换之后干等一整个周期，期间每次取流都 412——而后端明明当场就知道自己吃了个 401。
   * 取数的调度权必须在知道"什么时候要用"的那一端。
   *
   * 撤掉它不是洁癖：留着就是一条没有调用方的写全站登录态的口子，而且它会让下一个人以为
   * "推那条路还活着"，在 pull 出问题时去修一条早就没人走的路。
   */

  // 扩展 SW 的关键生命周期事件 → debug bus 的 `ext-cdp` channel（`GET /api/debug/log?channel=ext-cdp`）。
  // **走 HTTP 不走 relay 的 WS**：要记的那几件事（onStartup 触发、账本清空、认领旧组）全发生在
  // connect 之前，走 WS 就等于永远记不到最需要的那一刻。
  // 只收扩展自己的低频事件（浏览器/扩展每次启动至多各一次），高频路径（每个 tab 的 add/remove）
  // 不许往这里打。同 /api/ext/verify 用 Origin 门控、注册在门之前：扩展拿不到 api_token。
  app.post('/api/ext/debug-log', async (c) => {
    if (!/^chrome-extension:\/\/[a-p]{32}$/.test(c.req.header('Origin') ?? '')) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const body = await c.req.json().catch(() => undefined) as
      { event?: unknown; summary?: unknown; fields?: unknown; ok?: unknown } | undefined
    const gate = strictBody(c, body, EXT_DEBUG_LOG_KEYS)
    if (gate) return gate
    const event = typeof body?.event === 'string' ? body.event : undefined
    if (!event) return c.json(errorBody('validation_error', 'event required'), 400)
    const at = Date.now()
    recordDebug({
      id: `ext-cdp:${event}@${at}`,
      at,
      channel: 'ext-cdp',
      key: event,
      title: `扩展：${event}`,
      summary: typeof body?.summary === 'string' ? body.summary : event,
      // ok **由扩展申报**，缺省 true（生命周期事件 onStartup / ledger-cleared 都不是故障）。
      // 慢命令那两条要报 false，否则 DebugBox 的 failedOnly 会只留下后端侧的 relay-timeout
      // 而藏掉配对的 slow-command —— 而"有 timeout、没 slow-command"正是"命令没送到 SW"的
      // 判据，等于一个过滤器凭空造出一个错误结论。
      ok: body?.ok !== false,
      fields: Array.isArray(body?.fields)
        ? (body.fields as unknown[])
            .filter((f): f is { label: string; value: unknown } =>
              !!f && typeof (f as { label?: unknown }).label === 'string')
            .slice(0, 12)
            .map((f) => ({ label: f.label, value: String(f.value) }))
        : [],
    })
    return c.json({ ok: true })
  })

  // 浏览器采集能力快判：`state` 直接对应三行引导（ready / disconnected / never-seen，见 spec §5）。
  // 扩展跑在 Chrome 里，所以"有没有 Chrome"和"有没有扩展"是同一条信号 —— 这里不需要探测任何东西，
  // 纯读 relay 现状 + 落盘缓存，**永远秒回**（扩展没连时正是要用它，不能在这儿等或去唤醒谁）。
  // `connected:false` 不是故障判定：MV3 的 SW 被回收是常态，别拿它去写 sourceHealth。
  // 同 relay-status 注册在门之前：装机引导要在拿到凭证之前就能读。
  app.get('/api/browser-capability', (c) => {
    const cap = deps.browserCapability
    if (!cap) return c.json({ error: 'ext relay disabled' }, 404)
    return c.json(cap())
  })

  // 全量诊断：快判 + **摸文件系统**找 Chrome 候选。只在"从没连上过"或用户主动要求时跑
  // （spec §5：老用户永远走不到这条）。它和快判是同一个返回结构外加一个 `chrome` 块，
  // 不另造形状——组装走 diagnoseCapability，MCP 的 harvest_capability 调的是同一个函数。
  // 与快判同样注册在门之前——装机引导要在拿到凭证之前就能跑。
  app.post('/api/browser-capability/diagnose', async (c) => {
    const cap = deps.browserCapability
    const hb = deps.harvestBrowser
    if (!cap || !hb) return c.json({ error: 'ext relay disabled' }, 404)
    return c.json(diagnoseCapability(cap(), await hb.status()))
  })

  // expose range headers so dash.js (which reads them via JS) works cross-origin
  // `/v1/*` 是 OpenAI 协议的根级形状（客户端拿源当 Base URL、自己拼 `/v1/images/generations`），
  // 和 `/api/*` 同一套 CORS、同一道门——它能驱动用户的 Chrome 去生图，不能比 /api/mcp 松。
  const apiCors = cors({ origin: '*', exposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'] })
  app.use('/api/*', apiCors)
  app.use('/v1/*', apiCors)

  // 这里曾经有一个 credential broker（`GET /api/credential`）：容器带着自己那份
  // `STREAM_CREDENTIAL_TOKEN` 反过来向宿主要某个域的 Cookie。**它已经撤掉，别再加回来。**
  //
  // 方向是反的：**宿主是唯一调度方**。包不发起调用，是宿主在处理请求时决定去问谁要什么、
  // 只把这一次需要的东西递给包（adapter 就是那层兼容——它跑在宿主进程里，凭证由宿主
  // 注入 `init(env)` / `sidecar.start(creds)`，再随请求递给容器）。让包反向敲门，等于凭空
  // 造出一个「常驻在容器环境变量里的长期密钥」，而它换不来任何宿主本来做不到的事。
  //
  // 撤掉时的实情：全仓零调用方，唯一申报了 `credentials` 的抖音包走的正是上面那条注入路。
  //
  // 包能碰哪些登录态仍由 `stream.credentials` 申报把关，闸门在 `packages/activate.ts` 的
  // `makeCookieFor`——那是**宿主把一个能力交给自己 import 进来的代码**，进程内、宿主全程在场，
  // 和「容器隔着 HTTP 敲门」不是一回事。

  // /api/* 的门。注册在 CORS 之后、业务路由之前，所以下面每一条（以及 serve.ts 里更晚挂上的
  // /api/mcp）都受它管——**这正是要点**：`/api/mcp` 能打开任意网址并在你的登录态里执行任意 JS，
  // 它绝不能比别的端点松。注册在它**之前**的那几条是刻意豁免的（/api/health、/api/ext/*、
  // /api/browser-capability），各自在原地写明了理由，共同点是"连不上/没凭证的时候正要用它"。
  if (deps.accessGuard) {
    const guardToken = deps.accessGuard.token
    const { extId, trustedHosts, trustedOrigins } = deps.accessGuard
    const accessGate: MiddlewareHandler = async (c, next) => {
      // 先判浏览器维度。**这一道才是挡"本机上的恶意网页"的那一道**——它 fetch 127.0.0.1
      // 时来源地址就是 loopback，跟我们自己的前端毫无区别，只有 Origin 认得出它。
      const hostHeader = c.req.header('Host')
      if (!isTrustedHost(hostHeader, trustedHosts) ||
          !isTrustedOrigin({
            origin: c.req.header('Origin'),
            hostHeader,
            extId,
            extraOrigins: trustedOrigins,
          })) {
        return c.json(errorBody('unauthorized', '请求来源不被信任'), 403)
      }
      const verdict = authorizeAccess({
        remoteAddress: peerAddress(c),
        bearer: c.req.header('Authorization'),
        queryToken: c.req.query('token'),
        token: guardToken,
      })
      if (verdict === 'denied') {
        // 说人话 + 说清怎么办：外来访问要 token，而 token 只有在那台机器上才看得到。
        return c.json(
          errorBody('unauthorized', '来自本机以外的请求需要出示访问令牌（在 Stream 的设置页获取）'),
          401
        )
      }
      await next()
    }
    app.use('/api/*', accessGate)
    app.use('/v1/*', accessGate)

    // 令牌自身只从**本机**取得：手机要连，就得有人在这台机器上看一眼（或扫一眼二维码）。
    // 已经持 token 的外来请求也不给——它已经有了，再吐一遍只是多一个泄漏面。
    app.get('/api/access-token', (c) => {
      if (!isLoopbackAddress(peerAddress(c))) {
        return c.json(errorBody('unauthorized', '访问令牌只能在运行 Stream 的那台机器上查看'), 403)
      }
      // 连 URL 一起给：手机上要用的是"一条能点开的链接"，不是让人手抄 64 位十六进制。
      // 端口取自本次请求的 Host（就是用户实际访问的那个口），地址取本机的非 loopback 网卡。
      const port = (c.req.header('Host') ?? '').split(':')[1] || '8900'
      return c.json({ token: guardToken, urls: lanUrls(port, guardToken) })
    })
  }

  // 扩展安装引导的三个动作（spec 2026-08-30-extension-onboarding §8）。
  //
  // **注册在门之后**，和只读的 `/api/browser-capability` 不一样：那个是快判，装机引导要在拿到
  // 凭证之前就能读；这三个里有两个会**动用户的桌面**（install 驱动他自己的 Chrome）和落盘
  // （decline）。凡是有副作用的都不进免检名单。
  if (deps.extensionOnboarding) {
    const onboarding = deps.extensionOnboarding

    app.get('/api/extension/onboarding', (c) => c.json(onboarding.state()))

    // 把扩展目录物化出来，回绝对路径。手动装那条路也调它——**两条路必须指向同一个目录**，
    // 否则排查时会出现两个路径，而用户念的和 agent 选的分家。
    app.post('/api/extension/materialize', (c) => {
      try {
        return c.json(onboarding.materialize())
      } catch (e) {
        return c.json(errorBody('internal', (e as Error).message), 500)
      }
    })

    // 代装。**不做超时包裹**：引擎自己有等待上界（等窗口、等中继），在这里再套一层只会
    // 制造一个"超时了但那边还在点用户的浏览器"的窗口。三态回执原样透出，`blocked` 的
    // reason 一个字都不改——它指名了是哪一步的哪个控件，收窄成"装不上"就等于扔掉排查线索。
    app.post('/api/extension/install', async (c) => {
      try {
        return c.json(await onboarding.install())
      } catch (e) {
        // 抛出来 = 这一趟**根本没跑起来**（Stream Desktop 没连、租约拿不到）。它和 `blocked`
        // （跑了、卡在某一步）是两件事，混成一个回答会把排查引向错误的一端。
        return c.json(errorBody('internal', (e as Error).message), 500)
      }
    })

    // 卸载。同 install：三态回执原样透出，`blocked` 的 reason 一个字都不改。
    app.post('/api/extension/uninstall', async (c) => {
      try {
        return c.json(await onboarding.uninstall())
      } catch (e) {
        return c.json(errorBody('internal', (e as Error).message), 500)
      }
    })

    // 重载。同 install：三态回执原样透出。调用方先 materialize，再调这个。
    app.post('/api/extension/reload', async (c) => {
      try {
        return c.json(await onboarding.reload())
      } catch (e) {
        return c.json(errorBody('internal', (e as Error).message), 500)
      }
    })

    // 读扩展后台控制台。POST 不是 GET：它会在用户的 Chrome 里开窗、点链接。
    app.post('/api/extension/console', async (c) => {
      try {
        return c.json(await onboarding.readConsole())
      } catch (e) {
        return c.json(errorBody('internal', (e as Error).message), 500)
      }
    })

    app.post('/api/extension/decline', (c) => {
      onboarding.decline()
      return c.body(null, 204)
    })
  }

  // live needs-login projection: which facilities are showing an auth wall right now.
  // Guarded so callers/tests that don't wire authFacilities still build the app.
  // 先对账再回答：这个端点是重登面板打开时读的，而横幅本身只在一次采集跑完时才更新。
  // 用户在浏览器里自己登录回来的情况下，不对账就会给他弹一个"你需要登录"的二维码 —— 而他
  // 明明已经登录了。对账只在确实有横幅挂着时才发远程调用，所以正常情况下这里是零成本。
  // 对账失败不能挡住回答：拿缓存的投影答，总比 500 好。
  if (deps.authFacilities)
    app.get('/api/auth/facilities', async (c) => {
      await deps.reconcileAuth?.().catch(() => {})
      return c.json(deps.authFacilities!())
    })

  /**
   * 「在浏览器里完成登录」——平台又加了一步我们渲染不了的验证（滑块 / 短信 / 二次扫码）时，
   * 把那个标签放到用户面前，让他自己做完。Stream 不去理解那一步是什么，只负责把人送到。
   *
   * 抢屏在这里正当：它由用户点击触发，而且他点的就是"去浏览器里弄"。
   */
  if (deps.focusLoginTab)
    app.post('/api/auth/facilities/:facility/focus', async (c) => {
      const facility = c.req.param('facility')
      const focused = await deps.focusLoginTab!(facility).catch(() => false)
      // 没有 lane（还没点过「重新登录」，标签压根没开）→ 明确回 409，让前端说人话，
      // 而不是回 200 让用户以为点了但浏览器没反应。
      if (!focused) return c.json(errorBody('conflict', '还没有打开的登录标签，先点「重新登录」'), 409)
      return c.json({ focused: true })
    })

  if (deps.events) {
    app.get('/api/events', (c) => {
      const since = c.req.query('since')
      const types = c.req.query('types')
      return c.json(deps.events!.list({
        since: since ? Number(since) : undefined,
        types: types ? types.split(',') : undefined,
      }))
    })
    app.post('/api/events/read', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { ids?: number[]; all?: boolean }
      const gate = strictBody(c, body, EVENTS_READ_KEYS)
      if (gate) return gate
      deps.events!.markRead(body)
      return c.json({ ok: true })
    })
  }

  // full named streams (id/description + sources/params/cadence) for the UI. For audio
  // (歌单) streams, attach `image` = the cover of the most recent stored item that has one,
  // so the music view can show playlist covers. Cheap: only audio streams, small limit.
  app.get('/api/streams', (c) => {
    const streams = deps.service.streamsResource()
    // audio-ness is derived from Channel membership (present='audio'), not a stored flag.
    const audioIds = deps.channelStore?.audioStreamIds() ?? new Set<string>()
    const withCovers = streams.map((s) => {
      if (!audioIds.has(s.id)) return s
      const recent = deps.itemStore.recent({ stream: s.id, limit: 30 })
      let image: string | undefined
      for (const it of recent) {
        const media = it.content?.media ?? []
        const audioCover = media.find((m) => m.kind === 'audio' && !!m.poster)
        const cover =
          (audioCover && 'poster' in audioCover ? audioCover.poster : undefined) ??
          media.map((m) => ('poster' in m ? m.poster : 'image' in m ? m.image : undefined)).find((p) => !!p)
        if (cover) {
          image = cover
          break
        }
      }
      return image ? { ...s, image } : s
    })
    return c.json(withCovers)
  })

  // Live preview — fetch + normalize a stream (or one source with ad-hoc params) WITHOUT
  // persisting, so a source's render/effect can be eyeballed before it's committed. No
  // store, no dedup, no health-ledger write. Per-source fetch failures come back as
  // `errors` (classified reason), never a 5xx, so one bad source can't blank the preview.
  app.get('/api/streams/:id/preview', async (c) => {
    const limit = Number(c.req.query('limit')) || undefined
    try {
      return c.json(await deps.service.previewStream(c.req.param('id'), { limit }))
    } catch (e) {
      return c.json(errorBody('not_found', (e as Error).message), 404)
    }
  })

  app.post('/api/sources/preview', async (c) => {
    const body = await c.req.json().catch(() => undefined)
    const gate = strictBody(c, body, SOURCE_PREVIEW_KEYS)
    if (gate) return gate
    if (!isObject(body) || typeof body.sourceId !== 'string' || !body.sourceId) {
      return c.json(errorBody('validation_error', 'sourceId required'), 400)
    }
    const params = isObject(body.params) ? (body.params as Record<string, unknown>) : {}
    return c.json(await deps.service.previewSource(body.sourceId, params))
  })

  // Manual re-harvest — a real persisted tick, for verifying re-fetch on demand (vs
  // preview, which never persists). Returns { fetched, written }. Unknown stream → 404.
  app.post('/api/streams/:id/refresh', async (c) => {
    try {
      const streamId = c.req.param('id')
      const refreshed = await deps.service.refreshStream(streamId)
      return c.json(refreshed)
    } catch (e) {
      return c.json(errorBody('not_found', (e as Error).message), 404)
    }
  })

  // 频道级重新抓取：扇出到该频道的全部成员流，各跑一次真实 tick。
  //
  // 为什么是一个端点而不是让前端连发 N 个：扇出策略（并发上限、部分失败怎么算、结果怎么汇总）
  // 是服务端的事——放前端等于每个调用方各写一遍，而且第一版一定写成无上限的 Promise.all。
  //
  // **部分失败仍回 200**：某个 facility 掉了登录态、某个源超时，是这条链路的常态；把整次请求判失败
  // 会让另外 6 条成功的抓取在 UI 上一起消失。失败逐条记在 `streams[].error` 里，`failed` 给个总数，
  // 由调用方决定怎么讲这件事。
  app.post('/api/channels/:id/refresh', async (c) => {
    if (!deps.channelStore) return c.json(errorBody('unavailable', 'channels not configured'), 503)
    const channel = deps.channelStore.getChannel(c.req.param('id'))
    if (!channel) return c.json(errorBody('not_found', 'channel not found'), 404)
    return c.json(await refreshStreams(channel.stream_ids, (id) => deps.service.refreshStream(id)))
  })

  // Advance a stream's read watermark to its newest stored item (marks it "seen"): the
  // 正在追的 badge clears. Idempotent (StreamSeenStore.markSeen only advances).
  app.post('/api/streams/:id/seen', (c) => {
    if (!deps.seenStore) return c.json(errorBody('unavailable', 'seen store not configured'), 503)
    const id = c.req.param('id')
    const seen_seq = deps.seenStore.markSeen(id, deps.itemStore.maxSeq(id))
    return c.json({ stream_id: id, seen_seq })
  })

  app.post('/api/streams', async (c) => {
    if (!deps.channelStore) return c.json(errorBody('unavailable', 'channels not configured'), 503)
    const body = await c.req.json().catch(() => undefined)
    // 闸在形状校验**之前**：写错名字时「你写的是 sources，该写 members」比
    // 「members must be an array」有用得多——判据与理由见 http/strict-input.ts。
    const gate = strictBody(c, body, STREAM_CREATE_KEYS)
    if (gate) return gate
    const err = streamValidationError(body)
    if (err || !isObject(body) || typeof body.id !== 'string' || body.id.length === 0) {
      return c.json(errorBody('validation_error', err ?? 'id must be a string'), 400)
    }
    // `channel_id`：建流的同时就把归属定下来，一次请求内完成。
    //
    // 为什么必须在这里、而不是让调用方建完再 PATCH 频道：两步之间存在一个「这条流不属于任何
    // 频道」的中间态，而 `isCollected` 对**没被任何频道引用**的流答 true（默认是对的——没归属的
    // 流通常就是一条独立资源流，新建即抓一次是既有行为，**别去改那条判据**）。于是一条马上要归
    // research（live present，现读不落库）的流在第一步就被排班并立刻 tick 一次；第二步撤出调度
    // 已经晚了，那一次 tick 的东西已经进了库——research 源一次 tick 返回目录里每个 run 各一条。
    // 修的是顺序：先记归属，再问判据。
    const channelId = body.channel_id
    if (channelId !== undefined && (typeof channelId !== 'string' || channelId.length === 0)) {
      return c.json(errorBody('validation_error', 'channel_id must be a non-empty string'), 400)
    }
    // 认不出的频道要**响亮地**拒绝：静默忽略等于建出一条没人要的流，而调用方以为绑上了。
    const channel = channelId === undefined ? null : deps.channelStore.getChannel(channelId)
    if (channelId !== undefined && !channel) {
      return c.json(errorBody('validation_error', `channel not found: ${channelId}`), 400)
    }
    if (deps.channelStore.getStream(body.id)) return c.json(errorBody('conflict', 'stream id already exists'), 409)
    const created = deps.channelStore.putStream({
      id: body.id,
      label: body.label as string,
      strategy: body.strategy as StreamRecord['strategy'],
      cadence_seconds: body.cadence_seconds as number,
      members: body.members as SourceBinding[],
      contract: body.contract as Record<string, unknown> | undefined,
      options: body.options as Record<string, unknown>,
    })
    // 绑定在判据**之前**：`applyCollectionPolicy` 读的是「这条流现在归谁」，先绑才问得到真话。
    // 追加到服务端当下的成员表末尾（不是调用方递来的快照），顺带避开「拿着陈旧 stream_ids
    // 覆盖回去」那类丢更新。
    if (channel) deps.channelStore.patchChannel(channel.id, { stream_ids: [...channel.stream_ids, created.id] })
    // 无条件排班曾是这里的写法——一条建完就要挪进 research 频道的流也会当场开始采集。
    applyCollectionPolicy([created.id])
    // 建流时直接绑进一个 research 频道 → 这条流现在该有 watcher 了。
    deps.onChannelsChanged?.()
    return c.json(created, 201)
  })

  // Subscribe straight from a URL: radar-match → user-chosen source → build the member → create
  // the Stream. Keeps the companion extension thin — it POSTs {input, sourceId}, Stream resolves.
  app.patch('/api/streams/:id', async (c) => {
    if (!deps.channelStore) return c.json(errorBody('unavailable', 'channels not configured'), 503)
    const id = c.req.param('id')
    const current = deps.channelStore.getStream(id)
    if (!current) return c.json(errorBody('not_found', 'stream not found'), 404)
    const body = await c.req.json().catch(() => undefined)
    const err = streamValidationError(body, true)
    if (err || !isObject(body)) return c.json(errorBody('validation_error', err ?? 'body must be an object'), 400)
    // 传 `sources`（正确是 `members`）曾经拿到 200 + 一个完整的 stream 对象，看上去就像改成功了。
    // 判据与理由见 http/strict-input.ts。
    const badField = unknownKey(Object.keys(body), STREAM_PATCH_KEYS)
    if (badField) return c.json(errorBody('validation_error', unknownKeyMessage('字段', badField, STREAM_PATCH_KEYS)), 400)
    const next: StreamRecord = {
      ...current,
      label: body.label !== undefined ? body.label as string : current.label,
      strategy: body.strategy !== undefined ? body.strategy as StreamRecord['strategy'] : current.strategy,
      cadence_seconds: body.cadence_seconds !== undefined ? body.cadence_seconds as number : current.cadence_seconds,
      members: body.members !== undefined ? body.members as SourceBinding[] : current.members,
      contract: body.contract !== undefined ? body.contract as Record<string, unknown> | undefined : current.contract,
      // options merge shallowly (PATCH semantics) — a caller toggling one flag
      // (e.g. autoDownload) must not clobber vault_subdir/kind/ad_filter siblings.
      options: body.options !== undefined ? { ...current.options, ...(body.options as Record<string, unknown>) } : current.options,
    }
    const needsReschedule = next.cadence_seconds !== current.cadence_seconds || JSON.stringify(next.members) !== JSON.stringify(current.members)
    const updated = deps.channelStore.putStream(next)
    // cadence/members change → full reschedule (new timer + immediate re-fetch).
    // metadata-only change (label, ad_filter, vault_subdir…) → refresh the scheduler's
    // in-memory copy so `/api/streams` reflects it, but keep the timer and skip re-fetch.
    // `rescheduleResourceStream` 是 remove + **无条件** add：对 live present（research/search）
    // 的流，改一次 cadence/members 就把它放回采集队列，且一直采到重启。而改 members 正是这类流
    // 的常规操作（换 artifactsDir、加减源都从频道页发这条 PATCH）。判据同源，见 applyCollectionPolicy。
    if (needsReschedule) {
      if (deps.channelStore.isCollected(id)) deps.service.rescheduleResourceStream(streamRecordToStream(updated))
      else deps.service.unscheduleResourceStream(id)
    } else deps.service.updateResourceStream(streamRecordToStream(updated))
    // 改成员表就可能换掉 artifacts 目录（换 artifactsDir、加减源都从频道页发这条 PATCH）——
    // 老 watcher 盯着的目录已经不是这条流的了，必须停掉重起。
    if (needsReschedule) deps.onChannelsChanged?.()
    return c.json(updated)
  })

  app.delete('/api/streams/:id', (c) => {
    if (!deps.channelStore) return c.json(errorBody('unavailable', 'channels not configured'), 503)
    const id = c.req.param('id')
    if (!deps.channelStore.getStream(id)) return c.json(errorBody('not_found', 'stream not found'), 404)
    deps.channelStore.removeStream(id)
    deps.service.unscheduleResourceStream(id)
    // 流没了（removeStream 同步从所有 channel.stream_ids 摘除）→ 它的 watcher 要停。
    deps.onChannelsChanged?.()
    return c.json({ ok: true })
  })

  app.post('/api/streams/:id/playlist-export', async (c) => {
    if (!deps.channelStore) return c.json(errorBody('unavailable', 'channels not configured'), 503)
    if (!deps.audioArchive) return c.json(errorBody('unavailable', 'audio archive not configured'), 503)
    const id = c.req.param('id')
    const stream = deps.channelStore.getStream(id)
    if (!stream) return c.json(errorBody('not_found', 'stream not found'), 404)
    // 顺序去问歌单本身，不问库里的入库顺序——理由见 scheduler.readStreamInSourceOrder 的头注
    // （两个方向都试错过；`seq` 只在"一次性整份回填"时才碰巧等于歌单顺序）。
    let snapshot
    try {
      snapshot = await deps.service.readStreamInSourceOrder(id)
    } catch (e) {
      return c.json(errorBody('internal', (e as Error).message), 500)
    }
    // 取不到就**别写**。写一份顺序不对的 m3u 会当场覆盖上一份好的，而用户在播放器里
    // 看不出它是错的——静默失真比一次响亮的失败贵得多。
    if (snapshot.errors.length) {
      return c.json(errorBody('upstream_error', `歌单当前取不到，没有导出（顺序只能问歌单本身）：${snapshot.errors.map((e) => e.reason).join('; ')}`), 502)
    }
    const refs = snapshot.items
      .map((it) => extractTrackRef(it as unknown as Item))
      .filter((r): r is NonNullable<typeof r> => !!r)
    try {
      return c.json(exportPlaylistM3u(deps.audioArchive, stream.label, refs))
    } catch (e) {
      return c.json(errorBody('internal', (e as Error).message), 500)
    }
  })

  /**
   * 这部作品实际生效的绑定：先按 TMDb 坐标查；验不出坐标（综艺 / 无 canonical）时，若调用方给了
   * `streamId` 就回退按关注流查——否则非 TMDb 的关注流绑了网盘，详情页也永远够不着它。
   */
  function workBindingSet(detail: VideoDetail, streamId?: string): MappingSet | undefined {
    if (!deps.netdisk) return undefined
    const ref = tmdbWorkRef(detail)
    if (ref) { const s = deps.netdisk.bindingForTmdb(ref.id, ref.media); if (s) return s }
    // bindingForStream 可选调用：注入的 netdisk 可能是只实现了部分方法的替身，缺则视作无 stream 绑定。
    if (streamId) return deps.netdisk.bindingForStream?.(streamId)
    return undefined
  }

  /**
   * 作品级绑定视图：这部片子能不能绑网盘、绑没绑、绑了的话哪几集配上了文件。
   *
   * 详情页要它才有入口可显示。`ref` 反映能否**按 TMDb 新建**绑定（null = canonical 没验出坐标）；
   * `binding` 反映**实际绑没绑**（含非 TMDb 的关注流绑定）——两者独立：一个综艺可以 `ref:null` 却已绑，
   * UI 据此显示绑定信息而不是「还不能绑」。
   */
  function workBindingView(detail: VideoDetail, streamId?: string): {
    ref: ReturnType<typeof tmdbWorkRef>
    binding?: {
      id: string; dirPath: string; lastSyncAt?: string
      /** `total` 只数已播出的集（含已配上的）；`unaired` 是还没播/未定档的占位数，不在 `total` 里。 */
      total: number; matched: number; unaired: number
      /** 已配上文件、可以直接播的条目（电影 1 条）。leftKey 直接喂 resolve?key=——播放侧键无关。 */
      playable: Array<{ leftKey: string; title: string }>
      /** 「跳转网盘」目标（夸克文件夹 web URL）；解析不到/非夸克 → 缺省，前端回落 AList 网关链接。 */
      netdiskUrl?: string
      /** 坏绑定标记：目录已从网盘删/移（AList object-not-found），前端亮出来。缺省 = 健康。 */
      broken?: { at: string; message: string }
      /** 追更状态（spec 2026-09-03-work-follow-loop）。缺省 = 不追（存量绑定 / 电影）。 */
      follow?: { enabled: boolean; nextCheckAt?: string; lastCheckAt?: string; dryRuns: number }
    }
  } {
    const set = workBindingSet(detail, streamId)
    return { ref: tmdbWorkRef(detail), binding: set ? workBindingViewOf(set) : undefined }
  }

  /** workBindingView + 解析「跳转网盘」URL（夸克 fid，异步）。首次解析后 fid 缓存在绑定上，之后近乎免费。 */
  async function workBindingViewWithUrl(detail: VideoDetail, streamId?: string): Promise<ReturnType<typeof workBindingView>> {
    const work = workBindingView(detail, streamId)
    if (work.binding) {
      const set = workBindingSet(detail, streamId)
      const url = set && deps.netdisk ? await deps.netdisk.browseUrl(set) : null
      if (url) work.binding.netdiskUrl = url
    }
    return work
  }

  /**
   * 「转存→自动绑定」用的作品坐标——强一致检查点：title 必须来自服务端核实的详情（canonical/
   * metadata 的真名，tmdbWorkRef 已拒绝 id 冒充），调用方传的 title 只当身份提示。核实不出 → null，
   * 调用方据此拒绝闭环，而不是拿 id 起目录名。videoDetails 未配置时无从核实，降级为「提示不是
   * id 回显才收」。
   */
  async function verifiedWorkRef(req: { id: string; media: 'movie' | 'tv'; title?: string; year?: number }): Promise<TmdbWorkRef | null> {
    if (deps.videoDetails) {
      const result = await deps.videoDetails.get(videoTmdbLookupIdentity({ id: req.id, media: req.media, title: req.title || req.id }))
      const ref = tmdbWorkRef(result.detail)
      return ref && ref.id === req.id && ref.media === req.media ? ref : null
    }
    return req.title?.trim() && req.title !== req.id
      ? { id: req.id, media: req.media, title: req.title, ...(typeof req.year === 'number' ? { year: req.year } : {}) }
      : null
  }

  /** 一个绑定 → 前端要的视图（配上几集、哪些能播）。转存自动绑定后直接返回它，前端不必再拉详情。 */
  function workBindingViewOf(set: MappingSet) {
    const matchedEntries = set.entries.filter((e) => e.rightFile && (e.status === 'auto' || e.status === 'confirmed'))
    // 分母只数已播出的集（`progressOf`）：TMDb 先列出整季占位，还没播的混进分母就把「一集不缺」
    // 显示成「缺 4 集」。`unaired` 单独给，前端要说「另有 N 集未播」。
    const progress = progressOf(set.entries, new Date().toISOString().slice(0, 10))
    return {
      id: set.id, dirPath: set.right.path, lastSyncAt: set.lastSyncAt,
      total: progress.total, matched: progress.matched, unaired: progress.unaired,
      playable: matchedEntries.map((e) => ({ leftKey: e.leftKey, title: e.leftTitle })),
      // 绑定级健康态：目录已从网盘删/移（AList object-not-found）。前端据此在面板亮坏绑定标记。
      ...(set.broken ? { broken: set.broken } : {}),
      ...(set.follow ? { follow: set.follow } : {}),
    }
  }

  /**
   * 分季分集树 —— 详情页「真剧集」才长出来。approach C（见 2026-07-18 spec §1）：
   *  - canonical 到 TMDb `tv`：树 + 剧照来自 TMDb 分集索引（懒加载一次、投影缓存进 video_details、
   *    命中不重抓）；**每集能不能播**再从网盘绑定的 entries 按 leftKey 叠上去。已绑/未绑同一条路，
   *    区别只是有没有可播集——这样两种情况都有 Jellyfin 那样的 16:9 剧照。
   *  - `movie` / 综艺 / 没 canonical → undefined，前端据此维持扁平采集 grid。
   *
   * 索引取不到（TMDb 挂了且无缓存）但已绑 → 回落用 entries 铺树（无剧照），保住老行为不至于整棵消失。
   *
   * 红线（2026-07-17 §4.3）：绝不为 movie/未 canonical 发 TMDb 请求；缓存只存投影后的
   * leftKey+title+still+airDate（几个短字符串），绝不是那 1MB 的 overview/crew。
   */
  async function seasonsFor(detail: VideoDetail): Promise<ReturnType<typeof buildSeasons>> {
    const ref = tmdbWorkRef(detail)
    if (!ref || ref.media !== 'tv') return undefined
    const set = deps.netdisk?.bindingForTmdb(ref.id, ref.media)
    // 能播的 leftKey 集合（配上了文件的集）——叠在权威分集树上，决定每集是播放还是找资源。
    const playableKeys = new Set(
      (set?.entries ?? []).filter((e) => e.rightFile && (e.status === 'auto' || e.status === 'confirmed')).map((e) => e.leftKey),
    )
    // 树 + 剧照来自 TMDb 索引：缓存优先，未命中懒加载一次。
    let index = detail.episodeIndex?.entries
    if (!index && deps.episodeIndex && deps.videoDetails) {
      try {
        index = await deps.episodeIndex(ref)
        deps.videoDetails.cacheEpisodeIndex(detail, index)
      } catch { index = undefined }
    }
    if (index) {
      return buildSeasons('tv', index.map((e) => ({ leftKey: e.leftKey, title: e.title, still: e.still, airDate: e.airDate, playable: playableKeys.has(e.leftKey) })))
    }
    // 索引拿不到但已绑 → 回落 entries（无剧照），别让整棵树消失。
    if (set) {
      return buildSeasons('tv', set.entries.map((e) => ({ leftKey: e.leftKey, title: e.leftTitle, playable: playableKeys.has(e.leftKey) })))
    }
    return undefined
  }

  /**
   * 统一作品详情端点 —— 收敛 /api/streams|items|tmdb 三条「按身份取详情」的旧端点（见 2026-07-20
   * search 设计 §10）。`:key` 三形态都汇到同一个 `videoDetails.get(identity)`：
   *   stream:<id>            关注流（额外回带 episodes + stream 元信息）
   *   item:<id>             榜单条目（保留 douban-discovery 兜底）
   *   tmdb:<movie|tv>:<id>  已知 tmdb id（canonical 快速路径，无 Item/Stream）
   * 响应里 `binding` 是这部作品的**网盘绑定视图**（旧端点里那个叫 `work` 的字段——它其实是绑定视图、
   * 不是作品本身；本次收敛顺带把字段名从 `work` 正过来叫 `binding`）。POST …/refresh 强制重取。
   */
  const workDetailHandler = async (c: Context, force: boolean) => {
    if (!deps.videoDetails) return c.json(errorBody('unavailable', 'video detail is not configured'), 503)
    const key = c.req.param('key') ?? ''
    const sep = key.indexOf(':')
    const kind = sep === -1 ? key : key.slice(0, sep)
    const rest = sep === -1 ? '' : key.slice(sep + 1)
    if (kind === 'stream') {
      if (!deps.channelStore) return c.json(errorBody('unavailable', 'video detail is not configured'), 503)
      const stream = deps.channelStore.getStream(rest)
      if (!stream) return c.json(errorBody('not_found', 'stream not found'), 404)
      const allEpisodes = deps.itemStore.recent({ stream: stream.id, limit: 200, order: 'asc' })
      const episodes = gateResolveOnlyVideoMedia(
        allEpisodes.filter((item) => !item.muted),
        deps.netdisk ? (k) => deps.netdisk!.lookup(k) : undefined,
        deps.netdisk ? (streamId) => deps.netdisk!.hasBindingForStream(streamId) : undefined,
        (streamId) => deps.channelStore!.videoStreamIds().has(streamId),
      )
      const result = await deps.videoDetails.get(videoLookupIdentity(stream, allEpisodes), { force })
      return c.json({ stream: { id: stream.id, label: stream.label }, episodes, detail: result.detail, cache: result.cache, binding: await workBindingViewWithUrl(result.detail, stream.id), seasons: await seasonsFor(result.detail) })
    }
    if (kind === 'item') {
      const item = deps.itemStore.get(rest)
      if (!item) return c.json(errorBody('not_found', 'item not found'), 404)
      const result = await deps.videoDetails.get(videoWorkLookupIdentity(item), { force })
      const fallback = !result.detail.metadata ? videoDiscoveryFallback(item) : null
      const detail = fallback ? { ...result.detail, metadata: fallback } : result.detail
      return c.json({ item, detail, cache: result.cache, binding: await workBindingViewWithUrl(detail, item.stream_id), seasons: await seasonsFor(detail) })
    }
    if (kind === 'tmdb') {
      const msep = rest.indexOf(':')
      const media = msep === -1 ? '' : rest.slice(0, msep)
      const id = msep === -1 ? '' : rest.slice(msep + 1)
      if ((media !== 'movie' && media !== 'tv') || !id) return c.json(errorBody('validation_error', 'tmdb key must be tmdb:<movie|tv>:<id>'), 400)
      const title = c.req.query('title') || id
      const result = await deps.videoDetails.get(videoTmdbLookupIdentity({ id, media, title }), { force })
      return c.json({ detail: result.detail, cache: result.cache, binding: await workBindingViewWithUrl(result.detail), seasons: await seasonsFor(result.detail) })
    }
    return c.json(errorBody('validation_error', 'key must be stream:<id> | item:<id> | tmdb:<movie|tv>:<id>'), 400)
  }
  app.get('/api/video/works/:key', (c) => workDetailHandler(c, false))
  app.post('/api/video/works/:key/refresh', (c) => workDetailHandler(c, true))

  // 把这几条流的调度状态对齐到「该不该采集」。真身在 store/collection-policy.ts（HTTP 这条路
  // 和 bootstrap 那条 `reconcile_open` 重排班通道同吃一份），判据出处见那里的头注。
  const applyCollectionPolicy = (streamIds: Iterable<string>): void =>
    applyCollectionPolicyTo(deps.channelStore, deps.service, streamIds)

  // Named channels — explicit (user store) + implicit solo channels for ungrouped streams.
  // A channel groups 1+ streams under a user-facing label; MusicChannel reads from here.
  //
  // 一份构建代码，两个端点共用（GET /api/channels 和 PATCH /api/channels/:id 的返回体）。
  // 别为 PATCH 另写一个"轻量版"投影：同一资源返回两种形状，正是前端"写完手工合并本地快照"
  // 那类丢更新的温床（见 docs/superpowers/specs/2026-07-27-channel-record-shared-state-design.md）。
  // `null` = channels not configured（调用方翻译成 503）。
  const buildChannelViews = (kindFilter?: string) => {
    if (!deps.channelStore) return null
    const allStreams = deps.service.streamsResource()
    const streamMap = new Map(allStreams.map((s) => [s.id, s]))
    const groupedIds = deps.channelStore.referencedStreamIds()
    const audioIds = deps.channelStore.audioStreamIds()

    // cover enrichment helper — same logic as /api/streams. audio-ness is derived from
    // Channel membership (present='audio'), not a stored stream flag.
    const coverOf = (s: typeof allStreams[number]): string | undefined => {
      if (!audioIds.has(s.id)) return undefined
      const recent = deps.itemStore.recent({ stream: s.id, limit: 30 })
      for (const it of recent) {
        const media = it.content?.media ?? []
        const audioCover = media.find((m) => m.kind === 'audio' && !!m.poster)
        const cover =
          (audioCover && 'poster' in audioCover ? audioCover.poster : undefined) ??
          media.map((m) => ('poster' in m ? m.poster : 'image' in m ? m.image : undefined)).find((p) => !!p)
        if (cover) return cover
      }
      return undefined
    }

    // Work synopsis (作品简介) for the level-2 detail page — the feed-level description stamped onto
    // items at harvest (stampFeedFields). One value per work; take the first item that carries it.
    const videoWorkSynopsis = (streamId: string): string | undefined => {
      for (const it of deps.itemStore.recent({ stream: streamId, limit: 30 })) {
        const syn = (it.raw as { __feedSynopsis?: unknown } | undefined)?.__feedSynopsis
        if (typeof syn === 'string' && syn.trim()) return syn.trim()
      }
      return undefined
    }

    const registry = deps.resolve?.registry
    const sourceHealth = deps.resolve?.sourceHealth
    // 「它依赖的东西坏了吗」——整份请求算一次（`uses` 反着读，见 `brokenDependencies`）。
    // 一切健康时（常态）连一次图遍历都不发生。账本的 key 是取数时写下的 id，可能是存量形状，
    // 所以这里同时留一张 全名 → 账本 key 的表，别在下游拿全名去查账本。
    const brokenLedgerKey = new Map<string, string>()
    for (const [key, h] of Object.entries(sourceHealth?.snapshot() ?? {})) {
      if (h.state === 'healthy') continue
      const full = quietGet(registry, key)?.id ?? key
      if (!brokenLedgerKey.has(full)) brokenLedgerKey.set(full, key)
    }
    const brokenDeps = registry && brokenLedgerKey.size
      ? brokenDependencies((id) => registry.affectedSources(id), [...brokenLedgerKey.keys()])
      : new Map<string, string[]>()

    const expandStream = (s: typeof allStreams[number]) => {
      const members = s.sources.map((src) => {
        const pluginId = src.plugin_id || ''
        const sourceTemplateId = src.source_template_id || ''
        const sourceId = (pluginId && sourceTemplateId)
          ? canonicalSourceId(pluginId, sourceTemplateId)
          : (src.source_id || canonicalSourceId(pluginId, sourceTemplateId))
        const manifest = registry?.get(sourceId)
        // The Source's display identity is the SINGLE publicSource() projection, nested
        // verbatim under `source` — same object the plugin catalog serves. Binding-specific
        // fields (params/health/active) sit alongside it, never flattened into it. Do NOT
        // hand-pick or rename projection fields here: that is what diverged the two surfaces.
        const source = manifest ? publicSource(manifest) : fallbackSource(sourceId)
        // health only for resolvable bindings: the ledger tracks FETCH outcomes, and a
        // member whose manifest is gone never fetches — its ledger entry (if any) is a
        // stale pre-deletion "healthy". Reporting nothing beats lying green.
        const health = manifest ? sourceHealth?.stateOf(sourceId) : undefined
        const healthError = manifest ? healthErrorOf(sourceHealth, sourceId, health) : undefined
        // 这一格和 `health` 是两件事：`health` 说「我自己采得动吗」，这一格说「我依赖的东西
        // 还在吗」。前者绿着而后者有值，正是那个静音故障——采集次次成功，产出却是残的。
        const dependencyIssues = manifest
          ? dependencyIssuesOf(registry, sourceHealth, brokenDeps, brokenLedgerKey, manifest)
          : undefined
        return {
          source,
          params: src.params,
          ...(health ? { health } : {}),
          ...(healthError ? { healthError } : {}),
          ...(dependencyIssues ? { dependencyIssues } : {}),
        } as { source: typeof source; params: Record<string, unknown>; health?: string; active?: boolean; healthError?: HealthErrorView; dependencyIssues?: DependencyIssueView[] }
      })
      // exclusive ladder: mark the current winning rung (first healthy member)
      if (s.strategy === 'exclusive') {
        const winner = members.findIndex((m) => m.health === 'healthy')
        if (winner >= 0) members[winner].active = true
      }
      return {
        id: s.id,
        description: s.description,
        image: coverOf(s),
        strategy: s.strategy,
        sources: members,
        cadence_seconds: s.cadence_seconds,
        vault_subdir: s.vault_subdir,
        ad_filter: s.ad_filter,
        title_include: s.title_include,
        harvest: s.harvest,
        newCount: undefined as number | undefined,
        synopsis: undefined as string | undefined,
      }
    }

    const channels: Array<{
      id: string
      label: string
      description?: string
      kind: string
      present: string
      system?: boolean
      image?: string
      streams: ReturnType<typeof expandStream>[]
      options?: Record<string, unknown>
      /** 归属的空间（侧栏分组那一层）。solo 频道没有存放处，恒为默认空间。 */
      space_id: string
    }> = []

    // explicit channels — streams resolved by reference from the user store
    for (const def of deps.channelStore.listChannels()) {
      const defStreams = deps.channelStore.streamsOf(def.id).map(streamRecordToStream)
      const expanded = defStreams.map(expandStream)
      // 正在追的: a stream in the「正在追」系统列表(见 collections/store.ts)— attach an unread count.
      // Its PRESENCE (not a separate flag) is what marks a stream as followed; the frontend splits
      // on it. 真因(2026-07-20): 以前只要是非榜单成员就算「正在追」,用户随手把一个自定义 stream
      // 加进频道就会自动出现在这里,没有真正的收藏动作。榜单成员仍然直接排除(它们是图表行,从来
      // 不是可收藏的单一作品)。
      if (def.present === 'video' && deps.seenStore && deps.collections) {
        const rankingIds = new Set(VIDEO_RANKING_STREAMS.map((r) => r.id))
        for (const s of expanded) {
          if (rankingIds.has(s.id) || !deps.collections.isIn(SYSTEM_COLLECTIONS.videoFollowing, { kind: 'stream', streamId: s.id })) continue
          const seen = deps.seenStore.seenSeq(s.id) ?? 0
          s.newCount = deps.itemStore.newCountSince(s.id, seen)
          s.image = videoWorkCover(deps.itemStore, s.id) // level-1 work poster (album cover), not an episode thumb
          s.synopsis = videoWorkSynopsis(s.id) // level-2 作品简介
        }
      }
      const opts = def.options as { description?: string; image?: string }
      const image = expanded.find((s) => s.image)?.image ?? opts.image
      channels.push({
        id: def.id,
        label: def.label,
        description: opts.description,
        kind: def.present,
        present: def.present,
        system: def.system,
        image,
        streams: expanded,
        // 能力槽位设置(频道详情页)要读回当前选择——options 就是唯一真相源(见 channelSlotsError)。
        options: def.options as Record<string, unknown>,
        space_id: def.space_id,
      })
    }

    // solo channels for ungrouped streams (flow-management or dynamically scheduled streams)
    for (const s of allStreams) {
      if (groupedIds.has(s.id)) continue
      const expanded = expandStream(s)
      const present = audioIds.has(s.id) ? 'audio' : 'timeline'
      channels.push({
        id: s.id,
        label: s.description || s.id,
        kind: present,
        present,
        image: expanded.image,
        streams: [expanded],
        // solo 频道没有 channels 行，也就没有可存归属的地方——恒落默认空间。要把它挪去
        // 别的空间，得先让它变成一个真频道（否则挪完没有任何地方记得住）。
        space_id: DEFAULT_SPACE_ID,
      })
    }

    return kindFilter ? channels.filter((ch) => ch.kind === kindFilter) : channels
  }

  app.get('/api/channels', (c) => {
    const views = buildChannelViews(c.req.query('kind') || undefined)
    if (!views) return c.json({ error: 'channels not configured' }, 503)
    return c.json(views)
  })

  // ── 空间（频道之上那一层，侧栏的分组）。只有 label + position 两个属性，所以是四条
  //    平铺的 CRUD，没有投影层：GET 直接回记录，前端拿它画侧栏的分组标题。
  app.get('/api/spaces', (c) => {
    if (!deps.channelStore) return c.json(errorBody('unavailable', 'channels not configured'), 503)
    return c.json(deps.channelStore.listSpaces())
  })

  app.post('/api/spaces', async (c) => {
    if (!deps.channelStore) return c.json(errorBody('unavailable', 'channels not configured'), 503)
    const body = await c.req.json().catch(() => undefined)
    const gate = strictBody(c, body, SPACE_CREATE_KEYS)
    if (gate) return gate
    const err = spaceValidationError(body)
    if (err || !isObject(body)) return c.json(errorBody('validation_error', err ?? 'body must be an object'), 400)
    const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : nextSpaceId()
    if (deps.channelStore.getSpace(id)) return c.json(errorBody('conflict', 'space id already exists'), 409)
    const created = deps.channelStore.putSpace({
      id,
      label: (body.label as string).trim(),
      // 不给次序 = 排在最后。新建的东西跳到列表中间是"我没动过的行自己换了位置"。
      position: body.position !== undefined ? body.position as number : deps.channelStore.nextSpacePosition(),
    })
    return c.json(created, 201)
  })

  app.patch('/api/spaces/:id', async (c) => {
    if (!deps.channelStore) return c.json(errorBody('unavailable', 'channels not configured'), 503)
    const id = c.req.param('id')
    const current = deps.channelStore.getSpace(id)
    if (!current) return c.json(errorBody('not_found', 'space not found'), 404)
    const body = await c.req.json().catch(() => undefined)
    const err = spaceValidationError(body, true)
    if (err || !isObject(body)) return c.json(errorBody('validation_error', err ?? 'body must be an object'), 400)
    const gate = strictBody(c, body, SPACE_PATCH_KEYS)
    if (gate) return gate
    // 默认空间**可以改名和挪位置**（它只是"不能删"），所以这里不挡 system。
    const updated = deps.channelStore.patchSpace(id, {
      label: body.label !== undefined ? (body.label as string).trim() : current.label,
      position: body.position !== undefined ? body.position as number : current.position,
    })
    if (!updated) return c.json(errorBody('not_found', 'space not found'), 404)
    return c.json(updated)
  })

  app.delete('/api/spaces/:id', (c) => {
    if (!deps.channelStore) return c.json(errorBody('unavailable', 'channels not configured'), 503)
    const id = c.req.param('id')
    const space = deps.channelStore.getSpace(id)
    if (!space) return c.json(errorBody('not_found', 'space not found'), 404)
    // 删默认空间就没有兜底落点了——无主频道会从侧栏里整批消失。
    if (space.system) return c.json(errorBody('validation_error', 'default space cannot be deleted'), 400)
    // 成员不跟着删，挪回默认空间（store 里那一步是同一个事务）。删空间不是删内容。
    deps.channelStore.removeSpace(id)
    return c.json({ ok: true })
  })

  app.post('/api/channels', async (c) => {
    if (!deps.channelStore) return c.json(errorBody('unavailable', 'channels not configured'), 503)
    const body = await c.req.json().catch(() => undefined)
    // 同上：名字写错要在形状校验之前说清楚（`streamIds` → `stream_ids` 这类）。
    const gate = strictBody(c, body, CHANNEL_CREATE_KEYS)
    if (gate) return gate
    const err = channelValidationError(body)
    if (err || !isObject(body)) {
      return c.json(errorBody('validation_error', err ?? 'body must be an object'), 400)
    }
    const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : nextChannelId()
    if (deps.channelStore.getChannel(id)) return c.json(errorBody('conflict', 'channel id already exists'), 409)
    const missing = ensureChannelStreamsExist(deps.channelStore, body.stream_ids as string[])
    if (missing) return c.json(errorBody('validation_error', missing), 400)
    const slotsErr = channelSlotsError(body.options, deps.providerBindings, deps.channelStore)
    if (slotsErr) return c.json(errorBody('validation_error', slotsErr), 400)
    const urlErr = channelEmbedUrlError(body.options)
    if (urlErr) return c.json(errorBody('validation_error', urlErr), 400)
    const presentRaw = (body.present ?? body.variant) as unknown
    const spaceErr = spaceRefError(deps.channelStore, body.space_id)
    if (spaceErr) return c.json(errorBody('validation_error', spaceErr), 400)
    const created = deps.channelStore.putChannel({
      id,
      label: body.label as string,
      present: coercePresent(presentRaw) ?? 'timeline',
      stream_ids: body.stream_ids as string[],
      options: body.options as Record<string, unknown>,
      space_id: body.space_id as string | undefined,
    })
    applyCollectionPolicy(created.stream_ids)
    // 新建 research 频道（创建对话框走的正是这条）→ 它绑的流现在该有 watcher 了。
    deps.onChannelsChanged?.()
    return c.json(created, 201)
  })

  app.patch('/api/channels/:id', async (c) => {
    if (!deps.channelStore) return c.json(errorBody('unavailable', 'channels not configured'), 503)
    const id = c.req.param('id')
    const current = deps.channelStore.getChannel(id)
    if (!current) return c.json(errorBody('not_found', 'channel not found'), 404)
    const body = await c.req.json().catch(() => undefined)
    const err = channelValidationError(body, true)
    if (err || !isObject(body)) return c.json(errorBody('validation_error', err ?? 'body must be an object'), 400)
    // 闸在校验**之后**：`id` 由校验先用「id cannot be changed」挡下，比"不认识的字段"准。
    const gate = strictBody(c, body, CHANNEL_PATCH_KEYS)
    if (gate) return gate
    const streamIds = body.stream_ids !== undefined ? body.stream_ids as string[] : current.stream_ids
    const missing = ensureChannelStreamsExist(deps.channelStore, streamIds)
    if (missing) return c.json(errorBody('validation_error', missing), 400)
    const slotsErr = channelSlotsError(body.options, deps.providerBindings, deps.channelStore)
    if (slotsErr) return c.json(errorBody('validation_error', slotsErr), 400)
    const urlErr = channelEmbedUrlError(body.options)
    if (urlErr) return c.json(errorBody('validation_error', urlErr), 400)
    const patchPresentRaw = (body.present ?? body.variant) as unknown
    const spaceErr = spaceRefError(deps.channelStore, body.space_id)
    if (spaceErr) return c.json(errorBody('validation_error', spaceErr), 400)
    const updated = deps.channelStore.patchChannel(id, {
      label: body.label !== undefined ? body.label as string : current.label,
      present: patchPresentRaw !== undefined ? (coercePresent(patchPresentRaw) ?? 'timeline') : current.present,
      stream_ids: streamIds,
      system: current.system,
      options: body.options !== undefined ? body.options as Record<string, unknown> : current.options,
      space_id: body.space_id !== undefined ? body.space_id as string : current.space_id,
    })
    if (!updated) return c.json(errorBody('not_found', 'channel not found'), 404)
    // 新旧成员表的并集：挪进来的要撤出调度，挪出去的要重新排班（撤出不是单向门）。
    applyCollectionPolicy([...current.stream_ids, ...streamIds])
    // present 改成/改离 research、成员表增删——两种都要重算 watcher 集合。
    deps.onChannelsChanged?.()
    // 返回**持久化后的 ChannelView**（与 GET /api/channels 逐字段同源），不是裸 ChannelRecord：
    // 前端拿它直接覆盖共享状态里那一条，从而不必"写完手工合并自己那份可能陈旧的快照"。
    // 形状必须与 GET 一致——差一个 `streams` 字段，前端覆盖完就是一片空白。
    const view = buildChannelViews()?.find((ch) => ch.id === id)
    return c.json(view ?? updated)
  })

  app.delete('/api/channels/:id', (c) => {
    if (!deps.channelStore) return c.json(errorBody('unavailable', 'channels not configured'), 503)
    const id = c.req.param('id')
    const channel = deps.channelStore.getChannel(id)
    if (!channel) return c.json(errorBody('not_found', 'channel not found'), 404)
    if (channel.system) return c.json(errorBody('validation_error', 'system channel cannot be deleted'), 400)
    deps.channelStore.removeChannel(id)
    // 删频道也在改「流—频道」关系，所以判据也要在这里问一次（流本身不跟着删，只是少了一个引用者）。
    // 咬人的方向：一条流同时挂在 timeline 和 research 上时按 timeline 采集，删掉那个 timeline
    // 频道后只剩 research 引用着它——不问判据它就一直采到重启。反方向（删掉最后一个引用者 → 成为
    // 无主流 → 进调度）是 `isCollected` 那条刻意的默认，与 PATCH 把它从频道里摘出去逐字一致。
    applyCollectionPolicy(channel.stream_ids)
    // 删掉的若是 research 频道，它名下那些流的 watcher 要停（流本身还在，只是没人再看它）。
    deps.onChannelsChanged?.()
    return c.json({ ok: true })
  })

  app.get('/api/channels/:id/items', (c) => {
    if (!deps.channelStore) return c.json(errorBody('unavailable', 'channels not configured'), 503)
    const id = c.req.param('id')
    const channel = deps.channelStore.getChannel(id)
    if (!channel) return c.json(errorBody('not_found', 'channel not found'), 404)
    const limitRaw = c.req.query('limit')
    const limit = limitRaw ? Number(limitRaw) : undefined
    const cursorRaw = c.req.query('cursor')
    const cursor = cursorRaw ? decodeCursor(cursorRaw) : null
    if (cursorRaw && !cursor) return c.json(errorBody('validation_error', 'invalid cursor'), 400)
    const streamMeta = new Map(deps.service.streamsResource().map((stream) => [stream.id, stream]))
    const audioIds = deps.channelStore.audioStreamIds()
    const streamIds = channel.stream_ids.filter((streamId) => {
      const stream = streamMeta.get(streamId)
      if (!stream) return false
      // Snapshot (collection) and audio streams are kept out of the all-latest firehose (the
      // system default-timeline). An explicitly-selected custom channel shows all its members —
      // otherwise a channel whose only member is a collection stream would read as empty.
      if (channel.system && channel.present === 'timeline') return stream.mode !== 'collection' && !audioIds.has(streamId)
      return true
    })
    const pageLimit = limit ?? 200
    // 窗口收窄到 pageLimit + 1（Task 2b）：recentForStreams 现在把排序键（timestamp || fetched_at，
    // 与本路由 JS 排序键字节对齐）和 cursor 谓词一起下推进 SQL，窗口按 SQL 侧的排序键取 top N，
    // 不再是"按插入序 seq 取固定 500 条再指望 JS 排序纠正"——旧方案对 collection stream 是硬伤：
    // ItemStore.replaceStream 对 collection 免驱逐（1000+ 首歌单要保留全部），固定 500 的窗口
    // 让第 501 条永远进不来，keyset 翻页会在 500 处终止、截断真实存量。收窄后每页只取够用的
    // pageLimit + 1，既修了截断也省了解析多余 480 行的成本。
    // 首屏（无 cursor）也走"按排序键"的窗口（cursor 参数传 true：只排序不加谓词）而非按 seq——
    // 若只按 seq 取窗口，一个 stream 内 seq 序（插入序）与 timestamp 序不一致时（乱序补录/去
    // 重再插），排序键真正最新的行可能 seq 很旧、落在小窗口外，首屏就已经取错。
    // recentForStreams 的 legacy（无 cursor 参数）路径未改，其他调用方/测试不受影响。
    const windowPerStream = pageLimit + 1
    const byStream = deps.itemStore.recentForStreams(streamIds, windowPerStream, cursor ?? true)
    const sorted = streamIds
      .flatMap((streamId) => byStream.get(streamId) ?? [])
      .sort((a, b) => {
        const at = sortKeyOf(a)
        const bt = sortKeyOf(b)
        // id tie-breaker：keyset 游标要求严格全序（同排序键的边界条目不跳不重）。
        // byte comparison 与 SQL 层 BINARY 谓词对齐：localeCompare 在混大小写 id 上会造成翻页跳
        if (at !== bt) return at > bt ? -1 : 1
        return a.id === b.id ? 0 : a.id > b.id ? -1 : 1
      })
    const after = cursor ? sorted.filter((it) => isAfterCursor({ sortKey: sortKeyOf(it), id: it.id }, cursor)) : sorted
    const page = after.slice(0, pageLimit)
    const last = page[page.length - 1]
    const next_cursor = after.length > pageLimit && last ? encodeCursor(sortKeyOf(last), last.id) : undefined
    // 同质内容归堆的标记（`src/story-fold/`）：**成员条照发不隐藏**——折不折是前端的事。
    // 在这里少发一条就等于替用户决定了他看不到什么，而且分页数会跟着对不上。
    const items = attachStoryGroups(page.map(toClientItem), deps.storyFold)
    // 信封一次性切换（Design D2）：不带 cursor 的请求也返回 { items, next_cursor? }，不留两种形状
    return c.json(next_cursor ? { items, next_cursor } : { items })
  })

  // ── 同质内容归堆：展开 / 拆堆 / 谁先发 ────────────────────────────────────
  // 判据与不变量见 `src/story-fold/` 与 `docs/ARCHITECTURE.md`「同质内容归堆」。

  /**
   * **谁在同质内容上持续先发**——「来源」在归堆之后唯一的作用。
   *
   * 只统计**同时出现在一堆里**的那些次：两个源都发了同一条内容，谁的发布时间早算谁领先。
   * 没同框过的源之间不比——那不是领先，是没有可比性。
   *
   * **必须挂在 `/:groupId` 前面**：Hono 按注册序匹配，反过来的话 `leaderboard` 会被当成
   * 一个组 id 吃掉，榜永远返回空成员列表——而且不报错，只是永远是空的。
   */
  app.get('/api/story-fold/leaderboard', (c) => {
    if (!deps.storyFold) return c.json(errorBody('unavailable', 'story fold not available'), 503)
    return c.json({ sources: deps.storyFold.leaderboard() })
  })

  /** 一个堆里都有谁（前端展开时问）。 */
  app.get('/api/story-fold/:groupId', (c) => {
    if (!deps.storyFold) return c.json(errorBody('unavailable', 'story fold not available'), 503)
    return c.json({ members: deps.storyFold.group(c.req.param('groupId')) })
  })

  /**
   * 人工拆堆。**同时记下这两条永不再并**（store 侧做的）——只删归属的话，
   * 下一轮采集会照原判据把它合回去，用户会发现自己白拆了。
   */
  app.delete('/api/story-fold/:itemId', (c) => {
    if (!deps.storyFold) return c.json(errorBody('unavailable', 'story fold not available'), 503)
    deps.storyFold.unfold(c.req.param('itemId'))
    return c.json({ ok: true })
  })

  // ── /api/providers：Provider 行 CRUD + 声明匹配预览 ─────────────────────────
  const providersReady = () => !!(deps.providers && deps.channelStore)

  app.get('/api/providers', (c) => {
    if (!providersReady()) return c.json(errorBody('unavailable', 'providers not configured'), 503)
    const category = c.req.query('category') ?? c.req.query('variant')
    const key = c.req.query('key')
    if (category && key) {
      // 匹配预览：这个路由键落到谁头上（specific 优先，'*' 兜底）
      if (!PROVIDER_VARIANTS.includes(category as never)) {
        return c.json(errorBody('validation_error', `category must be ${PROVIDER_VARIANTS.join(' | ')}`), 400)
      }
      const matched = deps.providers!.executor.match(category as (typeof PROVIDER_VARIANTS)[number], key)
      return c.json({ items: matched.map((r) => providerView(deps, r)) })
    }
    const live = deps.channelStore!.listProviders().map((r) => providerView(deps, r))
    return c.json({ items: [...live, ...plannedProviderViews()] })
  })

  app.get('/api/providers/:id', (c) => {
    if (!providersReady()) return c.json(errorBody('unavailable', 'providers not configured'), 503)
    const record = deps.channelStore!.getProvider(c.req.param('id'))
    if (!record) return c.json(errorBody('not_found', 'provider not found'), 404)
    return c.json(providerView(deps, record))
  })

  app.get('/api/provider-callsites', (c) => {
    if (!deps.providerBindings || !deps.channelStore) return c.json(errorBody('unavailable', 'provider bindings not configured'), 503)
    return c.json({ items: PROVIDER_CALLSITES.map((callsite) => ({
      ...callsite,
      binding: deps.providerBindings!.binding(callsite.id),
      providers: deps.channelStore!.listProviders().filter((provider) => provider.category === callsite.category && !isParked(provider)).map((provider) => ({ id: provider.id, label: provider.label })),
    })) })
  })

  app.get('/api/presents', (c) => c.json({ items: PRESENTS }))

  app.put('/api/provider-callsites/:id/binding', async (c) => {
    if (!deps.providerBindings) return c.json(errorBody('unavailable', 'provider bindings not configured'), 503)
    const body = await c.req.json().catch(() => undefined)
    const gate = strictBody(c, body, CALLSITE_BINDING_KEYS)
    if (gate) return gate
    if (!isObject(body) || !stringArray(body.providerIds)) return c.json(errorBody('validation_error', 'providerIds must be a string array'), 400)
    // params 是可选的调用点覆盖（如 llm 调用点的 model 覆盖，Task 9 消费）；非 object 400，省略即不设/清空。
    if (body.params !== undefined && !isObject(body.params)) return c.json(errorBody('validation_error', 'params must be an object'), 400)
    try { return c.json(deps.providerBindings.put(c.req.param('id'), body.providerIds, body.params as Record<string, unknown> | undefined)) }
    catch (error) { return c.json(errorBody('validation_error', (error as Error).message), 400) }
  })

  app.post('/api/provider-callsites/:id/restore-default', (c) => {
    if (!deps.providerBindings) return c.json(errorBody('unavailable', 'provider bindings not configured'), 503)
    try { return c.json(deps.providerBindings.restore(c.req.param('id'))) }
    catch (error) { return c.json(errorBody('validation_error', (error as Error).message), 400) }
  })

  app.post('/api/providers', async (c) => {
    if (!providersReady()) return c.json(errorBody('unavailable', 'providers not configured'), 503)
    const body = await c.req.json().catch(() => undefined)
    const gate = strictBody(c, body, PROVIDER_KEYS)
    if (gate) return gate
    const err = providerValidationError(body)
    if (err || !isObject(body)) return c.json(errorBody('validation_error', err ?? 'body must be an object'), 400)
    const shadowed = Array.isArray(body.members) ? shadowedSourceName(body.members, deps.resolve?.registry) : null
    if (shadowed) return c.json(errorBody('name_shadows_source', shadowedNameMessage(shadowed)), 422)
    const id = body.id as string
    if (deps.channelStore!.getProvider(id)) return c.json(errorBody('conflict', `provider ${id} already exists`), 409)
    const category = (body.category ?? body.variant) as (typeof PROVIDER_VARIANTS)[number]
    const record = deps.channelStore!.putProvider({
      id,
      label: (body.label as string) ?? id,
      description: (body.description as string) ?? '',
      category,
      serves: (body.serves as string[]) ?? [],
      // 默认 strategy 随 category：search 并发，其余顺次
      strategy: (body.strategy as 'sequential' | 'concurrent') ?? (category === 'search' ? 'concurrent' : 'sequential'),
      members: (body.members as import('../store/types.ts').ProviderMemberRef[]) ?? [],
      contract: (body.contract as Record<string, unknown> | null) ?? null,
      options: (body.options as Record<string, unknown>) ?? {},
    })
    return c.json(providerView(deps, record), 201)
  })

  app.patch('/api/providers/:id', async (c) => {
    if (!providersReady()) return c.json(errorBody('unavailable', 'providers not configured'), 503)
    const body = await c.req.json().catch(() => undefined)
    const gate = strictBody(c, body, PROVIDER_KEYS)
    if (gate) return gate
    const err = providerValidationError(body, true)
    if (err || !isObject(body)) return c.json(errorBody('validation_error', err ?? 'body must be an object'), 400)
    const shadowed = Array.isArray(body.members) ? shadowedSourceName(body.members, deps.resolve?.registry) : null
    if (shadowed) return c.json(errorBody('name_shadows_source', shadowedNameMessage(shadowed)), 422)
    const { id: _ignored, ...patch } = body
    // 系统行的**身份**由代码定义（`src/providers/system/`），行上那几列是死数据——改它既不会生效
    // （读侧一律取代码），也不会报错。所以在门口就响亮拒掉，而不是收下再静默丢弃：静默丢弃会让
    // 用户以为改成了。members/options/label/description 是编排与文案，照常可改。
    const identityConflict = systemIdentityConflict(c.req.param('id'), patch)
    if (identityConflict) {
      return c.json(errorBody('validation_error', `系统 Provider 的身份（${identityConflict}）由代码定义，不能改；可改的是 members / options / label / description`), 400)
    }
    const updated = deps.channelStore!.patchProvider(c.req.param('id'), patch as Partial<import('../store/types.ts').ProviderRecord>)
    if (!updated) return c.json(errorBody('not_found', 'provider not found'), 404)
    return c.json(providerView(deps, updated))
  })

  app.delete('/api/providers/:id', (c) => {
    if (!providersReady()) return c.json(errorBody('unavailable', 'providers not configured'), 503)
    const id = c.req.param('id')
    const provider = deps.channelStore!.getProvider(id)
    if (!provider) return c.json(errorBody('not_found', 'provider not found'), 404)
    // 引用保护:callsite binding 引用 + 被另一 Provider 的 {provider} 成员引用(composition) + 被频道槽位引用——任一非空即拒。
    const callsiteRefs = deps.providerBindings?.references(id) ?? []
    const providerRefs = deps.channelStore!.providersReferencing(id)
    const slotRefs = deps.channelStore!.channelSlotsReferencing(id)
    if (callsiteRefs.length || providerRefs.length || slotRefs.length) {
      return c.json({ error: { code: 'conflict', message: 'provider is referenced', details: { callsites: callsiteRefs, providers: providerRefs, channels: slotRefs } } }, 409)
    }
    deps.channelStore!.removeProvider(id)
    return c.json({ ok: true })
  })

  // Per-stream ad-filter rules — additive on top of built-in defaults + config.yaml global
  // rules (see mergeAdRules). `null` body clears the stream's override.
  app.patch('/api/channels/:channelId/streams/:streamId/ad-filter', async (c) => {
    if (!deps.channelStore) return c.json({ error: 'channels not configured' }, 503)
    const channelId = c.req.param('channelId')
    const streamId = c.req.param('streamId')
    const body = (await c.req.json().catch(() => undefined)) as { keywords?: unknown; domains?: unknown } | null | undefined
    if (body !== null) {
      const isStringArray = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'))
      // 闸在形状校验**之前**：`keyword`（少个 s）过去是静默丢弃——200 + 一条看起来正常的流，
      // 规则却一条没落；而形状校验只会说"keywords 必须是字符串数组"，指不出你写错了名字。
      const gate = strictBody(c, body, AD_FILTER_KEYS)
      if (gate) return gate
      if (typeof body !== 'object' || body === null || !isStringArray(body.keywords) || !isStringArray(body.domains)) {
        return c.json({ error: 'keywords/domains must be string arrays' }, 400)
      }
    }
    // ad_filter 落在 stream.options（流级规则）；channelId 仅做归属校验，保持旧路由契约。
    const channel = deps.channelStore.getChannel(channelId)
    const rec = deps.channelStore.getStream(streamId)
    if (!channel || !rec || !channel.stream_ids.includes(streamId)) return c.json({ error: 'not found' }, 404)
    const { ad_filter: _drop, ...rest } = rec.options as Record<string, unknown>
    const nextOptions = body === null ? rest : { ...rest, ad_filter: body as AdRules }
    const updated = deps.channelStore.putStream({ ...rec, options: nextOptions })
    // options-only change — refresh the scheduler's copy so the next tick uses the new
    // ad_filter (effectiveAdRules reads it from the in-memory Stream, not the store).
    deps.service.updateResourceStream(streamRecordToStream(updated))
    return c.json(streamRecordToStream(updated))
  })

  // Per-stream 只看包含 (title-include allow-filter): keep only items whose title contains one of
  // `keywords`; the rest fold at ingest. `null` body clears it. Sibling of the ad-filter route.
  app.patch('/api/channels/:channelId/streams/:streamId/title-filter', async (c) => {
    if (!deps.channelStore) return c.json({ error: 'channels not configured' }, 503)
    const channelId = c.req.param('channelId')
    const streamId = c.req.param('streamId')
    const body = (await c.req.json().catch(() => undefined)) as { keywords?: unknown } | null | undefined
    if (body !== null) {
      const isStringArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string')
      const gate = strictBody(c, body, TITLE_FILTER_KEYS)
      if (gate) return gate
      if (typeof body !== 'object' || body === null || !isStringArray(body.keywords)) {
        return c.json({ error: 'keywords must be a string array' }, 400)
      }
    }
    const channel = deps.channelStore.getChannel(channelId)
    const rec = deps.channelStore.getStream(streamId)
    if (!channel || !rec || !channel.stream_ids.includes(streamId)) return c.json({ error: 'not found' }, 404)
    const { title_include: _drop, ...rest } = rec.options as Record<string, unknown>
    const keywords = (body?.keywords as string[] | undefined)?.map((s) => s.trim()).filter(Boolean) ?? []
    const nextOptions = body === null || keywords.length === 0 ? rest : { ...rest, title_include: keywords }
    const updated = deps.channelStore.putStream({ ...rec, options: nextOptions })
    deps.service.updateResourceStream(streamRecordToStream(updated))
    return c.json(streamRecordToStream(updated))
  })

  // Re-run classifyAd (with the CURRENT effective rules) over a stream's already-stored
  // items. Manually-labeled items (`muted.manual === true`) are never touched — a human
  // label always wins. Opt-in: the UI calls this explicitly after editing a stream's rules,
  // it never runs automatically.
  app.post('/api/channels/:channelId/streams/:streamId/ad-filter/reclassify', (c) => {
    if (!deps.channelStore) return c.json({ error: 'channels not configured' }, 503)
    const channelId = c.req.param('channelId')
    const streamId = c.req.param('streamId')
    const channel = deps.channelStore.getChannel(channelId)
    const streamRec = channel?.stream_ids.includes(streamId) ? deps.channelStore.getStream(streamId) : null
    if (!channel || !streamRec) return c.json({ error: 'not found' }, 404)

    const rules = mergeAdRules(deps.baseAdRules ?? {}, (streamRec.options as { ad_filter?: AdRules }).ad_filter)
    const titleInclude = (streamRec.options as { title_include?: string[] }).title_include
    // capPerStream defaults to 5000 in ItemStore — 1000 safely covers every stored row.
    const items = deps.itemStore.recent({ stream: streamId, limit: 1000 })
    let changed = 0
    for (const it of items) {
      if (it.muted?.manual) continue
      // Desired muted state = the same rules ingest applies: ad classification wins, else the
      // 只看包含 fold. Re-derived from scratch so this re-syncs stored items with the CURRENT
      // ad_filter AND title_include (an item folded/unfolded by either rule updates in place).
      const desired = classifyAd(streamItemToFields(it), rules) ?? includeFold(it.title, titleInclude)
      const prev = it.muted
      const differs = !!desired !== !!prev || desired?.reason !== prev?.reason || desired?.rule !== prev?.rule
      if (differs) {
        deps.itemStore.setMuted(it.id, desired ?? null)
        changed++
      }
    }
    return c.json({ changed })
  })

  // 「这几个 id 该怎么显示」——标题 / 来源 / 原文链接 / 封面，按 id 批量取。
  //
  // **为什么不塞进工具回执**：这是给渲染看的，不是给模型看的。对话里一条引用要画成带封面的
  // 卡片，需要的正是这四格；而把它们塞进 `inbox_search` 那类回执，等于每行多付几百字符的
  // 签名封面 URL 进模型上下文——那份瘦身投影是它的命脉（见 `src/mcp/inbox-search.ts` 头注，
  // 记着一次把上下文撑到 416K token 的事故）。前端按 id 现取，模型一个 token 都不用付。
  //
  // 形状与 `resolveHandle` 的 `snapshot` 同源（多一格 `poster`，判据同 extract 回执用的
  // `posterOf`）——**别在这里另写一套"封面取哪张"的规则**，两处一漂就是同一条内容在卡片上
  // 和在对话里显示成两个样子，而且没有任何一处会报错。
  app.get('/api/items/refs', (c) => {
    const badQuery = unknownKey(Object.keys(c.req.query()), ITEM_REFS_QUERY_KEYS)
    if (badQuery) return c.json(errorBody('validation_error', unknownKeyMessage('查询参数', badQuery, ITEM_REFS_QUERY_KEYS)), 400)
    const ids = (c.req.query('ids') ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')
    if (ids.length > ITEM_REFS_MAX) {
      return c.json(errorBody('validation_error', `一次最多 ${ITEM_REFS_MAX} 个 id`), 400)
    }
    const refs: Record<string, { title: string; source?: string; url?: string; poster?: string }> = {}
    for (const id of ids) {
      const it = deps.itemStore.get(id)
      // 查不到的**不进结果**，也不报错：引用可能指着一条已经被清掉的内容，那时调用方该退回
      // 纯文字，而不是把整条消息渲染成错误。缺席由"键不在"表达，不编一个空壳。
      if (!it) continue
      const poster = posterOf(it.content?.media)
      refs[id] = {
        title: it.title,
        ...(it.stream_id ? { source: it.stream_id } : {}),
        ...(it.url ? { url: it.url } : {}),
        ...(poster ? { poster } : {}),
      }
    }
    return c.json({ refs })
  })

  app.get('/api/items', (c) => {
    // 写错参数名不再静默返回全库——判据与理由见 http/strict-input.ts。
    const badQuery = unknownKey(Object.keys(c.req.query()), ITEMS_QUERY_KEYS)
    if (badQuery) return c.json(errorBody('validation_error', unknownKeyMessage('查询参数', badQuery, ITEMS_QUERY_KEYS)), 400)
    const stream = c.req.query('stream') || undefined
    const limitRaw = c.req.query('limit')
    const limit = limitRaw ? Number(limitRaw) : undefined
    // order=asc returns a stream's items in ingest order (playlist/歌单 top-to-bottom);
    // default newest-first.
    const order = c.req.query('order') === 'asc' ? 'asc' : undefined
    // all-latest (no stream): drop collection-mode streams — they're channel-only
    // and their per-harvest re-inserts would otherwise flood the timeline.
    const audioIds = deps.channelStore?.audioStreamIds() ?? new Set<string>()
    const videoIds = deps.channelStore?.videoStreamIds() ?? new Set<string>()
    const excludeStreams = stream
      ? undefined
      : deps.service.streamsResource().filter((s) => s.mode === 'collection' || audioIds.has(s.id)).map((s) => s.id)
    const rows = deps.itemStore.recent({ stream, limit, excludeStreams, order })
    // Gate `resolveOnly` audio (paid podcast episodes): unmatched-in-netdisk → downgrade to
    // cover-only so the row renders disabled rather than erroring on play. Matched episodes keep
    // their playable audio; pass a lookup only when netdisk is wired (else all such rows disable).
    const gated = gateResolveOnlyMedia(rows, deps.netdisk ? (k) => deps.netdisk!.lookup(k) : undefined)
    const videoGated = gateResolveOnlyVideoMedia(
      gated,
      deps.netdisk ? (key) => deps.netdisk!.lookup(key) : undefined,
      deps.netdisk ? (streamId) => deps.netdisk!.hasBindingForStream(streamId) : undefined,
      (streamId) => videoIds.has(streamId),
    )
    const projected = videoGated.map((item) => {
      if (!deps.videoDetails || !videoIds.has(item.stream_id)) return item
      const preview = videoDetailPreview(deps.videoDetails.peek(videoWorkLookupIdentity(item)))
      return preview ? { ...item, videoDetail: preview } : item
    })
    // 归堆标记同样挂上（和 `/api/channels/:id/items` 一处口径）——两条列表路由都要带，
    // 否则同一条 item 在两个入口一个有折叠一个没有，前端会渲染出两种样子。
    return c.json(attachStoryGroups(projected.map(toClientItem), deps.storyFold))
  })

  // Item mutation surface. `label` is the read-time manual ad label: 广告/抽奖 mute the
  // item (manual gold standard) and route it to the 广告 channel; 非广告 clears the flag
  // and records a negative fixture (a false positive caught by a human → precision guard).
  app.patch('/api/items/:id', async (c) => {
    const id = c.req.param('id')
    const item = deps.itemStore.get(id)
    if (!item) return c.json({ error: { code: 'not_found', message: 'item not found' } }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { label?: 'ad' | 'lottery' | 'not-ad' }
    const gate = strictBody(c, body, ITEM_PATCH_KEYS)
    if (gate) return gate
    if (body.label === 'not-ad') {
      deps.recordNegative?.(item)
      deps.itemStore.setMuted(id, null)
    } else if (body.label === 'ad' || body.label === 'lottery') {
      deps.itemStore.setMuted(id, { reason: body.label, rule: 'manual', manual: true })
    } else {
      return c.json({ error: { code: 'validation_error', message: 'label must be ad | lottery | not-ad' } }, 400)
    }
    return c.json({ ok: true })
  })

  // Maintenance: re-run normalize(raw, current manifest) over stored items, overwriting
  // ONLY `content` (ingest-time normalization is a cache — raw never leaves the row).
  // Scope keys are mutually exclusive; unknown scope → 404 so a typo can't fake success.
  app.post('/api/items/renormalize', async (c) => {
    if (!deps.renormalizeItems) return c.json(errorBody('unavailable', 'renormalize not configured'), 503)
    const text = await c.req.text()
    let body: unknown = {}
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text)
      } catch {
        return c.json(errorBody('validation_error', 'body must be valid JSON'), 400)
      }
    }
    if (!isObject(body)) {
      return c.json(errorBody('validation_error', 'body must be a JSON object'), 400)
    }
    const gate = strictBody(c, body, RENORMALIZE_KEYS)
    if (gate) return gate
    if (body.streamId !== undefined && typeof body.streamId !== 'string') {
      return c.json(errorBody('validation_error', 'streamId must be a string'), 400)
    }
    if (body.sourceId !== undefined && typeof body.sourceId !== 'string') {
      return c.json(errorBody('validation_error', 'sourceId must be a string'), 400)
    }
    const streamId = typeof body.streamId === 'string' ? body.streamId : undefined
    const sourceId = typeof body.sourceId === 'string' ? body.sourceId : undefined
    if (streamId && sourceId) {
      return c.json(errorBody('validation_error', 'streamId and sourceId are mutually exclusive'), 400)
    }
    try {
      return c.json(deps.renormalizeItems({ streamId, sourceId }))
    } catch (e) {
      if (e instanceof RenormalizeNotFoundError) return c.json(errorBody('not_found', e.message), 404)
      throw e
    }
  })

  // npm recipe 包安装(preview→install 两步)。uninstall/preview/install 走 POST(包名含 `/`,不进
  // path param);confirm 是 preview 发放的 tarball integrity,防"preview 之后包变了"的 TOCTOU。
  app.post('/api/recipes/packages/preview', async (c) => {
    if (!deps.recipePackageOps) return c.json(errorBody('unavailable', 'recipe package ops not configured'), 503)
    const body = await c.req.json<{ name?: string; version?: string }>()
    const gate = strictBody(c, body, RECIPE_PREVIEW_KEYS)
    if (gate) return gate
    const { name, version } = body
    if (!name) return c.json(errorBody('validation_error', 'name required'), 400)
    try { return c.json(await deps.recipePackageOps.preview(name, version)) }
    catch (e) { return c.json(errorBody('validation_error', (e as Error).message), 400) }
  })
  app.post('/api/recipes/packages/install', async (c) => {
    if (!deps.recipePackageOps) return c.json(errorBody('unavailable', 'recipe package ops not configured'), 503)
    const body = await c.req.json<{ name?: string; version?: string; confirm?: string }>()
    const gate = strictBody(c, body, RECIPE_INSTALL_KEYS)
    if (gate) return gate
    const { name, version, confirm } = body
    if (!name || !confirm) return c.json(errorBody('validation_error', 'name and confirm required (run preview first)'), 400)
    try { return c.json(await deps.recipePackageOps.install(name, version, confirm)) }
    catch (e) { return c.json(errorBody('validation_error', (e as Error).message), 400) }
  })
  // 动作 recipe 的**脚本入口**。和 MCP 的 `run_action_recipe` 是同一个 `runActionRecipe`
  // （deps 由 serve.ts 从 `mcpExtras` 那一份原样递进来，不在这里另装配一次）——两条路
  // 只有调用方不同，凭据注入 / 限速 / 冷却 / 两步确认全共用，不会各自长出一套行为。
  //
  // **为什么需要这条路**：动作 recipe 的参数里可能有大块字节（闲鱼上架的商品图是 data URL，
  // 页面 CSP 不放行 fetch，字节只能随参数递进去）。走 MCP 就意味着这些 base64 要穿过一次
  // 对话，几十 KB 起步、且**抄错一个字符就是 `atob` 失败**（2026-09-08 实测踩过）。脚本从
  // 磁盘读图直接 POST，这一段风险整个消失。
  //
  // 不加鉴权，与 `/api/netdisk/fs/put` 同一立场：8900 只听本机。
  app.post('/api/recipes/action', async (c) => {
    if (!deps.runAction) return c.json(errorBody('unavailable', 'action recipes not configured'), 503)
    const body = await c.req.json<{ sourceId?: string; params?: Record<string, unknown>; confirmed?: boolean }>()
    const gate = strictBody(c, body, ACTION_RUN_KEYS)
    if (gate) return gate
    if (!body.sourceId) return c.json(errorBody('validation_error', 'sourceId required'), 400)
    try {
      // 结果原样回：`needs-confirmation` / `blocked` / `done` 这些状态是调用方要判的，
      // 折成 HTTP 状态码会把它们压成一个数字（而 `blocked` 恰恰可能是"已经生效但没读到回执"）。
      return c.json(await deps.runAction({ sourceId: body.sourceId, params: body.params, confirmed: body.confirmed }))
    } catch (e) {
      return c.json(errorBody('internal', (e as Error).message), 500)
    }
  })
  // 上面那条回 `{status:'running', runId}` 时（动作超过了等待窗还没跑完），脚本从这里等结果。
  // 没有这条路的话，脚本口拿到 running 就只能去敲 /api/mcp——一个 HTTP 入口不该把它的消费者
  // 支去另一个协议面上收尾。
  app.get('/api/recipes/action/:runId', (c) => {
    if (!deps.actionRun) return c.json(errorBody('unavailable', 'action recipes not configured'), 503)
    const view = deps.actionRun(c.req.param('runId'))
    if (!view) return c.json(errorBody('not_found', 'no action run with that runId'), 404)
    return c.json(view)
  })
  app.post('/api/recipes/packages/uninstall', async (c) => {
    if (!deps.recipePackageOps) return c.json(errorBody('unavailable', 'recipe package ops not configured'), 503)
    const body = await c.req.json<{ name?: string }>()
    const gate = strictBody(c, body, RECIPE_UNINSTALL_KEYS)
    if (gate) return gate
    const { name } = body
    if (!name) return c.json(errorBody('validation_error', 'name required'), 400)
    try {
      const removed = await deps.recipePackageOps.uninstall(name)
      return removed ? c.json({ removed: true }) : c.json(errorBody('not_found', `${name} is not installed`), 404)
    } catch (e) { return c.json(errorBody('validation_error', (e as Error).message), 400) }
  })
  app.get('/api/recipes/packages/updates', async (c) => {
    if (!deps.recipePackageOps) return c.json(errorBody('unavailable', 'recipe package ops not configured'), 503)
    try { return c.json(await deps.recipePackageOps.updates()) }
    catch (e) { return c.json(errorBody('validation_error', (e as Error).message), 400) }
  })
  app.get('/api/recipes/packages/search', async (c) => {
    if (!deps.recipePackageOps) return c.json(errorBody('unavailable', 'recipe package ops not configured'), 503)
    const q = c.req.query('q')?.trim()
    if (!q) return c.json(errorBody('validation_error', 'q required'), 400)
    try { return c.json(await deps.recipePackageOps.search(q)) }
    catch (e) { return c.json(errorBody('validation_error', (e as Error).message), 400) }
  })
  app.get('/api/recipes/packages', async (c) => {
    if (!deps.recipePackageOps) return c.json(errorBody('unavailable', 'recipe package ops not configured'), 503)
    try { return c.json(await deps.recipePackageOps.listInstalled()) }
    catch (e) { return c.json(errorBody('validation_error', (e as Error).message), 400) }
  })

  app.get('/api/categories', (c) => c.json(deps.service.categories()))

  // Unified content-capability search — one noun, scoped. `content` = cross-platform posts,
  // `music` = playable tracks, `resources` = video/torrent facets (`nsfw=1` flips the source
  // set; `stream=1` streams NDJSON events). The source-CATALOG search (ranked manifests by
  // intent) lives on GET /api/sources?q= instead — different question, different resource.
  app.get('/api/search', async (c) => {
    try {
    const q = (c.req.query('q') ?? '').trim()
    const scope = c.req.query('scope')
    if (scope !== 'content' && scope !== 'music' && scope !== 'price' && scope !== 'resale' && scope !== 'resources' && scope !== 'video') {
      return c.json(errorBody('validation_error', 'scope must be content | music | price | resale | resources | video'), 400)
    }
    if (scope === 'content' || scope === 'music' || scope === 'price' || scope === 'resale') {
      if (!q) return c.json({ items: [] })
      if (!deps.providers) return c.json(errorBody('unavailable', `${scope} search not available`), 503)
      // 经 content-search / music-search / price-search / resale-search Provider 行（并发分支：成员结果合并，失败入 misses）。
      // price / resale 与 content 同形（并发 + 按产源 manifest 归一化），只是意图独立、成员各是各的：
      // price = 新品各平台报价，resale = 型号二手回收价——混排会让回收价看起来像一个便宜的购买选项。
      const callsite = scope === 'music' ? 'search.music' : scope === 'price' ? 'search.price' : scope === 'resale' ? 'search.resale' : 'search.content'
      const fallbackProviderId = scope === 'music' ? 'music-search' : scope === 'price' ? 'price-search' : scope === 'resale' ? 'resale-search' : 'content-search'
      const providerId = deps.providerBindings?.fixed(callsite, slotCtx(c))
      const r = await deps.providers.executor.invoke(providerId ?? fallbackProviderId, q)
      if (!r) return c.json(errorBody('unavailable', `${scope} search not available`), 503)
      const items = r.strategy === 'concurrent' ? r.items : []
      // Surface failed members instead of hiding them: a member that errored (after its stale-cookie
      // retry) becomes a warning, so the successful members' items still come back and the UI can
      // flag "this source failed" (e.g. needs re-login). 'declined (no result)' = empty, not a fault.
      //
      // `blocked` rides along when the member did not FAIL but is missing a precondition the user
      // can supply (login gone / extension not connected). It is what lets the UI draw a button
      // instead of red text — and why it must stay structured all the way here rather than being
      // re-derived from `reason` at the edge.
      const warnings = (r.strategy === 'concurrent' ? r.misses : [])
        .filter((m) => m.reason !== 'declined (no result)')
        .map((m) => ({ source: m.member, reason: m.reason, stack: m.stack, ...(m.blocked ? { blocked: m.blocked } : {}) }))
      // 每个成员跑了多久、结果是什么。搜索是并发扇出，总耗时只等于最慢那个成员——只有分源
      // 明细能回答"到底是谁慢"（一个骑真浏览器滚页面的成员和一个纯 HTTP 的成员差一个数量级）。
      // 执行器本来就在算它（每个 attempt 的墙钟），这里只是别把它丢掉。
      const timings = (r.strategy === 'concurrent' ? r.timings : [])
        .map((t) => ({ source: t.member, ms: t.ms, outcome: t.outcome }))
      // music members are package search recipes emitting raw feed-shaped items — map to the
      // track shape the music UI renders (and dedup the same song reported by several members).
      if (scope === 'music') return c.json({ items: rsshubItemsToTracks(items), warnings, timings })
      // content: normalize each raw item via ITS producing source's manifest (provenance from the
      // executor, read back with sourceOf). Normalization is chosen per-scope here — NOT by
      // "manifest has a normalizer" — so music's normalized catalog rows are never touched.
      const normalizeItem = deps.normalizeSearchItem
      const normalized = normalizeItem
        ? items.flatMap((raw) => { const src = sourceOf(raw); return src ? [toClientItem(normalizeItem(src, raw))] : [] })
        : items
      return c.json({ items: normalized, warnings, timings })
    }
    if (scope === 'video') {
      // 影视片名搜索（可插拔搜索源层）：经 video-search Provider 行并发扇出，各成员返回
      // VideoReference[]（未核实作品事实，见 tmdb-title-search）；此处按 external id / 归一化标题+年份
      // 去重合成 VideoWorkCandidate，累加 sources。misses（非 declined）→ warnings。今只 TMDB 一个成员，
      // 去重多为空转；区域来源（腾讯综艺/爱奇艺短剧）作为新成员并入本行后此段自然生效。
      if (!q) return c.json({ candidates: [] })
      if (!deps.providers) return c.json(errorBody('unavailable', 'video search not available'), 503)
      const r = await deps.providers.executor.invoke(deps.providerBindings?.fixed('search.video', slotCtx(c)) ?? 'video-search', q)
      if (!r || r.strategy !== 'concurrent') return c.json(errorBody('unavailable', 'video search not available'), 503)
      const warnings = r.misses
        .filter((m) => m.reason !== 'declined (no result)')
        .map((m) => ({ source: m.member, reason: m.reason, stack: m.stack }))
      // 去重键：优先共享 external id（tmdb/imdb），退化到归一化标题+年份。
      const keyOf = (ref: VideoReference): string => {
        const ids = ref.externalIds ?? {}
        if (ids.tmdb) return `tmdb:${ids.tmdb}`
        if (ids.imdb) return `imdb:${ids.imdb}`
        return `t:${ref.title.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')}:${ref.year ?? ''}`
      }
      const byKey = new Map<string, VideoWorkCandidate>()
      for (const raw of r.items) {
        const hit = raw as VideoReference & { rating?: number; overview?: string }
        if (!hit || typeof hit.title !== 'string' || !hit.title) continue
        const source = sourceOf(raw) ?? 'video-search'
        const existing = byKey.get(keyOf(hit))
        if (existing) {
          if (!existing.sources.includes(source)) existing.sources.push(source)
          // 不同源各带部分展示字段，补齐首见缺的
          if (existing.rating == null && hit.rating != null) existing.rating = hit.rating
          if (!existing.overview && hit.overview) existing.overview = hit.overview
          if (!existing.poster && hit.poster) existing.poster = hit.poster
          existing.externalIds = { ...(hit.externalIds ?? {}), ...(existing.externalIds ?? {}) }
        } else {
          byKey.set(keyOf(hit), { ...hit, sources: [source] })
        }
      }
      return c.json({ candidates: [...byKey.values()], warnings })
    }
    // resources
    const nsfw = c.req.query('nsfw') === '1' || c.req.query('nsfw') === 'true'
    if (c.req.query('stream') === '1') {
      if (!q || !deps.videoSearchStream) return c.json(errorBody('unavailable', 'resource search not available'), 503)
      // 槽位必须在开流之前解析：一旦 stream() 接管响应，头已发出、SlotBrokenError 再抛就变不成 422。
      // 解析出的行 id 传进 videoSearchStream，流式扇出的成员就换成了该行的成员——这才是就地换
      // Provider 真正生效的地方。（流式 NDJSON 仍无法过 invoke：执行器返回整值，不是逐源事件。）
      const streamProviderId = deps.providerBindings?.fixed('search.resources', slotCtx(c)) ?? 'resource-search'
      // 计数在此打点（executor 之外唯一的例外），记的是实际用的那一行
      deps.providers?.stats.record(streamProviderId, 'videoSearchStream')
      c.header('Content-Type', 'application/x-ndjson; charset=utf-8')
      c.header('Cache-Control', 'no-cache')
      c.header('X-Accel-Buffering', 'no') // don't let a reverse proxy buffer the stream
      return stream(c, async (s) => {
        for await (const ev of deps.videoSearchStream!(q, { nsfw, providerId: streamProviderId })) {
          await s.write(JSON.stringify(ev) + '\n')
        }
      })
    }
    if (!q) return c.json({ shows: [], loose: [], sources: [] })
    if (!deps.providers) return c.json(errorBody('unavailable', 'resource search not available'), 503)
    // 经 resource-search Provider 行（并发扇出，返回各源原始条目 + per-item provenance）。裸 q：
    // members 用 {keyword:'$input'}，传对象会把整个对象塞进 keyword 洞（同某取歌 Provider 行裸 id 那条）；
    // nsfw 当前行成员（provides:search-download）未用，丢弃它是保行为的。extract+facet 复用 src/video/* 在调用点重建。
    const resourceProviderId = deps.providerBindings?.fixed('search.resources', slotCtx(c)) ?? 'resource-search'
    const r = await deps.providers.executor.invoke(resourceProviderId, q)
    if (!r || r.strategy !== 'concurrent') {
      return c.json(errorBody('unavailable', 'resource search not available'), 503)
    }
    // 同一行 id 传给 facetResources：miss 标签的寻址键→sourceId 映射要按*实际扇出的那一行*建，
    // 槽位覆盖时若还查默认的 resource-search 行会建错映射（见 bootstrap.ts facetResources 头注）。
    const facets = deps.facetResources
      ? deps.facetResources(q, r.items, r.misses, resourceProviderId)
      : { shows: [], loose: [], sources: [] }
    return c.json(facets)
    } catch (e) {
      if (e instanceof SlotBrokenError) return slotBroken422(c, e)
      throw e
    }
  })

  /** 这三条路由的 `platform` 就是 `video.resolve` 的派发键前半截（`<platform>-video`）。
   *  **宿主不认识任何平台**：`vid` 长什么样、怎么换成可播放的流，全归认领那个平台的包。
   *  加一个平台 = 装一个包，这里零改动。 */
  const resolveVideo = makeVideoResolver({
    get executor() { return deps.providers!.executor },
    get bindings() { return deps.providerBindings },
  })
  /** 每次解析后记一条 DebugBox（走了哪条行、谁 decline 了）——那是排查播放失败的唯一现场。
   *  **`diag=1` 那一次不记**：播放器失败分类器在播放失败后会再打一次同一条 `play?…&diag=1`
   *  读失败信封（`app/src/components/ArtPlayer.tsx`），那是对刚才那次失败的复读，再记一条就是
   *  同一次失败在 DebugBox 里出现两回。所以记录放在路由里按请求判，而不是挂在解析器的横切回调上。 */
  const recordVideoResolve = (c: Context, platform: string, vid: string, res: InvokeResult | null | undefined) => {
    if (c.req.query('diag') === '1') return
    recordDebug(buildResolveEntry('video-resolve', platform, vid, res ?? null))
  }
  const videoArgs = (c: Context): { platform: string; vid: string } | null => {
    const platform = c.req.query('platform')
    const vid = c.req.query('vid')
    return platform && vid ? { platform, vid } : null
  }
  /** 解析为空时的回执，play / dash 共用一份判据。**内容本身没有**（某个成员抛了「内容不可用」，
   *  miss 带 `unavailable`）回 404 + 站方原话——那不是我们这边挂了，用户重试、报修都白搭；
   *  其余一律 502，`detail` 带第一条 miss 的 reason（有就带：一句"declined (no result)"也比空信封
   *  好排查），没有任何 miss（没有行匹配这个平台）就不带。 */
  const unresolvedResponse = (c: Context, res: InvokeResult | null | undefined): Response => {
    const miss = res?.misses ?? []
    const gone = miss.find((m) => m.unavailable)
    if (gone) return c.json({ error: 'unavailable', detail: gone.reason }, 404)
    const first = miss[0]?.reason
    return c.json({ error: 'unresolved', ...(first ? { detail: first } : {}) }, 502)
  }

  // 本机播放：解析成渐进式整片，带上那个 CDN 要的请求头代理它的字节（<video> 可 seek）。
  app.get('/api/media/play', async (c) => {
    const args = videoArgs(c)
    if (!args) return c.json(errorBody('validation_error', 'platform and vid required'), 400)
    if (!deps.providers) return c.json({ error: 'providers not configured' }, 503)
    let r: VideoResolved | null
    const sink: { last?: InvokeResult | null } = {}
    try { r = await resolveVideo(args.platform, args.vid, 'progressive', slotCtx(c), sink) }
    catch (e) { if (e instanceof SlotBrokenError) return slotBroken422(c, e); throw e }
    recordVideoResolve(c, args.platform, args.vid, sink.last)
    if (r?.kind !== 'progressive') return unresolvedResponse(c, sink.last)
    const resp = await proxyRangedStream(r.url, r.headers, c.req.header('Range'), r.mime)
    return c.req.query('dl') === '1' ? asDownload(resp, c.req.query('name') || args.vid) : resp
  })

  // DASH manifest（分离流高码率）给 dash.js 播；每条流的 BaseURL 指向下面那条分片路由。
  //
  // 分片信任表在这里登记，不在包里：那张表是宿主进程的单例，而返回 DashResult 的包可能是
  // 用户层从 `dist/index.js` 装载的一份 bundle——它若自己 import `rememberSegHosts`，bundle 里
  // 会 inline 出第二张空表，登了也白登，随后每条分片 403 且无处报错。所以包只在
  // `manifest.headers` 里申报请求头，路由拿到结果后按全部流 URL（主 + 备节点）登记。
  app.get('/api/media/dash', async (c) => {
    const args = videoArgs(c)
    if (!args) return c.json(errorBody('validation_error', 'platform and vid required'), 400)
    if (!deps.providers) return c.json({ error: 'providers not configured' }, 503)
    let r: VideoResolved | null
    const sink: { last?: InvokeResult | null } = {}
    try { r = await resolveVideo(args.platform, args.vid, 'dash', slotCtx(c), sink) }
    catch (e) { if (e instanceof SlotBrokenError) return slotBroken422(c, e); throw e }
    recordVideoResolve(c, args.platform, args.vid, sink.last)
    if (r?.kind !== 'dash') return unresolvedResponse(c, sink.last)
    rememberSegHosts(allStreamUrls(r.manifest), r.manifest.headers ?? {})
    return c.body(buildDashMpd(r.manifest), 200, { 'Content-Type': 'application/dash+xml' })
  })

  // 分片代理：主机必须是某个解析器刚刚登记过的（SSRF 闸门），请求头也从那份登记里取——
  // 这条路由自己不认识任何站点的 Referer / Cookie。主节点（u=）不行就依次试备节点（b=），
  // TTFB 超时或 5xx 即切换，一个死掉的 CDN 节点卡不住整条播放。
  app.get('/api/media/seg', async (c) => {
    const mime = c.req.query('m') === 'audio' ? 'audio/mp4' : 'video/mp4'
    const range = c.req.header('Range')
    const candidates = [c.req.query('u'), ...(c.req.queries('b') ?? [])].filter(
      (x): x is string => !!x && isAllowedSegHost(x)
    )
    if (candidates.length === 0) return c.json({ error: 'bad url' }, 400)
    let lastErr = 'all candidates failed'
    for (let i = 0; i < candidates.length; i++) {
      const last = i === candidates.length - 1
      // 非末节点快速切换（4s TTFB）。末节点没有下一档可落，给宽窗口 + 一次重试：冷的 CDN
      // 节点第一个字节常常超时，热起来之后好得很，过早放弃会掐死 init 分片，表现成"整个视频加载不出来"。
      for (let attempt = 0; attempt < (last ? 2 : 1); attempt++) {
        try {
          const resp = await proxyUrl(candidates[i], range, mime, last ? 9000 : 4000, segHeadersFor(candidates[i]))
          if (resp.status < 500 || last) return resp
          await resp.body?.cancel().catch(() => {}) // 5xx 且还有备节点 → 丢掉，试下一个
          lastErr = `upstream ${resp.status}`
          break
        } catch (e) {
          lastErr = String((e as Error).message) // abort/网络错 → 重试（末节点）或换下一个
        }
      }
    }
    return c.json({ error: lastErr }, 502)
  })

  // 一键冷启动：交给认领了这个域的那个包（`activate()` 的 `connect`），它自己决定订阅什么。
  app.post('/api/credentials/:domain/connect', async (c) => {
    const domain = c.req.param('domain').toLowerCase()
    const connect = deps.packageConnect?.get(domain)
    if (connect) {
      try {
        const { stream, extra } = await connect()
        deps.service.subscribe(stream)
        return c.json({ ok: true, id: stream.id, ...(extra ?? {}) })
      } catch (e) {
        // 鸭子判：包 bundle 里的 ValidationError 是另一份类，instanceof 判不出会把 400 变 502。
        if (isValidationError(e)) return c.json(errorBody('validation_error', (e as Error).message), 400)
        return c.json(errorBody('upstream_error', String((e as Error).message)), 502)
      }
    }
    return c.json({ error: { code: 'not_found', message: 'unknown credential domain' } }, 404)
  })

  // A facility's live page — the tab its DEFAULT lane is riding right now. A real resource, so it
  // is addressed as one; the fact that we mostly read it to debug a harvest doesn't make "debug"
  // the noun. `facility` (not a tabId) is the address because that is the name a caller actually
  // holds — the lane's tab is Stream's own and has no id anyone outside could have learned.
  //
  // Scope: the default lane only. A facility may hold several lanes (lane = facility + laneKey,
  // up to maxLanesPerFacility) and this route reaches just the unkeyed one — which is the lane
  // recipes ride unless they ask otherwise, hence the useful one to look at.
  //
  // Why it exists at all: without it, debugging a harvest means edit → restart → re-run → squint at
  // whatever you happened to log — guessing at the page's state instead of reading it. Opening the
  // same URL in another tab is not the same page: the harvest tab is mid-run, with that run's
  // scroll position, ledger and login state. So the only vantage point is this tab.
  // Reads queue behind that lane's task tail, so they never interleave with a running recipe.
  /**
   * 收尾一个 facility：关掉它名下所有标签。**幂等**——没有活标签也回 200，因为调用方
   * （前端离开频道时的 cleanup）没有、也不该有"现在到底开着没"的知识。
   *
   * 为什么需要一个显式的收尾信号：持久标签的生命周期本该绑在**使用者的意图**上（"我还在这个
   * 频道里"），而不是绑在超时或内存阈值上——后两者都是在猜。猜出来的结果就是标签要么关早了
   * （会话白重建），要么一直挂着。异常路径（用户直接关标签 / 浏览器崩了 / 人走了）这个回调跑
   * 不到，那一档由 browser-lane-reaper 定时任务兜底，两者职责不重叠。
   */
  app.post('/api/facilities/:id/close', async (c) => {
    if (!deps.closeFacilityTabs) return c.json(errorBody('unavailable', 'facility sessions not available'), 503)
    const facility = c.req.param('id')
    await deps.closeFacilityTabs(facility)
    return c.json({ ok: true, facility })
  })

  app.get('/api/facilities/:id/page', async (c) => {
    if (!deps.pageLook) return c.json(errorBody('unavailable', 'live page not available'), 503)
    const facility = c.req.param('id')
    const read = await deps.pageLook(facility, '({url: location.href, title: document.title})')
    if (!read) return c.json(errorBody('not_found', `no live tab for facility ${facility}`), 404)
    return c.json({ facility, ...(read.value as Record<string, unknown>) })
  })
  app.get('/api/facilities/:id/page/screenshot', async (c) => {
    if (!deps.pageShot) return c.json(errorBody('unavailable', 'live page not available'), 503)
    const facility = c.req.param('id')
    const b64 = await deps.pageShot(facility)
    if (!b64) return c.json(errorBody('not_found', `no live tab for facility ${facility}`), 404)
    return c.body(Buffer.from(b64, 'base64'), 200, { 'content-type': 'image/jpeg' })
  })
  // POST because each call CREATES an evaluation of `expression` against the page — the result is
  // not addressable and not cacheable, so it is not a GET.
  app.post('/api/facilities/:id/page/evaluations', async (c) => {
    if (!deps.pageLook) return c.json(errorBody('unavailable', 'live page not available'), 503)
    const facility = c.req.param('id')
    const body = await c.req.json().catch(() => undefined)
    const gate = strictBody(c, body, PAGE_EVAL_KEYS)
    if (gate) return gate
    const expression = isObject(body) ? body.expression : undefined
    if (typeof expression !== 'string' || !expression) {
      return c.json(errorBody('validation_error', 'expression is required'), 400)
    }
    try {
      const read = await deps.pageLook(facility, expression)
      if (!read) return c.json(errorBody('not_found', `no live tab for facility ${facility}`), 404)
      return c.json({ value: read.value }, 201)
    } catch (e) {
      return c.json(errorBody('upstream_error', String((e as Error).message)), 502)
    }
  })

  // 「收藏」——统一多列表系统,横跨 video/audio(见 collections/store.ts 头注)。key 是单个 URL 段
  // (如 `tmdb:movie:1368337`、`track:<platform>:12345`),由前端拼、原样 encodeURIComponent 传。
  function parseCollectedItemKey(raw: string): CollectedItemKey | null {
    if (raw.startsWith('episode:')) {
      const rest = raw.slice('episode:'.length)
      // 找第一个 `:` 切 streamId/itemId——假定 streamId 本身不含冒号(itemId 可以,如 xhs 笔记 id
      // 常见 `xxx:yyy` 这种合成串,所以用 indexOf 不是 split,取第一段而非按冒号切三份)。今天成立
      // (streamId 是 scheduler 生成的短 id),如果 streamId 生成规则以后引入冒号,这里要跟着改。
      const sep = rest.indexOf(':')
      if (sep <= 0 || sep === rest.length - 1) return null
      return { kind: 'episode', streamId: rest.slice(0, sep), itemId: rest.slice(sep + 1) }
    }
    const [kind, a, b] = raw.split(':')
    if (kind === 'stream' && a) return { kind: 'stream', streamId: a }
    if (kind === 'tmdb' && (a === 'movie' || a === 'tv') && b) return { kind: 'tmdb', media: a, id: b }
    if (kind === 'track' && a && b) return { kind: 'track', platform: a, trackId: b }
    return null
  }

  app.get('/api/collections', (c) => {
    if (!deps.collections) return c.json({ error: { code: 'unavailable', message: 'collections not available' } }, 503)
    const domain = c.req.query('domain')
    if (domain !== undefined && domain !== 'video' && domain !== 'audio') return c.json({ error: { code: 'bad_request', message: 'domain must be video or audio' } }, 400)
    const anchor = c.req.query('anchor') || undefined
    return c.json(deps.collections.listCollections(domain, anchor))
  })

  app.post('/api/collections', async (c) => {
    if (!deps.collections) return c.json({ error: { code: 'unavailable', message: 'collections not available' } }, 503)
    const body = (await c.req.json().catch(() => ({}))) as { domain?: string; label?: string; anchorStreamId?: string }
    const gate = strictBody(c, body, COLLECTION_CREATE_KEYS)
    if (gate) return gate
    if (body.domain !== 'video' && body.domain !== 'audio') return c.json({ error: { code: 'bad_request', message: 'domain must be video or audio' } }, 400)
    if (!body.label?.trim()) return c.json({ error: { code: 'bad_request', message: 'label required' } }, 400)
    if (body.anchorStreamId !== undefined && body.domain !== 'audio') return c.json({ error: { code: 'bad_request', message: 'anchorStreamId is audio-only' } }, 400)
    return c.json(deps.collections.createCollection(body.domain, body.label.trim(), body.anchorStreamId?.trim() || undefined))
  })

  app.patch('/api/collections/:id', async (c) => {
    if (!deps.collections) return c.json({ error: { code: 'unavailable', message: 'collections not available' } }, 503)
    const body = (await c.req.json().catch(() => ({}))) as { label?: string }
    const gate = strictBody(c, body, COLLECTION_PATCH_KEYS)
    if (gate) return gate
    if (!body.label?.trim()) return c.json({ error: { code: 'bad_request', message: 'label required' } }, 400)
    const updated = deps.collections.renameCollection(c.req.param('id'), body.label.trim())
    return updated ? c.json(updated) : c.json({ error: { code: 'not_found', message: 'collection not found' } }, 404)
  })

  app.delete('/api/collections/:id', (c) => {
    if (!deps.collections) return c.json({ error: { code: 'unavailable', message: 'collections not available' } }, 503)
    const ok = deps.collections.deleteCollection(c.req.param('id'))
    return ok ? c.json({ ok: true }) : c.json({ error: { code: 'bad_request', message: 'not found, or a system collection (正在追的/我的喜欢 cannot be deleted)' } }, 400)
  })

  app.post('/api/collections/:id/playlist-export', (c) => {
    if (!deps.collections) return c.json(errorBody('unavailable', 'collections not available'), 503)
    if (!deps.audioArchive) return c.json(errorBody('unavailable', 'audio archive not configured'), 503)
    const id = c.req.param('id')
    const collection = deps.collections.getCollection(id)
    if (!collection) return c.json(errorBody('not_found', 'collection not found'), 404)
    const snapshots = deps.collections.itemsOf(id)
    const refs = snapshots
      .filter((snap) => snap.kind === 'track' && snap.platform && snap.trackId)
      .map((snap) => ({ platform: snap.platform!, id: snap.trackId!, title: snap.title, artist: snap.artist }))
    // 非 track 成员(如 episode)在上面的 filter 里就被静默排除,不进 written 也不进 skipped——
    // 与 streams 路由 extractTrackRef 返回 null 时的丢弃方式一致(见上文 /api/streams/:id/playlist-export),
    // 结果原样透传给前端,不做二次折算。
    try {
      return c.json(exportPlaylistM3u(deps.audioArchive, collection.label, refs))
    } catch (e) {
      return c.json(errorBody('internal', (e as Error).message), 500)
    }
  })

  app.get('/api/collections/:id/items', (c) => {
    if (!deps.collections) return c.json({ error: { code: 'unavailable', message: 'collections not available' } }, 503)
    if (!deps.collections.getCollection(c.req.param('id'))) return c.json({ error: { code: 'not_found', message: 'collection not found' } }, 404)
    return c.json(deps.collections.itemsOf(c.req.param('id')))
  })

  // 多选批量加入——整批解析先行,任一坏 key 报 400 不落库;落库走 store 单事务(spec §4/§6)。
  app.post('/api/collections/:id/items', async (c) => {
    if (!deps.collections) return c.json({ error: { code: 'unavailable', message: 'collections not available' } }, 503)
    if (!deps.collections.getCollection(c.req.param('id'))) return c.json({ error: { code: 'not_found', message: 'collection not found' } }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { items?: Array<{ key?: string; title?: string; poster?: string; artist?: string; album?: string; durationS?: number; sourceUrl?: string }> }
    const gate = strictBody(c, body, COLLECTION_ITEMS_KEYS)
    if (gate) return gate
    if (!Array.isArray(body.items) || body.items.length === 0) return c.json({ error: { code: 'bad_request', message: 'items required' } }, 400)
    const parsed: Array<{ key: CollectedItemKey; meta: { title: string; poster?: string; artist?: string; album?: string; durationS?: number; sourceUrl?: string } }> = []
    for (const it of body.items) {
      // 顶层只有一个 `items`，写错的键几乎总在元素里（`name` 而不是 `title` 之类）——
      // 元素不过闸，这道门就等于没开。判据与理由见 http/strict-input.ts。
      const entryGate = strictBody(c, it, COLLECTION_ITEM_ENTRY_KEYS)
      if (entryGate) return entryGate
      const key = it.key ? parseCollectedItemKey(it.key) : null
      if (!key) return c.json({ error: { code: 'bad_request', message: `invalid item key: ${it.key ?? '(missing)'}` } }, 400)
      if (!it.title) return c.json({ error: { code: 'bad_request', message: `title required: ${it.key}` } }, 400)
      parsed.push({ key, meta: { title: it.title, poster: it.poster, artist: it.artist, album: it.album, durationS: it.durationS, sourceUrl: it.sourceUrl } })
    }
    return c.json(deps.collections.addItems(c.req.param('id'), parsed))
  })

  // 手动排序：整份名单进，不收增量（理由见 CollectionsStore.reorder）。名单不完整/有重复 → 400,
  // 一行都不写；成功后返回重排后的成员，前端不必再拉一次。
  app.put('/api/collections/:id/order', async (c) => {
    if (!deps.collections) return c.json({ error: { code: 'unavailable', message: 'collections not available' } }, 503)
    const id = c.req.param('id')
    if (!deps.collections.getCollection(id)) return c.json({ error: { code: 'not_found', message: 'collection not found' } }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { keys?: unknown }
    const gate = strictBody(c, body, COLLECTION_ORDER_KEYS)
    if (gate) return gate
    if (!Array.isArray(body.keys) || body.keys.some((k) => typeof k !== 'string')) {
      return c.json({ error: { code: 'bad_request', message: 'keys required (string[])' } }, 400)
    }
    try {
      deps.collections.reorder(id, body.keys as string[])
    } catch (e) {
      return c.json({ error: { code: 'bad_request', message: String((e as Error).message) } }, 400)
    }
    return c.json(deps.collections.itemsOf(id))
  })

  app.put('/api/collections/:id/items/:key', async (c) => {
    if (!deps.collections) return c.json({ error: { code: 'unavailable', message: 'collections not available' } }, 503)
    if (!deps.collections.getCollection(c.req.param('id'))) return c.json({ error: { code: 'not_found', message: 'collection not found' } }, 404)
    const key = parseCollectedItemKey(c.req.param('key'))
    if (!key) return c.json({ error: { code: 'bad_request', message: 'invalid item key' } }, 400)
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string; poster?: string; artist?: string; album?: string; durationS?: number; sourceUrl?: string
    }
    const gate = strictBody(c, body, COLLECTED_ITEM_KEYS)
    if (gate) return gate
    if (!body.title) return c.json({ error: { code: 'bad_request', message: 'title required' } }, 400)
    return c.json(deps.collections.addItem(c.req.param('id'), key, body as { title: string } & typeof body))
  })

  app.delete('/api/collections/:id/items/:key', (c) => {
    if (!deps.collections) return c.json({ error: { code: 'unavailable', message: 'collections not available' } }, 503)
    const key = parseCollectedItemKey(c.req.param('key'))
    if (!key) return c.json({ error: { code: 'bad_request', message: 'invalid item key' } }, 400)
    deps.collections.removeItem(c.req.param('id'), key)
    return c.json({ ok: true })
  })

  // 「这个东西现在在哪些列表里」——收藏面板打开时用它决定复选框初始状态。
  app.get('/api/collected/:key', (c) => {
    if (!deps.collections) return c.json({ error: { code: 'unavailable', message: 'collections not available' } }, 503)
    const key = parseCollectedItemKey(c.req.param('key'))
    if (!key) return c.json({ error: { code: 'bad_request', message: 'invalid item key' } }, 400)
    return c.json({ item: deps.collections.getItem(key), collectionIds: deps.collections.collectionsFor(key).map((coll) => coll.id) })
  })

  // 「继续观看」——服务端记录视频播放进度,取代原来的浏览器 localStorage(见 watch-progress-store.ts 头注)。
  // :key 段由调用方 encodeURIComponent(如 `tmdb:261391:S03E02`),这里统一 decode。
  app.put('/api/watch-progress/:key', async (c) => {
    if (!deps.watchProgress) return c.json(errorBody('unavailable', 'watch progress store not configured'), 503)
    const key = decodeURIComponent(c.req.param('key'))
    const body = (await c.req.json().catch(() => ({}))) as {
      position?: number; duration?: number; workKey?: string; workTitle?: string; workPoster?: string; epLabel?: string
      channelId?: string
    }
    const gate = strictBody(c, body, WATCH_PROGRESS_KEYS)
    if (gate) return gate
    const { position, duration, workKey, workTitle, workPoster, epLabel, channelId } = body
    if (!Number.isFinite(position) || position! < 0) return c.json(errorBody('validation_error', 'position must be a finite number >= 0'), 400)
    if (!Number.isFinite(duration) || duration! < 0) return c.json(errorBody('validation_error', 'duration must be a finite number >= 0'), 400)
    if (!workKey?.trim()) return c.json(errorBody('validation_error', 'workKey required'), 400)
    if (!workTitle?.trim()) return c.json(errorBody('validation_error', 'workTitle required'), 400)
    const row = deps.watchProgress.put({ key, position: position!, duration: duration!, workKey, workTitle, workPoster, epLabel, channelId })
    return c.json(row)
  })

  app.get('/api/watch-progress/:key', (c) => {
    if (!deps.watchProgress) return c.json(errorBody('unavailable', 'watch progress store not configured'), 503)
    const key = decodeURIComponent(c.req.param('key'))
    return c.json(deps.watchProgress.get(key))
  })

  // 「继续观看」货架——已按 workKey 去重、已看完排除、按最近更新排序(见 WatchProgressStore.inProgress)。
  // `?channel=<id>`(可重复)把货架切到那些频道:频道存在的意义就是把内容分开,儿童频道不该出现
  // 大人正在追的剧。不带参数 = 整份(`/video` 那个聚合入口)。
  //
  // **归属未知的老行(channel_id 上线前写的)算影视频道的**——这条政策落在这里,不在 store 里:
  // "哪个频道是视频的默认落点"是产品判断,store 只认 id。老行几乎必然来自影视频道(儿童频道是
  // 后建的),归给它比让它在每个频道都冒出来诚实得多。
  app.get('/api/watch-progress', (c) => {
    if (!deps.watchProgress) return c.json(errorBody('unavailable', 'watch progress store not configured'), 503)
    const channels = c.req.queries('channel')?.filter(Boolean)
    if (!channels?.length) return c.json(deps.watchProgress.inProgress({ limit: 20 }))
    return c.json(deps.watchProgress.inProgress({
      limit: 20,
      channels,
      unattributed: channels.includes(DEFAULT_VIDEO_CHANNEL_ID),
    }))
  })

  app.delete('/api/watch-progress/:key', (c) => {
    if (!deps.watchProgress) return c.json(errorBody('unavailable', 'watch progress store not configured'), 503)
    const key = decodeURIComponent(c.req.param('key'))
    deps.watchProgress.remove(key)
    return c.json({ ok: true })
  })

  // 意图跟踪——订阅的单位从"源"升到"目的"。立/列/档案/招源/消化/退休，见 src/intent/service.ts。
  app.post('/api/intents', async (c) => {
    if (!deps.intents) return c.json(errorBody('unavailable', 'intent 服务未装配'), 503)
    const body = (await c.req.json().catch(() => ({}))) as { goal?: string; streamIds?: unknown; recruit?: boolean }
    const gate = strictBody(c, body, INTENT_CREATE_KEYS)
    if (gate) return gate
    if (typeof body.goal !== 'string' || !body.goal.trim()) return c.json(errorBody('validation_error', 'goal 必填'), 400)
    if (body.streamIds !== undefined && !stringArray(body.streamIds)) {
      return c.json(errorBody('validation_error', 'streamIds 必须是 string[]'), 400)
    }
    try {
      const rec = await deps.intents.create({
        goal: body.goal,
        streamIds: stringArray(body.streamIds) ? body.streamIds : undefined,
      })
      let recruited: Awaited<ReturnType<typeof deps.intents.recruit>> | undefined
      if (body.recruit === true) {
        try {
          recruited = await deps.intents.recruit(rec.id)
        } catch {
          // 招源失败不影响立意图——意图已经立住了，招源可以事后重试。
        }
      }
      return c.json({ ...deps.intents.get(rec.id), ...(recruited ? { recruited } : {}) }, 201)
    } catch (e) {
      // 参数校验都在上面的 400；走到这的是 LLM/落盘失败（phase2 spec §4）
      return c.json(errorBody('upstream_error', (e as Error).message), 500)
    }
  })

  app.get('/api/intents', (c) => {
    if (!deps.intents) return c.json(errorBody('unavailable', 'intent 服务未装配'), 503)
    return c.json({ intents: deps.intents.list() })
  })

  app.get('/api/intents/:id', (c) => {
    if (!deps.intents) return c.json(errorBody('unavailable', 'intent 服务未装配'), 503)
    const rec = deps.intents.get(c.req.param('id'))
    if (!rec) return c.json(errorBody('not_found', 'intent not found'), 404)
    return c.json(rec)
  })

  app.get('/api/intents/:id/dossier', (c) => {
    if (!deps.intents) return c.json(errorBody('unavailable', 'intent 服务未装配'), 503)
    const dossier = deps.intents.dossier(c.req.param('id'))
    if (dossier === null) return c.json(errorBody('not_found', 'intent not found'), 404)
    return new Response(dossier, { headers: { 'content-type': 'text/markdown; charset=utf-8' } })
  })

  app.post('/api/intents/:id/recruit', async (c) => {
    if (!deps.intents) return c.json(errorBody('unavailable', 'intent 服务未装配'), 503)
    if (!deps.intents.get(c.req.param('id'))) return c.json(errorBody('not_found', 'intent not found'), 404)
    try {
      return c.json(await deps.intents.recruit(c.req.param('id')))
    } catch (e) {
      const msg = (e as Error).message
      // 只有 recruit 动作面没装配才 503；'LLM 未配置' 等上游失败统一 500，与 create 同语义
      if (msg.includes('recruit 未配置')) return c.json(errorBody('unavailable', msg), 503)
      if (msg.includes('已退休')) return c.json(errorBody('conflict', msg), 409) // 调用方错误：意图状态不允许
      return c.json(errorBody('upstream_error', msg), 500) // 其余(含上游 LLM 失败)
    }
  })

  app.post('/api/intents/:id/digest', async (c) => {
    if (!deps.intents) return c.json(errorBody('unavailable', 'intent 服务未装配'), 503)
    if (!deps.intents.get(c.req.param('id'))) return c.json(errorBody('not_found', 'intent not found'), 404)
    try {
      return c.json(await deps.intents.digestNow(c.req.param('id')))
    } catch (e) {
      return c.json(errorBody('upstream_error', (e as Error).message), 500)
    }
  })

  app.post('/api/intents/:id/retire', (c) => {
    if (!deps.intents) return c.json(errorBody('unavailable', 'intent 服务未装配'), 503)
    const rec = deps.intents.retire(c.req.param('id'))
    if (!rec) return c.json(errorBody('not_found', 'intent not found'), 404)
    return c.json(rec)
  })

  // 「下载页引用 → 下载项」的唯一问答口（原 `/api/media/magnet`，随成员契约落地改形）。
  // 搜索结果里 needsResolve=true 的行,其 link 是来源站的中转页(btbtla 一季 100+ 行,上来就
  // 逐条解析太多次抓取),消费方按需解析单行。脑子在 ProviderService.resolveDownloads(经
  // download-resolve 行 decline-chain,MCP video_resolve 同吃);这里只做 HTTP 那一半:
  // 参数校验 + 错误翻译(unsupported → 400,槽位坏 → 422,其余 → 502)。
  // 播放类不在这里——那是送字节的活,归 /api/media/* 各自的代理路 + src/media/serving.ts 那张表。
  // 独立顶层资源,不挂在 /api/downloads 下:那是下载队列(GET 列任务/POST 入队),本端点的
  // 返回物由 ?url= 现算,与队列里任何任务都无从属关系——层级会撒谎,所以不攀。裸
  // /api/downloads 也占用了(路由冲突守卫钉着)。
  app.get('/api/download-options', async (c) => {
    // 写错参数名不静默——判据与理由见 http/strict-input.ts。
    const badQuery = unknownKey(Object.keys(c.req.query()), DOWNLOAD_OPTIONS_QUERY_KEYS)
    if (badQuery) return c.json(errorBody('validation_error', unknownKeyMessage('查询参数', badQuery, DOWNLOAD_OPTIONS_QUERY_KEYS)), 400)
    const url = c.req.query('url') ?? ''
    if (!url) return c.json(errorBody('validation_error', 'url required'), 400)
    if (!deps.resolveDownloads) return c.json(errorBody('unavailable', 'providers not configured'), 503)
    try {
      return c.json({ options: await deps.resolveDownloads(url, slotCtx(c)) })
    } catch (e) {
      if (e instanceof SlotBrokenError) return slotBroken422(c, e)
      const msg = (e as Error).message
      const bad = msg.includes('unsupported url')
      return c.json(errorBody(bad ? 'validation_error' : 'upstream_error', msg), bad ? 400 : 502)
    }
  })

  // Image proxy for source-provided covers/posters (pansou + btbtla). Fetched
  // server-side with NO Referer so the many hotlink-protected image hosts (qpic,
  // baidu gimg, small CDNs) serve the bytes — a direct browser <img> to them is
  // blocked, so the picture would silently never load.
  //
  // Favicon proxy — resolves a site's icon server-side (the backend reaches sites a
  // CN browser can't, third-party favicon services are blocked) for items with no
  // real author avatar (RSS). Loaded via <img src>, cached 24h, 404 → initial fallback.
  app.get('/api/media/image', async (c) => {
    const url = c.req.query('url')
    const site = c.req.query('site')
    if (url !== undefined) {
      if (!/^https?:\/\//.test(url)) return c.body(null, 400)
      // dl=1 → save instead of display (a cross-origin <a download> can't set a filename,
      // but Content-Disposition can, and the body still streams through from our origin).
      const dl = c.req.query('dl') === '1'
      const name = c.req.query('name') ?? ''
      try {
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), 8000)
        let upstream: { status: number; contentType: string | null; body: Readable }
        try {
          // Native http(s), NOT global fetch: RSSHub's request-rewriter (embedded process-wide)
          // patches globalThis.fetch to inject a self-origin Referer when one is absent, which xhs's
          // image CDN (sns-webpic-qc.xhscdn.com) rejects with 403. This proxy's whole point is to
          // fetch hotlink-protected covers with NO Referer, so it must bypass that wrapper. (The
          // rest of the app keeps the wrapped fetch — it wants the proxy/UA rewriting.)
          upstream = await getImageNoReferer(url, ac.signal)
        } finally {
          clearTimeout(timer)
        }
        if (upstream.status < 200 || upstream.status >= 300) {
          // **必须留一句话**：上游拒发图时，浏览器那头只是一张空白，这里只回一个裸 502 ——
          // 两头都不说是谁拒的、拒了什么。荔枝那次（gzlzfm 403）就是这样：直连好好的、走代理
          // 全灭，而日志里一个字都没有，只能靠人拿 curl 一台一台去撞。更坏的是这类墙**会自己
          // 好**（同一地址半小时后四种 UA 全 200），所以现场不留下来就永远复现不了。
          const host = new URL(url).host
          console.warn(`[image-proxy] upstream ${upstream.status} ${host}`)
          // stdout 一行只在有人正好盯着那个终端时才算证据——而这类墙半小时后就自己好了。
          // 同一条进 debug bus：`ok:false` → 被 debug-sink 落盘，复发样本才攒得起来。
          const at = Date.now()
          recordDebug({
            id: `image-proxy:${host}@${at}`,
            at,
            channel: 'image-proxy',
            key: host,
            title: `图床拒发（${host}）`,
            summary: `上游 ${upstream.status} —— 代理取图失败，浏览器那头只会是一张空白`,
            ok: false,
            fields: [
              { label: 'status', value: String(upstream.status), tone: 'bad' },
              { label: 'host', value: host },
              { label: 'url', value: url },
              // 这条路径恒不发 UA、恒不发 Referer（getImageNoReferer 的全部意义），所以样本里
              // 每一条都是「裸请求也被拒」——要判「UA 有没有关系」得拿这份样本去比对，不是在
              // 这里记一个恒定值。判据与那张表见 image-fetch.ts 的 BROWSER_UA 头注。
            ],
          })
          return c.body(null, 502)
        }
        const ct = upstream.contentType || 'image/jpeg'
        const h = new Headers()
        h.set('Content-Type', ct)
        h.set('Cache-Control', 'public, max-age=86400')
        if (dl) {
          const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : 'jpg'
          const safe = (name || 'image').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').trim().slice(0, 120) || 'image'
          const ascii = safe.replace(/[^\x20-\x7E]/g, '_')
          h.set('Content-Disposition', `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(safe)}.${ext}`)
        }
        return new Response(Readable.toWeb(upstream.body) as ReadableStream, { status: 200, headers: h })
      } catch {
        return c.body(null, 502)
      }
    } else if (site !== undefined) {
      // site 必须是绝对 http(s) URL：resolveFavicon 对解析失败（如相对路径）返回 null → 404，
      // 会和"这站真没 favicon"混在一起没法区分。非法参数在这里显式 400（前端 faviconUrl 已
      // 拦截相对路径，这层是纵深防御，主要让 DevTools 里的失败可读）。私有 host 仍由
      // resolveFavicon 内部拒绝（SSRF 守卫），保持 404 不暴露"这是私有地址"。
      let parsedSite: URL
      try {
        parsedSite = new URL(site)
      } catch {
        return c.json(errorBody('validation_error', 'site must be an absolute url'), 400)
      }
      if (parsedSite.protocol !== 'http:' && parsedSite.protocol !== 'https:') {
        return c.json(errorBody('validation_error', 'site must be an http(s) url'), 400)
      }
      const icon = await resolveFavicon(site)
      if (!icon) return c.body(null, 404)
      return new Response(icon.body, {
        headers: { 'Content-Type': icon.contentType, 'Cache-Control': 'public, max-age=86400' },
      })
    } else {
      return c.json(errorBody('validation_error', 'url or site required'), 400)
    }
  })

  // 「给我这个链接里的媒体」——先按主机键问 content.enrich 有没有包认领这个站，没有再落宿主
  // 自己的分支（直链图片视频）→ media[]（含 download_url）。
  // 与 /api/enrich?source=link（Defuddle 转成文字）是两件事，所以放在 /api/media 下、名字里带 media：
  // 上一版把它挂成 `?source=url` 与 `?source=link` 并排，两个名字在自然语言里是同义词、产出却毫无
  // 关系，先后骗过三个人。MCP 的 stream_fetch_url 调的是同一个 fetchUrl 函数。
  app.get('/api/media/from-url', async (c) => {
    const url = c.req.query('url')
    if (!url) return c.json(errorBody('validation_error', 'url required'), 400)
    // resolveByLink：providers / bindings 都在（生产装配）才给；最小装配缺席 → fetchUrl 只走宿主分支。
    const fetchDeps: FetchUrlDeps = {
      resolveByLink: deps.providers && deps.providerBindings
        ? makeResolveByLink(deps.providerBindings, deps.providers.executor, slotCtx(c))
        : undefined,
    }
    try {
      return c.json(await fetchUrl(url, fetchDeps))
    } catch (e) {
      if (e instanceof SlotBrokenError) return slotBroken422(c, e)
      return c.json(errorBody('upstream_error', String((e as Error).message)), 502)
    }
  })


  // On-demand content umbrella — "give me this link/entity's content". Article extraction,
  // normalized comment trees, platform metadata (a package's owner/user lookups), and whole-URL
  // normalization (media list + text — the old fetch-url; MCP's stream_fetch_url calls the
  // same function directly). Params are explicit (not an item id) so ephemeral
  // discover/search items enrich too.
  app.get('/api/enrich', async (c) => {
    const source = c.req.query('source')
    try {
      // 包交出来的具名处理器优先（`activate()` 的 `enrichers`）。撞名在装载期就拒过了，
      // 所以这里不会顶掉宿主自己的分支。整袋 query 交过去，返回值原样发。
      const packageEnricher = source ? deps.packageEnrichers?.get(source) : undefined
      // HTTP 面不带取消信号（`Enricher` 的第二参不传）：一次请求一次答，没有"被下一次点击顶掉"这回事。
      if (packageEnricher) return c.json(await packageEnricher(c.req.query()) as never)

      // umbrella extensions dispatched at the route (their deps live at the HTTP layer)
      //
      // **没有 `source=url`**（已退场）：它和 `source=link` 在自然语言里是同义词，产出却毫无
      // 关系（媒体 media[] vs 文章 article）——这个名字先后骗过三个人（两次把正文功能挂上去，
      // 一次在 postman 示例里写了 example.com/article）。消费方为零（前端 EnrichParams 里没有
      // 'url'，MCP 的 stream_fetch_url 直接 import fetchUrl 函数）。媒体抓取的 HTTP 门现在叫
      // `GET /api/media/from-url`——名字里带 media，跟这条正文分支不再撞脸。
      // 网页正文是 `source=link`（Defuddle）：与 extract 的 article 分支共用同一份 Defuddle
      // 实现和缓存（一份抽取、两个投影——阅读器要 html，转成文字要 markdown-lite），但只共用
      // 梯子第一档。article 分支是一条抓取梯子（Defuddle 抽不出正文时降级到 Firecrawl，跑
      // JS）；这里的阅读器没有第二档——SPA 页面在阅读器里仍是空壳，只有走 extract 才会跑 JS 兜底。
      let req: EnrichRequest | null = null
      if (source === 'link') {
        const url = c.req.query('url')
        if (url) req = { source: 'link', url }
      }
      if (!req) return c.json(errorBody('validation_error', 'bad enrich request'), 400)
      return c.json(await enrich(req))
    } catch (e) {
      if (e instanceof SlotBrokenError) return slotBroken422(c, e)
      // 鸭子判：包 bundle 里的 ValidationError 是另一份类，instanceof 判不出会把 400 变 502。
      if (isValidationError(e)) return c.json(errorBody('validation_error', (e as Error).message), 400)
      return c.json(errorBody('upstream_error', String((e as Error).message)), 502)
    }
  })

  /** key/id → 该集当前选中文件的 AList 绝对路径（dirPath+rightFile）。与 /api/media/videos/resolve
   *  用同一个 leftKey 解析规则，只是不解直链——它要的就是路径本身。 */
  const resolveNetdiskPath = (c: Context): string | null => {
    const id = c.req.query('id')
    const key = c.req.query('key')
    const leftKey = key ? key : id ? `item:${id}` : null
    if (!leftKey) return null
    const hit = deps.netdisk?.lookup(leftKey)
    return hit ? `${hit.dirPath}/${hit.rightFile}` : null
  }

  // 网盘字幕轨探测：内嵌轨(ffprobe ~2s) + 同目录外挂 sibling 文件(AList 列目录)两条腿并跑，
  // 各自失败互不拖累。track 标识是带前缀字符串——`embed:<streamIndex>` / `file:<相对路径>`——
  // 前端只透传不解析。恒 200——两条腿全空/失败/没有网盘绑定都返回空数组，前端据此决定要不要
  // 显示字幕开关，不是错误。
  app.get('/api/media/netdisk-subtitle-list', async (c) => {
    const path = resolveNetdiskPath(c)
    if (!deps.netdisk || !path) return c.json({ tracks: [] })
    const dir = path.replace(/\/[^/]+$/, '')
    const videoFile = path.slice(dir.length + 1)
    const [embedded, siblings] = await Promise.all([
      deps.netdisk
        .rawUrl(path)
        .then(probeStreams)
        .then((p) => p.subtitle.map((t) => ({ id: `embed:${t.index}`, ...t })))
        .catch(() => []),
      deps.netdisk
        .listDir(dir)
        .then((files) => matchSiblingSubtitles(files, videoFile))
        .catch(() => []),
    ])
    let tracks: { id: string; lang?: string; title?: string }[] = [...embedded, ...siblings]
    // 本地两条腿全空才在线搜刮（`subtitle-search` 行的成员，站点知识住各自的包）。恒静默降级——
    // 搜刮全 miss/报错都返回空数组。重点是非中国区影视：既无内嵌轨也无 sibling 时的最后一条来源。
    const executor = deps.providers?.executor
    if (tracks.length === 0 && executor) {
      const netdisk = deps.netdisk
      // 要内容指纹的站得按字节读视频：宿主给一个「按区间读」的能力（AList rawUrl + HTTP Range），
      // 读哪几段、怎么算由包自己决定。
      const size = await netdisk.fileSize(path).catch(() => undefined)
      const read: RangeReader | undefined = size
        ? async (offset, length) => {
            const url = await netdisk.rawUrl(path)
            const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } })
            if (!res.ok) throw new Error(`range fetch HTTP ${res.status}`)
            return new Uint8Array(await res.arrayBuffer())
          }
        : undefined
      const cands = await searchSubtitles(executor, { name: videoFile, size, read })
      // 语言 label 从内容判（文件名不可信）：经那个源取字幕字节转 VTT → detectSubtitleLang，顺带
      // 把转好的 VTT 落进缓存（键与取流端点 `<track id>:vtt` 一致），用户随后选中这条时秒回。
      // **不读缓存**：弹幕判据要看原始 `\move` 标签，而缓存存的是剥掉标签的 VTT，读了就没法再判——
      // 探测本就是 embed+sibling 全空的兜底路径、一次列表调用的事，每次抓新的换来正确性划算。
      const cacheDir = deps.subtitleCacheDir
      const fetchText = async (cand: ScrapeCandidate): Promise<string | null> => {
        try {
          // 探测是列表的一部分，一条慢候选不许拖住整张菜单：5s 没取到就当抓失败（退回文件名线索）。
          const timeout = AbortSignal.timeout(5000)
          const raw = Buffer.from(await Promise.race([
            fetchSubtitleBytes(executor, cand.id),
            new Promise<never>((_, reject) => timeout.addEventListener('abort', () => reject(new Error('timeout')), { once: true })),
          ]))
          if (raw.length > 5 * 1024 * 1024) return null
          // 弹幕伪装成 .ass（满屏 \move 滚动评论）当字幕就是乱码——判出来返回空 VTT，让这条候选被
          // labelScrapeCandidates 当「抓到但没对白」丢掉，不进菜单。
          if (isLikelyDanmaku(decodeSubtitleText(raw))) return 'WEBVTT\n\n'
          const vtt = siblingToVtt(raw, decodeScrapeTrackId(cand.id)?.id ?? '')
          if (cacheDir) await writeCachedSubtitle(cacheDir, `${cand.id}:vtt`, Buffer.from(vtt, 'utf8')).catch(() => {})
          return vtt
        } catch {
          return null
        }
      }
      tracks = await labelScrapeCandidates(cands, fetchText).catch(() => [])
    }
    return c.json({ tracks })
  })

  // 抽音轨判决的**只读**视图：能从哪几个容器里抽（原盘 + 网盘各转码档）、各多大、会选哪个，
  // 以及选中那个容器里有哪几条音轨、会取哪条。和 netdisk-subtitle-list 对称（懒探测 ~3s，
  // 恒 200，取不到就是空），但多回答一个问题：**为什么**是那个。抽一次音轨要几分钟，事后才从
  // 日志读到理由太晚了；这条路只探元数据，不下载内容。
  //
  // 判决用的是 pickAudioContainer/pickAudioTrack 本体，不是复刻——一个和真实行为不一致的解释
  // 端点比没有更糟，因为它会被相信。档位直链和它的 cookie 都不外泄，只给 label 和大小。
  app.get('/api/media/netdisk-audio-list', async (c) => {
    const path = resolveNetdiskPath(c)
    if (!deps.netdisk || !path) return c.json({ containers: [], tracks: [] })
    try {
      const [size, candidates] = await Promise.all([
        deps.netdisk.fileSize(path).catch(() => undefined),
        transcodeCandidatesFor(deps)(path).catch(() => []),
      ])
      const containers: AudioContainer[] = [
        { kind: 'original', label: 'original', bytes: size },
        ...candidates.map(transcodeContainer),
      ]
      const chosen = pickAudioContainer(containers)!
      const url = chosen.kind === 'transcode' ? chosen.url! : await deps.netdisk.rawUrl(path)
      const { audio, durationS } = await probeStreams(url, { headers: chosen.headers })
      const picked = pickAudioTrack(audio)
      const strip = ({ url: _u, headers: _h, ...rest }: AudioContainer) => rest
      return c.json({
        durationS,
        containers: containers.map(strip),
        chosen: strip(chosen),
        tracks: audio.map((t) => ({ ...t, label: trackLabel(t), effectiveBitrate: effectiveBitrate(t) })),
        track: picked ? { ...picked, label: trackLabel(picked) } : undefined,
      })
    } catch (e) {
      return c.json({ containers: [], tracks: [], error: String((e as Error).message) })
    }
  })

  // 网盘字幕取流：`track=embed:<n>` 走 ffmpeg 现抽内嵌轨(~20s，网络 I/O 密集，见设计文档 §1.1)；
  // `track=file:<相对路径>` 取同目录外挂文件转 VTT(srt/ass 手转 + GB18030 回退，见
  // src/media/sibling-subtitles.ts)。两种都落盘缓存 10 天，命中秒回；内嵌轨缓存 key 与旧
  // index 契约同形，存量缓存继续命中。
  app.get('/api/media/netdisk-subtitle', async (c) => {
    if (!deps.netdisk || !deps.subtitleCacheDir) return c.json({ error: 'unavailable' }, 503)
    const path = resolveNetdiskPath(c)
    if (!path) return c.json({ error: 'id or key required' }, 400)
    const track = c.req.query('track') ?? ''
    const embed = /^embed:(\d+)$/.exec(track)
    const file = /^file:(.+)$/.exec(track)
    const scrape = track.startsWith('scrape:') ? decodeScrapeTrackId(track) : null
    if (!embed && !file && !scrape) {
      return c.json({ error: 'track required (embed:<n> | file:<relPath> | scrape:<...>)' }, 400)
    }
    const serveVtt = (bytes: Buffer) =>
      c.body(Uint8Array.from(bytes), 200, { 'content-type': 'text/vtt; charset=utf-8', 'cache-control': 'no-store' })

    if (embed) {
      const index = Number(embed[1])
      const cacheKey = `${path}:${index}`
      const cached = await readCachedSubtitle(deps.subtitleCacheDir, cacheKey)
      if (cached) return serveVtt(cached)
      try {
        const url = await deps.netdisk.rawUrl(path)
        const { bytes } = await extractStream(url, { index, kind: 'subtitle' })
        await writeCachedSubtitle(deps.subtitleCacheDir, cacheKey, bytes)
        return serveVtt(bytes)
      } catch (e) {
        return c.json({ error: 'extract_failed', detail: String((e as Error).message) }, 502)
      }
    }

    // scrape:<源全名>:<base64url(包给的 id)> —— 在线搜刮结果。宿主不 fetch 任何字幕站的 URL：解码出
    // 那个源，只调它的 op:'fetch'（主机白名单 = SSRF 边界住在包里）；取流转 VTT 复用 sibling 那套。
    if (scrape) {
      const cacheKey = `${track}:vtt`
      const cached = await readCachedSubtitle(deps.subtitleCacheDir, cacheKey)
      if (cached) return serveVtt(cached)
      const executor = deps.providers?.executor
      if (!executor) return c.json({ error: 'unavailable' }, 503)
      try {
        const raw = Buffer.from(await fetchSubtitleBytes(executor, track))
        if (raw.length > 5 * 1024 * 1024) return c.json({ error: 'extract_failed', detail: 'scrape file too large' }, 502)
        const bytes = Buffer.from(siblingToVtt(raw, scrape.id), 'utf8')
        await writeCachedSubtitle(deps.subtitleCacheDir, cacheKey, bytes)
        return serveVtt(bytes)
      } catch (e) {
        // 那个源被关掉 / 卸掉了：说清楚是哪一家没了，别让它长得像一次普通的抓取失败。
        if (e instanceof SubtitleSourceGone) return c.json({ error: 'subtitle_source_gone', detail: e.message }, 404)
        return c.json({ error: 'extract_failed', detail: String((e as Error).message) }, 502)
      }
    }

    // file:<relPath> —— 相对绑定目录寻址；拒绝越目录（.. / 绝对路径 / 空段）。
    const rel = file![1]
    if (rel.startsWith('/') || rel.split('/').some((seg) => seg === '' || seg === '..')) {
      return c.json({ error: 'bad file track path' }, 400)
    }
    const dir = path.replace(/\/[^/]+$/, '')
    const subPath = `${dir}/${rel}`
    const cacheKey = `${subPath}:vtt`
    const cached = await readCachedSubtitle(deps.subtitleCacheDir, cacheKey)
    if (cached) return serveVtt(cached)
    try {
      const url = await deps.netdisk.rawUrl(subPath)
      const res = await fetch(url)
      if (!res.ok) return c.json({ error: 'extract_failed', detail: `sibling fetch HTTP ${res.status}` }, 502)
      const raw = Buffer.from(await res.arrayBuffer())
      if (raw.length > 5 * 1024 * 1024) return c.json({ error: 'extract_failed', detail: 'sibling file too large' }, 502)
      const bytes = Buffer.from(siblingToVtt(raw, rel), 'utf8')
      await writeCachedSubtitle(deps.subtitleCacheDir, cacheKey, bytes)
      return serveVtt(bytes)
    } catch (e) {
      return c.json({ error: 'extract_failed', detail: String((e as Error).message) }, 502)
    }
  })

  // 网盘音轨提取的调试端点——独立验证用，不用先接好整条 transcribe pipeline。真正给管线用的接口是
  // extractNetdiskAudio()（src/netdisk/extract-audio.ts），这条路由只是它的一层瘦身 HTTP 包装。
  app.get('/api/media/_debug/netdisk-audio', async (c) => {
    if (!deps.netdisk) return c.json({ error: 'unavailable' }, 503)
    const path = resolveNetdiskPath(c)
    if (!path) return c.json({ error: 'id or key required' }, 400)
    try {
      const { bytes, mime } = await extractNetdiskAudio(deps.netdisk, path)
      return c.body(Uint8Array.from(bytes), 200, { 'content-type': mime, 'cache-control': 'no-store' })
    } catch (e) {
      return c.json({ error: 'extract_failed', detail: String((e as Error).message) }, 502)
    }
  })

  // Mapped video episodes have no official fallback: resolve their AList direct link on demand.
  // 两种寻址：`id` = ItemStore 条目（订阅流绑定，键 `item:<id>`）；`key` = 直接给 leftKey
  // （作品级 tmdb 绑定，键 `tmdb:<id>` / `tmdb:<id>:S..E..`）。播放反查本就是键无关的，
  // 唯一要小心的是别再把某种键的形状写死在这一个调用点上。
  app.get('/api/media/videos/resolve', async (c) => {
    const id = c.req.query('id')
    const key = c.req.query('key')
    const leftKey = key ? key : id ? `item:${id}` : null
    if (!leftKey) return c.json({ error: 'id or key required' }, 400)
    const hit = deps.netdisk?.lookup(leftKey)
    if (!hit) return c.json({ error: 'unavailable' }, 404)
    // 网盘视频 + 该网盘有转码播放 Provider（netdisk.play dispatch）→ 走代理转码链（H.264+AAC 有声）；
    // 否则（音频、无转码能力的网盘）原始 AList 直链。判定不含网盘字样——问 netdiskPlay.supports。
    const backend = netdiskBackendOf(hit.dirPath)
    // format=json：给播放器一个可判类型的 JSON（{mode:'native'|'hls', url}），因为 <video src> 跟随 302
    // 后 JS 读不到最终 content-type，无从选原生 vs hls.js。旧的 302 行为对非 json 调用方原样保留。
    const wantJson = c.req.query('format') === 'json'

    // 同目录下某一个候选文件 → {mode, url}。判定按文件各自算——同一季集桶里的画质候选可能落在
    // 不同 mode（如 1080p h264 mp4 能原生直放，4K hevc mkv 需转码），不能假设都跟 hit.rightFile 一样。
    const resolveCandidate = async (rightFile: string): Promise<{ mode: 'native' | 'hls'; url: string }> => {
      const candHit = { setId: hit.setId, dirPath: hit.dirPath, rightFile, lastSyncAt: hit.lastSyncAt }
      const canTranscode = !!backend && NETDISK_VIDEO_EXT.test(rightFile) && !!deps.netdiskPlay?.supports(backend)
      if (canTranscode) {
        const playUrl = `/api/media/netdisk-play?path=${encodeURIComponent(`${hit.dirPath}/${rightFile}`)}`
        // A：文件名标注浏览器能原生播（h264/aac mp4 等）→ 直接给原始直链（网关同源、支持 range），
        // 省掉转码 HLS 的整条复杂度；直链解析失败则回落转码 HLS。否则一律走转码 HLS（B）。
        if (browserPlayableByName(rightFile)) {
          try {
            return { mode: 'native', url: await deps.netdisk!.resolveUrl(candHit) }
          } catch (error) {
            deps.netdisk!.markError(candHit, String((error as Error).message))
          }
        }
        return { mode: 'hls', url: playUrl }
      }
      try {
        return { mode: 'native', url: await deps.netdisk!.resolveUrl(candHit) }
      } catch (error) {
        deps.netdisk!.markError(candHit, String((error as Error).message))
        throw error
      }
    }

    if (!wantJson) {
      // 非 JSON（旧 302 调用方）：始终解主选文件，行为不变。
      const canTranscode = !!backend && NETDISK_VIDEO_EXT.test(hit.rightFile) && !!deps.netdiskPlay?.supports(backend)
      if (canTranscode) return c.redirect(`/api/media/netdisk-play?path=${encodeURIComponent(`${hit.dirPath}/${hit.rightFile}`)}`, 302)
      try {
        return c.redirect(await deps.netdisk!.resolveUrl(hit), 302)
      } catch (error) {
        deps.netdisk!.markError(hit, String((error as Error).message))
        return netdiskPlayFailure(c, error, () => deps.netdisk!.resyncAfterGone?.(hit.setId))
      }
    }

    let primary: { mode: 'native' | 'hls'; url: string }
    try {
      primary = await resolveCandidate(hit.rightFile)
    } catch (error) {
      return netdiskPlayFailure(c, error, () => deps.netdisk!.resyncAfterGone?.(hit.setId))
    }
    // 一集只有一份可播文件：同集的其余画质是整理的删除候选（只留最高质量那份），不是可切换的
    // 播放候选，所以这里不再有画质列表。
    return c.json({ mode: primary.mode, url: primary.url })
  })

  // 网盘视频转码播放代理。按文件所属网盘 dispatch `netdisk.play` 拿它自家转码好的 H.264+AAC 流
  // （夸克网页播放器有声就靠这个），带该网盘的 cookie+referer 转发字节——浏览器跨源直取那条链会
  // 412（要网盘 cookie）。转码是网盘做的、后端零 CPU 只搬字节。无登录态/无转码 → 302 回落原始
  // 直链（有画无声、不比现状差）。转发 Range 支持拖动。resolve 路由已把网盘视频指到这里。
  //
  // 转码流是 HLS（m3u8+分片）——浏览器原生 <video> 放不了 m3u8，前端用 hls.js；而 m3u8 里的分片
  // 是相对 m3u8 自身 URL 的夸克 OSS 直链，浏览器跨源取会被 CORS/referer 挡，所以分片也经本路由的
  // `?seg=<绝对URL>&backend=<b>` 分支代理（同源、带 cookie+referer）。playlist 里的分片 URI 在下面
  // rewriteHlsPlaylist 里被改写成这个 seg 地址。
  app.get('/api/media/netdisk-play', async (c) => {
    // 分片代理：hls.js 取被改写过的 .ts / init 段（也兜住 master→media 的嵌套 playlist）。
    const seg = c.req.query('seg')
    if (seg) {
      const segBackend = c.req.query('backend') ?? ''
      const segServing = NETDISK_PLAY_SERVING[segBackend]
      if (!segServing) return c.json({ error: 'unsupported seg backend' }, 400)
      const segCookie = (await deps.credentialProvider?.cookieString(segServing.cookieDomain)) ?? undefined
      const segRange = c.req.header('range')
      let segUp: Response
      try {
        segUp = await fetch(seg, {
          headers: { ...segServing.headers, ...(segCookie ? { cookie: segCookie } : {}), ...(segRange ? { range: segRange } : {}) },
          signal: AbortSignal.timeout(20000),
        })
      } catch {
        return c.json({ error: 'segment fetch failed' }, 502)
      }
      const segCtype = segUp.headers.get('content-type') ?? ''
      if (/mpegurl/i.test(segCtype) || /\.m3u8(?:$|\?)/i.test(seg)) {
        const nested = rewriteHlsPlaylist(await segUp.text(), seg, segBackend)
        return new Response(nested, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' } })
      }
      const segHeaders = new Headers()
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const v = segUp.headers.get(h)
        if (v) segHeaders.set(h, v)
      }
      segHeaders.set('cache-control', 'no-store')
      return new Response(segUp.body, { status: segUp.status, headers: segHeaders })
    }
    const path = c.req.query('path')
    const backend = path ? netdiskBackendOf(path) : null
    if (!path || !backend || !deps.netdisk || !deps.netdiskPlay) return c.json({ error: 'path + supported netdisk required' }, 400)
    const rawFallback = async (cause?: unknown) => {
      try {
        return c.redirect(await deps.netdisk!.rawGatewayUrl(path), 302)
      } catch (e) {
        // 原始直链也求不出 → 用它或触发回落的那个错误分类：文件已被删（object not found）→ 404 精准，
        // 否则 502 可重试。转码解析（fileId/stream）抛的 `cause` 优先——它离「文件没了」更近。
        // 这条路只握着文件 path，靠 bindingForPath 反查出绑定来触发自愈。
        return netdiskPlayFailure(c, cause ?? e, () => {
          const set = deps.netdisk!.bindingForPath?.(path)
          if (set) deps.netdisk!.resyncAfterGone?.(set.id)
        })
      }
    }
    let stream
    try {
      const fid = await deps.netdisk.fileId(path)
      stream = await deps.netdiskPlay.stream(backend, fid)
    } catch (e) {
      return rawFallback(e) // fileId 抛 object not found = 文件已删 → 交给分类给 404 精准提示
    }
    if (!stream) return rawFallback()
    const serving = NETDISK_PLAY_SERVING[backend]
    const cookie = (await deps.credentialProvider?.cookieString(serving.cookieDomain)) ?? undefined
    const range = c.req.header('range')
    let upstream: Response
    try {
      upstream = await fetch(stream.url, {
        headers: { ...serving.headers, ...(cookie ? { cookie } : {}), ...(range ? { range } : {}) },
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      return rawFallback() // CDN 断连/DNS 抖/超时 → 别 500,回落原始直链
    }
    if (!upstream.ok) {
      // 解析出了流,但上游拒了字节(412 缺 cookie/referer、403、短链 404…)——resolve 之后 cookie 失效
      // 是典型触发。把坏流塞给播放器不如回落原始直链;200/206 放行,回落前 cancel body 防连接泄漏。
      // 夸克转码档**全家 412** 有专属真因:__puus 过期(CDN 鉴权比 drive-pc API 严),开一次
      // pan.quark.cn 刷新即自愈——见 shared/netdisk/quark/play.ts 头注,别去侦察防盗链参数。
      upstream.body?.cancel().catch(() => {})
      return rawFallback()
    }
    const upCtype = upstream.headers.get('content-type') ?? ''
    // 转码流是 HLS：把 playlist 里的相对分片改写成同源 seg 代理地址（否则 hls.js 会拿相对路径去解析
    // 到 /api/media/ 下 → 404，且直取夸克 OSS 分片会被 CORS 挡）。非 m3u8（罕见：直给渐进 mp4）原样透传。
    if (/mpegurl/i.test(upCtype) || /\.m3u8(?:$|\?)/i.test(stream.url)) {
      const rewritten = rewriteHlsPlaylist(await upstream.text(), stream.url, backend)
      return new Response(rewritten, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' } })
    }
    const headers = new Headers()
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    headers.set('cache-control', 'no-store')
    return new Response(upstream.body, { status: upstream.status, headers })
  })

  // On-demand audio resolution: a feed song (no playable file) → a playable URL via the
  // provider chain (official platform path first, fallbacks after). The <audio> element
  // hits this and is redirected to the resolved stream. Audio URLs expire, hence per-play.
  // Archive-first: if the track is already downloaded locally, redirect to the local file.
  app.get('/api/media/tracks/resolve', async (c) => {
    const platform = c.req.query('platform')
    if (!platform) return c.json({ error: 'platform required' }, 400)
    const id = c.req.query('id')
    // 四档判路住在 src/audio/track-source.ts —— 转写取字节走的是同一个函数。这里只做
    // 「HTTP 那一半」：把答案翻成 302 / 代理 / 404，再记同一条 debug entry。
    let resolved
    try {
      resolved = await resolveTrackSource(platform, id, { quality: c.req.query('quality'), fallbackUrl: c.req.query('fallback') }, {
        audioArchive: deps.audioArchive,
        netdisk: deps.netdisk,
        providers: deps.providers,
        // 这是个**按平台 dispatch** 的调用点：从绑定的候选里挑一条 serves 得上当前 platform 的行。
        // `fallback:false` = 不许兜底行顶上——不守这道门就会拿「音乐取流」那条梯子去跑播客，
        // 整条跑完全 declined 才回落，每次白烧 ~6.8s。
        //
        // **频道槽位同样过 serves 这一关**（和 video.resolve 一样，见 bindings.ts 的 dispatch）：
        // 槽里钉的那条行不 serves 当前平台键 → 回 null，这里落回裸 platform 键那一档
        // （`{ category:'resolve', key: platform }`）。这是要的语义，不是漏了一道门：一个频道
        // 为某个平台钉的行，不该把另一个平台的歌也劫走。槽里的行全删/全 parked 才抛
        // SlotBrokenError（→ 422）——那是「显式意图废了」，和「这条行不管这个平台」是两回事。
        providerFor: (p) => deps.providerBindings?.dispatch('music.track.resolve', p, slotCtx(c), { fallback: false }) ?? null,
      })
    } catch (e) {
      if (e instanceof SlotBrokenError) return slotBroken422(c, e)
      throw e
    }
    if (resolved.debug) recordDebug(buildAudioResolveEntry(resolved.debug))
    const src = resolved.source
    switch (src.kind) {
      case 'archive':
        return c.redirect(`/api/media/assets/${src.assetId}/file`, 302)
      case 'netdisk':
        return c.redirect(src.url, 302)
      case 'stream': {
        // 合成型 resolver 带 url + Referer headers → 代理（Range 原样透传）。目录项的
        // enclosure_url 是签名 CDN 链，热链没问题 → 302。
        if (!src.headers) return c.redirect(src.url, 302)
        const upstream = await fetch(src.url, {
          headers: { ...src.headers, ...(c.req.header('Range') ? { Range: c.req.header('Range')! } : {}) },
        })
        const h = new Headers(upstream.headers)
        h.set('Accept-Ranges', h.get('Accept-Ranges') ?? 'bytes')
        return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: h })
      }
      case 'fallback': {
        // 送法查服务策略表（src/media/serving.ts）：表外一律保持 302 直发（既有行为）；表内改走
        // 后端代理。代理**不是为了加速**——播放路径上的懒加载浏览器早就在做（实测 84MB 的 mp3
        // 只预缓冲前 278 秒就 defer、跳到第 70 分钟只取那附近 210 秒）。是为了**看得见**：302 一
        // 发出去 Stream 就退出字节路径,上游的 403 到了 <audio> 只剩一个裸的 SRC_NOT_SUPPORTED,
        // 播放器静默转圈,用户读成「加载好久」。见 spec 2026-08-04-audio-fallback-serving-policy。
        const policy = servingPolicyFor(src.url)
        if (!policy) return c.redirect(src.url, 302)
        return serveWithPolicy(src.url, policy, c.req.header('Range'))
      }
      case 'unavailable':
        return c.json(errorBody('unavailable', src.detail), 503)
      case 'unresolved':
        return c.json({ error: 'unresolved', detail: src.detail }, 404)
    }
  })

  // Generic debug box reconciliation: recent debug entries across flows (audio/download/video),
  // optionally filtered by channel/key. Live updates arrive over the WS ({type:'debug'}); this is
  // for a box opened mid-flow. Debug-only.
  app.get('/api/debug/log', (c) => {
    const channel = c.req.query('channel') || undefined
    const key = c.req.query('key') || undefined
    const limit = Number(c.req.query('limit')) || undefined
    return c.json({ entries: deps.debug?.recent({ channel, key, limit }) ?? [] })
  })

  // clear the debug ring (the box's 清空 button)
  app.delete('/api/debug/log', (c) => {
    deps.debug?.clear()
    return c.body(null, 204)
  })

  // serve an archived local file with HTTP Range support
  app.get('/api/media/assets/:assetId/file', (c) => {
    if (!deps.audioArchive) return c.json({ error: 'unavailable' }, 503)
    const a = deps.audioArchive.assetById(Number(c.req.param('assetId')))
    if (!a || !existsSync(a.absPath)) return c.body(null, 404)
    const stat = statSync(a.absPath)
    const range = c.req.header('range')
    const ct = a.format === 'flac' ? 'audio/flac' : a.format === 'm4a' ? 'audio/mp4' : `audio/${a.format}`
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      const start = m && m[1] ? Number(m[1]) : 0
      let end = m && m[2] ? Number(m[2]) : stat.size - 1
      end = Math.min(end, stat.size - 1)
      if (start > end || start >= stat.size) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${stat.size}` },
        })
      }
      const rs = Readable.toWeb(createReadStream(a.absPath, { start, end })) as ReadableStream
      return new Response(rs, {
        status: 206,
        headers: { 'Content-Type': ct, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': String(end - start + 1) },
      })
    }
    const rs = Readable.toWeb(createReadStream(a.absPath)) as ReadableStream
    return new Response(rs, { status: 200, headers: { 'Content-Type': ct, 'Accept-Ranges': 'bytes', 'Content-Length': String(stat.size) } })
  })

  app.post('/api/downloads', async (c) => {
    if (!deps.downloadQueue) return c.json(errorBody('unavailable', 'Download queue is not available'), 503)
    const body = (await c.req.json().catch(() => ({}))) as {
      itemId?: string
      stream?: string
      /** `album` 必须收：下载 provider 只解析播放地址，专辑名唯一的来源就是调用方手里这一份
       *  （搜索/歌单侧解析出来的）。丢在这儿，写进文件的 ID3 里专辑就永远是空的。 */
      track?: { platform?: string; trackId?: string; track_id?: string; title?: string; artist?: string; album?: string; pageUrl?: string }
      /** 已经下载好的就别再排。批量入队(下载整单 / 多选下载)一律要带,否则一份大半已归档的
       *  「我喜欢的」会被整份重下——队列的 single-flight 只对"排队中/在跑"去重,对**已下载完**
       *  的没有判断。默认关着,因为行内菜单的「重新下载」是用户的明确意图,不能被一刀切掉。 */
      skipArchived?: boolean
      /** 行内菜单的「重新下载」：已归档的也要**真的重下一遍**并重写标签，不许被归档层那道
       *  "文件在盘且质量不更差就跳过"的闸静默变成空操作。与 `skipArchived` 天然互斥
       *  （一个是"已下的别再下"、一个是"就是要再下一遍"），同时给就以 force 为准。 */
      force?: boolean
    }
    const gate = strictBody(c, body, DOWNLOAD_ENQUEUE_KEYS)
    if (gate) return gate
    const queue = deps.downloadQueue
    const force = body.force === true
    const skipArchived = !force && body.skipArchived === true
    let enqueued = 0
    let skipped = 0
    /** 跳过必须反映在返回的计数里——调用方拿 enqueued 报给用户,把"跳过"混进"已入队"就是撒谎。 */
    const admit = (ref: TrackRef, priority: number): void => {
      if (skipArchived && queue.isArchived(ref)) { skipped++; return }
      queue.enqueue(ref, { priority, force })
      enqueued++
    }
    if (body.itemId) {
      const item = deps.itemStore.get(body.itemId)
      if (!item) return c.json(errorBody('not_found', 'Item not found'), 404)
      const ref = extractTrackRef(item as unknown as Item)
      if (!ref) return c.json(errorBody('validation_error', 'Item has no track reference'), 400)
      admit(ref, 10) // manual > auto
    } else if (body.track) {
      const trackId = body.track.trackId ?? body.track.track_id
      if (!body.track.platform || !trackId) return c.json(errorBody('validation_error', 'track.platform and track.trackId required'), 400)
      admit({
        platform: body.track.platform,
        id: trackId,
        title: body.track.title,
        artist: body.track.artist,
        album: body.track.album,
        pageUrl: body.track.pageUrl,
      }, 10)
    } else if (body.stream) {
      for (const it of deps.itemStore.recent({ stream: body.stream, limit: 5000 })) {
        const ref = extractTrackRef(it as unknown as Item)
        if (ref) admit(ref, 5)
      }
    } else {
      return c.json(errorBody('validation_error', 'itemId, stream, or track required'), 400)
    }
    void queue.drain() // fire-and-forget pump
    return c.json({ enqueued, skipped })
  })

  app.get('/api/downloads', (c) => {
    if (!deps.downloadQueue) return c.json(errorBody('unavailable', 'Download queue is not available'), 503)
    const platform = c.req.query('platform')
    return c.json({ items: deps.downloadQueue.jobs({ platform: platform || undefined }) })
  })

  app.get('/api/media/assets', (c) => {
    if (!deps.audioArchive) return c.json({ error: 'unavailable' }, 503)
    const raw = c.req.query('refs')
    if (!raw) return c.json(errorBody('validation_error', 'refs required'), 400)
    const parsed = raw.split(',').map((part) => {
      const i = part.indexOf(':')
      if (i <= 0 || i === part.length - 1) return null
      const platform = part.slice(0, i)
      const id = part.slice(i + 1)
      return platform && id ? { platform, id } : null
    })
    if (parsed.some((ref) => !ref)) return c.json(errorBody('validation_error', 'refs must be platform:trackId pairs'), 400)
    const refs = parsed as { platform: string; id: string }[]
    return c.json({ archived: deps.audioArchive.status(refs) })
  })

  app.delete('/api/media/assets/:platform/:trackId', (c) => {
    if (!deps.audioArchive) return c.json({ error: 'unavailable' }, 503)
    deps.audioArchive.delete({ platform: c.req.param('platform'), id: c.req.param('trackId') }, { unlinkFile: true })
    return c.json({ ok: true })
  })

  // Source catalog. Plain = curated list; with ?q= = ranked candidate search over the
  // manifest catalog (the old GET /api/search?intent= — a catalog query, not content search).
  app.get('/api/sources', (c) => {
    const q = (c.req.query('q') ?? '').trim()
    if (!q) return c.json(deps.service.sources())
    const kRaw = c.req.query('k')
    const searchable = c.req.query('searchable') === '1' || c.req.query('searchable') === 'true'
    const catRaw = c.req.query('category')
    const category = catRaw ? catRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined
    return c.json(deps.service.search(q, kRaw ? Number(kRaw) : undefined, { searchable, category }))
  })
  // 「这个源坏了会连累谁」——沿 `uses` 声明的反向闭包（`src/registry/affected-sources.ts`）。
  // 一份被共用的 recipe（xhs 的 detail）漂了，用它的那几个源各自的健康状态仍是绿的，这里是唯一
  // 能把它们点出来的地方。
  //
  // **id 走查询串、不走路径段**：全名是 `<npm 包名>/<局部名>`，里面本来就带 `/`（还可能带 `@`），
  // 塞进路径段就得在两端各来一次转义，而少转一次的表现是 404——一个看起来像「这个源不存在」的错。
  // `id` 吃任何存量形状（全名 / `xhs:xhs-home` / 裸名），归一由 Registry 的四级解析做。
  app.get('/api/sources/affected', (c) => {
    const registry = deps.resolve?.registry
    if (!registry) return c.json(errorBody('unavailable', 'source registry not configured'), 503)
    const id = (c.req.query('id') ?? '').trim()
    if (!id) return c.json(errorBody('validation_error', 'id required'), 400)
    let result
    try {
      result = registry.affectedSources(id)
    } catch (e) {
      // 裸名歧义：`AmbiguousSourceIdError` 的消息里列着全部候选全名，原样交给用户——
      // 压成 404 就是把"它存在两份、请写全名"讲成"它不存在"。
      return c.json(errorBody('validation_error', (e as Error).message), 400)
    }
    const start = registry.get(result.id)
    if (!start) return c.json(errorBody('not_found', `unknown source: ${id}`), 404)
    const row = (sid: string) => {
      const m = registry.get(sid)
      return { id: sid, title: m?.title ?? m?.description, facility: m?.facility?.key }
    }
    return c.json({
      id: result.id,
      affected: result.affected.map(row),
      // 解析不到的 `uses` 边照实报出来：它完全可能就指着本次查询的这个源（第三方包没装/id 打错），
      // 也就是说答案里有个洞。吞掉它等于把"这条没验到"讲成"验过了"。
      unresolved: result.unresolved,
    })
  })
  app.get('/api/status', async (c) => {
    const h = await deps.health()
    return c.json({
      ok: true,
      cookies: h.cookies,
      manifests: h.manifests,
      streams: deps.service.status(),
    })
  })
  app.get('/api/topics', (c) => c.json(deps.service.topics()))

  // 「装了什么」的统一目录：内置 + 用户两层的**全部** Stream 包，各自填了哪几格槽位。
  // 不是 /api/plugins 的替代品——那条是插件目录 + 它带的 Source（被 fillsPluginSlot 过滤，
  // 纯 recipe 包不在），这条是"这台机器上装了什么"，不带 Source 清单、不带装卸操作。
  // 权威契约：docs/API.md「Packages（装了什么）」。
  // 运行时状态复用**已经在跑的那套** pluginStatus（bootstrap 侧带 stale-while-revalidate
  // 缓存，standby 管的服务根本不做 HTTP 探活）——绝不在这里新起一套探活：多一套 = 多一份
  // 会和 /api/plugins 说法不一致的真相。
  app.get('/api/packages', async (c) => {
    if (!deps.packageInventory) return c.json(errorBody('unavailable', 'package inventory not configured'), 503)
    const statusRows = deps.pluginStatus ? await deps.pluginStatus() : []
    // 能力包给了哪些工具**只有活着的宿主知道**（包目录里没有这个答案），所以在这里补一步。
    // 用户看的是这一页：可选能力包住 `<dataDir>/recipes/`，`/api/plugins` 那条根本列不到它们。
    const withTools = mergeCapabilityTools(deps.packageInventory(), deps.capabilityTools?.() ?? {})
    // 待生效项按 npm 名（`pkgName`）挂到对应那一行：目录说"装了什么"，这一格说"装了但还没生效"。
    // 没有 pkgName 的行（内置层）永远挂不上——待生效清单只算用户层。
    const pending = deps.packagePending?.() ?? []
    const byName = new Map(pending.map((p) => [p.name, p]))
    const merged = mergePackageRuntime(withTools, statusRows as PluginStatus[])
      .map((p) => (p.pkgName && byName.has(p.pkgName) ? { ...p, pending: byName.get(p.pkgName)! } : p))
    return c.json({ packages: merged })
  })

  // 整份待生效清单（含 removed 那些——目录里已经没有它们的行，只有这里能看到）。
  app.get('/api/packages/pending', (c) => {
    if (!deps.packagePending) return c.json(errorBody('unavailable', 'package inventory not configured'), 503)
    return c.json({ pending: deps.packagePending() })
  })

  // 一个容器起不来时，用户只有两个自助动作：看它为什么、再试一次。两条都在这里。
  // 失败分三种、映射成三个不同的状态码——合成一个 500 等于把人支去查错的地方。
  // 映射到 docs/API.md 的固定 code 集（不为这两个端点私自扩充 ErrorCode——调用方按 code 分支，
  // 多一个只此一处认识的码等于让通用错误处理漏掉它）。**具体是哪一种由 message 说**。
  const CONTAINER_OPS_FAIL = {
    no_container: { status: 404, code: 'not_found', message: '这个包没有容器，或者它的容器从没建起来' },
    unavailable: { status: 503, code: 'unavailable', message: '够不着 Docker：没装 / daemon 没跑 / socket 够不着' },
    not_managed: { status: 409, code: 'conflict', message: '容器不存在，而宿主没被授权替你建' },
  } as const satisfies Record<string, { status: number; code: ErrorCode; message: string }>

  app.get('/api/packages/:id/logs', async (c) => {
    if (!deps.containerOps) return c.json(errorBody('unavailable', 'container ops not configured'), 503)
    // 夹在 [1,1000]：无上限的 tail 会让一个刷屏的容器把几十 MB 灌进一次 HTTP 响应。
    // 解析不出数字回落 200，而不是 0——`tail=0` 在 docker 那边是"一行都不要"，
    // 表现是日志面板空着，看起来像"这个容器没有日志"。
    const raw = Number(c.req.query('tail'))
    const tail = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), 1000) : 200
    const r = await deps.containerOps.logs(c.req.param('id'), tail)
    if (!r.ok) {
      const f = CONTAINER_OPS_FAIL[r.code]
      return c.json(errorBody(f.code, r.message ?? f.message), f.status)
    }
    return c.json(r.value)
  })

  app.post('/api/packages/:id/restart', async (c) => {
    if (!deps.containerOps) return c.json(errorBody('unavailable', 'container ops not configured'), 503)
    const r = await deps.containerOps.restart(c.req.param('id'))
    if (!r.ok) {
      const f = CONTAINER_OPS_FAIL[r.code]
      return c.json(errorBody(f.code, r.message ?? f.message), f.status)
    }
    // 容器起不来是 200 + `state:'error'`，不是 5xx：请求本身成功了（我们确实试过了），
    // 失败的是那个容器。用 5xx 表达它会让前端分不清"没连上后端"和"容器没起来"。
    return c.json(r.value)
  })

  /** 重启后端：优雅关 → 按「谁拉起我」活回来（policy.ts）。**不是热重载**。
   *  闸门：有正在跑的任务就 409——8900 上跑着真金白银的定时任务，包更新不是打断它的理由。 */
  app.post('/api/restart', async (c) => {
    if (!deps.restart) return c.json(errorBody('unavailable', 'restart not configured'), 503)
    const force = c.req.query('force') === '1'
    const running = await deps.restart.running()
    if (running.length && !force) {
      return c.json({ ...errorBody('conflict', `有任务正在跑：${running.map((r) => r.label).join('、')}；等它跑完，或 ?force=1`), running }, 409)
    }
    // 先回 202 再关：trigger 的实现只交出 mode、把关停排到下一拍——同步开始关会把 HTTP server
    // 一起带走，这个 202 就永远发不出去。
    const mode = await deps.restart.trigger()
    return c.json({ mode }, 202)
  })

  // Plugin catalog: capability packages + operational status. Source ownership is
  // server-provided; the frontend must not infer plugins from source ids.
  app.get('/api/plugins', async (c) => {
    const plugins = deps.service.plugins()
    const statusRows = deps.pluginStatus ? await deps.pluginStatus() : []
    // **这里没有 `tools`**：`service.plugins()` 只有内置插件包，而能力包住 `<dataDir>/recipes/`
    // ——这一格在这条路上恒为空数组，是死数据。工具那一列只有 `/api/packages` 一处。
    return c.json(mergePluginStatus(plugins, statusRows))
  })
  // Enable/disable a plugin. Persisted; the catalog flips immediately, but a disable fully lands
  // (sources unregistered) on the next restart — see setPluginEnabled. Required plugins → 400.
  app.put('/api/plugins/:pluginId/enabled', async (c) => {
    if (!deps.setPluginEnabled) return c.json({ error: 'unavailable' }, 503)
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown }
    const gate = strictBody(c, body, PLUGIN_ENABLED_KEYS)
    if (gate) return gate
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) required' }, 400)
    try {
      return c.json(deps.setPluginEnabled(c.req.param('pluginId'), body.enabled))
    } catch (e) {
      // unknown → 404; required (locked on) → 409 conflict
      const msg = (e as Error).message
      return c.json({ error: msg }, /required/.test(msg) ? 409 : 404)
    }
  })
  // Cross-plugin source-catalog search (faceted, grouped by plugin). Registered before
  // the /:pluginId/sources route; the two never collide (2 path segments vs 3).
  app.get('/api/plugins/sources', (c) => {
    const limit = c.req.query('limit')
    const surface = c.req.query('surface')
    if (surface !== undefined && !isPickSurface(surface)) return badSurface(c, surface)
    return c.json(deps.service.searchAllPluginSources({
      query: c.req.query('query') ?? undefined,
      category: c.req.query('category') ?? undefined,
      capability: c.req.query('capability') ?? undefined,
      searchable: c.req.query('searchable') === '1' || c.req.query('searchable') === 'true',
      cursor: c.req.query('cursor') ?? undefined,
      limit: limit ? Number(limit) : undefined,
      surface,
    }))
  })
  app.get('/api/plugins/:pluginId/sources', (c) => {
    const limit = c.req.query('limit')
    const surface = c.req.query('surface')
    if (surface !== undefined && !isPickSurface(surface)) return badSurface(c, surface)
    return c.json(deps.service.pluginSources(c.req.param('pluginId'), {
      query: c.req.query('query') ?? undefined,
      category: c.req.query('category') ?? undefined,
      group: c.req.query('group') ?? c.req.query('facility') ?? undefined,
      cursor: c.req.query('cursor') ?? undefined,
      limit: limit ? Number(limit) : undefined,
      surface,
    }))
  })
  app.get('/api/plugins/:pluginId/sources/:sourceId{.+}', (c) => {
    const detail = deps.service.pluginSourceDetail(c.req.param('pluginId'), decodeURIComponent(c.req.param('sourceId')))
    if (!detail) return c.json({ error: 'not_found' }, 404)
    return c.json(detail)
  })

  /**
   * 一格配置的完整回执 = 存储那一侧（配置 row 引擎的 status）**加上**「谁能替我填它」。
   *
   * 把 provisioner 挂进这张既有回执、而不是另开一个只读端点：Sheet 本来就为每一格打这一发，
   * 反查的答案跟着回来是零成本；单开一条只会让同一张卡打两次、还要自己处理两份先后到达的态。
   * 三个出口（status / 存完 / 申请完）走同一个函数——回执形状只有一份，加字段漏不掉哪一处。
   */
  const runtimeConfigStatus = (ref: string) => ({
    ...(deps.sourceRuntimeConfig!.status(ref) as { secrets?: Record<string, { configured: boolean }> }),
    provisioner: deps.sourceRuntimeConfig!.provisioner?.(ref) ?? null,
    envFallback: deps.sourceRuntimeConfig!.envCovered?.(ref) ?? [],
  })

  app.post('/api/source-runtime-config/status', async (c) => {
    if (!deps.sourceRuntimeConfig) return c.json({ error: 'unavailable' }, 503)
    const body = (await c.req.json().catch(() => ({}))) as { pluginId?: string; sourceId?: string; ref?: string }
    const gate = strictBody(c, body, SOURCE_RUNTIME_STATUS_KEYS)
    if (gate) return gate
    if (!body.pluginId || !body.sourceId) return c.json({ error: 'pluginId and sourceId required' }, 400)
    const source = deps.service.pluginSourceDetail(body.pluginId, body.sourceId)
    if (!source?.runtimeConfig) return c.json({ error: 'not_configurable' }, 404)
    const resolved = effectiveConfigRef(source.runtimeConfig, body.ref)
    if ('error' in resolved) return c.json({ error: resolved.error }, 400)
    return c.json(runtimeConfigStatus(resolved.ref))
  })
  /**
   * **一键帮我把这一格填上**：跑那条声明了自己产出这格配置的 recipe（`configProvisionerFor`）。
   *
   * 为什么不是让前端拿着 `provisioner.sourceId` 去打 `POST /api/sources/preview`（那条今天就
   * 跑得通）——两条硬理由：
   *
   *  1. **preview 分不出成功和白跑。** 这类 recipe `allowEmpty: true`、不产 item，成功与
   *     「抽取一处都没命中」在它的回执里一字不差都是 `items: []`。按钮照那个报成功，用户
   *     会拿着一格空 key 去查别处。这里的判据换成**唯一诚实的那个**：跑完回头问一次
   *     `secrets[field].configured`。
   *  2. **该跑哪条 recipe 不该由前端决定。** 客户端只说"把这张卡这一格填上"，反查留在后端，
   *     前端拿不到一个可以换成别的 sourceId 的口子。
   */
  app.post('/api/source-runtime-config/provision', async (c) => {
    if (!deps.sourceRuntimeConfig) return c.json({ error: 'unavailable' }, 503)
    const body = (await c.req.json().catch(() => ({}))) as { pluginId?: string; sourceId?: string; ref?: string; params?: Record<string, unknown> }
    const gate = strictBody(c, body, SOURCE_RUNTIME_PROVISION_KEYS)
    if (gate) return gate
    if (!body.pluginId || !body.sourceId) return c.json({ error: 'pluginId and sourceId required' }, 400)
    const source = deps.service.pluginSourceDetail(body.pluginId, body.sourceId)
    if (!source?.runtimeConfig) return c.json({ error: 'not_configurable' }, 404)
    const resolved = effectiveConfigRef(source.runtimeConfig, body.ref)
    if ('error' in resolved) return c.json({ error: resolved.error }, 400)
    const run = deps.sourceRuntimeConfig.provision
    if (!deps.sourceRuntimeConfig.provisioner?.(resolved.ref) || !run) return c.json({ error: 'no_provisioner' }, 404)
    // 跑 + **回头核对那一格填上了没**只有一份实现（`credentials/provision-slot.ts`）——模型手上
    // 那个 `provision_capability_key` 走的是同一个函数。两边各写一遍的漂移是静音的：一边核对、
    // 另一边报假成功。
    const outcome = await provisionConfigSlot(
      {
        provisioner: (ref) => deps.sourceRuntimeConfig!.provisioner!(ref),
        run: (ref, params) => run(ref, params),
        statusOf: runtimeConfigStatus,
      },
      resolved.ref,
      (body.params ?? {}) as Record<string, unknown>,
      errText,
    )
    if (outcome.status === 'no-provisioner') return c.json({ error: 'no_provisioner' }, 404)
    if (outcome.status !== 'done') return c.json({ error: outcome.error }, 502)
    return c.json(outcome.receipt)
  })
  app.put('/api/source-runtime-config', async (c) => {
    if (!deps.sourceRuntimeConfig) return c.json({ error: 'unavailable' }, 503)
    const body = (await c.req.json().catch(() => ({}))) as { pluginId?: string; sourceId?: string; ref?: string; values?: Record<string, unknown> }
    const gate = strictBody(c, body, SOURCE_RUNTIME_SET_KEYS)
    if (gate) return gate
    if (!body.pluginId || !body.sourceId || !body.values || typeof body.values !== 'object') return c.json({ error: 'pluginId, sourceId and values required' }, 400)
    const source = deps.service.pluginSourceDetail(body.pluginId, body.sourceId)
    if (!source?.runtimeConfig) return c.json({ error: 'not_configurable' }, 404)
    const resolved = effectiveConfigRef(source.runtimeConfig, body.ref)
    if ('error' in resolved) return c.json({ error: resolved.error }, 400)
    const fields = source.runtimeConfig.fields
    if (Object.keys(body.values).some((key) => !(key in fields))) return c.json({ error: 'unknown runtime config field' }, 400)
    try {
      await deps.sourceRuntimeConfig.set(resolved.ref, body.values)
    } catch (e) {
      return c.json({ error: errText(e) }, 400)
    }
    return c.json(runtimeConfigStatus(resolved.ref))
  })
  // 采集浏览器的选择面（spec 2026-07-29 §4）。三个入口（mcp / app / web）**同一个字段、
  // 三种面**：这里是 web/app 那两张，mcp 那张是 config.yaml 的 `harvest_browser.exe`。
  // GET 列候选 + 当前选择 + mustChoose；PUT 存用户的选择。
  // 后端**绝不自动挑一个**：WSL 和 Windows 都装了 Chrome 是合法状态，替用户挑错的症状是
  // "一切正常运行、只是采集全程游客态"——最难查的一类。
  app.get('/api/settings/harvest-browser', async (c) => {
    if (!deps.harvestBrowser) return c.json({ error: 'unavailable' }, 503)
    return c.json(await deps.harvestBrowser.status())
  })
  app.put('/api/settings/harvest-browser', async (c) => {
    if (!deps.harvestBrowser) return c.json({ error: 'unavailable' }, 503)
    const body = (await c.req.json().catch(() => ({}))) as { exe?: string }
    const gate = strictBody(c, body, HARVEST_BROWSER_KEYS)
    if (gate) return gate
    if (!body.exe) return c.json({ error: 'exe required' }, 400)
    try {
      return c.json(await deps.harvestBrowser.select(body.exe))
    } catch (e) {
      // 路径不存在也走这里：与其静默存下一个错路径，不如当场说不行（见 select 的注释）。
      return c.json({ error: errText(e) }, 400)
    }
  })

  // 扩展该读哪些域的 cookie。**这个接口绝不发放任何密钥**——它只回答"要哪些域"。
  // 它曾经在另一种形状下吐过整个 cookie 库的解密密钥明文，而当时既没有门、又挂着 CORS `*`。
  // 门已经补上（access-guard.ts），但真正让那个洞消失的是**这里没有密钥可吐**：别往回加。
  app.get('/api/ext/sync-config', (c) => {
    const cfg = deps.extSyncConfig?.()
    return c.json(cfg ? { configured: true, ...cfg } : { configured: false })
  })

  // 摘要 prompt——settings 里唯一还归 LLM 的字段（连接/模型在 Providers 页配）。
  // GET 同时回 configured：`llm` 梯子上有没有一个端点齐全的成员。
  app.get('/api/settings/summary-prompt', (c) => {
    if (!deps.summaryPrompt) return c.json({ error: 'unavailable' }, 503)
    return c.json(deps.summaryPrompt.status())
  })
  app.put('/api/settings/summary-prompt', async (c) => {
    if (!deps.summaryPrompt) return c.json({ error: 'unavailable' }, 503)
    const body = (await c.req.json().catch(() => ({}))) as { prompt?: unknown }
    const gate = strictBody(c, body, SUMMARY_PROMPT_KEYS)
    if (gate) return gate
    if (typeof body.prompt !== 'string') return c.json({ error: 'prompt (string) required' }, 400)
    // 写路径经配置 row 引擎（rows.put）；schema/校验失败会抛，让它走统一 500 兜底之前先兜成 400。
    try {
      return c.json(await deps.summaryPrompt.set(body.prompt))
    } catch (e) {
      return c.json({ error: errText(e) }, 400)
    }
  })
  app.get('/api/settings/video-sources', (c) => {
    if (!deps.videoSources) return c.json({ error: 'unavailable' }, 503)
    return c.json(deps.videoSources.status())
  })
  app.put('/api/settings/video-sources', async (c) => {
    if (!deps.videoSources) return c.json({ error: 'unavailable' }, 503)
    const body = (await c.req.json().catch(() => ({}))) as import('../settings-store.ts').VideoSourceSettings
    const gate = strictBody(c, body, VIDEO_SOURCES_KEYS)
    if (gate) return gate
    if (body.language !== undefined && typeof body.language !== 'string') return c.json({ error: 'language must be a string' }, 400)
    try {
      return c.json(await deps.videoSources.set({ tmdbApiKey: body.tmdbApiKey, omdbApiKey: body.omdbApiKey, language: body.language }))
    } catch (e) {
      return c.json({ error: errText(e) }, 400)
    }
  })
  // Audio archive config/status (read-only) for the settings Sheet — the download落盘 root
  // (config.yaml audio_archive_root), whether it exists + is writable, and the track count.
  app.get('/api/settings/archive', (c) => {
    if (!deps.audioArchive) return c.json({ error: 'unavailable' }, 503)
    const { root, tracks } = deps.audioArchive.info()
    let writable = false
    try {
      accessSync(root, fsConstants.W_OK)
      writable = true
    } catch {
      /* not writable / missing */
    }
    return c.json({ root, exists: existsSync(root), writable, tracks })
  })
  // 全库对账：用真实字节重认每个已归档文件的格式与质量等级，纠正对不上的。默认只报不改
  // （它要重命名文件）；`{"apply":true}` 才真动。全库扫，不设时间窗——等级算错和什么时候
  // 下载的无关。慢（每条一次 ffprobe），是维护动作不是热路径。
  app.post('/api/settings/archive/reconcile-formats', async (c) => {
    if (!deps.audioArchive) return c.json({ error: 'unavailable' }, 503)
    const body = (await c.req.json().catch(() => ({}))) as { apply?: boolean }
    const gate = strictBody(c, body, ARCHIVE_MAINTENANCE_KEYS)
    if (gate) return gate
    return c.json(await deps.audioArchive.reconcileFormats({ apply: body.apply === true }))
  })
  // 归档目录里的孤儿文件：盘上有、`asset` 表里查无此行（改过命名规则/换格式重下留下的旧副本）。
  // 默认只报不删；`{"apply":true}` 才真删。白名单（点开头的路径段、Thumbs.db 之类）跳过的数量
  // 单独报在 `ignored`——跳了什么必须说出口。
  app.post('/api/settings/archive/orphans', async (c) => {
    if (!deps.audioArchive) return c.json({ error: 'unavailable' }, 503)
    const body = (await c.req.json().catch(() => ({}))) as { apply?: boolean }
    const gate = strictBody(c, body, ARCHIVE_MAINTENANCE_KEYS)
    if (gate) return gate
    return c.json(deps.audioArchive.orphans({ apply: body.apply === true }))
  })
  // 网盘底座（内置托管）：只读状态（token 永不回显）和一条活探测。没有写端点——地址和凭证
  // 都由 Stream 自己维护，没有可配的项。
  app.get('/api/settings/alist', (c) => {
    if (!deps.alist) return c.json({ error: 'unavailable' }, 503)
    return c.json(deps.alist.status())
  })
  // 活探测：对现役那一份打一次已认证的列目录。不收任何字段（以前收的临时 url/token 没有了）。
  app.post('/api/settings/alist/test', async (c) => {
    if (!deps.alist) return c.json({ error: 'unavailable' }, 503)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const gate = strictBody(c, body, ALIST_TEST_KEYS)
    if (gate) return gate
    return c.json(await deps.alist.test())
  })

  // （`/api/transcripts` 与 `/api/parses` 两族端点、以及 `POST /api/transcripts/:id/summary`
  // 这个动词端点，已于 2026-07-25 退场。转换是一种资源：`/api/conversions`，kind 判别。
  // 契约见 docs/API.md「Conversions」；触发/查询/取消全在那一族里。）

  // Voiceprint speaker registry — persons CRUD, per-item cluster listing (aggregated from a
  // diarized transcript's segments), and enroll/correct (bind a cluster to a person, then
  // rewrite that cluster's label in the stored transcript so subsequent renders show the name).
  /**
   * 「这个 item 里谁在什么时候说话」＝声纹库时间线，**没有第二个数据源**。
   * （转写段上的 speaker 是读时现算的投影，见 src/voiceprint/view.ts；存量抄件已由启动迁移
   * 反推进时间线，migrate-segments.ts。）形状对齐成 `{start,end,speaker,text}`——时间线没有
   * 文字，text 补空串，下游 mergePersonSpans 只拿它拼展示文本，块的边界只由时间决定。
   */
  const speakerTimelineOf = (itemId: string): Array<{ start: number; end: number; speaker?: string; text: string }> =>
    (deps.speakerRegistry?.getItemTimeline(itemId) ?? []).map((s) => ({ start: s.start, end: s.end, speaker: s.speaker, text: '' }))

  app.get('/api/voiceprint/persons', (c) => {
    if (!deps.speakerRegistry) return c.json(errorBody('unavailable', 'voiceprint not configured'), 503)
    return c.json({ persons: deps.speakerRegistry.listPersons() })
  })
  app.post('/api/voiceprint/persons', async (c) => {
    if (!deps.speakerRegistry) return c.json(errorBody('unavailable', 'voiceprint not configured'), 503)
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; aliases?: string[] }
    const gate = strictBody(c, body, VOICEPRINT_PERSON_KEYS)
    if (gate) return gate
    if (!body.name) return c.json(errorBody('validation_error', 'name required'), 400)
    return c.json(deps.speakerRegistry.createPerson(body.name, body.aliases), 201)
  })
  // 删人 = 删身份 **+ 撤回他留在时间线上的名字字面量**。enroll 是就地改写（时间线直接写成
  // 人名），只删库里的行会留下「库里查无此人、页面上照样挂着他」的悬空状态，只能手动重跑
  // 认名才刷得掉。撤回逻辑在 revertPersonNaming——只撤字面量与账，不碰 pending、不重跑认名。
  app.delete('/api/voiceprint/persons/:id', (c) => {
    if (!deps.speakerRegistry) return c.json(errorBody('unavailable', 'voiceprint not configured'), 503)
    const id = c.req.param('id')
    revertPersonNaming(deps.speakerRegistry, id)
    deps.speakerRegistry.deletePerson(id)
    return c.body(null, 204)
  })
  // 某人名下的声纹清单（元数据，无向量本体）。
  app.get('/api/voiceprint/persons/:id/voiceprints', (c) => {
    if (!deps.speakerRegistry) return c.json(errorBody('unavailable', 'voiceprint not configured'), 503)
    const id = c.req.param('id')
    if (!deps.speakerRegistry.getPerson(id)) return c.json(errorBody('not_found', 'unknown person'), 404)
    return c.json({ voiceprints: deps.speakerRegistry.listVoiceprints(id) })
  })
  // 单删一条声纹——一次 enroll 进了污染样本时的手术刀（此前只能整人删再全部重登）。
  // 删空**不**级联删 person：没有声纹的人只是自动认名匹配不到他，身份本身仍然合法。
  app.delete('/api/voiceprint/persons/:id/voiceprints/:vpId', (c) => {
    if (!deps.speakerRegistry) return c.json(errorBody('unavailable', 'voiceprint not configured'), 503)
    const id = c.req.param('id')
    if (!deps.speakerRegistry.getPerson(id)) return c.json(errorBody('not_found', 'unknown person'), 404)
    // 不属于该 person 的 vpId 与「压根不存在」同为 404：从调用方视角这条声纹就是不在这个人名下。
    if (!deps.speakerRegistry.deleteVoiceprint(id, c.req.param('vpId'))) {
      return c.json(errorBody('not_found', 'unknown voiceprint'), 404)
    }
    return c.body(null, 204)
  })
  app.get('/api/voiceprint/item/:itemId/clusters', (c) => {
    if (!deps.speakerRegistry) return c.json(errorBody('unavailable', 'voiceprint not configured'), 503)
    const segs = speakerTimelineOf(c.req.param('itemId'))
    const agg = new Map<string, { seconds: number; sampleAt: number }>()
    for (const s of segs) {
      if (!s.speaker) continue
      const cur = agg.get(s.speaker)
      if (cur) cur.seconds += s.end - s.start
      else agg.set(s.speaker, { seconds: s.end - s.start, sampleAt: s.start })
    }
    // 待确认的抽名（演职员表查无此人,问用户一次）按 cluster 贴到对应簇上——主导簇本就有大量
    // 发言时长、必在聚合列表里,前端在这一行渲染「抽到 X 认吗」+ 认/不认。
    const pendingByCluster = new Map(
      deps.speakerRegistry.listPendingNames(c.req.param('itemId')).map((p) => [p.cluster, { name: p.name, evidence: p.evidence }])
    )
    const clusters = [...agg.entries()].map(([cluster, v]) => ({
      cluster,
      seconds: Math.round(v.seconds),
      sampleAt: v.sampleAt,
      personName: /^SPEAKER_\d+$/.test(cluster) ? undefined : cluster,
      pending: pendingByCluster.get(cluster),
    }))
    return c.json({ clusters })
  })
  // (Re)build the item's speaker clusters — a speaker-identification-only pass: resolve the audio
  // (shared audio cache), diarize + name, persist the diarization timeline. STT is NOT re-run —
  // that is the whole point (识别不用重付 whisper). **转写不是前提**：识别只需要音频；有转写时
  // 额外把标签投影回 segments。POST on the clusters collection = create/replace them; async (202)
  // because audio extraction is minutes-scale. Re-POST = re-cluster from scratch.
  app.post('/api/voiceprint/item/:itemId/clusters', (c) => {
    const conversions = deps.conversions
    if (!deps.speakerRegistry || !conversions) {
      return c.json(errorBody('unavailable', 'voiceprint not configured'), 503)
    }
    // engine 不可用 → 503（不是 409）：区分「后端没配」与「这条记录不满足前提」，两种文案不能互串。
    if (!conversions.kinds().some((k) => k.kind === 'identify' && k.available)) {
      return c.json(errorBody('unavailable', 'voiceprint engine not configured'), 503)
    }
    const itemId = c.req.param('itemId')
    // 转写**可有可无**：有就把它当输入（标签投影回 segments），没有就跑纯 diarization。
    // 这里曾经是 404/409 两道门，它们正是前端「识别本集说话人」按钮点了就报错的根因。
    const stt = conversions.transcriptOf(itemId)
    // 该 item 上已有排队/在跑的活儿 → 拒绝（两个 pass 抢同一条转写会互相覆盖 segments）。
    const busy = [stt]
      .concat(conversions.list({ item: itemId, kind: 'identify', limit: 1 }).items)
      .some((r) => r && (r.status === 'queued' || r.status === 'running'))
    if (busy) {
      return c.json(errorBody('conflict', 'a job for this item is already queued or running'), 409)
    }
    // force：识别本就是「再算一遍」，命中缓存直接返回旧记录反而是错的。
    conversions.start('identify', itemId, { inputId: stt?.id, force: true })
    return c.json({ status: 'queued' }, 202)
  })
  app.post('/api/voiceprint/item/:itemId/clusters/:cluster/enroll', async (c) => {
    if (!deps.speakerRegistry || !deps.conversions) return c.json(errorBody('unavailable', 'voiceprint not configured'), 503)
    const itemId = c.req.param('itemId')
    const cluster = c.req.param('cluster')
    const body = (await c.req.json().catch(() => ({}))) as { personId?: string }
    const gate = strictBody(c, body, VOICEPRINT_ENROLL_KEYS)
    if (gate) return gate
    const { personId } = body
    if (!personId) return c.json(errorBody('validation_error', 'personId required'), 400)
    const person = deps.speakerRegistry.getPerson(personId)
    if (!person) return c.json(errorBody('not_found', 'unknown person'), 404)
    const vp = deps.speakerRegistry.enrollFromCluster(itemId, cluster, personId)
    if (!vp) return c.json(errorBody('not_found', 'unknown cluster'), 404)
    // 改名只落时间线——它是说话人数据的唯一存储，转写段上的名字是读时现算的投影（view.ts），
    // 这里改完所有读者自然跟上。
    deps.speakerRegistry.renameInTimeline(itemId, cluster, person.name)
    // 手动 enroll 也是「归名那一刻」：不走 identify，靠这里把该 item 的出现账按改名后的
    // 时间线重算（口径与 identify 一致）。
    deps.speakerRegistry.recomputeItemAppearances(itemId, deps.speakerRegistry.getItemTimeline(itemId))
    // 确认路径:若这个簇挂着一条待确认的抽名(演职员表查无此人),enroll 成功即清掉它——此后同名
    // 走「已有 Person」档 skip,永不再生成新待确认。
    deps.speakerRegistry.deletePendingName(itemId, cluster)
    return c.json({ ok: true })
  })
  // 否决一条待确认的抽名(演职员表查无此人,用户点「不认」):记 rejected,同名同作品再抽到不再入队。
  app.delete('/api/voiceprint/item/:itemId/pending/:cluster', (c) => {
    if (!deps.speakerRegistry) return c.json(errorBody('unavailable', 'voiceprint not configured'), 503)
    deps.speakerRegistry.rejectPendingName(c.req.param('itemId'), c.req.param('cluster'))
    return c.body(null, 204)
  })
  // Player-side timeline: an item's diarization timeline (转写 segments 是没有时间线时的回退，
  // 见 speakerTimelineOf), merged into continuous per-speaker blocks (gap-bridged, >=60s only —
  // "don't mark sub-minute speech") and optionally filtered to one person. Backs ArtPlayer's
  // progress-bar markers + "only this person" playback — the threshold/merge logic lives once
  // here (mergePersonSpans/filterBlocksByDuration), not duplicated in the frontend.
  app.get('/api/voiceprint/item/:itemId/blocks', (c) => {
    if (!deps.conversions && !deps.speakerRegistry) {
      return c.json(errorBody('unavailable', 'transcription not available'), 503)
    }
    const person = c.req.query('person')
    const minRaw = Number(c.req.query('minSeconds'))
    const minSeconds = Number.isFinite(minRaw) && minRaw > 0 ? minRaw : 60
    const segs = speakerTimelineOf(c.req.param('itemId'))
    const blocks = filterBlocksByDuration(mergePersonSpans(segs, { gapSeconds: 15 }), minSeconds)
      .filter((b) => !person || b.speaker === person)
      .map((b) => ({ start: b.start, end: b.end, label: b.speaker }))
    return c.json({ blocks })
  })

  // 跨内容查询「某人出现在哪些内容」：按 person_id 落的出现账（identify 归名时写、不改名漂移）。
  // person 对 persons(name+aliases) 匹配（精确优先，无命中再子串）→ seconds >= minSeconds（默认 30，
  // 滤插话）→ seconds 降序。title/source 从 itemStore 拿到多少给多少。见 appearances ledger spec。
  app.get('/api/voiceprint/appearances', (c) => {
    if (!deps.speakerRegistry) return c.json(errorBody('unavailable', 'voiceprint not configured'), 503)
    const person = c.req.query('person')
    if (!person) return c.json(errorBody('validation_error', 'person required'), 400)
    const minRaw = Number(c.req.query('minSeconds'))
    const minSeconds = Number.isFinite(minRaw) && minRaw >= 0 ? minRaw : 30
    const persons = deps.speakerRegistry.findPersonsByName(person)
    const rows = deps.speakerRegistry.listAppearancesForPersons(persons.map((p) => p.id), minSeconds)
    const appearances = rows.map((r) => {
      const it = deps.itemStore.get(r.itemId)
      return {
        itemId: r.itemId,
        title: it?.title,
        source: it?.stream_id,
        seconds: r.seconds,
        segments: r.segments,
        firstAt: r.firstAt,
        nameAtTime: r.nameAtTime,
      }
    })
    return c.json({ appearances })
  })
  // 存量回填：扫已存转写的 speaker 人名，对 persons 匹配得 person_id，写账——不重跑 diarize（见 spec）。
  app.post('/api/voiceprint/appearances/backfill', (c) => {
    if (!deps.speakerRegistry || !deps.conversions) {
      return c.json(errorBody('unavailable', 'voiceprint not configured'), 503)
    }
    let items = 0
    for (const { itemId, segments } of deps.conversions.allTranscripts()) {
      deps.speakerRegistry.recomputeItemAppearances(itemId, segments)
      items += 1
    }
    return c.json({ ok: true, items })
  })


  // ── 网盘插件 external 档的配置来源（spec 2026-09-05 §5.3）──
  // 用户把 `@streamapp/netdisk` 装进自己的 DSH 时，要复用 Stream 这份 OpenList
  // 就得知道网关路径和永久 token。过去托管层生成 profile 时直接递；现在只能来问。
  // `url` 拼的是**这次请求打进来的 origin** 下的网关路径（不是 standby 给容器发的随机口——
  // 那个口随容器生灭）。走 /api/* 那道门（loopback 免密 + Origin 栅栏），不另设闸。
  app.get('/api/netdisk/openlist-access', async (c) => {
    if (!deps.alist) return c.json(errorBody('unavailable', 'alist 包不在场'), 404)
    const token = await deps.alist.permanentToken()
    if (!token) return c.json(errorBody('unavailable', 'OpenList 的永久 token 还没铸出来（先在包页里完成接管）'), 404)
    const origin = new URL(c.req.url).origin
    return c.json({ url: `${origin}${GATEWAY_PREFIX}/alist`, token })
  })

  // ── 网盘分享：验活 / 转存 ──────────────────────────────────────────────
  // 两个调用点（netdisk.share.verify / netdisk.share.save）的 HTTP 面。挂在这里而不是
  // registerNetdiskRoutes 里：那套被 AList token 门控，而分享能力只要有网盘登录态就能用。
  // 都是 POST：verify 虽是读，但要驱动一个真浏览器打开分享页（数秒、单会话串行），不是可缓存的 GET。

  /** 调用方手里的是 link（搜索结果 / Agent 抽出的链），Provider 要的是 (netdisk, pwd_id)。
   *  接受任一形式：给 link 就在这儿解析（复用 SHARE_ID 那套正则，不另起一套）。 */
  const shareTargetOf = (b: { link?: string; netdisk?: string; pwd_id?: string }) => {
    if (b.netdisk && b.pwd_id) return { netdisk: b.netdisk, pwd_id: b.pwd_id }
    return b.link ? parseShareLink(b.link) : null
  }

  /** 一条分享 → 存活与否 + 里面的文件（文件名是"是不是我要的"的最强信号）。 */
  app.post('/api/netdisk/share/verify', async (c) => {
    if (!deps.netdiskShare) return c.json(errorBody('unavailable', 'netdisk share not configured'), 503)
    const body = (await c.req.json().catch(() => undefined)) as
      | { link?: string; netdisk?: string; pwd_id?: string; passcode?: string }
      | undefined
    const gate = strictBody(c, body, SHARE_VERIFY_KEYS)
    if (gate) return gate
    const target = isObject(body) ? shareTargetOf(body) : null
    if (!target) return c.json(errorBody('validation_error', 'link, or netdisk + pwd_id, required'), 400)
    // 提取码有就带上：百度几乎每条分享都锁着，没有它只能判「链接是否存在」。
    const r = await deps.netdiskShare.verify(target.netdisk, target.pwd_id, { passcode: body?.passcode })
    // null = 这个网盘没有专属 Provider 行。是"不支持"，不是"链接死了"——别让调用方混为一谈。
    if (!r) return c.json(errorBody('unavailable', `no verify provider for netdisk "${target.netdisk}"`), 501)
    return c.json({ ...r, netdisk: target.netdisk, pwd_id: target.pwd_id })
  })

  /** 选中的分享 → 转存进落点目录（默认取 Provider 行上的 dest，可按次覆盖）。 */
  app.post('/api/netdisk/share/save', async (c) => {
    if (!deps.netdiskShare) return c.json(errorBody('unavailable', 'netdisk share not configured'), 503)
    const body = (await c.req.json().catch(() => undefined)) as
      | {
          link?: string; netdisk?: string; pwd_id?: string; dest?: string; subdir?: string; passcode?: string
          /** 有它就走「转存 → 自动绑定」闭环：转存落进作品专属目录，成功后绑成这部作品的 tmdb 绑定。 */
          bind?: { id?: string; media?: string; title?: string; year?: number }
        }
      | undefined
    const gate = strictBody(c, body, SHARE_SAVE_KEYS)
    if (gate) return gate
    const target = isObject(body) ? shareTargetOf(body) : null
    if (!target) return c.json(errorBody('validation_error', 'link, or netdisk + pwd_id, required'), 400)
    const bindReq: { id: string; media: 'movie' | 'tv'; title?: string; year?: number } | undefined =
      body?.bind && body.bind.id && (body.bind.media === 'movie' || body.bind.media === 'tv')
        ? { id: body.bind.id, media: body.bind.media, ...(body.bind.title ? { title: body.bind.title } : {}), ...(typeof body.bind.year === 'number' ? { year: body.bind.year } : {}) }
        : undefined
    // 强一致检查点：绑定左侧的 title 只从服务端核实的作品详情出（videoDetails → tmdbWorkRef），
    // 前端快照只当身份提示——它曾把 tmdb id 当 title 传来，网盘目录因此永久叫了
    // 「55157 (1993) [tmdbid-55157]」。核实不出官方名 → 拒绝整个闭环且不转存。
    //
    // **这个检查在落点改用不透明目录名之后仍然必须留着，理由变了**：子目录名已不再取自 title
    // （opaqueWorkDirName 只吃 id+media），但 title 仍是绑定左侧的作品名——那是用户在 Stream
    // 界面里看到的东西。放它过去，界面上就会出现一部叫「55157」的作品。别顺手清理掉。
    let bind: TmdbWorkRef | undefined
    if (bindReq) {
      const verified = await verifiedWorkRef(bindReq)
      if (!verified) {
        return c.json({ saved: false, stage: 'bind-not-ready', message: '这部作品的官方名还没核实出来（TMDb 详情暂不可用）——先在详情页刷新，再回来转存' })
      }
      bind = verified
    }
    // subdir = 作品专属目录：落进 <行上的落点>/<subdir>/。绑定是「一个目录 ↔ 一个左侧」一对一，
    // 共用落点的话那个目录会同时装着几十部片子，没有哪个绑定能把它当自己的右侧。
    // 自动绑定时子目录名用**不透明**形态 `<media>-<tmdbId>`——网盘上不出现明文作品名，否则分享者
    // 打成规避字的文件名全白费（详见 opaqueWorkDirName 的注释与 2026-07-25 的设计）。绑定仍按
    // tmdb id 认（与路径解耦）。前端仍可传 subdir 显式覆盖，`jellyfinDirName` 为此保留。
    const r = await deps.netdiskShare.save(target.netdisk, target.pwd_id, {
      dest: body?.dest,
      subdir: body?.subdir ?? (bind ? opaqueWorkDirName(bind) : undefined),
      passcode: body?.passcode,
    })
    if (!r) return c.json(errorBody('unavailable', `no save provider for netdisk "${target.netdisk}"`), 501)
    // 转存成功就记一条**待认领**分享——**不论带不带 bind**。用户常常先转存、过几天才把那个落点
    // 建成绑定，而分享链接在这一刻就过完手了；不记，追更循环永远看不见它，同一部剧下次缺集还得
    // 重新搜同一条分享。认领在 FollowService（落地目录命中绑定的 right.path 时领走），过期由
    // 待认领账本自己收。带 bind 那一路下面还会立刻 recordShare 一次，这条随之在首轮被领走清掉。
    if (r.saved) {
      const landing = landingDirFor(target.netdisk, r.dest)
      // 落点说不清（没有挂载前缀 / 转存没回 dest）就不记：宁可少一条，也别记一个指不到任何绑定的目录。
      if (landing) {
        try {
          deps.netdiskRoutes?.follow?.recordPendingShare(target.netdisk, target.pwd_id, body?.passcode, landing)
        } catch (e) {
          console.warn(`[follow] recordPendingShare 失败（转存已成功）：${(e as Error).message}`)
        }
      }
    }
    // 转存 → 自动绑定：转存成功且带了 bind 就把落点绑成这部作品的绑定 + 同步配集，前端刷新即可播。
    // 绑定失败不翻转转存结果——文件已经转好了，绑定是锦上添花；把绑定的成败单列在 binding 字段里。
    let binding: unknown
    if (r.saved && bind && deps.netdisk) {
      const existing = deps.netdisk.bindingForTmdb(bind.id, bind.media)
      const action = planBinding(target.netdisk, r.dest, bind, existing)
      try {
        // 转存刚建的目录 AList 还没看到（缓存延迟）——先等它就绪再 sync，否则会「转存了却没配上」。
        const targetDir = action.kind === 'create' || action.kind === 'rebind' ? action.dirPath
          : action.kind === 'sync' ? existing!.right.path : undefined
        if (targetDir) await deps.netdisk.waitDirReady(targetDir)
        if (action.kind === 'create' || action.kind === 'sync' || action.kind === 'rebind') {
          const bound =
            action.kind === 'create' ? await deps.netdisk.bind({ left: action.left, dirPath: action.dirPath })
            : action.kind === 'sync' ? await deps.netdisk.sync(existing!)
            : await deps.netdisk.rebind(action.setId, action.dirPath)
          binding = workBindingViewOf(bound)
          // 手动转存过的分享进追更账本：下一轮追更会先回访它（更新的集数常常就挂在同一条分享下），
          // 不记就等于每次都要重新搜一遍同一部剧。追更没装配（未配 AList）时这一步天然不存在。
          // 单独包一层：账本写失败（SQLite busy 之类）只是丢一行可补的记录，绝不能把上面已经成功的
          // 绑定报成失败——那是把可恢复的小事说成不可恢复的大事。
          try {
            deps.netdiskRoutes?.follow?.recordShare(bound.id, target.netdisk, target.pwd_id, body?.passcode, 'manual')
          } catch (e) {
            console.warn(`[follow] recordShare 失败（绑定已成功）：${(e as Error).message}`)
          }
        } else binding = { error: action.reason }
      } catch (e) {
        binding = { error: String((e as Error).message) }
      }
    }
    // 转存失败（分享已死/目录建不出来）是业务结果，不是 HTTP 错误：200 带 saved:false + stage，
    // 调用方据 stage 说人话，而不是从一个 5xx 里猜发生了什么。
    return c.json(binding === undefined ? r : { ...r, binding })
  })

  if (deps.resolve) registerResolveRoutes(app, deps.resolve)
  // 链接认领的只读口：认领表是模块级 thunk（sources 域挂的），没有 deps，无条件挂。
  registerLinkRoutes(app)
  if (deps.netdiskRoutes) registerNetdiskRoutes(app, deps.netdiskRoutes)
  if (deps.sharing) registerSharingRoutes(app, { ...deps.sharing, onChannelsChanged: deps.onChannelsChanged })
  if (deps.onboard) registerOnboardRoutes(app, deps.onboard)
  if (deps.conversions) {
    registerConversionsRoutes(app, {
      runner: deps.conversions,
      // 一个 handle 指不指向真实存在的东西：存量 item，或 netdisk 绑定的作品（`tmdb:…` 分集
      // 本来就不在 item store 里——这正是它存在的意义，见 src/transcribe/source.ts）。
      resolveHandle: (handle) => {
        const stored = deps.itemStore.get(handle)
        if (stored) {
          return {
            known: true,
            media: stored.content?.media,
            // extract 判分支要的就是它（archetype 是入库时写好的必填字段）。`url` 是 article
            // 分支在 media 里找不到链接时的兜底地址。
            content: stored.content,
            url: stored.url,
            snapshot: { title: stored.title, source: stored.stream_id, url: stored.url },
          }
        }
        // 网盘绑定的作品/分集（`tmdb:…`）：**不是 item，没有 content**。但这个命名空间本身
        // 就是一段影音——这是关于句柄的事实，不是嗅探。媒体由句柄解析，故 resolvedByHandle。
        const bound = !!deps.netdisk?.lookup(netdiskKeyFor(handle))
        if (bound) return { known: true, content: { archetype: 'video', resolvedByHandle: true } }
        return { known: false }
      },
    })
  }

  return app
}
