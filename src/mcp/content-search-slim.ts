import type { StoredItem } from '../item-store.ts'

/**
 * `content_search` 回执的瘦身层。**只在 MCP 工具边界瘦，不动扇出本体**
 *（`ctx.search.contentSearch`）——HTTP 那条腿（`GET /api/search?scope=content`）是前端在吃，
 * 它要完整条目（媒体清单、body_html、raw 都用来渲染卡片），在扇出里瘦身会静默弄坏搜索页。
 * 同一个能力两个消费方胃口不同，和 `web_search` 的截断落在工具层是同一条道理。
 *
 * 为什么必须瘦：`StoredItem` 原样带着 `raw`（整个源站响应对象，视频站那种还嵌着 `<iframe>` 和
 * 一长串图片 URL）、`body_html` 和 `content.media` 明细。一次搜索几十条 = 几十 KB，实测一轮
 * 对话就把上下文顶到 400K+、直接 400 `Prompt exceeds max length`。模型要判「这条切不切题」
 * 只需要标题/作者/时间/一段正文摘要。
 *
 * **深挖走 `extract`（首选）或 `url` + `read_url`**：现搜结果不落库,但 MCP 边界留了瞬时快照
 *（`search-snapshot.ts`,TTL 内 `extract` 认这里的 `id`）——视频/音频条目只有 extract 深读得进
 * 正片（转写）,read_url 只拿得到标题简介。快照过期后 `url` 仍是兜底深挖入口,所以它不能省。
 */

/** 一次回执最多几条。超出的截掉，并在回执里明写截了多少——不写的话模型会拿一份被悄悄裁过的
 *  结果当全集，静默答错。 */
export const CONTENT_SEARCH_MAX_ITEMS = 20

/** 单条正文摘要的字符上限。 */
export const CONTENT_SEARCH_EXCERPT_CHARS = 400

export interface SlimContentItem {
  id: string
  stream_id: string
  source_id?: string
  /** 社区平台（真实使用体验）还是网页搜索（SEO 居多）——模型据此掂量证据力。 */
  tier: SearchSourceTier
  title: string
  author?: string
  url?: string
  /** 内容自己的发布时间（源站给的）。 */
  timestamp?: string
  /** 我们取到它的时刻。**就是这次调用发生的那一刻**——因为这是现搜，不是读库。 */
  fetched_at: string
  archetype?: string
  /** 截断后的正文摘要；`excerpt_truncated` 为 true 表示后面还有。 */
  excerpt?: string
  excerpt_truncated?: boolean
  /** 有没有可播/可看的媒体（明细不带出来；要看就走 `url`）。 */
  media_count?: number
  /** 首图 URL——只在 `withImage` 档带（price_search 用它把商品图递给选品对比卡）。 */
  image?: string
  paid?: boolean
}

export interface SlimContentSearchResult {
  items: SlimContentItem[]
  /** 命中总数（截断之前）。 */
  total: number
  /** 只在真的截断时出现，说清截掉了多少条。 */
  note?: string
}

function firstText(item: StoredItem): string | undefined {
  const t = item.content?.text ?? item.body_text
  if (typeof t !== 'string') return undefined
  const s = t.trim()
  return s.length > 0 ? s : undefined
}

function slimOne(item: StoredItem, opts: SlimOpts): SlimContentItem {
  const text = firstText(item)
  const truncated = !!text && text.length > CONTENT_SEARCH_EXCERPT_CHARS
  const media = item.content?.media
  // 首图只在显式要的那一档带:content_search 一轮几十条,每条多一串 CDN URL 是纯上下文负担;
  // price_search 则必须带——商品图是选品对比卡的原料,丢在这层下游就无米可炊。
  const image = opts.withImage ? media?.find((m) => m.kind === 'image' && typeof m.url === 'string')?.url : undefined
  return {
    ...(image ? { image } : {}),
    id: item.id,
    stream_id: item.stream_id,
    ...(item.source_id ? { source_id: item.source_id } : {}),
    tier: tierOf(item, opts.isCommunity),
    title: item.title,
    ...(item.author ? { author: item.author } : {}),
    ...(item.url ? { url: item.url } : {}),
    ...(item.timestamp ? { timestamp: item.timestamp } : {}),
    fetched_at: item.fetched_at,
    ...(item.content?.archetype ? { archetype: item.content.archetype } : {}),
    ...(text ? { excerpt: truncated ? text.slice(0, CONTENT_SEARCH_EXCERPT_CHARS) : text } : {}),
    ...(truncated ? { excerpt_truncated: true } : {}),
    ...(media && media.length > 0 ? { media_count: media.length } : {}),
    ...(item.content?.paid ? { paid: true } : {}),
  }
}

export interface SlimOpts {
  /** 带首图 URL（price_search 档）。 */
  withImage?: boolean
  /** 分档谓词，**必填、没有默认值**：给了 `() => false` 的默认，漏传的那个调用点会把全部结果
   *  判成 web 档、排序等于没排，而且没有一处会喊（活体 2026-08-24 撞过同形状的错）。 */
  isCommunity: CommunityPredicate
}

/**
 * 一条搜索结果来自社区平台还是网页搜索。购买尽调靠它分层：社区平台才有真实使用体验的横评，
 * 网页搜索源回来的大头是 SEO 软文——合并序里不分层，网页档快而多，会把社区档顶出截断窗
 * （2026-08-23 活体：前 8 条全是百家号）。
 *
 * **判据来自清单，不来自站名**：一条源的 manifest `categories` 含 `social-media` 就是社区档。
 * 装一个新的社区平台包，它的搜索源写上这个类目就自动进社区档，源码零改动。
 * 判据抽成具名函数：两个消费端（brief 排序、slim 打标）共用，别各写各的。
 */
export type SearchSourceTier = 'community' | 'web'
export type CommunityPredicate = (sourceId: string) => boolean
export interface ManifestLookup { get(id: string): { categories?: string[] } | undefined }

/** registry → 谓词。**每次调用都走 `lookup.get`，不在造它那一刻快照 id 集合**：registry 会
 *  热重载换组，装一个社区平台包之后下一轮搜索就该认它（「装配期取的值 = 冻住的答案」）。
 *  `get` 对裸名有一套四级解析、歧义会抛——抛了就当"不是社区档"，排序层不该因为一条 id
 *  写法不规范而整条搜索炸掉。 */
export function communityByCategory(lookup: ManifestLookup): CommunityPredicate {
  return (sourceId) => {
    try {
      return lookup.get(sourceId)?.categories?.includes('social-media') ?? false
    } catch {
      return false
    }
  }
}

export function searchSourceTier(sourceId: string | undefined, isCommunity: CommunityPredicate): SearchSourceTier {
  return sourceId !== undefined && isCommunity(sourceId) ? 'community' : 'web'
}

/** 一条条目的档位。**必须带 `stream_id` 兜底**：扇出路归一化出的条目源身份写在 `stream_id`
 *  上（`makeStreamItem(sourceId, …)`，`source_id` 缺席）——只读 `source_id` 会把社区源全判成
 *  web（活体 2026-08-24：76 条里 50 条社区命中全部错档，排序等于没排）。扇出条目的
 *  `stream_id` 就是源 id 本身，所以能直接送进 registry 查。 */
export function tierOf(item: Pick<StoredItem, 'source_id' | 'stream_id'>, isCommunity: CommunityPredicate): SearchSourceTier {
  return searchSourceTier(item.source_id ?? item.stream_id, isCommunity)
}

/** 同档内按源轮转交错(round-robin),源内保持各自的相关性序。 */
function interleaveBySource(items: StoredItem[]): StoredItem[] {
  const groups = new Map<string, StoredItem[]>()
  for (const it of items) {
    const key = it.source_id ?? it.stream_id
    const g = groups.get(key)
    if (g) g.push(it)
    else groups.set(key, [it])
  }
  const lists = [...groups.values()]
  const out: StoredItem[] = []
  for (let i = 0; out.length < items.length; i++) for (const list of lists) if (i < list.length) out.push(list[i]!)
  return out
}

/** 把扇出回来的整条 `StoredItem` 压成模型够用的那几格，并封顶条数。
 *
 *  **社区档排序必须发生在封顶之前**：合并序里网页搜索源（快而多）恰好排前，先砍到 20 条
 *  再排序 = 社区条目在进模型视野之前就被截没了——活体（2026-08-24）：扇出 76 条里两个
 *  社区源 40 + 10 条都在，MCP 回执的前 20 条却全是 web 档。
 *
 *  **同档内还要按源轮转交错**：一家 40 条的社区源就能把另一家 10 条整个挤出窗口，而后者
 *  独有的视频横评恰恰是证据密度最高的那类。轮转保证每个源的头部命中都进得了前 20，
 *  源内相对序不动（各源自己的相关性排序保留）。 */
export function slimContentSearchResults(items: readonly StoredItem[], opts: SlimOpts): SlimContentSearchResult {
  const community = interleaveBySource(items.filter((i) => tierOf(i, opts.isCommunity) === 'community'))
  const web = interleaveBySource(items.filter((i) => tierOf(i, opts.isCommunity) === 'web'))
  const ordered = [...community, ...web]
  const kept = ordered.slice(0, CONTENT_SEARCH_MAX_ITEMS)
  const dropped = items.length - kept.length
  return {
    items: kept.map((i) => slimOne(i, opts)),
    total: items.length,
    ...(dropped > 0
      ? {
          note:
            `只列出前 ${kept.length} 条（共 ${items.length} 条，截掉了 ${dropped} 条）。` +
            '要更多就把查询问得更具体，不要原样重发同一个查询。',
        }
      : {}),
  }
}
