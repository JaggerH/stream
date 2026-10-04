// src/voiceprint/view.ts
//
// 「这个 item 谁在什么时候说话」的**唯一读口**。
//
// 存储只有一份：声纹库时间线（item_diarization）。「名字贴在文字上」不是存储物，是这里
// 读时现算的投影（时间线 × 转写段，alignTextToClusters）——现算的永远新鲜，转写重跑后
// 不会读到旧快照。设计与三份存储收敛的来龙去脉见
// docs/superpowers/specs/2026-08-15-speaker-single-source-design.md。
//
// 投影**不信转写段自带的 speaker**：alignTextToClusters 整段覆写，段上残留的旧名字
// （历史回灌/内联 diarize 写的）在这里被无条件替换成时间线的答案。
import { alignTextToClusters } from './resolve.ts'
import type { DiarizedSpan } from './store.ts'
import type { TranscriptSegment } from '../transcribe/client.ts'

export interface SpeakerViewDeps {
  /** registry.getItemTimeline——没有就是空数组。 */
  timeline: (itemId: string) => DiarizedSpan[]
  /** conversions.segmentsOf——只要文字与起止，speaker 会被投影覆写。 */
  segments: (itemId: string) => TranscriptSegment[]
}

export interface SpeakerView {
  /** 时间线原样（权威）。空 = 这个 item 没有说话人数据。 */
  timeline: DiarizedSpan[]
  /** 转写段，speaker 为现算投影。时间线为空时原样返回（speaker 全 undefined）。 */
  segments: TranscriptSegment[]
  hasSpeakers: boolean
}

export function speakerViewOf(deps: SpeakerViewDeps, itemId: string): SpeakerView {
  const timeline = deps.timeline(itemId)
  const text = deps.segments(itemId)
  if (!timeline.length) {
    // **没有退档读抄件**：存量迁移（migrate-segments.ts）做完后不存在「只有抄件有」的 item。
    return { timeline, segments: text.map((s) => ({ ...s, speaker: undefined })), hasSpeakers: false }
  }
  return { timeline, segments: alignTextToClusters(text, timeline), hasSpeakers: true }
}
