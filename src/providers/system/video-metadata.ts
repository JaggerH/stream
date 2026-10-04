import type { SystemIdentity } from './types.ts'

/** 影视详情富集：成员按声明顺序合并，默认 TMDb 优先、OMDb 补空。Source 的 API 配置独立于
 *  Provider 的成员启用、顺序和策略；详情页只按 id 调用此系统行。
 *
 *  与 video-canonical 同 category(metadata)、同 serve 键(video-detail)——这两行**按 id 直调**，
 *  不经 match，所以同键不是冲突。`index.real.test.ts` 的「同 category 内 serveKeys 无跨行重复」
 *  因此在 metadata 上留有已知例外，见那个测试的注释。
 *
 *  策略 concurrent：详情页走 `collect()` 全收——TMDb 与 OMDb 都要跑完，调用点按声明顺序
 *  合并字段（先到的填空、不覆盖）。首胜即停会把「OMDb 补空」这件事直接抹掉。 */
export const videoMetadata: SystemIdentity = {
  id: 'video-metadata',
  category: 'metadata',
  serveKeys: ['video-detail'],
  fallback: false,
  strategy: 'concurrent',
  contract: null,
  defaultLabel: '影视元数据',
  defaultDescription: '影片/剧集标识 → 标题、简介、演职员与评分',
  // 宿主的产品判断：TMDb（影视身份主键，宿主领域模型）在前、OMDb 包补空在后。
  defaultMembers: [{ source: '@streamapp/builtin/tmdb-metadata' }, { source: '@streamapp/omdb/omdb-metadata' }],
}
