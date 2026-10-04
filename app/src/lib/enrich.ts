/** Source dispatch — detecting an item's source and extracting its enrichment key.
 *  Pure functions, no state: the single place that knows "this item → which source +
 *  what params". The stateful preload layer (cache, scroll scheduler, hooks) lives in
 *  preload.ts and routes everything through enrichParamsFor here. */

import { type EnrichParams } from './api.ts'
import type { Item, Media } from './types.ts'

/** 带 (provider, vid) 的视频 media——评论从它所属平台的包取（`${provider}-comments`）。 */
export function providerVideo(item: Item): { provider: string; vid: string } | undefined {
  const m = item.content?.media?.find(
    (m): m is Extract<Media, { kind: 'video' }> => m.kind === 'video' && !!m.provider && !!m.vid,
  )
  return m ? { provider: m.provider!, vid: m.vid! } : undefined
}

/** 包声明的现取（`content.enrich`）多半骑着用户的采集会话开标签页、占那个 facility 的访问预算——
 *  必须对应用户明确的一次打开，不随列表滚动预取。例外只有包自己申报 `prefetch: true` 的那类
 *  （站外裸 HTTP，比如论坛回复）：随滚动预取，卡片的摘要 / 评论数靠它暖出来。 */
export function allowsAutomaticEnrichment(item: Item): boolean {
  const declared = item.content?.enrich
  return !declared || declared.prefetch === true
}

/** Map an item to its enrichment request, or null when nothing can be enriched.
 *  判据只看形状，不看站名：包写的 `content.enrich` → 带 (provider, vid) 的视频 → link 原型。 */
export function enrichParamsFor(item: Item): EnrichParams | null {
  // 包的 normalizer 已经说了「打开时去哪现取」→ 原样用。下面的宿主判据只服务没写它的源。
  const declared = item.content?.enrich
  if (declared) {
    return { source: declared.source, params: declared.params, ...(declared.prefetch ? { prefetch: true } : {}) }
  }
  // 带 (provider, vid) 的视频：评论归认领那个平台的包（`${provider}-comments`）。
  const pv = providerVideo(item)
  if (pv) return { source: `${pv.provider}-comments` as const, vid: pv.vid }
  if (item.content?.archetype === 'link' && item.url) return { source: 'link', url: item.url }
  return null
}

/** True when this item has a fetchable comment thread (a sticky community source).
 *  Generic external links extract an article but carry no discussion. */
export function hasCommentThread(item: Item): boolean {
  const p = enrichParamsFor(item)
  if (!p || p.source === 'link') return false
  // 包声明的现取（`content.enrich`）按约定连首页评论一起交回（Enrichment.comments）——
  // 除了转发 / 回复帖：那里现取回来的是被引原帖的全文（Detail 把 article 填进 QuotedView），
  // 不是一段讨论串。
  if ('params' in p && item.content?.quoted) return false
  return true
}
