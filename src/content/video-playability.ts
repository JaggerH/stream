import type { StoredItem } from '../item-store.ts'
import type { PresentedItem } from './presented-item.ts'

/**
 * Serve-time gate for episodes in streams managed by an AList binding. A binding means that
 * episode playback must go through the item mapping: a matched item gets a same-origin resolve
 * URL, while an unmatched item remains visible as an explicitly disabled video card. Streams
 * without a binding retain their normalizer-provided media unchanged.
 *
 * **这是播放视图，不是库存**（同 `paid-playability.ts`）：绑定管着的分集，media 整个被换成
 * resolve 直链或一张禁用卡，原条目带的时长随之消失。产出 `PresentedItem`——赋不回 `StoredItem`，
 * 「库里存了什么」的判断够不着它。
 */
export function gateResolveOnlyVideoMedia(
  items: (StoredItem | PresentedItem)[],
  lookup?: (leftKey: string) => unknown,
  hasBinding?: (streamId: string) => boolean,
  isVideoStream?: (streamId: string) => boolean,
): PresentedItem[] {
  return items.map((item) => {
    if (!hasBinding?.(item.stream_id) || !isVideoStream?.(item.stream_id) || !item.content) return item

    const poster = item.content.media?.find((media) => media.kind === 'image' || media.kind === 'video')
    const posterUrl = poster?.kind === 'image' ? poster.url : poster?.poster
    const hit = lookup?.(`item:${item.id}`)
    const video = hit
      ? { kind: 'video' as const, url: `/api/media/videos/resolve?id=${encodeURIComponent(item.id)}`, poster: posterUrl, resolveOnly: true }
      : { kind: 'video' as const, poster: posterUrl, resolveOnly: true }

    return { ...item, content: { ...item.content, media: [video] } }
  })
}
