import { pluginTarget, type PluginTargetOpts } from '../plugins/plugin-target.ts'
import { withAwake } from '../plugins/standby/hook.ts'
import type { DiarizedSegment } from './resolve.ts'

/**
 * 容器对**这一窗内的一个说话人**给出的干净代表：把他名下若干段音频**拼起来**（≤20s）
 * 重算的一个 embedding，而不是每段各算一个。
 *
 * 为什么要它：距离的噪声由音频量主导——块长实测（`docs/research/voiceprint-clustering.md`）
 * 同人 p95 在 1s 时 0.80、2s 时 0.69，到 8s 才首次出现可用刀口。段级 embedding 各自只摊到
 * 两三秒，**求平均抹不掉「每段太少」这个根子**（均值降的是采样方差，不是每个样本自身的信息量）。
 */
export interface WindowSpeakerRep {
  speaker: string
  embedding: number[]
  /** 实际拼进去的秒数（≤ 容器的 REP_CLIP_S）。诊断用，不参与判定。 */
  clipSeconds: number
  /**
   * 容器的**帧级人声门控**判这个人本窗攒不够干净人声（<8s），主动弃权：`embedding` 为空。
   *
   * ⚠ 弃权 ≠ 缺省。缺省（整个 `speakers` 没有这一条）意思是「老容器/关了二次归组，
   * 没人算过干净代表」，此时退回段级时长加权均值是对的。弃权是容器**看过音频之后**说
   * 「这段音频回答不了『这是谁』」——段级均值同样从那段脏音频来，退回去等于把刚拦下的
   * 东西又放进来。所以下游对这两种情况必须分开处理（见 `mergeWindows`：弃权者不当锚点）。
   */
  abstained?: boolean
  /** 门控后剩下多少秒人声。诊断用（调门控阈值时看它），不参与判定。 */
  gatedSeconds?: number
}

export interface DiarizeResult {
  modelVersion: string
  segments: DiarizedSegment[]
  /** 容器版本较老 / 关掉二次归组时缺省——调用方必须能退回段级均值。 */
  speakers?: WindowSpeakerRep[]
}

/** Resolve the voiceprint engine base url (server-side fetch base): explicit → VOICEPRINT_URL
 *  env → bootstrap-injected plugin target (compose container DNS; none → '').
 *
 *  `opts.peek` 只给**纯探测**的调用方（`configured()`，见下）：那种问法在 host 档容器睡着时
 *  必然答空，喊出来是噪音。**整个函数不能静音**——它同时被真实取数路径（`base` getter，在
 *  withAwake 回调里求值）调用，那一端答空是真故障，必须留着喊声。 */
export function resolveVoiceprintUrl(explicit?: string, opts?: PluginTargetOpts): string {
  return (explicit ?? process.env.VOICEPRINT_URL ?? pluginTarget('voiceprint', opts) ?? '').replace(/\/$/, '')
}

/** Thin client over the sherpa-onnx voiceprint serving image. `diarize` returns who-spoke-when
 *  spans WITH each span's speaker embedding (one pass); `embed` embeds a single clip. Stateless
 *  — it knows no identities. */
export class VoiceprintEngineClient {
  constructor(private readonly explicitUrl?: string) {}

  /** 惰性:host 档下 origin 是容器醒着时才存在的(standby Cell 缓存),构造期快照必得空串。
   *  每次求值现解析;fetch 都在 withAwake 回调里,求值时容器已醒。compose 档恒定,无行为差。 */
  get base(): string {
    return resolveVoiceprintUrl(this.explicitUrl)
  }
  /** 「管不管得着」——纯探测（identifyReady → GET /api/conversion-kinds 每次都问一遍），
   *  不发请求、不唤醒。走窥视档：睡着时答空是正确答案，不进 `plugin-target` 故障频道。 */
  configured(): boolean {
    return resolveVoiceprintUrl(this.explicitUrl, { peek: true }).length > 0
  }

  async diarize(
    bytes: Uint8Array,
    mime: string,
    opts?: { hint?: 'accuracy' | 'fast'; signal?: AbortSignal }
  ): Promise<DiarizeResult> {
    const fd = new FormData()
    fd.append('file', new Blob([bytes as unknown as BlobPart], { type: mime }), 'audio')
    if (opts?.hint) fd.append('hint', opts.hint)
    // withAwake：diarize 单次调用可能跑很久，全程持引用防 reaper 中途停容器。
    const r = await withAwake('voiceprint', () =>
      fetch(`${this.base}/diarize`, { method: 'POST', body: fd, signal: opts?.signal })
    )
    if (!r.ok) throw new Error(`[voiceprint] diarize HTTP ${r.status}`)
    const j = (await r.json()) as {
      model_version?: string
      segments?: { start?: number; end?: number; speaker?: string; embedding?: number[] }[]
      speakers?: { speaker?: string; embedding?: number[]; clip_seconds?: number; abstained?: boolean; gated_seconds?: number }[]
    }
    const segments: DiarizedSegment[] = (j.segments ?? []).map((s) => ({
      start: s.start ?? 0,
      end: s.end ?? 0,
      speaker: s.speaker ?? 'SPEAKER_00',
      embedding: s.embedding ?? [],
    }))
    // 弃权条目（空 embedding + abstained）必须留下来往下传：它携带的是「容器看过音频后
    // 拒绝作答」这个信息，被过滤掉就退化成「缺省」，下游会拿段级均值把脏音频放回来。
    const speakers = j.speakers
      ?.filter((s) => s.speaker && (s.embedding?.length || s.abstained))
      .map((s) => ({
        speaker: s.speaker!,
        embedding: s.embedding ?? [],
        clipSeconds: s.clip_seconds ?? 0,
        ...(s.abstained ? { abstained: true as const } : {}),
        ...(s.gated_seconds !== undefined ? { gatedSeconds: s.gated_seconds } : {}),
      }))
    return { modelVersion: j.model_version ?? 'unknown', segments, ...(speakers?.length ? { speakers } : {}) }
  }

  /** 问一批区间「这段里人声帧占比多少、算不算非人声」。
   *
   *  给谁用：`shards.ts` 在跨窗合并后圈出结构上像掌声的簇，回来要第二个信号。
   *  阈值不在这一侧传——它跟帧模型同住容器，两处各写一份必然分叉（见容器 SHARD_SPEECH_MAX 头注）。
   *  `nonspeech` 已经是容器按自己阈值下的判定，调用方直接用，别自己拿 frac 再判一遍。 */
  async speechFrac(
    bytes: Uint8Array,
    mime: string,
    intervals: readonly [number, number][],
    signal?: AbortSignal
  ): Promise<{ start: number; end: number; frac: number | null; nonspeech: boolean }[]> {
    if (!intervals.length) return []
    const fd = new FormData()
    fd.append('file', new Blob([bytes as unknown as BlobPart], { type: mime }), 'audio')
    fd.append('intervals', JSON.stringify(intervals))
    const r = await withAwake('voiceprint', () =>
      fetch(`${this.base}/speech-frac`, { method: 'POST', body: fd, signal })
    )
    if (!r.ok) throw new Error(`[voiceprint] speech-frac HTTP ${r.status}`)
    const j = (await r.json()) as {
      items?: { start?: number; end?: number; frac?: number | null; nonspeech?: boolean }[]
    }
    return (j.items ?? []).map((x) => ({
      start: x.start ?? 0,
      end: x.end ?? 0,
      frac: x.frac ?? null,
      nonspeech: x.nonspeech === true,
    }))
  }

  async embed(bytes: Uint8Array, mime: string, signal?: AbortSignal): Promise<{ modelVersion: string; embedding: number[] }> {
    const fd = new FormData()
    fd.append('file', new Blob([bytes as unknown as BlobPart], { type: mime }), 'audio')
    const r = await withAwake('voiceprint', () => fetch(`${this.base}/embed`, { method: 'POST', body: fd, signal }))
    if (!r.ok) throw new Error(`[voiceprint] embed HTTP ${r.status}`)
    const j = (await r.json()) as { model_version?: string; embedding?: number[] }
    return { modelVersion: j.model_version ?? 'unknown', embedding: j.embedding ?? [] }
  }
}
