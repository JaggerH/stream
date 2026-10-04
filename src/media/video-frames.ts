// src/media/video-frames.ts
//
// 三条**已实测**的 ffmpeg/ffprobe 命令：取关键帧时刻、取每个关键帧的 17×16 灰度缩略图、
// 按秒取回某一时刻的整帧 JPEG。
//
// 本模块吃**本地路径或可 range 的 URL**，不吃字节：`-ss` 精确 seek 要求可寻址的输入，管道喂
// 不了。`src/netdisk/extract-audio.ts` 早就在让 ffmpeg 直读远程 URL——这里的输入端与它同源。
// 字节落盘是调用方的事（下一份计划里是 `ctx.jobDir`）。
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { THUMB_BYTES, THUMB_W, THUMB_H, dhash, dedupeFrames } from './frame-hash.ts'
import { requireMediaTool } from './ffmpeg-bin.ts'

const execFileP = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 120_000

/** 把请求头对象拼成 ffmpeg/ffprobe 的 `-headers` **输入选项**参数——调用方必须把返回值拼在
 *  `-i`（ffmpeg）或源地址（ffprobe 隐式输入）**之前**，这里只管拼字符串，不管放哪。B 站 CDN
 *  不带 Referer/UA/Cookie 就 403，这是唯一的挡板。
 *
 *  未传或空对象 → 返回 `[]`，拼进现有调用的参数数组里等于什么都没加——这是「不传 headers 时
 *  行为必须和现在一字不差」的落点，别在这里加任何默认头。
 *
 *  头之间以 `\r\n` 分隔，结尾也带一个 `\r\n`（ffmpeg/ffprobe 的 `-headers` 就吃这个格式，
 *  少了尾随 `\r\n` 最后一条头会被吞掉）。
 *
 *  key/value 里出现 `\r`/`\n` 一律拒绝：这两个字符串是从上游拼进命令行参数、再拼进 ffmpeg
 *  自己解析的 HTTP 头文本里，允许换行就等于允许调用方在这条头之后再注入任意一条新头
 *  （甚至撞见 CRLF 头注入的老问题）。必须在拼接前挡死，不能指望 ffmpeg 自己防。 */
export function headerArgs(headers?: Record<string, string>): string[] {
  if (!headers || Object.keys(headers).length === 0) return []
  const lines = Object.entries(headers).map(([key, value]) => {
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
      throw new Error(`[video-frames] header 含非法换行（注入风险），key=${JSON.stringify(key)}`)
    }
    return `${key}: ${value}`
  })
  return ['-headers', lines.join('\r\n') + '\r\n']
}

/** 收 stdout 的 ffmpeg runner。**别去复用 `audio-windows.ts` 的 `runFfmpeg`**——那个 stdout 是
 *  `'ignore'`、输入走 stdin，两头都不是这里要的：这里不喂输入、要收 stdout 里的二进制帧数据。 */
function runFfmpegCollectStdout(
  args: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    // 命令名走 requireMediaTool（见 ffmpeg-bin.ts）：缺席时给一句能指路的话，不是 ENOENT。
    let bin: string
    try { bin = requireMediaTool('ffmpeg') } catch (e) { reject(e as Error); return }
    const child = spawn(bin, args, { signal: opts.signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`[video-frames] ffmpeg timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d))
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
        reject(new Error(`[video-frames] ffmpeg exited ${code}: ${Buffer.concat(stderrChunks).toString('utf8').slice(0, 500)}`))
        return
      }
      resolve(Buffer.concat(stdoutChunks))
    })
  })
}

/** 关键帧（I 帧）的时刻，单位秒，按出现顺序。实测命令见计划文档；输出**第一行带一个尾随逗号**
 *  （`0.000000,`），解析必须按逗号切、取第一段、丢空串，否则会冒出 NaN。 */
export async function keyframeTimes(
  path: string,
  signal?: AbortSignal,
  opts: { headers?: Record<string, string> } = {}
): Promise<number[]> {
  const { stdout } = await execFileP(
    requireMediaTool('ffprobe'),
    [
      ...headerArgs(opts.headers),
      '-v', 'error',
      '-select_streams', 'v:0',
      '-skip_frame', 'nokey',
      '-show_entries', 'frame=best_effort_timestamp_time',
      '-of', 'csv=p=0',
      path,
    ],
    // maxBuffer 64MB（未量过具体上限，留够余量）：超限时 Node 会杀掉子进程、reject（响亮失败），
    // 不是静默截断——和另外两个 runner 一样，与 timeout 同为 DEFAULT_TIMEOUT_MS 保持语义一致
    // （损坏文件卡死 ffprobe 时不会永久挂起）。
    { signal, maxBuffer: 64 * 1024 * 1024, timeout: DEFAULT_TIMEOUT_MS }
  )
  return stdout
    .split(/\r?\n/)
    .flatMap((line) => line.split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number)
    .filter((n) => Number.isFinite(n))
}

/** 把 ffmpeg 直出的 rawvideo 字节流按 `THUMB_BYTES`（17×16 灰度）切成一张张缩略图。纯函数，不碰
 *  子进程——切片判据本身就该被单独钉住：余数不为 0 说明滤镜/像素格式跟约定不一致，此时切出来的
 *  **每一张都是错位的**，比崩掉坏得多（产出看着正常，只是每张对应的时刻全部错开）。空输入（0
 *  字节）是合法结果——"这个视频一个关键帧都没有"——0 天然是 THUMB_BYTES 的整数倍，不抛。 */
export function sliceThumbs(raw: Uint8Array): Uint8Array[] {
  if (raw.length % THUMB_BYTES !== 0) {
    throw new Error(
      `[video-frames] rawvideo 长度不是 ${THUMB_BYTES} 的整数倍：实得 ${raw.length} 字节，余 ${raw.length % THUMB_BYTES}`
    )
  }
  const thumbs: Uint8Array[] = []
  for (let off = 0; off < raw.length; off += THUMB_BYTES) {
    thumbs.push(raw.slice(off, off + THUMB_BYTES))
  }
  return thumbs
}

/** 每个关键帧的 17×16 灰度缩略图（`THUMB_BYTES` 字节/张），与 `keyframeTimes` 的返回**严格一一
 *  对应**（同一条 `-skip_frame nokey` 遍历顺序）。缩放与灰度由 ffmpeg 直出，本模块不解码图片。 */
export async function keyframeThumbs(
  path: string,
  signal?: AbortSignal,
  opts: { headers?: Record<string, string> } = {}
): Promise<Uint8Array[]> {
  const buf = await runFfmpegCollectStdout(
    [
      ...headerArgs(opts.headers),
      '-v', 'error',
      '-skip_frame', 'nokey',
      '-i', path,
      '-vsync', '0',
      '-vf', `scale=${THUMB_W}:${THUMB_H},format=gray`,
      '-f', 'rawvideo',
      '-',
    ],
    { signal }
  )
  return sliceThumbs(new Uint8Array(buf.buffer, buf.byteOffset, buf.length))
}

/** 取某一时刻（秒）的整帧 JPEG 字节。`-ss` 放在 `-i` **之前**做输入端 seek，比输出端 seek 快
 *  得多。 */
export async function frameAt(
  path: string,
  atSeconds: number,
  signal?: AbortSignal,
  opts: { headers?: Record<string, string> } = {}
): Promise<Uint8Array> {
  const buf = await runFfmpegCollectStdout(
    [
      ...headerArgs(opts.headers),
      '-v', 'error',
      '-ss', String(atSeconds),
      '-i', path,
      '-frames:v', '1',
      '-f', 'image2',
      '-c:v', 'mjpeg',
      '-q:v', '3',
      '-',
    ],
    { signal }
  )
  return new Uint8Array(buf)
}

/** 一张候选帧：它在第几秒、它的感知哈希。**故意不带图片字节**——整帧要用时才 `frameAt` 去取，
 *  提前取几十张 JPEG 攒在内存里，而其中大部分会被闸门挡在 OCR 之外。 */
export interface KeyframeCandidate {
  at: number
  hash: string
}

export interface PlanVideoFramesOptions {
  /** 两帧差多少位才算「画面变了」（dHash 共 256 位，17×16 网格）。 */
  minDistance?: number
  signal?: AbortSignal
  /** CDN 要的请求头（如 B 站的 Referer/UA/Cookie）——不带就 403，见 `headerArgs`。 */
  headers?: Record<string, string>
}

/** **已实测钉死，不是占位符。** 真编码视频（x264 GOP 50，A 页停 6s → B 页停 6s）相邻关键帧
 *  17×16 dHash 距离：噪声底 0–2、换页那一跳 28；静态图对比（同模板换正文，代码页最低）也
 *  只差 3–7 位。10 落在噪声上沿（0–2）与信号下沿（28）之间的隔离带里，两头都留足余量。
 *  完整实测表见 spec §5.3。
 *
 *  这组数字量的是**合成素材**——真实素材（手持摄像、屏幕录制带鼠标移动/光标闪烁）噪声底
 *  可能更高，若真实视频上出现「明明没换页却被判定变了」，回 spec 补一组真实素材的读数，
 *  不要凭感觉调这个数。 */
export const DEFAULT_MIN_DISTANCE = 10

/** 把「关键帧时刻」与「关键帧缩略图」两条序列按下标一一配对、逐张算 dHash。纯函数，不碰
 *  子进程——**长度不等就抛的分支在真 ffmpeg 下永远不可达**（两条命令遍历同一批关键帧），
 *  抽成具名导出才有地方喂假数据把这条分支跑到、也才有地方钉「确实是按下标配对，不是配错位」。
 *  两条序列必须一一对应，否则哈希会配到别的时刻上——那种错是安静的：产出看着正常，
 *  只是每张帧的时间都错了位，而下游正要拿这个时间去跟转写对齐。 */
export function pairFrames(times: readonly number[], thumbs: readonly Uint8Array[]): KeyframeCandidate[] {
  if (times.length !== thumbs.length) {
    throw new Error(`[video-frames] 关键帧时刻与缩略图张数对不上：${times.length} vs ${thumbs.length}`)
  }
  return times.map((at, i) => ({ at, hash: dhash(thumbs[i]!) }))
}

/**
 * 一个视频 → 一串去过重的候选帧。
 *
 * 两步：I 帧直取拿到（时刻，缩略图）两条严格对齐的序列，逐张算 dHash，再把「画面没变」的
 * 连续帧合并掉。**不做场景检测**——它要解码全片，实测比 I 帧直取慢 3.7 倍，而换来的更准的
 * 帧位置对下游没用：真正花钱的是每帧一次 OCR，帧数由「画面变了几次」决定，去重已经做到了。
 */
export async function planVideoFrames(
  path: string,
  opts: PlanVideoFramesOptions = {}
): Promise<KeyframeCandidate[]> {
  const [times, thumbs] = await Promise.all([
    keyframeTimes(path, opts.signal, { headers: opts.headers }),
    keyframeThumbs(path, opts.signal, { headers: opts.headers }),
  ])
  const all = pairFrames(times, thumbs)
  return dedupeFrames(all, opts.minDistance ?? DEFAULT_MIN_DISTANCE)
}

/** 媒体总时长（秒）。ffprobe 的 `format=duration`，与 `src/media/audio-windows.ts` 的
 *  `probeDurationS` 同一条问法。拿不到时长（ffprobe 失败 / 直播流无 duration）就抛，不
 *  默默回 0——那会让 `sampleFrames` 悄悄取出 0 帧，闸门会把「没量到时长」误判成「画面
 *  不动」。 */
export async function mediaDurationS(
  src: string,
  signal?: AbortSignal,
  opts: { headers?: Record<string, string> } = {}
): Promise<number> {
  const { stdout } = await execFileP(
    requireMediaTool('ffprobe'),
    [...headerArgs(opts.headers), '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', src],
    { signal, maxBuffer: 1024 * 1024 }
  )
  const parsed = JSON.parse(stdout) as { format?: { duration?: string } }
  const d = Number(parsed.format?.duration)
  if (!Number.isFinite(d)) throw new Error('[video-frames] ffprobe returned no duration')
  return d
}

/** `sampleFrames` 的默认取样帧数。spec §5.2 第 3 步写的就是这个数——**没量过，是拍的**。 */
export const DEFAULT_SAMPLE_COUNT = 8

/** 探测用的稀疏取样：在片长里均匀挑 `count` 个时刻，各 seek 一次取一帧、算哈希。
 *
 *  **和 `planVideoFrames` 是两条路，别混**：那条要 `-skip_frame nokey` 读完整个文件（两小时的
 *  片子几个 GB），这条每帧只发一次 range 请求，代价与片长无关。闸门用这条，闸门放行之后才付
 *  那条。两者差三个数量级，正是分成两段的全部意义。
 *
 *  取样时刻用 `(i + 0.5) / count * duration`——均匀撒开、天然避开首尾（片头黑场/片尾字幕对
 *  「画面动不动」这个判断是噪声），且严格递增、不会重复。
 *
 *  每个时刻直接发一条独立命令拿 raw 灰度字节喂 `dhash`——**不走 `frameAt`**：那条出的是
 *  JPEG，而 `dhash` 吃的是 272 字节的 17×16 raw 灰度；本模块的不变量之一是不解码图片、不
 *  引任何图像库，所以取样也不能绕道先出 JPEG 再解码。 */
export async function sampleFrames(
  src: string,
  opts: { count?: number; signal?: AbortSignal; headers?: Record<string, string> } = {}
): Promise<KeyframeCandidate[]> {
  const count = opts.count ?? DEFAULT_SAMPLE_COUNT
  if (count <= 0) {
    // 静默回空数组正是本模块头注点名的那个形状——闸门会把「取样数没配对」误判成
    // 「画面不动」。拿不到时长已经堵在 `mediaDurationS` 那头（抛，不默默回 0），
    // 这头也一样：响亮失败，不悄悄退化。
    throw new Error(`[video-frames] sampleFrames count must be > 0, got ${count}`)
  }
  const signal = opts.signal
  const duration = await mediaDurationS(src, signal, { headers: opts.headers })
  const times = Array.from({ length: count }, (_, i) => ((i + 0.5) / count) * duration)
  const thumbs = await Promise.all(
    times.map((t) =>
      runFfmpegCollectStdout(
        [
          ...headerArgs(opts.headers),
          '-v', 'error',
          '-ss', String(t),
          '-i', src,
          '-frames:v', '1',
          '-vf', `scale=${THUMB_W}:${THUMB_H},format=gray`,
          '-f', 'rawvideo',
          '-',
        ],
        { signal }
      )
    )
  )
  return times.map((at, i) => ({ at, hash: dhash(new Uint8Array(thumbs[i]!.buffer, thumbs[i]!.byteOffset, thumbs[i]!.length)) }))
}
