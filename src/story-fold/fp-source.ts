// 归堆要的「这条媒体的声学指纹」——与 text-source 同构：先查账本，没有就排一次、告诉
// worker 等下一轮。**绝不同步等**（3 小时媒体的下载+解码在分钟级）。
// null 的三种含义（对 worker 是同一个处置——走文本路）：不是媒体 / 引擎不可用 / 算过但失败。
import type { ConversionStore } from '../conversions/store.ts'
import type { StoredItem } from '../item-store.ts'
import { transcribableMedia } from '../transcribe/media.ts'
import { decodeFingerprint } from '../media/audio-fingerprint.ts'

export interface FpSource {
  fpFor(itemId: string): Promise<{ fp: Uint32Array; totalS: number } | 'pending' | null>
  /** 这条有没有可指纹的媒体——纯查询，绝不排队。worker 用它先验"这是不是媒体对"。 */
  hasFingerprintableMedia(itemId: string): boolean
}

export interface FoldFpSourceDeps {
  conversions: ConversionStore
  /** 排一次 audio-fp。已有记录时 runner 自己按 (item, kind) 去重。 */
  requestFp: (item: StoredItem) => void
  itemOf: (itemId: string) => StoredItem | undefined
  /** 指纹引擎此刻在不在（探测是异步的，thunk 不是快照）。 */
  available: () => boolean
}

export function makeFoldFpSource(deps: FoldFpSourceDeps): FpSource {
  return {
    // 只答"是不是媒体"，不看 available()——引擎在不在由 fpFor 管。这里一旦掺进引擎状态，
    // worker 就分不出"跨形态对"和"引擎没起来"，而这两种的处置本来就该一样地不排队。
    hasFingerprintableMedia(itemId) {
      const item = deps.itemOf(itemId)
      return !!item && !!transcribableMedia(item.content?.media)
    },
    async fpFor(itemId) {
      if (!deps.available()) return null
      const done = deps.conversions.latestFor(itemId, 'audio-fp')
      if (done?.status === 'done') {
        const r = done.result as { fp?: string; totalS?: number } | undefined
        if (typeof r?.fp !== 'string' || !r.fp) return null
        return { fp: decodeFingerprint(r.fp), totalS: r.totalS ?? 0 }
      }
      if (done && (done.status === 'queued' || done.status === 'running')) return 'pending'
      if (done?.status === 'error') return null // 算过了但失败——重排也是同样的结果，交给 runner 的 retry
      const item = deps.itemOf(itemId)
      if (!item || !transcribableMedia(item.content?.media)) return null
      deps.requestFp(item)
      return 'pending'
    },
  }
}
