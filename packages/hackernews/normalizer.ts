import type { Normalizer } from '../../src/content/normalize.ts'
import { extractLinks, toText } from '../../shared/package-sdk/html.ts'

/** 帖子的 HN id：RSSHub 的 description 里带一条讨论页链接（`item?id=`），没有时退到 guid
 *  （`/best` 路由是 `"<id>"`，更早的 threads 路由是 `"<id>-<评论数>"`）。 */
function storyId(raw: Parameters<Normalizer>[0]): string | undefined {
  const hay = `${String(raw.description ?? '')} ${String(raw.link ?? '')}`
  const fromLink = hay.match(/news\.ycombinator\.com\/item\?id=(\d+)/)?.[1]
  if (fromLink) return fromLink
  const guid = raw.guid
  return typeof guid === 'string' || typeof guid === 'number' ? String(guid).match(/^(\d+)/)?.[1] : undefined
}

/**
 * Hacker News 条目的渲染规则（认领 RSSHub 命名空间 `hackernews`）。
 *
 * HN 的条目是「标题 + 几条链接」：description 基本全是 `<a>`，没有正文。归成 `link`，并在
 * `content.enrich` 里写下这条讨论去哪取——前端照它调本包的 `hackernews-comments`，不再认站名。
 * `prefetch: true`：两发站外裸 HTTP，不骑浏览器标签页，可以随列表滚动预取（卡片的摘要 / 首图 /
 * 评论数靠这一步暖出来）。
 */
export const hackernewsNormalizer: Normalizer = (raw) => {
  const desc = String(raw.description ?? '')
  const title = raw.title ? String(raw.title) : undefined
  const id = storyId(raw)
  const enrich = id ? { enrich: { source: 'hackernews-comments', params: { id }, prefetch: true } } : {}

  const links = extractLinks(desc)
  const prose = toText(desc.replace(/<a\b[^>]*>.*?<\/a>/gi, '')).trim()
  if (links.length > 0 && prose.length < 30) {
    return {
      archetype: 'link',
      title,
      text: prose || undefined,
      media: links.map((l) => ({ kind: 'link' as const, url: l.url, title: l.text || l.url })),
      ...enrich,
    }
  }
  return { archetype: 'text', title, text: toText(desc) || undefined, ...enrich }
}
