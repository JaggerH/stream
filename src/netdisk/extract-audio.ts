import type { NetdiskService } from './sync.ts'
import { probeStreams, extractStream } from '../media/extract.ts'
import {
  pickAudioContainer, pickAudioTrack, transcodeContainer, trackLabel, shouldPrefetch,
  type AudioContainer, type TranscodeCandidate,
} from '../media/audio-route.ts'
import { prefetchToFile, type PrefetchResult } from '../media/prefetch.ts'

export interface NetdiskAudio {
  bytes: Uint8Array
  mime: string
}

/** 一次提取的分阶段墙钟与代价，让它是量出来的而不是猜的。 */
export interface ExtractAudioTiming {
  /** 选中的容器：原盘还是网盘转码档 */
  container: AudioContainer['kind']
  /** 容器标签，如 `original` / `transcode:low` */
  containerLabel: string
  /** 选中容器的字节数——**这是这次提取真正要过网的量**（音视频交织，抽音要流过整个容器） */
  containerBytes?: number
  /** 有几个容器可选（原盘 + 各转码档） */
  containers: number
  /** 命中音轨缓存——所有网络阶段全跳过，其余字段是缓存写入那次的形状之外的默认值 */
  cached?: boolean
  /** 首选的转码档探/抽失败后回落到了原盘——值是失败那档的标签（如 `transcode:low`）。
   *  真实事故(2026-07-23):夸克转码直链全家 412 而原盘直链正常;回落让"转码腿挂"只表现为
   *  成本升高(整盘过网),不再表现为"网盘音频腿挂"。 */
  fellBackFrom?: string
  /** 预取阶段墙钟与连接数。缺席 = 没预取（容器太大/大小未知/预取失败退回流式）。 */
  prefetchMs?: number
  prefetchConnections?: number
  /** 选中的音轨标签，如 `aac/2ch/128kbps`；它决定产出大小（发给 ASR 的字节），不决定下载量 */
  track: string
  index?: number
  /** 容器里有几条音轨 */
  tracks: number
  rawUrlMs: number
  probeMs: number
  extractMs: number
  /** 产出字节（抽出来的音频），**不是**过网字节——两者差着整个容器 */
  bytes: number
}

/** 网盘文件 → 音轨字节（stream copy，不转码），形状对齐 src/transcribe/sources.ts 的 TranscribeInput
 *  ({bytes, mime}) —— 喂给 transcribe 管线不需要改 TranscribeClient 任何代码。
 *
 *  这是**网络 I/O 密集**操作，而且贵在容器不在音轨：抽音要把整个容器流过去（音视频交织，HTTP 源
 *  上没有「只取一条流」这回事）。所以省钱的唯一手段是**挑一个更小的容器**——网盘自己的低清转码档
 *  往往比原盘小一到两个数量级（实测 143MiB vs 5.5GiB）。判决在 src/media/audio-route.ts。
 *  GPU 在这里没有用武之地，`-c:a copy` 既不解码也不编码。
 *
 *  index 缺省时判路 + 探测 + 挑轨；没有任何可用音轨则抛错，交给调用方决定降级策略。
 *  `onTiming` 给出选中的容器、音轨、分阶段耗时——**耗时和字节数一律从这里读，别猜**。 */
export async function extractNetdiskAudio(
  netdisk: Pick<NetdiskService, 'rawUrl'> & Partial<Pick<NetdiskService, 'fileSize'>>,
  path: string,
  opts?: {
    index?: number
    onTiming?: (t: ExtractAudioTiming) => void
    /** 这个文件的可播转码档（更小的容器候选）。不注入 = 只有原盘可选，行为等同从前。
     *  best-effort：抛错/取不到只是少一个候选，不能让整次提取失败。 */
    transcodeCandidates?: () => Promise<TranscodeCandidate[]>
    /** 音频落盘缓存（src/media/audio-cache.ts，各腿共用；键 = 盘内路径）。命中 = 零网络；
     *  读写失败都不影响提取本身。 */
    cache?: import('../media/audio-cache.ts').AudioCacheLike
  },
): Promise<NetdiskAudio> {
  // 同一个盘内路径同一时刻只抽一次，后来者等第一个的结果（AudioCache 的在途表）。
  // **键就是 path**，和下面读写缓存用的是同一把——另算一把就会漂移。
  //
  // 显式 index 不共享：那是调试路径，调用方要的就是他点名的那条轨，不能拿别人抽的另一条给他。
  const cache = opts?.cache
  if (!cache || opts?.index !== undefined) return extractOnce(netdisk, path, opts)
  // 问和抢必须在同一个 tick 内（中间不能有 await），否则这个判断就成了猜的。
  const joining = cache.isInFlight(path)
  const out = await cache.share(path, () => extractOnce(netdisk, path, opts))
  // 等来的这一份也要在账上留一条——静静少一条 timing 会让「这次没抽」看起来像「这次没跑」。
  if (joining) {
    opts?.onTiming?.({
      container: 'original', containerLabel: 'inflight', containers: 0, cached: true,
      track: 'inflight', tracks: 0, rawUrlMs: 0, probeMs: 0, extractMs: 0, bytes: out.bytes.length,
    })
  }
  return out
}

async function extractOnce(
  netdisk: Pick<NetdiskService, 'rawUrl'> & Partial<Pick<NetdiskService, 'fileSize'>>,
  path: string,
  opts?: Parameters<typeof extractNetdiskAudio>[2],
): Promise<NetdiskAudio> {
  const t0 = Date.now()

  // 0. 缓存最先问——命中就什么网络都不碰（连 rawUrl 都不必求）。显式 index 是调试路径，不经缓存。
  if (opts?.cache && opts.index === undefined) {
    const hit = await opts.cache.read(path).catch(() => null)
    if (hit) {
      opts.onTiming?.({
        container: 'original', containerLabel: 'cache', containers: 0, cached: true,
        track: 'cached', tracks: 0, rawUrlMs: 0, probeMs: 0, extractMs: 0, bytes: hit.bytes.length,
      })
      return hit
    }
  }

  const rawUrl = await netdisk.rawUrl(path)
  const t1 = Date.now()

  // 显式 index = 调用方已经替我们判过了（调试端点、重跑某条特定轨），照做、不探测、不判路。
  if (opts?.index !== undefined) {
    const t2 = Date.now()
    const { bytes, mime } = await extractStream(rawUrl, { index: opts.index, kind: 'audio' })
    opts.onTiming?.({
      container: 'original', containerLabel: 'original', containers: 1,
      track: 'explicit', index: opts.index, tracks: 0,
      rawUrlMs: t1 - t0, probeMs: t2 - t1, extractMs: Date.now() - t2, bytes: bytes.length,
    })
    return { bytes, mime }
  }

  // 1. 挑容器。原盘大小问 netdisk（AList fs/get 本来就带 size）；拿不到就只是「不可比」，
  //    此时转码档不会赢、回落原盘——不拿猜的数字赌一次几百 MB 的传输。
  const [size, candidates] = await Promise.all([
    netdisk.fileSize?.(path).catch(() => undefined),
    opts?.transcodeCandidates?.().catch(() => [] as TranscodeCandidate[]) ?? [],
  ])
  const containers: AudioContainer[] = [
    { kind: 'original', label: 'original', bytes: size },
    ...candidates.map(transcodeContainer),
  ]
  const chosen = pickAudioContainer(containers)!

  /** 对一个容器跑完 预取→探轨→抽取 全程。失败原样抛给调用方分层处理。 */
  const runContainer = async (container: AudioContainer, fellBackFrom?: string): Promise<NetdiskAudio> => {
    const remoteUrl = container.kind === 'transcode' ? container.url! : rawUrl

    // 2. 容器不大就先并行预取到本地：并行连接绕开 CDN 按连接限速，本地读消掉 ffmpeg 对远端流
    //    ~2× 的重复读（数字与出处见 prefetch.ts 头注）。预取失败退回流式抽——慢，但一样对。
    let prefetch: PrefetchResult | undefined
    if (shouldPrefetch(container)) {
      prefetch = await prefetchToFile(remoteUrl, { size: container.bytes!, headers: container.headers }).catch(() => undefined)
    }
    const url = prefetch?.path ?? remoteUrl
    const headers = prefetch ? undefined : container.headers
    // 分段计时必须互不重叠：probe 的表从预取结束才起——首个活体运行就把预取的 31.5s 记进了
    // probeMs（31801ms），读起来像本地 ffprobe 花了半分钟。
    const tProbe = Date.now()

    try {
      // 3. 在选中的容器里挑轨。必须探**选中的那个**容器——转码档的轨和原盘的轨是两套东西。
      const { audio } = await probeStreams(url, { headers })
      const track = pickAudioTrack(audio)
      if (!track) throw new Error('[extract-audio] no audio stream found')
      const t2 = Date.now()

      const { bytes, mime } = await extractStream(url, { index: track.index, kind: 'audio', headers })
      await opts?.cache?.write(path, { bytes, mime }).catch(() => {}) // 缓存写失败不拖累提取
      opts?.onTiming?.({
        container: container.kind,
        containerLabel: container.label,
        containerBytes: container.bytes,
        containers: containers.length,
        prefetchMs: prefetch?.ms,
        prefetchConnections: prefetch?.connections,
        fellBackFrom,
        track: trackLabel(track),
        index: track.index,
        tracks: audio.length,
        rawUrlMs: t1 - t0,
        probeMs: t2 - tProbe,
        extractMs: Date.now() - t2,
        bytes: bytes.length,
      })
      return { bytes, mime }
    } finally {
      await prefetch?.cleanup()
    }
  }

  // 4. 转码档失败 → 回落原盘重来一遍，恰好一次。真实事故(2026-07-23):夸克转码直链全家 412
  //    而原盘 AList 直链同刻 206 正常——播放代理早有 rawFallback,这里此前没有,于是"转码腿挂"
  //    被放大成"网盘音频腿挂"(job 记 no transcribable media)。回落后的代价是整盘过网(成本升高),
  //    不是失败。原盘自己炸没有更下一级,原样上抛。
  //    412 真因(当日活体二分钉死):CDN 转码鉴权严格校验 __puus 新鲜度,broker 里的 __puus 过期
  //    即全家 412(drive-pc API 容忍旧值,所以取链照样成功);用户开一次 quark 网页端刷新 __puus、
  //    下一轮把新 cookie 取回 broker 就自愈。不是防盗链/URL 参数变更——同 URL 同 curl,换新 cookie 即 200。
  if (chosen.kind !== 'transcode') return runContainer(chosen)
  try {
    return await runContainer(chosen)
  } catch {
    return runContainer(containers.find((c) => c.kind === 'original')!, chosen.label)
  }
}
