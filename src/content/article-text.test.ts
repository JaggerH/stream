import { describe, expect, it, vi } from 'vitest'

const extractArticle = vi.hoisted(() => vi.fn())
vi.mock('./extract.ts', () => ({ extractArticle }))

import { MIN_ARTICLE_CHARS, fetchArticleText, htmlToMarkdown } from './article-text.ts'

// 远超阈值、且整段没有一个空格的中文正文——同时服务两条用例：
// 常规的「抽得出」，和「wordCount 陷阱」（按空格切词它只算 1 个 word）。
const LONG_ZH = '这是一段没有任何空格的中文正文内容。'.repeat(30)

describe('htmlToMarkdown', () => {
  it('块级标签之间断行——段落不能黏成一坨', () => {
    expect(htmlToMarkdown('<p>第一段</p><p>第二段</p>')).toBe('第一段\n第二段')
  })

  it('内联标签不断行（一句话不该被拆开）', () => {
    expect(htmlToMarkdown('<p>看这个<a href="x">链接</a>就懂了</p>')).toBe('看这个链接就懂了')
  })

  it('列表逐条断行', () => {
    expect(htmlToMarkdown('<ul><li>甲</li><li>乙</li></ul>')).toBe('甲\n乙')
  })

  it('标签被剥掉，只留文字', () => {
    expect(htmlToMarkdown('<div><h1>标题</h1><p>正文<em>强调</em></p></div>')).toBe('标题\n正文强调')
  })

  // 图片是 markdown-lite 存在的理由：图文混排的文章关键信息常在图里，丢图 = 残缺正文；
  // 逐图 OCR 也靠这个标记定位回填。
  it('图片保留为 ![alt](url)，各占一行', () => {
    expect(htmlToMarkdown('<p>前文</p><img src="https://e.com/a.png" alt="配图"><p>后文</p>'))
      .toBe('前文\n![配图](https://e.com/a.png)\n后文')
  })

  it('没有 alt 的图片保留为 ![](url)', () => {
    expect(htmlToMarkdown('<p>甲</p><img src="https://e.com/a.png">')).toBe('甲\n![](https://e.com/a.png)')
  })

  it('alt 里的方括号/换行压成空格——不许破坏 ![alt](url) 语法本身', () => {
    expect(htmlToMarkdown('<img src="https://e.com/a.png" alt="有[括号]的alt">'))
      .toBe('![有 括号 的alt](https://e.com/a.png)')
  })

  it('无 src / data: 内联图直接丢（追踪像素、占位图不值一格）', () => {
    expect(htmlToMarkdown('<p>甲</p><img><img src="data:image/gif;base64,R0lGOD">')).toBe('甲')
  })

  it('连续空行压成一个，行首尾空白清掉', () => {
    expect(htmlToMarkdown('<p>  甲  </p><p></p><p></p><p>乙</p>')).toBe('甲\n乙')
  })

  it('空 html → 空串（调用方据此判「抽不到正文」）', () => {
    expect(htmlToMarkdown('')).toBe('')
    expect(htmlToMarkdown('<div></div>')).toBe('')
  })
})

describe('fetchArticleText', () => {
  // 这条守的是一次真实的事故：`Article.text` 这个字段**从来没被赋值过**（doExtract 只产 html），
  // 而它的类型和名字都在诱导你去读它。上一版 article 分支就是读了一个同款的空字段
  // （`FetchUrlResult.text`），做出一条恒空的分支还配了绿测试。所以这里的夹具**故意不带 text**：
  // 谁要是改回去读 `article.text`，这条当场红。
  it('正文从 html 现抽，不读那个从没被填过的 text 字段', async () => {
    extractArticle.mockResolvedValue({ sourceUrl: 'u', title: '标题', html: `<p>${LONG_ZH}</p>` })
    await expect(fetchArticleText('u')).resolves.toEqual({ text: LONG_ZH, title: '标题' })
  })

  it('抓不到 / 抽空 → null（调用方据此 decline，把机会让给梯子上的下一个成员）', async () => {
    extractArticle.mockResolvedValue(null)
    await expect(fetchArticleText('u')).resolves.toBeNull()
    extractArticle.mockResolvedValue({ sourceUrl: 'u', html: '' })
    await expect(fetchArticleText('u')).resolves.toBeNull()
    extractArticle.mockResolvedValue({ sourceUrl: 'u', html: '<div>   </div>' })
    await expect(fetchArticleText('u')).resolves.toBeNull()
  })

  // 降级判据的两条支点（spec：firecrawl-article-fallback §4）——
  // 支点一：SPA 空壳**不是**空的，也**不是**非 200。按 HTTP 状态或"html 是否为空"判会永远不降级。
  it('200 空壳（只剩导航页脚）→ null，梯子才落得到跑 JS 的降级档', async () => {
    extractArticle.mockResolvedValue({ sourceUrl: 'u', html: '<nav>首页 关于 联系</nav><footer>© 2026</footer>' })
    await expect(fetchArticleText('u')).resolves.toBeNull()
  })

  // 支点二：wordCount 陷阱。中文正文整段没有空格，按空格切词只算出 1 个 word——
  // 拿 wordCount 当阈值会把所有中文页判成空壳、全部推去降级档（烧额度 + 内容出境）。
  it('纯中文长正文（无空格）不得被判成空壳', async () => {
    expect(LONG_ZH.split(/\s+/).filter(Boolean)).toHaveLength(1) // wordCount 会算成 1
    extractArticle.mockResolvedValue({ sourceUrl: 'u', html: `<p>${LONG_ZH}</p>` })
    await expect(fetchArticleText('u')).resolves.not.toBeNull()
  })

  it('图片标记的字符不计入正文长度——一张长 URL 的图撑不过阈值', async () => {
    const longUrl = `https://e.com/${'x'.repeat(MIN_ARTICLE_CHARS)}.png`
    extractArticle.mockResolvedValue({ sourceUrl: 'u', html: `<p>短文</p><img src="${longUrl}">` })
    await expect(fetchArticleText('u')).resolves.toBeNull()
  })
})
