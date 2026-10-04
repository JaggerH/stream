import type { SystemIdentity } from './types.ts'

/** provides=search-price 的逐源成员：executor 并发扇出每个比价搜索源，参数 {mode:'search',
 *  keyword:'$input'} 在调用时填。与 content-search 同形（并发 + 按各条 item 的产源 manifest
 *  归一化，见 app.ts scope=price），但独立成一档：比价是「商品名 → 各平台报价」，与「跨平台
 *  资讯/笔记/视频」是两种意图，不该混排。成员不在这里点名：
 *  哪个包的 recipe 声明了 `provides: [search-price]`，它就自动进这一行，装上即入、关掉即出。 */
export const priceSearch: SystemIdentity = {
  id: 'price-search',
  category: 'search',
  serveKeys: ['price'],
  fallback: false,
  strategy: 'concurrent',
  contract: null,
  defaultLabel: '比价搜索',
  defaultDescription: '商品名 → 各电商平台报价',
  defaultMembers: [
    { mode: 'auto', provides: 'search-price', params: { mode: 'search', keyword: '$input', count: 20 } },
  ],
}
