import type { SystemIdentity } from './types.ts'

/** 统一下载解析行（openspec: resolve-api-unification）——「资源页引用 → 下载链接」的唯一入口。
 *  成员 = 各下载源，sequential decline-chain：不认识该 URL 的源 decline（抛 unsupported url /
 *  返回空数组），认领的源产出结果。
 *
 *  默认成员是 auto 段：收所有申报了 `provides: [resolve-download]` 的源（站点包各出一条，
 *  宿主通用实现 builtin mode `magnet`，认领哪些 URL 由那个包的 `stream.links.patterns`（kind download-page）声明，
 *  见 `src/video/resolve.ts`）。加一个下载中转站 = 那个站的包加声明，零代码零端点、不碰这一行。 */
export const downloadResolve: SystemIdentity = {
  id: 'download-resolve',
  category: 'resolve',
  serveKeys: ['download'],
  fallback: false,
  strategy: 'sequential',
  // 成员返回契约（行级文档，executor 不强校验）
  contract: { members: '[{ url, type, password?, name? }]（type: magnet|ed2k|quark|baidu|aliyun|http|…；空数组 = decline）' },
  defaultLabel: '下载解析',
  defaultDescription: '资源页 URL → 下载链接（磁力/网盘/ed2k）',
  defaultMembers: [{ mode: 'auto', provides: 'resolve-download' }],
}
