import type { DouyinAweme, DouyinItem } from './douyin-types.ts'

/** Normalize a raw aweme into the bridge item shape makeStreamItem reads (title/link/
 *  author/guid/pubDate), carrying the raw aweme under `douyin` for the presenter.
 *  Registered as the `douyin` normalizer and used directly by the douyin handlers. */
export function toDouyinItem(a: DouyinAweme): DouyinItem {
  return {
    guid: a.aweme_id as string,
    // No caption → no title (empty, not a "(无标题)" placeholder). The view drops the title
    // line entirely for untitled posts; a placeholder here would just get rendered.
    title: a.desc || '',
    // search awemes lack share_url — fall back to the canonical /video/<id> url so the
    // card link + downstream proxy/enrich still resolve.
    link: a.share_url || (a.aweme_id ? `https://www.douyin.com/video/${a.aweme_id}` : undefined),
    author: a.author?.nickname,
    author_avatar: a.author?.avatar_thumb?.url_list?.find((u) => !!u),
    pubDate: a.create_time ? new Date(a.create_time * 1000).toISOString() : undefined,
    douyin: a,
  }
}
