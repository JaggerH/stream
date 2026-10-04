/** Generic article extraction — the same engine Obsidian Web Clipper uses (Defuddle),
 *  run server-side on HTML we fetch ourselves. Turns any external link (an HN story,
 *  a blog post) into a clean reader article: main content + metadata, clutter removed.
 *
 *  Comments are NOT extracted here — Defuddle treats them as clutter. Discussion
 *  threads are harvested per-community (see content/comments/*). */

import { Defuddle } from 'defuddle/node'
import { safeFetchText } from '../adapters/safe-fetch.ts'
import { sanitizeHtml } from './sanitize.ts'
import type { Article } from './types.ts'
import type { ContentCache } from '../content-cache.ts'

const TTL_MS = 24 * 60 * 60 * 1000
const cache = new Map<string, { at: number; article: Article | null }>()

let content: ContentCache | null = null

/** Wire the persistent ContentCache (bootstrap). The namespace spec lives here, next to
 *  the value it describes: extracted articles are stable facts (30d), dead/unextractable
 *  urls are negative-cached a day so list renders don't re-hit them. Unwired (tests,
 *  standalone) falls back to the in-process map below.
 *
 *  **返回一份撤销**：这个模块级指针活得比任何一次装配都长，而 `cacheLayer` 是随装配生灭的
 *  sqlite 句柄。不撤销的话，同进程里第二次 bootstrap（测试、将来的重启）之后它仍指着**上一份
 *  已经关掉的库**——表现是转成文字时突然抛 sqlite "database is closed"，离案发点十万八千里。 */
export function wireArticleCache(cacheLayer: ContentCache): () => void {
  cacheLayer.register('article', { ttlMs: 30 * 24 * 60 * 60 * 1000, negativeTtlMs: TTL_MS })
  const prev = content
  content = cacheLayer
  return () => {
    if (content === cacheLayer) content = prev
  }
}

/** Extract a reader article from a page url. Cached per url (persistent when wired). */
export async function extractArticle(url: string): Promise<Article | null> {
  if (content) return content.tryGet<Article>('article', url, () => doExtract(url))
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.article
  const article = await doExtract(url)
  cache.set(url, { at: Date.now(), article })
  return article
}

async function doExtract(url: string): Promise<Article | null> {
  const page = await safeFetchText(url)
  if (!page) return null
  let res
  try {
    res = await Defuddle(page.html, page.finalUrl, {
      markdown: false,
      useAsync: false, // don't let extractors call out to third-party APIs
      includeReplies: false, // comments are harvested separately
    })
  } catch {
    return null
  }
  const html = res.content ? sanitizeHtml(res.content) : ''
  if (!html) return null
  let domain = res.domain
  if (!domain) {
    try {
      domain = new URL(page.finalUrl).hostname
    } catch {
      /* keep empty */
    }
  }
  return {
    sourceUrl: page.finalUrl,
    title: res.title || undefined,
    author: res.author || undefined,
    published: res.published || undefined,
    html,
    excerpt: res.description || undefined,
    leadImage: res.image || undefined,
    wordCount: res.wordCount || undefined,
    domain: domain || undefined,
  }
}
