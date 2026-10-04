import type { Release, VideoSourceType } from './types.ts'

/**
 * 按「这台机器能用的下载类型」收窄资源搜索结果。允许集来自
 * `GET /api/netdisk/mounts` 的 `searchableSourceTypes`（magnet/ed2k 无条件 + AList
 * 上实际挂着的网盘）。
 *
 * 这是**视图**层的收窄，不是数据事实——「我只挂了夸克所以只看夸克」是本机偏好，
 * 所以过滤在前端；MCP 那条 AI 路不该被某台机器的挂载情况限制。（去重是数据质量
 * 问题，在后端 Provider 里做。）
 *
 * 逐链过滤，不能按条目：pansou 一条消息常带一串混合类型链接，`link`/`sourceType`/
 * `password` 只是 links[0] 的镜像。只看 sourceType 会把「首链是百度、但也带夸克」
 * 的结果整条误杀。
 */
export function filterRelease(r: Release, allowed: Set<VideoSourceType>): Release | null {
  if (!r.links?.length) return allowed.has(r.sourceType) ? r : null
  const survivors = r.links.filter((l) => allowed.has(l.type))
  if (survivors.length === 0) return null
  const primary = survivors[0]
  // 镜像字段重新指向存活的首链——不重新镜像的话 UI 会展示一个已被过滤掉的链接
  return { ...r, links: survivors, link: primary.url, sourceType: primary.type, password: primary.password }
}

export function filterReleases(rs: Release[], allowed: Set<VideoSourceType>): Release[] {
  return rs.flatMap((r) => {
    const kept = filterRelease(r, allowed)
    return kept ? [kept] : []
  })
}
