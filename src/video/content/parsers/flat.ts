/**
 * Flat parser — one raw item = one download, identity in the title. Covers
 * nyaa / u3c3 / 1lou / bangumi-moe (torrent rows) and is the universal FLOOR:
 * it detects at a low baseline so anything no other parser claims still parses.
 */
import { parseTitle } from '../../parse.ts'
import { classifyNetdisk } from '../classify.ts'
import { cleanName } from '../text.ts'
import type { ContentParser, DownloadRow, RawDownloadItem } from '../types.ts'

export const flatParser: ContentParser = {
  id: 'flat',
  detect(item: RawDownloadItem) {
    // a magnet/ed2k enclosure is the unmistakable mark of ONE torrent = one flat row;
    // claim it strongly so an accompanying HTML description can't misroute it to digest.
    const link = item.link ?? item.links?.[0]?.url ?? ''
    if (/^(magnet:|ed2k:)/i.test(link)) return 0.7
    return 0.3 // floor — always eligible, wins only when nothing else claims
  },
  parse(item: RawDownloadItem): DownloadRow[] {
    const link = item.link ?? item.links?.[0]?.url ?? ''
    if (!link) return []
    const rawTitle = item.title ?? ''
    const name = cleanName(rawTitle) || rawTitle
    const f = parseTitle(rawTitle)
    return [
      {
        source: item.source,
        name,
        link,
        netdisk: classifyNetdisk(link),
        quality: f.quality,
        season: f.season,
        coverage: f.coverage,
        codec: f.codec,
        hdr: f.hdr,
        group: f.group,
        sizeBytes: f.sizeBytes,
        images: item.images?.length ? item.images : undefined,
        needsResolve: item.needsResolve,
        confidence: name ? 1 : 0.4,
        parser: 'flat',
      },
    ]
  },
}
