/**
 * 购买对比的**支配运算**与产品形状：谁被谁斩、凭什么。
 * 权威设计：docs/superpowers/specs/2026-08-23-purchase-verdict-structured-comparison-design.md
 * （形状与两根轴的定义）；`docs/research/consumption-frontier-model.md`（为什么是支配不是"最优"）。
 *
 * 这颗脑子只有一份，调用方是决策 job（`job.ts` 第 ④ 步）。它曾经也是一个独立的工具面
 * （模型手填产品、这里校验回显）——那条已拆：模型会把 job 的回执逐字段手抄进去、抄的时候
 * 把口径抄错。现在这里没有任何"给模型看的修正指令"，输入全部来自代码。
 */

export interface ProductPrice {
  platform: string
  /** 字符串不硬拆数字——"7219.02元+179.98元淘金币"这类组合价拆了就失真。 */
  price: string
  note?: string
  /** 购买链接——从比价那一行的 `url` 原样带过来,卡片把平台名渲染成可点的入口。 */
  url?: string
}

/** 一条来源:这个产品的优缺点是从哪读来的。没有它,对比卡上全是无出处断言
 *  (spec 2026-08-23-purchase-evidence-deepread §2.2)。 */
export interface ProductEvidence {
  /** 来源一句话:平台 + 作者/标题,如「B站 @某评测 保温杯20款横评」。 */
  source: string
  /** 指向该来源的链接——**必填**(用户拍板 2026-08-24:来源必须可溯)。点不过去的来源等于没有来源。 */
  url: string
  /** 该来源支撑了本产品的哪条结论(短句)。 */
  point?: string
}

/**
 * 用于比较的代价。**`prices` 是原文字符串(组合价不拆),这里是可算的那个数**——两者并存,
 * 各司其职:前者给人看,后者进支配运算。
 *
 * 两种形态**不可混用**:一次性支出和日均持有成本不是同一根轴,混在一起算出来的支配关系
 * 是错的,而且错得毫无征兆。job 里一次只产一种。
 */
export type ProductCost =
  /** 消耗品/一次性支出:残值为 0、当场用掉,比的就是这笔钱本身。 */
  | { kind: 'once'; amount: number }
  /**
   * 按**单位用量**比的消耗品(纸巾、洗衣液、猫粮…):比的是每百抽 / 每百克多少钱。
   *
   * 为什么不能用 `once` 的整包价:同一个牌子铺开几十个规格,`3 包装 ¥12` 的整包价永远低于
   * `24 包装 ¥45`,于是前者把后者斩掉——**而买回来三天就用完了**。整包价在这个品类里
   * 不是"代价",只是"一次掏多少钱"。
   */
  | {
      kind: 'unit'
      /** 代表 SKU 的实付价(元)。 */
      purchase: number
      /** 代表 SKU 的总量(如 2640)。 */
      quantity: number
      /** 归一后的单位(抽 / 克 / 毫升 / 卷)。**不同单位之间不可比**,由上游按多数派切开。 */
      unit: string
      /** 这个数是从哪个 SKU 算出来的——聚合候选(`洁柔`)本身买不到,能买的是它。 */
      sku: string
    }
  /**
   * 可周转资产:比的是**日均持有成本** `(买入价 − 残值) / 持有天数`。
   *
   * 买入价里有一部分不是消费,是**存货**——它以后还能变回钱,记成成本就是记错账。
   * 判据见 `docs/research/consumption-frontier-model.md` 第三节。
   */
  | {
      kind: 'ownership'
      /** 买入价(元)。 */
      purchase: number
      /** 转手时能拿回多少(元)。**用户不打算卖就是 0**——抽屉里躺着的旧机残值就是 0,
       *  这两档算出来的前沿形状不同,而且都是对的。 */
      resale: number
      /** 持有天数(> 0)。 */
      days: number
      /** 残值是**怎么来的**——必填。引用的保值率要写出处;查不到而按买入价算的也要写明
       *  (job 的 `residual.mode` 是整份回执的口径,这里是逐台的一句话)。 */
      basis: string
    }

export interface VerdictProduct {
  /** 具体型号含规格,如「长城世喜 夏季玻璃水 2L」。 */
  name: string
  /** 商品图——卡片列头渲染缩略图。 */
  image?: string
  prices: ProductPrice[]
  /** 可比的代价(见 `ProductCost`)。支配运算的 x 轴。 */
  cost: ProductCost
  /**
   * 体验序:1 = 最好,允许并列。支配运算的 y 轴。
   *
   * **要的是序不是分**。用户的效用函数拿不到,也不该猜;但"A 的体验不劣于 B"是能负责地说的
   * 一句话,而这正是判定支配所需的全部。给分数反而是在假装有精度。
   */
  experience_rank: number
  pros: string[]
  cons: string[]
  /** 一句话:和用户需求的契合点。 */
  fit: string
  /** ≥1 条——结论必须挂来源。 */
  evidence: ProductEvidence[]
}

/** 一条被斩的记录:谁、被谁、凭什么。`why` 由代码拼(带实测数字),不让模型编。 */
export interface DominationRecord {
  name: string
  by: string
  why: string
}

/** 归一化后的产品:多一个算出来的可比数。 */
export type NormalizedProduct = VerdictProduct & {
  /** 折算后的可比代价。`once` 档就是 amount;`ownership` 档是日均持有成本。 */
  comparable_cost: number
  /** `comparable_cost` 的单位,给卡片直接显示:'元' | '元/天' | '元/天（未扣残值）'。 */
  cost_unit: string
}

const fmtCost = (v: number, unit: string): string => `${unit.startsWith('元/天') ? v.toFixed(2) : String(Math.round(v * 100) / 100)} ${unit}`

/**
 * 支配:两根轴上都不劣,且至少一根严格优。
 *
 * **这是本模块的立身之处**:它不需要知道用户有多喜欢什么——只需要"不劣于"。所以结论
 * 可证伪(用户能自己核每一条),而"最优"是不可核对的断言。
 */
function dominates(a: NormalizedProduct, b: NormalizedProduct): boolean {
  const costNotWorse = a.comparable_cost <= b.comparable_cost
  const rankNotWorse = a.experience_rank <= b.experience_rank
  const strictlyBetter = a.comparable_cost < b.comparable_cost || a.experience_rank < b.experience_rank
  return costNotWorse && rankNotWorse && strictlyBetter
}

/** 逐对比一遍。被多个候选支配时,记**最便宜**的那个斩杀者(读起来最有说服力)。 */
export function computeDomination(products: NormalizedProduct[]): { dominated: DominationRecord[]; frontier: string[] } {
  const dominated: DominationRecord[] = []
  const frontier: string[] = []
  for (const b of products) {
    const killers = products.filter((a) => a.name !== b.name && dominates(a, b))
    if (killers.length === 0) {
      frontier.push(b.name)
      continue
    }
    const killer = killers.reduce((m, k) => (k.comparable_cost < m.comparable_cost ? k : m))
    const cheaper = killer.comparable_cost < b.comparable_cost
    const better = killer.experience_rank < b.experience_rank
    const costPart = cheaper
      ? `代价更低(${fmtCost(killer.comparable_cost, killer.cost_unit)} vs ${fmtCost(b.comparable_cost, b.cost_unit)})`
      : `代价持平(${fmtCost(b.comparable_cost, b.cost_unit)})`
    const expPart = better ? '体验也更好' : '体验不落下风'
    dominated.push({ name: b.name, by: killer.name, why: `${costPart},${expPart}——两个维度都不占优,不必再考虑。` })
  }
  return { dominated, frontier }
}
