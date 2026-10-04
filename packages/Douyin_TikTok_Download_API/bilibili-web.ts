import type { Normalizer } from '../../src/content/normalize.ts'
import type { Media } from '../../src/content/types.ts'

/**
 * Normalizer for the video-service-backed Bilibili sources (fetch_one_video /
 * fetch_user_post_videos / fetch_com_popular / fetch_user_collection_videos /
 * fetch_user_profile / fetch_video_comments / fetch_video_danmaku / live endpoints).
 * These are bilibili's own raw web-API JSON shapes, not RSSHub html — dispatches on
 * shape rather than manifest id so one normalizer covers every mode. Never throws.
 */
export const bilibiliWebNormalizer: Normalizer = (raw) => {
  const r = raw as Record<string, unknown>

  // video-shaped: has a bvid — the common case (video/user-videos/popular/collection).
  const bvid = typeof r.bvid === 'string' ? r.bvid : undefined
  if (bvid) {
    const title = typeof r.title === 'string' ? r.title : undefined
    const pic = typeof r.pic === 'string' ? r.pic : typeof r.cover === 'string' ? r.cover : undefined
    const duration = typeof r.duration === 'number' ? r.duration : undefined
    const media: Media[] = [
      {
        kind: 'video',
        provider: 'bilibili',
        vid: bvid,
        poster: pic,
        duration_s: duration,
        page_url: `https://www.bilibili.com/video/${bvid}`,
      },
    ]
    return { archetype: 'video', title, media }
  }

  // comment-shaped: content.message (fetch_video_comments / fetch_comment_reply).
  const content = r.content as { message?: string } | undefined
  if (content?.message) return { archetype: 'text', text: content.message }

  // danmaku-shaped: { time, text } (adapter already parsed the XML).
  if (typeof r.time === 'number' && typeof r.text === 'string') {
    return { archetype: 'text', text: r.text }
  }

  // profile-shaped: mid + name, no bvid (fetch_user_profile).
  if (typeof r.mid !== 'undefined' && typeof r.name === 'string') {
    const face = typeof r.face === 'string' ? r.face : undefined
    return {
      archetype: face ? 'gallery' : 'text',
      title: r.name,
      text: typeof r.sign === 'string' ? r.sign : undefined,
      media: face ? [{ kind: 'image', url: face }] : undefined,
    }
  }

  // live room / live videos / live streamers / anything unrecognized → text fallback.
  const roomInfo = r.room_info as { title?: string; cover?: string } | undefined
  if (roomInfo?.title) {
    return {
      archetype: roomInfo.cover ? 'gallery' : 'text',
      title: roomInfo.title,
      media: roomInfo.cover ? [{ kind: 'image', url: roomInfo.cover }] : undefined,
    }
  }
  const uname = typeof r.uname === 'string' ? r.uname : undefined
  if (uname) {
    const cover = typeof r.cover === 'string' ? r.cover : undefined
    return { archetype: cover ? 'gallery' : 'text', title: uname, media: cover ? [{ kind: 'image', url: cover }] : undefined }
  }

  return { archetype: 'text' }
}
