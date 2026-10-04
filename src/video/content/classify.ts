/**
 * Link classification for the content layer — finer than parse.ts::classifyLink,
 * because netdisk-search sources (pansou) surface a long tail of drives the store's
 * SourceType never modeled (UC / 天翼 / 迅雷 / 123 / 115). Kept as its own table so
 * the store's SourceType stays small; mapping to SourceType happens at the boundary.
 */
import type { NetdiskKind } from './types.ts'
import { shareLinkKindOf, type ShareLinkKind } from '../../../shared/netdisk/share-link.ts'

/** 网盘文法（唯一一份在 shared/netdisk/share-link.ts）的 kind → 本层词表。NetdiskKind 没建模的几家落 unknown。 */
const KIND_OF: Record<ShareLinkKind, NetdiskKind> = {
  quark: 'quark', uc: 'uc', tianyi: 'tianyi', baidu: 'baidu', aliyun: 'aliyun', xunlei: 'xunlei',
  '123': 'pan123', '115': 'p115', mobile: 'unknown', pikpak: 'unknown',
}

/** Classify a URL (or magnet/ed2k scheme) into a NetdiskKind. */
export function classifyNetdisk(url: string): NetdiskKind {
  if (url.startsWith('magnet:')) return 'magnet'
  if (url.startsWith('ed2k:')) return 'ed2k'
  const kind = shareLinkKindOf(url)
  return kind ? KIND_OF[kind] : 'unknown'
}

// Hosts that appear in netdisk-search blobs but are NEVER a download: the poster's
// own Telegram group/channel, an index spreadsheet, etc. Dropping these keeps digest
// rows honest (a t.me/群聊 link is not a movie).
const NON_DOWNLOAD_HOST =
  /^https?:\/\/(?:t\.me|telegram\.me|docs\.qq\.com|kdocs\.cn|content\.21cn\.com|www\.wenshushu\.cn)\b/i

/** A real download link (magnet/ed2k/any netdisk page) vs a group/index/junk link. */
export function isDownloadUrl(url: string): boolean {
  if (url.startsWith('magnet:') || url.startsWith('ed2k:')) return true
  if (NON_DOWNLOAD_HOST.test(url)) return false
  return /^https?:\/\//i.test(url)
}

/** NetdiskKind → the store's SourceType. Kinds the store doesn't model collapse to
 *  'unknown' (still shown via netdiskLabel), so verify/save's supported set is unaffected. */
export function toSourceType(kind: NetdiskKind): import('../types.ts').SourceType {
  switch (kind) {
    case 'magnet':
    case 'ed2k':
    case 'quark':
    case 'baidu':
    case 'aliyun':
      return kind
    default:
      return 'unknown'
  }
}

/** Human label for a netdisk kind (for display when SourceType collapses to unknown). */
export const NETDISK_LABEL: Record<NetdiskKind, string> = {
  magnet: '磁力',
  ed2k: 'ed2k',
  quark: '夸克',
  uc: 'UC',
  tianyi: '天翼',
  baidu: '百度',
  aliyun: '阿里',
  xunlei: '迅雷',
  pan123: '123',
  p115: '115',
  unknown: '其他',
}
