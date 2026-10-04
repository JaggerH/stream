import type { DashResult } from './dash.ts'

/** 一次解析要的是哪一档：渐进式整片 / 分离流 DASH / 最小码率纯音轨。
 *  `audio` 是转写那条路要的——它只要声音，不要 1080p 画面。 */
export type VideoFormat = 'progressive' | 'dash' | 'audio'

export type VideoResolved =
  | { kind: 'dash'; manifest: DashResult }
  /** `mime` 给纯音轨那一档用（`audio/mp4`）；缺省按 `video/mp4` 发。 */
  | { kind: 'progressive'; url: string; headers?: Record<string, string>; mime?: string }

/** 一条本机播放地址。本体住 `shared/package-sdk/media-url.ts`（包的 fetch-url 与宿主同吃一份）；
 *  这里 re-export 给宿主既有 import 点。 */
export { mediaPlayUrl } from '../../shared/package-sdk/media-url.ts'

/** Range 代理任意可 range 的上游：透传 Range、relay body，保证 <video> 可 seek。
 *  `mime` 只在上游不给 content-type 时兜底（纯音轨那一档传 `audio/mp4`）。 */
export async function proxyRangedStream(
  url: string, headers?: Record<string, string>, range?: string, mime?: string,
): Promise<Response> {
  const upstream = await fetch(url, { headers: { ...(headers ?? {}), ...(range ? { Range: range } : {}) } })
  const h = new Headers()
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const v = upstream.headers.get(k); if (v) h.set(k, v)
  }
  if (!h.has('content-type')) h.set('content-type', mime ?? 'video/mp4')
  h.set('accept-ranges', h.get('accept-ranges') ?? 'bytes')
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: h })
}
