// src/audio/ref.ts
import type { Item } from '../content/types.ts'
import type { TrackRef } from './resolver.ts'
import { albumFromText } from '../../shared/music/album.ts'

/** Pull a downloadable/archivable track reference off an item. Prefers the structured
 *  platform/track_id the normalizer now emits; falls back to a resolve url's query. */
export function extractTrackRef(item: Item): TrackRef | null {
  const media = item.content?.media ?? []
  const author = typeof item.author === 'string' ? item.author : undefined
  for (const m of media) {
    if (m.kind !== 'audio' && m.kind !== 'link') continue
    const mm = m as { platform?: string; track_id?: string; url?: string; page_url?: string }
    if (mm.platform && mm.track_id) {
      return { platform: mm.platform, id: mm.track_id, title: item.title, artist: author, album: albumFromText(item.content?.text), pageUrl: mm.page_url }
    }
    // fallback: /api/media/tracks/resolve?platform=<platform>&id=<id>
    const u = mm.url ?? ''
    const qi = u.indexOf('?')
    if (qi >= 0) {
      const q = new URLSearchParams(u.slice(qi + 1))
      const platform = q.get('platform'); const id = q.get('id')
      if (platform && id) return { platform, id, title: item.title, artist: author, album: albumFromText(item.content?.text), pageUrl: mm.page_url }
    }
  }
  return null
}
