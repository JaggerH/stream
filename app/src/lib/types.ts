import type { AuthorEnrichView, ItemActionView, SourceSiteView } from '@item/actions.ts'

export type SourceType = 'post' | 'conversation' | 'email' | 'calendar'

export interface StreamSummary {
  id: string
  description: string
}

// —— normalized presentation model (mirrors backend src/content/types.ts) ——
export type Archetype = 'text' | 'article' | 'video' | 'audio' | 'gallery' | 'link' | 'forward'
export type Media =
  | { kind: 'image'; url: string; thumb?: string; w?: number; h?: number; alt?: string }
  | { kind: 'video'; url?: string; embed?: string; poster?: string; duration_s?: number; page_url?: string; provider?: string; vid?: string; resolveOnly?: boolean; w?: number; h?: number }
  | { kind: 'audio'; url?: string; poster?: string; duration_s?: number; page_url?: string; platform?: string; track_id?: string; resolveOnly?: boolean }
  | { kind: 'link'; url: string; title?: string; summary?: string; image?: string; platform?: string; track_id?: string; duration_s?: number }
export interface Quoted {
  author?: string
  text?: string
  media?: Media[]
  permalink?: string
  archetype?: Archetype
}
/** Film/series metadata — set only by the movie normalizer (video-variant channels). */
export interface ContentMeta {
  rating?: string
  year?: string
  genres?: string[]
  /** normalizer 自报的来源短键（后端不枚举站） */
  source?: string
  /** `source` 的显示名，normalizer 给（前端不认识任何一家；缺了就原样显示 `source`） */
  sourceLabel?: string
}
export interface Content {
  archetype: Archetype
  title?: string
  text?: string
  media?: Media[]
  quoted?: Quoted
  meta?: ContentMeta
  /** 源站说这条要钱。与能不能播无关——网盘补上音频后依然是付费集（后端 normalize 注入）。 */
  paid?: boolean
  /** 打开时去哪现取剩下的：包的 normalizer 写，`enrichParamsFor` 先看它、原样进 `/api/enrich`
   *  的 query（`source` 是那个包申报的 enricher 名，`params` 全字符串）。`prefetch: true` = 包自报这次
   *  现取便宜（站外裸 HTTP、不骑采集标签页）：随滚动预取、走 HTTP；缺省只在点开时经 WS 现取。
   *  镜像 `src/content/types.ts`。 */
  enrich?: { source: string; params: Record<string, string>; prefetch?: boolean }
}

/** One source's failure inside a live preview — shown in the preview modal (see api.previewStream). */
export interface PreviewError {
  source: string
  category: string
  reason: string
}
/** Result of a live, non-persisted preview: normalized items + per-source failure reasons. */
export interface PreviewResult {
  items: Item[]
  errors: PreviewError[]
}

export interface Item {
  id: string
  stream_id: string
  /** source manifest id (`<包名>/<局部名>`, or a catalog `rsshub:<ns>/…` id); the backend resolves
   *  it for the projected `source_label` / `source_site`.
   *  Absent on items persisted before the backend started stamping it. */
  source_id?: string
  /** 本季在合并剧里的季号（见后端 `StreamItem.season`）——缺省 = 这个 Stream 没有本地季分组。 */
  season?: number
  type: SourceType
  title: string
  url?: string
  author?: string
  /** author avatar url when the source carries one; absent otherwise (see `author_enrich`) */
  author_avatar?: string
  /** engagement counts where the source provides them */
  comment_count?: number
  like_count?: number
  body_text?: string
  body_html?: string
  attachments?: string[]
  content?: Content
  videoRef?: {
    title: string
    aliases?: string[]
    year?: number
    kind?: 'movie' | 'series' | 'season' | 'episode' | 'unknown'
    sourceUrl?: string
    externalIds?: Record<string, string>
  }
  /** Cache-only projection of provider-enriched video detail, attached by the video list API. */
  videoDetail?: { title?: string; year?: number; rating?: number; poster?: string; backdrop?: string }
  /** note id promoted from the raw archive at the API serialization boundary (list endpoints strip `raw`). */
  note_id?: string
  /** source-native guid promoted at the API boundary — "<storyId>[-<count>]" on discussion-site items. */
  source_guid?: string
  /** 以下四格是后端出线口现算的投影（包的 `stream.item` + 源目录，见 docs/API.md「Items 出线形状里的投影格」）。
   *  前端只照着画，不按站分支。 */
  /** 作者头像 / 主页去哪现取（仅在没有 author_avatar 时出）。 */
  author_enrich?: AuthorEnrichView
  /** 这条上的可点动作（点赞 / 收藏…），由产出它的包声明。 */
  actions?: ItemActionView[]
  /** 源在条目上给人看的名字（源目录标题，前带站名）。 */
  source_label?: string
  /** 源所属站点（认领它的包的 homepage）：画图标用。 */
  source_site?: SourceSiteView
  /** set by the backend ad-filter; the inbox folds (does not drop) muted items.
   *  reason 'lottery' = 抽奖; manual = human read-time label vs auto rule hit */
  muted?: { reason: string; rule: string; manual?: true }
  /**
   * 同质内容归堆（后端 `src/story-fold/`）：这条和别的条目说的是同一件事。
   *
   * **成员条照发不隐藏**——后端把整堆都给了，收起来是这一层的事。`isRep` 的那条当门面，
   * 其余的默认不单独占一行；`why` 是「凭什么并的」，用户展开时要看得见，看不见他就不敢信。
   */
  storyGroup?: { id: string; isRep: boolean; size: number; why: Array<{ kind: string; score: number; detail: string }> }
  timestamp: string
  fetched_at: string
}

// —— on-demand enrichment model (mirrors backend src/content/types.ts) ——
/** Extracted article body for a link item, or a note's own text/media. */
export interface Article {
  sourceUrl: string
  title?: string
  author?: string
  published?: string
  /** sanitized content html (rendered with dangerouslySetInnerHTML) */
  html?: string
  /** plain-text body, when there's no rich html */
  text?: string
  media?: Media[]
  excerpt?: string
  leadImage?: string
  wordCount?: number
  domain?: string
}

/** A normalized comment. Flat sources leave `replies` empty; threaded
 *  sources (discussion sites) nest. `html` (when present) is sanitized and preferred over `text`. */
export interface Comment {
  id: string
  author?: string
  avatar?: string
  text: string
  html?: string
  like?: number
  badges?: string[]
  ip?: string
  time?: number
  replies?: Comment[]
}

export interface Enrichment {
  article?: Article
  comments?: Comment[]
  total?: number
  /** opaque cursor for the next page (cursor-paged comment APIs); null/absent = no more */
  cursor?: string | null
}

/** Per-source diagnostics from one aggregated video search (drives the timing panel). */
export interface VideoSourceTiming {
  /** source slug — matches Release.source / ShowSeason.source */
  key: string
  label: string
  ms: number
  count: number
  /** 跨源去重丢掉的 release 数；count=0 && dropped>0 = 全是重复，不是无结果 */
  dropped: number
  status: 'ok' | 'empty' | 'error' | 'timeout'
}

/** Static per-source metadata (label + click-through search url) for badges. */
export interface VideoSourceMeta {
  key: string
  label: string
  searchUrl?: string
}

/** Streamed search events (NDJSON from /api/video/search/stream). */
export type VideoSearchEvent =
  | { type: 'init'; sources: VideoSourceMeta[] }
  | { type: 'source'; key: string; part: { shows: ShowSeason[]; loose: Release[] }; timing: VideoSourceTiming }
  | { type: 'done' }

// —— faceted video search model (mirrors backend src/video/types.ts) ——
export type Quality = '2160p' | '1080p' | '720p' | 'sd' | 'unknown'
export type VideoSourceType = 'magnet' | 'ed2k' | 'quark' | 'baidu' | 'aliyun' | 'unknown'
export type Coverage =
  | { kind: 'pack'; from: number; to: number; total: number | null }
  | { kind: 'complete' }
  | { kind: 'single'; episode: number }
  | { kind: 'range'; from: number; to: number }
  | { kind: 'unknown' }
export interface Release {
  source: string
  title: string
  /** original full message text (pansou) — shown verbatim when present */
  content?: string
  /** preview/cover image URLs (pansou) */
  images?: string[]
  /** 出处频道名（源给的） */
  channel?: string
  /** 出处频道页 URL（源给的）——直接链它，前端不拼 */
  channelUrl?: string
  /** 没有频道时的出处名（来源标签） */
  provider?: string
  /** 这一条的出处 URL（源给的） */
  origin?: string
  quality: Quality
  sourceType: VideoSourceType
  coverage: Coverage
  codec?: string
  hdr?: string
  group?: string
  sizeBytes?: number
  link: string
  password?: string
  /** finer netdisk label (天翼/UC/迅雷/123/115) when sourceType collapses to unknown */
  netdiskLabel?: string
  /** mirror shares of THIS SAME work on other netdisks (each a typed link + 提取码) */
  links?: Array<{ url: string; type: VideoSourceType; password?: string }>
  needsResolve?: boolean
  parsed: boolean
}
export interface CoverageSummary {
  total: number | null
  episodes: number[]
  missing: number[]
  hasPack: boolean
}
export interface QualityBucket {
  quality: Quality
  releases: Release[]
  coverage: CoverageSummary
}
export interface ShowSeason {
  source: string
  title: string
  pageUrl?: string
  /** cover/poster image (btbtla) */
  image?: string
  season: number | null
  total: number | null
  qualities: QualityBucket[]
}
export interface VideoSearchResult {
  shows: ShowSeason[]
  loose: Release[]
  sources: VideoSourceTiming[]
}

export interface MusicSearchResult {
  id: string
  platform: string
  trackId: string
  title: string
  artist?: string
  album?: string
  poster?: string
  durationS?: number
  /** the song's page on the source platform (来源 link / stored as source_url when collected).
   *  NOT playable: the player rebuilds the resolve route from (platform, trackId). */
  sourceUrl: string
}

/**
 * 统一收藏系统(2026-07-20)——「什么被收藏了」和「在哪个列表里」分开。取代了 v1 的两套并行实现
 * (音频 LikedTrack「我的喜欢」、视频 CollectedWork「正在追」),现在两个域共用同一套原语。
 * 键判别式同构 netdisk 的 MappingLeft:stream(关注的 Stream)/ tmdb(纯榜单作品,无 Stream)/
 * track(音乐单曲)。
 */
export type CollectedItemKind = 'stream' | 'tmdb' | 'track' | 'episode'
export type CollectionDomain = 'video' | 'audio'

export interface CollectedItem {
  key: string
  kind: CollectedItemKind
  domain: CollectionDomain
  streamId?: string
  tmdbId?: string
  media?: 'movie' | 'tv'
  platform?: string
  trackId?: string
  itemId?: string
  title: string
  poster?: string
  artist?: string
  album?: string
  durationS?: number
  sourceUrl?: string
  firstCollectedAt: number
}

/** 一个命名列表——两个系统默认列表(正在追的/我的喜欢,`system` 有值、不可删)+ 用户自建的任意多个。 */
export interface Collection {
  id: string
  domain: CollectionDomain
  label: string
  system?: 'following' | 'liked'
  /** 锚定的 stream——该播单作为子列表出现在这个 stream 的 detail 里。undefined = 全局播单。 */
  anchorStreamId?: string
  itemCount?: number
  createdAt: string
  updatedAt: string
}

/** 两个系统默认列表的 id——同构后端 collections/store.ts 的同名导出,值必须一致。 */
export const SYSTEM_COLLECTIONS = { videoFollowing: 'col_video_following', audioLiked: 'col_audio_liked' } as const

export interface SourceCandidate {
  id: string
  adapter: string
  description: string
  type: SourceType
  categories: string[]
  capabilities: string[]
  params_schema: Record<string, unknown>
  auth: string
  cadence_hint_seconds: number
  /** RSSHub-catalog enrichment (display-only; present for catalog sources) */
  notes?: string
  docsMarkdown?: string
  requireConfig?: boolean
  nsfw?: boolean
  homepage?: string
  example?: string
  score: number
}

export interface PluginSummary {
  id: string
  name: string
  tagline?: string
  description?: string
  homepage?: string
  repository?: string
  docsUrl?: string
  status: 'ready' | 'needs_config' | 'disabled' | 'error'
  /** user enable flag (required plugins are always true) */
  enabled: boolean
  /** core plugin that cannot be disabled — UI locks the toggle on */
  required: boolean
  launch: {
    mode: 'builtin' | 'container' | 'external' | 'manual'
    health?: 'healthy' | 'starting' | 'unhealthy' | 'unknown'
  }
  capabilities: string[]
  sourceCount: number
  sourceGrouping?: {
    enabled: boolean
    resolver: string
  }
  topCategories?: Array<{ key: string; label: string; count: number }>
  configured?: boolean
  health?: 'ok' | 'down' | 'unknown'
}

export interface Facility {
  key: string
  label: string
}

export interface SourceSummary {
  id: string
  pluginId: string
  pluginName: string
  adapterId?: string
  title: string
  description?: string
  categories: string[]
  facility?: Facility
  /** 认领这条源的包说它是哪个站（包的 homepage 主机）；图标先用它。 */
  site?: SourceSiteView
  capabilities: string[]
  auth: string
  badges?: string[]
  paramCount: number
  requiredParamCount: number
}

/** 「这一格配置有谁能替我去申请」——`POST /api/source-runtime-config/status` 回执里那格
 *  `provisioner`（后端 `SourcesService.configProvisionerFor` 的原样投影）。`null` = 没人能，
 *  界面上就只剩「前往申请」那条外链。**判据在后端**：前端从不自己挑该跑哪条 recipe。 */
export interface RuntimeConfigProvisioner {
  sourceId: string
  field: string
  entryUrl: string
  label: string
  paramsSchema: Record<string, { type?: string; required?: boolean; description?: string }>
}

export interface SourceRuntimeConfigStatus {
  values: Record<string, string>
  secrets: Record<string, { configured: boolean }>
  provisioner: RuntimeConfigProvisioner | null
  /** 部署环境变量兜得住的格（只有字段名）。必填判据认它：这些格空着也能跑。老后端不回这一格。 */
  envFallback?: string[]
}

export interface SourceDetail extends SourceSummary {
  paramsSchema: Record<string, ParamSpec>
  /** `perInstance` = 这份配置属于**一个成员实例**（同一个源可以带不同 params 多次进一条梯子），
   *  落点是那个成员的 `params.tokenName`（完整 ref，形如 `llm:<实例名>`），不是全源共享的 `ref`。 */
  runtimeConfig?: { ref: string; fields: Record<string, { type: 'secret' | 'string'; label: string; description?: string; helpUrl?: string; required?: boolean; default?: string }>; perInstance?: boolean }
  docs?: {
    markdown?: string
    url?: string
  }
  examples?: Array<{ title?: string; params: Record<string, string> }>
  credentials?: Array<{ domain: string; required: boolean; reason?: string }>
}

/** /api/resolve/targets 里的 source 节点:完整展示字段 + 健康/主力标记。 */
export type ResolveTargetSource = SourceSummary & { health: 'healthy' | 'degraded' | 'dead'; active: boolean }

/**
 * 选择面：这个源列表是**为哪个动作**服务的。
 *
 * - `stream` —— 给频道加一条会持续来内容的流。
 * - `provider` —— 给 Provider 行挑一个干活的成员（搜索腿、网盘验活这些住在这里：它们不是流，
 *   但确实该能被挑中）。
 *
 * 后端按源自己的 `pick_in` 申报过滤（判据 `pickableIn`）。不传 = 两个面的并集，只滤掉"谁都不该
 * 挑"的那些——总览页用这一档。**打开一个选择器时就该把它是哪个面说出来**，否则用户会在"给频道
 * 加来源"里看到"给笔记点赞"这种动作。
 */
export type PickSurface = 'stream' | 'provider'

export interface PluginSourceListResponse {
  plugin: PluginSummary
  sources: SourceSummary[]
  groups: Array<{ key: string; label: string; count: number }>
  facets: {
    categories: Array<{ key: string; label: string; count: number }>
    capabilities: Array<{ key: string; label: string; count: number }>
    facilities: Array<{ key: string; label: string; count: number }>
  }
  nextCursor?: string
  total?: number
}

export interface PluginSourcesSearchResponse {
  sources: SourceSummary[]
  plugins: Array<{ id: string; name: string; count: number }>
  facets: {
    categories: Array<{ key: string; label: string; count: number }>
    capabilities: Array<{ key: string; label: string; count: number }>
  }
  nextCursor?: string
  total?: number
}

export interface ParamOption {
  label?: string
  value: string
}

export interface ParamSpec {
  type?: string
  required?: boolean
  description?: string
  default?: string
  options?: ParamOption[]
  /** 这个字符串参数用哪种控件填。manifest 的 `params_schema.<key>.widget` 原样透传过来
   *  （后端把 params_schema 当不透明记录，不校验也不改写），认得的 key 见前端
   *  `SourceParamField` 的 PARAM_WIDGETS 登记表；不认得的一律退回纯文本框。 */
  widget?: string
}

export interface SourceInfo {
  id: string
  description: string
  type: SourceType
  categories: string[]
  capabilities: string[]
  params_schema: Record<string, unknown>
  auth: string
  cadence_hint_seconds: number
}

export interface StatusInfo {
  ok: boolean
  cookies: CookieHealth
  manifests: number
  streams: { id: string; last_tick: string | null; item_count: number }[]
}

/** POST /api/streams body — mirrors the backend StreamRecord (SourceBinding members). */
export interface StreamCreate {
  id: string
  label: string
  strategy: 'fanout' | 'exclusive'
  cadence_seconds: number
  members: { plugin: string; source: string; params: Record<string, unknown> }[]
  options: Record<string, unknown>
  /** 建流的同时把归属定下来，一次请求内完成。省掉它就有一个「这条流不属于任何频道」的中间态，
   *  而后端对没归属的流答"该采集"——归 live present 频道（research/search）的流会因此被抓一次
   *  并落库。没有频道可给的调用方（独立资源流）不传，行为与从前一致。 */
  channel_id?: string
}

/** Coarse failure class from the source-health ledger (mirrors backend src/failure.ts). */
export type FailureCategory = 'drift' | 'auth' | 'timeout' | 'network' | 'blocked' | 'empty' | 'unknown'

/** Latest recorded failure for an unhealthy source — the "why" behind a red/amber dot.
 *  Present only for non-healthy sources that actually errored; healthy sources omit it. */
export interface SourceHealthError {
  category: FailureCategory
  message: string
  at: string
}

/** 一个源申报依赖的东西出了问题。
 *  - `broken`：那个依赖此刻非健康。它多半**不是任何一条 Stream 的成员**（xhs 的 detail 就是
 *    这样），界面上没有属于它的行——所以这条只能挂在用它的人身上，否则用户永远看不到。
 *  - `unresolved`：那条 `uses` 边解析不到（包没装 / id 打错）。答案里的洞，一样要说出来。 */
export type DependencyIssue =
  | { kind: 'broken'; id: string; title?: string; health: 'healthy' | 'degraded' | 'dead'; error?: SourceHealthError }
  | { kind: 'unresolved'; id: string }

export interface StreamMember {
  // The Source's presentation is the SINGLE publicSource() projection, nested verbatim —
  // the same SourceSummary the plugin catalog serves. The frontend renders it directly and
  // never derives display fields from ids (that is why `source.id` is the clean manifest id,
  // not the composite `pluginId:templateId`). Binding-specific fields sit alongside, below.
  source: SourceSummary
  params: Record<string, unknown>
  // Runtime overlay from the source-health ledger. `active` = the current winning rung
  // of an exclusive Stream's priority ladder (meaningless for fanout). Optional overlay.
  health?: 'healthy' | 'degraded' | 'dead'
  // The failure detail behind a non-healthy `health` (hover card). Absent when healthy.
  healthError?: SourceHealthError
  /** 「我自己绿着，但我依赖的东西有问题」——后端沿 `uses` 反着读出来的（`brokenDependencies`）。
   *  和 `health` 是两件事：`health` 说「我采得动吗」，这一格说「我依赖的东西还在吗」。
   *  两者同时绿才等于产出是完整的；只有 `health` 绿正是那个静音故障的样子。 */
  dependencyIssues?: DependencyIssue[]
  active?: boolean
}

export interface Stream {
  id: string
  description: string
  sources: StreamMember[]
  cadence_seconds: number
  vault_subdir: string
  /** upstream shape (storage/consumption authority, mirrors backend Stream.mode): 'collection'
   *  = full-snapshot each harvest + excluded from the all-latest timeline; 'feed'/absent =
   *  incremental append/evict window. Consumption routing (audio vs timeline) is owned by the
   *  Channel's `kind`, not this field — see ChannelStream.kind below. */
  mode?: 'feed' | 'collection'
  /** cover image, attached by the API for audio streams (cover of the most recent stored
   *  item that has one). Display-only; absent for non-audio streams. */
  image?: string
  /** rules ADDED on top of the built-in + config.yaml global ad_filter, scoped to this
   *  stream only. Edited via api.setStreamAdFilter. */
  ad_filter?: { keywords?: string[]; domains?: string[] }
  /** 只看包含: keep only items whose title contains one of these keywords (non-matching fold at
   *  ingest). Edited via api.setStreamTitleFilter. */
  title_include?: string[]
}

/** A named target that groups 1+ streams — the read-layer navigation entity
 *  consumed by MusicChannel (and eventually the sidebar). Returned by /api/channels. */
export interface ChannelView {
  id: string
  label: string
  description?: string
  /** @deprecated present 的读别名,前端迁完删 */
  kind: 'audio' | 'timeline' | 'mixed' | 'video'
  present: 'timeline' | 'search' | 'audio' | 'video' | 'research' | 'tasks' | 'embed'
  system?: boolean
  image?: string
  streams: ChannelStream[]
  /** 频道级配置(如 `slots`:能力槽位覆盖,见 docs/superpowers/specs present-channel-slots)。
   *  未配置任何 options 的频道(如 ungrouped 的 solo 频道)不带这个字段。 */
  options?: Record<string, unknown>
  /** 归属的空间(侧栏分组那一层,见 docs/API.md §Spaces)。后端每条都给,恒非空。 */
  space_id: string
}

/** 空间 = 频道之上那一层,侧栏里的分组。只有名字和次序。
 *  **别叫它"组"**——Stream 里"组"指的是频道对 stream 的分组(ungrouped stream 会自动变成
 *  一个 solo 频道),同一个词在两层上各指一件事。 */
export interface SpaceView {
  id: string
  label: string
  /** 侧栏显示次序,小的在前。 */
  position: number
  /** 默认空间:不可删(它是所有频道的兜底落点),但可以改名挪位置。 */
  system?: boolean
}

/** 所有频道的默认落点。与后端 `DEFAULT_SPACE_ID` 同一个字面量。 */
export const DEFAULT_SPACE_ID = 'default-space'

/** `POST /api/channels` 的返回体：后端的**原始记录**，不是 `ChannelView`——没有展开的 `streams`，
 *  多一个 `stream_ids`。新建路径只用它的 `id`（随后整份重拉），所以这个端点保持原样；
 *  `PATCH /api/channels/:id` 才返回持久化后的 `ChannelView`（见 lib/channels.tsx 的写入口）。 */
export interface ChannelRecordDto {
  id: string
  label: string
  present: 'timeline' | 'search' | 'audio' | 'video' | 'research' | 'tasks' | 'embed'
  stream_ids: string[]
  system?: boolean
  options?: Record<string, unknown>
}

export interface ChannelCreate {
  label: string
  /** @deprecated present 的写别名,前端迁完删 */
  variant?: 'timeline' | 'audio'
  /** 后端收的是全集（`coercePresent`，src/store/present.ts）。这里曾窄成 timeline|audio，
   *  于是新增的 present 连"能被创建"都表达不出来——研究频道只能手搓 API 建。 */
  present?: 'timeline' | 'search' | 'audio' | 'video' | 'research' | 'tasks' | 'embed'
  stream_ids: string[]
  options: Record<string, unknown>
  /** 归属的空间。不给 = 落默认空间；指向不存在的空间后端 400。 */
  space_id?: string
}

export const DEFAULT_TIMELINE_CHANNEL_ID = 'default-timeline'
export const DEFAULT_AUDIO_CHANNEL_ID = 'default-audio'
export const DEFAULT_VIDEO_CHANNEL_ID = 'default-video'

export interface ChannelStream {
  id: string
  description: string
  kind?: 'timeline' | 'audio'
  image?: string
  /** unread / new-episode count since the viewer's read-watermark. Attached by the API ONLY to
   *  a video channel's followed (non-ranking) members — its PRESENCE marks a stream as
   *  "正在追的". Absent on ranking streams and on non-video channels. */
  newCount?: number
  /** 作品简介 — feed-level synopsis for a followed video work, shown on the level-2 detail page. */
  synopsis?: string
  sources: StreamMember[]
  cadence_seconds: number
  vault_subdir: string
  /** How the Stream combines its member Sources: `fanout` = harvest all + merge;
   *  `exclusive` = priority ladder, first healthy Source wins. Optional until the
   *  backend exposes it on the channel payload. */
  strategy?: 'fanout' | 'exclusive'
  /** rules ADDED on top of the built-in + config.yaml global ad_filter, scoped to this
   *  stream only. Edited via api.setStreamAdFilter. */
  ad_filter?: { keywords?: string[]; domains?: string[] }
  /** 只看包含: keep only items whose title contains one of these keywords (non-matching fold at
   *  ingest). Edited via api.setStreamTitleFilter. */
  title_include?: string[]
  /** T1 harvest policy: first-harvest backfill depth vs steady-state incremental depth.
   *  Edited via api.updateStream({ options: { harvest } }). Unset = backend default. */
  harvest?: { backfillLimit?: number; incrementalLimit?: number }
}

/** A live WS message from the backend. */
/** One labelled detail row of a debug entry (mirrors backend src/http/debug-log.ts). */
export interface DebugField {
  label: string
  value: string
  tone?: 'ok' | 'warn' | 'bad' | 'muted'
}

/** A generic debug entry from any flow (audio resolve / download / video resolve). Delivered
 *  live over the WS ({type:'debug'}) and readable via GET /api/debug/log. The DebugBox renders
 *  it domain-agnostically: summary + fields. */
export interface DebugEntry {
  id: string
  at: number
  channel: string
  key: string
  title: string
  summary: string
  ok: boolean
  fields: DebugField[]
}

export type WsMessage =
  | { type: 'item'; item_type: SourceType; item: Item }
  // live harvest preview stream: one frame per freshly-scraped item during a recipe run,
  // then a done frame. Fed to the discover window + the preview modal so they fill as the
  // scrape happens instead of waiting for the whole batch.
  | { type: 'harvest-item'; sourceId: string; label?: string; item: Item }
  | { type: 'harvest-done'; sourceId: string }
  | { type: 'debug'; entry: DebugEntry }
  | {
      type: 'audio-download'
      job: {
        id: number
        platform: string
        track_id: string
        state: string
        attempts: number
        last_error?: string
        downloaded_bytes?: number
        total_bytes?: number
        archived?: boolean
      }
    }
  // 通用 WS 现取协议（`enrich.open { source, params }` 的回程）：包交出的 enricher 在采集会话里现取
  // 一条的正文 / 评论，分片推回；全部按 correlationId 认领。`blocked` = 采集会话被站点挡住。
  | { type: 'enrich.started'; correlationId: string }
  | { type: 'enrich.article'; correlationId: string; article: Article }
  | { type: 'enrich.comments'; correlationId: string; comments: Comment[]; total: number }
  | { type: 'enrich.completed'; correlationId: string }
  | { type: 'enrich.failed'; correlationId: string; error: string }
  | { type: 'enrich.blocked'; correlationId: string; reason: string }
  // research present: 某个 live 流背后的 artifacts 目录变了（防抖后）。不带数据——
  // 收到的一端自己决定要不要重查，本仓是 ResearchChannel 按 streamId 过滤后 fetchLiveItems。
  | { type: 'live-changed'; streamId: string }
  // 频道 / Stream / 空间的库存变了（后端在 UserStore 的写路径上广播，合并成一拍）。
  // **不带 diff**：收到的一端自己重读一次名录。理由见 src/store/user-store.ts 的 `onChange`
  // ——改这份库存的入口不止网页，对话里 AI 走的是 MCP 工具，带 diff 就要每个入口都说清自己
  // 改了什么，漏说的那次只会让界面停在旧数据上而不报错。
  | { type: 'inventory' }

/** 一台机器上发现的 Chrome。`side` 决定排序（Windows 侧在前），**不是自动选中**。 */
export interface ChromeCandidate {
  exe: string
  side: 'windows' | 'linux'
  source: 'standard' | 'user-install' | 'path'
}

/** 「采集用哪个 Chrome」。`mustChoose` = 没选过且候选不止一个——此时必须问用户，
 *  替他挑错的症状是"一切正常运行、只是采集全程游客态"。 */
export interface HarvestBrowserStatus {
  selected: string | null
  origin: 'settings' | 'config' | null
  candidates: ChromeCandidate[]
  mustChoose: boolean
}

/** 采集能力三态（后端真相源：src/browser/capability-store.ts）。
 *  `never-seen` = 从没连上过（该走安装引导）；`disconnected` = 连过又掉了（该走排查，
 *  **不是**再劝他装一遍）；`ready` = 现在就能用。 */
export type BrowserCapabilityState = 'ready' | 'disconnected' | 'never-seen'

export interface BrowserCapabilitySnapshot {
  state: BrowserCapabilityState
  connected: boolean
  since: string | null
  everSeen: boolean
  lastSeenAt?: string
  extVersion?: string
  browser?: string
  platform?: string
}

/** 代装的三态回执（后端真相源：src/browser/extension-install.ts）。
 *  `needs-chrome-restart` **不是失败**——步骤都跑完了，多半只差重启一次 Chrome。 */
export type ExtensionInstallOutcome =
  | { status: 'connected' }
  | { status: 'needs-chrome-restart' }
  | { status: 'blocked'; reason: string }

/** 登录态快照现状（后端真相源：src/credentials/pushed-cookie-store.ts）。
 *  空 `domains` 单看分不出"从没取过"和"取过了但一个域都没有"——判据是 `updatedAt`。 */
export interface CookieHealth {
  /** 现在握着哪些 cookie 域（已归一：剥前导点 + 小写）。 */
  domains: string[]
  /** 上一次整份取回的时刻（epoch ms）；null = 从来没取到过。 */
  updatedAt: number | null
}

/** 摘要 prompt + LLM 就绪状态。连接（端点+key）与模型不在这里配了——它们是 `llm` Provider 行上的
 *  成员实例与调用点绑定，配置面在 Providers 页。`configured` = 梯子上有端点齐全的成员。 */
export interface SummaryPromptStatus {
  prompt: string
  configured: boolean
}

/** A plugin's read-only status row (the plugin status panel). */
export interface PluginStatus {
  id: string
  configured: boolean
  health: 'ok' | 'down' | 'unknown'
}

/** A denormalized snapshot of the source item, stored with its transcript so the
 *  history stays findable even after the source card scrolls away (ephemeral Discovery). */
export interface ItemSnapshot {
  title?: string
  /** short source label (the item's stream id / facility, as the backend snapshot reports it) */
  source?: string
  sourceId?: string
  streamId?: string
  author?: string
  authorAvatar?: string
  poster?: string
  url?: string
}

// —— Conversions（统一的转换资源；契约见 docs/API.md「Conversions」）——

export type ConversionKind = 'extract' | 'identify' | 'frames' | 'summary' | 'audio-fp'

/** 一个阶段的墙钟。**未发生的阶段不会出现在数组里**——「没跑」和「跑了 0ms」是两回事，
 *  所以渲染时不要给缺失的阶段补 0。 */
export interface ConversionStage {
  name: string
  ms: number
}

export interface ConversionTiming {
  totalMs: number
  stages: ConversionStage[]
}

/** 梯子上的一档：哪个成员跑了、背后是哪个 source、花了多久、结果如何。
 *  `member` 是寻址键（用户起的实例名，如 `zhipu`），`source` 才是它背后的源 id——两个都要，
 *  只看键答不出"用的哪个 source"，只看源分不清同一个源的两个实例。 */
export interface LadderRung {
  member: string
  source: string
  ms: number
  /** win = 它出的结果；miss = 它弃权（没配/不适用）；error = 它试了但失败；
   *  rejected = 它答过，但被调用方的 validate 否决，换了下一个成员。
   *  **miss 和 error 必须分开看**——前者去配置，后者去查故障，方向相反。 */
  outcome: 'win' | 'miss' | 'error' | 'rejected'
  reason?: string
}

/** 一次转换走了梯子上的哪几档。`via` = 赢的那个成员的寻址键（null = 全员没出结果）。 */
export interface LadderTrace {
  via: string | null
  rungs: LadderRung[]
}

/** 一次转换：把一个 item 派生出一份新产物。信封所有 kind 同形，`result` 按 kind 判别。 */
export interface Conversion {
  id: string
  kind: ConversionKind
  itemId: string
  status: 'queued' | 'running' | 'done' | 'error'
  queuePos?: number
  inputId?: string
  snapshot?: ItemSnapshot
  /** 分阶段耗时（失败的转换也有——慢失败才是要查的那种）。历史迁移来的旧记录没有这个字段。 */
  timing?: ConversionTiming
  /** 这一次是 Provider 梯子上的谁干的。走梯子的 kind 才有；老记录没有（那时还没记）。 */
  ladder?: LadderTrace
  error?: { code: string; message: string }
  /** 列表默认不带（要正文得 expand=result）。按 kind 判别：
   *  extract → {text,format,branch,detail?}（转写特产 lang/segments/media 在 detail 里）；
   *  identify → {probe}（说话人内容在声纹库时间线，经 /api/voiceprint/* 读）；summary → {summary}。 */
  result?: unknown
  createdAt: string
  startedAt?: string
  finishedAt?: string
  updatedAt: string
}

/** 一种转换的能力描述——`available` 决定按钮显不显示（别再 POST 试探 503）。 */
export interface ConversionKindInfo {
  kind: ConversionKind
  label: string
  stages: string[]
  available: boolean
  options: Record<string, string>
  /** extract 才有：各分支（stt/ocr/article）的后端此刻配没配——planExtract 的 caps 输入，
   *  「转成文字」按钮的显隐由它 + archetype 一起决定。 */
  branches?: Record<string, boolean>
}

// —— Provider view types (shared by ProvidersPage + the source-config Sheet) ——
export type ProviderCategory = 'search' | 'resolve' | 'download' | 'transform' | 'transcribe' | 'llm' | 'metadata' | 'images'
export type MemberHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unknown'

/** Raw provider member (write shape). Explicit source ref, or an auto-catalog member.
 *  `name` = 实例名（可选）：同一个 source 带不同 params 多次进同一行时的寻址键
 *  （ResolvedMember.name / options.exclude / calls.byMember 用的都是它；不写时 = source）。 */
export type ProviderMemberRef =
  | { source: string; name?: string; params?: Record<string, unknown> }
  | { mode: 'auto'; provides?: string; matches?: string; params?: Record<string, unknown> }
  /** category 段：成员 = 目录里 `categories` 含该标签且声明了 `key_param` 的每个源，resolve 时现取
   *  （后端 registry.inCategory）。这份镜像与 `src/store/types.ts` 的 ProviderMemberRef 同源，
   *  后端加一种段这里就要加一行——否则写侧构造出的合法行在前端是个类型错误。 */
  | { mode: 'auto'; category: string; params?: Record<string, unknown> }

export type ResolvedMember = {
  // name = binding/addressing key (reorder/exclude operate on it); source = the single
  // publicSource() projection, nested verbatim (same shape the plugin catalog serves).
  name: string
  priority: number
  source: SourceSummary
  health: MemberHealth
  // Failure detail behind a non-healthy `health` (hover card). Absent when healthy.
  healthError?: SourceHealthError
  // Key-provisioning state for a member declaring `secret` in its manifest. Absent when the
  // source has no secret declaration (nothing to show a badge for).
  keyState?: 'stored' | 'env' | 'missing'
}

export type ProviderView = {
  id: string
  label: string
  description?: string
  category: ProviderCategory | null
  serves: string[]
  strategy: 'sequential' | 'concurrent' | null
  status: 'live' | 'planned'
  callSites: string[]
  referencedBy?: string[]
  members: ProviderMemberRef[]
  resolvedMembers: ResolvedMember[]
  calls: { total: number; byMember: Record<string, number>; lastCalledAt: string | null }
  options?: { exclude?: string[]; [key: string]: unknown }
  /** parked = 搭车导入、尚未激活的行；槽位候选一律排除（见 src/providers/parked.ts）。 */
  parked?: boolean
  /** 这行的默认来源（后端声明在 PROVIDER_DEFAULT_SOURCE）：「添加来源」直接开它的配置面，
   *  不必先在几百个源的目录里翻。缺席 = 这行没有正解，照旧走目录。 */
  defaultSource?: SourceSummary
}

export type ProviderCallsiteView = {
  id: string
  label: string
  description: string
  category: ProviderCategory
  mode: 'fixed' | 'dispatch'
  entries: Array<{ id: string; label: string; presenter: string }>
  /** params = 调用点级覆盖（如 llm 调用点的 `model`）。后端 PUT 是**整体替换**：改 providerIds
   *  时不把它原样带回去就等于清空（见 api.setProviderCallsiteBinding 的第 4 参）。 */
  binding: { callsiteId: string; providerIds: string[]; params?: Record<string, unknown> } | null
  providers: Array<{ id: string; label: string }>
}

/** GET /api/presents 的一个槽位——present 里声明的 provider callsite，可被频道级
 *  options.slots 覆盖(见 src/providers/presents.ts PresentSlot)。 */
export interface PresentSlotView {
  callsiteId: string
  label: string
  category: ProviderCategory
  mode: 'fixed' | 'dispatch'
}

/** GET /api/presents 的一个 present（mirrors backend PresentDescriptor）。 */
export interface PresentView {
  id: string
  label: string
  needsStreams: boolean
  data: 'collected' | 'live'
  slots: PresentSlotView[]
}

// —— Netdisk (AList) binding / alignment types (mirrors src/netdisk/types.ts) ——
export type NetdiskEntryStatus = 'auto' | 'pending' | 'confirmed' | 'rejected' | 'unmatched'
export interface NetdiskFingerprint {
  size: number
  duration?: number
}
export interface MappingEntry {
  leftKey: string
  leftTitle: string
  rightFile: string | null
  fingerprint?: NetdiskFingerprint
  confidence?: number
  status: NetdiskEntryStatus
  /** 人工订正标记（= 用户在 UI 选/清过网盘文件的 ground-truth 样本）。存在 ⟺ 规则没配对、人来纠过；
   *  `autoFile` = 首次订正时规则给的（错）答案。mirrors src/netdisk/types.ts。 */
  corrected?: { at: string; autoFile: string | null }
  lastError?: { at: string; message: string }
  /** TMDb 该集播出日期（YYYY-MM-DD）。缺席 = 权威没给，不等于未播出。mirrors src/netdisk/types.ts。 */
  airDate?: string
}
/** 一个匹配阶段（闭集：epnum 集号分桶、title 纯标题、episode-part 复合键；mirrors src/netdisk/types.ts）。 */
export type NetdiskMatchStage =
  | { by: 'epnum'; epNumRegex: string; titleStrip: string[]; threshold: number; margin: number }
  | { by: 'title'; titleStrip: string[]; threshold: number; margin: number }
  | { by: 'episode-part'; keyRegex: string; titleStrip: string[]; threshold: number; margin: number }
/** 匹配规格 v2（有序 stage 管线；AI 离线产出、可读、确定性执行；mirrors src/netdisk/types.ts）。
 *  旧扁平字段仅为读老数据保留。 */
export interface NetdiskMatchSpec {
  version: number
  stages?: NetdiskMatchStage[]
  epNumRegex?: string
  titleStrip?: string[]
  threshold?: number
  margin?: number
  /** 人工覆盖「这条绑定的集要不要人往网盘供货」；缺席 = 自动算（判据见 docs/MATCHING.md）。
   *  整绑定一刀切，**不是** leftKey 列表——订阅流的 leftKey 会随重新采集变。 */
  needsSupply?: boolean
  generatedBy?: string
  generatedAt?: string
}
/** `POST /api/netdisk/mappings/:id/spec/preview` 的回包：候选 + 前后覆盖 + 会动的行 + 与人工订正的
 *  冲突（mirrors src/netdisk/types.ts）。前端今天不打这个端点——写谱的是对话里的模型，走 MCP 的
 *  netdisk_preview_spec / netdisk_apply_spec；这份类型镜像的是仍然活着的 HTTP 契约。 */
export interface NetdiskSpecChange { leftKey: string; title: string; from: string | null; to: string | null }
export interface NetdiskSpecConflict { leftKey: string; title: string; ruleSays: string | null; human: string | null }
export interface NetdiskSpecPreview {
  candidateSpec: NetdiskMatchSpec
  before: NetdiskCoverageReport
  after: NetdiskCoverageReport
  changed: NetdiskSpecChange[]
  correctedConflicts: NetdiskSpecConflict[]
}
/** 覆盖率报告（两向：源缺档 vs 文件孤儿）。 */
export interface NetdiskCoverageReport {
  left: { total: number; matched: number; ambiguous: number; missing: number }
  right: { total: number; matched: number; orphan: number }
  missingEpisodes: number[]
  orphanFiles: string[]
}
export interface MappingSet {
  id: string
  left: { kind: 'playlist'; streamId: string; title: string }
  right: { kind: 'alist-dir'; path: string; boundAt: string }
  rightHistory: Array<{ path: string; unboundAt: string }>
  autoSync: boolean
  lastSyncAt?: string
  entries: MappingEntry[]
  matchSpec?: NetdiskMatchSpec
  coverage?: NetdiskCoverageReport
  /** 追更（spec 2026-09-03-work-follow-loop）。缺席 = 不追（存量绑定 / 电影）。tv 绑定新建时默认开。 */
  follow?: { enabled: boolean; nextCheckAt?: string; lastCheckAt?: string; dryRuns: number }
}
export interface AlistFile {
  name: string
  size: number
  isDir: boolean
}
/** 单个网盘的实时健康：已挂载 / 挂载失效 / 有 cookie 可挂 / 待同步 cookie。 */
export type NetdiskMountStatus = 'mounted' | 'error' | 'cookieReady' | 'noCookie'
/** 挂载 preset（GET /api/netdisk/mounts 的 presets 条目；addition schema 不下发）。 */
export interface NetdiskMountPreset {
  id: string
  label: string
  driver: string
  cookieDomain: string
  mountPath: string
  /** 该域在登录态快照里有没有 cookie。 */
  hasCookie: boolean
  /** 实时健康态（由 AList storage 现状 + hasCookie 推）。 */
  status: NetdiskMountStatus
}
/** GET /api/netdisk/mounts 响应（presets 带实时健康 + AList 可达性）。 */
export interface NetdiskMountsView {
  presets: NetdiskMountPreset[]
  mounts: NetdiskMountEntry[]
  alistReachable: boolean
  /** 本机可用的下载类型：magnet/ed2k 无条件 + AList 上实际挂着的网盘。
   *  影视页「找资源」拿它当过滤允许集。AList 不可达 → 只有 magnet/ed2k。 */
  searchableSourceTypes: VideoSourceType[]
}
/** 一条挂载期望态（settings.alist.mounts 持久化形态）。 */
export interface NetdiskMountEntry {
  presetId: string
  mountPath?: string
}
/** reconcile 执行结果（各桶放 presetId）。 */
export interface NetdiskReconcileResult {
  created: string[]
  healed: string[]
  missingCookie: string[]
  ok: string[]
}

/**
 * GET /api/netdisk/reconcile/streams/:id/authority 的 `stats`：这条订阅的**节目单**长什么样。
 * `needsSupply` = 源站列着但自己放不出来的集数，网盘入口就靠它答「该用整理还是该挂载」。
 * 别拿 `/api/items` 数——那条路上挂着播放投影（付费集没配上时音频被换成封面图）。
 */
export interface AuthorityStats {
  entries: number
  paid: number
  withDuration: number
  needsSupply: number
}

// —— 归档器「整理」面板（spec §4）：GET config / POST :show/preview / POST :show/execute / POST decisions ——
/** GET /api/netdisk/reconcile/config 里的一条 show。 */
export interface ReconcileShowConfig {
  id: string
  label: string
  bindingId: string
  sourceDirs: string[]
  /** 货架地址——**不在整理配置里存**（spec §6 P8），后端每次现解后随 GET 一起下发：
   *  `claimed` = 绑定的落地目录（认领的文件落这儿），`secondary` = 该订阅那条「下架 stream」扫的
   *  目录（下架集本身就是一条扫网盘的 stream）；影视绑定没有第二货架，那一格缺席。
   *  解不出来时为 null，原因在 `shelvesProblem`。
   *  **只读**：PUT 回去也会被后端剥掉，改地址要去各自的真相源改。 */
  shelves?: { claimed: string; secondary?: string } | null
  /** 货架解不出来/不能用的原因（缺绑定、没有下架 stream、地址撞了来源目录）。原文呈现给用户，
   *  它就是"该去补哪一样东西"的指路。 */
  shelvesProblem?: string
  subShows: { name: string; dir: string; numPattern: string }[]
  autoExecute: boolean
  /** 认集规则显式覆盖（逐字段替换，非合并）——镜像后端形状。UI 今天只 GET，但若以后加
   *  PUT-from-UI 的编辑流程，漏了这个字段会在往返时把后端已存的覆盖悄悄丢掉、拿默认规则
   *  顶替，必须原样带回。 */
  identity?: { titleStrip?: string[]; epNumRegex?: string }
}
/** POST /api/netdisk/reconcile/:show/preview 里一条 plan action
 *  （move/delete-dup/delete-loser/delete-redundant/replace/pending）。
 *  `key` 是集身份键（`makeIdentity()` 产出，后端算好附上）——待定行「豁免」必须传它,不是文件名。 */
export interface ReconcilePlanAction {
  kind: 'move' | 'rename' | 'delete-dup' | 'delete-loser' | 'delete-redundant' | 'replace' | 'pending'
  key: string
  /**
   * 这条建议**是怎么来的**（后端 `DecisionOrigin`，机器可读）：
   *  · `authority` **从清单出发**——某一集去清单里找自己的文件（"哪个文件是我？"）；
   *  · `file` **从网盘文件出发**——没有任何一集认领这份文件，只能从它自己的证据边反推（"我该怎么办？"）。
   *
   * 两者在产品语义上是两件事（尤其"要你决定"那一档：集侧问"是不是这一集"、文件侧问"到底是哪一集"），
   * 卡片上必须一眼可分。**只认这个字段，绝不从 `basis` 前缀或中文 `reason` 里推**——那是把
   * 展示字段当协议用，后端文案一改前端就静默错位。老后端没有它 → 整格不显示，绝不猜。
   */
  origin?: 'authority' | 'file'
  src: { path: string; name: string; size: number; durationS?: number }
  dstDir?: string
  dupOf?: string
  /** `delete-loser` 专属：同集留下的那份的路径——"删这份、留那份"里的那份。
   *  `delete-redundant` **没有**这一项：留下的那份不是文件，是源站自己（那一集它放得出），
   *  所以那一类只渲染"删这一份"，别去找不存在的另一半。 */
  keptPath?: string
  /** `replace` 专属：**被删掉**的那份（旧正主）的路径。这一类里 `src` 是留下来的那份——和
   *  `delete-loser` 正好相反，渲染"删哪个/留哪个"时别把两者当同一种形状。 */
  oldPath?: string
  /** `move`/`replace`/`rename` 落地的新文件名（只加 `SxxExx - ` 编号前缀）。
   *  `move`/`replace` 缺席 = 原名不变；`rename` 恒有值——那一类的落点本来就是"原地改名"。 */
  newName?: string
  basis?: string
  reason?: string
  /** 这一条说的是哪一集（节目单里的集名）——`move` 的"凭什么"，删除/替换行的抬头。
   *  取不到时缺席（第二货架择优的 `delete-loser`、名字不在清单里的 `delete-dup`）：
   *  UI 退化成"动作标签 + 作品名"，**不许拿文件名冒充集名**。 */
  episode?: string
  /**
   * `delete-redundant` 里**没人认领**那一半专属（`basis` = `redundant-free-candidates:<keys>`）：
   * 那串 leftKey 各自对应的**集名**，与 `basis` 逐位对齐。删它的全部依据就是"这几集源站自己都
   * 放得出"——卡片不说出那几集是谁，用户手里只剩一个文件名（活体 2026-08-02：卡上只有
   * `37.申与酉`，用户据此以为付费判断错了）。
   *
   * **它是候选不是结论**：一份文件同时撞上三集时机器并不知道是哪一集，只知道"不论哪一集都该删"。
   * 所以多于一个时**必须全列出来**，措辞不许暗示已经定了是哪一集。认领成立那一条不带它
   * （那条有确定的 `episode`）。
   */
  candidateEpisodes?: string[]
  /** 待定的种类（机器可读,UI 按它分组措辞,绝不解析 reason 字符串）。
   *  `replace` = 第二货架上已有同集身份的一份、两份比不出高下；`swap-hold` = 目标目录有同名文件,
   *  下轮再落位；`no-duration` = 时长还没探到（状态,不是问句）；`suspect-dir` = 目录疑似认错；
   *  `duration-collision` = 时长撞上某一集但名字完全不沾,不足以判定是同一集（问的是"这是不是那
   *  一集",不是"这两份留哪个"）；`evidence-conflict` = 证据指向**好几个**集、没有规则敢裁
   *  （问的是"它到底属于哪一集"——连该问哪一集都还没定,所以没有 `episode` 抬头）；
   *  `season-unresolved` = 这份文件所在的文件夹判不出属于哪一季,它整段没进过匹配器（状态,不是
   *  问句,但出路只有人：给文件夹起个带季号的名字,或把文件挪进 `S<nn>/`）。 */
  pendingKind?: 'replace' | 'no-duration' | 'swap-hold' | 'suspect-dir' | 'duration-collision' | 'evidence-conflict' | 'season-unresolved'
  /** `duration-collision` 专属：撞上的是哪一集（`leftKey`）。点「不是这一集 → 挪去下架」时连同
   *  `src.path` 原样回传给 decisions 端点——**前端不许自己拼那个组合键**（同 `key` 那条）。 */
  collidesWith?: string
  /** `evidence-conflict` 专属：**全部**相争的那几集（`leftKey`,按证据分量降序）。点
   *  「都不是这一集 → 挪去下架」时逐个连同 `src.path` 回传——**必须一个不落**,少一个下一轮
   *  这张卡还在（后端要求每一对都答过才放行）。同样不许前端自己拼组合键。 */
  conflictsWith?: string[]
  /**
   * `swap-hold` 专属：**占着那个位置的那份文件的完整路径**。
   *
   * UI 拿它去和**本轮其他动作**对上号，把「删掉这份 → 等位那份随即搬入」这句因果说出来。
   * 以前这层关系只存在于后端代码里：界面上「可以自动完成」与「等下一轮自然落位」各摆各的，
   * 第一块执行完第三块就自动落位，而两块之间一个字没提。
   *
   * **是路径不是文件名**：同名文件可以躺在不同目录，名字对名字必然错配。
   * 缺席（老后端）→ 对不上号，那一条按"卡住了"处理（进「要你决定」），绝不静默丢掉。
   */
  blockedBy?: string
  /** 「这几份留哪个」的并排对照（`replace` 动作与 `replace` 待定共用）。
   *  `authorityDurationS` 缺席 = 节目单没给时长,裁判不在场 → 只列数据,不标对错。
   *  设计见 `docs/superpowers/specs/2026-07-30-duplicate-episode-decision-design.md` §4。 */
  compare?: {
    authorityDurationS?: number
    candidates: { path: string; size: number; durationS?: number; inLib: boolean }[]
  }
}
export interface ReconcilePreview {
  plan: ReconcilePlanAction[]
  counts: {
    move: number; deleteDup: number; deleteLoser: number; replace: number; pending: number
    moveClaimed: number; moveSecondary: number
    /** 免费集副本判删（`delete-redundant`）。老后端没有这个字段 → `undefined`，别当 0 用。 */
    deleteRedundant?: number
    /** 只加编号前缀的原地改名数（`rename`）。老后端没有这个字段 → `undefined`，别当 0 用。 */
    rename?: number
    /**
     * 搬进纯享货架（`<认领货架>/纯享/S<nn>`，季模式专属）的份数。它是 `move` 的一格，
     * **不在 `moveClaimed` 里**——那个目录住在认领货架里面，但装的不是剧集。
     * 老后端没有这个字段 → `undefined`，别当 0 用。
     */
    movePureCut?: number
  }
  /** 本轮两个货架的地址（后端现解）。清单里每一行都要说清"删的是库里那份还是来源那份"，
   *  判据就是路径前缀——只有后端知道货架在哪。老后端没有这个字段时徽标整格不显示，别猜。 */
  shelves?: { claimed: string; secondary?: string }
  /** 本轮扫的来源目录（原地模式下为空数组：一切都在库里）。 */
  sourceDirs?: string[]
  /** 本轮运行账（后端每次 preview/execute 都落一条并原样下发）。`errors` 是探测/AList 失败的行——
   *  「错误是行，不是日志」，UI 要原样列出来，不要吞掉。 */
  ledger?: ReconcileRunLedger
}
/** 运行账（reconcile_runs 一行）。`counts` 仍不在这里声明（后端审计用的全量，UI 不消费）；
 *  `rows` 补了，因为**判决书（`explain`）挂在行上**，证据卡按路径去这两处取。 */
export interface ReconcileRunLedger {
  runId: string
  at?: string
  conservation?: boolean
  errors?: { path?: string; stage: 'probe' | 'move' | 'rename' | 'delete' | 'rmdir'; detail: string }[]
  /** 本轮主池每个文件一行（含无动作的）。 */
  rows?: ReconcileLedgerRow[]
  /** 下架货架复核那一趟的行（独立小节，不并进 `rows`）。它们的 `explain` 来自复核自己那张证据图。 */
  secondaryReview?: { checked: number; rows: ReconcileLedgerRow[] }
}
/** 账本一行（镜像后端 `LedgerRow`）。UI 只消费 `path` + `explain`，其余字段照抄形状备查。 */
export interface ReconcileLedgerRow {
  path: string
  size: number
  durationS?: number
  verdict: 'claimed' | 'offline' | 'copy' | 'hold' | 'dup' | 'exempt'
  episode?: string
  basis: string
  /** 这一行是从哪一侧推出来的（同 `ReconcilePlanAction.origin`）。老账本行没有它。 */
  origin?: 'authority' | 'file'
  action: string
  /** **缺席是常态**——老账本行没有它；豁免/字节全等那两档跑在匹配器之前，压根没进过证据图。 */
  explain?: RowExplain
}

// —— 判决书（hover card 证据卡）：镜像后端 `src/netdisk/match-engine/`（explain.ts / types.ts）——
//
// **后端是唯一真相源，前端不许自算、不许补算**（与 `identity` 覆盖字段同一条约定）：这几个类型
// 存在的意义就是把裁决层真正用过的那份证据原样端到界面上。前端一旦自己算一遍相似度、自己推一句
// "所以它不是这一集"，界面说的话和机器判的事就成了两张皮——上一次事故的形状正是如此
// （`no-duration-hit` 那句"时长和名字都对不上任何一集"在 05 案里是假话）。
// 老账本行/豁免行没有 `explain` 是**合法状态**：那时不渲染 ⓘ，不补一个出来。

/** 一条证据边上的事实。`kind` 是闭集，与后端 `Fact` 逐字对齐。 */
export type MatchFact =
  /** 名字：`identity-exact` = 两侧清洗后逐字相同（`score` 恒 1）；`sim` = bigram Dice。 */
  | { kind: 'name'; method: 'identity-exact' | 'sim'; score: number; cleanedLeft: string; cleanedRight: string; stripId: string }
  /** 结构键：两侧读出了同一个键值才有这条事实。 */
  | { kind: 'struct-key'; key: 'season-episode' | 'episode-part' | 'epnum'; value: string }
  /** 时长：`hit` = 在容差内；`contradict` = 差出量级（错身文件）。中间那一段不产事实。 */
  | { kind: 'duration'; state: 'hit' | 'contradict'; deltaS: number; toleranceS: number }
  /** 文件↔文件：与 `peerPath` 同字节数且时长相同或同缺 = 同一份内容的另一拷贝。 */
  | { kind: 'byte-identity'; peerPath: string }

/** 边的结局。`informational` 只给不可裁决的事实（如与本集无关的字节孪生）。 */
export type MatchEdgeOutcome = 'won' | 'vetoed' | 'informational'

/**
 * 被否决的理由。**闭集**——人话映射（`reconcile-evidence-card.tsx` 的 `VETO_TEXT`）按它维护，
 * 缺映射 = 界面露原始码 + 测试红（宁可露码，不许编话）。后端加了新值、前端没跟上时，
 * 同步这份镜像的那一刻测试就会变红。
 */
export type MatchVetoReason =
  | 'duration-contradict'
  | 'name-floor'
  | 'zero-competition-loser'
  | 'below-threshold'
  | 'no-margin'
  | 'left-claimed'
  | 'file-claimed'
  | 'quality-dedup'
  | 'no-adjudicable-fact'
  | 'unevaluated'

export interface ExplainEdge {
  episode: { leftKey: string; title: string; durationS?: number; paid?: boolean }
  /** 原样，不加工。 */
  facts: MatchFact[]
  outcome: MatchEdgeOutcome
  /** 被否决的边**必带**理由。 */
  vetoReason?: MatchVetoReason
  /** 定这条边结局的规则编号。 */
  rule?: string
}

/** 一行的证据卡数据（镜像后端 `RowExplain`）。 */
export interface RowExplain {
  /** `kbps` 后端现算（size×8÷时长）——**前端不重算**，两个数分家就会各说各话。 */
  file: { path: string; sizeBytes: number; durationS?: number; kbps?: number }
  /** 按强度降序，上限 8 条。 */
  edges: ExplainEdge[]
  /** 没列进来的边数（够不着展示门槛的 + 超出上限截掉的）。0 时字段缺席。 */
  truncatedCount?: number
  verdict: {
    /** 命中的裁决规则编号（`R4` 等）。**残差没有规则**，那时字段缺席——不许编一个出来。 */
    rule?: string
    disposition: 'claimed' | 'copy' | 'asked' | 'residual'
    /** 门槛对照：命中值 vs 阈值。 */
    thresholds?: Record<string, { got: number; need: number }>
  }
}
/** 「AI 建议 vs 人最终选择」的一行（镜像后端 `SuggestionRow`）。 */
export interface SuggestionView {
  id: string
  at: number
  path: string
  verdict: 'is-episode' | 'none-of-these' | 'unsure' | 'failed'
  leftKey?: string
  quotes: number
  candidates: string[]
  answeredAt?: number
  humanVerdict?: 'is-episode' | 'not-episode'
  humanLeftKey?: string
}

/** 四格**互斥且穷尽**，相加 = `countable`。别只显示 `agreed`/`countable` 两个数——
 *  那样"人答了但没法比"和"还没人答"会被并进同一个分母，一致率就虚高了。 */
export interface AgreementCounts {
  countable: number
  agreed: number
  disagreed: number
  inconclusive: number
  open: number
}

/** 全表汇总（**不跟着筛选/分页变**）。`total` 含 unsure/判读失败/无引文那些，它们不进 `countable`。 */
export interface SuggestionSummary extends AgreementCounts {
  total: number
  byKind: Record<'is-episode' | 'none-of-these', AgreementCounts>
}

/** POST …/execute 的返回：真动了多少 + 逐条错误（原样呈现，别汇总成「N 条出错」就完事）。 */
export interface ReconcileExecResult {
  moved: number
  /** 只加编号前缀的原地改名数（`rename`）。老后端没有这个字段 → `undefined`，别当 0 用。 */
  renamed?: number
  deleted: number
  pending: number
  /** 本轮搬空后清掉的分享子目录数。老后端没有这个字段 → `undefined`，别当 0 用。 */
  removedDirs?: number
  /** 这一轮的溯源 run id——`undoRun` 要传它。老后端没有这个字段 → 撤销按钮不该出现。 */
  runId?: string
  errors: string[]
  ledger?: ReconcileRunLedger
}

/** 一部作品的网盘绑定视图（GET /api/video/works/:key 的 `binding` 字段）。
 *  `ref` 为 null = **还不能绑**（canonical 没验出 TMDb 坐标），不是「没绑」——UI 必须分开说。 */
export interface WorkBindingView {
  ref: { id: string; media: 'movie' | 'tv'; title: string; year?: number } | null
  binding?: { id: string; dirPath: string; lastSyncAt?: string
    /** `total` 只数已播出的集；`unaired` 是还没播/未定档的占位数，不在 `total` 里（后端恒给，类型上可选只为夹具省事）。 */
    total: number; matched: number; unaired?: number; playable: WorkPlayable[]; netdiskUrl?: string
    /** 坏绑定标记：目录已从网盘删/移（AList object-not-found）。有值 = 亮出健康态告警。 */
    broken?: { at: string; message: string }
    /** 追更状态（spec 2026-09-03-work-follow-loop）。缺席 = 不追（存量绑定 / 电影）。 */
    follow?: { enabled: boolean; nextCheckAt?: string; lastCheckAt?: string; dryRuns: number } }
}

/** GET /api/netdisk/mappings/:id/follow 的响应——追更状态行铺开后的详情（缺集数 / 来源分享 / 最近几轮）。 */
export interface FollowView {
  follow?: { enabled: boolean; nextCheckAt?: string; lastCheckAt?: string; dryRuns: number }
  /** 已播但没配上文件的集（按 leftKey 或集标识，后端定形）。 */
  missingAired: string[]
  /** 还没播出的集数（不算缺）。 */
  upcoming: number
  shares: Array<{
    pwdId: string
    netdisk: string
    origin: 'manual' | 'search'
    validity?: 'alive' | 'not-usable' | 'needs-login' | 'unknown'
    lastCheck?: string
  }>
  runs: FollowRunRecord[]
}

/** 一轮追更运行的记录（scheduled 或 manual 触发）。 */
export interface FollowRunRecord {
  id: string
  setId: string
  at: string
  trigger: 'scheduled' | 'manual'
  missingAired: string[]
  revisited: Array<{ pwdId: string; validity: string; newFiles: number; picked: number }>
  searched?: { queries: string[]; hits: number; alive: number; picked: number; failed: number }
  saved: Array<{ pwdId: string; files: string[] }>
  synced: { matchedBefore: number; matchedAfter: number }
  errors: string[]
  /** 这一轮末尾接上的归档结果（spec 2026-09-03-tv-season-archive §5）。缺席 = 这轮没跑归档
   *  （老记录 / 归档被闸）。`gated` 有值时 moved/deleted/renamed 恒为 0——归档整轮没动手。 */
  archived?: { runId: string; moved: number; deleted: number; renamed: number; gated?: string }
}

/** work.binding.playable 的一条：已配上文件、可直接播的条目（电影 1 条）。 */
export interface WorkPlayable { leftKey: string; title: string }

/** 影视片名搜索候选（GET /api/search?scope=video）。点开按 externalIds.tmdb + kind 走 tmdb 详情路由。 */
export interface VideoWorkCandidate {
  title: string
  kind: 'movie' | 'series'
  year?: number
  poster?: string
  externalIds: { tmdb: string; imdb?: string }
  /** 哪些搜索成员命中（去重累加）——现恒 ['tmdb-title-search']。 */
  sources: string[]
  rating?: number
  overview?: string
}

/** 详情页分季分集树的一集（后端 /video-detail 的 `seasons` 字段；仅「真剧集」有，电影/综艺 absent）。
 *  `playable` = 已绑网盘且该集配上了文件（leftKey 直接喂 resolve?key=）。 */
export interface SeasonEpisode { season: number; episode: number; title: string; leftKey: string; playable: boolean; still?: string; airDate?: string }
export interface SeasonGroup { season: number; episodes: SeasonEpisode[] }

// —— voiceprint speaker registry (mirrors backend src/voiceprint/store.ts) ——
export interface VoicePerson {
  id: string
  name: string
  aliases: string[]
}
/** One diarized speaker cluster aggregated from an item's transcript segments.
 *  `personName` is set when the cluster label has already been enrolled to a person
 *  (i.e. it's no longer a raw `SPEAKER_NN` id) — mirrors GET /api/voiceprint/item/:itemId/clusters. */
export interface SpeakerCluster {
  cluster: string
  seconds: number
  sampleAt: number
  personName?: string
  /** 待确认的抽名：自我介绍抽到、但演职员表查无此人（不硬认）。用户点一次「认」→ enroll，
   *  「不认」→ 否决不再问。仅匿名簇可能带此字段（mirrors GET /clusters）。 */
  pending?: { name: string; evidence: string }
}

/** Server-side 「继续观看」row (mirrors backend src/watch-progress-store.ts WatchProgressRow) —
 *  one video's playback position, keyed by its `leftKey` (or inbox item id when unbound). */
export interface WatchProgressRow {
  key: string
  workKey: string
  workTitle: string
  workPoster?: string
  epLabel?: string
  /** 播放发生在哪个视频频道；缺省 = 归属未知（此列上线前写的老行）。 */
  channelId?: string
  position: number
  duration: number
  updatedAt: number
}

// ── Recipe 包市场（/recipes）────────────────────────────────────────────────
// ── 「包」页（GET /api/packages）────────────────────────────────────────────
// 与后端 src/packages/inventory.ts 的 PackageSummary 一一对应。
// 这是**第三个读模型**：/api/plugins 是插件目录 + 它带的 Source，/api/recipes/packages 是
// npm 管理面（只有用户层），这一份是「这台机器上装了什么」——两层全部的包 + 各自的槽位。

/** 一个包填了哪几格。没填的槽位不出现（`recipe×0` 不是一个该被画出来的标记）。 */
export interface PackageSlots {
  sources?: number
  recipes?: number
  /** 那几份 recipe 各叫什么（去 `.recipe.json` 后缀，已排序）。配方行靠它说出「是哪几条」。 */
  recipeNames?: string[]
  code?: true
  /** 能力槽位的入口路径（`stream.capability`）。**和 `code` 不是一回事**：`code` 那格注册
   *  adapter/normalizer，这一格交出一个 `Capability`（工具 + 服务）。两格权限相同。 */
  capability?: string
  /** 这个能力包**此刻**挂在工具面上的动词。数据源是活着的能力宿主，不是包目录。
   *  有 `capability` 却是空数组 = 「声明了能力但没装载/没注册工具」，是一句真话；
   *  `capability` 缺席的包这一格也缺席。 */
  tools?: string[]
  backend?: true
  credentials?: string[]
  /** 这个包的 recipe 声明的 `runtime_config.ref`。定时任务编辑器拿它当「账号存哪一格」的可选项。 */
  config?: string[]
}

export type PackageRuntimeState = 'running' | 'idle' | 'error' | 'unknown'

/** `netdisk-base` = 宿主的网盘底座（挂载 + 绑定配置住在它的配置面板里）。 */
export type PackageRole = 'netdisk-base'

export interface PackageSummary {
  id: string
  name: string
  description?: string
  layer: 'builtin' | 'user'
  pkgName?: string
  version?: string
  slots: PackageSlots
  /** 分段判据：有容器或要凭证 = 宿主在替它跑东西 = 会在运行时坏。 */
  hosted: boolean
  /** 包在宿主里扮演的角色（后端判，`src/netdisk/base-package.ts`）。前端按它分支，**不按包 id**。 */
  role?: PackageRole
  /** 只有填了插件槽位的包才有可翻的开关。 */
  enabled?: boolean
  /** 只有带容器的包才有状态行。 */
  runtime?: { state: PackageRuntimeState; image: string; lastUsed?: number }
  /** 这个包读不动（`package.json` 不合法…），值是原因。有它时 slots 恒空——它照样占一行，
   *  否则用户看不见自己刚装的包，只会以为没装上，去装第二遍。 */
  unreadable?: string
  /** 盘上这份和启动时装载的那份对不上（刚装 / 刚换版 / 刚卸）——见 `PendingChange`。 */
  pending?: PendingChange
}

/** `GET /api/packages/pending` 的一格。与后端 src/packages/pending.ts 的 PendingChange 一一对应。
 *  **不是账本**：后端每次现算「启动时装载的 vs 盘上现在的」，所以重启一落地它就自己消失。
 *  `needsRestart:false` 的（纯 recipe 数据）已经热生效，横幅不数它。 */
export interface PendingChange {
  name: string
  kind: 'installed' | 'updated' | 'removed'
  from?: string
  to?: string
  needsRestart: boolean
  /** 给人看的一句话：为什么要 / 不要重启 */
  why: string
}

/** `POST /api/restart` 的两种非失败结果。409 不是「出错」——它是后端在说「有任务正在跑」，
 *  调用方要拿 `running` 列出来、再给「强制」一个入口，所以不走 ApiError。 */
/** `mode` 是后端按「谁拉起我」判出来的收尾方式（`src/restart/policy.ts`）；前端只展示，不据此分支。 */
export type RestartMode = 'supervised' | 'reexec' | 'watch'
export type RestartBackendResult =
  | { status: 202; mode: RestartMode }
  | { status: 409; running: { id: string; label: string }[] }

/** `GET /api/packages/:id/logs`。truncated = 行数顶到了 tail，上面还有。 */
export interface PackageLogs {
  lines: string[]
  truncated: boolean
}

/** `POST /api/packages/:id/restart`。容器起不来是 200 + state:'error'，不是 5xx——
 *  请求本身成功了（我们确实试过了），失败的是那个容器。 */
export interface PackageRestart {
  state: 'running' | 'error'
  error?: string
}

/** npm 搜索代理返回的一条。后端已把 registry 的返回收窄到这三个字段。 */
export interface RecipePackageSearchHit {
  name: string
  version: string
  description: string
}

/** 已装的一个 recipe 包。sourceIds = 这个包带进来的源 id。 */
export interface InstalledRecipePackage {
  name: string
  version: string
  facility: string
  sourceIds: string[]
  /** 这个包带不带代码入口（`stream.code`）。卸载确认页靠它决定要不要说「重启后才生效」。 */
  hasCode?: boolean
}

/** preview 端点的返回。注意：capabilities/effects 是**包作者自述**，宿主不核实。
 *  rateLimit 是**钳制后**的值（不会超过 builtin 声明），overrides 是这个包将覆盖的内置源 id。
 *  confirm 是 tarball integrity，install 必须原样带回（防 preview 之后包被换掉）。 */
export interface RecipePackagePreview {
  name: string
  version: string
  facility: string
  cookieDomain?: string
  rateLimit?: { burst: number; perMinute: number; perHour?: number; maxWaitMs?: number }
  /** 这个包会让后端替它去连的主机（`stream.serving` 的 match ∪ hosts）。空数组 = 不代理任何东西。
   *  形状与后端 `RecipePackagePreview`（src/replay/recipe-install.ts）一致。 */
  proxies?: string[]
  /** 这个包声明的 Provider 行 id（`stream.providers[].id`）。非空 ⇒ 确认页要说「重启后端后才出现」：
   *  身份表是启动期快照，热装不会建行。后端**恒发**这一格（没有声明就是空数组），所以这里不写 `?`
   *  ——形状与后端 `RecipePackagePreview`（src/replay/recipe-install.ts）一致。 */
  providers: string[]
  recipes: Array<{ id: string; description: string; capabilities: string[]; effects: string[]; params: string[] }>
  overrides: string[]
  /** 这个包带代码时才有：入口 + 它申报会注册的 adapter / normalizer 名。缺席 = 纯数据包。
   *  形状与后端 `RecipePackagePreview`（src/replay/recipe-install.ts）一致。 */
  code?: { entry: string; adapters: string[]; normalizers: string[] }
  /** 这个包填了**能力槽位**（`stream.capability`）时才有：入口 + 拿得到的话它会注册的工具名。
   *  和 `code` 指的是同一个文件、同一种权限（后端进程内、完整权限、可取浏览器登录态），
   *  所以确认页上是同一档——能力包不声明 `stream.code`，只认 `code` 会让它一路静默装上。
   *  `tools` 通常缺席：工具名要 import + mount 之后才知道，而确认发生在那之前。
   *  形状与后端 `RecipePackagePreview`（src/replay/recipe-install.ts）一致。 */
  capability?: { entry: string; tools?: string[] }
  /** 这个包带容器时才有：**钳制后**那份声明的摘要（service 名已由宿主指派、卷已加包前缀、
   *  standby 已兜底）。缺席 = 不跑容器。没有 `gpu` 一格——第三方声明 gpu 一律被拒，
   *  摆一个恒为 false 的字段只会让人以为那是个可能的状态。`env` 只有键名，值不外泄。
   *  形状与后端 `BackendSummary`（src/packages/container-policy.ts）一致。 */
  backend?: {
    image: string
    service: string
    port: number
    mem: string
    volumes: string[]
    envKeys: string[]
    standby: { idleMinutes: number; startTimeoutSeconds?: number }
  }
  /** 这个包申报的凭证域 = 它能取到的登录态边界。包级申报（容器经 broker、代码经 ctx.cookieFor
   *  都吃这一份），所以不在 `backend` 里。缺席 = 一个域都没申报。 */
  credentials?: string[]
  /** 官方 scope 的包从 npm 镜像装、却核不上官方源——值是原因。照装，但按第三方对待（不注入登录态）。 */
  mirrorUnverified?: string
  confirm: string
}

export interface RecipePackageInstallResult {
  dir: string
  version: string
}

/** `GET /api/recipes/packages/updates` 的一项（后端 `RecipeUpdateCandidate`）。`builtin` / `installed`
 *  至少有一格：内置包没装过用户层那份时只有 `builtin`；"当前版"= `installed ?? builtin`
 *  （用户层同名包整包盖住内置那份）。 */
export interface RecipePackageUpdate {
  name: string
  /** 内置层那份的版本（随 CLI 出货的快照）。 */
  builtin?: string
  /** 用户层已装的版本；有它时它才是"当前版"。 */
  installed?: string
  latest: string
}
