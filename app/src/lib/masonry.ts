// 瀑布流分列：估高 → 投进当前最矮的列。纯函数，不碰 DOM、不碰 React。
//
// 为什么是估高而不是测高：卡片高度在渲染前就能算——列宽已知，图片的 natural w/h 已经在
// mediaPreviews 里，文字高度按字数估。测高要等图片加载完、会重排抖动、追加时整片跳位。
//
// 关键约束：估高**只**决定"这张卡投进哪一列"这一个问题，绝不拿去撑高度。每列都是普通
// flex-col，卡片高度由内容自然决定。估错的后果只是列底参差——实测 5 列 321 张卡时 3.5%。
//
// 但这有个前提：**凡是影响高度的取值，估高器和渲染端(PostCard)必须用同一个**。占位比例
// (DEFAULT_MEDIA_*)、封面比例带(MEDIA_RATIO_MIN/MAX)、学到的真实尺寸(mediaSize.ts)三样都各
// 踩过一次"只改一端"，每次都表现为列高对不上（最狠一次差 2429px / 23.8%）。往下加新的
// 高度因素时，先问它在两端是不是同一个来源。
import type { Item } from './types.ts'
import { mediaPreviews, normalizePostTitle, postSummary, quotedPost } from './feedPresent.ts'
import { getMediaSize } from './mediaSize.ts'

/** 目标卡宽——列数就是 `floor(容器宽 / 它)`。
 *
 *  260 → 210 的理由是活体量的：工作台开着对话抽屉（固定 420px）时瀑布流容器实测 872px，
 *  按 260 算只有 3 列，卡片被拉到 283px 宽、一屏信息量偏低。210 让这一档落到 4 列
 *  （每列约 209px），且留了余量——840px 以上都是 4 列，不会在抽屉宽度微调时抖回 3 列。 */
export const TARGET_CARD_WIDTH = 210
export const MIN_COLUMNS = 2
export const MAX_COLUMNS = 6

/** 还不知道真实尺寸时的**占位**比例，3:4 —— 全量实测（321 张封面）的**中位数** 0.75。
 *
 *  改过两次，两次都是被样本骗的，记在这里免得再来第三次：
 *  最早 4:5 竖版（照 Pinterest / 小红书类推，压根没量）；然后 16:9 横版（量了，但只有 19 张
 *  已加载的图，得出"压倒性横版"）。全量量完才看清真实分布是**双峰**：横版 16:9 一带 45%、
 *  竖版 9:16 一带 36%、正方形那一档 **0 张**。占位比例既然要在"还不知道是哪一族"时用，
 *  就该取中位数让两边的期望误差最小，而不是押注其中一族。 */
export const DEFAULT_MEDIA_RATIO = 3 / 4
/** 同一个默认比例的 CSS 写法（宽/高），给 CardMedia 的 `aspect-ratio` 用。
 *
 *  必须和 DEFAULT_MEDIA_RATIO 是同一个数：估高器按这个比例给缺尺寸的图**预留**了高度，
 *  渲染端就得真的占住那么高。两边不一致的后果实测过——活体 134 张有封面的卡里 78 张
 *  没有内建宽高，渲染端当时不传 ratio、框子塌成 auto（其中 60 张当场是 0 高），估高器
 *  却按 274×1.25≈342px 记账，列高实测最多差 2429px（23.8%）。而且图片加载完成的瞬间
 *  列高会整列跳一下——正是 aspect-ratio 本该消灭的抖动。 */
export const DEFAULT_MEDIA_ASPECT = '4 / 3'
// ── 封面比例带 ────────────────────────────────────────────────────────────────────
//
// 允许的高/宽区间。**不是**固定成一个比例，也不是完全放任。
//
// 为什么不固定一个比例：全量实测 321 张封面，分布是双峰的——横版 16:9 一带 45%、竖版
// 9:16 一带 36%、**正方形那一档 0 张**。内容天然分成"横屏视频封面"和"竖屏视频封面"两坨，
// 中间是空的。所以任何单一固定比例都会对其中一坨下狠手：定 16:9 要把 36% 的竖版裁掉 68%
// 的画面，定 9:16 要把 45% 的横版裁掉两侧一大半。
//
// 为什么也不放任：上限原来是 2.0，太松——9:16（1.78）原样长出来就是 266px 的列里一根
// 472px 的塔，紧挨着 100px 的纯文字卡，差 4.7 倍，读起来是"高塔配矮桩"而不是参差。
//
// 夹成 [9/16, 5/4] 之后：横版 16:9 正好落在下界，**一刀不裁**；竖版 9:16 夹到 5:4，
// 裁掉约 30%（竖屏视频封面的主体基本都在画面中央，这一刀不致命）；卡片高度范围从
// 210–629px 收到大约 210–400px。参差还在，塔没了。
export const MEDIA_RATIO_MIN = 9 / 16
export const MEDIA_RATIO_MAX = 5 / 4

/** 把一个高/宽比夹进允许的带内。
 *
 *  估高器和渲染端（PostCard）**必须调这同一个函数**——不是各自抄一遍 Math.min/max。
 *  这条链上"只改一端"已经出过三次事（占位比例、超长图上限、学到的真实尺寸），每次都
 *  表现为列高对不上，最狠一次差 2429px / 23.8%。共用一个函数是让它不可能再发生的写法。 */
export function clampMediaRatio(ratioHW: number): number {
  return Math.min(MEDIA_RATIO_MAX, Math.max(MEDIA_RATIO_MIN, ratioHW))
}
const CONTENT_PADDING = 22   // 文字区上下 padding 之和
const TITLE_LINE_H = 20
const DESC_LINE_H = 18
const FOOTER_H = 30          // 底部作者行
const TITLE_FONT = 14
const DESC_FONT = 13
const MAX_TITLE_LINES = 2
const MAX_SUMMARY_LINES_WITH_TITLE = 2
const MAX_SUMMARY_LINES_NO_TITLE = 3
// —— 转发帖的引用块（PostCard 里那张嵌套 Card）——
const QUOTE_FONT = 12
// 两个数字是活体量的（37 张转发卡：2 行的块高 49px、3 行 65.5px）——
// 16 + n×16.5 正好还原，不是照 CSS 心算的。
const QUOTE_LINE_H = 16.5        // text-[12px] leading-snug
const QUOTE_BLOCK = 22           // 自己的 py-2(16) + 与摘要之间的 mt-1.5(6)
const MAX_QUOTE_LINES = 3        // 必须等于 PostCard 上那个 line-clamp-3
/** 引用块比正文再窄一圈：外面是卡片的 px-3(24)，里面还有自己的 px-2.5(20)。
 *  正文那半仍按 colWidth 估（既有行为，误差对每张卡系统性一致，只影响列底参差几像素）；
 *  引用块这 44px 占 210px 列宽的 21%，不扣会少估行数，所以单独扣掉。 */
const QUOTE_INSET = 44

export interface CardMetrics {
  id: string
  mediaW?: number
  mediaH?: number
  hasMedia: boolean
  title: string
  summary: string
  /** 转发帖被引用的原帖（作者 + 正文拼成一串，只用来估行数）。'' = 不是转发。 */
  quote: string
}

export interface MasonryState {
  /** 每列的 item id（存 id 不存 item：状态要能跨渲染比较，item 对象每次都是新的）。 */
  columns: string[][]
  /** 每列的累计估高——增量追加的依据。 */
  heights: number[]
  colCount: number
  itemCount: number
  lastId: string | null
}

export function columnCountFor(containerWidth: number): number {
  const raw = Math.floor(containerWidth / TARGET_CARD_WIDTH)
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, raw))
}

/** 粗估一段文字的像素宽度。CJK 和全角标点按一个字宽，其余按半个多一点。
 *  精度只影响列底齐不齐，不必上 canvas 真测。 */
function textWidth(text: string, fontSize: number): number {
  let w = 0
  for (const ch of text) w += /[⺀-鿿가-퟿＀-￯]/.test(ch) ? fontSize : fontSize * 0.55
  return w
}

function lineCount(text: string, fontSize: number, colWidth: number, max: number): number {
  if (!text) return 0
  return Math.min(max, Math.max(1, Math.ceil(textWidth(text, fontSize) / Math.max(1, colWidth))))
}

export function estimateCardHeight(m: CardMetrics, colWidth: number): number {
  let h = 0
  if (m.hasMedia) {
    const ratio = m.mediaW && m.mediaH ? m.mediaH / m.mediaW : DEFAULT_MEDIA_RATIO
    h += colWidth * clampMediaRatio(ratio)
  }
  const titleLines = lineCount(m.title, TITLE_FONT, colWidth, MAX_TITLE_LINES)
  const summaryLines = lineCount(
    m.summary, DESC_FONT, colWidth,
    titleLines > 0 ? MAX_SUMMARY_LINES_WITH_TITLE : MAX_SUMMARY_LINES_NO_TITLE
  )
  h += CONTENT_PADDING + titleLines * TITLE_LINE_H + summaryLines * DESC_LINE_H + FOOTER_H
  if (m.quote) {
    const lines = lineCount(m.quote, QUOTE_FONT, colWidth - QUOTE_INSET, MAX_QUOTE_LINES)
    h += QUOTE_BLOCK + lines * QUOTE_LINE_H
  }
  return h
}

export function cardMetrics(item: Item): CardMetrics {
  // 这里**不**读 enrichment（那是 per-item 的 hook，拿不到批量值）——估高用未 enrich 的
  // 封面和摘要就够了，差异只影响列底齐不齐。
  const first = mediaPreviews(item)[0]
  // 学到的真实尺寸**压过**条目自带的声明。声明的那份不可信：实测有一批把短视频的
  // 1080×1920 挂到了 4:3 的封面图上，照它预留会连着框子一起画错。渲染端(PostCard)读的
  // 是同一份缓存，两边不会各说各话。
  const learned = getMediaSize(first?.src)
  // 摘要走 postSummary 而不是 itemSummary：转发语为空时后者会把原帖正文顶上来当摘要，
  // 而渲染端(PostCard)把那段字画在引用块里、正文位置留空——照 itemSummary 记账就是
  // 同一段字记两遍。两端同源在这里的落点就是"调同一个函数"。
  const quoted = quotedPost(item)
  return {
    id: item.id,
    mediaW: learned?.w ?? first?.w,
    mediaH: learned?.h ?? first?.h,
    hasMedia: !!first,
    title: normalizePostTitle(item),
    summary: postSummary(item),
    quote: quoted ? `${quoted.author}${quoted.text}` : '',
  }
}

function shortestColumn(heights: number[]): number {
  let best = 0
  // 严格小于才换列 → 并列时取最左，等高卡片因此按 左→右 的阅读顺序铺开。
  for (let i = 1; i < heights.length; i++) if (heights[i] < heights[best]) best = i
  return best
}

/** 上一次的结果还能接着用吗？条件：列数没变，且**抽样**检查新列表末位与旧列表末位重合
 *  (只比较 `metrics[prev.itemCount - 1]` 这一个下标，不是逐项比对整段前缀，所以不是严格
 *  证明"新列表是旧列表的前缀")。这个抽样在实践中够用：瀑布流只会在末尾追加或整体替换,
 *  一旦是"顶部插入新卡"这种会改变前缀的场景,被抽样的那个下标对应的 id 必然跟着挪位、
 *  从而让抽样检查失败、退回全量重算,不会误判成可增量追加。
 *  列宽变化**故意不**打断增量——缩放窗口时列数没变却让卡片洗牌，是比列底略不齐更糟的体验。 */
function canAppend(metrics: CardMetrics[], colCount: number, prev?: MasonryState): prev is MasonryState {
  if (!prev || prev.colCount !== colCount) return false
  if (metrics.length < prev.itemCount) return false
  if (prev.itemCount === 0) return true
  return metrics[prev.itemCount - 1]?.id === prev.lastId
}

export function assignColumns(
  metrics: CardMetrics[],
  colCount: number,
  colWidth: number,
  prev?: MasonryState
): MasonryState {
  // colCount<=0 时 heights 会是空数组,shortestColumn 越界返回 0 就会 push 到不存在的列
  // 而抛错;夹到 1(不夹到 MIN_COLUMNS)只保底"总能跑完",不擅自覆盖调用方传入的列数意图。
  colCount = Math.max(1, colCount)
  const append = canAppend(metrics, colCount, prev)
  const columns = append ? prev.columns.map((c) => [...c]) : Array.from({ length: colCount }, () => [] as string[])
  const heights = append ? [...prev.heights] : new Array(colCount).fill(0)
  const start = append ? prev.itemCount : 0

  for (let i = start; i < metrics.length; i++) {
    const card = metrics[i]
    const col = shortestColumn(heights)
    columns[col].push(card.id)
    heights[col] += estimateCardHeight(card, colWidth)
  }

  return {
    columns,
    heights,
    colCount,
    itemCount: metrics.length,
    lastId: metrics.length ? metrics[metrics.length - 1].id : null,
  }
}
