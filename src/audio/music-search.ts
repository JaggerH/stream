/** Call-site adapter for GET /api/search?scope=music.
 *
 *  music-search 是一条并发 Provider 行，成员是目录里的搜索路由。它们吐的是 RSSHub DataItem，
 *  不是音乐 UI 要的 track 形状，在这里映射一次。**曲目引用来自 `trackRefFromUrl`**——哪条链接
 *  是哪家的哪首歌，文法住在各自的包里（`stream.links.patterns`，kind track），这里不认识任何站
 *  （spec 2026-09-18-facility-knowledge-stage2-design §2.5）。认不出引用的条目直接丢：一条没有
 *  稳定 id 的“歌”进不了归档、对不上网盘、收藏不了，留着只是噪音。 */

import { albumFromText } from '../../shared/music/album.ts'
import { trackRefFromUrl, type TrackRef } from './track-url.ts'

export interface MusicSearchTrack {
  id: string
  platform: string
  trackId: string
  title: string
  artist?: string
  album?: string
  poster?: string
  durationS?: number
  /** the song's own page on the source platform — a real origin link, shown as 来源 and stored as
   *  `collected_item.source_url` when the track is collected. NOT a playback url: the player
   *  rebuilds `/api/media/tracks/resolve` from (platform, trackId) at play time. A resolve route
   *  used to be baked in here and one collected row still carries it (see the "don't persist
   *  routes" rule in src/content/normalize.ts). */
  sourceUrl: string
}

/** Raw RSSHub feed item fields we read (catalog search routes); everything optional. */
interface RawMusicItem {
  title?: string
  link?: string
  author?: string
  image?: string
  description?: string
  itunes_duration?: string
}

/** RSSHub titles are "曲名 - 歌手"; the artist shows separately, so drop the trailing " - 歌手". */
export function songTitle(title: string | undefined, artist: string | undefined, id: string): string {
  const t = (title ?? '').trim() || id
  return artist && t.endsWith(` - ${artist}`) ? t.slice(0, -(artist.length + 3)).trim() : t
}

/** "mm:ss" / "hh:mm:ss" → seconds (toubiec's itunes_duration). Absent/unparseable → undefined. */
function durationSeconds(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const parts = raw.trim().split(':').map((p) => Number(p))
  if (parts.some((n) => !Number.isFinite(n))) return undefined
  return parts.reduce((acc, n) => acc * 60 + n, 0) || undefined
}

export function rsshubItemsToTracks(
  items: unknown[],
  trackRef: (url: string) => TrackRef | null = trackRefFromUrl
): MusicSearchTrack[] {
  const out: MusicSearchTrack[] = []
  const seen = new Set<string>()
  for (const raw of items) {
    const it = raw as RawMusicItem
    const link = it.link
    const ref = typeof link === 'string' ? trackRef(link) : null
    if (!ref || link == null) continue
    const id = `${ref.platform}:${ref.track_id}`
    if (seen.has(id)) continue
    seen.add(id)
    const artist = typeof it.author === 'string' && it.author ? it.author : undefined
    out.push({
      id,
      platform: ref.platform,
      trackId: ref.track_id,
      title: songTitle(it.title, artist, ref.track_id),
      artist,
      album: albumFromText(it.description),
      poster: typeof it.image === 'string' ? it.image : undefined,
      durationS: durationSeconds(it.itunes_duration),
      sourceUrl: link,
    })
  }
  return out
}
