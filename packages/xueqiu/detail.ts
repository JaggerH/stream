import type { Enricher } from '../../src/packages/activate.ts'
import type { PackageReadSource } from '../../src/packages/read-source.ts'
import type { Enrichment } from '../../src/content/types.ts'
import { ValidationError } from '../../shared/package-sdk/errors.ts'

/**
 * 打开一条转发 / 回复帖时，现取被截断原帖全文的那条源（本包的 `xueqiu-detail` recipe，局部名），
 * 同时也是这个 enricher 对外申报的名字（`package.json#stream.code.enrichers`、normalizer 写进
 * `Content.enrich.source` 的那个）。三处共用这一个常量，改一处不会漂。
 */
export const DETAIL_SOURCE = 'xueqiu-detail'

/** 只放行本站的状态页：recipe 会把本 facility 的真标签页导航到这个地址，任意客户端 URL 绝不能放过去。 */
const PERMALINK_RE = /^https:\/\/xueqiu\.com\//

/**
 * 站方在详情页正文前注入一段隐藏的出处节点：`来源：雪球App，作者：<名>，（<url>）`。
 * DOM 观察器读的是 textContent，会把它一起读进来；剥掉它才是用户看到的正文。
 */
const CITATION_PREFIX = /^来源[:：]雪球App[，,]作者[:：][^)）]*[)）]/

export interface DetailDeps {
  readSource: PackageReadSource
}

/**
 * user_timeline 里被转发 / 被回复的原帖正文是服务端截断的（结尾 "..."）；单条状态的 JSON 接口同样截断，
 * 而它和详情页的裸 HTML 都被站方 WAF 拦成 JS 挑战页（带有效登录 cookie 裸 fetch 也过不去）。所以这里读的是
 * **详情页渲染完的 DOM**（`xueqiu-detail` recipe，kind:browser）——页面自己显示的那份全文。
 *
 * 只回 `article.text`，不回评论：引用块在这里没有讨论串。前端把它填回 QuotedView（转发帖的本帖评论仍是正文）。
 */
export function makeDetailEnricher(deps: DetailDeps): Record<string, Enricher> {
  return {
    [DETAIL_SOURCE]: async (query, signal): Promise<Enrichment> => {
      const permalink = query.permalink
      if (!permalink || !PERMALINK_RE.test(permalink)) {
        throw new ValidationError(`${DETAIL_SOURCE}: permalink must be a https://xueqiu.com/ status URL`)
      }
      const items = await deps.readSource(DETAIL_SOURCE, { permalink }, { signal })
      const it = items[0] as { text?: unknown } | undefined
      const raw = typeof it?.text === 'string' ? it.text : ''
      const text = raw.replace(CITATION_PREFIX, '').trim()
      return text ? { article: { sourceUrl: permalink, text } } : {}
    },
  }
}
