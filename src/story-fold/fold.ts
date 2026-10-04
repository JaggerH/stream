/**
 * 同质内容归堆的**骨架**：证据器 → 归堆 → 选代表 → 折叠。
 *
 * 设计与不变量见 `docs/superpowers/specs/2026-08-13-same-story-folding-design.md`。
 * 这里只重复最要紧的两条：
 *
 * 1. **归堆是呈现层的事，永不阻止入库。** 它只回答「这几条摆一格还是摆三格」，
 *    不回答「这条存不存」。后者是 `src/dedup-store.ts` 的活，两者永不合并——
 *    合了之后跨平台采到的第二份会被当重复丢在入库那一步，「他也发到 B 站了」
 *    这个事实本身就没了。
 * 2. **一条内容都不会消失。** 折叠只是摆法，`rep + members` 展开等于输入。
 *    测试里钉着这条。
 *
 * 阈值和证据组合按场景走 `FoldProfile`（`./profiles.ts`），公式走
 * `src/text/similarity.ts`——全后端唯一一把尺。
 */

import { titleSim } from '../text/similarity.ts'
import type { FoldProfile } from './profiles.ts'

/** 能被归堆的最小形状。搜索 hit、站内 item 都满足它。 */
export interface Foldable {
  title: string
  url?: string
}

/** 一次并堆的理由。**每次并堆都要说得出为什么**——手动拆堆、排错、调阈值都靠它。 */
export interface Evidence {
  /**
   * 哪一档判出来的。**三档的可信度不一样，所以绝不能混成一个 kind**：前两档是算出来的
   * （链接是事实、字面共享块是证据），`semantic` 是**问模型问出来的**——它天然软一档，
   * 看的人要能一眼分清「这两条被合了」是哪一级下的判断。
   */
  kind: 'url-identity' | 'title-dice' | 'text-identity' | 'semantic' | 'audio-identity'
  score: number
  detail: string
}

/** 一个堆：代表 + 被折进来的成员 + 每次并入的理由。 */
export interface FoldGroup<T extends Foldable> {
  rep: T
  members: T[]
  why: Evidence[]
}

/**
 * URL 归一化键：去协议、去尾斜杠、host 小写，**路径原样保留**。
 *
 * 和 `mergeHitsByUrl` 是同一套口径（那边管跨腿合并，这边管归堆）。刻意不去 query 参数、
 * 不去 `www.`——再往下就会把真的不同页面并掉。路径大小写敏感，一起 lower 同理。
 */
export function urlKey(url: string | undefined): string {
  if (!url) return ''
  const bare = url.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  const slash = bare.indexOf('/')
  return slash < 0 ? bare.toLowerCase() : bare.slice(0, slash).toLowerCase() + bare.slice(slash)
}

/** 抠 host（小写）。抠不出来返回空串——**空串不等于同站**：非 http 的链接（磁力）抠不出 host，
 *  两条都抠不出来时它们并不因此就是同一个站，消费方（`worthFetchingText` / `judgeable`）拿空串
 *  当「这条根本抓不了正文」用。 */
export function hostOf(url: string | undefined): string {
  const key = urlKey(url)
  if (!key) return ''
  const host = key.split('/')[0]
  // 一个 host 至少得有个点，否则那多半根本不是链接（`不是个链接` 会整串落到这里）。
  return host.includes('.') ? host : ''
}

/**
 * 串里所有数字（去前导零）。**集号/期号/季号不同 = 一票否决**，无视标题多像。
 *
 * 这是整个判据里最重要的一条负证据：「怡乐播客-209」和「怡乐播客-210」的 Dice 高达 0.9 以上，
 * 「第3期上」和「第3期下」更是只差一个字。网盘那条线正是栽在这里（阈值 0.6 把上下集配错），
 * 那次的结论是**短串靠相似度永远分不出集号**，必须让数字自己说话。
 */
export function numberSignature(s: string): string[] {
  return (s.match(/\d+/g) ?? []).map((n) => n.replace(/^0+(?=\d)/, ''))
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

/** 「二十三」这类中文数字 → 23。只处理百以内——集号/季号超过这个量级的都用阿拉伯数字写。 */
function cnNumber(s: string): string {
  if (/^\d+$/.test(s)) return s.replace(/^0+(?=\d)/, '')
  const i = s.indexOf('十')
  if (i < 0) return String(CN_DIGITS[s] ?? s)
  const tens = i === 0 ? 1 : (CN_DIGITS[s[i - 1]] ?? 1)
  const ones = i === s.length - 1 ? 0 : (CN_DIGITS[s[i + 1]] ?? 0)
  return String(tens * 10 + ones)
}

/** 「第X季/期/集」这类序号标记。**中文数字归一到阿拉伯**——「第二季」和「第2季」是同一季。 */
const ORDINAL_RE = /第\s*([0-9零一二两三四五六七八九十]+)\s*([季期集部章回卷篇话讲])/g
/** 分卷标记：同一期被切成两半时的那个字。只认**结尾**位置，避免误伤正文里的「上」「下」。 */
const VOLUME_RE = /([上中下])(?:集|篇|部|半)?\s*$/

/**
 * 一条标题的**序列身份**：数字 + 第X季/期 + 上/下。两条的序列身份对不上 → 一票否决。
 *
 * 为什么不能只靠数字：「第二季」和「第三季」一个阿拉伯数字都没有，Dice 却高到 0.86——
 * 光靠相似度它们必并。中文数字必须和阿拉伯数字归到同一个签名里，否则同一部剧的两季
 * 会被折成一条，而这正是用户最不能忍的那种错（他要找的那一季被藏起来了）。
 */
export function serialSignature(s: string): string[] {
  const out = numberSignature(s)
  for (const m of s.matchAll(ORDINAL_RE)) out.push(`${m[2]}:${cnNumber(m[1])}`)
  const vol = VOLUME_RE.exec(s.trim())
  if (vol) out.push(`卷:${vol[1]}`)
  return out
}

/** 两条的序列身份是不是冲突。一边完全没有序号 → 不冲突（标题本来就不带号）。 */
export function serialConflict(a: string, b: string): boolean {
  const sa = serialSignature(a)
  const sb = serialSignature(b)
  if (sa.length === 0 || sb.length === 0) return false
  return sa.slice().sort().join(',') !== sb.slice().sort().join(',')
}

/**
 * 站名尾巴：搜索结果里同一篇稿子常被各站加上自己的招牌（`… - The Verge`、`…_新浪科技`）。
 *
 * 不剪掉它，跨站转载的 Dice 会被这几个字压到阈值以下——实测 `Apple Unveils M6 Chip - The Verge`
 * 对 `Apple unveils M6 chip` 只有 0.81，本该并的并不上。
 *
 * **只剪短尾巴、只认带空格的分隔符**：`GPT-6` 里的连字符没有空格，不会被误伤；尾巴超过 24 字
 * 多半是标题本身的一部分，不动。
 */
function stripSiteSuffix(s: string): string {
  const m = /^(.*\S)\s*(?:\s[-–—|]\s|_)\s*(\S.{0,23})$/.exec(s.trim())
  return m ? m[1] : s
}

/** 比标题前的归一：剪站名尾巴 → 小写 → 去掉标点和空白（书名号、破折号这些不承载身份）。 */
export function foldTitle(s: string): string {
  return stripSiteSuffix(s)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

/**
 * 这一对的「标题像」要不要等第 2 档抓正文确认。**同站才要**。
 *
 * 同站（搜狐号/百家号/网易号这类一个域名下无数个发布者的平台）上最常见的形态是
 * **同一个栏目天天更新、标题只换日期**：实测搜狐两天的「每日一练｜时事政治模拟题」
 * Dice 0.857，越过 0.85 阈值，题目却完全不同——而 `serialConflict` 挡不住它，
 * 标题里根本没有任何号可数。跨站没有这种连载形态，标题像就直接合（免费的那一档就该
 * 免费判完）。
 *
 * 抠不出 host 的（磁力、非 http）不算同站——两条都抠不出来时它们并不因此就是同一个站。
 *
 * 判成「要确认」的一对在第 1 档各自成堆，**自然流到第 2 档**（`worthFetchingText`
 * 不设标题相似度下限），不需要另造一条确认通路。
 */
export function titleNeedsTextConfirm(a: Foldable, b: Foldable, profile: FoldProfile): boolean {
  if (!profile.sameHostTitleNeedsText) return false
  const ha = hostOf(a.url)
  return ha !== '' && ha === hostOf(b.url)
}

/**
 * 这两条是不是同一件事。是 → 返回证据；不是 → `null`。
 *
 * 证据器按**从硬到软**排：同一个 URL 是事实，标题相似只是推断。硬证据命中就不再往下问——
 * 同 URL 的两条标题再不像也是同一个页面（搜索引擎给同一页配不同标题很常见）。
 */
export function sameStory(a: Foldable, b: Foldable, profile: FoldProfile): Evidence | null {
  const ka = urlKey(a.url)
  if (ka !== '' && ka === urlKey(b.url)) {
    return { kind: 'url-identity', score: 1, detail: `同一个链接：${ka}` }
  }

  // 集号/期号/季号/上下集对不上 → 一票否决，不管标题多像。**同站也照判**：
  // 百家号/搜狐号/网易号是「一个域名、无数个发布者」，转载最密的地方恰好都在站内，
  // 而「同一系列的两集」由上面这道序列身份否决挡着，不需要再叠一道同站禁并。
  if (serialConflict(a.title, b.title)) return null

  const score = titleSim(foldTitle(a.title), foldTitle(b.title))
  if (score < profile.titleThreshold) return null
  // 同站的「标题像」只是疑似，交给第 2 档比正文（上面那条 `url-identity` 不受影响：
  // 同一个链接是事实，不需要确认）。
  if (titleNeedsTextConfirm(a, b, profile)) return null
  return { kind: 'title-dice', score, detail: `标题几乎一样（${score.toFixed(2)}）：${b.title}` }
}

/**
 * 归堆。**并查集式而不是逐对**：A~B、B~C 但 A≁C 时三条要进同一堆——
 * 逐对判会把 C 单独留下，于是同一件事还是占两格。
 *
 * 代表取**输入序里最靠前的那条**：搜索这一档的输入序就是相关性序（Google 排前），
 * 没有比它更好的先验。档 B（收件箱）要换成「正文最全 / 首发最早」，那是它自己档的事，
 * 到时候把选代表抽成 profile 的一格。
 *
 * 堆之间也按代表的输入位置排——**不重排结果**。折叠是要少看几条重复，不是要换个顺序。
 */
export function fold<T extends Foldable>(items: T[], profile: FoldProfile): Array<FoldGroup<T>> {
  const groups: Array<FoldGroup<T>> = []
  for (const item of items) {
    let landed = false
    for (const g of groups) {
      // 和堆里**任意一条**像就算进这个堆（传递性）。
      const hit = sameStory(g.rep, item, profile) ?? g.members.map((m) => sameStory(m, item, profile)).find(Boolean)
      if (hit) {
        g.members.push(item)
        g.why.push(hit)
        landed = true
        break
      }
    }
    if (!landed) groups.push({ rep: item, members: [], why: [] })
  }
  return groups
}
