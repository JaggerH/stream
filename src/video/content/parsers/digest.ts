/**
 * Digest parser — one raw item is a free-text post (pansou Telegram message) that
 * may bundle MANY resources, each a (name, link) pair. Deterministic split: pair
 * each link with the text segment immediately preceding it (see text.ts::pairDigest).
 * A single-resource post is the degenerate case (one pair, name from the title).
 */
import { parseTitle } from '../../parse.ts'
import { classifyNetdisk, isDownloadUrl } from '../classify.ts'
import { cleanName, cleanUrl, findLinks, isHtml, pairDigest } from '../text.ts'
import type { ContentParser, DownloadRow, RawDownloadItem } from '../types.ts'

/** URLs present in the free text (not the pre-extracted links[], which may be buggy). */
function textLinkCount(item: RawDownloadItem): number {
  return item.content ? findLinks(item.content).filter((l) => isDownloadUrl(l.url)).length : 0
}

export const digestParser: ContentParser = {
  id: 'digest',
  detect(item: RawDownloadItem) {
    if (!item.content) return 0
    // an HTML description is an RSSHub torrent body, NOT a pansou digest — refuse it,
    // else the parser shreds "<a href=…>" markup into garbage rows (the nyaa bug).
    if (isHtml(item.content)) return 0
    const n = textLinkCount(item)
    if (n === 0) return item.links?.length ? 0.5 : 0 // links[] only → weak claim
    // one URL → single resource (0.6); many → clearly a digest (up to 0.95)
    return Math.min(0.95, 0.55 + 0.1 * n)
  },
  parse(item: RawDownloadItem): DownloadRow[] {
    const content = item.content ?? ''
    let groups = pairDigest(content)
      .map((g) => ({ name: g.name, links: g.links.filter((l) => isDownloadUrl(l.url)) }))
      .filter((g) => g.links.length)

    // content had no parseable URL but the source pre-extracted a link → single row.
    // The pre-extracted url may itself be dirty (old truncation bug), so re-clean it.
    if (!groups.length && item.links?.length) {
      const l = item.links[0]
      const { url, password } = cleanUrl(l.url)
      if (isDownloadUrl(url)) {
        groups = [{ name: cleanName(item.title ?? ''), links: [{ url, password: l.password ?? password, start: 0, end: 0 }] }]
      }
    }
    if (!groups.length) return []

    const single = groups.length === 1
    const rows: DownloadRow[] = []
    for (const g of groups) {
      // the segment before the link is the MOST specific identity; the item title is a
      // fallback only (it's often a generic digest header like "周五 动漫" / "剧集分享").
      const name = g.name || cleanName(item.title ?? '')
      const primary = g.links[0]
      const f = parseTitle(name || g.name)
      const mirrors = g.links.slice(1).map((l) => ({ url: l.url, netdisk: classifyNetdisk(l.url), password: l.password }))
      rows.push({
        source: item.source,
        name: name || g.name,
        link: primary.url,
        netdisk: classifyNetdisk(primary.url),
        password: primary.password,
        quality: f.quality,
        season: f.season,
        coverage: f.coverage,
        codec: f.codec,
        hdr: f.hdr,
        group: f.group,
        sizeBytes: f.sizeBytes,
        channel: item.channel,
        channelUrl: item.channelUrl,
        provider: item.provider,
        origin: item.origin,
        images: single && item.images?.length ? item.images : undefined,
        mirrors: mirrors.length ? mirrors : undefined,
        // a named row is high-confidence; an unnamed one (bad segment) is suspect
        confidence: (name || g.name) ? (single ? 1 : 0.85) : 0.3,
        parser: 'digest',
      })
    }
    return rows
  },
}
