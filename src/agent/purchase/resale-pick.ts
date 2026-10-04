/**
 * 残值这一格的两件事：**对名**（从回收平台回来的行里挑出"就是这台"）与**选代**（持有 N 天后
 * 的残值，用同系列上 N 代机型**今天**的回收价当代理）。
 *
 * 为什么不拿第一行：回收平台的搜索自带型号归一——「一加 Ace 6」回 Ace 6 / Ace 6T / Ace 6 至尊版 /
 * Ace 5，「红米 Turbo 5」回 Turbo 5 / Turbo 5 Max，第一行常常不是问的那台（实测 2026-09-03）。
 * 拿错一行不会报错，只会把 Max 版的价安到标准版头上，然后支配关系错得毫无征兆。
 *
 * 为什么要选代：平台只报**今天、最好机况**的价。一台国补后 1511 买入、今天回收 1530 的机器，
 * 按今天的价算持有两年的日均成本是 0——数字没错，答的不是"用两年再卖"这个问题。没有任何来源给
 * "两年后的回收价"，最近的代理是**同系列上两代今天值多少**：它已经被市场折了两年，而且同一次
 * 查询就带回来。命名不规整的系列会对不上，那就如实退回"按买入价"（job 的 purchase_only 档）。
 */
import type { ResidualInfo } from './job.ts'
import { priceOf } from '../search/domains/catalog.ts'

export interface ResaleRow {
  title?: string
  /** 价格行，如「最高回收价 ¥3060｜vivo · 手机」。第一个数字就是价。 */
  excerpt?: string
  /** 哪个平台（author / source_id）。 */
  source?: string
}

/**
 * 品牌别名：全集（ZOL）叫「真我 Neo7 Turbo」「Redmi Turbo 5 MAX」，转转叫「realme Neo7 Turbo」
 * 「红米 Turbo 5 Max」——同一台机两种写法，活体一轮 4 台里 3 台就是这么对丢的（2026-09-03）。
 * 对名前把别名折成一个规范 token。只收品牌，不收型号词（Max / Pro 这种后缀恰恰是要区分的）。
 */
const BRAND_ALIASES: Array<[canonical: string, aliases: string[]]> = [
  ['realme', ['真我']],
  ['redmi', ['红米']],
  ['xiaomi', ['小米']],
  ['oneplus', ['一加']],
  ['honor', ['荣耀']],
  ['huawei', ['华为']],
  ['apple', ['苹果']],
  ['samsung', ['三星']],
  ['meizu', ['魅族']],
  ['nubia', ['努比亚']],
  ['motorola', ['摩托罗拉', 'moto']],
  ['lenovo', ['联想']],
]

const norm = (s: string) => {
  let t = s.toLowerCase()
  for (const [canonical, aliases] of BRAND_ALIASES) {
    for (const a of aliases) t = t.split(a.toLowerCase()).join(canonical)
  }
  // **括号注释要剥掉**：横评和聚合候选爱写中英并列（`维达（Vinda）`、`得宝（Tempo）`、
  // `洁柔（C&S）`），而在售标题里是 `Vinda/维达 细韧100抽 3层S码 抽纸 6包`——同一个牌子，
  // 带括号那份永远匹配不上。活体 2026-09-04（run 82779f12）：维达那 20 行里唯一一行正确商品
  // 「Vinda/维达 细韧100抽 3层S码 抽纸 6包」被判成"不是这个",于是整个品牌 no_price。
  return t.replace(/[（(][^）)]*[）)]/g, '').replace(/[\s　·_-]+/g, '')
}

/**
 * 标题是不是「就是这台」：整串相等，或去掉标题**开头一到两个词**之后相等——来源会补品牌
 * （「vivo iQOO Z11 Turbo」）或带着老系列名（realme 把 GT Neo 系列改叫 Neo，转转仍叫
 * 「realme GT Neo6」，全集叫「真我Neo6」）。只放行前缀：后缀多一个词就是另一款。
 */
export function sameModel(model: string, title: string): boolean {
  const m = core(model)
  if (!m) return false
  const words = title.trim().split(/\s+/)
  for (let k = 0; k <= 2 && k < words.length; k++) if (core(words.slice(k).join(' ')) === m) return true
  return false
}

/** 品牌词只用来对齐，不参与对名：去掉开头的品牌 token 后剩下的才是"这台是哪台"。 */
const BRAND_PREFIXES = [...BRAND_ALIASES.map(([c]) => c), 'vivo', 'oppo']
const core = (s: string) => {
  const n = norm(s)
  for (const b of BRAND_PREFIXES) if (n.startsWith(b) && n.length > b.length) return n.slice(b.length)
  return n
}

/**
 * 判据：整串相等（去空格、大小写不敏感、品牌别名折叠）；只允许**前缀多一个词**这一种宽松，
 * 后缀多（Max / Pro / 至尊版）一律不算。多源命中时取**最高**的那一行（都是「最高回收价」口径，
 * 上限取最大的上限），出处逐个列。
 */
export function pickResaleRow(model: string, rows: ResaleRow[]): ResidualInfo | null {
  const hits = rows
    .filter((r) => r.title && sameModel(model, r.title))
    .map((r) => ({ amount: priceOf(r.excerpt), source: r.source ?? '未知来源', title: r.title!, label: String(r.excerpt ?? '').split('｜')[0]!.trim() }))
    .filter((r): r is { amount: number; source: string; title: string; label: string } => r.amount !== undefined && r.amount > 0)
  if (hits.length === 0) return null
  hits.sort((a, b) => b.amount - a.amount)
  const top = hits[0]!
  return {
    resale: top.amount,
    basis:
      // 口径跟着来源走：转转 / 爱回收的 excerpt 是「最高回收价 ¥X」（最好机况，偏低），闲鱼是「挂牌中位价 ¥X」
      // （个人卖家要价，偏高）。多源都命中取高的：用户会挑最划算的渠道出手。
      `${top.source} ${top.label || `¥${top.amount}`}` +
      (hits.length > 1 ? `；另 ${hits.slice(1).map((h) => `${h.source} ${h.label || `¥${h.amount}`}`).join('、')}` : ''),
  }
}

/** 持有多少天 → 往前数几代。半年内按今天的价（0 代），一年上下 1 代，一年半以上 2 代。 */
export function generationsBack(holdDays: number): 0 | 1 | 2 {
  if (holdDays < 183) return 0
  if (holdDays < 548) return 1
  return 2
}

/**
 * 同系列上 `back` 代的型号名。取型号里**第一个数字**当代数：`Ace 6`→5、`Neo7`→6、`Z11`→10、
 * `iPhone 17`→16；两位整十（`X80`、`K90`）按 10 一代，整百（`Y600`）按 100 一代——这是国产厂
 * 系列命名的常态（X70/X80/X90、Y500/Y600）。型号里没有数字（`iPhone Air`）→ null，让上层退回。
 * 减出非正数也 null。**这只是命名规律，不是产品事实**：`Neo7 Turbo` 减一代得 `Neo6 Turbo`，
 * 市面上未必有这台——所以它的结果必须再经 `pickResaleRow` 精确对一次，对不上就是没有。
 */
export function predecessorName(model: string, back: number): string | null {
  if (back <= 0) return model
  const m = /(\d+)/.exec(model)
  if (!m || m.index === undefined) return null
  const n = Number(m[1])
  const step = n % 100 === 0 && n >= 100 ? 100 : n % 10 === 0 && n >= 20 ? 10 : 1
  const prev = n - back * step
  if (prev <= 0) return null
  return model.slice(0, m.index) + String(prev) + model.slice(m.index + m[1]!.length)
}

const GEN_WORD = ['', '一', '两'] as const

/**
 * 上代型号名的**变体阶梯**：按命名规律推出来的名字常常不存在（「真我Neo5 Turbo」——Neo5 那一代
 * 没有 Turbo 版；「Redmi Turbo 3 MAX」——那一代没有 Max）。活体一轮 9 台只对上 3 台（2026-09-03，
 * Sonnet 试跑）。所以从推出来的名字开始，**逐个去掉代数之后的尾词**（Turbo / MAX / Pro…），
 * 退到同代的基础款：「真我Neo6 Turbo」→「真我Neo6」。配置不同，价会偏（基础款偏低、高配偏高），
 * basis 里写明退到了哪一款。代数**之前**的词不动——那是品牌和系列，动了就是另一台机。
 */
export function predecessorVariants(name: string): string[] {
  const m = /(\d+)/.exec(name)
  if (!m || m.index === undefined) return [name]
  const head = name.slice(0, m.index + m[1]!.length)
  const tail = name.slice(m.index + m[1]!.length).trim().split(/\s+/).filter(Boolean)
  // 第一代常常不带数字（「荣耀 Power」是「荣耀 Power 2」的上一代）：推到 1 时再补一个去掉数字的写法。
  const heads = m[1] === '1' ? [head, name.slice(0, m.index).trim()] : [head]
  const out: string[] = []
  for (let k = tail.length; k >= 0; k--) for (const h of heads) out.push([h, ...tail.slice(0, k)].join(' ').trim())
  return [...new Set(out.filter(Boolean))]
}

/**
 * 残值格的完整逻辑：按持有年限选代 → 逐代查回收平台 → 精确对名（对不上再退同代基础款）。
 * 往前数不到那么多代（上两代没收录、上一代有）就退一代并在 basis 里写明；**长持有不退到 0 代**
 * ——那正是"今天的价当两年后的价"这个错，宁可回 null 让 job 按买入价排。
 */
export async function resolveResidual(
  model: string,
  holdDays: number,
  search: (name: string) => Promise<ResaleRow[]>,
): Promise<ResidualInfo | null> {
  const back = generationsBack(holdDays)
  if (back === 0) return pickResaleRow(model, await search(model))
  for (let g = back; g >= 1; g--) {
    const name = predecessorName(model, g)
    // 往前数得太远推成非正数（Power2 的上两代）→ 这一代没有，试下一代；型号里根本没数字才是真的没法推。
    if (!name) { if (!/\d/.test(model)) return null; continue }
    for (const variant of predecessorVariants(name)) {
      const hit = pickResaleRow(variant, await search(variant))
      if (!hit) continue
      return {
        resale: hit.resale,
        basis:
          `${hit.basis}——取的是同系列上${GEN_WORD[g]}代 ${variant} 的今日回收价，当作 ${model} 持有 ${holdDays} 天后的残值代理` +
          (variant !== name ? `（那一代没有 ${name} 这一款，退到了 ${variant}，配置不同价会偏）` : '') +
          (g < back ? `（上${GEN_WORD[back]}代没收录，退了一代，会偏高）` : ''),
      }
    }
  }
  return null
}


/** 兄弟款后缀：型号后面紧跟这些词就是另一款（Pro / Max / 至尊版 / 6T…），不是这台。 */
const SIBLING_SUFFIX = /^(pro|max|ultra|plus|\+|至尊|turbo|活力|青春|竞速|mini|prime|neo|gt|se|rt|[a-z])(?![a-z])/

/**
 * 比价行的标题是不是**这台**的报价。比价源回的是长 SKU 串（「REDMI 红米 K80 至尊版 手机 天玑9400
 * 砂岩灰 12 512G」），`sameModel` 那种整串相等对不上，所以这里是包含匹配 + 兄弟款排除：
 * 归一化后标题里得有型号核心，而且**紧跟在后面的不能是数字或兄弟款后缀**（「K80」不认「K800」、
 * 「K80 Pro」、「Ace 6」不认「Ace 6T」）。「5G」这种网络制式例外。
 * 活体（2026-09-03）：问「Redmi K80至尊版」回来的 62 行里混着「K80 Pro 95成新」，问「Redmi K90」
 * 回来的混着「K90至尊版」「K90max」——取最小价时兄弟款便宜的那台会顶掉本尊。
 */
export function offerTitleMatches(model: string, title: string): boolean {
  const m = core(model)
  if (!m) return false
  const n = norm(title)
  let from = 0
  while (true) {
    const idx = n.indexOf(m, from)
    if (idx < 0) return false
    const rest = n.slice(idx + m.length)
    if (rest === '' || /^[45]g/.test(rest) || (!/^\d/.test(rest) && !SIBLING_SUFFIX.test(rest))) return true
    from = idx + 1
  }
}

/** 这一行是不是**现售的新品**报价：比价源把过期优惠标成「已结束」，二手行带「95成新」之类——
 *  两种都不是今天能买到的价，取最小值时它们必然赢，于是一台机的日均成本按一个买不到的数算。 */
export function isCurrentNewOffer(title: string): boolean {
  return !/已结束|成新|二手|官翻|翻新|拆封|样机/.test(title)
}
