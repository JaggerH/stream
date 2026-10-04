import type { StoredItem } from '../item-store.ts'
import type { PresentedItem } from './presented-item.ts'

/**
 * Serve-time gate for `resolveOnly` audio (paid podcast episodes: no origin fallback, no resolve
 * Provider — playable only if a netdisk mapping has the file). When `lookup` returns no hit for
 * `platform:track_id`, downgrade the media to cover-only so the row renders as a disabled/greyed
 * item instead of erroring on play. Matched episodes keep their playable audio untouched.
 * Items without resolveOnly audio (free podcasts, ordinary non-paid platform tracks, everything
 * else) pass through.
 *
 * **这是播放视图，不是库存**：降级那一手把整条音频换成一张封面图，时长与 `track_id` 随之消失。
 * 任何回答「库里存了什么」的判断（网盘整理的权威清单、匹配、账本）**不得消费它的产物**——
 * 那会把"没配上"读成"库里就没有时长"。返回的 `PresentedItem` 在类型上就赋不回 `StoredItem`，
 * 这条契约由编译器守着（见 `presented-item.ts`）。
 */
export function gateResolveOnlyMedia(
  items: (StoredItem | PresentedItem)[],
  lookup?: (leftKey: string) => unknown,
): PresentedItem[] {
  return items.map((it) => {
    const content = it.content
    const media = content?.media
    if (!content || !media?.length) return it
    const ao = media.find((m) => m.kind === 'audio' && m.resolveOnly && m.platform && m.track_id)
    if (!ao || ao.kind !== 'audio') return it
    if (lookup?.(`${ao.platform}:${ao.track_id}`)) return it // matched → stays playable
    const nextMedia = ao.poster
      ? [{ kind: 'image' as const, url: ao.poster }]
      : media.filter((m) => m.kind !== 'audio')
    return { ...it, content: { ...content, media: nextMedia } }
  })
}
