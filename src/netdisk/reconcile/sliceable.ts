/**
 * 「这份文件切得动吗」——采样转写的第一道门。
 *
 * `sample-audio.ts` 拿它决定要不要发那两段切片请求：不满足就一次网络都不发，直接回
 * `ok:false`（`netdisk_transcribe` 据此答 `unsupported`）。
 */

/**
 * 能按字节切片的容器：**裸帧流**，从任意位置切开、解码器找到下一个同步字就能继续。
 *
 * mp4 / m4a / mkv 不在其列——它们的索引（moov / cues）在容器别处，切一段出来是一堆解不开的
 * 字节。**给这类文件切片拿回来的是空转写，而空转写会被读成"这段没人说话"**：一个会骗人的
 * 结果，比报错糟得多。所以宁可整个不支持，也不切。
 */
const SLICEABLE_RE = /\.(mp3|aac)$/i

export function isSliceable(path: string): boolean {
  return SLICEABLE_RE.test(path)
}
