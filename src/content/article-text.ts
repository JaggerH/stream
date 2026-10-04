// src/content/article-text.ts
//
// 抓一个网页的**正文 markdown-lite**——`extract` 的 article 分支要的东西。
//
// 为什么不直接用 `extractArticle()` 的返回值：`Article` 上确实有个 `text?` 字段，但
// **`doExtract` 一次都没填过它**（它只产 `html`）。这个仓库里同款陷阱刚咬过一次——
// `FetchUrlResult.text` 的注释写着「extracted plain text」，赋值 0 次，害我写出一条
// 恒空的分支还配了绿测试。所以这里**从 html 现抽**，不信字段名。
import { parseHTML } from 'linkedom'
import { extractArticle } from './extract.ts'

/** 低于这个纯文本字符数就当「这一档没拿到正文」→ decline，把机会让给梯子上跑 JS 的降级档。
 *  空壳页不是全空的——SPA 常剩导航和页脚，所以阈值不能是 0。初值 200，按活体数据再调。
 *  计数**不含图片标记**（见 proseLength）：`![alt](很长的URL)` 的字符不是正文，不能充数。 */
export const MIN_ARTICLE_CHARS = 200

/** 阅读器要 html，转成文字要 markdown-lite——同一次抽取的两个投影。
 *
 *  markdown-lite = 段落断行的纯文本 + 图片保留为 `![alt](url)`（各占一行）。不做标题/链接的
 *  全套保真——消费方（总结模型、逐图 OCR）只需要两样：句子边界，和图片在正文里的位置。
 *  图片必须留：图文混排的文章（公众号是典型）关键信息常在图里，丢图等于交出残缺正文，
 *  逐图 OCR（firecrawl 线）也要靠这个标记定位回填。 */
export function htmlToMarkdown(html: string): string {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`)
  for (const img of document.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? ''
    // 没有 src 的图什么都指不到；data: 内联图多是追踪像素/占位图，OCR 也不该喂它——都直接丢。
    if (!src || src.startsWith('data:')) {
      img.remove()
      continue
    }
    // alt 里的 [ ] 换行会破坏 `![alt](url)` 语法本身，压成空格。
    const alt = (img.getAttribute('alt') ?? '').replace(/[\n[\]]/g, ' ').trim()
    img.replaceWith(document.createTextNode(`\n![${alt}](${src})\n`))
  }
  for (const el of document.querySelectorAll('p,div,br,li,h1,h2,h3,h4,h5,h6,tr,blockquote,pre')) {
    el.after(document.createTextNode('\n'))
  }
  return (document.body.textContent ?? '')
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    // 空行**全部丢掉**：它们几乎都来自 `<p></p>` 这类空标签，段落之间有一个换行就够了，
    // 留着只是喂给模型的噪音。
    .filter(Boolean)
    .join('\n')
}

/** 正文字符数——去掉图片标记后再数。降级判据用它，**不用 Defuddle 的 `wordCount`**：
 *  wordCount 按空格切词，中文正文整段没有空格，一篇几千字的中文文章可能只算出个位数的
 *  word——拿它当阈值会把所有中文页判成空壳、全部推去跑 JS 的降级档（烧额度 + 内容出境）。 */
function proseLength(markdown: string): number {
  return markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim().length
}

/** 抓这个 URL 的正文 markdown-lite；`null` = 这一档没拿到正文（死链 / 不是文章 / Defuddle
 *  抽空 / 只剩导航页脚的空壳）——调用方（`article-defuddle` 成员）据此 decline。
 *
 *  降级判据在**这里**（成员内部），不在分支层：分支外面再判一次就是在梯子外面再搭一条梯子，
 *  走法进不了 `ladder` 账本。判据不能是 HTTP 状态——SPA 的典型症状恰恰是 200 + 空壳。
 *
 *  复用 `extractArticle()`——**同一份实现、同一份缓存**（article 30d / 死链负缓存 1d），
 *  阅读器那条路（`/api/enrich?source=link`）和这里共享，不各抓一遍。 */
export async function fetchArticleText(url: string): Promise<{ text: string; title?: string } | null> {
  const article = await extractArticle(url)
  if (!article?.html) return null
  const text = htmlToMarkdown(article.html)
  if (proseLength(text) < MIN_ARTICLE_CHARS) return null
  return { text, title: article.title }
}
