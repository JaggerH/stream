// src/conversions/converters/identify.ts
//
// 「识别说话人」：对一个 item 的音频跑 diarization + 认名，**不跑 STT**——这正是它单独成 kind
// 的理由（补名不用再付一次 whisper 的钱）。
//
// **转写不是前提**。识别只需要音频：diarization 时间线落进声纹库（`registry.putItemTimeline`，
// 在 identify fn 内部），文字只是自我介绍抽名的可选输入。没有转写就只做纯 diarization，
// 一样是成功。
//
// **时间线是唯一产物落点**（读口在 src/voiceprint/view.ts，投影读时现算）：这里不回灌上游、
// 也不在自己的 result 里存带名字的 segments——那两份快照曾经各自过时、各叫各的名字，
// 收敛始末见 docs/superpowers/specs/2026-08-15-speaker-single-source-design.md。
// 它的失败模式是「没补上」，不是「弄坏了」：任何一步不成都不碰已存的转写结果。
import type { Media } from '../../content/types.ts'
import type { MediaBytes } from '../../transcribe/media.ts'
import type { TranscriptSegment } from '../../transcribe/client.ts'
import type { IdentifyFn, IdentifyWindowing } from '../../voiceprint/identify.ts'
import { alignTextToClusters } from '../../voiceprint/resolve.ts'
import type { ConversionStore } from '../store.ts'
import type { Converter, ConversionContext } from '../runner.ts'

export interface IdentifyConverterDeps {
  store: ConversionStore
  resolveMedia: (handle: string, mediaHint: Media[] | undefined) => Promise<MediaBytes | null>
  identify: IdentifyFn
  available: () => boolean
  resolveIntroNames?: (itemId: string, segs: TranscriptSegment[]) => Promise<TranscriptSegment[]>
  /** 从时间线重算该 item 的出现账（口径统一：时间线是唯一账源，见 spec §3.4）。 */
  recordAppearances?: (itemId: string) => void
  /** 读回刚落库的 diarization 时间线（probe 的数据源）。 */
  readTimeline?: (itemId: string) => { start: number; end: number; speaker: string }[]
  /** 重聚类前回收该 item 的旧聚类向量（否则上一轮的 SPEAKER_NN 残留在 registry 里）。 */
  onRecluster?: (itemId: string) => void
  makeWindowing?: (ctx: ConversionContext, onDegrade: (e: unknown) => void) => IdentifyWindowing | undefined
}

/** 上游那条 extract 的产物。合同是 `text`；时间轴与媒体是**转写分支特有**的，在 detail 下
 *  ——所以「上游有没有时间轴」同时也是「上游是不是一条转写」的判据。 */
interface ExtractResult {
  text?: string
  detail?: { lang?: string; segments?: TranscriptSegment[]; media?: Media[] }
}

/** 这次 diarization 探到了什么。**这份账是后面定阈值的唯一数据来源**——「什么内容值得往上
 *  再加一层」不能靠猜，没量过的阈值只是一个装作有判据的猜测（见
 *  docs/superpowers/specs/2026-08-14-extract-progressive-ladder-design.md §8）。 */
export interface IdentifyProbe {
  speakerCount: number
  /** 有人在说话的总秒数（不是媒体时长——静音和音乐不算）。 */
  spokenSeconds: number
  /** 每个簇说了多久，长的在前。 */
  clusters: Array<{ label: string; seconds: number }>
}

/**
 * 把 diarization 时间线折成一份读数。
 *
 * **读时间线，不读转写段。** 没有转写时 identify 返回的是空数组（对齐的输入就是空的），
 * 拿它算会把所有没转写过的 item 记成「0 个说话人」——而那恰恰是这份账最该覆盖的一类。
 */
export function probeOf(
  timeline: readonly { start: number; end: number; speaker: string }[]
): IdentifyProbe {
  const byCluster = new Map<string, number>()
  for (const s of timeline) {
    const dur = s.end - s.start
    // 零时长/负时长不是发言。放进去会凭空多出一个说话人，而 speakerCount 正是下游的判据。
    if (!(dur > 0)) continue
    byCluster.set(s.speaker, (byCluster.get(s.speaker) ?? 0) + dur)
  }
  // spokenSeconds 只在总数上舍入一次——真实时间戳是浮点秒，多簇时「各分项先舍入再相加」会
  // 累积舍入误差，账对不上真实总时长。clusters[].seconds 各自舍入是给人看的展示近似，
  // 两者不必相等：spokenSeconds 是账，clusters 是分项，别指望 sum(clusters.seconds) === spokenSeconds。
  // 重叠发言按簇各计一次，不去重：两人同时说 10s 会记成 20s（两个 speaker 各自的时间线都有
  // 这 10s）。将来拿它当密度分母时要知道这个口径——它不是「有人在说话的墙钟时长」。
  const rawTotal = [...byCluster.values()].reduce((n, s) => n + s, 0)
  const clusters = [...byCluster]
    .map(([label, seconds]) => ({ label, seconds: Math.round(seconds) }))
    .sort((a, b) => b.seconds - a.seconds)
  return { speakerCount: clusters.length, spokenSeconds: Math.round(rawTotal), clusters }
}

export function makeIdentifyConverter(deps: IdentifyConverterDeps): Converter {
  return {
    kind: 'identify',
    label: '补说话人',
    stages: ['media', 'diarize'],
    available: deps.available,
    async run(ctx) {
      // 上游那条正文**如果有**：显式 inputId 优先，否则取该 item 最新的一条 extract。
      // 这一读只为拿**媒体线索**——它此刻很可能还在跑（这条和取白文是同时开工的），
      // 所以不在这里读 segments，那一读要等到 diarization 完事之后（见下面）。
      const upstream = ctx.inputId ? deps.store.get(ctx.inputId) : deps.store.latestFor(ctx.itemId, 'extract')
      const upstreamMedia = (upstream?.result as ExtractResult | undefined)?.detail?.media
      // 上游还没产出 media 时退到 item 自己的（路由/并肩起跑都会把它递进 options）。
      // 少了这条兜底，并肩起跑的常态就是「上游还没跑完 → 拿不到线索 → no_media」。
      const mediaHint = upstreamMedia ?? (ctx.options.media as Media[] | undefined)

      const m = await ctx.stage('media', () => deps.resolveMedia(ctx.itemId, mediaHint))
      if (ctx.signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'cancelled' } }
      if (!m) return { ok: false, error: { code: 'no_media', message: 'no transcribable media' } }

      deps.onRecluster?.(ctx.itemId)

      const outcome = await ctx.stage('diarize', async () => {
        let degraded: { err: unknown } | null = null
        const windowing = deps.makeWindowing?.(ctx, (err) => (degraded = { err }))
        const named = await deps.identify(ctx.itemId, m.bytes, m.mime, ctx.signal, windowing)
        return { named, degraded }
      })
      if (ctx.signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'cancelled' } }
      if (outcome.degraded) {
        // identify 契约不 throw——降级时它返回原 segs，从返回值看不出来，只能靠 onDegrade 旁路
        // 分账。这里如实报失败：这条 kind 的**全部**意图就是补名，没补上就是没成。
        return { ok: false, error: { code: 'degraded', message: '声纹归名降级（未补上说话人）' } }
      }

      // —— 到这里才去读转写 ——
      // **这一读是并行的全部关窍。** 起跑时上游多半还没跑完（取白文 20–140s，分人 200–900s），
      // 那时读只会读到空。等分人跑完再读，取白文早已落定，抽名照做不误。
      // 真碰上上游还没好（或这条 item 压根没转写）：抽名跳过，时间线照样落库、照样成功
      // ——这条 kind 答的是「谁在说」，那件事已经做完了。
      const fresh = upstream ? deps.store.get(upstream.id) : deps.store.latestFor(ctx.itemId, 'extract')
      const freshResult = fresh?.result as ExtractResult | undefined
      const textSegs = fresh?.status === 'done' && freshResult?.detail?.segments?.length ? freshResult.detail.segments : []

      // 抽名要文字（自我介绍句）：把标签投影到文字段上只为喂它，投影本身不落库——
      // 「名字贴在文字上」是读口（view.ts）读时现算的形态。抽出的改名由 intro-names 直接写进
      // 时间线（renameInTimeline），所以这里丢弃返回值也不丢任何东西。
      if (deps.resolveIntroNames && textSegs.length) {
        try {
          await deps.resolveIntroNames(ctx.itemId, alignTextToClusters(textSegs, outcome.named))
        } catch {
          /* 抽名失败不该让补名整体失败——时间线上保留声纹匹配出的名字 */
        }
      }

      // 出现账与 probe 都以时间线为源（此刻抽名的改名已落进去）。
      const timeline = deps.readTimeline?.(ctx.itemId) ?? []
      deps.recordAppearances?.(ctx.itemId)
      return { ok: true, result: { probe: probeOf(timeline) } }
    },
  }
}
