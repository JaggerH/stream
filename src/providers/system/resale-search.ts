import type { SystemIdentity } from './types.ts'

/** provides=search-resale 的逐源成员：executor 并发扇出每个二手回收/残值源，参数 {mode:'search',
 *  keyword:'$input'} 在调用时填。与 price-search 同形但**独立成档**：比价是「商品名 → 各平台
 *  新品报价」，这一行是「型号 → 二手值多少」——两种意图，混排会让模型把 1200 元的回收价当成
 *  一个便宜的购买选项（`docs/research/consumption-frontier-model.md` §六）。成员不在这里点名：
 *  哪个包的 recipe 声明了 `provides: [search-resale]`，它就自动进这一行，装上即入、关掉即出。消费端是购买决策 job 的 `residual` 格（`src/kernel/plugins/agent.ts`）。 */
export const resaleSearch: SystemIdentity = {
  id: 'resale-search',
  category: 'search',
  serveKeys: ['resale'],
  fallback: false,
  strategy: 'concurrent',
  contract: null,
  defaultLabel: '残值搜索',
  defaultDescription: '型号 → 二手回收 / 挂牌价',
  defaultMembers: [
    { mode: 'auto', provides: 'search-resale', params: { mode: 'search', keyword: '$input', count: 20 } },
  ],
}
