export interface Block {
  start: number
  end: number
  label: string
}

/** While filtering to `active`, decide what to do at playback time `t`. null = do nothing
 *  (either not filtering, or t is inside an active block). Mirrors the backend contract; kept pure
 *  so it's unit-tested without a real player. */
export function skipTarget(
  blocks: Block[],
  active: Set<string> | null,
  t: number
): { seek: number } | { pause: true } | null {
  if (!active) return null
  const mine = blocks.filter((b) => active.has(b.label)).sort((a, b) => a.start - b.start)
  if (!mine.length) return null
  if (mine.some((b) => t >= b.start && t < b.end)) return null
  const next = mine.find((b) => b.start > t)
  return next ? { seek: next.start } : { pause: true }
}

/** Deterministic HSL color per speaker label (same name → same hue across renders). */
export function speakerColor(label: string): string {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) % 360
  return `hsl(${h} 70% 55%)`
}

export function timelineStrips(
  blocks: Block[],
  duration: number
): { leftPct: number; widthPct: number; color: string; label: string }[] {
  if (!(duration > 0)) return []
  return blocks.map((b) => ({
    leftPct: (b.start / duration) * 100,
    widthPct: ((b.end - b.start) / duration) * 100,
    color: speakerColor(b.label),
    label: b.label,
  }))
}

/** Who is talking at playback time `t` — the label of the block covering it, or null in a gap
 *  (silence, or speech too short to have qualified as a block). Drives the panel's live
 *  「正在说话」highlight. Kept pure so it's unit-tested without a real player, like skipTarget. */
export function speakingAt(blocks: Block[], t: number): string | null {
  return blocks.find((b) => t >= b.start && t < b.end)?.label ?? null
}

/** One speaker's blocks as percentage-of-duration segments — the row's mini timeline. Mirrors
 *  timelineStrips' math but scoped to a single label, so the row can draw only its own speech
 *  against the full runtime. Empty until duration is known. */
export function speakerSegments(
  blocks: Block[],
  duration: number
): { leftPct: number; widthPct: number; start: number; end: number }[] {
  if (!(duration > 0)) return []
  return blocks
    .map((b) => ({
      leftPct: (b.start / duration) * 100,
      widthPct: Math.max(((b.end - b.start) / duration) * 100, 0.6), // floor: a short block must stay clickable
      start: b.start,
      end: b.end,
    }))
    .sort((a, b) => a.leftPct - b.leftPct)
}

/** 一个发言段上**可跳的两个落点**：段首、段尾。用途不是「定位到段内任意一刻」，而是
 *  **验一段切得连不连贯**——听头、听尾，确认从头到尾都是同一个人、边界没把别人切进来。
 *
 *  所以段尾**不是 `end`**，是 `end - TAIL_PREROLL`：落在 `end` 上只能听见静音或下一个人，
 *  正是要判断的那件事听不到；提前几秒进去，才能听见这段自己的尾巴、以及它怎么过渡出去。
 *  （附带一个好处：落在 `end` 上会被「只看」的 `skipTarget` 判成出段——`t < end`——当场弹去
 *  下一段，点尾巴反而跳走。提前量顺手把这个坑一起绕开了。）
 *
 *  段短于 `MIN_SPLIT` 时 `tail` 为 null：整段就那么长，从头听就听完了，再分出个尾巴落点，
 *  两个目标几乎重合、条上还挤出两个 1px 的热区，只会点不准。 */
export const TAIL_PREROLL = 4
const MIN_SPLIT = 2 * TAIL_PREROLL
export function segmentSeekPoints(seg: { start: number; end: number }): {
  start: number
  tail: number | null
} {
  const span = Math.max(0, seg.end - seg.start)
  return { start: seg.start, tail: span > MIN_SPLIT ? seg.end - TAIL_PREROLL : null }
}

/** Which progress-bar marks get a VISIBLE name next to the dot.
 *
 *  Naming every dot is wrong twice over: a speaker with 8 blocks would print their name 8 times,
 *  and marks that sit close together would overlap into mush. So a name is drawn at most once per
 *  speaker, and only where it clears `minGapPct` of the last drawn one. A speaker whose turn is
 *  crowded out doesn't lose their name — the attempt simply carries to their next mark, which is
 *  why this walks the marks in time order instead of just taking each speaker's first.
 *  Pure → unit-tested without a player. */
export function nameableMarks<T extends { leftPct: number; label: string }>(
  marks: T[],
  minGapPct = 9
): (T & { showName: boolean })[] {
  const named = new Set<string>()
  let lastNamedPct = -Infinity
  return [...marks]
    .sort((a, b) => a.leftPct - b.leftPct)
    .map((m) => {
      const showName = !named.has(m.label) && m.leftPct - lastNamedPct >= minGapPct
      if (showName) {
        named.add(m.label)
        lastNamedPct = m.leftPct
      }
      return { ...m, showName }
    })
}

export function blockLabels(blocks: Block[]): { label: string; seconds: number }[] {
  const agg = new Map<string, number>()
  for (const b of blocks) agg.set(b.label, (agg.get(b.label) ?? 0) + (b.end - b.start))
  return [...agg.entries()]
    .map(([label, seconds]) => ({ label, seconds }))
    .sort((a, b) => b.seconds - a.seconds)
}
