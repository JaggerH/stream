// 声学指纹（chromaprint）：算、比、探测引擎。归堆用它判「两条媒体是不是同一份录音」，
// 不转写、不调模型。设计：docs/superpowers/specs/2026-08-23-audio-fingerprint-fold-design.md。
//
// 比对的统计底座：chromaprint 每项 32 bit，**两段无关音频的逐位相似度期望是 0.5**（随机位），
// 同一份录音的不同编码实测 >0.85。阈值 0.75 落在两者之间。
//
// 标定完成（`docs/research/audio-fingerprint-threshold.md`，量法与复现步骤在那儿）：
// 负例 n=120 同平台（同一档播客两两全组合，同主播、**同片头曲**）最高 **0.5524**；
// 负例 n=15 跨平台（m4a × mp3）最高 0.5451——不同编码器没有抬高基线；
// 正例 n=2 跨平台真实重投 **0.961 / 0.9612**（其中一对是归堆自己端到端判出来的）。
// 0.75 距负例上界 0.198、距正例 0.211，**几乎正好在两簇中点，别动这三个数**。
// 真出现误判再重开：先看证据行里的重叠分钟数（误判几乎只来自共享片头 → 先调 minOverlapS）。

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireMediaTool, mediaToolPath } from './ffmpeg-bin.ts'

const execFileP = promisify(execFile)
const defaultExec = async (cmd: string, args: string[]) => {
  const { stdout } = await execFileP(cmd, args, { maxBuffer: 4 * 1024 * 1024 })
  return { stdout }
}

/** 初值来自设计 spec §3.2；标定后改这里，消费方（worker）不各存一份。 */
export const FP_DEFAULTS = { maxOffsetS: 300, minOverlapS: 300, simThreshold: 0.75 }

export function encodeFingerprint(fp: Uint32Array): string {
  return Buffer.from(fp.buffer, fp.byteOffset, fp.byteLength).toString('base64')
}

export function decodeFingerprint(b64: string): Uint32Array {
  const buf = Buffer.from(b64, 'base64')
  // 拷一份对齐的：Buffer 池的 byteOffset 不保证 4 对齐，直接套 Uint32Array 会抛
  const aligned = new Uint8Array(buf.length - (buf.length % 4))
  aligned.set(buf.subarray(0, aligned.length))
  return new Uint32Array(aligned.buffer)
}

function popcount32(x: number): number {
  x -= (x >> 1) & 0x55555555
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333)
  x = (x + (x >> 4)) & 0x0f0f0f0f
  return (x * 0x01010101) >> 24
}

/** offset = b 相对 a 的项偏移（b 晚开始为正）。返回重叠区间的逐位相似度与重叠项数。 */
function similarityAt(a: Uint32Array, b: Uint32Array, offset: number): { sim: number; overlap: number } {
  const aStart = Math.max(0, offset)
  const aEnd = Math.min(a.length, b.length + offset)
  const overlap = aEnd - aStart
  if (overlap <= 0) return { sim: 0, overlap: 0 }
  let diffBits = 0
  for (let i = aStart; i < aEnd; i++) diffBits += popcount32((a[i] ^ b[i - offset]) >>> 0)
  return { sim: 1 - diffBits / (overlap * 32), overlap }
}

export interface FpCompareResult { match: boolean; similarity: number; offsetS: number; overlapS: number }

/**
 * 带偏移的滑动比对：全偏移窗逐项扫描。
 * 两关判据（相似度 + 最短重叠）见 spec §3.2。最短重叠只在**两条长度可比**时才缩到
 * 0.8×较短时长：短×短的重投要能判（3 分钟对 3 分钟，否则永远凑不满 300s，反而比
 * 今天转写可判更差）；长×短的"切片对正片"（3 小时正片 vs 2 分钟预告，标题天然相近
 * 能过候选闸）正是这道关要防的——它的相似度是满分，唯一挡得住的就是重叠下限，
 * 所以绝不许被缩放废掉。
 *
 * 注：曾尝试「粗扫步长 16 + 最优点 ±16 细化」两段式搜索，但真实偏移未必落在
 * 16 的整数倍格点上，且指纹项之间没有自相关——粗扫格点上的相似度就是纯噪声，
 * 细化窗口有很大概率根本盖不到真实峰值（漏检）。逐项全扫描没有这个假设，
 * 换来的是线性于 maxOffsetS 的开销，在本模块的数据规模下可接受。
 */
export function compareFingerprints(
  a: Uint32Array, b: Uint32Array,
  opts: { itemsPerSecond: number; maxOffsetS?: number; minOverlapS?: number; simThreshold?: number },
): FpCompareResult {
  const rate = opts.itemsPerSecond
  const maxOffset = Math.round((opts.maxOffsetS ?? FP_DEFAULTS.maxOffsetS) * rate)
  const simThreshold = opts.simThreshold ?? FP_DEFAULTS.simThreshold
  const shorterS = Math.min(a.length, b.length) / rate
  const longerS = Math.max(a.length, b.length) / rate
  const minOverlapBaseS = opts.minOverlapS ?? FP_DEFAULTS.minOverlapS
  const floorS = shorterS >= 0.8 * longerS ? Math.min(minOverlapBaseS, 0.8 * shorterS) : minOverlapBaseS
  const minOverlap = Math.round(floorS * rate)

  let best = { sim: 0, overlap: 0, offset: 0 }
  for (let off = -maxOffset; off <= maxOffset; off++) {
    const { sim, overlap } = similarityAt(a, b, off)
    if (overlap >= minOverlap && sim > best.sim) best = { sim, overlap, offset: off }
  }
  return {
    match: best.overlap > 0 && best.sim >= simThreshold,
    similarity: best.sim,
    offsetS: best.offset / rate,
    overlapS: best.overlap / rate,
  }
}

export type FpEngine = 'ffmpeg' | 'fpcalc'

/** 引擎探测（启动时一次）：ffmpeg 的 chromaprint muxer → fpcalc → null。
 *  null 时消费方要**响亮关闭**这一档（boot 日志），绝不静默假装判过。 */
export async function probeFingerprintEngine(
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string }> = defaultExec,
  /** 用哪个 ffmpeg 问这句话。缺省走全仓唯一的解析点；解不出（这台机器上没有）就跳过这一档。 */
  ffmpegBin: string | null = mediaToolPath('ffmpeg'),
): Promise<FpEngine | null> {
  try {
    if (!ffmpegBin) throw new Error('no ffmpeg')
    const { stdout } = await exec(ffmpegBin, ['-hide_banner', '-muxers'])
    if (/\bchromaprint\b/.test(stdout)) return 'ffmpeg'
  } catch { /* ffmpeg 不在——转写链路会另行喊，这里只管指纹档 */ }
  try {
    await exec('fpcalc', ['-version'])
    return 'fpcalc'
  } catch {
    return null
  }
}

/** fpcalc -raw 输出里的 FINGERPRINT=1,2,3 行 → Uint32Array。没有该行 = 引擎错误，抛。 */
export function parseFpcalcRaw(stdout: string): Uint32Array {
  const line = stdout.split('\n').find((l) => l.startsWith('FINGERPRINT='))
  if (!line) throw new Error('[audio-fp] fpcalc 输出里没有 FINGERPRINT 行')
  return new Uint32Array(line.slice('FINGERPRINT='.length).split(',').map((s) => Number(s) >>> 0))
}

/** 跑一条命令、stdin 灌 bytes、收集 stdout 字节。与 audio-windows 的 runFfmpeg 是姊妹：
 *  那个只写文件，这个只收 stdout——chromaprint muxer 的产物就是 stdout 上的裸 uint32 流。 */
function runCapture(cmd: string, args: string[], opts: { input?: Uint8Array; signal?: AbortSignal; timeoutMs: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { signal: opts.signal, stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`[audio-fp] ${cmd} timed out after ${opts.timeoutMs}ms`))
    }, opts.timeoutMs)
    child.stdout!.on('data', (d: Buffer) => out.push(d))
    child.stderr!.on('data', (d: Buffer) => err.push(d))
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e) } })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`[audio-fp] ${cmd} exited ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 500)}`))
      else resolve(Buffer.concat(out))
    })
    if (opts.input) {
      child.stdin!.on('error', () => {}) // EPIPE 竞态交给 close/error 上报
      child.stdin!.end(opts.input)
    }
  })
}

/** 媒体字节 → chromaprint 指纹。视频被 -vn 抽掉，音频版/视频版同一期因此可比。
 *  超时 10 分钟：3 小时媒体的解码在几十秒量级，10 分钟是卡死保险不是预算。 */
export async function fingerprintBytes(
  bytes: Uint8Array, engine: FpEngine,
  opts?: { signal?: AbortSignal; timeoutMs?: number; tmpDir?: string },
): Promise<Uint32Array> {
  const timeoutMs = opts?.timeoutMs ?? 600_000
  if (engine === 'ffmpeg') {
    const raw = await runCapture(
      requireMediaTool('ffmpeg'),
      ['-v', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 'chromaprint', '-fp_format', 'raw', '-'],
      { input: bytes, signal: opts?.signal, timeoutMs },
    )
    const aligned = new Uint8Array(raw.length - (raw.length % 4))
    aligned.set(raw.subarray(0, aligned.length))
    return new Uint32Array(aligned.buffer)
  }
  // fpcalc 只吃文件路径，落一个临时文件；-length 上限给足 10 小时（默认只算前 120s，是坑）。
  const dir = await mkdtemp(join(opts?.tmpDir ?? tmpdir(), 'stream-audio-fp-'))
  try {
    const p = join(dir, 'media.bin')
    await writeFile(p, bytes)
    // killSignal 显式 SIGKILL：Node 默认超时用 SIGTERM，卡死保险对僵死进程可能不管用。
    const { stdout } = await execFileP('fpcalc', ['-raw', '-length', '36000', p], {
      maxBuffer: 16 * 1024 * 1024, signal: opts?.signal, timeout: timeoutMs, killSignal: 'SIGKILL',
    })
    return parseFpcalcRaw(stdout)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
