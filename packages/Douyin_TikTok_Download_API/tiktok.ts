import type { Normalizer } from '../../src/content/normalize.ts'
import type { Media } from '../../src/content/types.ts'

/**
 * 这个容器服务的 TikTok 源（fetch_one_video / fetch_user_post / fetch_user_like /
 * fetch_user_collect / fetch_user_play_list / fetch_user_mix / fetch_post_comment /
 * fetch_user_profile / fans / follow）共用的 normalizer。TikTok 没有公开的可嵌入播放器，视频
 * media 只带身份 `(provider:'tiktok', vid:<作品 id>)`，播放地址由本包的 resolve 成员在播放
 * 那一刻现解、走宿主的通用播放路由——normalizer 不烘任何路由字符串。按 raw 的形状分派而不是
 * 按 manifest id，所以一个 normalizer 覆盖全部模式。绝不抛。
 */
export const tiktokNormalizer: Normalizer = (raw) => {
  const r = raw as Record<string, unknown>

  // video-shaped: has a `video` object (item/aweme_detail — web and app shapes both
  // carry `id`/`video`; app's aweme_detail additionally has `aweme_id`, checked as fallback).
  const video = r.video as { cover?: string; originCover?: string; duration?: number } | undefined
  if (video) {
    const id = typeof r.id === 'string' ? r.id : typeof r.aweme_id === 'string' ? r.aweme_id : undefined
    const title = typeof r.desc === 'string' ? r.desc : undefined
    const author = r.author as { uniqueId?: string } | undefined
    const pageUrl = id
      ? author?.uniqueId
        ? `https://www.tiktok.com/@${author.uniqueId}/video/${id}`
        : `https://www.tiktok.com/video/${id}`
      : undefined
    const poster = video.cover ?? video.originCover
    // pageUrl 有值就意味着 id 有值：身份与页面地址同源。
    const media: Media[] = id && pageUrl
      ? [
          {
            kind: 'video',
            provider: 'tiktok',
            vid: id,
            poster,
            duration_s: video.duration,
            page_url: pageUrl,
          },
        ]
      : []
    if (media.length) return { archetype: 'video', title, media }
    return { archetype: 'text', title }
  }

  // comment-shaped: plain `text` field (fetch_post_comment / fetch_post_comment_reply).
  if (typeof r.text === 'string') return { archetype: 'text', text: r.text }

  // profile-shaped: uniqueId + nickname, no video (fetch_user_profile / fans / follow entries).
  const uniqueId = typeof r.uniqueId === 'string' ? r.uniqueId : undefined
  if (uniqueId) {
    const avatar = typeof r.avatarLarger === 'string' ? r.avatarLarger : undefined
    return {
      archetype: avatar ? 'gallery' : 'text',
      title: typeof r.nickname === 'string' ? r.nickname : uniqueId,
      text: typeof r.signature === 'string' ? r.signature : undefined,
      media: avatar ? [{ kind: 'image', url: avatar }] : undefined,
    }
  }

  // fans/follow entries wrap the user object one level deeper: { user: {...} }.
  const nestedUser = r.user as { uniqueId?: string; nickname?: string; avatarThumb?: string } | undefined
  if (nestedUser?.uniqueId) {
    return {
      archetype: nestedUser.avatarThumb ? 'gallery' : 'text',
      title: nestedUser.nickname ?? nestedUser.uniqueId,
      media: nestedUser.avatarThumb ? [{ kind: 'image', url: nestedUser.avatarThumb }] : undefined,
    }
  }

  return { archetype: 'text' }
}
