/**
 * Normalized presentation model — the stable display contract.
 * A normalizer maps a raw source item → Content; the frontend renders by archetype
 * and never re-parses source html. See docs/design/normalization-layer.md.
 */

export type Archetype = 'text' | 'article' | 'video' | 'audio' | 'gallery' | 'link' | 'forward'

export type Media =
  | { kind: 'image'; url: string; thumb?: string; w?: number; h?: number; alt?: string }
  | {
      kind: 'video'
      /** directly-playable video file (including same-origin resolve endpoints) */
      url?: string
      embed?: string
      poster?: string
      duration_s?: number
      page_url?: string
      /** natural pixel dimensions of the SOURCE video, when the source reports them (short-video
       *  platforms usually do). Lets the frame snap to the right orientation (16:9 vs 9:16) on
       *  first paint instead of defaulting to 16:9 and flipping once the poster loads. */
      w?: number
      h?: number
      /** provider + provider-side id for local playback proxy (e.g. provider:'<platform>', vid: 平台侧 id) */
      provider?: string
      vid?: string
      /** true = playback is allowed only through a mapped resolver; absent url means disabled */
      resolveOnly?: boolean
    }
  | {
      kind: 'audio'
      /** directly-playable audio ORIGIN (a podcast RSS enclosure_url). Optional: platform tracks
       *  (platform, track_id) — 由所属包的 facility + recipe 给出 — and paid/resolveOnly episodes carry
       *  only that reference and NO origin — the resolve route is a program concern built by the
       *  reader at play time, never persisted here. Mirrors the `video` variant's optional url +
       *  resolveOnly. */
      url?: string
      poster?: string
      duration_s?: number
      page_url?: string
      /** source platform + id, for the archive join + download — (platform, track_id) 由所属包的 facility + recipe 给出 */
      platform?: string
      track_id?: string
      /** true = no origin-playable url and no resolve Provider: playable ONLY if an external
       *  mapping (netdisk) has it (e.g. a paid podcast episode). The serve layer downgrades such
       *  media to cover-only (→ disabled row) when the mapping has no match, so unmatched paid
       *  episodes render greyed instead of erroring on play. Paid/resolveOnly audio without a match
       *  never sets it either. */
      resolveOnly?: boolean
    }
  | { kind: 'link'; url: string; title?: string; summary?: string; image?: string; platform?: string; track_id?: string; duration_s?: number }

/** Forwarded / quoted content (recursive — forward-of-forward). */
export interface Quoted {
  author?: string
  text?: string
  media?: Media[]
  permalink?: string
  archetype?: Archetype
}

/** Structured film/series metadata for the movie normalizer (video-present channels).
 *  Optional and additive — absent on every non-movie source, so existing normalizers
 *  and renderers are unaffected. Fields are best-effort per ranking route; a card
 *  shows only what was parsed. The normalizers that write it live in the packages that own the
 *  ranking sources (today `packages/rsshub/movie.ts`); the host never enumerates the sites. */
export interface ContentMeta {
  /** rating on a 10-point scale, one decimal, e.g. '8.4' */
  rating?: string
  /** release year, e.g. '2024' */
  year?: string
  genres?: string[]
  /** 评分 / 条目来自哪一家——normalizer 自报的短键，宿主不枚举。 */
  source?: string
  /** `source` 的显示名（卡片徽标、详情页「评分来自谁」）——由 normalizer 给，前端不认识任何一家。 */
  sourceLabel?: string
  /**
   * 「这条是发现源，外部 id 权威（TMDb/OMDb）认不出它时，用我这几格兜住详情页」——由 normalizer
   * 申报（`src/video/discovery-fallback.ts` 只认这一格，不解析任何站的文案）。缺席 = 不兜底。
   */
  discovery?: { runtimeMinutes?: number; directors?: string[]; actors?: string[] }
}

export interface Content {
  archetype: Archetype
  title?: string
  text?: string
  media?: Media[]
  quoted?: Quoted
  /** Movie/series metadata — set only by the movie normalizer. */
  meta?: ContentMeta
  /**
   * 源站说这一条要钱（付费集 / 付费专栏）。**与能不能播无关**——网盘绑定把音频补上之后它
   * 依然是付费集，只是我们手里有了。所以它不能由 `media.resolveOnly`（能不能播的路由标）
   * 倒推：那样一旦补上音频，付费这个事实就凭空消失了。
   * 由 `normalize()` 统一按 raw.price 注入，见那里的契约。
   */
  paid?: boolean
  /**
   * 这条打开时去哪现取剩下的（详情正文 / 图集 / 评论）。由包的 normalizer 写，前端
   * `enrichParamsFor()` **先看它**，有就原样拿去调 `/api/enrich?source=<source>&<params…>`，
   * 没有才落到宿主自己的判据（link / `${provider}-comments`）——
   * 前端从此不用认识任何一个站。
   *
   * 契约：`source` 必须是该包 `package.json#stream.code.enrichers` 里申报的名字之一（裸名，
   * 与 `/api/enrich` 的 `source` 同一套）；`params` 全是字符串（原样进 query）。宿主**不在采集期
   * 校验**——normalizer 是纯函数、跑在 ingest 上，装载期也够不到它的输出；写错 source 的代价是
   * 前端打开时 `/api/enrich` 回 400，响亮不静默。
   *
   * `prefetch: true` = 这次现取便宜（站外裸 HTTP，不骑用户 Chrome 的采集标签页、不扣 facility 的
   * 访问预算）：前端可以随列表滚动预取，并走 HTTP 一问一答。缺省 = 不预取、只在用户真点开时经
   * WS `enrich.open` 现取——多数包的现取要开标签页跑 recipe，随滚动预取就是替用户白访问一次。
   * 这一格只有写 enricher 的包说得清，所以由它申报，前端不按站名猜。
   */
  enrich?: { source: string; params: Record<string, string>; prefetch?: boolean }
}

// —— on-demand enrichment model (the open-time parallel of Content) ——
// A thin item (an HN link with only a title, an xhs homefeed card) is enriched when
// the reader opens it: the linked article's body is extracted and the discussion's
// comments are harvested. Every source normalizes to this one shape so the reader's
// peek (list) and full view (modal) are source-blind. See useEnrichment on the client.

/** Extracted article body for a link item (Defuddle), or a note's own text/media. */
export interface Article {
  sourceUrl: string
  title?: string
  author?: string
  /** ISO-ish publish date string as reported by the page metadata */
  published?: string
  /** sanitized content html (rendered with dangerouslySetInnerHTML) */
  html?: string
  /** plain-text body, when there's no rich html (e.g. an xhs note caption) */
  text?: string
  media?: Media[]
  excerpt?: string
  leadImage?: string
  wordCount?: number
  domain?: string
}

/** A normalized comment. Flat sources (xhs/多数视频平台) leave `replies` empty; threaded
 *  sources (HN) nest. `html` (when present) is sanitized and preferred over `text`. */
export interface Comment {
  id: string
  author?: string
  avatar?: string
  text: string
  html?: string
  like?: number
  /** source labels surfaced as chips, e.g. 'UP' / '置顶' / 'OP' */
  badges?: string[]
  ip?: string
  /** unix seconds */
  time?: number
  replies?: Comment[]
}

export interface Enrichment {
  article?: Article
  comments?: Comment[]
  /** total comment count (may exceed comments.length when paginated/capped) */
  total?: number
  /** opaque cursor to fetch more (source-side next page); null/absent = no more */
  cursor?: string | null
}

/** Minimal item shape used by archive/extraction helpers (structurally compatible with StreamItem). */
export interface Item {
  id: string
  title?: string
  author?: string | { name?: string }
  content?: Content
}
