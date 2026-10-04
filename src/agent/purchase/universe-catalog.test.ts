import { describe, it, expect } from 'vitest'
import {
  makeCatalogUniverse,
  catalogsOf,
  pickCatalog,
  pickBands,
  priceOf,
  baseModelName,
  type CatalogBand,
  type CatalogIndex,
} from './universe-catalog.ts'
import type { DecisionConstraints } from './job.ts'

const C = (over: Partial<DecisionConstraints> = {}): DecisionConstraints => ({
  category: ['手机'],
  priceRange: {},
  softCriteria: ['拍照'],
  holdDays: 730,
  willResell: false,
  ...over,
})

/** 一份「四个固定价格档」的产品库声明——形状照包里那份写，但**宿主不认识它是谁家的**。 */
const FOUR_BANDS: CatalogBand[] = [
  { value: '0', max: 1999 },
  { value: '2000', min: 2000, max: 4599 },
  { value: '4600', min: 4600, max: 7599 },
  { value: '7600', min: 7600 },
]

const recipe = (catalog: unknown, extra: Record<string, unknown> = {}) => ({ meta: { catalog, ...extra } })

const phoneCatalog = {
  category: ['手机', 'phone'],
  param: 'price',
  bands: FOUR_BANDS,
}

/** 只装一份产品库的索引：`@pkg/lib/phones` 管手机、按 price 四档查。 */
const ONE: CatalogIndex = () => catalogsOf(new Map([['@pkg/lib/phones', recipe(phoneCatalog)]]))

describe('catalogsOf — 产品库由 recipe 自己声明，宿主只读表', () => {
  it('没声明 catalog 的 recipe 不算产品库', () => {
    const r = catalogsOf(new Map([['@a/x/y', { meta: { title: 't' } }], ['@a/x/z', {}]]))
    expect(r).toEqual({ catalogs: [], problems: [] })
  })

  it('声明写错形状 → 进 problems 点名是哪条，不静默当成"没声明"', () => {
    const r = catalogsOf(new Map([['@a/x/bad', recipe({ category: '手机' })]]))
    expect(r.catalogs).toEqual([])
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toContain('@a/x/bad')
  })

  it('只写了 param 没写 bands（或反过来）是写错，不是"不分档"', () => {
    const r = catalogsOf(new Map([
      ['@a/x/p', recipe({ category: ['手机'], param: 'price' })],
      ['@a/x/b', recipe({ category: ['手机'], bands: FOUR_BANDS })],
    ]))
    expect(r.catalogs).toEqual([])
    expect(r.problems).toHaveLength(2)
  })
})

describe('pickCatalog — 品类词命中声明里的任一词', () => {
  it('手机命中那份产品库', () => {
    expect(pickCatalog(ONE().catalogs, ['手机', '拍照'])?.sourceId).toBe('@pkg/lib/phones')
  })
  it('大小写不敏感（英文品类词）', () => {
    expect(pickCatalog(ONE().catalogs, ['Phone'])?.sourceId).toBe('@pkg/lib/phones')
  })
  it('没有产品库的品类返回 undefined，交给调用方回落', () => {
    expect(pickCatalog(ONE().catalogs, ['扫地机器人'])).toBeUndefined()
  })
  it('两份都认这个品类 → priority 高的那份；平手按 id 定，结果可复现', () => {
    const { catalogs } = catalogsOf(new Map([
      ['@b/lib/phones', recipe(phoneCatalog, { priority: 50 })],
      ['@a/lib/phones', recipe(phoneCatalog, { priority: 70 })],
      ['@c/lib/phones', recipe(phoneCatalog, { priority: 70 })],
    ]))
    expect(pickCatalog(catalogs, ['手机'])?.sourceId).toBe('@a/lib/phones')
  })
})

describe('pickBands — 档是粗的，取有交集的全部', () => {
  it('5000 元以内 → 三档（0 / 2000 / 4600），因为 4600 档跨过了 5000', () => {
    expect(pickBands(FOUR_BANDS, { max: 5000 })).toEqual(['0', '2000', '4600'])
  })
  it('3000-3800 → 只要 2000 那一档（3800×1.2=4560，没跨过 4600）', () => {
    expect(pickBands(FOUR_BANDS, { min: 3000, max: 3800 })).toEqual(['2000'])
  })
  it('3000-4000 → 标价余量跨过 4600，4600 那一档也要', () => {
    expect(pickBands(FOUR_BANDS, { min: 3000, max: 4000 })).toEqual(['2000', '4600'])
  })
  it('没给区间 → 全部档', () => {
    expect(pickBands(FOUR_BANDS, {})).toHaveLength(4)
  })
})

describe('priceOf', () => {
  it('纯数字字符串', () => expect(priceOf('3699')).toBe(3699))
  it('带千分位', () => expect(priceOf('12,999')).toBe(12999))
  it('取不到就是取不到，不回 0', () => {
    expect(priceOf('暂无报价')).toBeUndefined()
    expect(priceOf(undefined)).toBeUndefined()
  })
})

describe('makeCatalogUniverse', () => {
  // **夹具必须是 `readSource` 那一端的形状**：adapter 的原始条目，字段名就是 recipe 里写的
  // 那几个（description/link/image）。照归一化后的 `StoredItem`（body_text/url/raw.image）
  // 写夹具，测试会全绿而线上恒空——活体两头都撞过，这条夹具就是那次的疤。
  const rows = [
    { title: 'A手机（12GB/256GB）', description: '3699', link: 'https://x/a', image: 'https://i/a.jpg' },
    { title: 'B手机', description: '5299' },
    { title: 'C手机', description: '暂无报价' },
    { title: '', description: '1999' },
  ]

  it('按声明的 param 逐档去问声明里的那个源', async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const u = makeCatalogUniverse(async (id, params) => { calls.push([id, params]); return { items: [] } }, ONE)
    await u(C({ priceRange: { max: 5000 } }))
    expect(calls).toEqual([
      ['@pkg/lib/phones', { price: '0' }],
      ['@pkg/lib/phones', { price: '2000' }],
      ['@pkg/lib/phones', { price: '4600' }],
    ])
  })

  it('不分档的产品库：只问一次、不带参数，价格照样逐行筛', async () => {
    const calls: Array<Record<string, unknown>> = []
    const flat: CatalogIndex = () => catalogsOf(new Map([['@pkg/lib/all', recipe({ category: ['手机'] })]]))
    const u = makeCatalogUniverse(async (_id, params) => { calls.push(params); return { items: rows } }, flat)
    const r = await u(C({ priceRange: { max: 4000 } }))
    expect(calls).toEqual([{}])
    expect(r.models.map((m) => m.model)).toEqual(['A手机'])
  })

  it('出处标签是 `catalog:<源全名>`——回执里说得出是哪份产品库，宿主不替它起名', async () => {
    const u = makeCatalogUniverse(async () => ({ items: [] }), ONE)
    expect((await u(C())).source).toBe('catalog:@pkg/lib/phones')
  })

  it('**逐行的确切价格才是判据**——标价超出上限（含余量）的行不进全集', async () => {
    const u = makeCatalogUniverse(async () => ({ items: rows }), ONE)
    // 4000 × 1.2 = 4800 < 5299：B 挡在外面
    const r = await u(C({ priceRange: { max: 4000 } }))
    expect(r.models.map((m) => m.model)).toEqual(['A手机'])
    expect(r.models[0]).toMatchObject({ listPrice: 3699, url: 'https://x/a', image: 'https://i/a.jpg' })
  })

  it('**标价上限放 20% 余量**——预算 2500，标价 2599 的行要进全集（实付价由比价期再切）', async () => {
    const u = makeCatalogUniverse(async () => ({ items: [{ title: 'K90', description: '2599' }, { title: 'Pro', description: '3699' }] }), ONE)
    const r = await u(C({ priceRange: { max: 2500 } }))
    expect(r.models.map((m) => m.model)).toEqual(['K90'])
  })

  it('拿不到价的行不进全集——不让价格不明的候选混进支配运算', async () => {
    const u = makeCatalogUniverse(async () => ({ items: [{ title: 'C手机', description: '暂无报价' }] }), ONE)
    expect((await u(C())).models).toEqual([])
  })

  it('跨档去重：同一台在两档都出现只留一条', async () => {
    const u = makeCatalogUniverse(async () => ({ items: [{ title: '同一台', description: '4500' }] }), ONE)
    const r = await u(C({ priceRange: { min: 1000, max: 7000 } }))
    expect(r.models).toHaveLength(1)
  })

  it('**一档取挂了 → truncated=true 且带原因**，绝不静默少几台', async () => {
    let n = 0
    const u = makeCatalogUniverse(async () => {
      if (n++ === 0) throw new Error('反爬闸')
      return { items: [{ title: 'A手机', description: '3699' }] }
    }, ONE)
    const r = await u(C({ priceRange: { max: 5000 } }))
    expect(r.truncated).toBe(true)
    expect(r.errors[0]).toContain('反爬闸')
    expect(r.models).toHaveLength(1) // 别的档照常交货
  })

  it('**没声明 exhaustive 的产品库，取回东西就是残的**——宿主不替源吹"这就是全集"', async () => {
    const u = makeCatalogUniverse(async () => ({ items: [{ title: 'A手机', description: '3000' }] }), ONE)
    expect((await u(C({ priceRange: { min: 2000, max: 4599 } }))).truncated).toBe(true)
  })

  it('声明了 exhaustive:true 的产品库，取全了就不标残', async () => {
    const full: CatalogIndex = () => catalogsOf(new Map([['@pkg/lib/all', recipe({ category: ['手机'], exhaustive: true })]]))
    const u = makeCatalogUniverse(async () => ({ items: [{ title: 'A手机', description: '3000' }] }), full)
    expect((await u(C())).truncated).toBe(false)
  })

  it('一档真的空 → 不谎报 truncated（没东西可漏）', async () => {
    const u = makeCatalogUniverse(async () => ({ items: [] }), ONE)
    expect((await u(C({ priceRange: { min: 2000, max: 4599 } }))).truncated).toBe(false)
  })

  it('没有产品库的品类：空全集 + source=none（调用方据此回落）', async () => {
    const u = makeCatalogUniverse(async () => ({ items: rows }), ONE)
    const r = await u(C({ category: ['扫地机器人'] }))
    expect(r).toEqual({ models: [], source: 'none', truncated: false, errors: [] })
  })

  it('有写错的声明时，source=none 也把问题带出去——回落那一侧要能说出"有份产品库声明坏了"', async () => {
    const broken: CatalogIndex = () => catalogsOf(new Map([['@pkg/lib/bad', recipe({ category: 7 })]]))
    const r = await makeCatalogUniverse(async () => ({ items: [] }), broken)(C())
    expect(r.source).toBe('none')
    expect(r.errors[0]).toContain('@pkg/lib/bad')
  })

  it('**索引在调用时现取**——包是后装的，装配期拿到的空表不能冻住', async () => {
    let table = new Map<string, unknown>()
    const u = makeCatalogUniverse(async () => ({ items: [{ title: 'A手机', description: '3000' }] }), () => catalogsOf(table as never))
    expect((await u(C())).source).toBe('none')
    table = new Map([['@pkg/lib/phones', recipe(phoneCatalog)]])
    expect((await u(C())).source).toBe('catalog:@pkg/lib/phones')
  })
})

describe('按身份归并——产品库按 SKU 拆行，横评说的是裸型号', () => {
  it('去掉容量后缀，留横评会用的那个名字', () => {
    expect(baseModelName('vivo X300(12GB/256GB)')).toBe('vivo X300')
    expect(baseModelName('Redmi K100 Pro（12GB/256GB）')).toBe('Redmi K100 Pro')
    expect(baseModelName('华为畅享90 Pro Max 128GB')).toBe('华为畅享90 Pro Max')
  })

  it('**同一台的多个容量档并成一条，取最低价**（那是这台机的入场价）', async () => {
    const u = makeCatalogUniverse(async () => ({
      items: [
        { title: 'vivo X300(12GB/256GB)', description: '4299' },
        { title: 'vivo X300(16GB/512GB)', description: '4799' },
        { title: 'vivo X300（12GB/512GB）', description: '3999' },
      ],
    }), ONE)
    const r = await u(C({ priceRange: { max: 5000 } }))
    expect(r.models).toHaveLength(1)
    expect(r.models[0]).toMatchObject({ model: 'vivo X300', listPrice: 3999 })
  })

  it('不归并的后果是 named 恒 0——enum 里全是带容量的串，模型逐字找不到裸型号', async () => {
    // 活体 2026-09-02：6 篇横评读成、抽出 OPPO Find X9 / vivo X300 / iPhone 17 三台，
    // 三台全落进 unmatched，看起来像"横评不提这个价位"，实际是名字问成了另一个东西。
    const u = makeCatalogUniverse(async () => ({ items: [{ title: 'OPPO Find X9(16GB/512GB)', description: '4999' }] }), ONE)
    expect((await u(C({ priceRange: { max: 5000 } }))).models[0]?.model).toBe('OPPO Find X9')
  })
})

describe('baseModelName 的收尾', () => {
  it('剥完容量留下的空括号要清掉', () => {
    // 活体撞到过 `苹果iPhone 17e（）`：容量没了、括号还在，那个名字拿去比价查不到。
    expect(baseModelName('苹果iPhone 17e（128GB）')).toBe('苹果iPhone 17e')
    expect(baseModelName('某机(256GB)')).toBe('某机')
  })
  it('结尾的分隔符也清掉', () => {
    expect(baseModelName('某机 12GB+256GB')).toBe('某机')
  })
})
