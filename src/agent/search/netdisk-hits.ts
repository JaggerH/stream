// src/agent/search/netdisk-hits.ts
import type { NetdiskHit } from './types.ts'
import type { Release, VideoSearchResult } from '../../video/types.ts'

/** Expand one release into NetdiskHits. A pansou release can carry MANY netdisk shares in `links[]`
 *  (link/sourceType only mirror the FIRST) — expand each so a quark share is never masked by a
 *  baidu-first release (needed for 夸克优先). Releases with neither links[] nor a link are dropped;
 *  page-only / needsResolve links are still surfaced (v1 returns them as-is). */
function releaseToHits(rel: Release, groupTitle?: string): NetdiskHit[] {
  const sourceId = rel.source || 'resource-search'
  const title = rel.title || groupTitle
  const shares =
    rel.links && rel.links.length
      ? rel.links
      : rel.link
        ? [{ url: rel.link, type: rel.sourceType, password: rel.password }]
        : []
  return shares
    .filter((s) => s.url)
    .map((s) => ({
      title,
      link: s.url,
      netdisk: s.type ?? 'unknown',
      password: s.password,
      sourceId,
      snippet: rel.content,
    }))
}

/** Flatten the faceted resource-search result into provider-agnostic NetdiskHits: every netdisk share on
 *  every release (structured shows + loose) becomes one NetdiskHit. netdisk = sourceType (quark/baidu/…). */
export function hitsFromVideoResult(r: VideoSearchResult): NetdiskHit[] {
  const hits: NetdiskHit[] = []
  for (const show of r.shows ?? []) {
    for (const q of show.qualities ?? []) {
      for (const rel of q.releases ?? []) hits.push(...releaseToHits(rel, show.title))
    }
  }
  for (const rel of r.loose ?? []) hits.push(...releaseToHits(rel))
  return hits
}
