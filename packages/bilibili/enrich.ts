import type { Enricher } from '../../src/packages/activate.ts'
import { ValidationError } from '../../shared/package-sdk/errors.ts'
import type { Comment, Enrichment } from '../../src/content/types.ts'
import type { BiliComment, BilibiliClient, VideoRef } from './client.ts'
import { videoRefOf } from './client.ts'

/** query 里的 `bvid` / `aid` → 一个视频引用。两个都缺 → 调用方写错了。 */
function refOf(q: Record<string, string>): VideoRef {
  if (q.bvid) return { bvid: q.bvid }
  if (q.aid) return { aid: q.aid }
  throw new ValidationError('bvid or aid required')
}

function mapComment(c: BiliComment, pinned: boolean): Comment {
  const badges: string[] = []
  if (c.isUp) badges.push('UP')
  if (pinned) badges.push('置顶')
  return {
    id: c.rpid,
    author: c.author,
    avatar: c.avatar,
    text: c.text,
    like: c.like,
    badges: badges.length ? badges : undefined,
  }
}

/** 这个包交给宿主的三个富化处理器（`/api/enrich?source=…`）。
 *  参数校验归包——什么参数算合法只有它知道；不合法抛 `ValidationError`，宿主翻 400。 */
export function makeEnrichers(client: BilibiliClient): Record<string, Enricher> {
  return {
    'bilibili-comments': async (q): Promise<Enrichment> => {
      const vid = q.vid
      if (!vid) throw new ValidationError('vid required')
      const page = Math.max(1, Number(q.page) || 1)
      const r = await client.comments(videoRefOf(vid), page)
      const rows: Comment[] = []
      // 置顶评论只在第一页领头——作者把补充信息放在那儿。
      if (page === 1 && r.pinned) rows.push(mapComment(r.pinned, true))
      const pinnedId = r.pinned?.rpid
      for (const c of r.comments) {
        if (c.rpid === pinnedId) continue
        rows.push(mapComment(c, false))
      }
      const hasMore = page < Math.ceil(r.total / r.pageSize)
      return { comments: rows, total: r.total, cursor: hasMore ? String(page + 1) : null }
    },

    'bilibili-owner': async (q) => client.owner(refOf(q)),

    'bilibili-user': async (q) => {
      const { uid, name } = q
      if (!uid && !name) throw new ValidationError('uid or name required')
      const user = uid ? await client.user(uid) : await client.userByName(name)
      // 查不到这个人：**说出来**，别回一个空对象——前端拿空对象会渲染出一个没有名字的作者位。
      if (!user) throw new ValidationError(`user not found: ${name}`)
      // `url` = 空间页：宿主的通用作者位（item.author_enrich → AuthorChip）照它画链接。
      return { ...user, url: `https://space.bilibili.com/${encodeURIComponent(user.uid)}` }
    },
  }
}
