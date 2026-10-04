import type { SystemIdentity } from './types.ts'

/** 影视片名搜索：成员并发扇出，各返回 VideoReference[]（未核实的作品事实）；调用点（app.ts
 *  scope=video）按 external id / 归一化标题+年份去重合成候选卡。今只 TMDB 一个成员；区域来源
 *  （腾讯综艺 / 爱奇艺短剧）走 onboard-source 落地后作为新成员并入本行，端点/去重/前端零改动。 */
export const videoSearch: SystemIdentity = {
  id: 'video-search',
  category: 'search',
  serveKeys: ['video'],
  fallback: false,
  strategy: 'concurrent',
  contract: null,
  defaultLabel: '影视搜索',
  defaultDescription: '片名 → 候选作品',
  defaultMembers: [
    { source: '@streamapp/builtin/tmdb-title-search', params: { keyword: '$input' } },
  ],
}
