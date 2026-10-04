import type { ActivateFn } from '../../src/packages/activate.ts'
import { DouyinTiktokDownloadApiAdapter } from './adapter/adapter.ts'
import { douyinNormalizer } from './douyin.ts'
import { tiktokNormalizer } from './tiktok.ts'
import { bilibiliWebNormalizer } from './bilibili-web.ts'
import { makeEnrichers } from './enrich.ts'
import { makeConnect } from './connect.ts'

/** 这个包贡献的东西：一个 adapter + 三个 normalizer（这个容器同时服务三家 facility，
 *  每家一个 normalizer 认它自己的原始 API 形状）+ 抖音评论 enricher（`douyin-comments`，
 *  骑同一个 adapter 打容器）+ 一键订阅「我的抖音关注」的 connect（零输入，不经容器）。
 *  容器地址走 `ctx.backendUrl`（不传参 = 本包自己的 backend service），**递 thunk 不递值**：
 *  host 档下 loopback origin 是容器醒着才存在的，构造期快照必得空串。显式覆盖由包自己读
 *  环境变量 `DOUYIN_API_URL`，不经 `ctx.config`。 */
export const activate: ActivateFn = (ctx) => {
  const adapter = new DouyinTiktokDownloadApiAdapter({
    backendUrl: () => ctx.backendUrl(),
    withAwake: ctx.withAwake,
    // 抖音作品详情不经容器（站方把 `aweme/detail` 挪到 Argus 签名头后面了），走本包的
    // `douyin-detail` recipe——在用户自己的 Chrome 里让页面自己算签名。见 adapter 的 `hybridVideoData`。
    readSource: ctx.readSource,
  })
  return {
    adapters: { Douyin_TikTok_Download_API: adapter },
    normalizers: { douyin: douyinNormalizer, tiktok: tiktokNormalizer, 'bilibili-web': bilibiliWebNormalizer },
    enrichers: makeEnrichers(adapter),
    connect: makeConnect(),
  }
}
