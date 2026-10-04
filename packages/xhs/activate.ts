import type { ActivateFn } from '../../src/packages/activate.ts'
import { XhsAdapter } from './adapter.ts'
import { xhsNormalizer } from './normalizer.ts'
import { makeDetailEnricher } from './detail.ts'
import { StreamTable } from './streams.ts'

/** 这个包贡献的东西：一个 adapter（播放解析成员 xhs-resolve）+ 一个 normalizer（笔记的渲染规则）
 *  + 一个 enricher（打开笔记现取正文 / 图集 / 视频流 / 评论，`xhs-detail`）。
 *
 *  三样都不碰 cookie：每一段能力都是「在用户自己的 Chrome 里跑一份本包的 recipe」，经 `ctx.readSource`
 *  （裸名按本包限定）。流地址表 `streams` 是 detail 与 resolve 之间唯一的传话渠道，所以两者共享同一个实例。 */
export const activate: ActivateFn = (ctx) => {
  const deps = { readSource: ctx.readSource, streams: new StreamTable() }
  return {
    adapters: { xhs: new XhsAdapter(deps) },
    normalizers: { xhs: xhsNormalizer },
    enrichers: makeDetailEnricher(deps),
  }
}
