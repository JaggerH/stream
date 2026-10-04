// src/content/article/article-fetch-dep.ts
//
// article 分支转成文字的 `fetch` dep：把 `article-extract` 能力行一次 invoke 的结果，翻译成
// `ExtractConverterDeps.article.fetch` 的 `{ text?, ladder }` 契约。单独抽出来（而不是留在
// bootstrap() 的闭包里）是因为要守住的判据值得一份自己的测试——bootstrap() 太重，起不起得来
// 跟这个判据对不对没关系（同款理由见 `../images/parse-ocr-dep.ts`）。
//
// 判据：`article-extract` 行拿不到 text 时有两种完全不同的真相——两档成员都干净 decline
// （Defuddle 认不出正文结构、Firecrawl 也没配/没跑，这页**真的**没有可用正文）vs 有成员
// 试了但真的失败（如 Firecrawl 抛 `rate_limited`：HTTP 429，限流或额度耗尽）。两者若都被
// 说成同一句「抓到了页面，但没有可用正文」，后者下这句话是假的——用户会去换一个页面，
// 而不是去看额度，而 spec 明写这两者的下一步完全不同。
//
// 判据用 `InvokeMiss.stack`（`realFailureReason`）：干净 decline 不写这个字段，真 catch 到
// 抛出的错误才写。不做字符串匹配 reason。
import type { InvokeResult } from '../../providers/executor.ts'
import { ladderTrace, LadderError, realFailureReason, type LadderTrace } from '../../providers/ladder-trace.ts'

/** `providerExecutor` 用得到的那一小片接口——不依赖它的完整类型，测试给个假的就行。 */
export interface ArticleFetchInvoker {
  invoke(ref: string, input: unknown): Promise<InvokeResult | null>
}

/** `article-extract` 行 → article 分支的 `fetch` dep。全员干净 decline → 原样返回
 *  `{ text: undefined, ladder }`，上层落成「抓到了页面，但没有可用正文」（此时这句话是对的）；
 *  有成员真的失败 → 抛 `LadderError`，把 member+reason 带出去，不能被悄悄吞成"没有正文"。 */
export function makeArticleFetchDep(executor: ArticleFetchInvoker): (url: string) => Promise<{ text?: string; ladder: LadderTrace }> {
  return async (url) => {
    const res = await executor.invoke('article-extract', url)
    const ladder = ladderTrace(res ?? null)
    const seq = res && res.strategy === 'sequential' ? res : null
    const won = seq?.value as { text?: string } | null
    if (!won?.text) {
      const reason = realFailureReason(seq?.misses ?? [])
      if (reason) throw new LadderError(`article-extract: ${reason}`, ladder)
    }
    return { text: won?.text, ladder }
  }
}
