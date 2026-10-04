import type { Adapter } from '../../src/adapters/types.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'
import type { VideoResolved } from '../../src/video/play.ts'
import { BilibiliClient, videoRefOf } from './client.ts'
import { fetchUrlFor } from './fetch-url.ts'

/**
 * 这个包的执行后端。**按 manifest id 分派**（同一个 adapter 服务这个包的几个源）。
 *
 * `bilibili-resolve`：`{ vid, format }` → `[VideoResolved]`。平台分派已经由 Provider 行的
 * serve 键（`bilibili-video`）完成，所以这里不判平台；`format` 缺省走 dash。
 * `bilibili-fetch-url`：`{ url }` → `[FetchUrlResult]`（manifest `output: object`，单个对象）。
 * 哪些链接归本包由 `stream.links` 声明（`bilibili.com` / `b23.tv`），派发由 `content.enrich` 调用点按
 * `bilibili-link` 完成，这里只认 id。
 */
export class BilibiliAdapter implements Adapter {
  readonly id = 'bilibili'
  constructor(private readonly client: BilibiliClient) {}

  async init(): Promise<void> { /* 凭证由宿主注入进 client 的 cookie 闭包 */ }

  async fetch(params: Record<string, unknown>, manifest: SourceManifest): Promise<unknown[]> {
    if (manifest.id.endsWith('bilibili-resolve')) return this.resolve(params)
    if (manifest.id.endsWith('bilibili-fetch-url')) {
      const url = typeof params.url === 'string' ? params.url : ''
      if (!url) return []
      return [await fetchUrlFor(this.client, url)]
    }
    throw new Error(`[bilibili] unsupported source ${manifest.id}`)
  }

  private async resolve(params: Record<string, unknown>): Promise<VideoResolved[]> {
    const vid = typeof params.vid === 'string' ? params.vid : ''
    if (!vid) return []
    const ref = videoRefOf(vid)
    const format = typeof params.format === 'string' ? params.format : 'dash'
    if (format === 'progressive') {
      const { url, headers } = await this.client.progressive(ref)
      return [{ kind: 'progressive', url, headers }]
    }
    if (format === 'audio') {
      const { url, headers } = await this.client.audio(ref)
      return [{ kind: 'progressive', url, headers, mime: 'audio/mp4' }]
    }
    return [{ kind: 'dash', manifest: await this.client.dash(ref) }]
  }
}
