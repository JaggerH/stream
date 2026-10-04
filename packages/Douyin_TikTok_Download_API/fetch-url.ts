import { mediaPlayUrl } from '../../shared/package-sdk/media-url.ts'
import type { FetchUrlResult, FetchedMedia } from '../../src/http/fetch-url.ts'
import { playAddrOf, type MediaPlatform } from './adapter/play-addr.ts'

/** 成员只用 adapter 的这一格：一条链接 → 容器 `/api/hybrid/video_data` 的 `data`。 */
export interface HybridClient {
  hybridVideoData(url: string): Promise<Record<string, unknown>>
}

/** `{ url_list: [...] }` / `{ url_list }` 里的第一条地址（抖音的封面、头像、图集全是这个形状）；
 *  TikTok itemStruct 同一格是裸字符串（`cover` / `avatarThumb`），两种都认。 */
function firstUrl(block: unknown): string | undefined {
  if (typeof block === 'string') return block || undefined
  const list = (block as { url_list?: unknown } | undefined)?.url_list
  return Array.isArray(list) ? list.find((u): u is string => typeof u === 'string' && !!u) : undefined
}

/**
 * 「给我这个链接里的媒体」——本包在 `stream.links` 认领 `douyin.com` / `iesdouyin.com`（平台 douyin，
 * `douyin-url` 行按 `douyin-link` 接）与 `tiktok.com`（平台 tiktok，`tiktok-url` 行按 `tiktok-link` 接）。容器的 `/api/hybrid/video_data` 自己认短链 / 分享链接，
 * 这里不做任何 URL 规整，原样交它。
 *
 * `download_url` 用宿主导出的 `mediaPlayUrl` 拼，**不自己拼路由字符串**、也不把容器的下载口
 * 交给外部客户端：那是插件网关的内部路径，客户端拿到只会指向一个它够不着的地址。
 * 键是作品 id（抖音 `aweme_id` / TikTok `id`）——没有 id 就拼不出播放路由，那条 video media
 * 干脆不给（半条「能看不能下」的媒体比没有更误导）。
 *
 * 容器报错 → **返回**带原话的失败结果，不抛：认领了却失败，`fetchUrl` 那层会照单把原话带出去。
 */
export async function fetchUrlFor(client: HybridClient, platform: MediaPlatform, url: string): Promise<FetchUrlResult> {
  let d: Record<string, unknown>
  try {
    d = await client.hybridVideoData(url)
  } catch (e) {
    return { platform, media: [], error: (e as Error).message }
  }
  const author = d.author as { nickname?: string; avatar_thumb?: unknown; avatarThumb?: unknown } | undefined
  const video = d.video as { cover?: unknown; duration?: number } | undefined
  const vid = String(d.aweme_id ?? d.id ?? '')
  const media: FetchedMedia[] = []

  const play = playAddrOf(platform, d)
  if (play && vid) {
    // duration：抖音 aweme 给的是**毫秒**，TikTok itemStruct 给的是**秒**（与两家 normalizer 同判）。
    const duration = typeof video?.duration === 'number' && video.duration > 0 ? video.duration : undefined
    media.push({
      kind: 'video',
      url: play.url,
      poster: firstUrl(video?.cover),
      duration_s: duration === undefined ? undefined : platform === 'douyin' ? Math.round(duration / 1000) : duration,
      download_url: mediaPlayUrl({ platform, vid, dl: true }),
    })
  }
  // 图集 / 图文：逐张给 image media。
  const images = d.images
  if (Array.isArray(images)) {
    for (const img of images) {
      const src = firstUrl(img)
      if (src) media.push({ kind: 'image', url: src })
    }
  }

  return {
    platform,
    title: String(d.desc ?? d.title ?? ''),
    author: author?.nickname,
    author_avatar: firstUrl(author?.avatar_thumb ?? author?.avatarThumb),
    media,
    raw: d,
  }
}
