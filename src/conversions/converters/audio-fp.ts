// src/conversions/converters/audio-fp.ts
//
// 声学指纹作为一种 conversion：media（取字节，复用转写那条统一漏斗）→ fingerprint（本地
// chromaprint）。产物是归堆判「同一份录音」的身份牌，**不是给人读的正文**——绝不混进
// extract 的记录。消费方：src/story-fold/fp-source.ts。
// 设计：docs/superpowers/specs/2026-08-23-audio-fingerprint-fold-design.md §3.3。
import type { Media } from '../../content/types.ts'
import type { MediaBytes } from '../../transcribe/media.ts'
import { encodeFingerprint } from '../../media/audio-fingerprint.ts'
import type { Converter } from '../runner.ts'

export interface AudioFpConverterDeps {
  /** 取这条 item 的媒体字节——与转写共用同一条漏斗与落盘缓存（归档→网盘→官方源→直链）。 */
  resolveMedia: (handle: string, mediaHint: Media[] | undefined) => Promise<MediaBytes | null>
  /** 算指纹（引擎已在装配处探测绑定；这里只收函数，不认识 ffmpeg/fpcalc）。 */
  fingerprint: (bytes: Uint8Array, mime: string, signal: AbortSignal) => Promise<Uint32Array>
  /** 指纹引擎此刻在不在（探测是异步的，这必须是 thunk 不是快照）。 */
  available: () => boolean
}

/** chromaprint 的项密度（实测 ~6–7/秒）。只用于 durationS 缺席时估 totalS——
 *  偏移窗的秒↔项换算靠它，判据（相似度/重叠）不靠它。 */
const ITEMS_PER_SECOND_ESTIMATE = 7

export function makeAudioFpConverter(deps: AudioFpConverterDeps): Converter {
  return {
    kind: 'audio-fp',
    label: '声学指纹',
    stages: ['media', 'fingerprint'],
    available: deps.available,
    async run(ctx) {
      const mediaHint = ctx.options.media as Media[] | undefined
      const m = await ctx.stage('media', () => deps.resolveMedia(ctx.itemId, mediaHint))
      if (!m) return { ok: false, error: { code: 'no_media', message: 'no fingerprintable media' } }
      try {
        const fp = await ctx.stage('fingerprint', () => deps.fingerprint(m.bytes, m.mime, ctx.signal))
        if (ctx.signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'cancelled' } }
        if (fp.length === 0) return { ok: false, error: { code: 'fp_failed', message: '指纹为空（媒体里没有音轨？）' } }
        const durationS = typeof ctx.options.durationS === 'number' ? ctx.options.durationS : undefined
        return { ok: true, result: { fp: encodeFingerprint(fp), items: fp.length, totalS: durationS ?? fp.length / ITEMS_PER_SECOND_ESTIMATE } }
      } catch (e) {
        // 真实引擎（runCapture / execFile）接了 AbortSignal，abort 时是 reject 不是正常 resolve
        // 后再检查 aborted——不先判就会把用户取消误归成 fp_failed，错误消息是一句 AbortError
        // 文案，把人指向"引擎坏了"而不是"用户点了取消"。
        if (ctx.signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'cancelled' } }
        // 引擎的原话要走到记录里——「取到了字节但算不出」和「没有媒体」是两个排查方向。
        return { ok: false, error: { code: 'fp_failed', message: (e as Error).message } }
      }
    },
  }
}
