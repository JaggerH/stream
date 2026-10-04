/**
 * 购买决策 job：**路线归代码，模型只站窄口**。
 * 权威设计 `docs/superpowers/specs/2026-09-02-purchase-decision-job-design.md`。
 *
 * 这个模块存在的理由，一句话：这条路线以前住在一段约 600 词的英文 `next_steps` 里，把九步
 * 交给模型自觉执行。**提示词是请求，不是约束**：模型跳过终态工具直接写散文的活体证据记在
 * `2026-09-01-candidate-set-discovery-design.md` §5。所以阶段被搬进这里，顺序在代码里，
 * 跳步在结构上不成立。**工具面上只有 `purchase_decide` 这一个入口**——手工组装终稿的那两个
 * 旧工具已拆：留着它们，模型就会把这份回执逐字段手抄一遍进去，抄的时候把"残值查不到"
 * 补成"残值按 0 计"（2026-09-03 活体）。
 *
 * ```
 * ① 枚举全集    硬约束直查              零 LLM   deps.universe
 * ② 软条件信号  横评里谁被点名           关节 B   deps.signal
 * ③ 逐台取数    价格 / 残值              零 LLM   deps.price / deps.residual
 * ④ 支配运算    日均持有成本 → 前沿      纯代码   verdict.computeDomination（复用，不另写）
 * ⑤ 回执        前沿 + 淘汰 + 覆盖 + 缺口 纯代码
 * ```
 *
 * ④⑤ 之间没有模型的位置——终稿是 job 的最后一步，不是「它记得调的工具」。
 */
import { computeDomination, type DominationRecord, type NormalizedProduct } from './verdict.ts'
import type { SignalMention, SignalResult } from './signal.ts'
import { isCurrentNewOffer, offerTitleMatches } from './resale-pick.ts'
import { foldByMention, pickRepresentative, pickCheapestByUnit, unitCost, type UnitSpec } from './spec-parse.ts'

export interface DecisionConstraints {
  /** 品类词，如 ['手机']。 */
  category: string[]
  priceRange: { min?: number; max?: number }
  /** 软条件，如 ['拍照']。空 = 不筛，仅按价格枚举。 */
  softCriteria: string[]
  /** 打算持有多少天。**由用户给，不猜**——它是 x 轴的分母。 */
  holdDays: number
  /**
   * 到期会不会真的转手。**答「不会」是合法答案且会改变结论**：残值即 0，
   * 也不需要去查保值率（`docs/research/consumption-frontier-model.md` 第三节）。
   * 答「会」而残值查不到时**不装死**——退到按买入价比，并在回执里大声说明（见 `residual`）。
   */
  willResell: boolean
}

/** 全集里的一台。`price` 是枚举源顺带给的参考价（列表页上的那个数）。 */
export interface UniverseModel {
  model: string
  listPrice?: number
  url?: string
  image?: string
}

export interface ReviewItem {
  id: string
  title: string
  url: string
  platform?: string
}

/** 逐台取数的并行上限。3 = 慢慢买每台 2 页 × 3 台 ≈ 6 个在飞的请求，实测 12 并发才开始回空壳。 */
export const PRICE_CONCURRENCY = 3

/** 有界并行 map，结果按输入顺序。 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** 借同伴保值率估残值，至少要这么多台实测。1 台的保值率不是「同档水平」。 */
export const MIN_RESIDUAL_PEERS = 2

export interface PriceRow {
  platform: string
  /** 比价行的商品标题——用来判「是不是这台的现售新品」；没有就不判（只按价格带筛）。 */
  title?: string
  price: string
  /** 可算的那个数。取不到就没有——**别拿 0 顶替**。 */
  amount?: number
  url?: string
}

export interface ResidualInfo {
  /**
   * 这台**今天**能卖的钱（元，绝对值）——回收平台的「最高回收价」或二手挂牌价。
   * 是**上限**：最好机况、今天的行情；用户真到 holdDays 之后转手只会更低。job 不替来源
   * 折旧（那是编数），只把它和买入价一起摆出来，并在 `basis` 里说清是上限。
   */
  resale: number
  /** 这个数怎么来的（哪个平台、什么口径）。必填——转述的数字不写出处会被当成实测值读。 */
  basis: string
}

/** 没能进前沿计算的一台，连同**为什么**。空着不说等于假装它不存在。 */
export interface UnrankedModel {
  model: string
  /** `unit_mismatch`：这一轮按单位价比（快消品），而它的单位对不上或规格解析不出用量。
   *  **和 `no_price` 分开**——两者在回执里长得一样的话，"单位不可比"会被读成"买不到"。 */
  reason: 'no_mention' | 'no_price' | 'unit_mismatch'
  detail: string
}

/**
 * 残值这一格是怎么处理的。**它是回执的一等字段，不是 basis 里的一句备注**：活体里模型把
 * 「查不到残值」讲成了「系统默认残值为 0」——两句话意思相反，而它只看了几个字段名就脑补了。
 *
 * - `none`：用户说不转手，残值就是 0，这一档本来就对。
 * - `known`：每台都查到了保值率，日均持有成本是真的。
 * - `purchase_only`：用户要转手、但残值来源没接上（或有的台查不到）。**不装死也不编数**：
 *   照样给出按买入价的排名，但整份回执明说"这不是持有成本的前沿"。上一版把这些台全部
 *   踢出比较，结果是前沿为空、模型手里没东西可交，只能拿一桌问题填空。
 */
export interface ResidualHandling {
  mode: 'none' | 'known' | 'purchase_only'
  /** 人话，给模型原样转述。 */
  note: string
}

/**
 * 这一轮的**买入价**是从哪儿来的。和 `ResidualHandling` 同一个模式、同一条纪律：
 * **口径全体统一，不逐台混用**——一台用比价的实付价、另一台用列表页的标价，两个数不在
 * 同一根轴上，而支配运算照跑不误、没有一处会报错。
 *
 * - `compared`：走比价源拿到的实付价（默认，也是最强的一档）。
 * - `listing`：**整轮**退到枚举时那个列表页价。只在比价对**所有**候选都空手时启用。
 *   这不是编数：发现循环抽候选时就是从在售页面配对出「型号↔价格」的，且 catalog 域的
 *   check 用 `price_search` 验过"真在售、价格在区间内"。但它是**标价不是到手价**，
 *   所以必须在回执里说出来，别让人当成实付。
 */
export interface PricingHandling {
  mode: 'compared' | 'listing'
  note: string
}

export interface DecisionDeps {
  /**
   * ① 枚举全集。`truncated` = 这份清单是残的（分页没走完 / 上游截断）。
   *
   * `onProgress` 是**每轮**的，所以走参数传、**不许在装配期闭包进去**（装配期取的值 =
   * 冻住的答案）。发现循环那一档能跑近 8 分钟，没有它外面只看得见一句「枚举全集」，
   * 连"是不是卡住了"都判不了。
   */
  universe: (c: DecisionConstraints, onProgress?: (note: string) => void) => Promise<{
    models: UniverseModel[]
    source: string
    truncated: boolean
    /** 枚举过程里的失败说明（哪一档、为什么）。**不是可选的装饰**：只给一个 truncated
     *  布尔的话，回执说得出"清单是残的"却说不出为什么，排查时手里只剩一个 0。 */
    errors?: string[]
    /**
     * 这个源给的 `listPrice` **是不是验过"真在售、价格在区间内"**。默认 false。
     *
     * 它决定比价整轮空手时能不能退到 listPrice（见 `PricingHandling`）。**判据只有生产方
     * 知道，不许由 job 猜**：产品库直查那档给的是目录标价（recipe 只翻 3 页，没验在售，
     * 与街价还差着一个折扣），拿它顶替就是把一次真实的取数失败洗成一份看着挺像样的前沿；
     * 发现循环那档的每个候选都被 catalog 域的 check 用 `price_search` 验过，是另一回事。
     */
    listPriceVerified?: boolean
  }>
  /** ② 找横评。 */
  reviews: (c: DecisionConstraints) => Promise<ReviewItem[]>
  /** ② 关节 B：读一篇，抽出落在全集里的点名。 */
  signal: (review: ReviewItem, universe: string[], c: DecisionConstraints) => Promise<SignalResult>
  /** ③ 取价。 */
  /** 比价。回 `{ rows, warnings }` 时 warnings 是**没答上来的成员**（超时 / 挂了），0 行时进 gaps——
   *  否则「源挂了」和「这台真没人卖」在回执里长得一样（活体：K90 上一轮有价、下一轮 no_price，无从判）。 */
  price: (model: string) => Promise<PriceRow[] | { rows: PriceRow[]; warnings: string[] }>
  /** ③ 取保值率。`willResell` 为 false 时**不会被调用**。 */
  /**
   * 残值：这台持有 holdDays 之后大概能卖多少。来源只报**今天**的价，所以 holdDays 进来是让来源
   * 自己选代理（按持有年限取上一代 / 上两代同系列的今日回收价，见 `resale-pick.ts`）。
   */
  residual: (model: string, holdDays: number) => Promise<ResidualInfo | null>
  /**
   * 阶段进度（人话一句）。job 跑两三分钟，调用方是异步轮询的——没有这条，超时之后只知道
   * "没回来"，不知道卡在枚举 / 读横评 / 比价的哪一步。可选：直调（测试）不需要它。
   */
  onStage?: (stage: 'universe' | 'reviews' | 'signal' | 'price' | 'result', note: string) => void
}

export interface DecisionCoverage {
  /** 全集多大。 */
  universe: number
  /** 其中被横评为软条件点名的有几台。 */
  named: number
  /** 横评提到、但不在全集里的条数（逃生项）——**全集抓漏没有的唯一线索**。 */
  unmatched: number
  /** 越界被事后校验丢掉的条数。>0 说明 enum 那道闸漏了，值得看一眼。 */
  droppedMentions: number
  /** 读了几篇横评 / 一共找到几篇。 */
  reviewsRead: number
  reviewsFound: number
  priced: number
  residualKnown: number
  /** 回收平台查不到上一代、按同档最保守保值率估出来的台数（见 `MIN_RESIDUAL_PEERS`）。不计入 residualKnown。 */
  residualEstimated: number
  /** 枚举没找着、靠横评点名回灌进来的台数（见 `seeded` legend）。>0 ⇒ `stopped` 必为 truncated。 */
  seeded: number
  /**
   * `complete` 全集与读取都跑完；`truncated` 枚举源自己说清单是残的；
   * `interrupted` 中途出错但已攒下的照常交货。
   * **一次 truncated 的跑不许被讲成「市面上就这些」。**
   */
  stopped: 'complete' | 'truncated' | 'interrupted'
}

export interface DecisionReceipt {
  constraints: DecisionConstraints
  universeSource: string
  /** 进了支配运算的那些，带算出来的日均持有成本与体验序。 */
  products: NormalizedProduct[]
  frontier: string[]
  dominated: DominationRecord[]
  /** 没进比较的**举例**，每种原因最多几条——精确数字看 `unrankedCounts`。
   *  **不逐条列全**：一次 277 台的枚举里有 268 台没被点名，全列出来会把回执撑爆，
   *  而工具结果一被截断，**最要紧的 frontier/dominated 恰好在后面被切掉**
   *  （活体撞到过：模型说"完整的 frontier 没有可核对地呈现"，于是拒绝下结论）。 */
  unranked: UnrankedModel[]
  /** 每种原因各有多少台——**这才是那个数**，举例只是让人看得见长什么样。 */
  unrankedCounts: Record<UnrankedModel['reason'], number>
  /** 提到了但不在全集里的原文写法（去重，最多 20 条；精确条数在 `coverage.unmatched`）。 */
  unmatchedRaw: string[]
  /** 因缺字段被丢的抽取行原样（最多 10 条，每条截到 160 字；精确条数在 `coverage.droppedMentions`）。
   *  只给一个数，「丢的是什么」就只能另开一轮去复现——活体一轮丢了 7 条，回执里什么都看不出。 */
  droppedRaw: string[]
  coverage: DecisionCoverage
  residual: ResidualHandling
  /** 买入价的来源口径（全轮统一，见 `PricingHandling`）。 */
  pricing: PricingHandling
  /** 出了什么岔子——一格失败只标记那一格。 */
  gaps: Array<{ stage: string; subject?: string; reason: string }>
  /**
   * 字段名的人话解释。模型读回执时**只看见字段名**，而 `softCriteria` / `no_mention` 这类名字
   * 它会按字面脑补——活体里它把软条件讲成"硬性条件"，于是"没人在横评里夸高刷"变成了
   * "市面上没有高刷的手机"。含义就写在数据旁边，不留给它猜。
   */
  legend: Record<string, string>
  /** 给模型的旁白：它能解释，不能改数。 */
  note: string
}

const LEGEND: Record<string, string> = {
  softCriteria: '横评里要看的点（如「拍照」）。它**不是过滤条件**：决定的是"哪些机型被横评就这一点点了名"，没被点名不等于不满足。',
  no_mention: '读过的横评没有就软条件点它的名——缺的是可核的依据，不是它不合格。',
  no_price: '比价没拿到落在合理区间的价格，放不上成本轴。',
  'pricing.mode':
    '买入价从哪儿来，**全轮统一**。`compared` = 比价源的现售报价（最强的一档）；' +
    '`listing` = 比价对所有候选都空手，整轮退到枚举时那个列表页价——有出处、枚举阶段验过真在售，' +
    '**但它是标价不是到手价，实付通常更低**，转述时必须说明，别讲成实付价。',
  unit_mismatch:
    '这一轮按单位价比（快消品），而它的单位对不上（如卷纸的「克」对抽纸的「抽」）或规格解析不出用量。' +
    '**不是"买不到"，也不是"它不好"**——只是放不进这一轮这根轴。',
  'cost.unit':
    '快消品档：比的是**每百抽 / 每百克多少钱**，不是整包价。整包价在这个品类里会让「3 包装 ¥12」' +
    '斩掉「24 包装 ¥45」——买回来三天就用完了。`sku` 是这个单位价从哪个具体规格算出来的：' +
    '候选名（如「洁柔」）是横评说话的粒度，**能买的是那个 sku**，转述时要把它带上。',
  frontier: '互不支配的那几台：没有任何一台在"代价"和"体验序"两根轴上都不劣于它。它们之间的差别是用户偏好，不是客观优劣。',
  dominated: '被斩的：另一台两根轴都不劣于它、至少一根严格更优。理由带数字，用户能自己核。',
  experience_rank: '按被横评点名的篇数排的序（1 = 最多），不是质量分。**并列 = 篇数相同 = 数据分不出高下**，不是"确认相当"；被斩理由里的"体验不落下风"在并列时也只是这个意思。',
  'coverage.residualEstimated': '回收平台查不到上一代、按同档实测保值率里最保守的那个估出来的台数（basis 开头写着「估的」）。不计入 residualKnown。',
  'coverage.stopped': 'truncated = 枚举源自己说清单没取完，这份全集是残的，不许讲成"市面上就这些"；interrupted = 找到了横评但一篇都没读成（每篇为什么见 gaps 里 stage=signal 的行），体验序无从谈起。',
  // 两档枚举的保证强度不同，**必须让读回执的人知道自己拿的是哪一档**：直查是可复现的整页
  // 结构化清单，发现循环是"开了几个聚集页、从里面抽出来的"。把后者转述成前者，等于给一份
  // 样本盖上"全集"的章。
  universeSource:
    '这份全集是从哪儿枚举来的。`catalog:<源>` = 按品类+价格档直查那份产品库（结构化、可复现）；' +
    '`discovery:catalog` = 没有可直查的产品库，走发现循环现找聚集页再抽（品类找窝 → 抓窝 → 配对 → 比价验在售）——' +
    '**它是一份有出处的样本，不是穷举**，转述时要说清这一点，并把 gaps 里 stage=universe 的行一起说出来；' +
    '`none` = 两档都没跑成，这一轮没有全集，别拿横评凑一个出来。',
  seeded:
    '枚举没找着、靠横评点名回灌进来的台数。横评反复点名而全集里没有 = **枚举漏了的硬证据**，' +
    '所以拿这些名字回头问一次比价源，验到"真买得到（现售新品 + 规格解析得出用量）"的才收进全集。' +
    '**它们的出处比枚举来的弱**：只证明买得到，没证明这个品类还有哪些同类没被提及——' +
    '所以只要 seeded > 0，这一轮的 `stopped` 就是 truncated，转述时必须说清全集是补出来的。',
}

/** 回灌最多验几个名字——成本闸（每个一次比价查询）。按被点名的篇数排序后取前几个。 */
const MAX_SEEDS = 8

/** 一篇横评最多读几篇——成本闸。 */
const MAX_REVIEWS = 6
/** 每台最多带几行比价（最便宜的在前）。 */
const MAX_PRICE_ROWS = 6

/**
 * 体验序：按**被点名次数**降序的 dense rank（1 = 最高，允许并列）。
 *
 * 这不是质量分，是「有多少篇横评为这个软条件点了它的名」。用它当 y 轴是有代价的，
 * 代价必须说出来：它偏向曝光多的机型。但它有一样「模型打分」没有的东西——**每一位都挂着
 * 引文，用户能自己核**。而斩杀线的全部说服力就在可证伪（研究文档第二节）。
 */
function rankByMentions(counts: Map<string, number>): Map<string, number> {
  const distinct = [...new Set(counts.values())].sort((a, b) => b - a)
  const rankOf = new Map(distinct.map((v, i) => [v, i + 1]))
  return new Map([...counts].map(([model, n]) => [model, rankOf.get(n)!]))
}

export async function runPurchaseDecision(
  constraints: DecisionConstraints,
  deps: DecisionDeps,
): Promise<DecisionReceipt> {
  const gaps: DecisionReceipt['gaps'] = []
  let stopped: DecisionCoverage['stopped'] = 'complete'

  // ① 全集 ------------------------------------------------------------------
  deps.onStage?.('universe', `枚举全集：${constraints.category.join('、')}，${constraints.priceRange.min ?? 0}–${constraints.priceRange.max ?? '∞'} 元`)
  const uni = await deps.universe(constraints, (note) => deps.onStage?.('universe', note))
  if (uni.truncated) stopped = 'truncated'
  deps.onStage?.('reviews', `全集 ${uni.models.length} 台${uni.truncated ? '（清单不全）' : ''}，找横评`)
  for (const reason of uni.errors ?? []) gaps.push({ stage: 'universe', reason })
  let universe = uni.models
  let names = universe.map((m) => m.model)
  const byName = new Map(universe.map((m) => [m.model, m]))

  // ② 软条件信号 -------------------------------------------------------------
  const mentionCount = new Map<string, number>()
  /** 每条点名连同**它来自哪一篇**——evidence 的 url 就是这一篇的 url。
   *  只存点名不存出处，卡片上就是一串无出处断言。 */
  const citations = new Map<string, Array<{ m: SignalMention; from: ReviewItem }>>()
  const unmatchedRaw = new Set<string>()
  /** unmatched 原文 → 被几篇点名 / 引文。聚合认领（③ 之前那道闸）的词表和证据。 */
  const unmatchedCount = new Map<string, number>()
  const unmatchedCites = new Map<string, Array<{ m: SignalMention; from: ReviewItem }>>()
  const droppedRaw: string[] = []
  let droppedMentions = 0
  let reviewsRead = 0
  let reviewsFound = 0

  if (names.length > 0) {
    let reviews: ReviewItem[] = []
    try {
      reviews = await deps.reviews(constraints)
    } catch (e) {
      gaps.push({ stage: 'reviews', reason: `找横评失败：${msg(e)}` })
    }
    reviewsFound = reviews.length
    const picked = reviews.slice(0, MAX_REVIEWS)
    deps.onStage?.('signal', `找到 ${reviewsFound} 篇横评，读前 ${picked.length} 篇看谁被点名（最慢的一步）`)
    // **并行读**：这一段是整条链最慢的一格（每篇一次 LLM）。串行跑会把工具面拖到分钟级。
    // 收集完再按原顺序折叠，保证结果与顺序无关（否则名次会随网络快慢抖）。
    const settled = await Promise.all(
      picked.map(async (review) => {
        try {
          return { review, r: await deps.signal(review, names, constraints) }
        } catch (e) {
          return { review, err: msg(e) }
        }
      }),
    )
    for (const s of settled) {
      if ('err' in s && s.err !== undefined) {
        // 一篇读挂了不放倒整轮（discovery 那条 `interrupted` 教训的同一形状）。
        gaps.push({ stage: 'signal', subject: s.review.title, reason: s.err })
        continue
      }
      const r = s.r!
      reviewsRead++
      droppedMentions += r.dropped.length
      for (const d of r.dropped) if (droppedRaw.length < 10) droppedRaw.push(JSON.stringify(d.raw).slice(0, 160))
      // unmatched 的原文要**连篇数和引文一起**留住：它们是下一步「聚合认领」的词表，
      // 只存一个 Set 的话，认领成功之后既排不出体验序、也拿不出出处。
      const rawsHere = new Set<string>()
      for (const u of r.unmatched) {
        if (!u.raw) continue
        unmatchedRaw.add(u.raw)
        rawsHere.add(u.raw)
        unmatchedCites.set(u.raw, [...(unmatchedCites.get(u.raw) ?? []), { m: u, from: s.review }])
      }
      for (const raw of rawsHere) unmatchedCount.set(raw, (unmatchedCount.get(raw) ?? 0) + 1)
      // 同一篇里同一台被夸多次只算一次——否则一篇长文能把一台机顶到前面。
      for (const model of new Set(r.mentions.map((m) => m.model))) {
        mentionCount.set(model, (mentionCount.get(model) ?? 0) + 1)
      }
      for (const m of r.mentions) citations.set(m.model, [...(citations.get(m.model) ?? []), { m, from: s.review }])
    }
  }

  // ②' 聚合认领：横评说的粒度比全集粗时，把全集聚到横评的粒度上 -------------------
  //
  // 快消品的常态：全集是 SKU（`洁柔粉Face 3层110抽*24包`），横评说的是品牌（`洁柔`）。
  // 两边差一级粒度，逐字匹配就全部落空——活体 2026-09-04 跑「纸巾」：27 个点名全进
  // unmatched、86 台全部 no_mention、`named` 恒 0，斩杀线整个跑不起来，而**没有一处会报错**，
  // 看起来像"横评不提这些牌子"。
  //
  // 词表就是横评自己（`foldByMention` 的头注解释了为什么不硬编码品牌表）。手机那条路碰不到
  // 这里：横评说 `vivo X300`、全集里就有，在上游第一道精确匹配就命中了，unmatched 是空的。
  const folded = foldByMention(names, [...unmatchedCount.keys()])
  /** 聚合候选 → 派去比价的那个 SKU 及其规格。空 = 这一轮没有聚合（手机那条路的常态）。 */
  const foldedSpec = new Map<string, { model: string; spec: UnitSpec }>()
  if (folded.size > 0) {
    const absorbed = new Set<string>()
    for (const [raw, memberNames] of folded) {
      const members = memberNames.map((n) => byName.get(n)!).filter(Boolean)
      const rep = pickRepresentative(members)
      // 选不出代表（成员都没价 / 都解析不出规格）→ **不聚**。宁可这个点名留在 unmatched 里
      // 诚实地摆着，也不要造一个算不出单位价的候选混进支配运算。
      if (!rep) continue
      foldedSpec.set(raw, rep)
      for (const n of memberNames) absorbed.add(n)
      mentionCount.set(raw, unmatchedCount.get(raw) ?? 1)
      citations.set(raw, unmatchedCites.get(raw) ?? [])
      unmatchedRaw.delete(raw) // 认领成功了就不再是"没配上"
      byName.set(raw, {
        model: raw,
        ...(rep.model && byName.get(rep.model)?.listPrice !== undefined ? { listPrice: byName.get(rep.model)!.listPrice } : {}),
        ...(byName.get(rep.model)?.url ? { url: byName.get(rep.model)!.url } : {}),
        ...(byName.get(rep.model)?.image ? { image: byName.get(rep.model)!.image } : {}),
      })
    }
    if (foldedSpec.size > 0) {
      // 被聚走的 SKU 不再单独出现——否则同一件东西在回执里既是"洁柔"又是那几条 SKU，
      // 支配运算会拿它自己斩自己。
      universe = [...folded.keys()].filter((k) => foldedSpec.has(k)).map((k) => byName.get(k)!)
        .concat(uni.models.filter((m) => !absorbed.has(m.model)))
      names = universe.map((m) => m.model)
      deps.onStage?.('signal', `横评说的是品牌不是具体规格：${foldedSpec.size} 个品牌聚了 ${absorbed.size} 个 SKU`)
    }
  }

  // ①' 回灌枚举：横评反复点名、全集里却没有的名字，是**枚举漏了的硬证据** ----------------
  //
  // 活体 2026-09-04 七轮纸巾：横评那一端**每一轮都是同样六个牌子**（维达 / 心相印 / 清风 /
  // 洁柔 / 得宝 / 可心柔），而发现循环枚举出来的全集在 86 → 18 → 25 → 69 → 81 → 9 之间乱飘，
  // 第七轮整份飘到了海外商用擦手纸（Viva 布巾、Tork 多折手巾、Joe Multifold）——`named: 0`、
  // `priced: 0`，整轮空转。**稳的是横评，飘的是枚举**，而横评一直在把答案摆在 `unmatchedRaw`
  // 里，被当废料丢掉。
  //
  // 所以把它们回灌：拿这些名字回头问一次比价源，**验到"真买得到"的才收进全集**。
  // 这不违反「枚举领路、横评只排序」——领路的仍是枚举，只是用横评给的线索补它自己漏掉的那部分；
  // 收进来的每一个都带着"现售新品报价"这条出处，不是拿点名凑候选。
  //
  // 但它的保证比枚举来的**弱一档**：只证明这个牌子买得到，没证明这个品类还有哪些同类没被提及。
  // 所以 `seeded > 0` 一律把这一轮标成 truncated，别让一份补出来的全集被讲成"市面上就这些"。
  const seededRows = new Map<string, PriceRow[]>()
  if (unmatchedRaw.size > 0) {
    const cands = [...unmatchedRaw]
      .map((raw) => ({ raw, n: unmatchedCount.get(raw) ?? 0 }))
      .sort((a, b) => b.n - a.n)
      .slice(0, MAX_SEEDS)
    deps.onStage?.('universe', `横评点了 ${unmatchedRaw.size} 个全集里没有的名字，回头验前 ${cands.length} 个是不是真买得到`)
    const probed = await mapWithConcurrency(cands, PRICE_CONCURRENCY, async ({ raw, n }) => {
      try {
        const res = await deps.price(raw)
        const rows = Array.isArray(res) ? res : res.rows
        const current = rows.filter((r) => !r.title || (isCurrentNewOffer(r.title) && offerTitleMatches(raw, r.title)))
        // 判据与快消品档取价那一格**同一个函数**：解析得出用量、剔掉促销碎数字之后还剩得下东西。
        // 两份判据一旦分家，就会出现「回灌收了它、取价时又说没价」的静默错位。
        const cheapest = pickCheapestByUnit(current)
        return cheapest ? { raw, n, rows, cheapest } : { raw, n }
      } catch (e) {
        gaps.push({ stage: 'universe', subject: raw, reason: `回灌验在售失败：${msg(e)}` })
        return { raw, n }
      }
    })
    const admitted: string[] = []
    for (const p of probed) {
      if (!('cheapest' in p) || !p.cheapest) continue
      const { raw, n, rows, cheapest } = p
      byName.set(raw, { model: raw, listPrice: cheapest.amount })
      // 走快消品档的单位价轴：用量取自**成交那一行**，和上面聚合认领来的候选同一条路。
      foldedSpec.set(raw, { model: cheapest.title, spec: cheapest.spec })
      mentionCount.set(raw, n)
      citations.set(raw, unmatchedCites.get(raw) ?? [])
      unmatchedRaw.delete(raw)
      universe = [...universe, byName.get(raw)!]
      // 刚问到的这批行**留着给取价那一格用**：同一个名字问两遍不但白烧一次比价源，
      // 还可能拿回不一样的行（比价源按关键词返回，两次未必同一片），于是"回灌验到了"
      // 和"取价没拿到"能同时成立——最难查的那种自相矛盾。
      seededRows.set(raw, rows)
      admitted.push(raw)
    }
    if (admitted.length > 0) {
      names = universe.map((m) => m.model)
      stopped = 'truncated'
      gaps.push({
        stage: 'universe',
        reason: `枚举漏了横评点名的 ${admitted.length} 个（${admitted.slice(0, 6).join('、')}），已按"验到真买得到"补进全集；` +
          `这份全集是补出来的，不代表这个品类只有这些。`,
      })
      deps.onStage?.('universe', `补进全集 ${admitted.length} 个横评点名、枚举漏掉的：${admitted.slice(0, 6).join('、')}`)
    }
  }

  // ③ 取数 + 判定谁能进计算 ---------------------------------------------------
  const unranked: UnrankedModel[] = []
  const named = [...mentionCount.keys()]
  for (const m of universe) {
    if (!mentionCount.has(m.model)) {
      unranked.push({
        model: m.model,
        reason: 'no_mention',
        detail: '读过的横评没有为这个条件点它的名。这不等于它不好——只是没有可核的依据给它排体验序。',
      })
    }
  }

  const rank = rankByMentions(mentionCount)
  deps.onStage?.('price', `${named.length} 台被点名，逐台比价${constraints.willResell ? ' + 查保值率' : ''}`)
  const products: NormalizedProduct[] = []
  let priced = 0
  let residualKnown = 0

  /** 候选名 → 这一轮**真正拿去比价的那个串**。聚合候选是品牌（`洁柔`），问出去的却是代表 SKU
   *  的全名——两者不一样，而回执里以前只有前者，于是"为什么没比到价"永远缺最关键的一格。 */
  const askedAs = new Map<string, string>()
  /** 候选名 → **成交那一行**的规格（快消品档）。用量和价格来自同一行报价，不是事先猜的代表 SKU。 */
  const pricedSpec = new Map<string, { model: string; spec: UnitSpec }>()

  // 取数也并行（每台一次比价、要转手时再加一次保值率查询），**但同时最多 PRICE_CONCURRENCY 台**：
  // 十台一起打，比价源（慢慢买 SSR，每台 2 页）当场限流回空壳页——活体一轮 10 台里 5 台
  // 「一行都没回」。并行度是这一层的事，不是某个源的事：源只知道自己被打了，不知道是谁在打。
  // 收集完仍按原顺序折叠。
  const fetched = await mapWithConcurrency(named, PRICE_CONCURRENCY, async (model) => {
      const out: { model: string; rows: PriceRow[]; priceErr?: string; info: ResidualInfo | null } = { model, rows: [], info: null }
      // **问候选名本身**——聚合候选就问品牌（`洁柔`）。
      //
      // 上一版问的是事先选出的代表 SKU 全名，活体 2026-09-04（run 82779f12）证伪了那条路：
      // 代表被"单位价最低"选成长尾促销款（「得宝一博同款…家庭囤货装」「清风敦煌文创联名…
      // BG28ASJIP」），拿这种长串去比价回来的几乎全是**历史优惠**（清风只回 3 行、全已结束），
      // 而问品牌名回来的多数是现售。用量不再靠事先猜的代表，改由**每一行报价自己带**
      // （见 `pickCheapestByUnit`）——价格和用量来自同一行，那一行就是用户真能点进去买的。
      const askAs = model
      askedAs.set(model, askAs)
      // 回灌进来的那些，刚才验在售时已经问过一次，行原样留着——**不再问第二遍**（见 ①' 头注）。
      const cached = seededRows.get(model)
      if (cached) out.rows = cached
      else {
        try {
          const res = await deps.price(askAs)
          out.rows = Array.isArray(res) ? res : res.rows
          const warnings = Array.isArray(res) ? [] : res.warnings
          if (out.rows.length === 0 && warnings.length > 0) out.priceErr = `比价一行都没回，且有成员没答上来：${warnings.join('；')}`
        } catch (e) {
          out.priceErr = msg(e)
        }
      }
      if (constraints.willResell) {
        try {
          out.info = await deps.residual(askAs, constraints.holdDays)
          // null 不是异常，但同样要进 gaps：整轮退到 purchase_only 时，用户得知道是**哪几台**对不上，
          // 否则回执只剩一个「4 台里 1 台查到」的数字，没法核、也没法去补。
          if (!out.info) gaps.push({ stage: 'residual', subject: model, reason: '回收平台没有这台（型号对不上或没收录），残值查不到' })
        } catch (e) {
          gaps.push({ stage: 'residual', subject: model, reason: msg(e) })
        }
      }
      return out
    })

  /** 过了价格闸的台。残值怎么算要看**全体**（见下），所以先攒起来、再统一定口径。 */
  const priced_: Array<{ model: string; purchase: number; withAmount: PriceRow[]; info: ResidualInfo | null }> = []

  for (const { model, rows, priceErr, info } of fetched) {
    if (priceErr) gaps.push({ stage: 'price', subject: model, reason: priceErr })
    // **价格要过合理性闸，再取最小值。** 比价行里混着促销文案的碎数字（"省9.11元"、
    // "12.74元券"），而抠价是"取这一行的第一个数"——不筛就必然是**最小的那个垃圾赢**，
    // 于是一台手机的日均持有成本算出来是几分钱，表格照样画得出来。
    // 判据用两个现成的锚：用户给的价格区间，以及产品库那一行的参考价（同一台机的真实量级）。
    const anchor = byName.get(model)?.listPrice
    const lo = Math.max(constraints.priceRange.min ?? 0, anchor ? anchor * 0.5 : 0)
    const hi = Math.min(constraints.priceRange.max ?? Infinity, anchor ? anchor * 1.6 : Infinity)
    // 先按标题筛掉**不是这台**和**不是现售新品**的行，再看价格带。比价源按关键词回一整片
    // （兄弟款、已结束的优惠、二手），取最小值时正是它们赢——活体一台买入价算成 1373，
    // 是一条已结束的 K80 至尊版优惠，比它上代的今日回收价还低。
    // 逐行记下**被谁拒的**。只报一个「没有一行合格」的总数，排查时手里就只剩那个 0——
    // 活体 2026-09-04 为这一句话付了四轮代价：三次凭推理猜错了原因（"SKU 名太长搜不到"、
    // "被限流"、"品牌粒度过不了闸"），每次都得重新手工侦察一遍才知道猜错了。
    // **回执说不出为什么，下一个人就只能再猜一次。**
    const rejected = { expired: [] as string[], otherModel: [] as string[] }
    const current = rows.filter((r) => {
      if (!r.title) return true
      if (!isCurrentNewOffer(r.title)) { rejected.expired.push(r.title); return false }
      if (!offerTitleMatches(model, r.title)) { rejected.otherModel.push(r.title); return false }
      return true
    })
    // **快消品档不看价格带，看单位价。** 价格带（listPrice 的 0.5–1.6 倍）是照"同一台机只有
    // 一个价"写的；一个牌子铺开 6 包装到 27 包装，整包价横跨一个数量级，那道带子会把大包装
    // 全部切掉——而大包装恰恰是单位价最便宜的那些。这一档的闸换成「标题解析得出用量」：
    // 解析不出来的行本来也上不了单位价这根轴，它同时挡住了促销碎数字那类垃圾行。
    const folded = foldedSpec.has(model)
    const cheapest = folded ? pickCheapestByUnit(current, anchor) : null
    const withAmount = folded
      ? (cheapest ? [current.find((r) => r.title === cheapest.title)!] : [])
      : current.filter(
          (r) => typeof r.amount === 'number' && Number.isFinite(r.amount) && r.amount! >= lo && r.amount! <= hi,
        )
    const purchase = folded ? cheapest?.amount : (withAmount.length > 0 ? Math.min(...withAmount.map((r) => r.amount!)) : undefined)
    if (purchase === undefined) {
      // 被拒的行长什么样——**样例是结论的一部分**，不是日志。没有它就分不出"问错了词"
      // （回来的全是别的商品）和"这东西今天真没现货"（回来的全是已结束）。
      const sample = (xs: string[]) => xs.slice(0, 2).map((t) => `「${t.slice(0, 40)}」`).join('、')
      const why = [
        rejected.expired.length ? `${rejected.expired.length} 行是已结束/二手（如 ${sample(rejected.expired)}）` : '',
        rejected.otherModel.length ? `${rejected.otherModel.length} 行不是这个（如 ${sample(rejected.otherModel)}）` : '',
      ].filter(Boolean).join('；')
      // **不拿列表参考价顶替**：那是另一个口径的数，混进来会让支配关系错得毫无征兆。
      unranked.push({
        model,
        reason: 'no_price',
        detail: rows.length === 0
          ? `比价一行都没回${priceErr ? '（原因见 gaps 里 stage=price 的行）' : ''}，没法放上成本轴。（问的是「${askedAs.get(model) ?? model}」）`
          : current.length === 0
            ? `比价回了 ${rows.length} 行，没有一行是这个的现售新品报价：${why}。（问的是「${askedAs.get(model) ?? model}」）`
            : `比价回了 ${current.length} 行现售报价，但没有一个价格落在合理区间（${Math.round(lo)}–${hi === Infinity ? '∞' : Math.round(hi)} 元），没法放上成本轴。（问的是「${askedAs.get(model) ?? model}」）`,
      })
      // 没上成本轴的台，它的残值缺口也别留着：残值和比价是并行取的，这条 gap 是顺手带出来的，
      // 留下会让读回执的人以为"一台没定价的机器在查残值时失败了"（Sonnet 试跑就把它读成了矛盾）。
      for (let i = gaps.length - 1; i >= 0; i--) if (gaps[i]!.stage === 'residual' && gaps[i]!.subject === model) gaps.splice(i, 1)
      continue
    }
    priced++
    if (info && info.resale < purchase) residualKnown++
    // 规格跟着**那一行报价**走（快消品档）——价格和用量必须来自同一个东西。
    if (cheapest) pricedSpec.set(model, { model: cheapest.title, spec: cheapest.spec })
    priced_.push({ model, purchase, withAmount, info })
  }

  // ③' 比价整轮空手 → 退到枚举时那个列表页价（**全轮统一，不逐台混用**）。
  //
  // 为什么需要：快消品的候选是品牌聚出来的，派去比价的是代表 SKU 的**全名**
  // （`心相印茶语丝享 3层110抽*6包S码`），而比价源按商品名搜——这种长串搜不到。
  // 活体 2026-09-04（run 03eef4f2）：6 个品牌全部 no_price、前沿 0 台，**而价格本来就在手上**
  // ——发现循环抽候选时干的就是「从在售页面配对型号↔价格」，且 catalog 域的 check 已经用
  // `price_search` 验过真在售、价格在区间内（那一轮日志：合格 25）。枚举那端拿到的数，
  // 比价那端又问一次、问不到就判"没价格"，是典型的没追到另一端。
  //
  // 但**不许逐台顶替**（那条禁令在上面 no_price 分支里写着，是对的）：一台实付价、一台标价，
  // 两个数不在同一根轴上。所以只在比价对**所有**候选都空手时整轮切换，并在回执里说清口径。
  const pricing: PricingHandling = { mode: 'compared', note: '买入价来自比价源的现售报价。' }
  // **闸门是"这个源的 listPrice 验过在售没有"，不是"缺不缺价"**：产品库直查那档给的是目录
  // 标价，拿它顶替会把一次真实的取数失败洗成一份看着挺像样的前沿（`no_price` 分支那条禁令
  // 守的就是这个，`src/agent/purchase/job.test.ts` 里两条用例钉着）。
  if (priced_.length === 0 && uni.listPriceVerified) {
    const fromListing = named
      .map((model) => ({ model, listPrice: byName.get(model)?.listPrice }))
      .filter((x): x is { model: string; listPrice: number } => typeof x.listPrice === 'number')
    // 不足 2 台本来也算不出支配关系，退了也没用，不如保持"没比到价"的诚实说法。
    if (fromListing.length >= 2) {
      pricing.mode = 'listing'
      pricing.note =
        `比价源对这一轮的候选一行都没回（快消品的代表 SKU 全名太长，按商品名搜不到），` +
        `整轮改用**枚举时那个列表页价**——它有出处（每台的 url 就是抽到它的那个页面），` +
        `且枚举阶段用 price_search 验过真在售、价格在区间内。**但它是标价不是到手价**，` +
        `实付通常更低，别把它当成实付价转述。口径全轮统一，没有一台混用比价的数。`
      for (const { model, listPrice } of fromListing) {
        // 这一档的价来自**枚举时那个 SKU**，所以用量也必须来自同一个 SKU——价格和用量同源
        // 是单位价唯一成立的前提（比价那一档同源于"成交的那一行"，这一档同源于"枚举的那一行"）。
        const rep = foldedSpec.get(model)
        if (rep) pricedSpec.set(model, rep)
        priced_.push({ model, purchase: listPrice, withAmount: [{ platform: '枚举页', price: `${listPrice} 元`, amount: listPrice }], info: null })
        priced++
      }
      // 这些台不再是"没价格"——把刚才那批 no_price 撤掉，否则回执自相矛盾（既在前沿里、又在没进比较的名单里）。
      const back = new Set(fromListing.map((x) => x.model))
      for (let i = unranked.length - 1; i >= 0; i--) if (unranked[i]!.reason === 'no_price' && back.has(unranked[i]!.model)) unranked.splice(i, 1)
    }
  }

  // **查不到上一代的台，借同一轮同伴的实测保值率估**——取最保守的那个。无编号首代机、改名系列、
  // 平台没收录的冷门机都走这条；它不依赖型号命名规律，只依赖"这一轮别的台查到了"。
  // 为什么取最低不取中位：估的数不能帮它赢。按最保守算它只会偏贵，这样还能进前沿就是真便宜。
  // 至少 MIN_RESIDUAL_PEERS 台实测才启用，否则仍整轮退回按买入价（一台的保值率不是"同档水平"）。
  // 活体（2026-09-03）：11 轮里 3 轮因一台首代机（荣耀 WIN RT / 一加 Turbo 6X）把其余 8 台的实测残值整轮作废。
  // **查到的残值高过买入价 = 代理失真，不能当残值用。** 上代今天的最高回收价（最好机况）高过
  // 这台今天的到手价，通常是退了一代 + 国补把新品价压下去了；按买入价封顶会算出「持有成本 0」，
  // 一台机凭这个横扫全场（活体 2026-09-03：vivo S60 上代 S50 回收 ¥2235 > 到手 ¥2209，成本 0，
  // 斩了 11 台）。失真的和查不到的同一处理：走同伴估算，并在 gaps 里说清是哪一种。
  const usable = (p: { purchase: number; info: ResidualInfo | null }): p is { purchase: number; info: ResidualInfo } =>
    !!p.info && p.info.resale < p.purchase
  const peers = priced_.filter(usable)
  const estimated = new Map<string, ResidualInfo>()
  if (constraints.willResell && peers.length >= MIN_RESIDUAL_PEERS) {
    const ratio = Math.min(...peers.map((p) => p.info!.resale / p.purchase))
    const pct = Math.round(ratio * 100)
    for (const p of priced_) {
      if (usable(p)) continue
      const distorted = p.info ? `查到的上代回收价 ¥${Math.round(p.info.resale)} 高过买入价 ¥${p.purchase}（${p.info.basis}）——代理失真，不能当残值用；` : '回收平台查不到这台的上一代，'
      // 向下取整：估的数只许偏贵。四舍五入会把比例抬到同伴最低值之上（活体差了 ¥1、万分之二）。
      estimated.set(p.model, {
        resale: Math.floor(p.purchase * ratio),
        basis: `估的：${distorted}按同档 ${peers.length} 台实测保值率里最保守的 ${pct}% × 买入价 ¥${p.purchase} 算——估的数只会让它偏贵，不会帮它赢`,
      })
      const reason = p.info
        ? `查到的上代回收价 ¥${Math.round(p.info.resale)} 高过买入价 ¥${p.purchase}，代理失真；残值已按同档最保守保值率 ${pct}% 估算（见它的 basis）`
        : `回收平台没有这台（型号对不上或没收录），残值已按同档最保守保值率 ${pct}% 估算（见它的 basis）`
      const g = gaps.find((g) => g.stage === 'residual' && g.subject === p.model)
      if (g) g.reason = reason
      else gaps.push({ stage: 'residual', subject: p.model, reason })
    }
  } else if (constraints.willResell) {
    for (const p of priced_) {
      if (usable(p) || !p.info) continue
      gaps.push({ stage: 'residual', subject: p.model, reason: `查到的上代回收价 ¥${Math.round(p.info.resale)} 高过买入价 ¥${p.purchase}，代理失真，不能当残值用；同档实测不足 ${MIN_RESIDUAL_PEERS} 台，没法估` })
    }
  }
  const residualEstimated = estimated.size
  const infoOf = (p: { model: string; purchase: number; info: ResidualInfo | null }): ResidualInfo | null =>
    usable(p) ? p.info : (estimated.get(p.model) ?? null)

  // 残值口径**全体统一**，不逐台混用：一台扣了残值、另一台没扣，两个数就不在同一根轴上，
  // 支配关系错得毫无征兆。三档见 `ResidualHandling`。
  const residual: ResidualHandling = !constraints.willResell
    ? { mode: 'none', note: '用户说不会转手，残值按 0 计——抽屉里躺着的旧机残值就是 0，这一档本来就对。' }
    : priced_.length > 0 && priced_.every((p) => infoOf(p))
      ? {
          mode: 'known',
          note:
            '每台都查到了回收价，代价是真的日均持有成本 (买入价 − 残值) / 持有天数。' +
            '**残值是代理不是预测**：平台只报今天的价，这里按持有年限取同系列上一代 / 上两代机型**今天**的最高回收价（最好机况）——' +
            '每台的 basis 写着取的是哪一台、退没退代。各台一律同一口径，比的是相对高下。' +
            (residualEstimated > 0
              ? `其中 ${residualEstimated} 台回收平台查不到上一代，按同档 ${peers.length} 台实测保值率里最保守的那个估的（basis 开头写着「估的」）——估的数只会让它偏贵，不会帮它赢。`
              : ''),
        }
      : {
          mode: 'purchase_only',
          note:
            `用户打算 ${constraints.holdDays} 天后转手，但 ${priced_.length} 台里只有 ${residualKnown} 台在回收平台对上了上代机型` +
            `（对不上的那几台见 gaps 里 stage=residual 的行）。` +
            '**这里按买入价算，没扣残值**——它不是持有成本的前沿：保值率高的机型实际会比表上划算。' +
            '查到的那几台把查到的数写在各自的 basis 里，但本轮没有扣（一台扣一台不扣，两个数就不在同一根轴上）。' +
            '不要把这说成"系统默认残值为 0"，也不要自己估一个残值补进去。',
        }

  /**
   * 这一轮用哪根成本轴。**全体统一，不逐台混用**——和残值口径同一条纪律：一台按每百抽、
   * 另一台按日均持有成本，两个数根本不在同一根轴上，而支配运算照跑不误、没有一处会报错。
   *
   * 判据是「这一轮有没有聚出品牌候选」：聚得出来说明横评在按品牌讲、全集是带规格的 SKU，
   * 那就是快消品的形状，比的只能是单位价。单位本身也取多数派——`元/百抽` 和 `元/百克`
   * 之间比大小同样毫无意义。
   */
  const axisUnit = (() => {
    if (foldedSpec.size === 0) return null
    const tally = new Map<string, number>()
    for (const p of priced_) {
      const u = pricedSpec.get(p.model)?.spec.unit
      if (u) tally.set(u, (tally.get(u) ?? 0) + 1)
    }
    if (tally.size === 0) return null
    return [...tally.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0]
  })()

  for (const p of priced_) {
    const { model, purchase, withAmount } = p
    const rep = pricedSpec.get(model)
    if (axisUnit !== null && rep?.spec.unit !== axisUnit) {
      // 单位对不上就进不了这一轮的比较。**说清楚是"单位不可比"，不是"它没价格"**——
      // 两句话在回执里长得一样的话，用户会以为这个牌子买不到。
      unranked.push({
        model,
        reason: 'unit_mismatch',
        detail: rep
          ? `这一轮按「${axisUnit}」比单位价，它是按「${rep.spec.unit}」卖的，两者不可比。`
          : `这一轮按「每百${axisUnit}」比单位价，但它的规格解析不出用量，放不上这根轴。`,
      })
      continue
    }
    const info = infoOf(p)
    // 到这里 info 一定 < 买入价（失真的已换成估算），min 只是防御。
    const resale = residual.mode === 'known' ? Math.min(Math.round(info!.resale), purchase) : 0
    const basis =
      residual.mode === 'known'
        ? info!.basis
        : residual.mode === 'none'
          ? '用户说不会转手，残值按 0 计。'
          : info
            ? `按买入价算（未扣残值）：这台查到了——${info.basis}——但别的台没查到，口径统一，本轮没扣。`
            : p.info
              ? `残值代理失真（上代回收价 ¥${Math.round(p.info.resale)} 高过买入价），同档实测不足没法估，按买入价算（未扣残值）。`
              : '残值查不到，按买入价算（未扣残值）。'
    const u = byName.get(model)
    const cites = citations.get(model) ?? []
    products.push({
      name: model,
      ...(u?.image ? { image: u.image } : {}),
      // **只带过闸的行**。闸原先只管"用哪个数当买入价"，却把所有比价行原样塞进回执——
      // 于是卡片和模型仍然看得见 `5.9元`、`7.39元` 这种"手机价"。活体里模型据此判定
      // 「数据质量不合格」并拒绝下结论，它是对的：**展示出来的东西也是结论的一部分**。
      // 最便宜的几行就够对账；一台 20 行 × 11 台是回执里最重的一块（活体 44 KB）。
      prices: [...withAmount]
        .sort((a, b) => a.amount! - b.amount!)
        .slice(0, MAX_PRICE_ROWS)
        .map((r) => ({ platform: r.platform, price: r.price, ...(r.url ? { url: r.url } : {}) })),
      cost: rep
        ? { kind: 'unit', purchase, quantity: rep.spec.quantity, unit: rep.spec.unit, sku: rep.model }
        : { kind: 'ownership', purchase, resale, days: constraints.holdDays, basis },
      experience_rank: rank.get(model)!,
      pros: [...new Set(cites.map(({ m }) => m.attribute))],
      cons: [],
      fit: rep
        ? `被 ${mentionCount.get(model)} 篇横评就「${constraints.softCriteria.join('、') || '综合'}」点名；单位价按能买到的 ${rep.model} 算。`
        : `被 ${mentionCount.get(model)} 篇横评就「${constraints.softCriteria.join('、') || '综合'}」点名。`,
      evidence: cites.slice(0, 3).map(({ m, from }) => ({
        source: `${from.platform ? `${from.platform} ` : ''}${from.title}`.slice(0, 80),
        url: from.url,
        point: m.attribute,
      })),
      comparable_cost: rep ? unitCost(purchase, rep.spec.quantity) : (purchase - resale) / constraints.holdDays,
      cost_unit: rep
        ? `元/百${rep.spec.unit}`
        : residual.mode === 'purchase_only'
          ? '元/天（未扣残值）'
          : '元/天',
    })
  }

  // ④ 支配运算——复用 verdict 那颗脑子，不另写一份 --------------------------
  const { dominated, frontier } = products.length >= 2
    ? computeDomination(products)
    : { dominated: [] as DominationRecord[], frontier: products.map((p) => p.name) }

  if (gaps.some((g) => g.stage === 'signal') && reviewsRead === 0 && reviewsFound > 0) stopped = 'interrupted'

  deps.onStage?.('result', `${products.length} 台进比较，前沿 ${frontier.length} 台、被斩 ${dominated.length} 台`)
  // ⑤ 回执 ------------------------------------------------------------------
  const coverage: DecisionCoverage = {
    universe: universe.length,
    named: named.length,
    unmatched: unmatchedRaw.size,
    droppedMentions,
    reviewsRead,
    reviewsFound,
    priced,
    residualKnown,
    residualEstimated,
    seeded: seededRows.size,
    stopped,
  }
  // 举例上限：够看出"长什么样"，又不至于把 frontier 挤出截断窗。
  const PER_REASON_EXAMPLES = 4
  const unrankedCounts = unranked.reduce(
    (m, u) => ({ ...m, [u.reason]: (m[u.reason] ?? 0) + 1 }),
    {} as Record<UnrankedModel['reason'], number>,
  )
  const trimmedUnranked = (['no_mention', 'no_price'] as const).flatMap((reason) =>
    unranked.filter((u) => u.reason === reason).slice(0, PER_REASON_EXAMPLES),
  )
  // **键的顺序就是截断顺序**：工具结果被截断时后面的先没。结论（前沿 / 被斩 / 覆盖率 / 口径 /
  // 旁白）排前面，最重的 products 明细排最后——活体里 frontier 排在 268 条 unranked 之后
  // 被切掉过一次，这次 11 台 × 20 行比价又把 products 撑到 40 KB，同一个坑。
  return {
    constraints,
    universeSource: uni.source,
    coverage,
    residual,
    pricing,
    note: buildNote(coverage, products.length, residual),
    frontier,
    dominated,
    unrankedCounts,
    unranked: trimmedUnranked,
    unmatchedRaw: [...unmatchedRaw].slice(0, 20),
    droppedRaw,
    gaps,
    legend: LEGEND,
    products,
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 旁白：**回执里的数就是结论**，模型只负责讲清楚。这里把「哪些话不许说」写死——
 * 它们都是听起来很顺、实则与同一份回执打架的说法。
 */
function buildNote(c: DecisionCoverage, ranked: number, residual: ResidualHandling): string {
  const parts: string[] = [
    `候选集来自${c.universe} 台的枚举，其中 ${c.named} 台被横评点名、${ranked} 台进了比较。` +
      '讲结论时必须把这几个数说出来——没有出处的候选集不是结论，是一张披着表格的猜测。',
    '这份回执就是终稿：直接照它讲结论，**不要再调别的工具重新组装一遍**，也不要反问用户要更多条件——缺什么回执已经说了，把缺的说出来就够。',
  ]
  if (residual.mode === 'purchase_only') parts.push(`⚠️ ${residual.note}`)
  if (c.stopped === 'truncated') {
    parts.push('⚠️ 这份全集是**残的**（枚举源自己说没取完）。**绝不许**把它讲成「市面上就这些」。')
  }
  if (c.seeded > 0) {
    parts.push(
      `⚠️ 其中 ${c.seeded} 个是枚举**漏掉**、靠横评点名回头验到"真买得到"才补进来的（见 legend 的 seeded）。` +
        '它们的出处只证明买得到，不证明这个品类没有别的同类——这一轮的全集是补出来的，说结论时要带上这一句。',
    )
  }
  if (c.stopped === 'interrupted') {
    parts.push('⚠️ 横评一篇都没读成，体验序无从谈起。别拿它当完整结论。')
  }
  if (c.unmatched > 0) {
    parts.push(
      `横评提到 ${c.unmatched} 个不在全集里的型号（见 unmatchedRaw）——可能是枚举漏了，也可能是海外/未上市机型。` +
        '值得提一句，别当没看见。',
    )
  }
  if (c.droppedMentions > 0) {
    parts.push(`有 ${c.droppedMentions} 条抽取结果因缺字段（型号 / 属性 / 原话）被丢弃，说明抽取那一口不稳，结论要打折看。`)
  }
  if (ranked < 2) {
    parts.push('进比较的候选不足 2 个，**支配关系无从谈起**——如实说清为什么（看 unranked 的原因），别硬推一个。')
  }
  parts.push('答案里出现的型号必须在本回执里；回执之外的型号一律不许出现。')
  return parts.join(' ')
}
