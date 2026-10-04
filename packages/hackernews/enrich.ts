import type { Enricher, PluginContext } from '../../src/packages/activate.ts'
import type { Article, Enrichment } from '../../src/content/types.ts'
import { ValidationError } from '../../shared/package-sdk/errors.ts'
import { fetchHnStory, fetchThreadComments, storyPageUrl } from './client.ts'

/** `/api/enrich?source=hackernews-comments&id=<story id>`：链接帖的原文（经宿主的正文抽取）
 *  + 整棵评论树。Ask/Show HN 这种没有外链的帖子，帖子正文本身就是 article。
 *
 *  评论树一次拿完（Algolia 一发），`cursor` 恒为 null；`total` 用 HN 自己报的数（树被截断时
 *  它大于 comments.length）。 */
export function makeEnrichers(ctx: Pick<PluginContext, 'readArticle'>): Record<string, Enricher> {
  return {
    'hackernews-comments': async (q, signal): Promise<Enrichment> => {
      const id = Number(q.id)
      if (!Number.isInteger(id) || id <= 0) throw new ValidationError('id (a Hacker News story id) required')
      const story = await fetchHnStory(id, signal)
      if (!story) return {}
      // 原文与评论树并行：卡片预览（摘要 + 首图）不必等整棵树。
      const [extracted, comments] = await Promise.all([
        story.url ? ctx.readArticle(story.url) : Promise.resolve(null),
        fetchThreadComments(id, story.by, signal),
      ])
      let article: Article | undefined
      if (extracted) article = { ...extracted, title: extracted.title ?? story.title }
      if (!article && story.textHtml) {
        article = { sourceUrl: storyPageUrl(story.id), title: story.title, author: story.by, html: story.textHtml }
      }
      return { article, comments, total: story.total || comments.length, cursor: null }
    },
  }
}
