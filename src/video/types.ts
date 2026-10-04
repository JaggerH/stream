/**
 * Faceted model for cross-source video/torrent search results.
 *
 * A download option is a point in a multi-dimensional space (quality × source ×
 * episode-coverage × release attrs). The current flat-string list collapses those
 * dimensions; this model keeps them as explicit fields so BOTH consumers can
 * project over them: the human UI renders a fixed projection (quality tabs →
 * episode rows), and the MCP/AI reads the named dimensions directly and filters
 * per the user's question. "Aggregation" is just a choice of grouping dimensions.
 *
 * Cross-source decisions (agreed): unified schema for ALL sources, but NO
 * cross-source entity merge — grouping is per `(source, show, season)`. Stance is
 * passive: one cheap pass, normalize, annotate gaps; completeness is best-effort
 * and never guaranteed (no eager fan-out, no external metadata).
 */

export type Quality = '2160p' | '1080p' | '720p' | 'sd' | 'unknown'

/** Where the download lives — magnet/torrent vs a netdisk share. */
export type SourceType = 'magnet' | 'ed2k' | 'quark' | 'baidu' | 'aliyun' | 'unknown'

/** Episode coverage of a single release. `total` (when known, from a "全N集"
 *  label) is the season's episode count — the denominator for gap detection. */
export type Coverage =
  | { kind: 'pack'; from: number; to: number; total: number | null }
  | { kind: 'complete' } // whole season / movie, episodes not enumerable (Sxx COMPLETE, "全集")
  | { kind: 'single'; episode: number }
  | { kind: 'range'; from: number; to: number }
  | { kind: 'unknown' } // unparseable

/** One downloadable option = one point in the faceted space. */
export interface Release {
  /** 展示键（源元数据的 `key`，见 `src/search/seeds.ts`）；查不到元数据时是源 id。 */
  source: string
  title: string // raw title — display + fallback when facets are uncertain
  /** original full message text (pansou) — file lists/notes the one-line title
   *  drops; shown verbatim when present. */
  content?: string
  /** preview/cover image URLs (pansou messages often carry poster images) */
  images?: string[]
  /** 出处频道名（源给的通用字段 `channel`，如盘搜命中的频道） */
  channel?: string
  /** 出处频道页 URL（源给的通用字段 `channel_url`）——前端直接链它，不自己拼 */
  channelUrl?: string
  /** 没有频道时的出处名（源给的通用字段 `provider`）——来源标签 */
  provider?: string
  /** 这一条的出处 URL（源给的通用字段 `origin`） */
  origin?: string
  quality: Quality
  sourceType: SourceType
  coverage: Coverage
  codec?: string // 'H265' | 'H264' | …
  hdr?: string // 'HDR' | 'DV' | 'HDR+DV'
  group?: string // release group: BlackTV / FLUX / NHTFS
  sizeBytes?: number
  /** magnet/ed2k/netdisk url, OR a resolvable page url when the magnet is fetched
   *  lazily (see `needsResolve`). */
  link: string
  /** netdisk extraction code (提取码), when the share needs one (pansou results) */
  password?: string
  /** finer netdisk label for display when `sourceType` collapses to 'unknown'
   *  (天翼/UC/迅雷/123/115 — drives the store's SourceType never modeled). Set by the
   *  content parser layer; purely cosmetic, verify/save still gate on sourceType. */
  netdiskLabel?: string
  /** all netdisk shares on one pansou message (a message can carry many) — each a
   *  typed link + its 提取码. `link`/`sourceType`/`password` mirror the first. `desc` pairs a
   *  link with its own description (SUPERSET, provider-composition change): the expand/btbtla
   *  assembler fills it with the download row's raw title; pansou leaves it empty (the pairing
   *  lives in `content`, left to a downstream parsing tool). */
  links?: Array<{ url: string; type: SourceType; password?: string; desc?: string }>
  /** true when `link` is a page that must be fetched to get the actual magnet
   *  (btbtla resolves magnets lazily to avoid N fetches per show). */
  needsResolve?: boolean
  /** facets parsed from the title (fuzzy) vs taken from a native field (reliable,
   *  e.g. btbtla's quality tab). The AI uses this to weigh confidence. */
  parsed: boolean
}

/** Derived per-(show, season, quality) coverage — computed over releases, not a
 *  source field. Makes 缺集 first-class for both consumers. */
export interface CoverageSummary {
  total: number | null // denominator from a "全N集" pack label; null = unknown
  episodes: number[] // distinct covered episode numbers (packs expand to their range ∪ singles)
  missing: number[] // total != null ? (1..total) − episodes : []  (empty when total unknown)
  hasPack: boolean
}

export interface QualityBucket {
  quality: Quality
  releases: Release[]
  coverage: CoverageSummary
}

/** A show+season group within ONE source (no cross-source merge). */
export interface ShowSeason {
  source: string
  title: string // display name (e.g. "上载新生 第三季")
  /** source detail page for this season (for the preview iframe); null if none */
  pageUrl?: string
  /** cover/poster image for this season (btbtla search-page thumbnail); none if absent */
  image?: string
  season: number | null
  /** season episode count (denominator for 缺集) — from a "全N集" pack in ANY
   *  quality of this season; null when no pack advertises it. Season-level, not
   *  per-quality: a pack covers 1..N so gaps only show in OTHER qualities. */
  total: number | null
  qualities: QualityBucket[]
}

/** Top-level aggregated result — replaces the old flat `Item[]`. */
export interface VideoSearchResult {
  /** structured groups (sources that expose show/season structure, e.g. btbtla) */
  shows: ShowSeason[]
  /** releases that don't group into a show/season (movies, unparseable) — flat */
  loose: Release[]
  /** per-source timing for the UI panel (unchanged contract) */
  sources: VideoSourceTiming[]
}

export interface VideoSourceTiming {
  /** stable source slug — matches Release.source / ShowSeason.source */
  key: string
  label: string
  ms: number
  count: number
  /** 跨源去重丢掉的 release 数。count=0 && dropped>0 = 「全是重复」，不是「无结果」——
   *  没有这个字段，一个全是重复的源会谎报成 status:'empty'。 */
  dropped: number
  status: 'ok' | 'empty' | 'error' | 'timeout'
}

/** Static per-source metadata sent up front so the UI can render source badges
 *  (friendly label + click-through to the source's search page) before timings
 *  arrive. `searchUrl` is the source's search page for the current query;
 *  undefined for sources with no public search page (e.g. 盘搜, API-only). */
export interface VideoSourceMeta {
  key: string
  label: string
  searchUrl?: string
}

/** A part = one source's aggregated output. */
export interface VideoPart {
  shows: ShowSeason[]
  loose: Release[]
}

/** Streamed search protocol (NDJSON): init (source list) → one `source` per
 *  source as it completes (in completion order) → done. */
export type VideoSearchEvent =
  | { type: 'init'; sources: VideoSourceMeta[] }
  | { type: 'source'; key: string; part: VideoPart; timing: VideoSourceTiming }
  | { type: 'done' }

/** A provider-neutral key derived from the Stream's already-ingested video facts.
 *  Detail Providers enrich this identity; they never replace the Stream's links,
 *  episodes, or local-media facts. */
export interface VideoLookupIdentity {
  title: string
  aliases?: string[]
  year?: number
  kind?: 'movie' | 'series' | 'season' | 'episode' | 'unknown'
  season?: number
  episode?: number
  /** Discovery cover used only to disambiguate canonical authority candidates. */
  poster?: string
  sourceUrl?: string
  externalIds: Record<string, string>
  people?: Array<{ name: string; role: 'director' | 'actor' }>
}

/** Facts emitted by a discovery Source about the work it links to. This is not an authority
 * mapping: a resolver must verify these facts before it writes canonical external IDs. */
export interface VideoReference {
  title: string
  aliases?: string[]
  people?: Array<{ name: string; role: 'director' | 'actor' }>
  year?: number
  kind?: VideoLookupIdentity['kind']
  poster?: string
  sourceUrl?: string
  externalIds?: Record<string, string>
}

/** A title-search candidate: an unverified work reference (a `VideoReference`) plus which search
 *  member(s) surfaced it and display-only projections. `/api/search?scope=video` dedups the
 *  Provider-row members' outputs into these; opening one navigates to the existing detail via
 *  `/api/video/works/tmdb:<media>:<id>` (its `externalIds.tmdb` + `kind`). */
export interface VideoWorkCandidate extends VideoReference {
  /** discovering member keys (deduped hits accumulate), e.g. `['tmdb']`. */
  sources: string[]
  /** TMDb vote_average, display-only. */
  rating?: number
  /** short synopsis, display + detail-miss fallback. */
  overview?: string
}

export interface VideoPerson {
  name: string
  role: 'actor' | 'director' | 'writer' | 'creator' | 'producer' | 'other'
  character?: string
  image?: string
}

export interface VideoRating {
  source: string
  value: number
  scale: number
  votes?: number
}

/** Normalized scalar and collection fields returned by one metadata Source. */
export interface VideoMetadataResult {
  source: string
  title?: string
  originalTitle?: string
  releaseDate?: string
  year?: number
  runtimeMinutes?: number
  certification?: string
  overview?: string
  tagline?: string
  genres?: string[]
  tags?: string[]
  people?: VideoPerson[]
  ratings?: VideoRating[]
  externalIds: Record<string, string>
}

/** One authority candidate's best cover-similarity score, kept as resolver evidence.
 *  `score` is null when no candidate cover could be downloaded or decoded. */
export interface VideoPosterCandidateScore {
  tmdbId: string
  title?: string
  /** Covers actually compared for this candidate (a candidate with none scores null). */
  compared: number
  score: number | null
}

/** Why a cover-similarity decision went the way it did. Cover matching is the sole admission
 *  rule for a discovery row that carries a cover, so the scores behind it are retained: an
 *  operator debugging a wrong or missing mapping needs the losing scores, not just the winner. */
export interface VideoPosterMatch {
  threshold: number
  minMargin: number
  score: number
  runnerUp?: number
  candidates: VideoPosterCandidateScore[]
}

/** Which rung of the resolver's ladder admitted this identity. Debugging a wrong mapping starts
 *  with "which evidence was trusted", not with the score — a title-year match and a cover match
 *  fail for entirely different reasons. */
export type VideoCanonicalMatchedBy = 'id' | 'title-year' | 'title-unique' | 'poster'

/** Authority-verified identity established before detail enrichment. */
export interface VideoCanonicalResult {
  source: string
  externalIds: Record<string, string>
  kind?: VideoLookupIdentity['kind']
  title?: string
  year?: number
  matchedBy?: VideoCanonicalMatchedBy
  /** Present only when cover similarity decided it (`matchedBy: 'poster'`). */
  posterMatch?: VideoPosterMatch
}

/** Resolver provenance is retained so a detail miss is distinguishable from an unrequested lookup. */
export type VideoCanonicalDiagnostic =
  | ({ status: 'resolved'; provider: string; member: string } & VideoCanonicalResult)
  | { status: 'miss'; provider: string }

export type VideoImageKind = 'poster' | 'backdrop' | 'logo'

export interface VideoImageCandidate {
  kind: VideoImageKind
  url: string
  language?: string
  width?: number
  height?: number
  source?: string
}

/** Normalized image candidates returned by one image Source. */
export interface VideoImageResult {
  source: string
  images: VideoImageCandidate[]
}

/** A safe, structured account of one Source failure during an enriched lookup. */
export interface VideoProviderFailure {
  provider: string
  member: string
  phase: 'lookup' | 'normalize' | 'cache'
  message: string
}

/** Cached, deterministically merged detail Provider data. */
export interface VideoDetail {
  cacheKey: string
  identity: VideoLookupIdentity
  canonical?: VideoCanonicalDiagnostic
  metadata?: VideoMetadataResult
  images: Partial<Record<VideoImageKind, VideoImageCandidate>>
  imageCandidates: VideoImageCandidate[]
  failures: VideoProviderFailure[]
  fetchedAt: string
  expiresAt: string
  /**
   * TMDb 权威分集索引（投影后，仅剧集）—— 详情页分季分集的懒加载缓存。
   *
   * 硬约束（`2026-07-17-tmdb-left-binding` §4 的成本红线在此仍生效）：只存投影后的
   * `{leftKey, title}`，**绝不存 overview / still_path / crew**（那 1MB 是唯一会让开销失控的东西）；
   * 只在 `media='tv'` 且未绑网盘时按需填充，命中不重抓。已绑走 `MappingSet.entries`，不读它。
   */
  episodeIndex?: { fetchedAt: string; entries: Array<{ leftKey: string; title: string; still?: string; airDate?: string }> }
}
