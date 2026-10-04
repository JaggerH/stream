import type { ActivateFn } from '../../src/packages/activate.ts'
import { xueqiuNormalizer } from './normalizer.ts'
import { makeDetailEnricher } from './detail.ts'

/** 这个包贡献的代码：一个 normalizer（用户动态的渲染规则，`xueqiu`）+ 一个 enricher（打开转发帖时
 *  现取被截断的原帖全文，`xueqiu-detail`）。都不碰 cookie：现取经 `ctx.readSource` 跑本包自己的 recipe。 */
export const activate: ActivateFn = (ctx) => ({
  normalizers: { xueqiu: xueqiuNormalizer },
  enrichers: makeDetailEnricher({ readSource: ctx.readSource }),
})
