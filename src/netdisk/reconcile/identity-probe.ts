/**
 * **取证据**：这份网盘文件的开头和结尾各说了什么。
 *
 * 它回答的是判读层需要的两件事，两件都不是元数据答得了的：
 *  · 开头讲的是不是这一集（题目、地名、人名）——排除"根本是另一集"；
 *  · 结尾是正常收尾语还是戛然而止——分得开"这份被截断了"和"节目单时长不准"。
 *
 * **这一层不判断任何事**，只把两段原文端出来。判读归模型自己（工作台里那个正在整理的 agent，
 * 经 `netdisk_transcribe` 拿到这两段话）。分层不是洁癖：证据原文必须能单独摆给用户看，
 * 否则给出的是一个无法核对的结论，而这条链路后面接的是删除或认领。
 *
 * ## 为什么不用 `extract-audio.ts`
 *
 * 那条腿抽的是**整个文件**的音轨（头注写得很清楚：音视频交织，HTTP 源上没有"只取一条流"
 * 这回事，所以整个容器都得流过去）。对视频那是唯一的办法；但播客是 mp3 —— 裸帧流，
 * 任意位置切开都能解，两段各约 120 秒只要 ~4.8 MB × 2。活体实测：切片 0.7s、转写 6–24s，
 * 而整盘 mp3 是 122 MB。两者解决的是不同的问题，不是重复实现。
 *
 * ## 窗口为什么是 120 秒（实测定的，别改小）
 *
 * 2026-08-03 拿 `116.安特卫普金库案.mp3` 实测：
 *  · **头 30 秒不够**——前 16 秒是片头音乐，剩下 14 秒只念到"这期案件由徐先生带来"，
 *    还没进正题；120 秒才听到"安特魏普 / 比利时西北部 / 钻石之都 / 钻石交易中心"。
 *  · **尾 30 秒是纯片尾音乐**，whisper 如实返回空；120 秒才拿到
 *    "感谢您收听……咱们下期再见"——而那句正是"没被截断"的判据。
 */

import type { TranscribeResult } from '../../transcribe/client.ts'

/** 探测窗口（秒）。实测定的下限，见本文件头注——改小会让头段读不到题目、尾段只剩音乐。 */
export const PROBE_WINDOW_S = 120

// 「切不切得动」单列一个模块（`sliceable.ts`）：它是采样的第一道门，`sample-audio.ts` 要在
// 发任何请求之前先问它一次。
export { isSliceable } from './sliceable.ts'
import { isSliceable } from './sliceable.ts'

export type ByteRange = [start: number, end: number]

/**
 * 头尾两段的字节区间。**按时长占比算，不按标称码率**：VBR 文件没有单一码率，拿标称值算会偏；
 * 而占比对 CBR 精确、对 VBR 也够用——要的只是"大约两分钟音频"，不是精确到帧。
 *
 * 时长不足两个窗口 → **整个文件一段**：那时两个窗口会重叠，切两段等于把中间那截听两遍、
 * 还多花一次转写，而文件本来就短。
 */
export function sliceRanges(
  sizeBytes: number,
  durationS: number | undefined,
  windowS = PROBE_WINDOW_S,
): { head: ByteRange; tail?: ByteRange } | null {
  if (!sizeBytes || !durationS || durationS <= 0) return null
  if (durationS <= windowS * 2) return { head: [0, sizeBytes - 1] }
  const w = Math.round((windowS / durationS) * sizeBytes)
  return { head: [0, w - 1], tail: [sizeBytes - w, sizeBytes - 1] }
}

/** 一段窗口的转写结果 + 它在整条音频里的位置（用户要知道"这是第几分钟的话"才知道该不该信）。 */
export interface ProbeWindow {
  text: string
  startS: number
  endS: number
}

export interface IdentityProbe {
  head: ProbeWindow
  /** 短文件只有一段——那时整个文件都在 `head` 里，没有"尾"可言。 */
  tail?: ProbeWindow
  timing: ProbeTiming
}

/**
 * 分阶段墙钟，**让它是量出来的而不是猜的**（同 `extract-audio.ts` 的 `ExtractAudioTiming`）。
 *
 * 这一条是有来历的：我先按一次观测断言"喂 mp3 比喂 wav 慢 4 倍"，据此差点去加一层本地
 * ffmpeg 转码；补测发现 13.5s vs 13.1s——**几乎没差别，那次是撞上噪声**。单次观测没有证据力，
 * 而这几个数会被拿去做"要不要优化"的决定，所以它们必须每次都真量。
 */
export interface ProbeTiming {
  /** 取直链（AList）。 */
  rawUrlMs: number
  /** 两段切片下载**各自耗时之和**。两段是并行取的，所以它不是墙钟——看的是"谁是大头"。 */
  fetchMs: number
  /** 两段转写各自耗时之和（同上，不是墙钟）。 */
  transcribeMs: number
  /** 送进 ASR 的字节合计。 */
  bytes: number
}

export interface ProbeDeps {
  /** 网盘直链（AList rawUrl）。 */
  rawUrl: (path: string) => Promise<string>
  /** 取一段字节。**必须跟随重定向**：`/api/netdisk/raw` 与 AList 都会 302 到网盘 CDN，
   *  不跟随就拿回一个 0 字节的 302 body（活体踩过）。 */
  fetchRange: (url: string, start: number, end: number) => Promise<Uint8Array>
  /** ASR。切片**原样喂**（mp3 字节），后端自己 ffmpeg 抽轨——本地不需要 ffmpeg。 */
  transcribe: (bytes: Uint8Array, mime: string, filename: string) => Promise<TranscribeResult>
}

export interface ProbeFile {
  path: string
  sizeBytes: number
  durationS?: number
}

/**
 * 取这份文件头尾各一段的转写。切不动的容器、或时长不可用 → `null`（**一次网络都不发**）。
 *
 * 某一段转写为空是**合法结果**，不是失败：活体 116 的末 30 秒就是纯片尾音乐，whisper 如实
 * 返回空。那一段照样带出去，由判读层解释——"尾部没人说话"本身就是一条证据（可能是音乐收尾，
 * 也可能是被截断），当错误吞掉就把它变没了。
 */
export async function probeHeadTail(
  deps: ProbeDeps,
  file: ProbeFile,
  opts?: { windowS?: number },
): Promise<IdentityProbe | null> {
  if (!isSliceable(file.path)) return null
  const windowS = opts?.windowS ?? PROBE_WINDOW_S
  const ranges = sliceRanges(file.sizeBytes, file.durationS, windowS)
  if (!ranges) return null

  const t0 = Date.now()
  const url = await deps.rawUrl(file.path)
  const timing: ProbeTiming = { rawUrlMs: Date.now() - t0, fetchMs: 0, transcribeMs: 0, bytes: 0 }
  const dur = file.durationS!
  const name = file.path.slice(file.path.lastIndexOf('/') + 1)

  const take = async (r: ByteRange, startS: number, endS: number): Promise<ProbeWindow> => {
    const tf = Date.now()
    const bytes = await deps.fetchRange(url, r[0], r[1])
    const tt = Date.now()
    timing.fetchMs += tt - tf
    timing.bytes += bytes.length
    // 切片**原样喂**（mp3 字节），不在本地转 wav：实测两者转写耗时几乎相同（13.5s vs 13.1s），
    // 而转一道要么多一个 ffmpeg 子进程、要么多一份临时文件，白花。
    const res = await deps.transcribe(bytes, 'audio/mpeg', name)
    timing.transcribeMs += Date.now() - tt
    return { text: res.text ?? '', startS: Math.round(startS), endS: Math.round(endS) }
  }

  // 两段**并行**取：下载打的是网盘 CDN，转写走 `transcribe` 那条梯子（远端 API），
  // 两者都没有本地资源可抢，一段等另一段纯属白等。
  //
  // **代价是 `timing` 的两个累加值不再是墙钟**——并行时它们会加出比实际更长的和。所以这里
  // 明确它们的语义是"两段各自花了多久的总和"（用来看谁是大头），墙钟另有出处（`llmMs` 那侧
  // 和调用方自己的计时）。把一个并行流程的分段耗时当墙钟读，会得出"总和 > 总时长"的怪数字。
  const [head, tail] = await Promise.all([
    take(ranges.head, 0, ranges.tail ? windowS : dur),
    ranges.tail ? take(ranges.tail, dur - windowS, dur) : Promise.resolve(undefined),
  ])
  return tail ? { head, tail, timing } : { head, timing }
}
