import type { SystemIdentity } from './types.ts'

/** 详情加载先验证可复用的权威标识；后续 metadata/images Provider 只消费该标识，不再各自猜测。
 *
 *  策略 concurrent：详情页走 `collect()`——它要的是**每个成员各自的结果**（逐成员成对），
 *  由调用点按来源合并字段，不是"第一个赢的说了算"。那正是并发（全收）语义。 */
export const videoCanonical: SystemIdentity = {
  id: 'video-canonical',
  category: 'metadata',
  serveKeys: ['video-detail'],
  fallback: false,
  strategy: 'concurrent',
  contract: null,
  defaultLabel: '影视权威标识',
  defaultDescription: '发现信息 → 已验证的 TMDb/IMDb 标识',
  defaultMembers: [{ source: '@streamapp/builtin/tmdb-canonical' }],
}
