// src/agent/search/extract.ts
import type { NetdiskHit } from './types.ts'
import { SHARE_LINK_PATTERNS } from '../../../shared/netdisk/share-link.ts'

// 网盘分享链接的文法只有一份（shared/netdisk/share-link.ts）：它匹配分享路径；提取码另从链接后
// 一小段窗口里取（query `?pwd=`，或附近的 提取码/密码 标签）。

/** Rewrite a hub url to the endpoint that actually carries the post text + links before fetching.
 *  Discourse 话题页是 JS 壳——正文在同一话题的 `.json` 端点。认的是 **Discourse 的 URL 形状**
 *  （`/t/<slug>/<数字 id>`，可带楼层号 / query），不认具体主机：这是对一类论坛软件的知识，不是对某个站。
 *  形状撞上了但其实不是 Discourse 的站，由调用方在补抓失败时回落原页（见 domains/netdisk.ts 的 parse）。
 *  Others are returned unchanged. */
export function hubFetchUrl(url: string): string {
  const m = /^(https?:\/\/[^/?#]+\/t\/[^/?#]+\/\d+)(?=$|[/?#])/.exec(url)
  return m ? m[1] + '.json' : url
}

/** Find a 提取码 for a link inside a short window right after it. */
function passwordNear(text: string, from: number): string | undefined {
  const window = text.slice(from, from + 100)
  return (
    /[?&]pwd=([0-9a-zA-Z]{4})/.exec(window)?.[1] ??
    /(?:提取码|密码|访问码|pwd)[：:\s]*([0-9a-zA-Z]{4})\b/i.exec(window)?.[1]
  )
}

/** The resource title/description usually sits just BEFORE the share link on a hub page. Capture a
 *  cleaned window around the link so scoreTopicality has context to judge "is THIS link the target?"
 *  — without it every extracted link is a bare url and scores 0. Strips tags / escapes / whitespace. */
function contextSnippet(text: string, idx: number): string {
  const raw = text.slice(Math.max(0, idx - 160), idx + 20)
  const clean = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\[nrtu][0-9a-fA-F]*/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.slice(-110)
}

/**
 * Extract concrete netdisk share links from a fetched hub page's text (spec §6 step 3, 乙档). Pure:
 * regex over the raw text, dedup by link, best-effort 提取码 from a window after each link. `sourceId`
 * tags each hit with the hub it came from (so a productive hub can be flagged onboardable).
 */
export function extractNetdiskLinks(text: string, sourceId: string): NetdiskHit[] {
  const seen = new Set<string>()
  const out: NetdiskHit[] = []
  for (const { pattern: re, kind: netdisk } of SHARE_LINK_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const link = m[0]
      if (seen.has(link)) continue
      seen.add(link)
      const idx = m.index ?? 0
      out.push({
        link,
        netdisk,
        password: passwordNear(text, idx + link.length),
        sourceId,
        snippet: contextSnippet(text, idx),
      })
    }
  }
  return out
}
