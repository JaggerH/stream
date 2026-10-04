// src/voiceprint/migrate-segments.ts
//
// 存量迁移：把「说话人只活在转写抄件里」的老 item（2026-07-26 声纹解耦之前）补出
// diarization 时间线。抄件的每段有 {start,end,speaker}，机械反推即可——无损、免费、不碰音频。
// 设计见 docs/superpowers/specs/2026-08-15-speaker-single-source-design.md §3.1。
//
// **幂等**：跑完在声纹库 meta 表落标记，此后启动零开销。落在 bootstrap（而非手跑脚本），
// 自托管部署自动受益。
//
// 时间线粒度会比真 diarization 碎（文字段边界），下游 mergePersonSpans 本来就做 gap 合并，
// 展示无感。
import type { TranscriptSegment } from '../transcribe/client.ts'
import type { SpeakerRegistryStore } from './store.ts'

export const MIGRATION_KEY = 'migrated_segments_to_timeline'

export interface MigrateDeps {
  registry: Pick<SpeakerRegistryStore, 'getMeta' | 'setMeta' | 'getItemTimeline' | 'putItemTimeline'>
  /** 所有已完成、带 segments 的转写（ConversionRunner.allTranscripts）。 */
  allTranscripts: () => Array<{ itemId: string; segments: TranscriptSegment[] }>
  log?: (msg: string) => void
}

export interface MigrateResult {
  /** 有标记直接跳过（连扫都没扫）。 */
  skipped: boolean
  /** 抄件带 speaker 且时间线为空的 item 数。 */
  candidates: number
  /** 实际迁出时间线的 item 数（= candidates，分开报是为了日志能看出中途异常）。 */
  migrated: number
}

export function migrateSegmentsToTimeline(deps: MigrateDeps): MigrateResult {
  if (deps.registry.getMeta(MIGRATION_KEY)) return { skipped: true, candidates: 0, migrated: 0 }

  let candidates = 0
  let migrated = 0
  for (const { itemId, segments } of deps.allTranscripts()) {
    // 只认带 speaker 的段——没跑过识别的转写（绝大多数）无从迁、也不必迁。
    const spans = segments
      .filter((s): s is TranscriptSegment & { speaker: string } => !!s.speaker && s.end > s.start)
      .map((s) => ({ start: s.start, end: s.end, speaker: s.speaker }))
    if (!spans.length) continue
    // 已有时间线的不动：那是 identify 的一等产物，比抄件反推的准。
    if (deps.registry.getItemTimeline(itemId).length) continue
    candidates += 1
    deps.registry.putItemTimeline(itemId, spans)
    migrated += 1
  }
  deps.registry.setMeta(MIGRATION_KEY, new Date().toISOString())
  deps.log?.(`[speaker-migrate] candidates=${candidates} migrated=${migrated}`)
  return { skipped: false, candidates, migrated }
}
