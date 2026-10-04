import type { ActivateFn } from '../../src/packages/activate.ts'
import { hackernewsNormalizer } from './normalizer.ts'
import { makeEnrichers } from './enrich.ts'

/** 这个包贡献的代码：一个 normalizer（RSSHub `hackernews` 命名空间的渲染规则，写下 `content.enrich`）
 *  + 一个 enricher（`hackernews-comments`：原文 + 评论树）。不碰登录态；原文抽取借宿主的 `ctx.readArticle`。 */
export const activate: ActivateFn = (ctx) => ({
  normalizers: { hackernews: hackernewsNormalizer },
  enrichers: makeEnrichers(ctx),
})
