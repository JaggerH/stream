import type { SystemIdentity } from './types.ts'

/** provides=search-sticker 的逐源成员：executor 并发扇出每个表情包站，参数 {mode:'search',
 *  keyword:'$input'} 在调用时填。和 content-search **分开成档**：表情包站回的是「一张图 + 一句配文」，
 *  消费方（粒粒拼豆的热梗调研、照图出图）要的是图本身；混进内容搜索会被帖子标题淹没，内容搜索那边
 *  也会多出一堆没有正文的图片条目。成员不在这里点名：哪个包的 recipe 声明了 `provides: [search-sticker]`，
 *  它就自动进这一行（今天是皮蛋表情包 pdan、发表情 fabiaoqing）。HTTP 口：`GET /api/search?scope=sticker`。 */
export const stickerSearch: SystemIdentity = {
  id: 'sticker-search',
  category: 'search',
  serveKeys: ['sticker'],
  fallback: false,
  strategy: 'concurrent',
  contract: null,
  defaultLabel: '表情包搜索',
  defaultDescription: '关键词 → 各表情包站的图',
  defaultMembers: [
    { mode: 'auto', provides: 'search-sticker', params: { mode: 'search', keyword: '$input', count: 20 } },
  ],
}
