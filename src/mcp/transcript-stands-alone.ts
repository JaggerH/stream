// src/mcp/transcript-stands-alone.ts
//
// 「这条视频的转写，离了画面上的字，还读得下去吗」。
//
// 画面文字层（`frames`）跑得慢、重尾（活体样本 17s–861s），服务端等不到它的时候要决定：
// 转写先给出去，还是扣着（`extract-frames-layer.ts` 的两档）。这就是那个判据。
//
// **不新造判据**——用 frames 闸门自己那一份（`framesGate`）。那道闸回答的本来就是同一个
// 问题的反面：「转写盖不住画面，值不值得去抽帧」。它放行的四个理由里：
//
//   - `deictic`：说话人一直在指屏幕。转写**是完整的**，画面上的字是补充 → 站得住。
//   - `no_transcript` / `sparse_speech`：没转写 / 大段没人说话。正文本来就在画面上 →
//     站不住。用户 2026-08-30 报的那条只有背景音乐的抖音新闻就是 `sparse_speech`。
//   - `unknown_duration`：时长不知道，语速密度算不出来——**「没量到」不是「验过了」**，
//     按站不住走。
//
// 另写一份「文字够不够长」之类的门槛会立刻和闸门漂移，而漂移了不报错：两边各自看都正常，
// 只是有一类视频会被扣住或被放行得莫名其妙。
import type { Media } from '../content/types.ts'
import type { Segment } from '../conversions/frames/new-text.ts'
import { framesGate } from '../conversions/frames/gate.ts'
import { durationOf } from '../conversions/converters/frames.ts'

/** 一条 extract 记录里这个判断用得着的那几格（结构子集，别 import 整个记录类型）。 */
export interface TranscriptShape {
  result?: {
    text?: string
    detail?: { media?: Media[]; segments?: Segment[] }
  }
}

/**
 * 这条 extract 的转写能不能单独读。
 *
 * @param row - 那条 extract 记录（`undefined` / 形状不对 → false，即站不住）。
 * @returns true 仅当闸门的理由是 `deictic`（转写完整、画面是补充）。
 */
export function transcriptStandsAlone(row: TranscriptShape | undefined): boolean {
  const detail = row?.result?.detail
  const segments = detail?.segments ?? []
  const verdict = framesGate({ text: row?.result?.text ?? '', durationS: durationOf(detail?.media, segments) })
  return verdict.reason === 'deictic'
}
