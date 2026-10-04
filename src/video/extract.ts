/**
 * Per-source extractors: map a source's raw RSSHub items into normalized
 * GroupedReleases. This is the boundary where format heterogeneity is absorbed —
 * downstream (aggregate) never sees source-specific shapes.
 */
import { classifyLink, parseShow, parseTitle } from './parse.ts'
import type { GroupedRelease } from './aggregate.ts'
import type { Release } from './types.ts'

export interface RawVideoItem {
  title?: string
  link?: string
  enclosure_url?: string
  category?: string[]
  /** btbtla: season info under RSSHub's `_extra` passthrough — seasonTitle (e.g.
   *  "上载新生 第三季") for grouping, seasonUrl (the detail-page URL) for the preview
   *  iframe. Lives in `_extra` because they aren't standard DataItem fields. */
  _extra?: { seasonTitle?: string; seasonUrl?: string; cover?: string }
  [k: string]: unknown
}

/**
 * Flat magnet sources (nyaa / u3c3): facets parsed from the title, magnet taken
 * directly from the row. Episodic content with a parseable show name is grouped
 * (by show+season); movies, unparseable names, and one-offs fall to `loose` (the
 * caller demotes thin groups too). Show parsing is fuzzy → grouping is best-effort.
 */
export function extractFlat(items: RawVideoItem[], source: string): GroupedRelease[] {
  return items.flatMap((it) => {
    const title = String(it.title ?? '')
    const link = String(it.enclosure_url ?? it.link ?? '')
    if (!link) return []
    const f = parseTitle(title)
    const release: Release = {
      source,
      title,
      quality: f.quality,
      sourceType: classifyLink(link),
      coverage: f.coverage,
      codec: f.codec,
      hdr: f.hdr,
      group: f.group,
      sizeBytes: f.sizeBytes,
      link,
      parsed: true,
    }
    // group only episodic content (has an episode/pack/range) with a usable show
    // name; everything else stays loose.
    const show = f.coverage.kind !== 'unknown' ? parseShow(title) : null
    return [{ show, season: f.season, release }]
  })
}
