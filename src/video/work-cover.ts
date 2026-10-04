import type { ItemStore } from '../item-store.ts'

/**
 * Work cover (level-1 poster) for a video Stream — the RSSHub feed's top-level image
 * (album/series poster) is stamped onto each item's author_avatar at harvest
 * (stampFeedFields); fall back to the first item media image. Portrait poster, distinct
 * from landscape episode thumbs. Shared by /api/channels' 正在追 enrichment and the
 * collected-works migration (both need the same "what's this work's poster" answer).
 */
export function videoWorkCover(itemStore: ItemStore, streamId: string): string | undefined {
  const recent = itemStore.recent({ stream: streamId, limit: 30 })
  for (const it of recent) if (it.author_avatar) return it.author_avatar
  for (const it of recent) {
    // kind:'image' media carries its URL in `url`, not `image` (that key only exists on
    // kind:'link') — a recipe-sourced item (no feed-level image to stamp onto author_avatar,
    // see above) falls through to here with exactly that shape.
    const img = (it.content?.media ?? [])
      .map((m) => (m.kind === 'image' ? m.url : 'poster' in m ? m.poster : 'image' in m ? m.image : undefined))
      .find((p) => !!p)
    if (img) return img
  }
  return undefined
}
