import type { ActivateFn } from '../../src/packages/activate.ts'
import { BilibiliClient } from './client.ts'
import { BilibiliAdapter } from './adapter.ts'
import { bilibiliNormalizer } from './normalizer.ts'
import { makeEnrichers } from './enrich.ts'
import { makeConnect } from './connect.ts'

const DOMAIN = 'bilibili.com'

/** 这个包贡献的东西：一个 adapter（播放解析）+ 一个 normalizer（RSSHub 动态流的渲染规则）
 *  + 三个 enricher（评论 / UP 主 / 用户，`/api/enrich?source=bilibili-*`）
 *  + 一个 connect（一键订阅「我的关注」，`POST /api/credentials/bilibili.com/connect`）。
 *  cookie **每次现取**（`ctx.cookieFor` 是异步函数，不是快照）——用户重新登录之后下一次调用
 *  就该用新的那份。 */
export const activate: ActivateFn = (ctx) => {
  const client = new BilibiliClient(() => ctx.cookieFor(DOMAIN))
  return {
    adapters: { bilibili: new BilibiliAdapter(client) },
    normalizers: { bilibili: bilibiliNormalizer },
    enrichers: makeEnrichers(client),
    connect: makeConnect(client),
  }
}
