/**
 * 从一个卡片链接里抠出条目的 id —— `readViewport`（"视口里现在有哪些卡"）唯一的身份来源。
 *
 * 规则是**路径的最后一段、且长得像 id（16 位以上的十六进制）**，不认站点的路由名。原先这里写死
 * 的是 `/explore/<id>`，那是 homefeed 的形状；账本来源换成 search feed 之后同一条笔记可能挂在
 * `/search_result/<id>` 下，写死路由名的后果是视口里一张「认识的卡」都没有 → locate 判 MISS →
 * 每次 detail 都退化成整页导航。**它有数据、不报错**，所以这种坏法最难发现（见
 * `.claude/skills/write-recipe/references/pipeline.md` §4）。
 *
 * 先切掉 query/hash 再匹配：签名 token 一类的 query 参数是不定形的长串，让它有机会参与匹配等于给自己
 * 埋一个偶发的错 id。
 *
 * 两个 driver（cloak 的 Playwright `$$eval` / ext-cdp 的 `Runtime.evaluate` 字符串）都在**页内**
 * 求值，闭包带不过去，所以共享的是这个正则的**源码字符串**，宿主侧的 `cardIdFromHref` 只是同一
 * 条规则的可测版本。
 */
export const CARD_ID_RE_SOURCE = '([0-9a-f]{16,})\\/?$'

/** 宿主侧的同款实现（单测拿它验规则；页内代码用 CARD_ID_RE_SOURCE 现场 new RegExp）。 */
export function cardIdFromHref(href: string): string | null {
  const path = String(href || '').split(/[?#]/)[0]
  const m = path.match(new RegExp(CARD_ID_RE_SOURCE))
  return m ? m[1] : null
}

/**
 * 页内谓词：这个元素**看得见吗**（= Playwright `:visible`：盒子非空 且 不是 `visibility:hidden`）。
 *
 * 为什么必须有它（2026-07-28 活体取证）：xhs 搜索结果页上**同一张卡片有 3 个 anchor**——
 * 一个 `display:none` 的 `/explore/<id>`（rect 全 0，中心算出来是 **(0,0)**）、一个 262×350 的
 * 封面、一个 238×39 的标题行。`openTarget` 取"文档序第一个 href 含 id 的元素"，取到的正是那个
 * 隐藏的，于是**点在页面左上角**：笔记没打开、`observeOpened` 等 3 秒超时、退回 fallback-nav。
 * 账本、locate、humanize 全都跑对了，最后一步点了个空。
 *
 * cloak 侧一直是对的（`page.locator(...):visible)`，注释里也早写着"第一个可能是 zero-size/hidden"），
 * **是 ext 侧丢了这条语义**——同一份 recipe 在两个 transport 上必须表现一致，所以这里把判据抽成
 * 一份共享的页内源码，而不是各写各的。
 *
 * `visibility:hidden` 也要判：它**有非空盒子**，光看 rect 拦不住（`display:none` 才一定是 0×0）。
 */
export const VISIBLE_EL_FN_SOURCE =
  '((el)=>{const r=el.getBoundingClientRect();' +
  'if(!(r.width>0)||!(r.height>0))return false;' +
  'try{return (getComputedStyle(el).visibility||"")!=="hidden"}catch(e){return true}})'
