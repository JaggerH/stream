import { describe, it, expect, vi } from 'vitest'
import { makeDiscoveryUniverse, makeUniverse } from './universe-discovery.ts'
import type { DecisionConstraints } from './job.ts'
import type { SearchOutcome } from '../search/types.ts'
import type { CatalogHit } from '../search/domains/catalog.ts'

const C = (over: Partial<DecisionConstraints> = {}): DecisionConstraints => ({
  category: ['纸巾'],
  priceRange: {},
  softCriteria: [],
  holdDays: 90,
  willResell: false,
  ...over,
})

type Outcome = SearchOutcome<CatalogHit>
const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  targets: [],
  hubs: [],
  onboardable: [],
  stopped: 'converged',
  ...over,
})

const hit = (model: string, price?: number, hubUrls = ['https://hub.example/list']): CatalogHit & { fit: number } => ({
  model,
  ...(price === undefined ? {} : { price }),
  hubUrls,
  fit: 1,
})

describe('makeDiscoveryUniverse', () => {
  it('把发现循环的候选变成全集，价格和出处一起带过来', async () => {
    const run = vi.fn(async () =>
      outcome({ targets: [hit('心相印 3层120抽', 39), hit('维达 超韧 4层', 45)] }),
    )
    const uni = makeDiscoveryUniverse({ runSearch: run })
    const r = await uni(C())

    expect(r.models).toEqual([
      { model: '心相印 3层120抽', listPrice: 39, url: 'https://hub.example/list' },
      { model: '维达 超韧 4层', listPrice: 45, url: 'https://hub.example/list' },
    ])
    expect(r.source).toBe('discovery:catalog')
  })

  it('收敛才算清单完整；跑满轮次/干涸/中断/早停都是残的，且说得出为什么', async () => {
    for (const [stopped, why] of [
      ['truncated', '跑满轮次'],
      ['dry', '扩源干涸'],
      ['interrupted', '中途某一轮挂了'],
      ['early', '够数早停'],
    ] as const) {
      const uni = makeDiscoveryUniverse({ runSearch: async () => outcome({ stopped, targets: [hit('A')] }) })
      const r = await uni(C())
      expect(r.truncated, stopped).toBe(true)
      expect(r.errors?.join(' '), stopped).toContain(why)
    }

    const ok = makeDiscoveryUniverse({ runSearch: async () => outcome({ stopped: 'converged', targets: [hit('A')] }) })
    expect((await ok(C())).truncated).toBe(false)
  })

  // 「没有枚举源」和「找了但一台没找到」是两回事：前者是我们的能力缺口，后者是这个品类的事实。
  // 回执把它们讲成同一句话，用户就会以为市面上没有纸巾。
  it('找了但空手：source 仍是 discovery，errors 说清是找过了', async () => {
    const uni = makeDiscoveryUniverse({ runSearch: async () => outcome({ stopped: 'dry', targets: [] }) })
    const r = await uni(C())
    expect(r.source).toBe('discovery:catalog')
    expect(r.models).toEqual([])
    expect(r.errors?.join(' ')).toContain('一台都没抽到')
  })

  it('发现循环整个挂了：不放倒整轮，标残并带出原因', async () => {
    const uni = makeDiscoveryUniverse({
      runSearch: async () => {
        throw new Error('searxng 连不上')
      },
    })
    const r = await uni(C())
    expect(r.models).toEqual([])
    expect(r.truncated).toBe(true)
    expect(r.errors?.join(' ')).toContain('searxng 连不上')
  })
})

describe('makeUniverse — 直查优先，回落发现', () => {
  it('直查源命中就用它，绝不跑发现循环（发现循环很贵）', async () => {
    const direct = vi.fn(async () => ({ models: [{ model: 'vivo X300' }], source: 'catalog:@pkg/lib/phones', truncated: true, errors: [] }))
    const discovery = vi.fn(async () => ({ models: [], source: 'discovery:catalog', truncated: false, errors: [] }))
    const r = await makeUniverse(direct, discovery)(C({ category: ['手机'] }))

    expect(r.source).toBe('catalog:@pkg/lib/phones')
    expect(discovery).not.toHaveBeenCalled()
  })

  // 回落的判据只有一条：直查自己说 `source === 'none'`（= 没有它认识的产品库）。
  // 不在这里复刻一份 pickSource 的品类正则——两份判据一旦分家，就会出现「直查说没有、
  // 这里以为有」的静默错位。
  it('直查说 none 就回落到发现循环', async () => {
    const direct = async () => ({ models: [], source: 'none', truncated: false, errors: [] })
    const discovery = vi.fn(async () => ({
      models: [{ model: '心相印 3层120抽', listPrice: 39 }],
      source: 'discovery:catalog',
      truncated: false,
      errors: [],
    }))
    const r = await makeUniverse(direct, discovery)(C())

    expect(discovery).toHaveBeenCalledOnce()
    expect(r.source).toBe('discovery:catalog')
    expect(r.models).toHaveLength(1)
  })

  // 产品库声明写错时直查只能说 none——但"为什么没有"不能在回落这一步丢掉。
  it('直查说 none 且带着问题 → 回落照跑，问题并进回落结果的 errors', async () => {
    const direct = async () => ({ models: [], source: 'none', truncated: false, errors: ['产品库声明写错（@pkg/lib/bad）'] })
    const discovery = vi.fn(async () => ({ models: [], source: 'discovery:catalog', truncated: false, errors: ['扩源干涸'] }))
    const r = await makeUniverse(direct, discovery)(C())

    expect(discovery).toHaveBeenCalledOnce()
    expect(r.errors).toEqual(['产品库声明写错（@pkg/lib/bad）', '扩源干涸'])
  })

  // 直查命中但一台没取到（上游全挂）：这是直查的事实，不是"没有源"。回落会把
  // 「那份产品库今天全挂了」洗成「发现循环找不到手机」，排查时手里就只剩后面那句。
  it('直查命中但空手：照实返回直查的空，不偷偷回落', async () => {
    const direct = async () => ({ models: [], source: 'catalog:@pkg/lib/phones', truncated: true, errors: ['价格档 0：超时'] })
    const discovery = vi.fn(async () => ({ models: [], source: 'discovery:catalog', truncated: false, errors: [] }))
    const r = await makeUniverse(direct, discovery)(C({ category: ['手机'] }))

    expect(discovery).not.toHaveBeenCalled()
    expect(r.source).toBe('catalog:@pkg/lib/phones')
    expect(r.errors).toEqual(['价格档 0：超时'])
  })
})
