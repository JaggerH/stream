// src/agent/search/domain.ts
import type { ChatFn } from './joints.ts'

/**
 * 一个发现域：同一条 `runSearch` 循环，不同的「候选是什么」。领域差异只有四格
 * （spec 2026-09-01 §2.1）——不是把 flow 里每个咬网盘的地方都开成一格。
 *
 * 三处**不**进域（spec §2.1，别把它们再拆回来）：
 * - `rank`：网盘档的「夸克优先」是**用户偏好**，进调用侧，不焊进域。
 * - `onboardable`：组装通用（窝的 url 恒进 + 切题候选的出处），但**出处本身是领域知识**，
 *   由 `originsOf` 提供——网盘档是这条链来自的那个窝，商品档是抽到该型号的那几个窝。
 * - 停止条件：通用逻辑（边际产出趋零），网盘档的「够 N 条」是叠加在它之上的早停参数。
 */
/** 关节口径（见 `DiscoveryDomain.framing`）。三句话，全部进系统提示。 */
export interface DomainFraming {
  /** 这一档在找什么，一句话。例：「找下架/私有资源」/「按约束枚举符合条件的商品」。 */
  mission: string
  /** 出搜索词时的 B 轴该怎么造词（A 轴恒是"拿目标本身去搜"，不因域而异）。
   *  带 1-2 个**本域的**例子——例子是这句提示里最有效的部分，也是最容易串味的部分。 */
  categoryAxisHint: string
  /** 这一档的「聚集地」长什么样。分类关节靠它判 hub。 */
  hubLooksLike: string
  /**
   * 这一档有没有「搜索结果本身就是货」这一类；没有就写 null（商品档：搜索结果里不会直接
   * 躺着结构化的「小米17 4999元」，directLinks 恒空，三分类退化成二分类是它的正常形态）。
   * 写 null 时提示里不出现这一档，免得模型硬往里塞。
   */
  directLooksLike: string | null
}

export interface DiscoveryDomain<T> {
  /** 域名字，进轨迹，好让一条 run 能说清自己是哪一档。 */
  name: string
  /** 从一个窝的页面文本认出候选。吃 #1 #2（URL 改写并进这里，抓不动就自己处理）。 */
  parse: (pageText: string, hubUrl: string) => T[] | Promise<T[]>
  /**
   * 这一条算不算数（真实 + 合格）。吃 #3 #10。
   *
   * **内部分两段**——先便宜地淘汰（网盘档：开链验活）、再对幸存者花钱打分（LLM）——
   * 但那是成本优化不是概念区别，所以对外只有一格。
   * **"没验"和"验过"必须分得开**（现有语义，别丢）：stats 里 unchecked ≠ dead——
   * 回执里 `{ alive: 0, dead: 0, unchecked: 0 }` 表示这一批压根没验（无 verify 依赖）。
   */
  check: (goal: string, candidates: T[], chat: ChatFn) => Promise<{
    kept: Array<T & { fit: number }>
    stats: { alive: number; dead: number; unchecked: number }
  }>
  /** 冷启动种子：这类东西通常在哪儿出没。吃 #6 #7。**只是初值不是天花板**——
   *  先验只负责第 0 轮，之后由 Task 3 的回灌接管。 */
  habitat: readonly string[]
  /**
   * 两个 LLM 关节（`proposeQueries` / `classifyHits`）问模型的那句话。
   *
   * **这一格不是文案，是领域知识**——关节的**代码**是通用的（出词、分类、抽词汇），但它
   * **问什么**不是：网盘档问的是「找下架/私有资源」，商品档问的是「按约束找一份商品清单」。
   * 把网盘那套口径留给商品档用，症状不是报错而是**跑偏**：活体（2026-09-02）跑
   * 「手机 拍照，5000 元以内」，第 0 轮生成的查询是「5000元以内拍照手机 网盘」「手机拍照
   * 五千元 下载」——habitat 明明只有「手机/拍照/5000元以内」，网盘词全来自关节的提示词。
   * 分类那一侧同理：「hub」在网盘口径里是资源站/福利号，在商品口径里该是排行榜/导购/比价页。
   *
   * 这是 Task 1 泛化时漏掉的第三处「声明成通用、领域知识却留在原地」——前两处是
   * `onboardable` 的出处和收敛判据的门槛。共同点是**测试全绿、没有一处报错**。
   */
  framing: DomainFraming
  /** 身份：两条抽到的是不是同一个。**只管去重**——别拿它当出处用。 */
  identityOf: (t: T) => string
  /**
   * 出处：这一条是从哪几个窝来的。**和 `identityOf` 是两件事**，别合并——
   * 「这两条是不是同一个」与「这条来自哪儿」在网盘档恰好都能从 hit 上读出来，于是很容易
   * 顺手用同一格；一合并，`onboardable`（"哪个站值得接进来"）里装的就变成网盘分享链本身，
   * 而没有一处会报错：现有测试断言的是窝的 url 仍在，那部分照旧过。
   */
  originsOf: (t: T) => string[]
  /**
   * 进窝顺序的亲和度：lower = 先开。吃 #7 #8——站型排序 + 专名命中。网盘档是
   * `hubPriority`（2026-08-10「阿达想当科学家」的教训：先看像不像目标，再看站型）。
   * 这一格是 plan Step 5 反向验证的目标：翻成恒不命中，进窝回归测试应当变红。
   */
  hubAffinity: (hub: { kind: string; title?: string }, goal: string) => number
}
