// src/conversions/converters/stt.ts
//
// 转写（STT）作为一种 conversion。重构前这条链路自带队列 + 状态机 + 唤醒重排 + 账本接线
// （src/transcribe/service.ts，581 行）；现在它只剩「怎么跑一次」：
//   media（取音频）→ asr（打 STT 阶梯）→ diarize（声纹归名，可选）
// 三个阶段各自计时，这正是本次重构要回答的那个问题：Whisper 和 diarization 各花了多久。
//
// 两处语义特意保留原样：
//  - 唤醒超时（standby 容器还在装权重）不是失败,而是 `retryable` —— runner 据此延迟重排整条阶梯。
//    梯子只管跨成员 failover,「没赢但可重试」归任务层,两种语义干净分离(见原 service.ts 的注)。
//  - identify 是 STT 的**加菜**:它降级/失败不该让 transcript 整体失败(转写已经交付了)。
import type { Media } from '../../content/types.ts'
import type { MediaBytes } from '../../transcribe/media.ts'
import type { InvokeResult } from '../../providers/executor.ts'
import { buildResolveEntry } from '../../providers/debug-entry.ts'
import { ladderTrace } from '../../providers/ladder-trace.ts'
import type { DebugEntry } from '../../debug.ts'
import type { TranscribeResult, TranscriptSegment } from '../../transcribe/client.ts'
import type { IdentifyFn, IdentifyWindowing } from '../../voiceprint/identify.ts'
import { alignTextToClusters } from '../../voiceprint/resolve.ts'
import type { ConversionContext } from '../runner.ts'
import type { ExtractBranchRunner } from './extract.ts'

export interface SttConverterDeps {
  resolveMedia: (handle: string, mediaHint: Media[] | undefined) => Promise<MediaBytes | null>
  invokeTranscribe: (input: {
    bytes: Uint8Array
    mime: string
    opts?: { diarize?: boolean; translate?: boolean }
    signal?: AbortSignal
  }) => Promise<InvokeResult | null>
  available: () => boolean
  onDebug?: (entry: DebugEntry) => void
  identify?: IdentifyFn
  /** identify 此刻能不能用（host 档下 engine 容器可能没醒）——不能只看 identify 在不在。 */
  identifyReady?: () => boolean
  resolveIntroNames?: (itemId: string, segs: TranscriptSegment[]) => Promise<TranscriptSegment[]>
  /** 从时间线重算该 item 的出现账（口径统一：时间线是唯一账源，见 speaker-single-source spec §3.4）。 */
  recordAppearances?: (itemId: string) => void
  /** 分窗断点续跑的上下文（挂在 ctx.jobDir 下）；不传 = 不分窗，identify 一口气跑完。 */
  makeWindowing?: (ctx: ConversionContext, onDegrade: (e: unknown) => void) => IdentifyWindowing | undefined
  /** 入队即预热本地 standby ASR 容器（fire-and-forget）。 */
  prewarm?: () => void
}

export function makeSttConverter(deps: SttConverterDeps): ExtractBranchRunner {
  const ready = () => (deps.identifyReady ? deps.identifyReady() : !!deps.identify)

  return {
    stages: ['media', 'asr', 'diarize'],
    available: deps.available,
    options: { diarize: 'boolean', translate: 'boolean' },
    async run(ctx) {
      const mediaHint = ctx.options.media as Media[] | undefined
      const diarize = !!ctx.options.diarize
      const translate = !!ctx.options.translate

      const m = await ctx.stage('media', () => deps.resolveMedia(ctx.itemId, mediaHint))
      if (!m) return { ok: false, error: { code: 'no_media', message: 'no transcribable media' } }

      // 声纹 engine 在场时它才是 diarizer，STT 只需要纯 ASR 文本——再让 CF-Whisper 去 diarize
      // 它会 decline，整条转写跟着失败。
      const sttDiarize = diarize && !ready()
      const inv = await ctx.stage('asr', () =>
        deps.invokeTranscribe({ bytes: m.bytes, mime: m.mime, opts: { diarize: sttDiarize, translate }, signal: ctx.signal })
      )
      if (ctx.signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'cancelled' } }

      // 把 executor 阶梯（哪个 STT 源赢了 / 每个为什么没中）投给 debug box。
      deps.onDebug?.(buildResolveEntry('transcribe', 'stt', ctx.itemId, inv, { verb: '转写' }))
      // 同一份走法**也存进记录**：debug box 是一次性的，关掉就没了；事后问"这份转写是谁做的"
      // 只能从记录里查。
      const ladder = ladderTrace(inv ?? null)

      const res = inv && inv.strategy === 'sequential' ? (inv.value as TranscribeResult[] | null)?.[0] : undefined
      if (!res) {
        const misses = inv && 'misses' in inv ? inv.misses : []
        const reasons = misses.map((x) => `${x.member}: ${x.reason}`).join('; ')
        // 唤醒超时 ≠ 任务失败：某个成员的容器还在装权重，过一会儿它就绿了。
        const retryable = misses.some((x) => x.retryable)
        return {
          ok: false,
          error: {
            code: retryable ? 'wake_timeout' : 'all_sources_missed',
            message: reasons || '转写失败（所有源均未成功）',
          },
          retryable,
          ladder,
        }
      }

      let segments = res.segments
      if (deps.identify && ready() && diarize && segments?.length) {
        segments = await ctx.stage('diarize', async () => {
          let degraded: { err: unknown } | null = null
          const windowing = deps.makeWindowing?.(ctx, (err) => (degraded = { err }))
          // identify 只答「谁在说」（一条时间线），投影到文字段上是这里自己做的一步。
          const timeline = await deps.identify!(ctx.itemId, m.bytes, m.mime, ctx.signal, windowing)
          if (ctx.signal.aborted || degraded) return segments // 降级 = 没补上；转写本身照常交付
          const named = alignTextToClusters(segments!, timeline)
          if (!deps.resolveIntroNames) return named
          try {
            return await deps.resolveIntroNames(ctx.itemId, named)
          } catch {
            return named // 抽名失败不该弄坏 transcript
          }
        })
      }
      if (ctx.signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'cancelled' } }

      if (segments?.length) deps.recordAppearances?.(ctx.itemId)
      return { ok: true, result: { text: res.text, lang: res.lang, segments, media: mediaHint }, ladder }
    },
  }
}
