/**
 * Bridge the content-parser layer to the search pipeline: adapt a source's raw item
 * into the parser's input, run the auto-detected parser, and map each DownloadRow
 * back onto the store's `Release`. Every row lands `loose` (show:null) — the pure-flat
 * model retires the ShowSeason tree; grouping, if ever wanted, is a post-hoc view.
 */
import type { RawVideoItem } from '../extract.ts'
import type { GroupedRelease } from '../aggregate.ts'
import type { Release } from '../types.ts'
import { NETDISK_LABEL, toSourceType } from './classify.ts'
import { route } from './registry.ts'
import type { DownloadRow, RawDownloadItem, RawLink } from './types.ts'

/** Adapt a pipeline RawVideoItem (any source shape) into the parser's normalized input. */
export function adaptRawItem(source: string, it: RawVideoItem): RawDownloadItem {
  const rawLinks = Array.isArray((it as { links?: unknown }).links)
    ? ((it as { links: RawLink[] }).links).filter((l) => l && l.url)
    : undefined
  // 出处只读源给的**通用字段**（origin / provider / channel_url）——由产出这条的包在自己的 adapter
  // 里拼好；宿主不认识任何上游的字段形状（spec 2026-09-26-boundary-stage9 §2.1）。
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  const channel = str(it.channel)
  const origin = str(it.origin)
  const provider = str(it.provider)
  const channelUrl = str(it.channel_url)
  const images = Array.isArray(it.images)
    ? (it.images as unknown[]).map(String).filter((u) => /^https?:\/\//.test(u))
    : undefined
  return {
    source,
    title: String(it.title ?? ''),
    content: it.content != null ? String(it.content) : undefined,
    links: rawLinks?.map((l) => ({ url: String(l.url), type: l.type, desc: l.desc, password: l.password })),
    link: String(it.enclosure_url ?? it.link ?? '') || undefined,
    images: images?.length ? images : undefined,
    channel,
    channelUrl,
    provider,
    origin,
    needsResolve: (it as { needsResolve?: boolean }).needsResolve,
  }
}

/** DownloadRow → the store's Release. */
export function rowToRelease(row: DownloadRow): Release {
  const sourceType = toSourceType(row.netdisk)
  // a work with mirror shares carries them as links[] (primary first) — the ONE
  // legitimate use of links[] in the flat model: same named work, alternate netdisks.
  const links = row.mirrors?.length
    ? [
        { url: row.link, type: sourceType, password: row.password },
        ...row.mirrors.map((m) => ({ url: m.url, type: toSourceType(m.netdisk), password: m.password })),
      ]
    : undefined
  return {
    source: row.source,
    title: row.name,
    quality: row.quality,
    sourceType,
    // show the finer label only when SourceType lost information (collapsed to unknown)
    netdiskLabel: sourceType === 'unknown' && row.netdisk !== 'unknown' ? NETDISK_LABEL[row.netdisk] : undefined,
    coverage: row.coverage,
    codec: row.codec,
    hdr: row.hdr,
    group: row.group,
    sizeBytes: row.sizeBytes,
    link: row.link,
    password: row.password,
    links,
    needsResolve: row.needsResolve,
    channel: row.channel,
    channelUrl: row.channelUrl,
    provider: row.provider,
    origin: row.origin,
    images: row.images,
    parsed: true,
  }
}

/** normalize for loose substring relevance (CN/EN, punctuation-insensitive). */
function norm(s: string): string {
  return s.toLowerCase().replace(/[\s._·・\-:：|()（）【】\[\]《》,，、!！?？]/g, '')
}

/**
 * Parse one source's raw items into grouped(loose) releases.
 *
 * Relevance: a DIGEST source (pansou) is a LOOSE full-text netdisk search — it hits on
 * tags/descriptions and returns piles of unrelated works, so every one of its rows is
 * gated on the query name (this also de-noises a 合集 that bundles the queried work with
 * a dozen others). FLAT/PAIRED sources (nyaa/btbtla) searched the query server-side, so
 * they pass through untouched — gating them on a CN substring would wrongly drop
 * romaji/EN-titled matches.
 */
export function parseSourceItems(source: string, rawAll: RawVideoItem[], q: string): GroupedRelease[] {
  const nq = q ? norm(q) : ''
  const out: GroupedRelease[] = []
  for (const it of rawAll) {
    const item = adaptRawItem(source, it)
    const routed = route(item)
    let rows = routed.parser.parse(item)
    if (routed.parser.id === 'digest' && nq) {
      rows = rows.filter((r) => norm(r.name).includes(nq)) // loose search → keep only real hits
    }
    for (const row of rows) {
      if (!row.name.trim()) continue // never surface a nameless row
      out.push({ show: null, season: null, release: rowToRelease(row) })
    }
  }
  return out
}
