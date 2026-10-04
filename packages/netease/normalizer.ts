import type { Content } from '../../src/content/types.ts'
import type { Normalizer, RawItem } from '../../src/content/normalize.ts'
import { extractImages, stripImages, toText } from '../../shared/package-sdk/html.ts'

/** Pull a NetEase song id out of a feed item's link/guid (e.g. music.163.com/song?id=123 or
 *  music.163.com/#/song?id=123). Returns undefined for non-song items (a playlist link etc.). */
export function neteaseSongId(raw: RawItem): string | undefined {
  const candidates = [raw.link, (raw as { guid?: unknown }).guid].filter((s): s is string => typeof s === 'string')
  for (const s of candidates) {
    // only SONG links carry a playable id — not user/home?id= or playlist?id=
    const m = s.match(/song\?id=(\d+)/) ?? s.match(/song\/(\d+)/)
    if (m) return m[1]
  }
  return undefined
}

/**
 * NetEase (网易云音乐) normalizer. RSSHub's 163/music routes carry song metadata + a page
 * link but NO playable file, so songs would render as plain text and be unplayable in 歌单.
 * Here we attach audio media carrying just the (platform, track_id) REFERENCE — the reader builds
 * the on-demand resolve route (`/api/media/tracks/resolve`) from it at play time; we never persist
 * the route itself (a stored route rots on endpoint rename). Items without a song id (e.g. a user's
 * playlist *list*) fall back to a plain link so they still show.
 */
export const neteaseNormalizer: Normalizer = (raw) => {
  const title = raw.title ? String(raw.title) : undefined
  const desc = String(raw.description ?? '')
  const text = toText(stripImages(desc)) || undefined
  const link = typeof raw.link === 'string' ? raw.link : undefined
  // native items carry an album cover in raw.picUrl; RSSHub 163 items embed an <img> in desc
  const poster = (typeof raw.picUrl === 'string' && raw.picUrl) || extractImages(desc)[0]?.url
  // VIP/paid detection: the RSSHub 163 route tags paid tracks with a 'VIP' category;
  // (legacy native items used a numeric fee 1|4 — kept for back-compat).
  const cats = Array.isArray(raw.category) ? (raw.category as unknown[]).map(String) : []
  const fee = typeof raw.fee === 'number' ? raw.fee : undefined
  const vip = cats.includes('VIP') || fee === 1 || fee === 4
  const id = neteaseSongId(raw)
  // 时长（秒）：RSSHub 163 路由输出 itunes_duration（秒数）；兼容 number / "秒字符串" / "HH:MM:SS"。
  const durRaw = (raw as { itunes_duration?: unknown }).itunes_duration
  const durationS =
    typeof durRaw === 'number' ? durRaw
      : typeof durRaw === 'string' && /^\d+$/.test(durRaw) ? Number(durRaw)
        : typeof durRaw === 'string' && durRaw.includes(':') ? durRaw.split(':').reduce((a, p) => a * 60 + Number(p), 0)
          : undefined

  if (id && !vip) {
    // Store only the REFERENCE (platform + track_id). We deliberately do NOT bake a resolve route
    // into the item: "where to resolve" is a program concern the reader builds from live code at
    // play time. Persisting it turned every endpoint rename into rotted data — that is exactly how
    // items ingested with the old /api/audio/resolve route 404'd after it was renamed.
    return {
      archetype: 'audio',
      title,
      text,
      media: [{ kind: 'audio', poster, page_url: link, platform: 'netease', track_id: id, duration_s: durationS }],
    }
  }

  // VIP/paid song: kept visible + downloadable via the netease-track Provider,
  // which resolves a playable/downloadable url through the catalog download routes.
  return {
    archetype: link ? 'link' : 'text',
    title,
    text,
    media: link
      ? [{ kind: 'link', url: link, title: vip ? `${title} (VIP)` : (title || link), image: poster, duration_s: durationS, ...(id ? { platform: 'netease', track_id: id } : {}) }]
      : undefined,
  }
}
