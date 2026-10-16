import type { ActivateFn } from '../../src/packages/activate.ts'
import { v2exNormalizer } from './normalizer.ts'
import { makeEnrichers } from './enrich.ts'

/** 这个包贡献的代码：一个 normalizer（RSSHub `v2ex` 命名空间的渲染规则，写下 `content.enrich`）
 *  + 一个 enricher（`v2ex-comments`：主题的全部回复）。不碰登录态；出站走 `ctx.fetch`。 */
export const activate: ActivateFn = (ctx) => ({
  normalizers: { v2ex: v2exNormalizer },
  enrichers: makeEnrichers(ctx),
})
