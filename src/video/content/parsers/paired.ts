/**
 * Paired-links parser — one raw item whose links[] each carry their own desc = a
 * bundle of DISTINCT downloads (btbtla: a season page, one row per release). The
 * desc is the identity; the url is a page resolved to a magnet lazily.
 */
import { parseTitle } from '../../parse.ts'
import { downloadPageKind } from '../../resolve.ts'
import { classifyNetdisk } from '../classify.ts'
import { cleanName } from '../text.ts'
import type { ContentParser, DownloadRow, NetdiskKind, RawDownloadItem } from '../types.ts'

/** How many of the item's links carry a usable per-link description. */
function pairedRatio(item: RawDownloadItem): number {
  const links = item.links ?? []
  if (!links.length) return 0
  const withDesc = links.filter((l) => l.desc && l.desc.trim().length > 0).length
  return withDesc / links.length
}

/** Resolve a link's kind. 直接可用的链接按 host 分类；下载站中转页（认领判据与解析实现
 *  同住 `src/video/resolve.ts`，别在这里加站点正则）打 needsResolve 标。 */
function kindOf(url: string): { netdisk: NetdiskKind; needsResolve: boolean } {
  const direct = classifyNetdisk(url)
  if (direct !== 'unknown') return { netdisk: direct, needsResolve: false }
  const page = downloadPageKind(url)
  if (page) return { netdisk: page, needsResolve: true }
  return { netdisk: 'unknown', needsResolve: false }
}

export const pairedParser: ContentParser = {
  id: 'paired',
  detect(item: RawDownloadItem) {
    // its shape: links[] present AND at least half carry a desc
    return pairedRatio(item) >= 0.5 ? 0.9 : 0
  },
  parse(item: RawDownloadItem): DownloadRow[] {
    const links = item.links ?? []
    const rows: DownloadRow[] = []
    for (const l of links) {
      if (!l.url) continue
      const desc = (l.desc ?? '').trim()
      const name = cleanName(desc) || desc
      if (!name) continue // a paired link with no desc is not a usable row
      const f = parseTitle(desc)
      const { netdisk, needsResolve } = kindOf(l.url)
      rows.push({
        source: item.source,
        name,
        link: l.url,
        netdisk: l.type ? (classifyNetdisk(l.url) === 'unknown' ? netdisk : (l.type as NetdiskKind)) : netdisk,
        password: l.password,
        quality: f.quality,
        season: f.season,
        coverage: f.coverage,
        codec: f.codec,
        hdr: f.hdr,
        group: f.group,
        sizeBytes: f.sizeBytes,
        needsResolve: needsResolve || item.needsResolve,
        confidence: 1,
        parser: 'paired',
      })
    }
    return rows
  },
}
