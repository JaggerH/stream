import type { StreamInfo } from './extract.ts'

/**
 * 抽一集的音频，走哪个**容器**、取里面哪条**轨**。
 *
 * 这两件事的代价完全不同，必须分开判——这是 2026-07-22 实测推翻前一版模型后的结论：
 *
 *  - **网络代价 = 整个容器的字节数，和音轨多大无关。** mkv/mp4 音视频交织，HTTP 源上没有
 *    「只取一条流」这回事：ffmpeg 得把容器流过去，顺路把不要的视频一起拉下来。实测（百花杀
 *    S01E17，5.5GiB 原盘，抽 2 分钟音频）：取 128kbps 立体声轨拉 236.4MiB、取 448kbps 5.1 轨
 *    拉 235.7MiB——**一模一样**，正好等于 2/46.6 × 5.5GiB。挑轨省不到一个字节。
 *  - **产出代价 = 那条轨自己的字节数。** 抽出来的音频要发给 ASR，所以轨还是要挑便宜的，
 *    只是它省的是上传和推理，不是下载。
 *
 * 于是判决分两步：先按容器字节挑容器（原盘 vs 网盘转码档），再在选中的容器里按码率挑轨。
 *
 * 前一版把两者混成一个数（拿「音轨字节」和「整档字节」比大小），结论是反的：它算出原盘那条
 * 128kbps 轨只要 43MB、`transcode:low` 要 143MB，于是永远选原盘——而真实代价是 5.5GiB vs
 * 143MiB，**差 39 倍，选反了**。
 */
export interface AudioContainer {
  kind: 'original' | 'transcode'
  /** 日志/调试用的人类标签，如 `original` 或 `transcode:low` */
  label: string
  /** 整个容器的字节数——判路比的就是它。网盘没报就是 undefined：不可比，不参与竞争。 */
  bytes?: number
  /** transcode: 该档位的直链。original 用 netdisk.rawUrl 现求（直链短命，不预取）。 */
  url?: string
  /** transcode: 取这条直链必须带的请求头（夸克要 cookie+referer，否则 412）。 */
  headers?: Record<string, string>
}

/** 网盘给出的一个可播转码档。`sizeBytes` 是**整档**大小；夸克 `file/v2/play` 每档都报。 */
export interface TranscodeCandidate {
  resolution: string
  url: string
  sizeBytes?: number
  headers?: Record<string, string>
}

export function transcodeContainer(c: TranscodeCandidate): AudioContainer {
  return { kind: 'transcode', label: `transcode:${c.resolution}`, bytes: c.sizeBytes, url: c.url, headers: c.headers }
}

/**
 * 最小的容器赢。
 *
 * 没有余量、没有惩罚系数——上一版那个 `TRANSCODE_SLOWDOWN = 12` 是拿错单位算出来的假象，
 * 已删。容器字节是两边同一把尺子量的同一件东西，直接比大小即可。
 *
 * 只有两种情况回落原盘：转码档没报大小（不可比，不拿猜的数字赌一次几百 MB 的传输），
 * 或者它并不更小。原盘是安全默认——它不依赖转码存在、不怕档位过期、不需要额外凭证。
 */
export function pickAudioContainer(containers: AudioContainer[]): AudioContainer | undefined {
  const original = containers.find((c) => c.kind === 'original')
  const cheapest = containers
    .filter((c) => c.bytes != null)
    .sort((a, b) => a.bytes! - b.bytes!)[0]
  if (!original) return cheapest ?? containers[0]
  if (!cheapest || original.bytes == null) return original
  return cheapest.bytes! < original.bytes ? cheapest : original
}

/**
 * 选中的容器要不要先并行预取到本地再抽（机制见 src/media/prefetch.ts）。
 *
 * 预取赢在两处：并行连接绕开 CDN 的按连接限速（实测 1→4 连接 = 1.04→5.29 MiB/s），
 * 本地读消掉 ffmpeg 对远端流 1.92× 的重复读。但它要**先把整个容器落盘**——所以只对
 * 「大小已知且不太大」的容器做：大小未知没法分段；太大（判决落到 4k 档或原盘的场景）
 * 落盘本身就成了新的代价，还不如流式抽。阈值取 512MiB：盖住所有 low/normal/high 档
 * （实测 109–381MiB），把 1.2GiB 的 4k 档和几 GiB 的原盘留在流式路径。
 */
export const PREFETCH_MAX_BYTES = 512 * 1024 * 1024
export function shouldPrefetch(container: AudioContainer): boolean {
  return container.bytes != null && container.bytes <= PREFETCH_MAX_BYTES
}

const LOSSLESS = /^(flac|alac|truehd|mlp|pcm|dts-hd|wavpack|tta|ape)/i

/**
 * 一条音轨的有效码率（bits/s）。容器声明了就用声明的；没声明按 **编码 + 声道** 估。
 *
 * 按声道估对有损编码够用，但**无损编码会被严重低估**——FLAC/ALAC 立体声实打实 700–1000kbps，
 * 按「立体声 = 192kbps」算会差 4–5 倍。这个方向的错是危险的：低估会让判决**主动选中**一条更贵
 * 的轨（高估只会让它避开，是安全的）。所以无损单独一档。
 */
export function effectiveBitrate(track: StreamInfo): number {
  if (track.bitrate) return track.bitrate
  const ch = track.channels ?? 2
  if (LOSSLESS.test(track.codec)) return ch >= 6 ? 4_000_000 : 900_000
  if (ch >= 8) return 900_000
  if (ch >= 6) return 640_000
  return 192_000
}

/** 这条轨的人类标签，如 `aac/2ch/128kbps`。 */
export function trackLabel(track: StreamInfo): string {
  return `${track.codec}${track.channels ? `/${track.channels}ch` : ''}/${Math.round(effectiveBitrate(track) / 1000)}kbps`
}

/**
 * 选中容器里最便宜的那条音轨。省的是**产出**（发给 ASR 的字节、推理时间），不是下载——
 * 下载在挑容器那一步就定死了。ASR 不在乎声道数，它自己会降混，所以永远可以取最省的。
 * 码率相同则保持文件顺序（sort 稳定）。
 */
export function pickAudioTrack(audio: StreamInfo[]): StreamInfo | undefined {
  return [...audio].sort((a, b) => effectiveBitrate(a) - effectiveBitrate(b))[0]
}
