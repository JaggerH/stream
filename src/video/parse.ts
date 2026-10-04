/**
 * Best-effort facet extraction from a release title. Titles are messy and
 * cross-source, so everything here is fuzzy — callers mark the resulting facets
 * `parsed: true`. Native fields (e.g. btbtla's quality tab) should override.
 */
import type { Coverage, Quality, SourceType } from './types.ts'
import { shareIdOf, shareLinkKindOf, type ShareLinkKind } from '../../shared/netdisk/share-link.ts'

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

/** "三" → 3, "十" → 10, "十二" → 12, "8" → 8. Returns null if unparseable. */
function cnNum(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s)
  if (s.length === 1) return CN_NUM[s] ?? null
  // 十X (11-19), X十 (20,30..), X十Y (21..)
  const ten = s.indexOf('十')
  if (ten === -1) return null
  const head = s.slice(0, ten)
  const tail = s.slice(ten + 1)
  const h = head === '' ? 1 : (CN_NUM[head] ?? null)
  const t = tail === '' ? 0 : (CN_NUM[tail] ?? null)
  if (h === null || t === null) return null
  return h * 10 + t
}

export function parseQuality(title: string): Quality {
  if (/\b(2160p|4k|uhd)\b/i.test(title)) return '2160p'
  if (/\b1080p\b/i.test(title)) return '1080p'
  if (/\b720p\b/i.test(title)) return '720p'
  if (/\b(480p|360p|sd)\b/i.test(title)) return 'sd'
  return 'unknown'
}

/** Season number from S03 / 第三季 / Season 3. null if absent. */
export function parseSeason(title: string): number | null {
  const cn = title.match(/第\s*([一二三四五六七八九十\d]+)\s*季/)
  if (cn) {
    const n = cnNum(cn[1])
    if (n !== null) return n
  }
  // S03 / Season 3 / S03E07 (no word boundary before the E, so allow a following Exx)
  const en = title.match(/\bS(?:eason)?\s*0*(\d{1,2})(?=E\d|\b)/i)
  if (en) return Number(en[1])
  return null
}

/** Episode coverage. Range patterns are checked before single patterns. */
export function parseCoverage(title: string): Coverage {
  // full-season pack: 全N集 / 全N话 — gives the denominator
  const pack = title.match(/全\s*(\d+)\s*[集話话]/)
  if (pack) {
    const n = Number(pack[1])
    return { kind: 'pack', from: 1, to: n, total: n }
  }
  // ranges: SxxExx-Eyy / SxxExx-yy
  const sRange = title.match(/S\d{1,2}E(\d{1,3})\s*-\s*E?(\d{1,3})/i)
  if (sRange) return { kind: 'range', from: Number(sRange[1]), to: Number(sRange[2]) }
  // ranges: 第03-04集 / 第3-8話
  const cnRange = title.match(/第\s*(\d{1,3})\s*-\s*(\d{1,3})\s*[集話话]/)
  if (cnRange) return { kind: 'range', from: Number(cnRange[1]), to: Number(cnRange[2]) }
  // ranges: EP01-08 / E01-E08
  const epRange = title.match(/\bEP?\.?\s*(\d{1,3})\s*-\s*(?:EP?\.?\s*)?(\d{1,3})\b/i)
  if (epRange) return { kind: 'range', from: Number(epRange[1]), to: Number(epRange[2]) }
  // ranges: nyaa parenthesized batch "(01-10)" / "(01 - 28)"
  const parenRange = title.match(/\((\d{1,3})\s*-\s*(\d{1,3})\)/)
  if (parenRange) return { kind: 'range', from: Number(parenRange[1]), to: Number(parenRange[2]) }
  // single: SxxExx
  const sSingle = title.match(/S\d{1,2}E(\d{1,3})\b/i)
  if (sSingle) return { kind: 'single', episode: Number(sSingle[1]) }
  // single: 第03集 / 第3話
  const cnSingle = title.match(/第\s*(\d{1,3})\s*[集話话]/)
  if (cnSingle) return { kind: 'single', episode: Number(cnSingle[1]) }
  // single: EP03 / E03 (avoid matching codecs like H.264 — require EP or word-boundary E + 2+ digits)
  const epSingle = title.match(/\bEP\.?\s*(\d{1,3})\b/i) || title.match(/\bE(\d{2,3})\b/)
  if (epSingle) return { kind: 'single', episode: Number(epSingle[1]) }
  // single: nyaa "Show - 24" (1-3 digits, not a 4-digit year). Lowest priority.
  const dashSingle = title.match(/\s-\s*(\d{1,3})(?=\s|\[|\(|$)/)
  if (dashSingle) return { kind: 'single', episode: Number(dashSingle[1]) }
  // whole-season pack with NO episode list: "Sxx COMPLETE" / a bare "Sxx" (season
  // marker, no Exx) / "全集"/"完结"/"合集". These ARE complete downloads but carry no
  // episode count — surface them like packs, not as junk.
  if (/\bcomplete\b|全集|完结|完結|合集/i.test(title) || /\bS\d{1,2}\b(?!\s*E\d)/i.test(title)) {
    return { kind: 'complete' }
  }
  return { kind: 'unknown' }
}

const NOISE =
  /\b(2160p|1080p|720p|480p|360p|4k|uhd|x?26[45]|hevc|avc|av1|web-?dl|webrip|web|blu-?ray|bd(rip)?|hdr10?|dolby|vision|amzn|nf|ddp?\d?\.?\d?|e?ac-?3|flac|aac|opus|\d{1,2}-?bit|dual-?audio|multi-?audio|remux|repack|batch|complete|v\d|raw|cht|chs|gb|big5)\b/gi

/**
 * Best-effort show name from a messy flat-source title (nyaa/u3c3). Strips tag
 * groups, alt-name parens, dub prefixes, the season/episode marker and the
 * release-noise tokens — what's left is the show. Returns null if nothing usable
 * (then the release falls to `loose`). Fuzzy: cross-release naming varies (romaji
 * vs CN vs official EN), so groups may split — acceptable without metadata.
 */
export function parseShow(title: string): string | null {
  let s = title
    .replace(/\[[^\]]*\]/g, ' ') // [SubsPlease] [Batch] …
    .replace(/【[^】]*】/g, ' ')
    .replace(/\([^)]*\)/g, ' ') // (Sousou no Frieren) (01-10) (1080p)
    .replace(/^\s*[一-龥]{1,4}\s*-\s*/, ' ') // 中配 - / 粤配 -
  // cut at the first season/episode marker — the show name precedes it. (S02E10 has
  // no word boundary after the season digits, so allow a trailing Exx.)
  const cut = s.search(/\bS(?:eason)?\s*0*\d{1,2}(?=E\d|\b)|第\s*\d+\s*[集话話季]|全\d+[集话話]|\s-\s*\d{1,3}(?=\D|$)|\bEP?\s*\d{1,3}\b|\bvol\.?\s*\d+/i)
  if (cut > 0) s = s.slice(0, cut)
  s = s
    .replace(NOISE, ' ')
    .replace(/[._|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s\-|:/]+$/, '')
    .trim()
  return s.length >= 2 ? s : null
}

export function parseSize(title: string): number | undefined {
  const m = title.match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB)\b/i)
  if (!m) return undefined
  const n = Number(m[1])
  const unit = m[2].toUpperCase()
  const mult = unit === 'TB' ? 1024 ** 4 : unit === 'GB' ? 1024 ** 3 : 1024 ** 2
  return Math.round(n * mult)
}

export function parseCodec(title: string): string | undefined {
  if (/\b(H\.?265|x265|HEVC)\b/i.test(title)) return 'H265'
  if (/\b(H\.?264|x264|AVC)\b/i.test(title)) return 'H264'
  return undefined
}

export function parseHdr(title: string): string | undefined {
  const dv = /(杜比视界|Dolby\s*Vision|\bDV\b)/i.test(title)
  const hdr = /\bHDR(10)?\+?\b/i.test(title)
  if (dv && hdr) return 'HDR+DV'
  if (dv) return 'DV'
  if (hdr) return 'HDR'
  return undefined
}

/** Release group — the `-GROUP` token at the tail, before size/extension. */
export function parseGroup(title: string): string | undefined {
  const m = title.match(/-\s*([A-Za-z][A-Za-z0-9]{1,15})(?=\s*(?:\[|$|\.torrent|\.mkv|\.mp4))/)
  return m ? m[1] : undefined
}

/** SourceType 只建模了这三家网盘；网盘文法（`shared/netdisk/share-link.ts`）认得的其余几家在这里落 `unknown`。 */
const SOURCE_TYPE_OF: Partial<Record<ShareLinkKind, SourceType>> = { quark: 'quark', baidu: 'baidu', aliyun: 'aliyun' }

/** Map a download link to a source type by scheme/host. 网盘判法按主机（唯一一份文法在 shared/netdisk/share-link.ts）。 */
export function classifyLink(link: string): SourceType {
  if (link.startsWith('magnet:')) return 'magnet'
  if (link.startsWith('ed2k:')) return 'ed2k'
  const kind = shareLinkKindOf(link)
  return (kind && SOURCE_TYPE_OF[kind]) ?? 'unknown'
}

/** 分享 ID：同一份网盘文法抠，且要与调用方给的 sourceType 对得上。抠不出来 → undefined。 */
function shareIdFor(link: string, sourceType: SourceType): string | undefined {
  const hit = shareIdOf(link)
  return hit && SOURCE_TYPE_OF[hit.kind] === sourceType ? hit.id : undefined
}

/** 归一化 URL 兜底：丢 query 与 hash、host 转小写。非 URL 原样返回。 */
function normalizeUrl(link: string): string {
  try {
    const u = new URL(link)
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/$/, '')}`
  } catch {
    return link
  }
}

/**
 * 一条下载链接 → 跨源稳定的去重身份。
 *
 * 同一个磁力在不同源里 URL 不同（dn / tracker 列表各异）但 btih 相同，所以键取
 * 内容标识而非整个 URL：磁力取 btih、ed2k 取 file hash、网盘取分享 ID。抠不出来
 * 退到归一化 URL。键带 sourceType 前缀，避免不同类型撞上相同 ID。
 */
export function dedupeKey(link: string, sourceType: SourceType): string {
  if (sourceType === 'magnet') {
    const m = /xt=urn:btih:([A-Za-z0-9]+)/i.exec(link)
    if (m) return `magnet:${m[1].toLowerCase()}`
  }
  if (sourceType === 'ed2k') {
    const m = /ed2k:\/\/\|file\|[^|]*\|\d+\|([A-Fa-f0-9]{32})/.exec(link)
    if (m) return `ed2k:${m[1].toLowerCase()}`
  }
  const id = shareIdFor(link, sourceType)
  if (id) return `${sourceType}:${id}`
  return `${sourceType}:${normalizeUrl(link)}`
}

/**
 * 一条网盘分享链接 → `netdisk.share.*` 调用点要的 `(netdisk, pwd_id)`。链接是每个消费方
 * 手里都有的东西（搜索结果、Agent 抽出的链），而 Provider 按网盘分发、按分享 id 定位，
 * 所以这个转换吃同一份网盘文法（shared/netdisk/share-link.ts），不另起一套。
 * 非网盘链接（magnet/ed2k）或抠不出 id 的 → null。
 */
export function parseShareLink(link: string): { netdisk: SourceType; pwd_id: string } | null {
  const netdisk = classifyLink(link)
  const pwd_id = shareIdFor(link, netdisk)
  return pwd_id ? { netdisk, pwd_id } : null
}

export interface ParsedFacets {
  quality: Quality
  season: number | null
  coverage: Coverage
  codec?: string
  hdr?: string
  group?: string
  sizeBytes?: number
}

/** Parse all title-derived facets in one pass. */
export function parseTitle(title: string): ParsedFacets {
  return {
    quality: parseQuality(title),
    season: parseSeason(title),
    coverage: parseCoverage(title),
    codec: parseCodec(title),
    hdr: parseHdr(title),
    group: parseGroup(title),
    sizeBytes: parseSize(title),
  }
}
