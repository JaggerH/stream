import { backendUrl } from './backendUrl.ts'
import { imgUrl } from './imageUrl.ts'
import type { Media } from './types.ts'

export type VideoMedia = Extract<Media, { kind: 'video' }>

/** How a video media item should be played. 带 (provider, vid) 的平台一律落 `dash` 那一档，
 *  **前端不认识平台名**——加一个平台 = 装一个包，这里零改动；只有网盘绑定走 `file`。
 *  The player component renders the resolved plan and never learns provider specifics. */
export type VideoPlan =
  // 分离流 DASH + 渐进式回落地址（任何带 provider+vid 的平台）
  | { kind: 'dash'; dashUrl: string; progressiveUrl: string; progressKey: string; poster?: string }
  // a single progressive mp4, proxied through the backend (Stream-managed netdisk files)
  | { kind: 'file'; src: string; poster?: string; progressKey?: string; subtitleListUrl?: string; subtitleUrlBase?: string }
  // a third-party embeddable player (generic RSS/搜索 results) — click-to-load
  | { kind: 'iframe'; src: string }
  // no playable stream, only a cover image
  | { kind: 'poster'; src: string }
  | { kind: 'none' }

/** Decode a video media item into a provider-agnostic playback plan. This is the
 *  single place provider knowledge lives, so the player stays dumb and new sources
 *  are one branch away. */
export function planVideo(m: VideoMedia, baseUrl: string): VideoPlan {
  // 海报最终落进 `<video poster>` / `<img src>`，浏览器**自己**去取——所以和正片流不是一回事：
  // 正片走 backendUrl（只是补个源，字节本来就归后端发），海报走 imgUrl（**要代理**，否则
  // 防盗链图床对着我们这个来源直接不发图，表现为播放器一片黑而没有任何报错）。两者语义不同，
  // 别互相替代；imgUrl 里已经处理了「海报本身就是后端根相对路由」那一档（转交 backendUrl）。
  const poster = m.poster ? imgUrl(baseUrl, m.poster) : undefined
  // Resolved Stream-managed files (for example AList episode bindings) are already
  // authorized backend paths. Keep absolute URLs intact for remote backends.
  if (m.url) {
    const src = backendUrl(baseUrl, m.url)
    // Stream-managed movies/episodes play via /api/media/videos/resolve?key=<leftKey>. That leftKey
    // ("tmdb:1399:S01E01" for an episode, "tmdb:969681" for a movie) already embeds the work id, so
    // it's globally unique and session-stable — reuse it as the progress key so each movie/episode
    // resumes where it left off (per-episode falls out for free).
    // A netdisk-bound *followed* stream (e.g. an iqiyi series the user added) instead resolves by
    // item id (…/resolve?id=<item.id>, video-playability.ts) — no leftKey. The item id is likewise
    // stable + globally unique (the netdisk mapping keys on `item:<id>`), so it doubles as the resume
    // key too, namespaced `item:` to stay clear of tmdb / `<provider>:<vid>` keys. Direct absolute urls (remote
    // backends / AList) carry neither and simply don't resume.
    const key = m.url.match(/[?&]key=([^&]+)/)?.[1]
    const id = m.url.match(/[?&]id=([^&]+)/)?.[1]
    const progressKey = key
      ? decodeURIComponent(key)
      : id
        ? `item:${decodeURIComponent(id)}`
        : undefined
    // Stream-managed netdisk episodes/movies (same key/id family as the resolve url above) may carry
    // subtitle tracks (embedded streams and/or sibling external files) — netdisk-subtitle-list finds
    // them, netdisk-subtitle?...&track=<embed:n | file:relPath> serves one as vtt. Absent for
    // non-netdisk absolute urls (remote backends carry neither key nor id).
    const subtitleQuery = key ? `key=${key}` : id ? `id=${id}` : undefined
    return {
      kind: 'file',
      src,
      poster,
      ...(progressKey ? { progressKey } : {}),
      ...(subtitleQuery
        ? {
            subtitleListUrl: `${baseUrl}/api/media/netdisk-subtitle-list?${subtitleQuery}`,
            subtitleUrlBase: `${baseUrl}/api/media/netdisk-subtitle?${subtitleQuery}`,
          }
        : {}),
    }
  }

  // 任何带 (provider, vid) 的视频：一律给 dash + progressive 两个地址（dash 播不了时播放器
  // 自己回落，见 ArtPlayer 的 mpdHandler）。**前端不认识平台名**——vid 长什么样、后端怎么解，
  // 归认领那个平台的包。
  if (m.provider && m.vid) {
    const q = `platform=${encodeURIComponent(m.provider)}&vid=${encodeURIComponent(m.vid)}`
    return {
      kind: 'dash',
      dashUrl: `${baseUrl}/api/media/dash?${q}`,
      progressiveUrl: `${baseUrl}/api/media/play?${q}`,
      progressKey: `${m.provider}:${m.vid}`,
      poster,
    }
  }
  if (m.embed) return { kind: 'iframe', src: m.embed }
  if (poster) return { kind: 'poster', src: poster }
  return { kind: 'none' }
}

/** The first directly-playable video media on an item (DASH or progressive mp4),
 *  used to drive inline-thumb playback. Returns undefined when the card carries no
 *  playable stream (iframe embed / poster only — those just open the modal, where
 *  enrichment can resolve a stream). `baseUrl` is irrelevant to the kind, so '' is
 *  fine for the playable test. */
export function playableVideo(media: Media[] | undefined): VideoMedia | undefined {
  for (const m of media ?? []) {
    if (m.kind !== 'video') continue
    const k = planVideo(m, '').kind
    if (k === 'dash' || k === 'file') return m
  }
  return undefined
}
