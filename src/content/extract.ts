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

/**
 * 一个实例的文章抽取缓存（`ctx.stores.articles`，存储域建并接线）。持久层（ContentCache）
 * 没接（单测 / stdio）时退回实例内的内存 Map——过去那张 Map 是模块级的，同进程第二个内核
 * 会读到第一个的缓存；现在每实例各一张。
 *
 * wire 返回一份撤销：撤销序可能交错，只在指针仍指自己时回滚（同 wireArticleCache 时代的
 * 语义）。持久句柄随装配生灭，实例上的指针必须跟着撤，否则第二次装配后仍指着已关的库。
 */
export class ArticleCache {
  private content: ContentCache | null = null
  private readonly mem = new Map<string, { at: number; article: Article | null }>()

  /** Wire the persistent ContentCache (storage domain). The namespace spec lives here, next to
   *  the value it describes: extracted articles are stable facts (30d), dead/unextractable
   *  urls are negative-cached a day so list renders don't re-hit them. */
  wire(cacheLayer: ContentCache): () => void {
    cacheLayer.register('article', { ttlMs: 30 * 24 * 60 * 60 * 1000, negativeTtlMs: TTL_MS })
    const prev = this.content
    this.content = cacheLayer
    return () => {
      if (this.content === cacheLayer) this.content = prev
    }
  }

  /** Extract a reader article from a page url. Cached per url (persistent when wired). */
  async extract(url: string): Promise<Article | null> {
    if (this.content) return this.content.tryGet<Article>('article', url, () => doExtract(url))
    const hit = this.mem.get(url)
    if (hit && Date.now() - hit.at < TTL_MS) return hit.article
    const article = await doExtract(url)
    this.mem.set(url, { at: Date.now(), article })
    return article
  }
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
