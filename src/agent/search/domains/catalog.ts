// src/agent/search/domains/catalog.ts
import type { ChatMessage, ChatResult } from '../../../llm/client.ts'
import { extractJson } from '../../../llm/extract-json.ts'
import type { DiscoveryDomain } from '../domain.ts'
import type { ChatFn } from '../joints.ts'

/** 商品档的候选：一个型号（可带配对出的价格）＋它来自哪些窝（出处，spec §2.4——
 *  候选集的价值一半在出出处上，没有出处的候选集不许进支配运算）。 */
export interface CatalogHit {
  model: string
  price?: number
  hubUrls: string[]
}

/** 结构化约束（Task 5 的 `enumerate_candidates` 入参）——不是自由文本 goal。 */
export interface CatalogConstraints {
  /** 品类词（如 ['手机', '拍照']）：habitat 种子 + check 的 LLM 切题判据。 */
  category: string[]
  /** 价格区间（元）。min / max 可缺。 */
  priceRange: { min?: number; max?: number }
}

/** 装配商品档需要的依赖。chat 供 parse 的 LLM 配对（parse 没有 chat 参数，闭包注入）；
 *  check 用接口传进来的 chat 参数。 */
export interface CatalogDomainDeps {
  chat: ChatFn
  /** 比价验证器——现成的 `price_search`（spec §2.3：不新增源、不新增 Provider 行，
   *  验证复用已有能力）。收窄到域需要的三格；接线时传 `ctx.search.priceSearch`。 */
  priceSearch: (model: string) => Promise<Array<{ title?: string; excerpt?: string; url?: string }>>
  constraints: CatalogConstraints
}

/**
 * 价格模式的粗筛（spec §2.6 ② 的选型 2 前半段）。**页面无关**：价格格式是全网半通用的
 * （¥4999 / 4999元 / 4,999 / 到手价4899），所以能进没见过的窝。
 *
 * **只认价格不认型号**：型号是自然语言，任何试图用正则认型号的尝试都会变成一站一份规则，
 * 那就退回 discovery 没意义的那一档。粗筛只负责把页面压成「含价格的候选行」，把喂给 LLM
 * 的体积砍掉一到两个量级；型号 ↔ 价格配对是 LLM 的活。
 *
 * 宁可松不可紧：写紧了整个窝被漏（型号价格分处两地的布局），那个损失由 Task 3 的回灌吸收。
 */
const PRICE_RE = /(?:到手价|券后价?|实付价?|成交价|预售价|售价|价格|¥|￥)\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*元/

export function coarsePriceRows(text: string): string[] {
  const rows: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (!line) continue
    if (!PRICE_RE.test(line)) continue
    rows.push(line)
  }
  return rows
}

/** 型号归一（identityOf 的地基，Task 4 Step 4）：去空格/大小写/标点，剥容量后缀（12+256 /
 *  12GB+256GB / 256G）。写松了整份候选集重复计数，支配运算照跑不误、没有一处会报错——
 *  这是这条线上第二个「安静出错」的点。 */
export function modelIdentity(model: string): string {
  // **顺序不能反：先剥容量、再去空白。** 容量串靠空格跟型号分界，空白一去这道界就没了，
  // 而 `\d+` 是贪婪的——「红米K80 12+256」会被当成「8012+256」整段吃掉，剩下「红米k」，
  // 于是 K80 和 K70 归成同一个身份。方向比注释原本担心的更坏：不是候选虚胖，是候选**消失**，
  // 而支配运算照跑不误、没有一处会报错。
  return model
    .toLowerCase()
    .replace(/(?<![0-9a-z])\d+\s*(?:gb?)?\s*\+\s*\d+\s*(?:gb?)?(?![0-9a-z])/g, ' ') // 12+256 / 12GB+256GB
    .replace(/(?<![0-9a-z])\d+\s*gb\b/g, ' ') // 残留的 256gb（单个 `g` 不剥——G 常是型号的一部分）
    .replace(/[\s,，.。:：'’"“”\-_—·+]/g, '')
}

/** LLM 配对：只把粗筛后的短行批量喂进去，输出「型号 ↔ 价格」。拿不准的行宁可漏不可错。
 *  hubUrls 由 parse 在拿到 hubUrl 之后补上。 */
async function pairModels(
  rows: string[],
  category: string[],
  chat: ChatFn,
): Promise<Array<{ model: string; price?: number }>> {
  if (rows.length === 0) return []
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你在从商品列表的"含价格行"里提取「型号 ↔ 价格」。每行可能是一个商品（型号 + 价格），' +
        '也可能只是导航/促销语/评论区。只输出 JSON 数组，形如 [{"model":"小米17 Pro","price":4999}]；' +
        '拿不准的行不要输出（宁可漏不可错）。不要任何解释。',
    },
    {
      role: 'user',
      content: `目标品类：${category.join('、') || '（未指定）'}\n\n候选行：\n${rows.map((r, i) => `${i}. ${r}`).join('\n')}`,
    },
  ]
  const res = await chat(messages)
  const parsed = extractJson<{ model?: unknown; price?: unknown }[]>(res.content)
  return (parsed ?? [])
    .filter((p): p is { model: string; price?: number } => typeof p.model === 'string' && p.model.trim().length > 0)
    .map((p) => ({ model: p.model.trim(), price: typeof p.price === 'number' && p.price > 0 ? p.price : undefined }))
}

/** LLM 切题打分（check 的贵段收尾）：给幸存者 0–3。 */
async function scoreCatalogTopicality(
  goal: string,
  hits: CatalogHit[],
  chat: ChatFn,
): Promise<Array<CatalogHit & { topicality: number }>> {
  if (hits.length === 0) return []
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你在判断商品候选是否切题。为每条打分：3=确定就是这个品类/型号，2=很可能是，1=沾边但存疑，0=无关。' +
        '只输出 JSON 数组，形如 [{"i":编号,"score":0到3}]，不要任何解释。',
    },
    {
      role: 'user',
      content: `目标：${goal}\n\n候选：\n${hits.map((h, i) => `${i}. ${h.model}${h.price !== undefined ? `（约${h.price}元）` : ''}`).join('\n')}`,
    },
  ]
  const res = await chat(messages)
  const parsed = extractJson<{ i: number; score: number }[]>(res.content) ?? []
  const byIndex = new Map(parsed.map((p) => [p.i, p.score]))
  return hits.map((h, i) => {
    const raw = byIndex.get(i)
    const score = typeof raw === 'number' && raw >= 0 && raw <= 3 ? Math.round(raw) : 0
    return { ...h, topicality: score }
  })
}

/** 从比价行里抠价格（excerpt 就是价格行，含促销/国补口径）。
 *
 * **导出是给决策 job 复用的**（`agent/purchase/job.ts` 的 ③ 取数）：两处都在读 `price_search`
 * 投影出来的同一种行，各写一个解析器的话，同一行价格会在两条路上解出不同的数，而两边单看都对。 */
export function priceOf(excerpt: string | undefined): number | undefined {
  const m = /(\d[\d,]*(?:\.\d+)?)/.exec(excerpt ?? '')
  if (!m) return undefined
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? n : undefined
}

/**
 * 商品档 domain（Task 4）。四格：
 * - `parse` = 规则粗筛（`coarsePriceRows`，页面无关、零成本、纯函数）+ LLM 配对（短行上做
 *   型号 ↔ 价格）。**没有"直链"这一档**（spec §2.5 ①）——搜索结果里不会直接躺着结构化的
 *   「小米17 4999元」，directLinks 恒空，三分类退化成二分类是这个域的正常形态。
 * - `check` = 两段：便宜段纯代码（价格已知且不在区间内 → dead，不用花钱去验；型号空 → dead；
 *   同一型号多窝抽到先按 identityOf 合并、hubUrls 累积），贵段注入 `price_search` 核实
 *   「真在售、价格真在区间内」（查无此型号 → unchecked 刷掉），再 LLM 判品类切题。
 * - `habitat` = 约束本身（品类词 + 价格区间的说法），**故意弱**——无专名目标没有强先验，
 *   强度靠 Task 3 的回灌补，不靠猜准。
 * - `identityOf` = 归一化型号名（去空格/大小写/容量后缀）。
 */
export function catalogDomain(deps: CatalogDomainDeps): DiscoveryDomain<CatalogHit> {
  const { chat, priceSearch, constraints } = deps
  const { category, priceRange } = constraints
  const inRange = (p: number): boolean =>
    p >= (priceRange.min ?? -Infinity) && p <= (priceRange.max ?? Infinity)
  const habitat: string[] = [
    ...category,
    ...(priceRange.max !== undefined ? [`${priceRange.max}元以内`] : []),
    ...(priceRange.min !== undefined ? [`${priceRange.min}元以上`] : []),
  ]
  return {
    name: 'catalog',
    parse: async (pageText: string, hubUrl: string): Promise<CatalogHit[]> => {
      const rows = coarsePriceRows(pageText)
      const paired = await pairModels(rows, category, chat)
      return paired.map((p) => ({ ...p, hubUrls: [hubUrl] }))
    },
    check: async (goal: string, candidates: CatalogHit[], chatFn: ChatFn) => {
      // 先按 identityOf 合并同型号（Task 4 Step 4 / spec §2.4）：同一型号从多个窝抽到合并成
      // 一条，hubUrls 累积**全部**来源——候选集的价值一半在出出处上。
      const merged = new Map<string, CatalogHit>()
      for (const c of candidates) {
        const id = modelIdentity(c.model)
        const prev = merged.get(id)
        if (!prev) {
          merged.set(id, { ...c, hubUrls: [...c.hubUrls] })
        } else {
          prev.hubUrls = [...new Set([...prev.hubUrls, ...c.hubUrls])]
          if (prev.price === undefined && c.price !== undefined) prev.price = c.price
        }
      }
      const uniq = [...merged.values()]

      // 便宜段（纯代码）：价格已知且不在区间内 → dead（事实，不用花钱去验）；型号空 → dead。
      // 品类词不进这段——型号是自然语言，词面匹配会变成一站一份规则（spec §2.6 ② 的教训），
      // 品类切题交给贵段的 LLM 判。
      const survivors: CatalogHit[] = []
      let alive = 0
      let dead = 0
      let unchecked = 0
      for (const c of uniq) {
        if (!c.model.trim() || (c.price !== undefined && !inRange(c.price))) {
          dead++
          continue
        }
        // 贵段：price_search 核实「这个型号真在售、价格真在区间内」。
        let rows: Array<{ excerpt?: string }> = []
        try {
          rows = await priceSearch(c.model)
        } catch {
          rows = [] // 网络失败——查不动和查无此型号都算没验上
        }
        const found = rows.map((r) => priceOf(r.excerpt)).filter((p): p is number => p !== undefined)
        if (found.length === 0) {
          unchecked++ // 查无此型号 → 刷掉（不回 kept）
          continue
        }
        if (!inRange(Math.min(...found))) {
          dead++ // 在售但不在区间内
          continue
        }
        alive++
        survivors.push(c)
      }
      const scored = await scoreCatalogTopicality(goal, survivors, chatFn)
      const kept = scored.map((h) => ({ ...h, fit: h.topicality }))
      return { kept, stats: { alive, dead, unchecked } }
    },
    habitat,
    // 关节口径。**B 轴的例子是这段提示里最有效的部分**——网盘档那套「品类词 × 获取词」
    // 换到这里会造出「拍照手机 网盘」（活体 2026-09-02 真出过），所以例子必须是本域的。
    // `directLooksLike: null`：搜索结果里不会直接躺着结构化的「小米17 4999元」，
    // 三分类退化成二分类是这个域的正常形态（spec §2.5 ①）。
    framing: {
      mission: '按约束枚举符合条件的商品清单',
      categoryAxisHint:
        '用品类 × 限定条件 × **清单类页面的说法**（如「5000元以内 拍照手机 排行榜」' +
        '「手机 性价比 推荐 榜单」「拍照手机 对比 导购」），',
      hubLooksLike: '一次列出很多款的页面——排行榜/榜单、导购/选购推荐、比价页、横评汇总、电商品类列表页',
      directLooksLike: null,
    },
    identityOf: (t) => modelIdentity(t.model),
    originsOf: (t) => t.hubUrls,
    hubAffinity: () => 0, // 无专名目标没有强先验（spec §1.3/§2.2）——窝好不好靠 Task 3 的回灌学，不靠猜
  }
}
