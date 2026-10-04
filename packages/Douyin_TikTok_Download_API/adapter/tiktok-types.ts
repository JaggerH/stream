/** Raw shapes returned by the Douyin_TikTok_Download_API TikTok-Web/App routers —
 *  TikTok's own web-app API `data` object, passed through unmodified. Read
 *  defensively; TikTok's web API shape shifts across regions/app versions. */

export interface TiktokVideoInfo {
  cover?: string
  originCover?: string
  playAddr?: string
  duration?: number
}

export interface TiktokAuthor {
  uniqueId?: string
  nickname?: string
  avatarLarger?: string
}

export interface TiktokItem {
  id?: string
  desc?: string
  createTime?: number
  video?: TiktokVideoInfo
  author?: TiktokAuthor
}

export interface TiktokUserInfo {
  user?: { uniqueId?: string; nickname?: string; avatarLarger?: string; signature?: string }
}

export interface TiktokResponse<T> {
  code: number
  data?: T
}
