import { SOURCE_META } from './source-domains.ts'
import { LOCAL } from './api.ts'

/** The platform namespace for a catalog source id. RSSHub sources are `rsshub:<ns>/...`;
 *  other ids fall back to their first `-` segment (a guess, only used when nothing better exists). */
export function sourceNamespace(id: string): string {
  return id.startsWith('rsshub:') ? id.slice('rsshub:'.length).split('/')[0].toLowerCase() : id.split('-')[0].toLowerCase()
}

/**
 * 一条源的站点域名。**包说了算**：后端给的 `site.domain`（认领这条源的包的 homepage 主机）优先；
 * 没有才查 RSSHub 命名空间那张生成的目录表（`source-domains.ts`，整网目录，不是手写的站点知识）——
 * 先按 manifest 申报的 `facility.key`，再按 id 里解析出的命名空间（易错：命名空间 ≠ 平台时会猜错）。
 * 前端不维护任何「这个包其实是哪个站」的别名表。
 */
export function sourceDomain(id: string, facilityKey?: string, siteDomain?: string): string | undefined {
  if (siteDomain) return siteDomain
  return SOURCE_META[facilityKey ?? sourceNamespace(id)]?.d
}

/** Brand-icon URL for a source, rendered by the Folo icon service — the same source RSSHub's own
 *  docs use. `undefined` when the platform is unknown (caller shows a lettered fallback). */
export function sourceIconUrl(id: string, facilityKey?: string, siteDomain?: string): string | undefined {
  const d = sourceDomain(id, facilityKey, siteDomain)
  return d ? `https://icons.folo.is/${d}` : undefined
}

export function sourceIconFallbackUrl(id: string, facilityKey?: string, siteDomain?: string): string | undefined {
  const d = sourceDomain(id, facilityKey, siteDomain)
  // LOCAL.baseUrl prefix, not a bare relative path: the page's origin is not always the
  // backend's (the panel lives inside the user's DSH page), so media must carry the base;
  // '' when they are the same origin.
  return d ? `${LOCAL.baseUrl}/api/media/image?site=${encodeURIComponent(`https://${d}`)}` : undefined
}
