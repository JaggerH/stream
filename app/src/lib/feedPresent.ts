// Presentation-only helpers for rendering a feed item: summary text, media
// previews, and small formatters. Shared by the timeline card (components/feed)
// and the artifact detail panel; no React, no state (triggerDownload 是唯一碰 DOM 的例外)。
import { imgUrl, LOCAL } from './api.ts'
import type { Item as StreamItem, Media } from './types.ts'
import { planVideo, type VideoMedia } from './videoPlan.ts'

export function videoDownloadUrl(media: VideoMedia | undefined, baseUrl: string, name: string): string {
  if (!media) return ''
  const plan = planVideo(media, baseUrl)
  const base = plan.kind === 'file' ? plan.src : plan.kind === 'dash' ? plan.progressiveUrl : ''
  return base ? `${base}${base.includes('?') ? '&' : '?'}dl=1&name=${encodeURIComponent(name)}` : ''
}

/** 触发一次浏览器下载。放在 URL 构造器旁边，是因为「拿到 videoDl 就得有人去点它」——
 *  列表行和全屏 Detail 现在都要下载同一条视频，各自写一份 <a>.click() 只会漂。 */
export function triggerDownload(href: string) {
  const a = document.createElement('a')
  a.href = href
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function itemSummary(
  item: StreamItem,
  article?: { excerpt?: string; html?: string; text?: string } | null
): string {
  const articleSummary =
    article?.excerpt ||
    article?.text ||
    article?.html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ||
    ''
  if (articleSummary) return articleSummary

  const mediaUrls = mediaSources(item)
  const text =
    item.content?.text ||
    item.content?.quoted?.text ||
    linkSummary(item.content?.media) ||
    item.body_text ||
    item.body_html?.replace(/<[^>]+>/g, ' ') ||
    ''

  return cleanDisplayText(text, [item.url, ...mediaUrls])
}

/** 转发/回复帖被引用的那一半（雪球的 retweeted_status、B 站的转发原动态）。 */
export interface QuotedPost {
  author: string
  text: string
}

/** 拆出原帖。null = 这条不是转发，或引用是个空壳（既没作者也没正文，画出来是空框）。 */
export function quotedPost(item: StreamItem): QuotedPost | null {
  const quoted = item.content?.quoted
  if (!quoted) return null
  const author = (quoted.author ?? '').trim()
  // 清洗参数必须和 itemSummary 完全一致——postSummary 靠"摘要 === 原帖正文"这个等式
  // 判断摘要是不是从原帖回落来的，两边用不同的清洗就再也相等不了。
  const text = cleanDisplayText(quoted.text ?? '', [item.url, ...mediaSources(item)])
  if (!author && !text) return null
  return { author, text }
}

/** 卡片 / 列表行上「本帖自己说的话」。
 *
 *  和 itemSummary 的唯一差别：转发语为空时 itemSummary 会把**原帖正文**顶上来当摘要
 *  （见上面的回落链），而贴文布局已经把原帖单独画成引用块了——照抄那份回落，同一段字
 *  就在一张卡上出现两遍，估高器还会按两份记账。所以这里让位。
 *
 *  itemSummary 的回落本身是对的，别去改它：全局搜索那类"一条只出一行字"的地方没有引用块，
 *  回落是它唯一能显示的内容。 */
export function postSummary(
  item: StreamItem,
  article?: { excerpt?: string; html?: string; text?: string } | null
): string {
  const summary = itemSummary(item, article)
  const quoted = quotedPost(item)
  return quoted && summary && summary === quoted.text ? '' : summary
}

export type MediaPreview = { src: string; alt?: string; w?: number; h?: number }

export function mediaPreviews(
  item: StreamItem,
  article?: { media?: Media[]; leadImage?: string } | null
): MediaPreview[] {
  const previews: MediaPreview[] = []
  const seen = new Set<string>()
  const push = (src?: string, alt?: string, w?: number, h?: number) => {
    if (!src || seen.has(src)) return
    seen.add(src)
    previews.push({ src: imgUrl(LOCAL.baseUrl, src), alt, w, h })
  }

  for (const entry of article?.media ?? []) {
    if (entry.kind === 'image') push(entry.url, entry.alt, entry.w, entry.h)
    if (entry.kind === 'video') push(entry.poster, undefined, entry.w, entry.h)
  }
  push(article?.leadImage)

  const media: Media[] = [
    ...(item.content?.media ?? []),
    ...(item.content?.quoted?.media ?? []),
  ]
  for (const entry of media) {
    if (entry.kind === 'image') push(entry.thumb || entry.url, entry.alt, entry.w, entry.h)
    // Carry the video's source dims (when the normalizer emitted them) so MediaBox snaps to the
    // right orientation on first paint instead of defaulting to 16:9 and flipping on poster load.
    if (entry.kind === 'video') push(entry.poster, undefined, entry.w, entry.h)
    if (entry.kind === 'audio') push(entry.poster)
    if (entry.kind === 'link') push(entry.image)
  }

  for (const attachment of item.attachments ?? []) {
    if (/\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(attachment)) push(attachment)
  }

  return previews
}

function mediaSources(item: StreamItem): string[] {
  const sources: string[] = []
  const push = (src?: string) => {
    if (src && !sources.includes(src)) sources.push(src)
  }

  const media: Media[] = [
    ...(item.content?.media ?? []),
    ...(item.content?.quoted?.media ?? []),
  ]
  for (const entry of media) {
    if (entry.kind === 'image') {
      push(entry.url)
      push(entry.thumb)
    }
    if (entry.kind === 'video') {
      push(entry.poster)
      push(entry.embed)
      push(entry.page_url)
    }
    if (entry.kind === 'audio') {
      push(entry.url)
      push(entry.poster)
      push(entry.page_url)
    }
    if (entry.kind === 'link') {
      push(entry.url)
      push(entry.image)
    }
  }
  for (const attachment of item.attachments ?? []) push(attachment)
  return sources
}

function linkSummary(media: Media[] | undefined): string {
  const link = media?.find((entry): entry is Extract<Media, { kind: 'link' }> => entry.kind === 'link' && !!entry.summary)
  return link?.summary ?? ''
}

function cleanDisplayText(text: string, urls: Array<string | undefined>): string {
  let cleaned = text
  for (const url of urls) {
    if (!url) continue
    cleaned = cleaned.split(url).join(' ')
  }
  return cleaned
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function formatTime(value: string): string {
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return ''
  const delta = Date.now() - time
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < hour) return `${Math.max(1, Math.round(delta / minute))}m`
  if (delta < day) return `${Math.round(delta / hour)}h`
  return `${Math.round(delta / day)}d`
}

/** 一个有意义的贴文标题，没有则返回 ''：空白，或占位标题——管线通用的 "(untitled)" 兜底，
 *  以及一些存量老条目仍然带着的 "(无标题)"。 */
export function normalizePostTitle(item: StreamItem): string {
  const raw = (item.title ?? '').trim()
  return raw && !/^[（(]\s*(?:无标题|untitled)\s*[)）]$/i.test(raw) ? raw : ''
}
