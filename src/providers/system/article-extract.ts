import type { SystemIdentity } from './types.ts'

/** 网页 → 正文 markdown-lite（段落断行 + `![alt](url)` 图片标记）。**成员是一条成本阶梯**：
 *  裸 HTTP 的 Defuddle 在前（快、免费、不出境），后面追加跑 JS 的降级档（SPA 页面 Defuddle
 *  只能拿到空壳，成员抽出的正文太短会自己 decline）。extract 的 article 分支打它。
 *
 *  为什么另立一行而不往 fetch-url 上加成员：那条行的合同是 FetchUrlResult（媒体导向），
 *  把正文抽取器混进去会让它的合同自相矛盾。
 *
 *  **`serveKeys:['article']` + `fallback:false`**（而不是兜底）：它**按行名直接调**（extract 的
 *  article 分支），不参与按域名的声明匹配。当兜底行会让它混进 `content.enrich` 的分发候选——
 *  那条调用点问的是「这个域名该用哪个富化 Provider」，不是同一个问题。 */
export const articleExtract: SystemIdentity = {
  id: 'article-extract',
  category: 'transform',
  serveKeys: ['article'],
  fallback: false,
  strategy: 'sequential',
  contract: { members: '{ text }（text 即 markdown；空/空壳视同 decline，把机会让给下一个成员）' },
  defaultLabel: '网页正文抽取',
  defaultDescription: '网页 URL → 正文 markdown（顺序回落：裸 HTTP → 跑 JS 的降级档）',
  // 成员顺序**就是**成本阶梯：裸 HTTP、不出境、免费的在前；跑 JS、把 URL 发给第三方、
  // 烧额度的在后。梯子外面不写任何降级判断——降级 = 前一档 decline，执行器自动落下一档。
  defaultMembers: [
    { source: '@streamapp/builtin/article-defuddle', params: { url: '$input' } },
    { source: '@streamapp/firecrawl/article-firecrawl', params: { url: '$input' } },
  ],
}
