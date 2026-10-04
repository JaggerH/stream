import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mediaDurationS } from './video-frames.ts'
import { requireMediaTool } from './ffmpeg-bin.ts'

const execFileP = promisify(execFile)

/** 临时目录前缀，出问题时孤儿好认。 */
const TMP_PREFIX = 'stream-audio-windows-'

const DEFAULT_WINDOW_S = 120
const DEFAULT_OVERLAP_S = 10

/** Cloud-STT chunking (Groq/OpenAI Whisper). 25MB is the API payload cap; 24MB leaves headroom.
 *  600s per chunk at 32kbps m4a ≈ 2.4MB, so the split trigger is size, the slice unit is duration. */
const STT_CHUNK_S = 600
const STT_MAX_BYTES = 24 * 1024 * 1024

export interface AudioWindow {
  index: number
  startS: number
  durS: number
  bytes: Uint8Array
}

/** How a chunk's bytes are actually encoded — declared by the producer so the uploader never has
 *  to guess. OpenAI-compatible Whisper endpoints detect the audio format from the **uploaded
 *  filename's extension**, so `ext` is load-bearing, not cosmetic. */
export interface SttChunkFormat {
  /** filename extension without the dot, e.g. `m4a` */
  ext: string
  /** the chunk's own media type, e.g. `audio/mp4` — NOT the source media's mime */
  mime: string
}

/** One upload-ready audio chunk for a cloud STT backend. `startS` is its offset in the source
 *  timeline, added back to each returned segment so a multi-chunk transcript stays global;
 *  `format` says what the bytes are, since re-encoding means they no longer match the source. */
export interface SttChunk {
  startS: number
  bytes: Uint8Array
  format: SttChunkFormat
}

/** What `planSttChunks` re-encodes to (see the ffmpeg args below: aac in an mp4 container).
 *  **Change the codec/container → change this in the same edit** — it is what the upload's
 *  filename extension and Blob type are built from. */
const STT_CHUNK_FORMAT: SttChunkFormat = { ext: 'm4a', mime: 'audio/mp4' }

/** 把 bytes 灌进 ffmpeg 的 stdin 跑一遍，等它把结果写到 `outPath`。抽轨和切窗都是这个形状：
 *  一个输入（管道或文件）→ 一个输出文件；stderr 攒起来只在失败时用。 */
function runFfmpeg(args: string[], opts: { input?: Uint8Array; signal?: AbortSignal; timeoutMs?: number }): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  return new Promise((resolve, reject) => {
    // 命令名从 requireMediaTool 取，不裸写 'ffmpeg'——没有它时抛的是一句能指路的话，
    // 而不是 `spawn ffmpeg ENOENT`（见 src/media/ffmpeg-bin.ts 头注）。
    let bin: string
    try { bin = requireMediaTool('ffmpeg') } catch (e) { reject(e as Error); return }
    const child = spawn(bin, args, { signal: opts.signal, stdio: [opts.input ? 'pipe' : 'ignore', 'ignore', 'pipe'] })
    const stderrChunks: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`[audio-windows] ffmpeg timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d))
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`[audio-windows] ffmpeg exited ${code}: ${Buffer.concat(stderrChunks).toString('utf8').slice(0, 500)}`))
        return
      }
      resolve()
    })
    if (opts.input) {
      child.stdin!.on('error', () => {}) // EPIPE 竞态（子进程已因别的原因退出）交给 close/error 上报，这里只是别让它变成未捕获异常
      child.stdin!.end(opts.input)
    }
  })
}

/**
 * 把媒体 bytes 抽成 16k 单声道 wav，再按 `windowS`/`overlapS` 切成若干窗——喂给 voiceprint
 * 容器的短调用（每窗一次 `/diarize`），不再让容器自己扛长音频（那条路已被 OOM 撞过，见
 * Task 6 头注）。
 *
 * 两步、只抽一次轨：
 *   1. `ffmpeg -i pipe:0 -vn -ac 1 -ar 16000 -c:a pcm_s16le f.wav`——源 bytes 从 stdin 灌入，
 *      不额外落一份源文件。
 *   2. 每窗 `ffmpeg -ss <start> -t <dur> -i f.wav -c:a pcm_s16le win.wav`——读的是第 1 步落地
 *      的本地 wav，不重新解码/重新过一遍源容器。
 *
 * 切窗用重编码而不是 `-c copy`：wav 是 raw PCM，直觉上 `-c copy` 该是字节级精确的流拷贝，
 * 但实测不是——`ffmpeg -ss 8 -t 10 -i full.wav -c copy` 切出来的窗 `ffprobe` 报时长
 * 10.112s（应为 10.000s），`-ss` 在 copy 路径下对齐到 demuxer 的读取块而不是采样点。换成
 * `-c:a pcm_s16le` 重编码后精确到 10.000s——重编码是无损 PCM→PCM，代价可忽略（每窗几百 ms
 * CPU），换来的是窗与窗之间时间轴不漂移（下游 Task 4 的合并算法靠 startS 做全局时间平移，
 * 漂移会累积成说话人分段错位）。
 *
 * 总时长 ≤ windowS：单窗，bytes 就是整段抽轨结果（不额外切一刀）。
 */
export async function planAudioWindows(
  bytes: Uint8Array,
  mime: string,
  opts?: { windowS?: number; overlapS?: number; tmpDir?: string; signal?: AbortSignal },
): Promise<{ windows: AudioWindow[]; totalS: number }> {
  void mime // ffmpeg 从内容自身探测容器/编码，mime 只是调用方的元数据，这里不需要
  const windowS = opts?.windowS ?? DEFAULT_WINDOW_S
  const overlapS = opts?.overlapS ?? DEFAULT_OVERLAP_S
  if (overlapS >= windowS) throw new Error('[audio-windows] overlapS must be < windowS')
  const signal = opts?.signal

  const parent = opts?.tmpDir ?? tmpdir()
  const dir = await mkdtemp(join(parent, TMP_PREFIX))
  try {
    const wavPath = join(dir, 'audio.wav')
    await runFfmpeg(
      ['-v', 'error', '-y', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath],
      { input: bytes, signal },
    )
    const totalS = await mediaDurationS(wavPath, signal)

    if (totalS <= windowS) {
      const wholeBytes = await readFile(wavPath)
      return { windows: [{ index: 0, startS: 0, durS: totalS, bytes: wholeBytes }], totalS }
    }

    const step = windowS - overlapS
    const starts: number[] = []
    for (let s = 0; s < totalS; s += step) {
      starts.push(s)
      if (s + windowS >= totalS) break
    }

    const windows: AudioWindow[] = []
    for (let i = 0; i < starts.length; i++) {
      const startS = starts[i]
      const durS = Math.min(windowS, totalS - startS) // 最后一窗可能不足 windowS
      const winPath = join(dir, `win-${i}.wav`)
      await runFfmpeg(
        ['-v', 'error', '-y', '-ss', String(startS), '-t', String(durS), '-i', wavPath, '-c:a', 'pcm_s16le', winPath],
        { signal },
      )
      windows.push({ index: i, startS, durS, bytes: await readFile(winPath) })
    }
    return { windows, totalS }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Prepare source media for a cloud STT backend (Groq/OpenAI Whisper), respecting the ~25MB
 * payload cap. Distinct from `planAudioWindows` (which the voiceprint path uses): that emits
 * **overlapping raw-PCM wav** windows split by **duration** because cross-window speaker merge
 * needs the overlap. STT wants the opposite — **non-overlapping compressed m4a** split by **byte
 * size**, since any overlap would duplicate transcript text at the seam. So this is a sibling in
 * the same toolchain, reusing `runFfmpeg`/`mediaDurationS` (from `video-frames.ts`, same ffprobe
 * question) rather than a fresh ffmpeg wrapper.
 *
 * Two steps:
 *   1. Compress the source bytes to mono / 16kHz / 32kbps aac (m4a) — Agent Reach's measured
 *      parameters; ≈4KB/s, so ~100min fits in 24MB.
 *   2. Whole compressed audio ≤ `maxBytes` → a single chunk (`startS=0`). Otherwise re-encode it
 *      into `chunkS`-second, non-overlapping chunks, each tagged with its `startS`. Slicing
 *      re-encodes (not `-c copy`) for the same reason `planAudioWindows` does: copy aligns `-ss`
 *      to container blocks, not sample points, drifting chunk durations.
 *
 * Every chunk carries `format` (= `STT_CHUNK_FORMAT`) because after step 1 the bytes are no longer
 * the caller's media — uploading them under the *source* mime / an extension-less name is exactly
 * what made Groq answer 400 (Whisper sniffs the format from the filename extension).
 */
export async function planSttChunks(
  bytes: Uint8Array,
  mime: string,
  opts?: { chunkS?: number; maxBytes?: number; tmpDir?: string; signal?: AbortSignal },
): Promise<SttChunk[]> {
  void mime // ffmpeg probes the container/codec from the bytes; mime is caller metadata only
  const chunkS = opts?.chunkS ?? STT_CHUNK_S
  const maxBytes = opts?.maxBytes ?? STT_MAX_BYTES
  const signal = opts?.signal

  const parent = opts?.tmpDir ?? tmpdir()
  const dir = await mkdtemp(join(parent, TMP_PREFIX))
  try {
    const m4aPath = join(dir, 'stt.m4a')
    await runFfmpeg(
      ['-v', 'error', '-y', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '32k', m4aPath],
      { input: bytes, signal },
    )
    const whole = await readFile(m4aPath)
    if (whole.length <= maxBytes) return [{ startS: 0, bytes: whole, format: STT_CHUNK_FORMAT }]

    const totalS = await mediaDurationS(m4aPath, signal)
    const chunks: SttChunk[] = []
    for (let startS = 0; startS < totalS; startS += chunkS) {
      const durS = Math.min(chunkS, totalS - startS) // last chunk = the remainder
      const chunkPath = join(dir, `stt-${startS}.m4a`)
      await runFfmpeg(
        ['-v', 'error', '-y', '-ss', String(startS), '-t', String(durS), '-i', m4aPath, '-c:a', 'aac', '-b:a', '32k', chunkPath],
        { signal },
      )
      chunks.push({ startS, bytes: await readFile(chunkPath), format: STT_CHUNK_FORMAT })
    }
    return chunks
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
