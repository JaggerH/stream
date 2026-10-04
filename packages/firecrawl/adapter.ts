import type { Adapter, SourceExecutionContext } from '../../src/adapters/types.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'
import { scrapeWithFirecrawl, type FirecrawlPage } from './client.ts'

/** `article-firecrawl` 源的执行后端 —— 宿主 `article-extract` 梯子的降级档成员。
 *
 *  key 是**可选**的：keyless 本身就能跑（按出口 IP 记账）。所以这里和别的 BYOK 源不一样，
 *  **没有 key 不 decline**——decline 会让这一档在 keyless 可用的情况下白白缺席。
 *  真正该 decline 的只有"这个输入我处理不了"（不是 http(s) URL）。
 *
 *  key 由宿主派发：manifest 的 `runtime_config.ref: firecrawl` 那一格，宿主在调用前解析好、
 *  放进 `context.runtimeConfig`。包自己不去任何地方取。 */
export class FirecrawlAdapter implements Adapter {
  readonly id = 'firecrawl'

  async init(): Promise<void> {}

  async fetch(rawParams: Record<string, unknown>, _manifest: SourceManifest, context?: SourceExecutionContext): Promise<unknown[]> {
    const params = rawParams as { url?: unknown; baseUrl?: unknown }
    // 行上写的是 `params: { url: '$input' }`，执行器把洞填进成员 params 再交给引擎——URL 在 params.url。
    const url = typeof params.url === 'string' ? params.url : ''
    if (!/^https?:\/\//i.test(url)) return [] // decline —— 不是我能处理的输入
    const apiKey = context?.runtimeConfig.apiKey
    const page: FirecrawlPage = await scrapeWithFirecrawl(url, {
      baseUrl: typeof params.baseUrl === 'string' && params.baseUrl ? params.baseUrl : undefined,
      apiKey: typeof apiKey === 'string' && apiKey ? apiKey : null,
    })
    // 失败不 catch：抓取失败必须**抛**（decline 的语义是「让位」，不是「试了失败」——混用会把
    // 限流记成弃权，ladder/misses 里分不出「没轮到」和「试了挂了」）。
    // 归形成 `article-extract` 行的成员合同 `{ text }`（text 即 markdown）：裸交 FirecrawlPage
    // 会让这一档"赢了梯子、分支读 .text 却是 undefined"——fetch-url 事故的同款形状。
    // 空 markdown 在 client 层已按 unavailable 抛掉，不存在空 text 的假赢。
    return [{ text: page.markdown, title: page.title, finalUrl: page.finalUrl, creditsUsed: page.creditsUsed }]
  }
}
