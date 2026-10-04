import type { SystemIdentity } from './types.ts'

/** provides=search-content 的逐源成员：executor 并发扇出每个搜索源，参数 {mode:'search',
 *  keyword:'$input'} 在调用时填。呈现在调用点按各条 item 的产出源 manifest 决定（见 app.ts
 *  scope=content），不再走 content-search-aggregate builtin 聚合器。 */
export const contentSearch: SystemIdentity = {
  id: 'content-search',
  category: 'search',
  serveKeys: ['content'],
  fallback: false,
  strategy: 'concurrent',
  contract: null,
  defaultLabel: '内容搜索',
  defaultDescription: '查询词 → 各平台内容条目',
  // auto 段扇出所有 provides=search-content 的目录源。**这里不点名任何一条路由**——
  // 一个平台的搜索源由它自己的包出，包在 manifest 里写 `provides: [search-content]` 就进来了。
  defaultMembers: [
    { mode: 'auto', provides: 'search-content', params: { mode: 'search', keyword: '$input', count: 20 } },
  ],
}
