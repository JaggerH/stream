/**
 * `inbox_search` —— 读**已经采集进库**的条目（ItemStore），不联网、不触发采集。
 *
 * **为什么它必须是一个独立的工具**：在它之前，工具面上 35 个工具里没有任何一个能列/搜
 * ItemStore（itemStore 只被 `extract` / 出现账按 id `get` 用）。于是「总结时间线里 X 近期的
 * 发言」这类问题只剩两条错路，实测两条都走过（2026-08-19）：`content_search` 是**现搜**
 * （扇出到已配置的可搜索源、结果 ephemeral 不落库），回来的是一堆刚搜到的网页；或者猜源 id
 * 调 `stream_read`，连猜 4 次全是 `Unknown id`，最后 `read_url` 抓整页把上下文撑到 416K token
 * 直接 400。**能力在库里，只是没有门。**
 *
 * **回执是瘦身投影，这是本模块的命脉**：只发 id/stream_id/title/author/timestamp/url/excerpt，
 * 绝不发 `raw`（整份上游 payload）/ `body_html` / `content.media`。一条雪球条目的完整 JSON 约
 * 850 字符，几十条就是一次「回执把对话撑爆」——上面那轮失败的直接原因就是回执体积，所以这层
 * 投影由 `src/mcp/inbox-search.test.ts` 钉死（改回胖回执当场红）。
 */
import type { StoredItem } from '../item-store.ts'
import { planExtract, type Content as PlanContent } from '../../shared/extract/plan.ts'

/** 正文片段的截断长度。截断这件事必须**明写在回执里**（`excerpt_truncated`），否则模型会把
 *  半截正文当全文总结，静默答错、没有一处会喊（AGENTS.md「追到另一端」的同一形状）。 */
export const EXCERPT_LIMIT = 300

/** `inline` 那类条目（正文本来就在条目上，`planExtract` 的 inline 档）用的更宽的上限。
 *
 *  **为什么要分两档**：活体实测（2026-08-19）模型对 8 条纯文本雪球帖连着调了 10 次 `extract`
 *  ——因为回执说"截断了"，而这类条目的全文本就在库里，extract 只是把同一段文字原样再取一遍，
 *  白起 10 个转换任务、多烧一轮上下文。宽到 1000 字，绝大多数帖子一次给全，回执里就能诚实地说
 *  `full_text: true`（别再取了）；真超长的那少数才需要 extract，那时指路才成立。 */
export const INLINE_EXCERPT_LIMIT = 1000

export interface InboxSearchArgs {
  q?: string
  /** stream id，一个或多个（用 `stream_list` 拿 id） */
  stream?: string | string[]
  /** 频道 id：频道就是一组 stream 的视图，这里解析成它的成员 stream 集合 */
  channel?: string
  author?: string
  /** ISO 时间（含端点），按发布时间过滤 */
  since?: string
  until?: string
  limit?: number
  order?: 'asc' | 'desc'
}

export interface InboxHit {
  id: string
  stream_id: string
  title: string
  author?: string
  timestamp: string
  url?: string
  excerpt?: string
  /** true = `excerpt` 只是开头一截，要全文得另取（怎么取看 `full_text`：它为 true 时不必再取） */
  excerpt_truncated?: boolean
  /** true = **正文已经全在 `excerpt` 里，别对这条调 `extract`**。判据是 `planExtract` 的
   *  `inline` 档（正文本来就写在条目上，前端的「转成文字」按钮对这类条目根本不显示）——
   *  对它调 extract 只是把同一段文字原样再取一遍，白起一个转换任务。 */
  full_text?: boolean
}

export interface InboxSearchResult {
  items: InboxHit[]
  /** 本次返回几条 */
  returned: number
  /** 过滤条件下**全部**命中几条（不受 limit 影响）——只有它答得了"还有多少没给你" */
  matched: number
  /** 命中数 > 返回数时的一句人话，直接进模型刚读到的那份数据（AGENTS.md：指令越靠近决策点越有效） */
  note?: string
}

/** 默认返回条数：对话里摊开几十条就成了刷屏，而且回执体积正是上一轮翻车的直接原因。 */
export const DEFAULT_LIMIT = 20
/** 硬上限。调用方给再大也按它截——limit 是模型填的参数，不能指望它自觉。 */
export const MAX_LIMIT = 100

/** 这条条目的正文是不是"本来就在条目上"（`planExtract` 的 `inline` 档）。
 *
 *  **判据借现成那份，不自己造**：`shared/extract/plan.ts` 是「这条 item 的正文该怎么取」的唯一
 *  权威（后端 extract 选分支、前端定按钮显不显示都吃它）。这里再写一个"看着像纯文本"的嗅探，
 *  就是第三份会漂移的判据，而漂移的表现是回执悄悄指错路，没有一处会报错。
 *
 *  `caps` 给全 true 是**故意的**：可用性（后端配没配）与本问题无关——我们只问分支是不是
 *  `inline`，而 inline 分支压根不打后端。给 false 会让某些条目退化成 `branch_unavailable`，
 *  分支字段仍在，但读起来像"这条不能取"，与这里要问的事不是一回事。
 *
 *  `content` 缺席（存量老行还没归一化）时**不下结论**：既不说全文在此，也不指路 extract。 */
function isInline(item: StoredItem): boolean {
  if (!item.content) return false
  return planExtract(item.content as PlanContent, { stt: true, ocr: true, article: true }, item.url).branch === 'inline'
}

/** 一条库里的 item → 瘦身投影。**加字段前先问它会不会把回执撑大**：`raw` / `body_html` /
 *  `content.media` 三样永远不进（守卫测试逐个钉着）。 */
export function projectHit(item: StoredItem): InboxHit {
  const body = item.content?.text ?? item.body_text ?? ''
  const text = body.replace(/\s+/g, ' ').trim()
  const inline = isInline(item)
  const cap = inline ? INLINE_EXCERPT_LIMIT : EXCERPT_LIMIT
  const truncated = text.length > cap
  const hit: InboxHit = {
    id: item.id,
    stream_id: item.stream_id,
    title: item.title,
    timestamp: item.timestamp,
  }
  if (item.author) hit.author = item.author
  if (item.url) hit.url = item.url
  if (text !== '') {
    hit.excerpt = truncated ? text.slice(0, cap) : text
    if (truncated) hit.excerpt_truncated = true
    // 只有"没截断的 inline"才敢说全文在此——inline 但超长时，全文确实还有别的地方（extract 的
    // inline 档），说 full_text 就是骗人。
    if (inline && !truncated) hit.full_text = true
  }
  return hit
}

export interface InboxSearchDeps {
  /** ItemStore.search 那一格（这里只认形状，好让测试不必起一个库） */
  search: (query: {
    streams?: string[]
    author?: string
    q?: string
    since?: string
    until?: string
    limit?: number
    order?: 'asc' | 'desc'
  }) => { items: StoredItem[]; matched: number }
  /** 现有频道的名录（id + 用户看到的名字 + 成员 stream）。**给的是整份名录不是"按 id 查"**：
   *  没有任何一个工具能列频道，只按 id 查就等于逼模型猜一个它无从知道的字符串；有了名录，
   *  这里既能按用户嘴里的名字（「时间线」）认，也能在认不出时把可选项写进回执。 */
  channels: () => Array<{ id: string; label: string; stream_ids: string[] }>
}

/** 用户嘴里的频道 ≈ id 或它显示的名字。顺序：id 精确 → 名字精确 → 名字子串（唯一命中才算）。 */
function matchChannel(
  all: Array<{ id: string; label: string; stream_ids: string[] }>,
  input: string,
): { id: string; label: string; stream_ids: string[] } | undefined {
  const key = input.trim()
  const byId = all.find((c) => c.id === key)
  if (byId) return byId
  const byLabel = all.find((c) => c.label === key)
  if (byLabel) return byLabel
  const loose = all.filter((c) => c.label.includes(key) || c.id.includes(key))
  return loose.length === 1 ? loose[0] : undefined
}

export function runInboxSearch(deps: InboxSearchDeps, args: InboxSearchArgs): InboxSearchResult {
  const limit = Math.min(MAX_LIMIT, Math.max(1, args.limit ?? DEFAULT_LIMIT))
  const explicit = args.stream === undefined ? [] : Array.isArray(args.stream) ? args.stream : [args.stream]
  let streams: string[] | undefined = explicit.length ? explicit : undefined
  if (args.channel !== undefined) {
    const all = deps.channels()
    const channel = matchChannel(all, args.channel)
    // 认不出这个频道时**不能静默当作"没过滤"**——那会把全库当成这个频道回给模型。
    // 回执里直接把可选项列出来：没有任何工具能列频道，只说一句"核对一下"是一条走不通的路。
    if (!channel) {
      return {
        items: [], returned: 0, matched: 0,
        note:
          `没有叫「${args.channel}」的频道。现有频道：${all.map((c) => `${c.label}(${c.id})`).join('、') || '（一个都没有）'}。` +
          '挑一个重来，或者不带 channel 直接搜全库。',
      }
    }
    const members = channel.stream_ids
    if (members.length === 0) {
      return { items: [], returned: 0, matched: 0, note: `频道「${channel.label}」里没有 stream。` }
    }
    streams = streams ? streams.filter((s) => members.includes(s)) : members
    if (streams.length === 0) {
      return { items: [], returned: 0, matched: 0, note: `给定的 stream 都不在频道 ${args.channel} 里。` }
    }
  }
  const { items, matched } = deps.search({
    streams,
    author: args.author,
    q: args.q,
    since: args.since,
    until: args.until,
    limit,
    order: args.order,
  })
  const hits = items.map(projectHit)
  const result: InboxSearchResult = { items: hits, returned: hits.length, matched }
  if (matched > hits.length) {
    result.note =
      `共命中 ${matched} 条，这里只给了最${args.order === 'asc' ? '早' : '新'}的 ${hits.length} 条。` +
      '要更多就调大 limit（上限 100）或收窄 since/until —— 别把没看到的那些当作不存在。'
  }
  return result
}
