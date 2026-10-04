/**
 * 从容器 `/api/hybrid/video_data` 回的 `data` 里抠出**一条可直连的播放地址**——解析成员
 * （`douyin-resolve` / `tiktok-resolve`）与贴链接抓媒体（`*-fetch-url`）共用这一份，别各抄一遍：
 * 两处各自抠，形状一漂就是「解析得到、贴链接却抓不到」这种两边单看都正常的错位。
 *
 * 两家的 `data` 形状不同（容器按 URL 认平台、原样透传站方结构）：
 * - 抖音是 aweme：`video.play_addr.url_list[]`，首条是 `*.douyinvod.com` 直连 mp4（Range → 206，
 *   但必须带 Referer `https://www.douyin.com/`，否则 403）；末条是主站 `/aweme/v1/play` 兜底。
 *   活体 2026-07-06 校过。
 * - TikTok 是 itemStruct：`video.playAddr`（字符串）为主，`video.bitrateInfo[].PlayAddr.UrlList[]`
 *   是分码率的备选，个别区域 / 版本会给 aweme 风格的 `video.play_addr.url_list`。
 *   ⚠️ PROVISIONAL — not live-verified：本机容器打 tiktokv.com 回空，三条路径按 tiktok-types.ts
 *   与站方 web 结构写的，没有一条是活体核过的；拿到真数据后回来重校（顺序、Referer 都算）。
 */

export type MediaPlatform = 'douyin' | 'tiktok'

/** 直连 CDN 需要的请求头（播放路由 range 代理时原样带上）。 */
const REFERER: Record<MediaPlatform, string> = {
  douyin: 'https://www.douyin.com/',
  tiktok: 'https://www.tiktok.com/',
}

const isHttp = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//.test(u)

/** 一个 `{ url_list }` / `{ UrlList }` 块里的第一条 http(s) 地址。 */
function firstHttp(list: unknown): string | undefined {
  return Array.isArray(list) ? list.find(isHttp) : undefined
}

interface AwemeVideo {
  play_addr?: { url_list?: unknown }
}

interface ItemStructVideo extends AwemeVideo {
  playAddr?: unknown
  bitrateInfo?: Array<{ PlayAddr?: { UrlList?: unknown } }>
}

/** 抠不到给 null（调用方决定是 decline 还是去问站方为什么）。 */
export function playAddrOf(
  platform: MediaPlatform,
  data: Record<string, unknown> | undefined,
): { url: string; headers: Record<string, string> } | null {
  const video = data?.video as ItemStructVideo | undefined
  if (!video) return null
  let url: string | undefined
  if (platform === 'tiktok') {
    url = (isHttp(video.playAddr) ? video.playAddr : undefined)
      ?? firstHttp(video.bitrateInfo?.[0]?.PlayAddr?.UrlList)
      ?? firstHttp(video.play_addr?.url_list)
  } else {
    url = firstHttp(video.play_addr?.url_list)
  }
  return url ? { url, headers: { Referer: REFERER[platform] } } : null
}
