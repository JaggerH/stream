import type { TranscriptSegment } from '../transcribe/client.ts'

/** A diarized speech span: who spoke (anonymous cluster) + its speaker embedding. */
export interface DiarizedSegment {
  start: number
  end: number
  speaker: string
  embedding: number[]
}

/** overlap in seconds between [s1,e1] and [s2,e2] (0 if disjoint). */
function overlap(s1: number, e1: number, s2: number, e2: number): number {
  return Math.max(0, Math.min(e1, e2) - Math.max(s1, s2))
}

/** Assign each text segment the diarization cluster it overlaps most (the ASR pipeline's internal
 *  align step, extracted as a pure fn). No overlap → speaker left undefined. Never keeps a
 *  pre-existing speaker value.
 *  只看起止和标签——所以时间线（DiarizedSpan，无向量）和 DiarizedSegment 都喂得进来。 */
export function alignTextToClusters(
  textSegs: TranscriptSegment[],
  diar: Array<{ start: number; end: number; speaker: string }>
): TranscriptSegment[] {
  return textSegs.map((seg) => {
    let best: string | undefined
    let bestOv = 0
    for (const d of diar) {
      const ov = overlap(seg.start, seg.end, d.start, d.end)
      if (ov > bestOv) {
        bestOv = ov
        best = d.speaker
      }
    }
    return { ...seg, speaker: best }
  })
}

export interface SpeakerBlock {
  speaker: string
  start: number
  end: number
  text: string
}

/**
 * 一个人的连续「发言段」：把**这个人自己的**相邻段合并、桥接 <= gapSeconds 的间隙，
 * **忽略中间谁插了话**。产出按时间排序，无 speaker 的段丢弃。
 *
 * 为什么不是「不被任何人打断的连续段」：那是 2026-07-24 活体验收推翻的上一版语义。综艺里
 * 笑声、主持接话、反应镜头不停打断，按那个算法一段十分钟的 set 会碎成几十块——实测
 * `tmdb:261391:S03E02`：某人簇总时长 639s，但 **>=120s 的连续块为 0 个**，于是播放器的
 * 发言段列表全空、整个说话人功能对用户不可见。
 *
 * 播放器要的是「这个人的那一段表演」，段里容忍几秒别人的声音反而是对的——
 * 观众一笑就跳走才是坏体验。gap 的代价是「只看某人」会放过 <= gap 秒的他人发言，
 * 取 15s：够桥接笑声/接一句，又不至于把别人整段吞进来（gap=30s 会）。
 */
export function mergePersonSpans(segs: TranscriptSegment[], opts?: { gapSeconds?: number }): SpeakerBlock[] {
  const gap = opts?.gapSeconds ?? 15
  const bySpeaker = new Map<string, TranscriptSegment[]>()
  for (const s of segs) {
    if (!s.speaker) continue
    const cur = bySpeaker.get(s.speaker)
    if (cur) cur.push(s)
    else bySpeaker.set(s.speaker, [s])
  }
  const spans: SpeakerBlock[] = []
  for (const [speaker, own] of bySpeaker) {
    const ordered = [...own].sort((a, b) => a.start - b.start)
    let cur: SpeakerBlock | null = null
    for (const s of ordered) {
      if (cur && s.start - cur.end <= gap) {
        cur.end = Math.max(cur.end, s.end)
        cur.text = `${cur.text} ${s.text}`.trim()
      } else {
        cur = { speaker, start: s.start, end: s.end, text: s.text }
        spans.push(cur)
      }
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

/** Keep only blocks lasting at least minSeconds (default 60) — "don't mark sub-minute speech". */
export function filterBlocksByDuration(blocks: SpeakerBlock[], minSeconds = 60): SpeakerBlock[] {
  return blocks.filter((b) => b.end - b.start >= minSeconds)
}
