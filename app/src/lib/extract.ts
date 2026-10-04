// app/src/lib/extract.ts
//
// 「转成文字」按钮的可见性判定——**不自己判**，调 shared/extract/plan.ts 那份唯一权威
// （后端 extract converter 选分支用的同一份代码）。以前这里是两个嗅探 helper 各自为政
// （playableVideo 管转写按钮、parseableSource 管解析按钮），收敛后按钮只有一个，判定也只有一份。
import { planExtract, type Content, type ExtractCapabilities } from '@extract/plan.ts'
import type { Item as StreamItem } from './types.ts'

export type { ExtractCapabilities }

/** caps 还没从 `/api/conversion-kinds` 回来时的初值：全 false → 按钮先不显示。
 *  宁可晚一拍出现，也别先亮出一个点了必失败的按钮。 */
export const NO_CAPS: ExtractCapabilities = { stt: false, ocr: false, article: false }

/** item.content → planExtract 的输入。renormalize 之前入库的老条目没有 archetype——
 *  给它们垫一个从媒体推出来的（**旧数据垫片**，不是第二份判定：新条目一律走存储的 archetype，
 *  权威判定始终在 shared/extract/plan.ts）。 */
export function toExtractContent(item: StreamItem): Content {
  const c = item.content
  const media = (c?.media ?? []) as Content['media']
  const archetype: Content['archetype'] =
    (c?.archetype as Content['archetype'] | undefined) ??
    ((media ?? []).some((m) => m.kind === 'video' || m.kind === 'audio')
      ? 'video'
      : (media ?? []).some((m) => m.kind === 'image')
        ? 'gallery'
        : item.url
          ? 'link'
          : 'text')
  return { archetype, text: c?.text, media, quoted: c?.quoted as Content['quoted'] }
}

/** 这条 item 显不显示「转成文字」按钮。`inline`（正文本来就在卡片上）不显示——
 *  对一条纯文字 post 按「转成文字」只会得到它已经展示着的那段字，按钮是噪音。 */
export function extractable(item: StreamItem, caps: ExtractCapabilities): boolean {
  const plan = planExtract(toExtractContent(item), caps, item.url)
  return plan.ok && plan.branch !== 'inline'
}
