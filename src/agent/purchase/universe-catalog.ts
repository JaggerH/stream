/**
 * 决策 job 的 ① 枚举全集，**有产品库可直查的那一档**。
 * spec `2026-09-02-purchase-decision-job-design.md` §2。
 *
 * 为什么不是「搜索 → LLM 从文章里配对」：产品库这一类**根本不该靠 discovery 找**——
 * 它按品类和价格档能直接拼 URL 问，一次裸 HTTP 拿回整页结构化的行，零 LLM、可复现。
 * discovery 那条（`universe-discovery.ts`）留给「没有产品库可查」的品类。
 *
 * **宿主不认识任何一家产品库。**「哪个品类去问哪份 recipe、它的价格是怎么分档的、这份清单
 * 全不全」都是那个站的事实，住在 recipe 自己的 `meta.catalog` 里（范例：`packages/zol/`）。
 * 这里只做三件泛化的事：读声明表 → 按品类挑一份 → 逐档问、逐行按确切价格筛、按身份归并。
 *
 * 声明形状（recipe `meta.catalog`，`catalogDeclSchema` 是唯一判据）：
 * - `category: string[]` —— 品类词；用户品类里含任一词（大小写不敏感）即命中。
 * - `param` + `bands` —— 站上的价格是**固定档**时成对写：`bands[i].value` 按 `param` 传给 recipe，
 *   `min/max` 是这一档覆盖的标价区间。两个都不写 = 不分档，问一次、全靠逐行筛。
 * - `exhaustive?: true` —— 源自己担保「取回来的就是这一档的全部」。缺省 false：只要取回了东西
 *   就标 truncated，回执据此禁止把它讲成「市面上就这些」。**缺省必须是保守的那一边**——
 *   宿主替源吹「这就是全集」是这条线上最贵的一种错。
 * - 多份都认同一个品类时按 `meta.priority` 高者、平手按源全名，保证可复现。
 *
 * 行的契约：recipe 产出的原始条目里 `title` = 型号（可带容量，这里会归并），`description` =
 * 标价（取第一个数字），`link` / `image` 可选。
 */
import { z } from 'zod'
import { modelIdentity } from '../search/domains/catalog.ts'
import type { DecisionConstraints, UniverseModel } from './job.ts'

const bandSchema = z.object({
  value: z.string().min(1),
  min: z.number().nonnegative().optional(),
  max: z.number().positive().optional(),
})

/** recipe `meta.catalog` 的形状。**只有这一份判据**：包作者写错时在这里被点名，不静默当成"没声明"。 */
export const catalogDeclSchema = z
  .object({
    category: z.array(z.string().min(1)).min(1),
    param: z.string().min(1).optional(),
    bands: z.array(bandSchema).min(1).optional(),
    exhaustive: z.boolean().optional(),
  })
  .refine((d) => (d.param === undefined) === (d.bands === undefined), {
    message: 'param 与 bands 必须成对出现（都写 = 按档问，都不写 = 不分档）',
  })

export type CatalogBand = z.infer<typeof bandSchema>

export interface CatalogDecl {
  /** 源全名（`<包名>/<局部名>`）——`readSource` 认的就是它。 */
  sourceId: string
  category: string[]
  param?: string
  bands?: CatalogBand[]
  exhaustive: boolean
  priority: number
}

/** 声明表 + 写错的那几条（带源全名）。 */
export interface CatalogTable {
  catalogs: CatalogDecl[]
  problems: string[]
}

/** 调用时现取的声明表——包是后装的（`stream add` / 重载），装配期的快照会把「后来有了」冻成「没有」。 */
export type CatalogIndex = () => CatalogTable

/**
 * 从**原始** recipe 表（`ctx.sources.liveRecipes.current`：全名 → recipe）里收产品库声明。
 * 读原始 recipe 而不是投影出来的 manifest：manifest 的 schema 会剥掉它不认识的键，
 * `meta.catalog` 到不了那边（与执行器直读 `meta.rateLimit` 同一个理由）。
 */
export function catalogsOf(recipes: ReadonlyMap<string, { meta?: unknown }>): CatalogTable {
  const catalogs: CatalogDecl[] = []
  const problems: string[] = []
  for (const [sourceId, r] of recipes) {
    const meta = (r.meta ?? {}) as Record<string, unknown>
    if (meta.catalog === undefined) continue
    const parsed = catalogDeclSchema.safeParse(meta.catalog)
    if (!parsed.success) {
      problems.push(`产品库声明写错（${sourceId} 的 meta.catalog）：${parsed.error.issues.map((i) => `${i.path.join('.') || '(根)'} ${i.message}`).join('；')}`)
      continue
    }
    catalogs.push({
      sourceId,
      category: parsed.data.category,
      ...(parsed.data.param !== undefined ? { param: parsed.data.param, bands: parsed.data.bands } : {}),
      exhaustive: parsed.data.exhaustive ?? false,
      priority: typeof meta.priority === 'number' ? meta.priority : 0,
    })
  }
  return { catalogs, problems }
}

/** 品类词 → 哪份产品库。命不中就没有直查源，交给调用方回落到 discovery。 */
export function pickCatalog(catalogs: CatalogDecl[], category: string[]): CatalogDecl | undefined {
  const joined = category.join(' ').toLowerCase()
  return catalogs
    .filter((c) => c.category.some((w) => joined.includes(w.toLowerCase())))
    .sort((a, b) => b.priority - a.priority || a.sourceId.localeCompare(b.sourceId))[0]
}

/**
 * 枚举期按**标价**筛，比价期按**街价**筛（`job.ts` 逐台比价时再用用户上限切一次实付价）。
 * 两个口径差着一个折扣：活体（2026-09-03）iQOO Z11 Turbo 标价 2399、实付 2039（−15%）。
 * 用户说「2500 以内」时按标价卡死 2500，标价 2599 的红米 K90 / 一加 Ace 6 / iQOO Neo11 会在
 * 枚举期就被挡掉——而它们的实付价多半在预算内，横评点名了、回执却只能记成「不在全集里」
 * （那一轮 unmatched 7 台，3 台是这个原因）。所以标价上限放 20% 余量，让比价期用实付价做最后
 * 那道闸；街价高于预算的照样被那道闸切掉（全部报价超限 → no_price → 不进比较）。
 */
export const LIST_PRICE_HEADROOM = 1.2

export function listPriceCeiling(max: number | undefined): number {
  return max === undefined ? Number.POSITIVE_INFINITY : Math.round(max * LIST_PRICE_HEADROOM)
}

/** 与用户区间（标价上限含余量）**有交集**的档全要。区间没给就全部档。档是粗的，逐行价格才是判据。 */
export function pickBands(bands: CatalogBand[], range: { min?: number; max?: number }): string[] {
  const lo = range.min ?? 0
  const hi = listPriceCeiling(range.max)
  return bands
    .filter((b) => (b.max ?? Number.POSITIVE_INFINITY) >= lo && (b.min ?? 0) <= hi)
    .map((b) => b.value)
}

/**
 * 去掉容量后缀，留下**横评里会用的那个名字**：`vivo X300(12GB/256GB)` → `vivo X300`。
 *
 * 为什么必须做：产品库按 SKU 一行一条（同一台机按容量拆成好几行），横评说的却是裸型号。
 * 不归并的话，抽取关节的 enum 里全是带容量的串，模型逐字找不到"vivo X300"，只能诚实地
 * 判成"不在集合里"——**活体撞到过：6 篇横评读成、抽出 3 台，3 台全落进 unmatched，
 * `named` 恒 0**。看起来像"横评不提这个价位的机器"，实际是我们把名字问成了另一个东西。
 */
export function baseModelName(model: string): string {
  return model
    .replace(/[（(]\s*\d+\s*g?b?\s*[+/／]\s*\d+\s*g?b?\s*[）)]/gi, '')
    .replace(/\s*\d+\s*gb?\b/gi, '')
    // 剥完留下的空壳要一起清掉。活体撞到过 `苹果iPhone 17e（）`——括号里的容量没了、括号还在，
    // 那个名字拿去比价查不到、印在卡片上也像个 bug。
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/[\s,，、/／+-]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 行里的标价：取第一个数字（千分位去掉）。货币符号在不在这一格由 recipe 决定，这里都认。 */
export function priceOf(description: unknown): number | undefined {
  if (typeof description !== 'string') return undefined
  const m = description.replace(/[,，\s]/g, '').match(/\d+(?:\.\d+)?/)
  if (!m) return undefined
  const n = Number(m[0])
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * `readSource` 给的是**adapter 的原始条目**，也就是 recipe 里自己写的那几个字段名
 * （`title` / `description` / `link` / `image`）——**不是**归一化之后的 `StoredItem`。
 *
 * ⚠️ 同一个源有两条读法，形状不同，别拿错的那条当判据：
 * - `scheduler.readSource`（本模块走的、生产走的）→ 原始字段。
 * - `scheduler.readSourceNormalized`（`POST /api/sources/preview` 走的）→ `StoredItem`：
 *   价格在 `body_text`、链接在 `url`、图在 `raw.image`。
 *
 * **读错哪一套都不会报错**：字段恒 undefined → 每行都被当成"没价格"筛掉 → 全集恒空 →
 * 回执诚实地说 universe:0，看起来像"这个品类今天没货"。活体两头都撞过：先是照 preview
 * 探出来的名字写，工具里恒 0；改回原始名字才通。**探针要打生产真正走的那条路。**
 */
interface RawItem {
  title?: unknown
  description?: unknown
  link?: unknown
  image?: unknown
}

export function makeCatalogUniverse(
  readSource: (sourceId: string, params: Record<string, unknown>) => Promise<unknown>,
  index: CatalogIndex,
): (c: DecisionConstraints) => Promise<{ models: UniverseModel[]; source: string; truncated: boolean; errors: string[] }> {
  return async (c) => {
    const { catalogs, problems } = index()
    const cat = pickCatalog(catalogs, c.category)
    if (!cat) return { models: [], source: 'none', truncated: false, errors: problems }

    const lo = c.priceRange.min ?? 0
    const hi = listPriceCeiling(c.priceRange.max)
    const byModel = new Map<string, UniverseModel>()
    const errors: string[] = []
    let truncated = false

    // 不分档的产品库问一次、不带参数；分档的按声明的 param 逐档问。
    const asks: Array<{ label: string; params: Record<string, unknown> }> =
      cat.param && cat.bands
        ? pickBands(cat.bands, c.priceRange).map((v) => ({ label: `价格档 ${v}`, params: { [cat.param!]: v } }))
        : [{ label: '产品库', params: {} }]

    for (const ask of asks) {
      let items: RawItem[] = []
      try {
        const res = (await readSource(cat.sourceId, ask.params)) as { items?: RawItem[] } | RawItem[]
        items = Array.isArray(res) ? res : (res?.items ?? [])
      } catch (e) {
        // 一档挂了不放倒整轮，但它意味着**清单是残的**——必须说出来，不许静默少几台。
        // **原因也必须带出去**：只标一个 truncated 布尔，回执就只会说「清单是残的」而说不出
        // 为什么，排查时手里只剩一个 0。活体撞到过：三档全部瞬间失败、universe 恒 0，
        // 而回执一个字都没解释。
        truncated = true
        errors.push(`${ask.label}：${e instanceof Error ? e.message : String(e)}`)
        continue
      }
      // 源没担保 exhaustive，取回来的就是一个"按站点排序取前若干"的样本，不是全集。
      // 回执据此标 truncated，旁白会禁止把它讲成「市面上就这些」。
      if (items.length > 0 && !cat.exhaustive) truncated = true
      for (const it of items) {
        const model = typeof it.title === 'string' ? it.title.trim() : ''
        if (!model) continue
        const listPrice = priceOf(it.description)
        // 档是粗的，**逐行的确切价格才是判据**——拿不到价的行不进全集（宁可少一台，
        // 不要一台价格不明的候选混进支配运算）。
        if (listPrice === undefined || listPrice < lo || listPrice > hi) continue
        // 按**身份**归并（`modelIdentity`：去空格/大小写/容量后缀），一台机一条。
        // 同一台的多个容量档取**最低价**——它是"这台机的入场价"，也是支配运算该用的那个数。
        const name = baseModelName(model) || model
        const id = modelIdentity(name)
        const prev = byModel.get(id)
        if (!prev) {
          byModel.set(id, {
            model: name,
            listPrice,
            ...(typeof it.link === 'string' ? { url: it.link } : {}),
            ...(typeof it.image === 'string' ? { image: it.image } : {}),
          })
        } else if (prev.listPrice === undefined || listPrice < prev.listPrice) {
          byModel.set(id, { ...prev, listPrice })
        }
      }
    }
    // `listPriceVerified` 明确留空（= false）：这是产品库上的**目录标价**，没验过这台今天
    // 真在售，而且与街价还差着一个折扣（见 `LIST_PRICE_HEADROOM`）。比价空手时**不许**退到它。
    return { models: [...byModel.values()], source: `catalog:${cat.sourceId}`, truncated, errors: [...problems, ...errors] }
  }
}
