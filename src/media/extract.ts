import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { requireMediaTool } from './ffmpeg-bin.ts'

const execFileP = promisify(execFile)

export interface StreamInfo {
  index: number
  codec: string
  lang?: string
  title?: string
  /** audio only — channel count (2 = stereo, 6 = 5.1, 8 = 7.1) */
  channels?: number
  /** audio only — declared bitrate in bits/s. Absent in many mkv releases (the muxer doesn't
   *  write it per stream); rank by channels then codec when it is. */
  bitrate?: number
}

export interface ProbeResult {
  video: StreamInfo[]
  audio: StreamInfo[]
  subtitle: StreamInfo[]
  /** container duration in seconds. Absent for a container that declares none (live streams,
   *  some fragmented mp4). It is the denominator of every bytes estimate — without it a route's
   *  cost cannot be guessed at all, only measured after the fact. */
  durationS?: number
}

interface FfprobeStream {
  index: number
  codec_type: string
  codec_name: string
  channels?: number
  bit_rate?: string
  tags?: { language?: string; title?: string }
}

/**
 * 一个受保护的直链要带的请求头 → ffmpeg/ffprobe 的命令行参数。
 *
 * `user-agent` 必须走 `-user_agent`：塞进 `-headers` 会被 ffmpeg 自己的默认 UA 盖掉。其余头
 * （cookie / referer）按 HTTP 报文格式塞 `-headers`，行尾是 CRLF，少一个就整串失效。
 * 网盘转码档基本都要这个——夸克缺 referer/cookie 直接 412。
 */
export function headerArgs(headers?: Record<string, string>): string[] {
  if (!headers) return []
  const args: string[] = []
  const rest: string[] = []
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'user-agent') args.push('-user_agent', v)
    else rest.push(`${k}: ${v}\r\n`)
  }
  if (rest.length) args.push('-headers', rest.join(''))
  return args
}

/** ffprobe 一个支持 Range 请求的 URL（或本地文件路径）——只读容器结构/流信息，不下载内容。
 *  实测 ~2s 量级（见设计文档 §1.1），远快于 extractStream。 */
export async function probeStreams(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 30000
  const { stdout } = await execFileP(
    requireMediaTool('ffprobe'),
    [
      '-v', 'error',
      ...headerArgs(opts.headers),
      '-show_entries', 'stream=index,codec_type,codec_name,channels,bit_rate:stream_tags=language,title:format=duration',
      '-of', 'json', url,
    ],
    { signal: AbortSignal.timeout(timeoutMs), maxBuffer: 8 * 1024 * 1024 },
  )
  const parsed = JSON.parse(stdout) as { streams?: FfprobeStream[]; format?: { duration?: string } }
  const durationS = Number(parsed.format?.duration) || undefined
  const out: ProbeResult = { video: [], audio: [], subtitle: [], durationS }
  for (const s of parsed.streams ?? []) {
    const info: StreamInfo = {
      index: s.index,
      codec: s.codec_name,
      lang: s.tags?.language,
      title: s.tags?.title,
      channels: s.channels,
      bitrate: s.bit_rate ? Number(s.bit_rate) || undefined : undefined,
    }
    if (s.codec_type === 'video') out.video.push(info)
    else if (s.codec_type === 'audio') out.audio.push(info)
    else if (s.codec_type === 'subtitle') out.subtitle.push(info)
  }
  return out
}

export type ExtractKind = 'subtitle' | 'audio'

export interface ExtractResult {
  bytes: Buffer
  mime: string
}

/** kind → 编解码参数 + 时间预算。字幕转 WebVTT(<track> 只吃这个格式，样式会丢、文本+时间轴保)；
 *  音频 stream copy 不转码，容器用 matroska(什么源编码都能装，不像 adts 只认 AAC)。
 *
 *  预算按 kind 分开是有实测依据的：字幕轨几十 KB、一分钟绰绰有余；**音轨是整条流从远端拷下来**
 *  ——一集 4K 剧的 DDP 5.1 Atmos 轨几百 MB，还要经 AList→网盘的 range 读，60s 必超时（实测
 *  `tmdb:278624:S01E01` 恒定 60s 撞墙，报 `no transcribable media`，看起来像"没有可转写的媒体"，
 *  其实是预算不够）。耗时几乎全在网络 I/O，不是 CPU。 */
const EXTRACT_ARGS: Record<ExtractKind, { codecArgs: string[]; format: string; mime: string; timeoutMs: number }> = {
  subtitle: { codecArgs: ['-c:s', 'webvtt'], format: 'webvtt', mime: 'text/vtt', timeoutMs: 60_000 },
  audio: { codecArgs: ['-c:a', 'copy'], format: 'matroska', mime: 'audio/x-matroska', timeoutMs: 900_000 },
}

/** ffmpeg 直接对着远端 URL 抽一条流到内存字节，不落临时文件、不下载全量。
 *  `index` 是 ffmpeg 的流选择符：数字 = 该容器里的绝对流号（probe 出来的那个）；字符串 = 相对
 *  选择符，抽转码档位时用 `a:0`（"第一条音轨"）——那些档位没经过 probe，绝对流号无从谈起。
 *
 *  近零 CPU（stream copy / 字幕转码都很轻），耗时几乎全在网络 I/O——~20s 量级（见设计文档 §1.1），
 *  调用方必须缓存结果，不能每次现抽。 */
export function extractStream(url: string, opts: { index: number | string; kind: ExtractKind; timeoutMs?: number; headers?: Record<string, string> }): Promise<ExtractResult> {
  const { codecArgs, format, mime, timeoutMs: kindTimeout } = EXTRACT_ARGS[opts.kind]
  const timeoutMs = opts.timeoutMs ?? kindTimeout
  const args = ['-v', 'error', ...headerArgs(opts.headers), '-i', url, '-map', `0:${opts.index}`, ...codecArgs, '-f', format, 'pipe:1']
  return new Promise((resolve, reject) => {
    // 命令名走 requireMediaTool（见 ffmpeg-bin.ts）：缺席时给一句能指路的话，不是 ENOENT。
    let bin: string
    try { bin = requireMediaTool('ffmpeg') } catch (e) { reject(e as Error); return }
    const child = spawn(bin, args)
    const chunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`[extract] ffmpeg timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', (d: Buffer) => stderrChunks.push(d))
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
        reject(new Error(`[extract] ffmpeg exited ${code}: ${Buffer.concat(stderrChunks).toString('utf8').slice(0, 500)}`))
        return
      }
      resolve({ bytes: Buffer.concat(chunks), mime })
    })
  })
}
