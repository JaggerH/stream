import { readFile } from 'node:fs/promises'
import { extractNetdiskAudio } from '../netdisk/extract-audio.ts'
import { servingPolicyFor, serveWithPolicy } from '../media/serving.ts'
import { originFallback } from '../../shared/music/origin-fallback.ts'
import { memberFailureReason, type VideoResolver } from '../video/resolve-video.ts'
import type { InvokeResult } from '../providers/executor.ts'
import type { NetdiskService } from '../netdisk/sync.ts'
import type { Media } from '../content/types.ts'

export interface MediaBytes {
  bytes: Uint8Array
  mime: string
}

export interface MediaDeps {
  /** Stream-managed netdisk episodes/movies: resolve the bound file and extract its audio track.
   *  noteResolveError/Ok 记绑定级健康态（object-not-found 标 broken、成功清）——可选（`?.` 调用），
   *  仅注入完整 NetdiskService 时上报，只握 lookup/rawUrl 的替身不必实现。 */
  netdisk?: Pick<NetdiskService, 'lookup' | 'rawUrl'> & Partial<Pick<NetdiskService, 'noteResolveError' | 'noteResolveOk' | 'lookupAll'>>
  /** 抽音判路的转码档候选与音轨缓存。声明在这一层是因为**两条腿都要**：source.ts 的主腿
   *  （handle 直查绑定）和本文件的 legacy 腿（media URL 里嵌网盘 key）必须走同一套优化，
   *  否则后者悄悄退回「原盘流式抽、不缓存」的老行为。 */
  transcodeCandidates?: (path: string) => Promise<import('../media/audio-route.ts').TranscodeCandidate[]>
  audioCache?: import('../media/audio-cache.ts').AudioCacheLike
  /**
   * 「这条音轨的字节去哪儿取」——播放路径那条统一漏斗（`src/audio/track-source.ts` 的
   * `resolveTrackSource`），由 bootstrap 绑好归档/网盘/provider 三样依赖后**以函数形式**注入。
   *
   * 为什么是函数而不是把那三样 dep 摊进来：转写层不该认识 provider executor 与凭证。缺它
   * （老 mock / 只跑视频腿的注入）→ 音频退化到只剩裸直链那一支。
   *
   * `fallbackUrl` = 这条 media 身上的源站原始直链（判据 `shared/music/origin-fallback.ts`，与
   * 播放侧同一份）。**不传它就等于砍掉漏斗的第四档**：免费播客前三档全落空，第四档手里是空的，
   * 于是 3ms 判「没地址」——活体撞过（2026-08-12）。
   */
  resolveTrack?: (
    platform: string,
    id: string,
    fallbackUrl?: string
  ) => Promise<import('../audio/track-source.ts').TrackSource>
  /**
   * 「这个平台的这个 id → 可播放的东西」（`src/video/resolve-video.ts`）。缺它 = 这条腿不存在
   * （返回 null），**不猜地址**：宿主不认识任何平台的 URL 形状。成员的失败原话经第五参 `sink`
   * 取回（解析器自己不抛），见 fetchBytes 里的注释。
   */
  resolveVideo?: VideoResolver
}

/** 本地归档文件的 mime。与 `/api/media/assets/:id/file` 那一处同一套映射（下游 ffmpeg 按字节
 *  自嗅探，这个值只用于记录与传参）。 */
function archiveMime(format: string): string {
  if (format === 'mp3') return 'audio/mpeg'
  if (format === 'm4a') return 'audio/mp4'
  if (format === 'flac') return 'audio/flac'
  return `audio/${format}`
}

type VideoMedia = Extract<Media, { kind: 'video' }>
type AudioMedia = Extract<Media, { kind: 'audio' }>
/** 可转写的两种媒体：视频（provider 定位 / 网盘 resolve url）与音频（`platform`+`track_id` 喂
 *  统一漏斗，或只有裸直链的老形状）。 */
export type TranscribableMedia = VideoMedia | AudioMedia

/**
 * The netdisk mapping leftKey for a Stream-managed video, or undefined. Stream-managed
 * episodes/movies play through `/api/media/videos/resolve?key=<leftKey>` (TMDb-keyed) or
 * `?id=<itemId>` (a netdisk-bound followed stream, keyed `item:<id>`) — the same key/id
 * family `app/src/lib/videoPlan.ts` and the netdisk-subtitle routes resolve. Provider-hosted / remote
 * urls carry the resolve endpoint on neither, so gating on it keeps this precise.
 *
 * Exported: `src/media/video-source.ts` (video-frame extraction) needs the identical judgment —
 * it wants the video half of the same item this function's audio-extraction caller strips away,
 * so it must recognize the same netdisk-bound video the same way, not a re-guessed copy.
 */
export function netdiskLeftKey(url?: string): string | undefined {
  if (!url || !url.includes('videos/resolve')) return undefined
  const key = url.match(/[?&]key=([^&]+)/)?.[1]
  if (key) return decodeURIComponent(key)
  const id = url.match(/[?&]id=([^&]+)/)?.[1]
  return id ? `item:${decodeURIComponent(id)}` : undefined
}

/**
 * The first transcribable media on an item：
 *  - 视频：带 provider 定位符（vid/embed/page_url）或网盘 resolve url；
 *  - 音频：**能喂给统一漏斗**（有 `platform`+`track_id`——归档/网盘/官方源/回落四档按这对键查），
 *    或只有一条裸直链的老形状（库里 22 条，见下面的直链兜底）。
 *
 * 判据与前端那份（`shared/extract/plan.ts` 的 `hasSource('stt')`）必须一致：一边说行、另一边
 * 说不行是静默错位，两边单看都正常。
 */
export function transcribableMedia(media: Media[] | undefined): TranscribableMedia | undefined {
  return (media ?? []).find(
    (m): m is TranscribableMedia =>
      (m.kind === 'video' && (!!m.vid || !!m.embed || !!m.page_url || !!netdiskLeftKey(m.url))) ||
      (m.kind === 'audio' && (!!m.url || !!(m.platform && m.track_id)))
  )
}

/** 拿到的 content-type（去掉参数）；上游没说就按 `audio/mpeg` 兜底——播客直链绝大多数是 mp3，
 *  且下游 ffmpeg 按字节自嗅探，这个值只用于记录与传参。 */
function audioMimeOf(resp: Response): string {
  return resp.headers.get('content-type')?.split(';')[0]?.trim() || 'audio/mpeg'
}

/**
 * Resolve a video item's media to raw bytes for transcription: 网盘绑定的取绑定文件，带
 * (provider, vid) 的视频一律经 `resolveVideo` 要一份纯音轨（没有就退到整片）——宿主不认识
 * 任何平台的 URL 形状，哪个平台的 vid 怎么解归认领它的包。
 *
 * 两种「没拿到」分得开：**null = 这条内容里没有可转写的东西**（也包括网盘绑定那条腿自己降级的
 * 情形）；**抛出 = 有东西但取不到**，异常带着上游原话。调用方（转换 runner）会把这句话落进
 * 转换记录，用户和模型读到的就是它。
 */
export async function resolveMediaBytes(media: Media[] | undefined, deps: MediaDeps): Promise<MediaBytes | null> {
  const v = transcribableMedia(media)
  if (!v) return null

  // Stream-managed netdisk episode/movie: resolve the bound file and pull its audio track
  // (stream-copy, no transcode). Extraction is network-heavy (~20s) and throws on no-audio /
  // failure — swallow to null so one bad episode can't fail the whole transcribe queue, matching
  // the provider branches' "can't transcribe this one" contract.
  const leftKey = v.kind === 'video' ? netdiskLeftKey(v.url) : undefined
  if (leftKey) {
    if (!deps.netdisk) return null
    const hit = deps.netdisk.lookup(leftKey)
    if (!hit) return null
    const p = `${hit.dirPath}/${hit.rightFile}`
    try {
      const out = await extractNetdiskAudio(deps.netdisk, p, {
        transcodeCandidates: deps.transcodeCandidates && (() => deps.transcodeCandidates!(p)),
        cache: deps.audioCache,
      })
      deps.netdisk.noteResolveOk?.(hit.setId) // 成功 → 清 broken
      return out
    } catch (e) {
      deps.netdisk.noteResolveError?.(hit.setId, e) // object-not-found → 标 broken（临时故障内部忽略）
      return null
    }
  }

  // 每条腿只答两件事：**这份字节的键是什么**、**没有的话怎么取**。取本身推迟到下面那一句
  // `readOrCompute` 里去发生——键必须先于取确定，否则「有人正在取同一份」这件事无从判起
  // （取都开始了才知道自己在取什么，为时已晚）。
  //
  // 键在每条腿里**只出现一次**，就是下面这些 `cacheKey = …`：落盘缓存和在途表共用它。
  // 另算一把键去记「谁在取」，两把键漂移了不会报错，只会安静地各取各的。
  let cacheKey: string | undefined
  let fetchBytes: (() => Promise<MediaBytes>) | undefined

  // 音频：**走播放那条统一漏斗**（`src/audio/track-source.ts`），四档一个不漏——本地归档、
  // 网盘绑定、官方 provider 梯子、回落原始直链。别在这里自己分腿：上一版只抄了「网盘 + 直链」
  // 两档，结果是已经下到本地的照样跑去 CDN 拉、有官方源的播客直接判成「没有可转写的东西」。
  //
  // 不需要落盘/分段：下游 planSttChunks 先把它压成 mono/16k/32kbps m4a（≈4KB/s，45 分钟约 11MB），
  // 比一直以来整段读进内存的网盘腿还小。
  if (v.kind === 'audio') {
    if (deps.resolveTrack && v.platform && v.track_id) {
      const { platform, track_id: trackId, url } = v
      const resolveTrack = deps.resolveTrack
      cacheKey = `track:${platform}:${trackId}`
      fetchBytes = async () => {
        const src = await resolveTrack(platform, trackId, originFallback(url))
        if (src.kind === 'archive') {
          // 已经在盘上——直接读，别再过网络。这一档正是平行实现漏掉的那个。
          return { bytes: new Uint8Array(await readFile(src.absPath)), mime: archiveMime(src.format) }
        }
        if (src.kind === 'unresolved' || src.kind === 'unavailable') {
          // 「有东西但取不到」——抛，让真实原因一路走到转换记录和用户面前（见本函数头注）。
          throw new Error(src.detail || '这条音轨四档都没解析到可取的地址')
        }
        // 回落原始直链**不能裸 fetch**：这些直链绝大多数在荔枝 CDN 上，冷对象第一次被请求就 403，
        // 而同一文件不同主机速度差过一万三千倍（策略表在 src/media/serving.ts，播放侧同款处置）。
        const policy = src.kind === 'fallback' ? servingPolicyFor(src.url) : undefined
        const resp = policy
          ? await serveWithPolicy(src.url, policy)
          : await fetch(src.url, src.kind === 'stream' && src.headers ? { headers: src.headers } : undefined)
        return bytesOf(resp, audioMimeOf(resp))
      }
    } else if (v.url) {
      // 直链兜底，**不是主路**：库里 22 条老形状的 audio 既没 platform 也没 track_id，漏斗按
      // `platform:id` 索引，对它们无从下手。新数据不会长成这样，这一支只为存量。
      const url = v.url
      cacheKey = `audio:${url}`
      fetchBytes = async () => {
        const policy = servingPolicyFor(url)
        const resp = policy ? await serveWithPolicy(url, policy) : await fetch(url, undefined)
        return bytesOf(resp, audioMimeOf(resp))
      }
    } else {
      return null // 漏斗没接、又没有直链 → 这条确实取不到（与「没有可转写的东西」同义）
    }
  } else if (v.kind === 'video' && v.provider && v.vid) {
    const { provider, vid } = v
    const resolveVideo = deps.resolveVideo
    if (!resolveVideo) return null
    cacheKey = `${provider}:${vid}`
    fetchBytes = async () => {
      // **先要纯音轨**：STT 要的是声音，整片视频是几十倍的字节。这个平台没有独立音轨时
      // （解析器返回 null）退一档要整片——空着不退的话表现是"这条能转写的内容说自己不能转写"。
      //
      // 两档都空时要说得出**为什么**：解析器不抛成员的错（执行器收进 `misses`、返回 null），
      // 所以最后那一档（整片）传 `sink` 接下它的 `InvokeResult`——成员失败过（作品被删 / 私密的
      // 站方原话、容器报错）就抛那句原话；只是 decline / 没有行匹配才落到通用那句。
      const sink: { last?: InvokeResult | null } = {}
      const audio = await resolveVideo(provider, vid, 'audio')
        ?? await resolveVideo(provider, vid, 'progressive', undefined, sink)
      if (audio?.kind !== 'progressive') {
        throw new Error(memberFailureReason(sink.last) ?? '这条视频没有解析到可取的音轨地址')
      }
      return bytesOf(await fetch(audio.url, { headers: audio.headers }), audio.mime ?? 'audio/mp4')
    }
  }

  if (!cacheKey || !fetchBytes) return null
  // 和 netdisk 腿同一套缓存基建：同一条内容 10 分钟内重转（开关 diarize、补说话人）不再整段重下，
  // **而且两个消费方同时开工时只取一遍**（取白文 ‖ 声纹时间轴，见 AudioCache 的在途表）。
  //
  // 归档那一档现在也会被存进缓存（以前是直接返回、绕过缓存）：多一份 10 分钟的盘上副本，
  // 换来的是「同时开工的第二个人不用再读一遍那个大文件」。这是有意的，不是回归。
  return deps.audioCache ? deps.audioCache.readOrCompute(cacheKey, fetchBytes) : fetchBytes()
}

/** 读一次失败响应里的原因：JSON 信封带 `detail`（`src/media/serving.ts` 的代理层拒绝时回的
 *  `{ error, detail }` 就是这个形状；`/api/media/play|dash` 解析为空的 404/502 也带它）就取它；
 *  取不出就退回带状态码的兜底——**绝不返回空串**，空的失败原因等于没有失败原因。 */
async function failureText(resp: Response): Promise<string> {
  const raw = await resp.text().catch(() => '')
  try {
    const detail = (JSON.parse(raw) as { detail?: unknown }).detail
    if (typeof detail === 'string' && detail.trim()) return detail.trim()
  } catch {
    // 不是 JSON（或截断了）→ 落到下面的兜底
  }
  return `取媒体失败（HTTP ${resp.status}）`
}

/** 一个响应 → 字节。**响应失败要抛，不能退回 null**：「取到了一个响应但它失败了」和
 *  「这条内容里压根没有可转写的东西」是两件事。两者都退回 null 的话，用户看到的都是那句
 *  「这条内容里没有可语音转文字的东西」——一句会把人送去查错误方向的话（真相往往是 CDN
 *  一时 403）。抛出去，真实原因才走得到转换记录、事件和用户面前。 */
async function bytesOf(resp: Response, mime: string): Promise<MediaBytes> {
  if (!resp.ok) throw new Error(await failureText(resp))
  return { bytes: new Uint8Array(await resp.arrayBuffer()), mime }
}
