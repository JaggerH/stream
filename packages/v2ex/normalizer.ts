import type { Normalizer } from '../../src/content/normalize.ts'
import { extractImages, stripImages, toText } from '../../shared/package-sdk/html.ts'

/** 主题 id：条目链接是 `v2ex.com/t/<id>`（可能带 `#replyN`）。 */
function topicId(link: unknown): string | undefined {
  if (typeof link !== 'string') return undefined
  try {
    const u = new URL(link)
    if (!/(^|\.)v2ex\.com$/i.test(u.hostname)) return undefined
    return u.pathname.match(/^\/t\/(\d+)/)?.[1]
  } catch {
    return undefined
  }
}

/**
 * V2EX 主题的渲染规则（认领 RSSHub 命名空间 `v2ex`）。
 *
 * 主题正文就在 feed 的 description 里（带图 → `gallery`，否则 `text`）；回复要打开时现取。
 * 在 `content.enrich` 里写下去哪取——前端照它调本包的 `v2ex-comments`，不再认站名。
 * `prefetch: true`：一发站外裸 HTTP，不骑浏览器标签页，可以随列表滚动预取。
 */
export const v2exNormalizer: Normalizer = (raw) => {
  const desc = String(raw.description ?? '')
  const title = raw.title ? String(raw.title) : undefined
  const id = topicId(raw.link)
  const enrich = id ? { enrich: { source: 'v2ex-comments', params: { id }, prefetch: true } } : {}

  const images = extractImages(desc)
  if (images.length > 0) {
    return { archetype: 'gallery', title, text: toText(stripImages(desc)), media: images, ...enrich }
  }
  return { archetype: 'text', title, text: toText(desc), ...enrich }
}
