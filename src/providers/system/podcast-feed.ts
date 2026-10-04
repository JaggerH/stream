import type { SystemIdentity } from './types.ts'

export const podcastFeed: SystemIdentity = {
  id: 'podcast-feed',
  category: 'resolve',
  serveKeys: ['podcast', 'podcast-timeline'],
  fallback: false,
  strategy: 'sequential',
  contract: null,
  defaultLabel: '播客源解析',
  defaultDescription: '播客订阅 key → 节目列表',
  // 成员 = 目录里 categories 含 podcast 且带 key_param 的每个源（registry.inCategory），resolve 时
  // 现取；订阅键灌进各源自己的 key_param。装了第三方播客 recipe 包就自动进这一行——站名归包，
  // 不归这里。
  defaultMembers: [{ mode: 'auto', category: 'podcast' }],
}
