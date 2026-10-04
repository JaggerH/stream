/**
 * 快消品（纸巾、洗衣液、猫粮……）那一档的两件事：**规格解析**和**按点名聚合**。
 *
 * 为什么需要它，一句话：**横评说品牌，全集是 SKU，两边差着一级粒度。**
 * 活体 2026-09-04（run 98c45f5d）跑「纸巾」，枚举回来 86 台全是
 * `洁柔粉Face 3层110抽*24包` 这样的 SKU，横评点名的却是 `维达` / `清风` / `洁柔` 这样的
 * 裸品牌——27 个点名全部落进 unmatched，86 台全部 `no_mention`，`named` 恒 0，
 * 斩杀线整个跑不起来。看起来像"横评不提这些牌子"，实际是我们把名字问成了另一个东西。
 * （同一个病手机那边也犯过一次，那次要剥的是容量后缀，见 `universe-catalog.ts` 的 `baseModelName`。）
 *
 * 两件事其实是一件：聚到品牌之后，"这个牌子多少钱"只有换算成**单位价**才有意义——
 * 否则 3 包装 ¥12 会斩掉 24 包装 ¥45，而支配运算照跑不误、没有一处会报错。
 */
import { modelIdentity } from '../search/domains/catalog.ts'

/** 一个 SKU 拆出来的三格。`unit` 已归一（张→抽）。 */
export interface UnitSpec {
  /** 产品线名 = SKU 名去掉规格串。`洁柔粉Face 3层110抽*24包` → `洁柔粉Face`。 */
  line: string
  /** 总量 = 每包数量 × 包装数。**层数不算在内**（那是厚度）。 */
  quantity: number
  unit: string
}

/**
 * 「张」和「抽」是同一件东西的两种叫法（一抽抽出来就是一张，多层算一张）。
 * **不归一的代价**：同一批货被判成两种不可比的单位，一半候选被踢出比较，
 * 而回执只会说"单位对不上"——看起来像数据问题，实际是我们自己造的。
 */
const UNIT_ALIAS: Record<string, string> = { 张: '抽', 抽: '抽', 卷: '卷', 克: '克', g: '克', ml: '毫升', 毫升: '毫升' }

/** 包装量词——它后面的数字是**乘数**，不是数量本身。 */
const PACK = '包|提|箱|条|袋|卷'

/**
 * 规格串：`<每包数量><单位>` 后面可选 `*<包装数><量词>`。
 *
 * **`层` 不在 UNIT_ALIAS 里，也不该在**——`3层110抽*24包` 若把 3 乘进去就是 7920 抽，
 * 一件贵三倍的东西看起来更便宜。这是这个文件里最容易犯且最安静的一个错。
 */
const SPEC_RE = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*(张|抽|卷|克|g|ml|毫升)\\s*(?:[*x×]\\s*(\\d+)\\s*(?:${PACK})?)?`,
  'i',
)

/** 只有量词没有单位的那种：`10卷`、`6提`。量词自己就是单位。 */
const BARE_PACK_RE = new RegExp(`(\\d+)\\s*(${PACK})(?![\\d])`)

/**
 * **没有数字的包装词**——「整箱装」「整箱」「箱装」「整提」。它说明这个 SKU 是一箱/一提，
 * 但**箱里有几包，名字里没写**。
 *
 * 遇到它必须判"用量未知"，**不许按一包算**：活体 2026-09-04 的第一份结果就是这么错的——
 * 「得宝Tempo 3层90抽无香抽纸整箱装 ¥18.1」被算成 90 抽 → 20.11 元/百抽，而抽纸的正常
 * 量级是 1–3 元/百抽（同轮洁柔 ¥45/2640抽 = 1.70），**差一个数量级**。这个数不报错、
 * 不缺失，就是安静地错，而它是整个支配运算的 x 轴。
 */
const BARE_CASE_RE = /(?<![0-9])(?:整箱装?|箱装|整提)/

export function parseUnitSpec(name: string): UnitSpec | null {
  const raw = name.trim()
  if (!raw) return null
  // 先判这一条：名字说了"一箱"却没说箱里几包 → 用量推不出来。**宁可判不出，也不要给一个
  // 像模像样的错数**——调用方会把它记成 unit_mismatch 并如实说清，而不是让它进支配运算。
  if (BARE_CASE_RE.test(raw) && !/[*x×]\s*\d/.test(raw)) return null

  const m = SPEC_RE.exec(raw)
  if (m) {
    const per = Number(m[1])
    const unit = UNIT_ALIAS[m[2].toLowerCase()] ?? m[2]
    const packs = m[3] ? Number(m[3]) : 1
    if (!Number.isFinite(per) || per <= 0 || !Number.isFinite(packs) || packs <= 0) return null
    const line = lineNameOf(raw, m.index)
    return line ? { line, quantity: per * packs, unit } : null
  }

  const p = BARE_PACK_RE.exec(raw)
  if (p) {
    const n = Number(p[1])
    if (!Number.isFinite(n) || n <= 0) return null
    const line = lineNameOf(raw, p.index)
    return line ? { line, quantity: n, unit: UNIT_ALIAS[p[2]] ?? p[2] } : null
  }
  return null
}

/**
 * 产品线名 = 规格串**之前**那一段，再把紧挨着它的层数（`3层`）一起剥掉。
 *
 * 切完是空的就返回空串（调用方判 null）——电商标题里规格常摆在最前面
 * （`6提悬挂式6000张…`）。**宁可判不可解析，也不要造一个空名字的候选**混进支配运算。
 */
function lineNameOf(raw: string, specAt: number): string {
  return raw
    .slice(0, specAt)
    .replace(/\d+\s*层\s*$/, '')
    .replace(/[\s,，、/／+\-*x×]+$/i, '')
    .trim()
}

/** 每**百**单位的价格（元/百抽）。用百作分母纯粹因为人读起来顺，1.70 比 0.017 好比较。 */
export function unitCost(price: number, quantity: number): number {
  return (price / quantity) * 100
}

/**
 * 按横评的点名把全集聚起来。**词表就是横评自己**——不硬编码品牌表。
 *
 * 为什么不用品牌表：那又是一份"名字里带限定词的名单"，加一个品类就要记得加一行，
 * 而漏了不会报错，只会让那个品类静静地 `named: 0`（本仓库同一形状的错撞过五次）。
 * 拿横评抽出来的原文当词表则是自适应的：横评说什么粒度，候选就是什么粒度。
 * 手机那边横评说 `vivo X300`、全集里就有 `vivo X300`，在上游第一道精确匹配就命中了，
 * **根本走不到这里**——所以这个改动碰不到已经跑通的那条路。
 *
 * 副作用是白拿的：抽取端的噪声（活体里混进来的小红书昵称 `鱼眉`/`预约鸦鸦`/`寄语`）
 * 认领不到任何 SKU，自动出局，不需要维护一份噪声词表。
 */
/**
 * 一个聚合候选（`洁柔`）派谁去比价。
 *
 * **不能对每个成员都真比一次价**：活体那一轮 86 个 SKU 聚成十来个品牌，逐个比价就是 86 次
 * 网络往返。所以用枚举时顺带拿到的 `listPrice` 先**选出单位价最低的那个 SKU**，只对它做一次
 * 真比价——和产品库直查那边「同一台机多个容量档取最低价」是同一个口径（那是"这台机的入场价"，
 * 这是"这个牌子的入场单位价"）。
 *
 * **单位混了要按多数派切**：同一个牌子既有抽纸（抽）又有卷纸（克），把它们放进同一个
 * min 里比就是拿 1.7 元/百抽 和 0.3 元/百克 比大小——两个数都对，比较毫无意义。
 */
export function pickRepresentative(
  members: Array<{ model: string; listPrice?: number }>,
): { model: string; spec: UnitSpec } | null {
  const parsed = members
    .map((m) => ({ model: m.model, listPrice: m.listPrice, spec: parseUnitSpec(m.model) }))
    .filter((m): m is { model: string; listPrice: number; spec: UnitSpec } => m.spec !== null && typeof m.listPrice === 'number')
  if (parsed.length === 0) return null

  const byUnit = new Map<string, typeof parsed>()
  for (const p of parsed) byUnit.set(p.spec.unit, [...(byUnit.get(p.spec.unit) ?? []), p])
  const majority = [...byUnit.values()].reduce((a, b) => (b.length > a.length ? b : a))

  const best = majority.reduce((a, b) =>
    unitCost(b.listPrice, b.spec.quantity) < unitCost(a.listPrice, a.spec.quantity) ? b : a,
  )
  return { model: best.model, spec: best.spec }
}

/**
 * 从**真实报价行**里挑单位价最低的那一条。
 *
 * 这是快消品比价的正确形状，`pickRepresentative`（事先按 listPrice 猜一个代表 SKU 再拿它的
 * 全名去比价）是错的，活体 2026-09-04（run 82779f12）三条证据：
 *  · 代表被选成长尾促销款——「得宝一博同款…家庭囤货装」「清风敦煌文创联名…BG28ASJIP」，
 *    因为判据是"单位价最低"，而最低价往往正是这种联名/囤货促销；
 *  · 拿这种长串去比价，回来的几乎全是**历史优惠**（清风只回 3 行、全是已结束）；
 *    对照：问品牌名 `洁柔` 回 20 行、多数现售。
 *  · 更根本的是**用量和价格来自两个不同的东西**——代表 SKU 的规格配上另一行的报价。
 *
 * 所以反过来：问品牌，然后**每一行自己说自己有多少**（在售标题天然带规格，
 * 「洁柔 Face柔韧3层抽纸 110抽×24包」），逐行算单位价取最低。用量与价格来自同一行，
 * 而且那一行就是用户真能点进去买的东西。
 *
 * 单位仍按多数派切（元/百抽 和 元/百克 比大小毫无意义）。
 */
export function pickCheapestByUnit(
  rows: Array<{ title?: string; amount?: number }>,
  /** 这个候选在枚举时观察到的一个真实整包价，用作行数太少时的兜底锚。没有就不用。 */
  anchor?: number,
): { amount: number; spec: UnitSpec; title: string } | null {
  const parsed = rows
    .map((r) => ({ amount: r.amount, title: r.title ?? '', spec: r.title ? parseUnitSpec(r.title) : null }))
    .filter((r): r is { amount: number; title: string; spec: UnitSpec } =>
      r.spec !== null && typeof r.amount === 'number' && Number.isFinite(r.amount) && r.amount > 0)
  if (parsed.length === 0) return null

  const byUnit = new Map<string, typeof parsed>()
  for (const p of parsed) byUnit.set(p.spec.unit, [...(byUnit.get(p.spec.unit) ?? []), p])
  const majority = [...byUnit.values()].reduce((a, b) => (b.length > a.length ? b : a))

  // **取最小之前先剔掉垃圾行。** 比价行里混着促销文案的碎数字（"省9.11元"、"1元凑单"），
  // 而抠价是"取这一行的第一个数"——不筛就必然是**最小的那个垃圾赢**。
  // 活体 2026-09-04（run 697b07e2）：得宝取到 ¥1 的「黄油小熊联名」行 → 0.21 元/百抽，
  // 而抽纸正常是 1–3。这道闸原先由 listPrice 价格带担着，快消品档去掉那道带子时
  // （包装规格横跨一个数量级，带子会把大包装全切掉）**没有把它防的东西一起换掉**。
  //
  // 判据必须**自锚定**：硬编码"纸巾多少钱算正常"对洗衣液、猫粮就是错的。所以拿这一批行
  // **自己的单位价中位数**当锚，低于中位数 1/4 的判为垃圾。行数太少（中位数不稳）时，
  // 退到枚举时观察到的那个整包价做一个宽松下限。
  const costs = majority.map((p) => unitCost(p.amount, p.spec.quantity)).sort((a, b) => a - b)
  const median = costs[Math.floor(costs.length / 2)]!
  const sane = majority.filter((p) => {
    const c = unitCost(p.amount, p.spec.quantity)
    if (majority.length >= MIN_ROWS_FOR_MEDIAN) return c >= median / OUTLIER_RATIO
    return anchor === undefined || p.amount >= anchor * LONE_ROW_FLOOR
  })
  // 全被剔光说明这一批行整体不可信（比如只有一行且远低于锚），如实返回 null——
  // 调用方会记成 no_price 并说清，而不是硬拿一个买不到的价去排名。
  if (sane.length === 0) return null

  return sane.reduce((a, b) =>
    unitCost(b.amount, b.spec.quantity) < unitCost(a.amount, a.spec.quantity) ? b : a,
  )
}

/** 少于这个行数就不信中位数（两行的"中位数"就是其中一行）。 */
const MIN_ROWS_FOR_MEDIAN = 3
/** 低于中位数这个倍数的单位价判为垃圾行。4 = 宽松：真促销打到 1/4 价的很少，碎数字则常差一两个量级。 */
const OUTLIER_RATIO = 4
/** 行数不足时的兜底：整包价不得低于枚举观察价的这个比例。0.2 很松（小包装 vs 整箱本就差几倍）。 */
const LONE_ROW_FLOOR = 0.2

export function foldByMention(universe: string[], mentions: string[]): Map<string, string[]> {
  const idx = universe.map((u) => ({ name: u, id: modelIdentity(u) }))
  const out = new Map<string, string[]>()
  for (const raw of mentions) {
    // 横评爱写「维达（Vinda）」「洁柔（C&S）」这种中英并列，而在售的 SKU 上只有中文名。
    // 活体 2026-09-04 那一轮：`维达` 裸名聚上了、`维达（Vinda）` 没聚上，**同一个牌子
    // 因为写法不同被算成两个东西**，一个进了候选、一个留在 unmatchedRaw 里。
    // 所以两种写法都试：原样，再剥掉括号注释。
    for (const cand of [raw, stripParenthetical(raw)]) {
      const key = modelIdentity(cand)
      if (!key) continue
      const members = idx.filter((u) => u.id.includes(key)).map((u) => u.name)
      if (members.length > 0) {
        out.set(raw, members)
        break
      }
    }
  }
  return out
}

/** 「维达（Vinda）」→「维达」。中英文括号都算。 */
function stripParenthetical(s: string): string {
  return s.replace(/[（(][^）)]*[）)]/g, '').trim()
}
