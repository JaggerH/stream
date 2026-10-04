/** Resolve and cache a site's favicon, used as the author/source avatar for items
 *  that carry no real avatar (RSS feeds). Fetched server-side on purpose: the
 *  backend reaches the publisher sites that RSS already pulls (a CN browser often
 *  can't, and third-party favicon services like Google s2 are blocked), and the
 *  result is cached so the list doesn't re-hit a domain per row.
 *
 *  Strategy: parse the homepage for the best <link rel="...icon"> then fall back
 *  to /favicon.ico. Misses are cached too (as null) so a dead domain isn't refetched. */

import { isPrivateHost } from './safe-fetch.ts'
import type { ContentCache } from '../content-cache.ts'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const TTL_MS = 24 * 60 * 60 * 1000
const HEAD_BYTES = 60_000
const FETCH_TIMEOUT_MS = 5000

export interface Icon {
  body: ArrayBuffer
  contentType: string
}

interface Entry {
  icon: Icon | null
  ts: number
}

const cache = new Map<string, Entry>()

/** ContentCache values must be JSON — icon bytes ride as base64 (favicons are tiny). */
interface IconDto {
  contentType: string
  bodyB64: string
}

function toDto(icon: Icon): IconDto {
  return { contentType: icon.contentType, bodyB64: Buffer.from(icon.body).toString('base64') }
}

function fromDto(dto: IconDto): Icon {
  const buf = Buffer.from(dto.bodyB64, 'base64')
  return { contentType: dto.contentType, body: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
}

let content: ContentCache | null = null

/** Wire the persistent ContentCache (bootstrap). Icon bytes are stable facts (30d);
 *  dead domains are negative-cached a day so lists don't re-hit them per row.
 *  Unwired (tests, standalone) falls back to the in-process map.
 *
 *  返回一份撤销，理由同 `wireArticleCache`：模块级指针比装配活得长，不撤就会指着一份
 *  已经关掉的 sqlite 句柄。 */
export function wireFaviconCache(cacheLayer: ContentCache): () => void {
  cacheLayer.register('favicon', { ttlMs: 30 * 24 * 60 * 60 * 1000, negativeTtlMs: TTL_MS })
  const prev = content
  content = cacheLayer
  return () => {
    if (content === cacheLayer) content = prev
  }
}

/** Resolve a favicon for the given page/site url. Cached per host (persistent when wired). */
export async function resolveFavicon(rawUrl: string): Promise<Icon | null> {
  let origin: string
  let host: string
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (isPrivateHost(u.hostname)) return null
    origin = u.origin
    host = u.hostname
  } catch {
    return null
  }
  if (content) {
    const dto = await content.tryGet<IconDto>('favicon', host, async () => {
      const icon = await fetchIcon(origin)
      return icon ? toDto(icon) : null
    })
    return dto ? fromDto(dto) : null
  }
  const hit = cache.get(host)
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.icon
  const icon = await fetchIcon(origin)
  cache.set(host, { icon, ts: Date.now() })
  return icon
}

async function fetchIcon(origin: string): Promise<Icon | null> {
  return (await iconFromHomepage(origin)) ?? (await fetchImage(new URL('/favicon.ico', origin).toString()))
}

async function iconFromHomepage(origin: string): Promise<Icon | null> {
  let html: string
  try {
    const res = await fetch(origin, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    })
    if (!res.ok) return null
    html = (await res.text()).slice(0, HEAD_BYTES)
  } catch {
    return null
  }
  const href = pickIconHref(html)
  if (!href) return null
  try {
    return await fetchImage(new URL(href, origin).toString())
  } catch {
    return null
  }
}

/** Pick the highest-resolution <link rel="...icon"> href from the page head. */
function pickIconHref(html: string): string | null {
  const tags = html.match(/<link\b[^>]*>/gi) ?? []
  let best: { href: string; size: number } | null = null
  for (const tag of tags) {
    if (!/\brel\s*=\s*["'][^"']*icon/i.test(tag)) continue
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]
    if (!href) continue
    const size = Number(tag.match(/\bsizes\s*=\s*["']?(\d+)/i)?.[1] ?? 16)
    if (!best || size > best.size) best = { href, size }
  }
  return best?.href ?? null
}

async function fetchImage(url: string): Promise<Icon | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    })
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') ?? ''
    const isIco = /\.ico(\?|$)/i.test(url)
    if (!/^image\//i.test(contentType) && !isIco) return null
    const body = await res.arrayBuffer()
    if (body.byteLength === 0) return null
    return { body, contentType: contentType || 'image/x-icon' }
  } catch {
    return null
  }
}
