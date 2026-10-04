/** V2EX discussion harvest via the public v1 API — no auth, no token. A topic already
 *  carries its own body in the feed, so only the (flat) replies are fetched.
 *
 *  html 原样交出（`content_rendered`）：消毒归宿主——它在收下包交出的 enricher 时统一过一遍
 *  （`src/packages/activate.ts`），包里不带第二份消毒器。 */

import type { Enricher } from '../../src/packages/activate.ts'
import type { Comment, Enrichment } from '../../src/content/types.ts'
import { ValidationError } from '../../shared/package-sdk/errors.ts'

const API = 'https://www.v2ex.com/api'
const TIMEOUT_MS = 6000

interface V2exReply {
  id: number
  content?: string
  content_rendered?: string
  created?: number
  member?: { username?: string; avatar_normal?: string; avatar_mini?: string }
}

/** A topic's replies as normalized (flat) comments. Empty on any failure. */
async function fetchReplies(topicId: number, signal?: AbortSignal): Promise<Comment[]> {
  let replies: unknown
  try {
    const t = AbortSignal.timeout(TIMEOUT_MS)
    const res = await fetch(`${API}/replies/show.json?topic_id=${topicId}`, {
      signal: signal ? AbortSignal.any([signal, t]) : t,
    })
    if (!res.ok) return []
    replies = await res.json()
  } catch {
    return []
  }
  if (!Array.isArray(replies)) return []
  return (replies as V2exReply[])
    .filter((r) => r && (r.content || r.content_rendered))
    .map((r) => ({
      id: String(r.id),
      author: r.member?.username,
      avatar: r.member?.avatar_normal || r.member?.avatar_mini,
      html: r.content_rendered || r.content || '',
      text: r.content ?? '',
      time: r.created,
    }))
}

/** `/api/enrich?source=v2ex-comments&id=<topic id>` → 全部回复（v1 API 一发给全，`cursor` 恒为 null）。 */
export function makeEnrichers(): Record<string, Enricher> {
  return {
    'v2ex-comments': async (q, signal): Promise<Enrichment> => {
      const id = /^\d+$/.test(q.id ?? '') ? Number(q.id) : NaN
      if (!Number.isInteger(id) || id <= 0) throw new ValidationError('id (a V2EX topic id) required')
      const comments = await fetchReplies(id, signal)
      return { comments, total: comments.length, cursor: null }
    },
  }
}
