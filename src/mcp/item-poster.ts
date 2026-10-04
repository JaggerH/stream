// src/mcp/item-poster.ts
//
// 「这条 item 的缩略图是哪张」——**一份判据**，写进转换记录的 `snapshot.poster`，
// 由对话里的卡片画出来（`ExtractCard` 的 ItemHead）。
//
// `ConversionSnapshot.poster` 这个位置从建表起就在，只是从来没人填——于是每张工具卡都
// 只能画一行标题。一张图能让用户一眼认出"这是我刚点的那条"，比一行 id 强得多。
//
// 纯函数：只看媒体描述符，不打网络、不猜。取不到就 `undefined`（卡片自己会退回纯文字，
// 不留空框）。

import type { Media } from '../content/types.ts'

/**
 * 挑一张能代表这条内容的图。
 *
 * 顺序即优先级，理由是"哪张最像封面"：视频/音频自带的 `poster` 就是封面；再退到第一张
 * 图片（图集的首图）；链接卡的 `image` 放最后——它常常是站点 logo 而不是内容本身。
 *
 * @param media - `content.media`。缺席/空数组 → `undefined`。
 */
export function posterOf(media: readonly Media[] | undefined): string | undefined {
  if (!media || media.length === 0) return undefined
  for (const m of media) {
    if ((m.kind === 'video' || m.kind === 'audio') && typeof m.poster === 'string' && m.poster !== '') return m.poster
  }
  for (const m of media) {
    if (m.kind === 'image') {
      // `thumb` 优先：图集首图的原图可能是几 MB，而这里只是一个 64px 的角标。
      if (typeof m.thumb === 'string' && m.thumb !== '') return m.thumb
      if (typeof m.url === 'string' && m.url !== '') return m.url
    }
  }
  for (const m of media) {
    if (m.kind === 'link' && typeof m.image === 'string' && m.image !== '') return m.image
  }
  return undefined
}
