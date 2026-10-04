/**
 * 转写结果的形状。**这里只有类型**——转写本身由 `transcribe` 那条 Provider 梯子做
 * （Groq / Cloudflare / OpenAI，见 `sources.ts`），全是远端 API，Stream 自己不跑 ASR。
 */
import type { DroppedSegment } from './no-speech.ts'

/** A timed speech segment (VAD chunk ≈ one breath/sentence). `speaker` is filled later by the
 *  voiceprint engine — the ASR sources never set it. */
export interface TranscriptSegment {
  start: number
  end: number
  text: string
  speaker?: string
}

export interface TranscribeResult {
  text: string
  lang?: string
  segments?: TranscriptSegment[]
  /** 被判为模型编造、已筛掉的段（静音/音乐上凭空造句、复读循环）。见 `no-speech.ts`。
   *  **缺席（`undefined`）= 这条腿没有筛**（本地/其他后端不给判据字段）；空数组 = 筛过、没有编造。
   *  两者绝不能混——「没筛」被读成「没有编造」，正是这类静音缺陷的经典走法。 */
  dropped?: DroppedSegment[]
}
