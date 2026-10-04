import type { ConversionStore } from '../conversions/store.ts'
import type { StoredItem } from '../item-store.ts'
import type { TextSource } from './worker.ts'

/**
 * 归堆要的"这条 item 的文本"——**直接复用转成文字（extract）那条链路**，不自己造转写。
 *
 * extract 已经把这件事做完了：它自己判分支（正文白拿 / 网页抓取 / 音视频转写）、
 * 结果按 item 存着、转过一次就不重复计费。这里只做两件事：先查有没有现成的，
 * 没有就排一次，然后告诉 worker「等下一轮」。
 *
 * **绝不同步等转写**：转写实测平均 16 秒、最慢 142 秒。worker 一轮里若干条，
 * 同步等就是把一轮拖到几分钟，而这条链路本来就该是"慢慢补齐"的。
 */

export interface FoldTextSourceDeps {
  conversions: ConversionStore
  /** 排一次 extract。已有记录时不会重复建（runner 自己按 (item, kind) 去重）。 */
  requestExtract: (item: StoredItem) => void
  /** 拿这条 item 的存储态（extract 要 content/url/media 才能判分支）。 */
  itemOf: (itemId: string) => StoredItem | undefined
  /**
   * 太长的音视频先不转。**这是成本闸门，现在只管文本路**：媒体对媒体已改走声学指纹
   * （见 fp-source.ts / 2026-08-23-audio-fingerprint-fold spec），这道门只拦"长媒体 × 文章"
   * 的跨形态组合——那种组合只能靠转写文本，而三小时的转写要几分钟。
   */
  maxMediaSeconds?: number
}

const DEFAULT_MAX_MEDIA_S = 20 * 60

export function makeFoldTextSource(deps: FoldTextSourceDeps): TextSource {
  const maxS = deps.maxMediaSeconds ?? DEFAULT_MAX_MEDIA_S
  return {
    async textFor(itemId) {
      // ① 已经取过了？白拿。
      const done = deps.conversions.latestFor(itemId, 'extract')
      if (done?.status === 'done') {
        const r = done.result as { text?: string; branch?: string } | undefined
        const text = typeof r?.text === 'string' ? r.text.trim() : ''
        if (text) return { text, source: r?.branch ?? 'extract' }
        return null // 取过了但没有正文——再排一次也是同样的结果
      }
      // ② 正在跑 / 排队中 → 下一轮再来。
      if (done && (done.status === 'queued' || done.status === 'running')) return 'pending'

      const item = deps.itemOf(itemId)
      if (!item) return null
      // ③ 太长的先不碰（成本闸门，只管文本路——媒体对走指纹，见 fp-source.ts）。
      const seconds = mediaSeconds(item)
      if (seconds !== undefined && seconds > maxS) return null

      deps.requestExtract(item)
      return 'pending'
    },
  }
}

function mediaSeconds(item: StoredItem): number | undefined {
  for (const m of item.content?.media ?? []) {
    if ((m.kind === 'video' || m.kind === 'audio') && typeof m.duration_s === 'number' && m.duration_s > 0) {
      return m.duration_s
    }
  }
  return undefined
}
