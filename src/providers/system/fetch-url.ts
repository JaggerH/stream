import type { SystemIdentity } from './types.ts'

/** **媒体导向**：任意链接 → 统一 media[]（已装包认领的主机由各包的 transform 行接管，这条兜底行
 *  自己只剩抖音与图片/视频直链）。它**不产正文**——`FetchUrlResult.text`
 *  这个字段在 src/http/fetch-url.ts 里一处都没赋值过（实测：普通网页 3ms 返回 media:[]，
 *  根本没发请求）。网页正文是另一条行：article-extract。
 *
 *  `fallback: true` = 旧形状的 `serves: ['*']`：transform category 的兜底行。 */
export const fetchUrl: SystemIdentity = {
  id: 'fetch-url',
  category: 'transform',
  serveKeys: [],
  fallback: true,
  strategy: 'sequential',
  contract: null,
  defaultLabel: '网页媒体抓取',
  defaultDescription: '任意 URL → 标准化媒体（各包未认领的主机：抖音与图片/视频直链）；不产正文',
  defaultMembers: [{ source: '@streamapp/builtin/fetch-url' }, { mode: 'auto', provides: 'generic-url' }],
}
