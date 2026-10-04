import type { Item } from './types.ts'

/**
 * 简介浮层里放什么——**唯一判据**，别在 JSX 里内联判。
 *
 * 只收**纯文本那一支**：结构化正文（文章 HTML、转发引用）铺在播放器画面上既读不了也不该读，
 * 它们留在右面板原来的位置。返回空串 = 这条内容不画浮层。
 *
 * 抽成具名函数是为了它能被搜到、能被钉住：两个挂载点（ArtPlayer 里的淡入层、媒体台底部的
 * 常驻层）和右面板「这段还画不画」都读它，判据一分家就会出现"浮层和面板各画一份同样的字"。
 *
 * `artText` 为空串时会回落到 `item.content?.text`（存储的那份旧简介），这是刻意的、不是漏判：
 * 简介浮层是装饰性的一条，宁可显示存着的那份旧简介，也不要空着一条。调用方传的是详情页富化
 * 状态里的 `art?.text`，类型就是 `string | undefined`，不存在"权威地确认为空"这个信号——所以
 * 空串和缺席同义，都当"这一份不可用，退回存储的那份"处理，不做区分。
 */
export function overlayBlurb(item: Item, artText?: string, artHtml?: string): string {
  if (artHtml) return ''
  if (item.content?.quoted) return ''
  return (artText || item.content?.text || '').trim()
}
