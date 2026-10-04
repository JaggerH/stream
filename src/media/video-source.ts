import { netdiskLeftKey } from '../transcribe/media.ts'
import { memberFailureReason, type VideoResolver } from '../video/resolve-video.ts'
import type { InvokeResult } from '../providers/executor.ts'
import type { Media } from '../content/types.ts'

/** A video address ffmpeg can read directly (a URL, plus any headers its CDN demands). */
export interface VideoSource {
  url: string
  headers?: Record<string, string>
}

export interface VideoSourceDeps {
  /** 网盘绑定：路径 → AList 直链。缺席 = 这条流不接网盘。 */
  netdisk?: {
    lookup(leftKey: string): { dirPath: string; rightFile: string } | undefined
    rawUrl(path: string): Promise<string>
  }
  /** 「这个平台的这个 id → 可播放的东西」（`src/video/resolve-video.ts`）。抽帧要的是
   *  **完整画面**，所以只要 `progressive`；解析器只给得出 dash 时这条腿如实报没有。
   *  解析器本身**不抛**成员的错（执行器把它收进 `misses`、返回 null），所以这里传 `sink` 接下
   *  这一次的 `InvokeResult`，成员失败过（作品没了 / 私密的站方原话、容器报错）就把那句原话
   *  **抛**出去，不吞成 null。 */
  resolveVideo?: VideoResolver
}

type VideoMedia = Extract<Media, { kind: 'video' }>

/** 与 `transcribableMedia`（`src/transcribe/media.ts`）判据故意不同：那条只认「能喂音轨」的
 *  media（含纯音频),这里只认「带视频画面信号」的 video-kind media——两者是两件事,别合并。 */
function firstVideoMedia(media: Media[] | undefined): VideoMedia | undefined {
  return (media ?? []).find(
    (m): m is VideoMedia => m.kind === 'video' && (!!m.vid || !!m.embed || !!m.page_url || !!netdiskLeftKey(m.url)),
  )
}

/**
 * 一条 item 的「ffmpeg 能直接读的视频地址」——抽帧要的正是 `resolveMediaBytes`
 * （`src/transcribe/media.ts`）扔掉的那一半：那条只要音轨（网盘腿抽音、其余平台要纯音频流），
 * 这里要的是完整画面。两条腿形状一致：网盘（AList 直链）、带 `(provider, vid)` 的平台
 * （经 `resolveVideo`，平台归包），都是**直链 + 那个 CDN 要的 headers**。返回地址不返回字节——
 * 几个 GB 的片子不用先落盘，ffmpeg 直接读 URL。
 *
 * **绝不许给 ffmpeg 一个「报错时回 200 + JSON」的中转端点。** 那种端点报错时 content-type 还写着
 * video/mp4，ffmpeg 拿到它只会换回一句 `Invalid data found when processing input`，真实原因
 * （上游 403 了，多半是一时的）全丢。所以这里只要解析成员给出的 CDN 直链——**它也是更便宜的那条**：
 * 省掉一整份经中转的字节。浏览器需要代理是因为它发不出 Referer；ffmpeg 能，headers 就是为此而设。
 *
 * `null` 的语义是「这条 item 没有可抽帧的视频源」（没有可用的 video media / 依赖没接 / 网盘
 * 没配到 / 解析成员 decline），不是「取失败」——调用方据此落「探过，没源」，不报错。**取失败要抛**：
 * 解析器把成员的错收在 `InvokeResult.misses` 里而不是往上抛，所以这条腿经 `sink` 接下那份结果，
 * 成员失败过就把它的原话（作品被删 / 私密时是站方原话，`memberFailureReason`）抛成 Error，
 * 让它落成说得出理由的 `source_failed`。
 */
export async function resolveVideoSource(media: Media[] | undefined, deps: VideoSourceDeps): Promise<VideoSource | null> {
  const v = firstVideoMedia(media)
  if (!v) return null

  const leftKey = netdiskLeftKey(v.url)
  if (leftKey) {
    if (!deps.netdisk) return null
    const hit = deps.netdisk.lookup(leftKey)
    if (!hit) return null
    const url = await deps.netdisk.rawUrl(`${hit.dirPath}/${hit.rightFile}`)
    return { url }
  }

  if (v.provider && v.vid) {
    if (!deps.resolveVideo) return null
    const sink: { last?: InvokeResult | null } = {}
    const r = await deps.resolveVideo(v.provider, v.vid, 'progressive', undefined, sink)
    if (r?.kind === 'progressive') return { url: r.url, headers: r.headers }
    const reason = memberFailureReason(sink.last)
    if (reason) throw new Error(reason)
    return null
  }

  return null
}
