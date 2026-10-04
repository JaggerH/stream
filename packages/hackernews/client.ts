/** Hacker News discussion harvest. Story metadata (url, body, total) comes from the
 *  official Firebase API — one fast call. The threaded comment tree comes from the
 *  Algolia HN API, whose /items/{id} returns the *entire* nested thread in a single
 *  request: fetching it node-by-node from Firebase was an N+1 of up to a few hundred
 *  round-trips that throttled into 20-75s; Algolia is one ~2-3s call we then parse.
 *
 *  html 原样交出（评论正文、Ask HN 的帖子正文）：消毒归宿主——它在收下包交出的 enricher 时
 *  统一过一遍（`src/packages/activate.ts`），包里不带第二份消毒器。 */

import type { Comment } from '../../src/content/types.ts'

const FB_API = 'https://hacker-news.firebaseio.com/v0'
const ALGOLIA_API = 'https://hn.algolia.com/api/v1'
const TIMEOUT_MS = 6000

// keep the rendered tree bounded: top-level comments, nesting depth, total node count.
// These cap parsing of the in-memory Algolia tree (no network per node), so they're
// about render weight, not latency.
const MAX_TOP = 30
const MAX_DEPTH = 6
const MAX_NODES = 200

interface HnItem {
  id: number
  by?: string
  text?: string
  url?: string
  title?: string
  score?: number
  descendants?: number
  deleted?: boolean
  dead?: boolean
}

/** A node of the Algolia /items/{id} thread tree — children are nested inline. */
interface AlgoliaNode {
  id: number
  author?: string | null
  text?: string | null
  created_at_i?: number
  children?: AlgoliaNode[]
}

export interface HnStory {
  id: number
  by?: string
  title?: string
  /** linked article url (absent for Ask/Show HN text posts) */
  url?: string
  /** post body html (Ask/Show HN), unsanitized */
  textHtml?: string
  score?: number
  /** total comment count reported by HN */
  total: number
}

/** The story's own discussion page. */
export function storyPageUrl(id: number | string): string {
  return `https://news.ycombinator.com/item?id=${id}`
}

function timeout(signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, t]) : t
}

/** Fetch just the story metadata (url, body, total) — one fast Firebase call. Lets the
 *  caller extract the linked article in parallel with the comment-tree harvest.
 *  null = dead / deleted / unreachable. */
export async function fetchHnStory(id: number, signal?: AbortSignal): Promise<HnStory | null> {
  let root: HnItem | null = null
  try {
    const res = await fetch(`${FB_API}/item/${id}.json`, { signal: timeout(signal) })
    if (!res.ok) return null
    root = (await res.json()) as HnItem | null
  } catch {
    return null
  }
  if (!root || root.deleted || root.dead) return null
  return {
    id: root.id,
    by: root.by,
    title: root.title,
    url: root.url,
    textHtml: root.text || undefined,
    score: root.score,
    total: root.descendants ?? 0,
  }
}

/** Fetch the whole nested comment tree in one Algolia request, then map it (OP flagged,
 *  depth/node-capped). Deleted comments (text:null) are dropped. Empty on any failure. */
export async function fetchThreadComments(id: number, opAuthor?: string, signal?: AbortSignal): Promise<Comment[]> {
  let root: AlgoliaNode | null = null
  try {
    const res = await fetch(`${ALGOLIA_API}/items/${id}`, { signal: timeout(signal) })
    if (res.ok) root = (await res.json()) as AlgoliaNode
  } catch {
    return []
  }
  if (!root?.children?.length) return []
  let nodes = 0
  const walk = (children: AlgoliaNode[], depth: number): Comment[] => {
    if (depth >= MAX_DEPTH || nodes >= MAX_NODES) return []
    const out: Comment[] = []
    const limit = depth === 0 ? MAX_TOP : children.length
    for (const c of children.slice(0, limit)) {
      if (nodes >= MAX_NODES) break
      if (!c || !c.text) continue // deleted/empty comments carry text:null
      nodes++
      const replies = c.children?.length ? walk(c.children, depth + 1) : []
      out.push({
        id: String(c.id),
        author: c.author ?? undefined,
        html: c.text,
        text: stripHtml(c.text),
        time: c.created_at_i,
        badges: opAuthor && c.author === opAuthor ? ['OP'] : undefined,
        replies: replies.length ? replies : undefined,
      })
    }
    return out
  }
  return walk(root.children, 0)
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x2F;/g, '/')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}
