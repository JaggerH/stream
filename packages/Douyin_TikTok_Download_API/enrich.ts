import type { Enricher } from '../../src/packages/activate.ts'
import { ValidationError } from '../../shared/package-sdk/errors.ts'
import type { Comment, Enrichment } from '../../src/content/types.ts'
import type { DouyinTiktokDownloadApiAdapter, RawDouyinComment } from './adapter/adapter.ts'

export type { VideoCommentsPage } from './adapter/adapter.ts'

/** enricher 只需要 adapter 的这一个方法——收窄成接口，测试塞一个假的就够，不用搭整个 adapter。 */
export type DouyinCommentsClient = Pick<DouyinTiktokDownloadApiAdapter, 'videoComments'>

/** 站方评论 → 宿主的 `Comment`。`time` 按 `Comment.time` 的契约给 unix 秒（站方 `create_time` 就是秒）；
 *  头像取 `url_list` 里第一条**非空**串（活体里首条偶有空串）。 */
function mapComment(c: RawDouyinComment): Comment {
  return {
    id: c.cid ?? '',
    author: c.user?.nickname,
    avatar: c.user?.avatar_thumb?.url_list?.find((u) => !!u),
    text: c.text ?? '',
    like: c.digg_count ?? 0,
    ip: c.ip_label,
    time: c.create_time,
  }
}

/** 这个包交给宿主的富化处理器（`/api/enrich?source=douyin-comments`）。
 *  参数校验归包——什么参数算合法只有它知道；不合法抛 `ValidationError`，宿主翻 400。 */
export function makeEnrichers(client: DouyinCommentsClient): Record<string, Enricher> {
  return {
    'douyin-comments': async (q): Promise<Enrichment> => {
      const vid = q.vid
      if (!vid) throw new ValidationError('vid required')
      // 翻页游标是站方的数字 cursor。首选 `cursor`；前端的通用翻页把上一页回的 cursor 当 `page`
      // 递回来（`app/src/lib/preload.ts` loadMore），所以 `page` 也认——两个名字、同一个数。
      const cursor = Number(q.cursor ?? q.page) || 0
      const r = await client.videoComments(vid, cursor)
      const out: Enrichment = { comments: r.comments.map(mapComment), total: r.total }
      // 没有下一页就不带 cursor：前端按「有没有 cursor」判还能不能翻。
      if (r.hasMore) out.cursor = String(r.cursor)
      return out
    },
  }
}
