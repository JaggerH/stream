import type { SystemIdentity } from './types.ts'

/** 策略 concurrent：详情页走 `collect()` 全收——两个成员的图各自成对带回，调用点按 kind
 *  逐类挑第一张。首胜即停只会拿到一家的图。 */
export const videoImages: SystemIdentity = {
  id: 'video-images',
  category: 'images',
  serveKeys: ['video-detail'],
  fallback: false,
  strategy: 'concurrent',
  contract: null,
  defaultLabel: '影视图片',
  defaultDescription: '影片/剧集标识 → 海报、背景和标题图',
  // 宿主的产品判断：TMDb（影视身份主键，宿主领域模型）的图在前、OMDb 包的海报补空在后。
  defaultMembers: [{ source: '@streamapp/builtin/tmdb-images' }, { source: '@streamapp/omdb/omdb-images' }],
}
