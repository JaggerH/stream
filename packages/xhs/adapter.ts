import type { Adapter } from '../../src/adapters/types.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'
import type { VideoResolved } from '../../src/video/play.ts'
import { BROWSER_UA } from '../../shared/package-sdk/browser-ua.ts'
import type { DetailDeps } from './detail.ts'
import { fetchUrlFor } from './fetch-url.ts'

/** 这个成员的 miss 原话。执行器把它记进成员 miss，宿主 502 的 `detail` 里就是这一句。 */
export const STREAM_NOT_REGISTERED = '这条笔记的播放地址还没取到——先打开这条笔记（详情页会把地址登记进来）'

/**
 * 这个包的执行后端。**按 manifest id 分派**（与 bilibili 同形）。
 *
 * `xhs-resolve`：`{ vid, format }` → `[VideoResolved]`，`vid = noteId`。平台分派已经由 Provider 行的
 * serve 键（`xhs-video`）完成，这里不判平台。本站只有 mp4 直链，所以 `format === 'dash'` 如实回 `[]`
 * （前端 dash 502 之后再问 progressive）。
 *
 * 流地址**只**从 `streams` 取（打开笔记时 detail 记的）。没记过就抛 `STREAM_NOT_REGISTERED`，**不**去跑
 * detail 现取：没有 xsec_token 的 detail 运行只能靠 feed 账本里恰好还有这张卡片，账本里没有就落
 * fallback-nav、注定失败，还白烧一个限速名额；而 `<video>` 的 Range 请求会把 xhs-resolve 反复打上来，
 * miss 一次就是一条注定失败的 recipe 运行。卡片本来就只有海报，不先打开详情本来就播不了——抛出原话
 * 让前端把「先打开这条笔记」说给用户听，比静默烧名额诚实。
 *
 * 地址是 http 的 xhscdn 签名 mp4：宿主的播放路由在服务端代理它，浏览器看不到 http。出站请求带完整的桌面
 * Chrome UA（`BROWSER_UA`）——这是原先专用视频代理路由发的形状，那条路没有活体样本能证明不带 UA 也行，
 * 原样保留（判据与实测表见 `image-fetch.ts` 的 BROWSER_UA 头注）。
 *
 * `xhs-fetch-url`：`{ url }` → `[FetchUrlResult]`（manifest `output: object`，单个对象）。哪些链接
 * 归本包由 `stream.links` 声明（`xiaohongshu.com` / `xhslink.com`），派发由 `content.enrich` 调用点按 `xhs-link` 完成，这里只认 id。
 */
export class XhsAdapter implements Adapter {
  readonly id = 'xhs'
  constructor(private readonly deps: DetailDeps) {}

  async init(): Promise<void> { /* 没有凭证要装：recipe 骑的是用户 Chrome 里的登录态 */ }

  async fetch(params: Record<string, unknown>, manifest: SourceManifest): Promise<unknown[]> {
    if (manifest.id.endsWith('xhs-resolve')) return this.resolve(params)
    if (manifest.id.endsWith('xhs-fetch-url')) {
      const url = typeof params.url === 'string' ? params.url : ''
      if (!url) return []
      return [await fetchUrlFor(this.deps, url)]
    }
    throw new Error(`[xhs] unsupported source ${manifest.id}`)
  }

  private async resolve(params: Record<string, unknown>): Promise<VideoResolved[]> {
    const vid = typeof params.vid === 'string' ? params.vid : ''
    if (!vid) return []
    if (params.format === 'dash') return []
    const hit = this.deps.streams.get(vid)
    if (!hit) throw new Error(STREAM_NOT_REGISTERED)
    return [{ kind: 'progressive', url: hit, headers: { 'User-Agent': BROWSER_UA } }]
  }
}
