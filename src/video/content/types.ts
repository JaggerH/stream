/**
 * Content-parser layer: turn a source's raw item (whatever shape it arrives in)
 * into a uniform list of DownloadRow — one row per distinct downloadable thing,
 * whose identity (`name`) is content-derived and whose facets are parsed once.
 *
 * The heterogeneity that used to leak downstream (flat title vs paired links[].desc
 * vs free-text digest) is absorbed here by pluggable, self-detecting parsers.
 */
import type { Coverage, Quality } from '../types.ts'

/** Netdisk/link kind — FINER than the store's SourceType (which only knows
 *  quark/baidu/aliyun/magnet/ed2k). Mapped back to SourceType at the Release
 *  boundary; the finer label survives in Release.netdiskLabel for display. */
export type NetdiskKind =
  | 'magnet'
  | 'ed2k'
  | 'quark'
  | 'uc' // drive.uc.cn (UC 网盘,夸克同源)
  | 'tianyi' // cloud.189.cn (天翼云盘)
  | 'baidu'
  | 'aliyun'
  | 'xunlei' // pan.xunlei.com (迅雷云盘)
  | 'pan123' // 123pan / 123865 / 123684 / 123912 (轮换域名)
  | 'p115' // 115
  | 'unknown'

/** The normalized input a parser sees — the union of shapes real sources emit.
 *  A source adapter's raw item is adapted into this before parsing. */
export interface RawDownloadItem {
  source: string
  title: string
  /** free-text body (pansou Telegram message); the digest parser reads this. */
  content?: string
  /** pre-extracted links (btbtla links[].desc; pansou's own extraction). Each may
   *  carry a per-link description — presence of desc is the paired-links signal. */
  links?: RawLink[]
  /** single download link for flat sources (nyaa enclosure_url / 1lou link). */
  link?: string
  images?: string[]
  channel?: string
  /** 频道页 URL——源给的通用字段 `channel_url`，宿主不拼 */
  channelUrl?: string
  provider?: string
  origin?: string
  /** true when `link` is a page to be resolved to a magnet later (btbtla /tdown). */
  needsResolve?: boolean
}

export interface RawLink {
  url: string
  type?: string
  desc?: string
  password?: string
}

/** One distinct downloadable thing, fully normalized. */
export interface DownloadRow {
  source: string
  /** content-derived identity — NEVER a URL. Empty string only if truly nothing
   *  usable could be derived (the row is then low-confidence, caller may drop). */
  name: string
  /** cleaned download/page URL (no trailing 访问码 garbage, no whitespace). */
  link: string
  netdisk: NetdiskKind
  password?: string
  quality: Quality
  season: number | null
  coverage: Coverage
  codec?: string
  hdr?: string
  group?: string
  sizeBytes?: number
  channel?: string
  channelUrl?: string
  provider?: string
  origin?: string
  images?: string[]
  needsResolve?: boolean
  /** additional shares of THIS SAME work on other netdisks (mirror links). The row's
   *  own `link`/`netdisk`/`password` are the primary; these are alternatives. */
  mirrors?: Array<{ url: string; netdisk: NetdiskKind; password?: string }>
  /** 0..1 — the parser's confidence this is a real, correctly-identified download. */
  confidence: number
  /** id of the parser that produced this row (provenance + eval). */
  parser: string
}

/** A pluggable content parser. `detect` votes on whether an item is its shape;
 *  the registry runs all detectors and routes to the highest scorer. */
export interface ContentParser {
  id: string
  /** 0 = not my shape, 1 = definitely mine. Detection keys on item SHAPE, not
   *  source id, so a new source of a known shape auto-routes. */
  detect(item: RawDownloadItem): number
  parse(item: RawDownloadItem): DownloadRow[]
}
