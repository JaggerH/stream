/** Firecrawl `/v2/scrape` 客户端 —— `article` 分支的降级档（Defuddle 抽不出正文才走）。
 *
 *  keyless 是实测可用的（2026-07-31）：不需要 API key、不需要 SDK、不需要任何额外请求头，
 *  裸 POST 即可，`metadata.creditsUsed: 1`。带 key 只是把额度记在自己账上——keyless 按**出口 IP**
 *  记账，代理节点与他人共享，额度可能被别人先吃掉且只表现为一个 429。 */

const DEFAULT_BASE = 'https://api.firecrawl.dev'
const DEFAULT_TIMEOUT_MS = 30_000

export interface FirecrawlPage {
  markdown: string
  title?: string
  /** Firecrawl 报告的最终 URL（跟随重定向后）；缺席时退回入参 */
  finalUrl: string
  creditsUsed?: number
}

/** 三类失败**必须分开**：`rate_limited` 的下一步是等/配 key，`unavailable` 的下一步是"这页就是
 *  抓不到，别再试"，`transport` 的下一步是查网络。合并成一个"失败了"，等于把最费时间的那类
 *  误诊固化进代码——调用方会对着一个限流错误去排查页面。 */
export type FirecrawlErrorKind = 'rate_limited' | 'unavailable' | 'transport'

export class FirecrawlError extends Error {
  constructor(readonly kind: FirecrawlErrorKind, message: string) {
    super(message)
    this.name = 'FirecrawlError'
  }
}

interface ScrapeBody {
  success?: boolean
  error?: string
  data?: {
    markdown?: string
    metadata?: { title?: string; sourceURL?: string; url?: string; creditsUsed?: number }
  }
}

export async function scrapeWithFirecrawl(
  url: string,
  opts: { baseUrl?: string; apiKey?: string | null; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<FirecrawlPage> {
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // keyless：没有 key 就**不发**这个头。发一个空的 `Bearer ` 会被当成一把坏钥匙拒掉，
  // 而不是回落到 keyless 额度。
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`

  let res: Response
  try {
    res = await fetch(`${base}/v2/scrape`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url, formats: ['markdown'] }),
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (e) {
    throw new FirecrawlError('transport', `[firecrawl] ${(e as Error).message}`)
  }

  // 429 = 速率/并发；402 = credits 用尽。两者对调用方是同一个动作（退避、或去配 key），
  // 所以归成一类；和"这页抓不到"分开。
  if (res.status === 429 || res.status === 402) {
    // 未读的 body 要等 GC 才把连接还给池；限流恰恰是会连续发生的场景，攒着不读会攒连接。
    void res.body?.cancel()
    throw new FirecrawlError('rate_limited', `[firecrawl] HTTP ${res.status} —— 限流或额度耗尽`)
  }

  let body: ScrapeBody
  try {
    body = (await res.json()) as ScrapeBody
  } catch {
    throw new FirecrawlError('transport', `[firecrawl] HTTP ${res.status} 返回体不是 JSON`)
  }

  // 非 2xx 按状态码再分一次：5xx 是 Firecrawl 自己挂了、可重试，不是页面的错——归 transport；
  // 4xx（除已处理的 429/402）才是"这页就是抓不到，别再试"的 unavailable。
  if (!res.ok) {
    const kind: FirecrawlErrorKind = res.status >= 500 ? 'transport' : 'unavailable'
    throw new FirecrawlError(kind, `[firecrawl] HTTP ${res.status}: ${body.error ?? '未说明'}`)
  }
  if (body.success === false) {
    throw new FirecrawlError('unavailable', `[firecrawl] HTTP ${res.status}: ${body.error ?? '未说明'}`)
  }

  // data 信封整个不在，说明返回形状不是我们认识的那个——更像"服务没答对"，跟"这页没内容"
  // （下面的空正文）是两种不同的失败，文案和分类都要分开，别复用同一句话。
  if (!body.data) {
    throw new FirecrawlError('transport', `[firecrawl] HTTP ${res.status}: 响应缺少 data 字段`)
  }

  const markdown = (body.data.markdown ?? '').trim()
  // 空正文当失败，不当"成功但没内容"。后者会让降级梯子认为这一档赢了，
  // 于是交出一份空正文——比失败更坏，因为下游会认真地总结一段空白。
  if (!markdown) throw new FirecrawlError('unavailable', '[firecrawl] 返回空正文')

  const meta = body.data?.metadata ?? {}
  return {
    markdown,
    title: meta.title,
    finalUrl: meta.url || meta.sourceURL || url,
    creditsUsed: meta.creditsUsed,
  }
}
