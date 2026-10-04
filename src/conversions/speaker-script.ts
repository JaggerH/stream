/**
 * 「谁说了什么」→ 给模型看的一份对话稿。
 *
 * 为什么是文本稿而不是 segments 数组：数组是分钟级长度、每段一个对象，进对话上下文之后模型
 * 每轮都要重读一遍。带人名和时间戳的稿子模型读到就懂，零对齐成本，而每段只多一行头（约 +10%）。
 * 权威理由见 docs/superpowers/specs/2026-08-12-speaker-axis-in-chat-design.md §3.1。
 *
 * **序号名的口径必须和前端 `useSpeakerMap` 一致**（按总发言时长降序的名次）：用户在认名列表里
 * 看到的「说话人 2」和模型嘴里的「说话人 2」得是同一个人，否则两边各说各的且不报错。
 */
import type { TranscriptSegment } from '../transcribe/client.ts'

export interface SpeakerEntry {
  /** 存储里的原始标签（`SPEAKER_03` 或已认领的人名）——回写、比对都认它。 */
  label: string
  /** 给模型看的名字：认领过的就是人名，没认领的是「说话人 N」。 */
  name: string
  /** 还没认领。**必须交出去**：不标的话模型会把「说话人 2」当成一个真实人名写进摘要。 */
  anonymous: boolean
}

export interface SpeakerScript {
  transcript: string
  speakers: SpeakerEntry[]
}

/** 后端给匿名簇的机器标签。判据与 `app/src/hooks/useSpeakerMap.ts` 的 RAW_SPEAKER_LABEL 同源——
 *  两边都是「标签长这样就是还没认领」，认领之后 enroll 会把标签本身改写成人名。 */
const RAW_SPEAKER_LABEL = /^(speaker|spk)[_\s-]?\d+$/i

/** mm:ss。**分钟不回绕**：一小时以上的播客写成 `02:05` 会指向另一个位置，而且看不出来错了。 */
function mmss(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** 名单：按总发言时长降序，序号名照这个名次给。 */
export function speakerNames(segments: readonly TranscriptSegment[]): SpeakerEntry[] {
  const seconds = new Map<string, number>()
  for (const s of segments) {
    if (!s.speaker) continue
    seconds.set(s.speaker, (seconds.get(s.speaker) ?? 0) + Math.max(0, s.end - s.start))
  }
  return [...seconds.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label], i) => {
      const anonymous = RAW_SPEAKER_LABEL.test(label)
      return { label, name: anonymous ? `说话人 ${i + 1}` : label, anonymous }
    })
}

/** 稿子里的一行，带它自己的时刻——**合成读口靠这个时刻把帧文字插进来**，所以不能只交字符串。 */
export interface ScriptLine {
  at: number
  text: string
}

/**
 * 并段成行：连续同一个说话人的句子并成一段，时间戳取这一段第一句。
 * 逐句一行读起来是一列时间戳，谁在说反而看不出来。
 */
export function speechLines(
  segments: readonly TranscriptSegment[],
  speakers: readonly SpeakerEntry[],
  opts: {
    /** 不写名字，但**照样按人分行**。给「只要画面文字、不要说话人」那种读法用：
     *  合并规则不变，时间轴才不会因为一段横跨几十秒而把画面文字挤到错的位置；
     *  而内部标签（`SPEAKER_00`）绝不能漏出去——那对读的人零信息，比给个名字更糟。 */
    anonymous?: boolean
  } = {},
): ScriptLine[] {
  const nameOf = opts.anonymous ? new Map<string, string>() : new Map(speakers.map((p) => [p.label, p.name]))
  const lines: ScriptLine[] = []
  let last: { speaker?: string; start: number; text: string } | undefined
  for (const s of segments) {
    if (last && last.speaker === s.speaker) last.text = `${last.text} ${s.text}`.trim()
    else {
      last = { speaker: s.speaker, start: s.start, text: s.text }
      lines.push({ at: last.start, text: '' }) // 占位，下一行统一渲染
    }
    const name = last.speaker ? nameOf.get(last.speaker) : undefined
    lines[lines.length - 1]!.text = name
      ? `[${mmss(last.start)}] ${name}：${last.text}`
      : `[${mmss(last.start)}] ${last.text}`
  }
  return lines
}

/** 帧文字的一行。前缀点明**这不是有人说的话**——屏幕上的字和话混在一起，模型会把幻灯片
 *  上的标题当成某人说过的原话去引用。 */
export function screenLine(at: number, text: string): ScriptLine {
  return { at, text: `[${mmss(at)}] 〔画面〕${text.replace(/\n/g, ' / ')}` }
}

export function speakerScript(segments: readonly TranscriptSegment[]): SpeakerScript {
  const speakers = speakerNames(segments)
  return { transcript: speechLines(segments, speakers).map((l) => l.text).join('\n'), speakers }
}
