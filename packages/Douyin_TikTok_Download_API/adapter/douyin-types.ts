/**
 * Raw Douyin aweme (作品) shapes — the subset the content normalizer reads.
 *
 * These are loose partials of the real Douyin web response (verified against a
 * live `fetch_user_post_videos` call; see __fixtures__/aweme.json). Every field is
 * optional because the upstream JSON is huge and unstable — the normalizer reads
 * defensively and never throws. Field paths confirmed from the real payload:
 *   aweme_id, desc, create_time, share_url
 *   author.{nickname, sec_uid, avatar_thumb.url_list[0]}
 *   video.{duration(ms), cover.url_list[0], play_addr.url_list[]}
 *   statistics.{digg_count, comment_count, share_count, collect_count}
 *   images[].url_list[]  (photo-mode 图集 posts; media_type !== video)
 */

export interface DouyinUrlList {
  url_list?: string[]
  uri?: string
}

export interface DouyinAuthor {
  nickname?: string
  sec_uid?: string
  avatar_thumb?: DouyinUrlList
}

export interface DouyinVideo {
  /** duration in MILLISECONDS (e.g. 11029) */
  duration?: number
  /** source video pixel dimensions (top-level video.width/height in the aweme; e.g. 1080×1920
   *  for a portrait clip). Used to snap the feed frame to the right orientation up front. */
  width?: number
  height?: number
  cover?: DouyinUrlList
  origin_cover?: DouyinUrlList
  dynamic_cover?: DouyinUrlList
  play_addr?: DouyinUrlList
}

export interface DouyinStatistics {
  digg_count?: number
  comment_count?: number
  share_count?: number
  collect_count?: number
  play_count?: number
}

/** A raw Douyin aweme as returned in `aweme_list` (huge object; only the read subset typed). */
export interface DouyinAweme {
  aweme_id?: string
  desc?: string
  create_time?: number
  share_url?: string
  /** 2 = 图集 (image album); 0 / 4 = video (verified against __fixtures__/aweme.json) */
  media_type?: number
  author?: DouyinAuthor
  video?: DouyinVideo
  statistics?: DouyinStatistics
  /** present on photo-mode (图集) posts */
  images?: DouyinUrlList[]
  [k: string]: unknown
}

/** Douyin_TikTok_Download_API ResponseModel envelope: { code, router, data }. */
export interface DouyinResponse<T = unknown> {
  code?: number
  router?: string
  data?: T
}

/** The `data` payload of the user/collection/follow/search list endpoints. */
export interface DouyinAwemeListData {
  aweme_list?: DouyinAweme[]
  max_cursor?: number
  // 收藏 returns the next-page cursor under `cursor` (the request param is `max_cursor`).
  cursor?: number
  has_more?: number
  status_code?: number
}

/** What the adapter returns per item: the bridge fields makeStreamItem reads
 *  (title/link/author/guid/pubDate) + the raw aweme under `douyin` for the content
 *  normalizer (mirrors the xhs adapter's normalized note shape). */
export interface DouyinItem {
  guid: string
  title: string
  link?: string
  author?: string
  author_avatar?: string
  pubDate?: string
  douyin: DouyinAweme
}
