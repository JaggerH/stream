import type { SystemIdentity } from './types.ts'

/** 成员并发扇出，返回各源原始条目；extract+facet 在调用点复用 src/video/* 重建 {shows,loose,sources}。
 *  非流式分支走 invoke()（app.ts scope=resources），流式分支扇出同一批行成员（bootstrap
 *  resourceSearchGroups）。已无 builtin 聚合器兜底——resource-search-aggregate 源与 videoSearch 旧管道已删。 */
export const resourceSearch: SystemIdentity = {
  id: 'resource-search',
  category: 'search',
  serveKeys: ['resources'],
  fallback: false,
  strategy: 'concurrent',
  contract: null,
  defaultLabel: '资源搜索',
  defaultDescription: '关键词 → 网盘链接与影视片源',
  // auto 段收两类成员，都由站的包自己申报 `provides: [search-download]`，这里不点名任何站：
  //  - 目录源（manifest / recipe meta 的 provides），段参数 {keyword:'$input'} 填进去——所以只收
  //    查询参数就叫 keyword 的源；
  //  - Provider 行（包的 `stream.providers[].provides`，如 expand 组合体），拿原始输入、自己的成员
  //    各自填 `$input`（见 executor 的 auto 段）。
  // 其余 RSSHub 目录路由的参数名各异（nyaa=:query / comicat=:keyword / bangumi.moe=:tags），展示元数据由
  // packages/rsshub 的 searchSources 声明；成员的挑选与顺序是宿主的产品判断，留在这一行，
  // 各作显式成员单独绑自己的参数。提取由调用点按 searchMetaBySourceId 的 kind 分发。
  // 决策（2026-07-10）：源少时逐个显式加即可，参数名统一留到成员变多再做；成人站（u3c3/javdb 等）
  // 不进本行——单独另做一个 Provider。
  // 漫猫：站点全站挂了假 JS 验证码（/public/html/start/，只为塞 visitor_test=human cookie），
  // 已在 RSSHub comicat/search 路由里带上该 cookie 修好（feature-comicat，携 cookie 抓 listing+detail）。
  defaultMembers: [
    { mode: 'auto', provides: 'search-download', params: { keyword: '$input' } },
    { source: 'rsshub:nyaa/search/:query?', params: { query: '$input' } },
    { source: 'rsshub:comicat/search/:keyword', params: { keyword: '$input' } },
    { source: 'rsshub:bangumi.moe/:tags{.+}?', params: { tags: '$input' } },
  ],
}
