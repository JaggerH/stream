/** Raw shapes returned by the Douyin_TikTok_Download_API Bilibili-Web router. These are
 *  bilibili's own public web-API `data` objects, passed through unmodified — field
 *  names are bilibili's, not this backend's. Read defensively; bilibili has been known
 *  to add/omit fields across endpoints and app versions. */

export interface BiliOwner {
  mid?: number
  name?: string
  face?: string
}

export interface BiliVideoDetail {
  bvid?: string
  aid?: number
  cid?: number
  title?: string
  desc?: string
  pic?: string
  duration?: number
  pubdate?: number
  owner?: BiliOwner
}

export interface BiliUserProfile {
  mid?: number
  name?: string
  face?: string
  sign?: string
}

export interface BiliRoomInfo {
  room_id?: number
  title?: string
  cover?: string
  area_name?: string
  live_status?: number
}

export interface BiliAnchorInfo {
  base_info?: { uname?: string; face?: string }
}

export interface BiliLiveRoomDetail {
  room_info?: BiliRoomInfo
  anchor_info?: BiliAnchorInfo
}

export interface BiliLiveStreamUrlInfo {
  host?: string
  extra?: string
}

export interface BiliLiveVideos {
  playurl_info?: {
    playurl?: {
      stream?: Array<{
        format?: Array<{ codec?: Array<{ base_url?: string; url_info?: BiliLiveStreamUrlInfo[] }> }>
      }>
    }
  }
}

export interface BiliResponse<T> {
  code: number
  data?: T
}
