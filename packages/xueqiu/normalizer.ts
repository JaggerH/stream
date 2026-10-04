import type { Normalizer } from '../../src/content/normalize.ts'
import type { Content } from '../../src/content/types.ts'
import { extractImages, stripImages, toText } from '../../shared/package-sdk/html.ts'
import { DETAIL_SOURCE } from './detail.ts'

/**
 * 雪球的表情是**内联 <img>**,不是字符:
 *   <img src="//assets.imedao.com/ugc/images/face/emoji_07_wonderful.png?v=1" title="[牛]" alt="[牛]" height="24" />
 * 不认它就会双输——extractImages 把它当成图片塞进图集(一条纯文字帖能凭空长出 7 张"图"),
 * stripImages 又把它从正文里删干净,于是这个字连文本形态都不剩。
 *
 * 判据取 src 路径里的 `/images/face/`(实测 2026-07-29 段永平 timeline 的 19 个 img 全是这个形状):
 * 真图走的是另一个域 `//xqimg.imedao.com/...`,不会被误伤。**不拿 height=24 或 alt 形如 [x] 当判据**
 * ——那是表情碰巧具备的属性,真图也可能有。
 *
 * 还原成 alt/title 的字面([牛]),让它以文字身份留在正文里,而不是消失。
 */
const EMOJI_IMG = /<img\b[^>]*>/gi
function unemoji(html: string): string {
  return html.replace(EMOJI_IMG, (tag) => {
    const src = /\bsrc=["']([^"']+)["']/i.exec(tag)?.[1] ?? ''
    if (!/\/images\/face\//i.test(src)) return tag
    return /\b(?:alt|title)=["']([^"']*)["']/i.exec(tag)?.[1] ?? ''
  })
}

/** 服务端截断的签名:正文以字面省略号收尾(英文三点或中文 …)。 */
const TRUNCATED = /(\.\.\.|…)\s*$/

/** 雪球接口给的 link/target 是站内相对路径(/uid/id);绝对化成完整 URL 供前端 a href。 */
function xueqiuUrl(path: string): string {
  if (!path) return ''
  return /^https?:\/\//.test(path) ? path : `https://xueqiu.com${path.startsWith('/') ? '' : '/'}${path}`
}

/**
 * 雪球 user_timeline normalizer.
 *
 * 雪球把"被转发 / 被回复的原帖"放在 `retweeted_status` 子对象里,本帖 `description` 只是
 * 转发语或回复评论;defaultNormalizer 只渲染 description → 原帖正文全丢。
 *
 * 复用归一化模型既有的 forward/quoted 能力(types.ts 的 `Quoted`、已装包里某个平台 normalizer 的转发分支、
 * 前端 Detail.tsx 的 QuotedView):本帖评论进 `text`,原帖进结构化 `quoted`,由前端渲染成
 * 嵌套引用卡片 —— 不把原帖拼进 text,也不预设"转发/回复"字样(retweeted_status 两者都可能)。
 *
 * 依赖 recipe.mapping 透传的字段:
 *   description  本帖 HTML(转发语 / 回复评论 / 原创正文)
 *   quoteText    retweeted_status.description —— 原帖正文 HTML(转发/回复时才有)
 *   quoteAuthor  retweeted_status.user.screen_name —— 原帖作者
 *   quotePermalink retweeted_status.target —— 原帖站内路径(/uid/id)
 *
 * user_timeline 把原帖 description **服务端截断**(结尾是字面 "..." 或 "…")。截断了、且有 permalink,
 * 这条就带 `enrich: { source: 'xueqiu-detail', params: { permalink } }`——前端打开它时按这个现取详情页
 * 渲染后的全文(本包的 detail enricher,`detail.ts`),填回引用块。没截断就不写:没有东西可补,
 * 白开一次标签页就是白扣一次这个 facility 的访问预算。
 */
export const xueqiuNormalizer: Normalizer = (raw) => {
  // 先把表情换回文字,后面的 extractImages/stripImages 才只看得见真图
  const ownHtml = unemoji(String(raw.description ?? ''))
  const quoteHtml = unemoji(String(raw.quoteText ?? ''))
  const quoteAuthor = raw.quoteAuthor ? String(raw.quoteAuthor) : ''
  const quotePermalink = raw.quotePermalink ? String(raw.quotePermalink) : ''

  const ownText = toText(stripImages(ownHtml)).trim()
  const ownMedia = extractImages(ownHtml)

  // 转发 / 回复:原帖作为结构化引用块,前端 QuotedView 渲染成嵌套卡片
  if (quoteHtml || quoteAuthor) {
    const quoteText = toText(stripImages(quoteHtml)).trim() || undefined
    const permalink = quotePermalink ? xueqiuUrl(quotePermalink) : undefined
    const content: Content = {
      archetype: 'forward',
      text: ownText || undefined,
      media: ownMedia.length ? ownMedia : undefined,
      quoted: {
        author: quoteAuthor || undefined,
        text: quoteText,
        media: extractImages(quoteHtml),
        permalink,
      },
    }
    if (permalink && quoteText && TRUNCATED.test(quoteText)) {
      content.enrich = { source: DETAIL_SOURCE, params: { permalink } }
    }
    return content
  }

  // 原创:图集 / 纯文本
  return ownMedia.length
    ? { archetype: 'gallery', text: ownText || undefined, media: ownMedia }
    : { archetype: 'text', text: ownText || undefined }
}
