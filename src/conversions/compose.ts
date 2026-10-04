// src/conversions/compose.ts
//
// 「这条 item 的正文给我」——**一个口**，把三条各自独立的轨合成一份带时间轴的东西：
// 底座正文（extract）、谁在说（identify）、屏幕上写着什么（frames）。
// 设计见 docs/superpowers/specs/2026-08-14-extract-progressive-ladder-design.md §3、§6。
//
// **两条不变量，都是「别把不知道说成知道」：**
//
// 1. **「没跑」「还在跑」「跑了没料」「跑了失败」必须分得开。** 四种都会让某一层交出空内容，
//    合成一个空值就等于让读的人以为「这条视频屏幕上没有字」——而真相可能是那层压根没跑、
//    或者正在跑、或者后端挂了。所以每一层都带一个 `state`，**内容为空时 state 才是答案**。
// 2. **吃哪几层由调用方选，这里不设默认。** 能力是逐层累加的：帧文字可能有几十行，
//    问「他说了什么」的人不该被迫付这笔 token。所以 `include` 是必填的。
//
// 纯函数：不碰 store、不打 I/O。取记录是调用方的事。
import { speakerNames, speechLines, screenLine, type ScriptLine, type SpeakerEntry } from './speaker-script.ts'
import type { TranscriptSegment } from '../transcribe/client.ts'
import type { ConversionKind, ConversionRecord } from './store.ts'

/**
 * 一层此刻的状况。**空内容时读这个，别读内容。**
 *
 * - `absent` —— 库里没有这条 kind 的记录：这层压根没跑过。
 * - `running` —— 排队中或正在跑：稍后再问就有。
 * - `error` —— 跑了，失败了。`detail` 是失败原话。
 * - `empty` —— 跑成功了，但这层没有内容。**这是一个有效答案**（纯口播的视频屏幕上就是没字），
 *   `detail` 说得出为什么（抽帧那层的 `probe.stop`）。
 * - `ready` —— 有内容。
 */
export type LayerState = 'absent' | 'running' | 'error' | 'empty' | 'ready'

export interface LayerStatus {
  state: LayerState
  /** 人话解释。`error` 是失败原话，`empty` 是「为什么空」（如抽帧的止损档位）。 */
  detail?: string
}

export interface ComposeInclude {
  /** 谁在说（identify）。 */
  speakers: boolean
  /** 屏幕上写着什么（frames）。 */
  screen: boolean
}

export interface ComposedContent {
  /** 底座正文。转写分支是白文，OCR/网页是 markdown。这一层永远交（它就是「正文」本身）。 */
  text?: string
  /**
   * 合成稿：一份按时刻排好的稿子，带说话人和画面文字。
   *
   * **只有真的合成了东西才有它**——只要了底座、或者上层都还没料时，读 `text` 就够了，
   * 再交一份一模一样的稿子只是重复烧 token。
   */
  script?: string
  /** 说话人名单。序号名的口径与前端 `useSpeakerMap` 一致（按总发言时长降序的名次）。 */
  speakers?: SpeakerEntry[]
  /** 每一层此刻的状况。**内容为空时这里才是答案。** */
  layers: Record<'extract' | 'identify' | 'frames', LayerStatus>
}

/** 这几个 kind 各自的记录。缺席（`undefined`）= 这层没跑过。 */
export type LayerRecords = Partial<Record<ConversionKind, ConversionRecord | null | undefined>>

interface ExtractResultShape {
  text?: string
  detail?: { segments?: TranscriptSegment[] }
}
interface IdentifyResultShape {
  probe?: { speakerCount?: number }
}

/** 说话人读口（`src/voiceprint/view.ts`）的产物：时间线 × 转写段现算的投影。
 *  compose 自己不碰声纹库——谁在说话由调用方从读口取来递进来，这里保持纯函数。 */
export interface SpeakerInput {
  segments: TranscriptSegment[]
  hasSpeakers: boolean
}
interface FramesResultShape {
  track?: Array<{ at: number; text: string }>
  probe?: { stop?: string }
}

/** 抽帧那层「跑了但没料」的四种止损，各自说得出人话。**它们都是成功**，不是故障。 */
const FRAMES_STOP_REASON: Record<string, string> = {
  gate: '判为纯口播，没抽（抽了也只有人脸）',
  no_source: '这条内容没有可抽帧的视频',
  still_picture: '画面几乎不动（固定机位），没有可抽的变化',
  no_new_text: '探过几帧，屏幕上没有转写之外的新字',
}

function statusOf(rec: ConversionRecord | null | undefined): LayerStatus {
  if (!rec) return { state: 'absent' }
  if (rec.status === 'queued' || rec.status === 'running') return { state: 'running' }
  if (rec.status === 'error') return { state: 'error', detail: rec.error?.message }
  return { state: 'ready' }
}

/**
 * 把三层合成一份读口产物。
 *
 * `include` 没要的层**照样报 state**——「你没要」和「它没有」是两件事，读的人要能看出
 * 「还有一层在那儿，我可以再问一次」。只是不把内容装进来。
 *
 * `speakers` 是说话人读口的产物（时间线 × 转写段的现算投影）；不传 = 声纹域没配，
 * 稿子骨架退用 extract 自己的段、且**剥掉段上残留的旧名字**（那是历史回灌写的，不是数据源）。
 */
export function composeContent(records: LayerRecords, include: ComposeInclude, speakers?: SpeakerInput): ComposedContent {
  const extract = records.extract
  const identify = records.identify
  const frames = records.frames

  const extractResult = extract?.status === 'done' ? (extract.result as ExtractResultShape | undefined) : undefined
  const text = extractResult?.text

  const layers: ComposedContent['layers'] = {
    extract: statusOf(extract),
    identify: statusOf(identify),
    frames: statusOf(frames),
  }
  if (layers.extract.state === 'ready' && !text?.trim()) {
    layers.extract = { state: 'empty', detail: '转成文字跑完了，但一个字都没取到' }
  }

  // —— 说话人 ——
  // 内容来自读口的现算投影（`speakers`，时间线是唯一存储）；这一层的**状态**由 identify 记录
  // 自己的产物（probe）说了算——拿投影去判，会让「identify 跑完一无所获、但时间线上还留着
  // 上一轮的名字」报成 ready，读的人于是以为这轮识别成功了。
  if (layers.identify.state === 'ready') {
    const probe = (identify?.result as IdentifyResultShape | undefined)?.probe
    if (!((probe?.speakerCount ?? 0) > 0)) {
      layers.identify = { state: 'empty', detail: '识别跑完了，但没有分出任何说话人' }
    }
  }
  // 骨架段：优先读口投影；声纹域没配时退用 extract 自己的段，并剥掉段上残留的旧名字
  // （历史回灌写的抄件，不是数据源——别让它冒充「识别过」）。
  const segments =
    speakers?.segments ?? (extractResult?.detail?.segments ?? []).map((s) => ({ ...s, speaker: undefined }))
  const hasSpeakers = speakers?.hasSpeakers === true && segments.some((s) => !!s.speaker)

  // —— 画面文字 ——
  const framesResult = frames?.status === 'done' ? (frames.result as FramesResultShape | undefined) : undefined
  const track = framesResult?.track ?? []
  if (layers.frames.state === 'ready' && track.length === 0) {
    const stop = framesResult?.probe?.stop
    layers.frames = { state: 'empty', detail: (stop && FRAMES_STOP_REASON[stop]) ?? '抽帧跑完了，但没有画面文字' }
  }

  const out: ComposedContent = { text, layers }

  const wantSpeakers = include.speakers && hasSpeakers
  const wantScreen = include.screen && track.length > 0
  if (!wantSpeakers && !wantScreen) return out // 没有可合成的东西，读 text 就够了

  const roster = speakerNames(segments)
  if (wantSpeakers) out.speakers = roster
  // 没要说话人时仍然用转写段搭骨架（不然帧文字没有可插进去的稿子），且**照旧按人分行**——
  // 摘掉 speaker 再分行的话，隔着几十秒的两段会并成一行，画面文字就被挤到错的位置去了。
  const lines: ScriptLine[] = speechLines(segments, roster, { anonymous: !wantSpeakers })
  if (wantScreen) for (const t of track) lines.push(screenLine(t.at, t.text))
  // 稳定排序：同一时刻上「有人在说」排在「屏幕上写着」前面，靠的是 speech 先入数组 + sort 稳定。
  lines.sort((a, b) => a.at - b.at)
  out.script = lines.map((l) => l.text).join('\n')
  return out
}
