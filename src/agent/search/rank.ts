// src/agent/search/rank.ts
import type { ScoredHit, SearchTarget } from './types.ts'

/** Netdisk preference: quark first (spec §6 step 5), everything else after, tie-broken by score. */
const NETDISK_ORDER: Record<string, number> = { quark: 0 }
const netdiskRank = (n: string) => (n in NETDISK_ORDER ? NETDISK_ORDER[n] : 1)

/**
 * Dedupe by link (keep the higher topicality), then sort quark-first, then topicality desc.
 * 商品档的候选没有 `link`（CatalogHit 只有 model）——这类 hit 按自身序列化去重，绝不塌缩成一条
 * （spec §2.1：枚举档要的是清单不是 top-N，排序几乎无意义；去重交给 check 的 identityOf 合并）。
 */
export function rankTargets(hits: ScoredHit[]): SearchTarget[] {
  const best = new Map<string, ScoredHit>()
  for (const h of hits) {
    const key = h.link || JSON.stringify(h)
    const prev = best.get(key)
    if (!prev || h.topicality > prev.topicality) best.set(key, h)
  }
  return [...best.values()].sort(
    (a, b) => netdiskRank(a.netdisk) - netdiskRank(b.netdisk) || b.topicality - a.topicality
  )
}
