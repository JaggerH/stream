import type { SystemIdentity } from './types.ts'

export const musicSearch: SystemIdentity = {
  id: 'music-search',
  category: 'search',
  serveKeys: ['music'],
  fallback: false,
  strategy: 'concurrent',
  contract: null,
  defaultLabel: '音乐搜索',
  defaultDescription: '歌名/歌手 → 可播放曲目',
  // 默认成员挑谁、排什么序是宿主的产品判断（开箱就能搜到歌的那两家），不是包的知识——所以写包全名、
  // 留在宿主。包自己能表达的只有「我能搜歌」；哪天成员多到要按申报自动收，改成 `{ mode: 'auto', provides }`。
  defaultMembers: [
    { source: '@streamapp/toubiec/toubiec-search', params: { keyword: '$input' } },
    { source: '@streamapp/zuna/zuna-search', params: { keyword: '$input' } },
  ],
}
