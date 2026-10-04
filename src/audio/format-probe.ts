import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { requireMediaTool } from '../media/ffmpeg-bin.ts'

const execFileP = promisify(execFile)

/** ffprobe 对 MP4 系容器(m4a/alac)常返回逗号分隔的候选列表(如 "mov,mp4,m4a,3gp,3g2,mj2")
 *  而不是单一值——命中其一就统一归一化成 'm4a'。 */
const CONTAINER_ALIASES: Record<string, string> = {
  mov: 'm4a', mp4: 'm4a', m4a: 'm4a', '3gp': 'm4a', '3g2': 'm4a', mj2: 'm4a',
}

/** 探测一个音频文件的真实容器格式——不依赖文件扩展名，ffprobe 认内容不认后缀。探测失败
 *  （进程出错/超时/不是合法音频）返回 null，调用方自己决定退回什么默认值（本项目里：退回
 *  接口自称的格式，见 src/audio/archive.ts 的接线）。
 *
 *  要求 `duration` 存在才认它是合法音频——单看 `format_name` 会被扩展名误导：一个只是"文件名
 *  恰好叫 .flac"的纯文本文件，ffprobe 照样报出 `format_name: "flac"`，`duration` 缺失才是它
 *  真正探测失败的信号。已知代价：极少数分片/流式 MP4 容器（fMP4，常见于 HLS 来源）在
 *  format 层可能不报 duration，会被这里误判成"探测失败"而退回接口声明值——属于本模块设计
 *  好的降级路径（静默退回，不影响归档），不是崩溃，接受这个代价。 */
export async function probeFormat(path: string): Promise<string | null> {
  return (await probeAudio(path))?.format ?? null
}

/** 一个音频文件的**实测**质量事实。字段与 `QualityMeta` 对齐，可直接喂 `computeTier`。
 *  容器不报某一项（有损格式没有位深）时该项缺席——缺席就是"这个文件没有这项"，不是 0。 */
export interface AudioProbe {
  format: string
  bitrate?: number
  sampleRate?: number
  bitDepth?: number
}

const num = (v: unknown): number | undefined => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * 探测一个音频文件的真实格式 + 码率/采样率/位深——全部认字节，不认接口的说法。
 *
 * 为什么要连质量字段一起探：`computeTier` 吃四个输入（format/bitrate/sampleRate/bitDepth），
 * 只把 format 换成实测值、另外三个仍用接口声明值，等级照样是半真半假的。一个声明 mp3、
 * 实为 flac 的文件，接口给的 bitrate 描述的是它以为的那个 mp3，对真实字节毫无意义。
 *
 * 合法性判据仍是 `duration` 在不在（见 `probeFormat` 的注释：只看 `format_name` 会被扩展名骗）。
 */
export async function probeAudio(path: string): Promise<AudioProbe | null> {
  try {
    const { stdout } = await execFileP(
      requireMediaTool('ffprobe'),
      [
        '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'format=duration,format_name,bit_rate',
        '-show_entries', 'stream=sample_rate,bits_per_raw_sample,bits_per_sample',
        '-of', 'json', path,
      ],
      { timeout: 30_000, killSignal: 'SIGKILL' },
    )
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string; format_name?: string; bit_rate?: string }
      streams?: Array<{ sample_rate?: string; bits_per_raw_sample?: string; bits_per_sample?: string }>
    }
    if (!parsed.format?.duration) return null

    const raw = parsed.format?.format_name
    if (!raw) return null
    const candidates = raw.split(',')
    let format: string | null = null
    for (const c of candidates) {
      if (CONTAINER_ALIASES[c]) { format = CONTAINER_ALIASES[c]; break }
    }
    format ??= candidates[0] || null
    if (!format) return null

    const s = parsed.streams?.[0]
    const bps = num(s?.bits_per_raw_sample) ?? num(s?.bits_per_sample)
    return {
      format,
      // ffprobe 报的是 bit/s，本项目各处的 bitrate 单位是 kbps
      bitrate: num(parsed.format.bit_rate) ? Math.round(num(parsed.format.bit_rate)! / 1000) : undefined,
      sampleRate: num(s?.sample_rate),
      bitDepth: bps,
    }
  } catch {
    return null
  }
}
