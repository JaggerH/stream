/** On-demand enrichment dispatcher — the open-time parallel of content/normalize.
 *  One entry, source-keyed, normalizing every source to { article, comments } so the
 *  reader's peek (list) and full view (modal) are source-blind. 薄源包一层而不是重写。
 *  站点自己的评论/详情/作者查询一律归包（`activate()` 的 `enrichers`），宿主只剩不属于任何
 *  一家站的那一条：任意网页的正文（`link`）。 */

import { extractArticle } from '../extract.ts'
import type { Enrichment } from '../types.ts'

export type EnrichRequest = { source: 'link'; url: string }

/**
 * 宿主自己受理的 `source` 名。包申报的 enricher 撞上其中任何一个 → 装载期硬拒
 * （`src/packages/activate.ts`）：一个包静默顶掉宿主的富化分支，表现是「这个源的评论
 * 今天对、明天不对」，没有一处会喊。
 *
 * **它必须和下面那个 switch 是同一份**——加一条分支就往这里加一个名字，
 * 否则新分支对包是敞开的。
 */
export const HOST_ENRICH_SOURCES: ReadonlySet<string> = new Set(['link'])

/** 宿主这条分支是站外裸 HTTP，不骑登录态标签页。包要借同一份正文抽取，走 `ctx.readArticle`。 */
export async function enrich(req: EnrichRequest): Promise<Enrichment> {
  switch (req.source) {
    case 'link': {
      const article = await extractArticle(req.url)
      return { article: article ?? undefined }
    }
  }
}
