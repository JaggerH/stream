import type { Readable } from 'node:stream'
import { owned } from './owned-outbound.ts'
import { BROWSER_UA } from '../../shared/package-sdk/browser-ua.ts'
import { refererForUrl } from '../media/serving.ts'

// 私人 node-http 快照并入 owned 受控通道：从"抢在 RSSHub 补丁前 import"的运气升级为进程入口
// 保证的显式捕获（见 owned-outbound.ts / serve.ts）。按主机带哪个 Referer 问包的 serving 声明。
const { httpGet, httpsGet } = owned

export interface NoRefererResponse {
  status: number
  contentType: string | null
  /** present for Range requests (video streaming): passed through from upstream */
  contentLength: string | null
  contentRange: string | null
  body: Readable
}

/** GET a URL server-side with NO Referer, via native node http(s) so it bypasses the global
 *  fetch wrapper. RSSHub's request-rewriter (loaded process-wide because we embed RSSHub)
 *  monkeypatches globalThis.fetch to inject a self-origin Referer when one is absent (empty
 *  string counts as absent) — which xhs's image CDN (sns-webpic-qc.xhscdn.com) rejects with 403.
 *  Media proxies must fetch hotlink-protected assets with NO Referer, so they bypass that wrapper.
 *  Passes an optional Range through (for video streaming) and follows redirects up to `redirects`
 *  hops. Lives in its own module so tests can mock it (node builtins aren't spyable). */
/**
 * 一个完整的桌面 Chrome UA。**它不是默认值**——想发就得在调用点显式传 `userAgent: BROWSER_UA`。
 *
 * 来历与为什么降级成"可选"：它是跟着豆瓣那次修复一起进来的（`d44fb22c`，正文只说"把最小的
 * `Mozilla/5.0` 升级成完整浏览器 UA"，验的是 douban / TMDB / IMDb 三个站）。也就是说
 * **"某些 CDN 需要浏览器 UA"这件事从来没有被单独证实过**。2026-08-18 拿库里 10 个真实图床
 * ×4 种 UA（本值 / 不发 / 旧的最小 `Mozilla/5.0` / `Stream/1.0`）逐一实测：
 *
 *     hdslb  iqiyipic  doubanio  gzlzfm  music.126  douyinpic  qpic  byteimg  tmdb  amazon
 *     —— 四种 UA 全部 10/10 命中 200，包括 d44fb22c 当年验的那三个站。
 *
 * 结论：**这个 UA 没有任何可测到的收益**，而它有一个可测到的风险——它是一串固定指纹，
 * WAF 可以直接拿它当靶子。所以图片代理默认不发 UA（少一个被针对的把柄），
 * 视频代理那条保持显式传它（那条路没有活体样本可测，不动为上，见 `app.ts` 的调用点）。
 *
 * **别把这段读成"荔枝那次 403 已经定案"**：那次（gzlzfm 对带 UA 的请求稳定 403、不带稳定 200）
 * 半小时后就复现不出来了——同一个地址连打 60 发、两种 UA 各 30，全部 200。所以真实形状更像
 * "WAF 进了某种触发态之后才按 UA 过滤"，**不是一条稳定规则**。这里改默认值靠的是上面那张
 * "四种 UA 全都不劣"的表，不是靠那次 403。
 *
 * **复发样本在哪**：图片代理每遇一次上游非 2xx 就记一条 `image-proxy` 频道的失败条目，落盘在
 * `data/debug-failures.jsonl`（`grep '"image-proxy"'`）。这条路径恒不发 UA、恒不发 Referer，
 * 所以样本里每一条都是"裸请求也被拒"。要谈"按 host 维护一张出站 UA 表"，先拿这份样本说话。
 *
 * 常量本体住 `shared/package-sdk/browser-ua.ts`（xhs 包直打站方接口也用它，宿主与包同吃一份）；
 * 这里 re-export 给宿主既有 import 点。
 */
export { BROWSER_UA }

export function getNoReferer(
  rawUrl: string,
  signal: AbortSignal,
  opts: { range?: string; accept?: string; redirects?: number; referer?: string; userAgent?: string } = {}
): Promise<NoRefererResponse> {
  const redirects = opts.redirects ?? 3
  return new Promise((resolve, reject) => {
    let u: URL
    try {
      u = new URL(rawUrl)
    } catch (e) {
      reject(e as Error)
      return
    }
    // UA 默认不发 —— 少一串固定指纹给 WAF 当靶子，且实测发不发都不影响命中（见 BROWSER_UA 头注）。
    const headers: Record<string, string> = { Accept: opts.accept ?? 'image/*,*/*' }
    if (opts.userAgent) headers['User-Agent'] = opts.userAgent
    // Referer 按主机：多数图床拒带 Referer 的请求（缺省不带）；少数反着防盗链、不带就拒——
    // 那几台由站点包的 serving 声明 `referer`（src/media/serving.ts refererForUrl），宿主不认识站。
    const referer = opts.referer ?? refererForUrl(u.toString())
    if (referer) headers.Referer = referer
    if (opts.range) headers.Range = opts.range
    const get = u.protocol === 'https:' ? httpsGet : httpGet
    const req = get(u, { headers, signal }, (res) => {
      const status = res.statusCode ?? 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && location && redirects > 0) {
        res.resume() // drain the redirect body so the socket frees
        getNoReferer(new URL(location, u).toString(), signal, { ...opts, redirects: redirects - 1 }).then(resolve, reject)
        return
      }
      resolve({
        status,
        contentType: res.headers['content-type'] ?? null,
        contentLength: res.headers['content-length'] ?? null,
        contentRange: res.headers['content-range'] ?? null,
        body: res,
      })
    })
    req.on('error', reject)
  })
}

/** Image twin of getNoReferer (no Range) — kept for the image proxy + its test. */
export async function getImageNoReferer(
  rawUrl: string,
  signal: AbortSignal,
  redirects = 3
): Promise<{ status: number; contentType: string | null; body: Readable }> {
  const r = await getNoReferer(rawUrl, signal, { redirects })
  return { status: r.status, contentType: r.contentType, body: r.body }
}
