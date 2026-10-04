import { describe, it, expect } from 'vitest'
import { PRICE_CONCURRENCY, runPurchaseDecision, type DecisionDeps, type DecisionConstraints } from './job.ts'
import { NOT_IN_SET } from './signal.ts'

const C: DecisionConstraints = {
  category: ['手机'],
  priceRange: { max: 5000 },
  softCriteria: ['拍照'],
  holdDays: 730,
  willResell: false,
}

const REVIEW = { id: 'r1', title: '2026 拍照手机横评', url: 'https://example.com/r1' }

function deps(over: Partial<DecisionDeps> = {}): DecisionDeps {
  return {
    universe: async () => ({
      models: [
        { model: 'A手机', listPrice: 3999 },
        { model: 'B手机', listPrice: 4599 },
        { model: 'C手机', listPrice: 4299 },
      ],
      source: 'catalog:@pkg/lib/phones',
      truncated: false,
    }),
    reviews: async () => [REVIEW],
    signal: async () => ({
      mentions: [
        { model: 'A手机', attribute: '夜景', quote: 'A 的夜景最好' },
        { model: 'B手机', attribute: '长焦', quote: 'B 的长焦不错' },
      ],
      unmatched: [],
      dropped: [],
    }),
    price: async (m) => [{ platform: '京东', price: `${m === 'A手机' ? 3899 : 4499} 元`, amount: m === 'A手机' ? 3899 : 4499 }],
    residual: async (m) => ({ resale: m === 'A手机' ? 1950 : 2250, basis: '转转最高回收价' }),
    ...over,
  }
}

describe('runPurchaseDecision — 阶段顺序与覆盖率', () => {
  it('回执带全集大小、点名数，并算出前沿', async () => {
    const r = await runPurchaseDecision(C, deps())
    expect(r.coverage.universe).toBe(3)
    expect(r.coverage.named).toBe(2)
    expect(r.products).toHaveLength(2)
    // A 更便宜且点名次数并列 → A 支配 B
    expect(r.frontier).toEqual(['A手机'])
    expect(r.dominated.map((d) => d.name)).toEqual(['B手机'])
  })

  it('没被点名的进 unranked 并说明原因——不静默消失', async () => {
    const r = await runPurchaseDecision(C, deps())
    const c = r.unranked.find((u) => u.model === 'C手机')
    expect(c?.reason).toBe('no_mention')
    expect(r.unranked).toHaveLength(1)
  })

  it('枚举源说清单是残的 → stopped=truncated，且旁白禁止讲成「市面上就这些」', async () => {
    const r = await runPurchaseDecision(
      C,
      deps({ universe: async () => ({ models: [{ model: 'A手机' }], source: 'catalog:@pkg/lib/phones', truncated: true }) }),
    )
    expect(r.coverage.stopped).toBe('truncated')
    expect(r.note).toContain('市面上就这些')
  })
})

describe('取不到数时的处理——宁可说没比，不许悄悄编一个', () => {
  it('比价拿不到可算的价格 → 不拿列表参考价顶替，进 unranked', async () => {
    const r = await runPurchaseDecision(C, deps({ price: async () => [{ platform: '京东', price: '暂无报价' }] }))
    expect(r.products).toHaveLength(0)
    expect(r.unranked.filter((u) => u.reason === 'no_price')).toHaveLength(2)
    expect(r.coverage.priced).toBe(0)
  })

  it('**用户会转手但残值查不到 → 不装死也不编数**：按买入价排名，整份回执明说没扣残值', async () => {
    // 上一版把这些台全部踢出比较：前沿为空，模型手里没东西可交，只能拿一桌问题填空（2026-09-03 活体）。
    // 现在退到买入价——有东西可交，但口径要大声写在回执里，别只藏在某台的 basis 里。
    const r = await runPurchaseDecision(
      { ...C, willResell: true },
      deps({ residual: async (m) => (m === 'A手机' ? null : { resale: 2250, basis: '转转最高回收价' }) }),
    )
    expect(r.residual.mode).toBe('purchase_only')
    expect(r.residual.note).toContain('没扣残值')
    expect(r.note).toContain('没扣残值')
    expect(r.products.map((p) => p.name).sort()).toEqual(['A手机', 'B手机'])
    // **口径全体统一**：B 明明查到了保值率，也不单独扣——一台扣一台不扣，两个数不在同一根轴上。
    for (const p of r.products) {
      expect((p.cost as { resale: number }).resale).toBe(0)
      expect(p.cost_unit).toBe('元/天（未扣残值）')
    }
    expect(r.coverage.residualKnown).toBe(1)
  })

  it('每台都查到保值率 → known，代价是真的日均持有成本', async () => {
    const r = await runPurchaseDecision({ ...C, willResell: true }, deps())
    expect(r.residual.mode).toBe('known')
    const a = r.products.find((p) => p.name === 'A手机')!
    expect((a.cost as { resale: number }).resale).toBe(1950)
    expect(a.cost_unit).toBe('元/天')
    expect(r.coverage.residualKnown).toBe(2)
  })

  it('回收价高过买入价 = 代理失真，不许封顶成「持有成本 0」；同伴不足就整轮退回按买入价并在 gaps 说清', async () => {
    const r = await runPurchaseDecision(
      { ...C, willResell: true },
      deps({ residual: async () => ({ resale: 9999, basis: '转转最高回收价' }) }),
    )
    expect(r.residual.mode).toBe('purchase_only')
    expect(r.coverage.residualKnown).toBe(0)
    const a = r.products.find((p) => p.name === 'A手机')!
    expect(a.comparable_cost).toBeGreaterThan(0)
    expect((a.cost as { basis: string }).basis).toContain('代理失真')
    expect(r.gaps.filter((g) => g.stage === 'residual').map((g) => g.subject).sort()).toEqual(['A手机', 'B手机'])
    expect(r.gaps[0]!.reason).toContain('高过买入价')
  })

  it('不转手那一档：残值按 0 算是**对的**，mode=none', async () => {
    const r = await runPurchaseDecision(C, deps())
    const cost = r.products[0]!.cost as { kind: string; resale: number; basis: string }
    expect(cost.resale).toBe(0)
    expect(r.residual.mode).toBe('none')
    expect(r.coverage.residualKnown).toBe(0)
  })

  it('回执自带字段图例——软条件明说"不是过滤条件"，模型不许脑补成硬门槛', async () => {
    const r = await runPurchaseDecision(C, deps())
    expect(r.legend.softCriteria).toContain('不是过滤条件')
    expect(r.legend.no_mention).toBeTruthy()
  })

  it('阶段进度按顺序报出来——异步轮询的调用方靠它知道卡在哪一步', async () => {
    const stages: string[] = []
    await runPurchaseDecision(C, deps({ onStage: (stage) => { stages.push(stage) } }))
    expect(stages).toEqual(['universe', 'reviews', 'signal', 'price', 'result'])
  })

  it('一篇横评读挂了，前面攒下的照常交货，并记进 gaps', async () => {
    let n = 0
    const r = await runPurchaseDecision(
      C,
      deps({
        reviews: async () => [REVIEW, { ...REVIEW, id: 'r2', title: '第二篇' }],
        signal: async () => {
          if (n++ === 1) throw new Error('LLM 梯子挂了')
          return {
            mentions: [{ model: 'A手机', attribute: '夜景', quote: 'A 的夜景最好' }],
            unmatched: [],
            dropped: [],
          }
        },
      }),
    )
    expect(r.coverage.reviewsRead).toBe(1)
    expect(r.gaps.find((g) => g.stage === 'signal')?.reason).toBe('LLM 梯子挂了')
    expect(r.products.map((p) => p.name)).toEqual(['A手机'])
  })
})

describe('逃生项与越界计数是一等回执字段', () => {
  it('横评提到全集外的型号 → 计数 + 保留原文写法，旁白点名', async () => {
    const r = await runPurchaseDecision(
      C,
      deps({
        signal: async () => ({
          mentions: [{ model: 'A手机', attribute: '夜景', quote: 'A 好' }],
          unmatched: [{ model: NOT_IN_SET, raw: 'Pixel 10 Pro', attribute: '算法', quote: '谷歌算法' }],
          dropped: [],
        }),
      }),
    )
    expect(r.coverage.unmatched).toBe(1)
    expect(r.unmatchedRaw).toEqual(['Pixel 10 Pro'])
    expect(r.note).toContain('不在全集里')
  })

  it('缺字段被事后校验丢掉 → 计入 droppedMentions，旁白提示结论要打折', async () => {
    const r = await runPurchaseDecision(
      C,
      deps({
        signal: async () => ({
          mentions: [{ model: 'A手机', attribute: '夜景', quote: 'A 好' }],
          unmatched: [],
          dropped: [{ raw: {}, reason: 'missing_field' }],
        }),
      }),
    )
    expect(r.coverage.droppedMentions).toBe(1)
    expect(r.note).toContain('缺字段')
  })
})

describe('体验序', () => {
  it('按被点名篇数排 dense rank，并列同名次', async () => {
    const r = await runPurchaseDecision(
      C,
      deps({
        reviews: async () => [REVIEW, { ...REVIEW, id: 'r2' }],
        signal: async (rev) => ({
          // A 两篇都点名，B 只有一篇 → A rank 1，B rank 2
          mentions:
            rev.id === 'r1'
              ? [
                  { model: 'A手机', attribute: '夜景', quote: 'q' },
                  { model: 'B手机', attribute: '长焦', quote: 'q' },
                ]
              : [{ model: 'A手机', attribute: '夜景', quote: 'q' }],
          unmatched: [],
          dropped: [],
        }),
      }),
    )
    const rankOf = Object.fromEntries(r.products.map((p) => [p.name, p.experience_rank]))
    expect(rankOf['A手机']).toBe(1)
    expect(rankOf['B手机']).toBe(2)
  })

  it('同一篇里被夸多次只算一篇——一篇长文顶不动名次', async () => {
    const r = await runPurchaseDecision(
      C,
      deps({
        signal: async () => ({
          mentions: [
            { model: 'A手机', attribute: '夜景', quote: 'q1' },
            { model: 'A手机', attribute: '长焦', quote: 'q2' },
            { model: 'B手机', attribute: '人像', quote: 'q3' },
          ],
          unmatched: [],
          dropped: [],
        }),
      }),
    )
    expect(r.products.every((p) => p.experience_rank === 1)).toBe(true)
  })
})

describe('价格合理性闸 + evidence 出处', () => {
  it('**促销文案的碎数字不许赢**——不筛就是最小的那个垃圾当买入价', async () => {
    // 活体 2026-09-02：模型拒绝下结论，理由是回执里出现 9.11 元、12.74 元的"手机价"。
    // 抠价是"取这一行第一个数"，促销行混进来后 Math.min 必然选中垃圾，而表照样画得出来。
    const r = await runPurchaseDecision(
      C,
      deps({
        price: async () => [
          { platform: '优惠', price: '省9.11元', amount: 9.11 },
          { platform: '京东', price: '3899元', amount: 3899 },
        ],
      }),
    )
    const cost = r.products[0]!.cost as { purchase: number }
    expect(cost.purchase).toBe(3899)
  })

  it('一行合理的都没有 → 进 unranked 并说清区间，不拿垃圾价顶上', async () => {
    const r = await runPurchaseDecision(C, deps({ price: async () => [{ platform: '优惠', price: '省9元', amount: 9 }] }))
    expect(r.products).toHaveLength(0)
    const u = r.unranked.find((x) => x.reason === 'no_price')
    expect(u?.detail).toMatch(/合理区间/)
  })

  it('**evidence 必须带出处 url**——空 url 等于无出处断言', async () => {
    const r = await runPurchaseDecision(C, deps())
    expect(r.products[0]!.evidence[0]).toMatchObject({ url: REVIEW.url })
    expect(r.products[0]!.evidence[0]!.source).toContain(REVIEW.title)
  })
})

describe('回执瘦身——被截断的话，最要紧的那部分正好在后面', () => {
  it('**unranked 只举例、不列全**，精确数字进 unrankedCounts', async () => {
    // 活体撞到过：277 台里 268 台没被点名，逐条列出来把工具结果撑到被截断，
    // 而 frontier/dominated 排在后面正好被切掉——模型于是说"没有可核对地呈现"、拒绝下结论。
    const many = Array.from({ length: 50 }, (_, i) => ({ model: `M${i}`, listPrice: 3000 }))
    const r = await runPurchaseDecision(
      C,
      deps({
        universe: async () => ({ models: many, source: 'catalog:@pkg/lib/phones', truncated: false }),
        signal: async () => ({ mentions: [], unmatched: [], dropped: [] }),
      }),
    )
    expect(r.unrankedCounts.no_mention).toBe(50)   // 数字是精确的
    expect(r.unranked.length).toBeLessThanOrEqual(4) // 列出来的只是样本
  })

  it('unmatchedRaw 也封顶，精确条数在 coverage', async () => {
    const raws = Array.from({ length: 40 }, (_, i) => ({ model: NOT_IN_SET, raw: `X${i}`, attribute: 'a', quote: 'q' }))
    const r = await runPurchaseDecision(
      C,
      deps({ signal: async () => ({ mentions: [], unmatched: raws, dropped: [] }) }),
    )
    expect(r.coverage.unmatched).toBe(40)
    expect(r.unmatchedRaw).toHaveLength(20)
  })

  it('**没过闸的比价行不进回执**——展示出来的东西也是结论的一部分', async () => {
    const r = await runPurchaseDecision(
      C,
      deps({
        price: async () => [
          { platform: '优惠', price: '省5.9元', amount: 5.9 },
          { platform: '京东', price: '3899元', amount: 3899 },
        ],
      }),
    )
    expect(r.products[0]!.prices.map((p) => p.platform)).toEqual(['京东'])
  })
})


describe('比价行先看标题：不是这台 / 不是现售新品的行不参与取最小价', () => {
  it('已结束的优惠和兄弟款便宜也不能赢——买入价取的是这台现售新品里最低的', async () => {
    const r = await runPurchaseDecision(
      C,
      deps({
        price: async (m) =>
          m === 'A手机'
            ? [
                { platform: '淘宝', title: '已结束A手机 12GB+256GB', price: '2999元', amount: 2999 },
                { platform: '京东', title: 'A手机 Pro 12GB+256GB', price: '3299元', amount: 3299 },
                { platform: '京东', title: '【95成新】A手机', price: '3099元', amount: 3099 },
                { platform: '京东自营', title: 'A手机 手机 12GB+256GB', price: '3899元', amount: 3899 },
              ]
            : [{ platform: '京东', price: '4499 元', amount: 4499 }],
      }),
    )
    const cost = r.products.find((p) => p.name === 'A手机')?.cost
    expect(cost && 'purchase' in cost ? cost.purchase : undefined).toBe(3899)
  })

  it('全是已结束 / 兄弟款 → no_price，detail 说清是这个原因，不是"没人卖"', async () => {
    const r = await runPurchaseDecision(
      C,
      deps({
        price: async (m) =>
          m === 'A手机'
            ? [{ platform: '淘宝', title: '已结束A手机 12GB+256GB', price: '2999元', amount: 2999 }]
            : [{ platform: '京东', price: '4499 元', amount: 4499 }],
      }),
    )
    const u = r.unranked.find((x) => x.model === 'A手机')
    expect(u?.reason).toBe('no_price')
    expect(u?.detail).toContain('现售新品报价')
    // 只报"没有一行合格"是不够的：必须说清**被谁拒的**、**样例长什么样**、**问出去的是哪个串**。
    // 缺这三样，排查就只能重新手工侦察一遍（活体 2026-09-04 为此连着猜错三次原因）。
    expect(u?.detail).toContain('已结束/二手')
    expect(u?.detail).toMatch(/「.*已结束A手机.*」/)
    expect(u?.detail).toContain('问的是「A手机」')
  })

  it('比价 0 行且有成员没答上来 → gaps 里 stage=price 写明是谁挂了', async () => {
    const r = await runPurchaseDecision(
      C,
      deps({
        price: async (m) =>
          m === 'A手机'
            ? { rows: [], warnings: ['manmanbuy: timeout after 45000ms'] }
            : [{ platform: '京东', price: '4499 元', amount: 4499 }],
      }),
    )
    expect(r.gaps.find((g) => g.stage === 'price' && g.subject === 'A手机')?.reason).toContain('timeout after 45000ms')
    expect(r.unranked.find((x) => x.model === 'A手机')?.detail).toContain('一行都没回')
  })
})


describe('逐台取数有并行上限——十台一起打会把比价源打成空壳页', () => {
  it('同时在飞的比价不超过 PRICE_CONCURRENCY，且结果顺序不变', async () => {
    const models = ['A手机', 'B手机', 'C手机', 'D手机', 'E手机', 'F手机', 'G手机']
    let inFlight = 0
    let peak = 0
    const r = await runPurchaseDecision(
      C,
      deps({
        universe: async () => ({ models: models.map((m) => ({ model: m, listPrice: 3999 })), source: 'catalog:@pkg/lib/phones', truncated: false }),
        signal: async () => ({ mentions: models.map((m) => ({ model: m, attribute: '夜景', quote: m })), unmatched: [], dropped: [] }),
        price: async (m) => {
          inFlight++
          peak = Math.max(peak, inFlight)
          await new Promise((res) => setTimeout(res, 5))
          inFlight--
          return [{ platform: '京东', price: '3899 元', amount: 3899 }]
        },
      }),
    )
    expect(peak).toBeLessThanOrEqual(PRICE_CONCURRENCY)
    expect(peak).toBeGreaterThan(1)
    expect(r.products.map((p) => p.name)).toEqual(models)
  })
})


describe('缺字段被丢的抽取行要把原样带进回执', () => {
  it('droppedRaw 列出被丢的行（截断），不只给一个数', async () => {
    const r = await runPurchaseDecision(
      C,
      deps({
        signal: async () => ({
          mentions: [{ model: 'A手机', attribute: '夜景', quote: 'A 好' }],
          unmatched: [],
          dropped: [{ raw: { model: 'B手机', attribute: '', quote: 'B 也好' }, reason: 'missing_field' }],
        }),
      }),
    )
    expect(r.coverage.droppedMentions).toBe(1)
    expect(r.droppedRaw).toEqual(['{"model":"B手机","attribute":"","quote":"B 也好"}'])
  })
})


describe('查不到上一代的台借同伴的实测保值率估——取最保守的那个', () => {
  const three = () => ({
    mentions: [
      { model: 'A手机', attribute: '夜景', quote: 'A' },
      { model: 'B手机', attribute: '长焦', quote: 'B' },
      { model: 'C手机', attribute: '续航', quote: 'C' },
    ],
    unmatched: [],
    dropped: [],
  })

  it('2 台实测 + 1 台查不到 → 仍是 known；查不到的按最低保值率估，basis 带「估的」，gap 改口', async () => {
    const r = await runPurchaseDecision(
      { ...C, willResell: true },
      deps({
        signal: async () => three(),
        // A 保值率 1950/3899 ≈ 50.01%，B 2000/4499 ≈ 44.45% → 取 B 的
        residual: async (m) => (m === 'C手机' ? null : { resale: m === 'A手机' ? 1950 : 2000, basis: '转转最高回收价' }),
      }),
    )
    expect(r.residual.mode).toBe('known')
    expect(r.residual.note).toContain('1 台回收平台查不到上一代')
    expect(r.coverage.residualKnown).toBe(2)
    expect(r.coverage.residualEstimated).toBe(1)
    const c = r.products.find((p) => p.name === 'C手机')!
    expect((c.cost as { resale: number }).resale).toBe(Math.round(4499 * (2000 / 4499)))
    expect((c.cost as { basis: string }).basis).toMatch(/^估的：/)
    expect(r.gaps.find((g) => g.stage === 'residual' && g.subject === 'C手机')?.reason).toContain('已按同档最保守保值率')
    // 实测的两台照常扣自己的
    expect((r.products.find((p) => p.name === 'A手机')!.cost as { resale: number }).resale).toBe(1950)
  })

  it('只有 1 台实测 → 不够同伴，整轮仍退回按买入价', async () => {
    const r = await runPurchaseDecision(
      { ...C, willResell: true },
      deps({
        signal: async () => three(),
        residual: async (m) => (m === 'A手机' ? { resale: 1950, basis: '转转最高回收价' } : null),
      }),
    )
    expect(r.residual.mode).toBe('purchase_only')
    expect(r.coverage.residualEstimated).toBe(0)
  })

  it('估的数只会让它偏贵：同伴里最保守的保值率，不是平均', async () => {
    const r = await runPurchaseDecision(
      { ...C, willResell: true },
      deps({
        signal: async () => three(),
        residual: async (m) => (m === 'C手机' ? null : { resale: m === 'A手机' ? 3000 : 1000, basis: 'x' }),
      }),
    )
    const c = r.products.find((p) => p.name === 'C手机')!
    expect((c.cost as { resale: number }).resale).toBe(Math.round(4499 * (1000 / 4499)))
  })
})


describe('查到的残值高过买入价 → 代理失真，走同伴估算，不封顶', () => {
  it('2 台实测正常 + 1 台失真 → known；失真那台按最保守保值率估、gap 写明失真、不进 residualKnown', async () => {
    const r = await runPurchaseDecision(
      { ...C, willResell: true },
      deps({
        signal: async () => ({
          mentions: [
            { model: 'A手机', attribute: '夜景', quote: 'A' },
            { model: 'B手机', attribute: '长焦', quote: 'B' },
            { model: 'C手机', attribute: '续航', quote: 'C' },
          ],
          unmatched: [],
          dropped: [],
        }),
        // A 50.01%，B 44.45%，C 上代回收 5000 > 买入 4499（失真）
        residual: async (m) => ({ resale: m === 'A手机' ? 1950 : m === 'B手机' ? 2000 : 5000, basis: '转转最高回收价' }),
      }),
    )
    expect(r.residual.mode).toBe('known')
    expect(r.coverage.residualKnown).toBe(2)
    expect(r.coverage.residualEstimated).toBe(1)
    const c = r.products.find((p) => p.name === 'C手机')!
    const ratio = 2000 / 4499
    expect((c.cost as { resale: number }).resale).toBe(Math.floor(4499 * ratio))
    expect((c.cost as { basis: string }).basis).toMatch(/^估的：查到的上代回收价 ¥5000 高过买入价/)
    expect(c.comparable_cost).toBeGreaterThan(0)
    expect(r.gaps.find((g) => g.stage === 'residual' && g.subject === 'C手机')?.reason).toContain('代理失真')
    // 估的比例不高于同伴最低（向下取整保证）
    expect((c.cost as { resale: number }).resale / 4499).toBeLessThanOrEqual(ratio)
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// 快消品档：横评说品牌、全集是 SKU。样本取自活体 2026-09-04 那一轮纸巾（run 98c45f5d），
// 那一轮的结果是 named:0 / 前沿 0 台——**没有一处报错**，看起来像"横评不提这些牌子"。
// ─────────────────────────────────────────────────────────────────────────────
const TISSUE: DecisionConstraints = {
  category: ['纸巾'],
  priceRange: {},
  softCriteria: [],
  holdDays: 90,
  willResell: false,
}

const TISSUE_REVIEW = { id: 't1', title: '纸巾横评', url: 'https://example.com/t1' }

/** 全集是带规格的 SKU，横评只说品牌——两边差一级粒度。 */
function tissueDeps(over: Partial<DecisionDeps> = {}): DecisionDeps {
  const listPrice: Record<string, number> = {
    '洁柔粉Face 3层110抽*24包': 45,
    '洁柔粉Face 3层100抽*3包': 12,
    '维达细韧 3层100抽*6包S码': 30,
  }
  return {
    universe: async () => ({
      models: Object.entries(listPrice).map(([model, p]) => ({ model, listPrice: p })),
      source: 'discovery:catalog',
      truncated: true,
      // 发现循环那档的 listPrice 是 catalog 域用 price_search 验过在售的——比价空手时可以退到它。
      listPriceVerified: true,
    }),
    reviews: async () => [TISSUE_REVIEW],
    // 模型逐字找不到 SKU，只能走逃生项带回品牌原文——这正是活体那一轮的形状。
    signal: async () => ({
      mentions: [],
      unmatched: [
        { model: NOT_IN_SET, attribute: '柔软', quote: '洁柔最柔', raw: '洁柔' },
        { model: NOT_IN_SET, attribute: '厚实', quote: '维达很厚', raw: '维达' },
        { model: NOT_IN_SET, attribute: '好', quote: '博主自称', raw: '鱼眉' },
      ],
      dropped: [],
    }),
    // 比价问的是**品牌**，回来的每一行自己带规格——用量和价格来自同一行（`pickCheapestByUnit`）。
    price: async (m) => {
      if (m === '洁柔') return [
        { platform: '京东', title: '洁柔 粉Face柔韧抽纸 3层110抽×24包', price: '45 元', amount: 45 },
        { platform: '京东', title: '洁柔 粉Face软抽 3层100抽×3包', price: '12 元', amount: 12 },
      ]
      if (m === '维达') return [{ platform: '京东', title: '维达 细韧抽纸 3层100抽×6包', price: '30 元', amount: 30 }]
      return []
    },
    residual: async () => null,
    ...over,
  }
}

describe('快消品：横评说品牌、全集是 SKU', () => {
  it('按品牌聚合之后才排得出体验序——不聚就是 named:0（活体那一轮的真实下场）', async () => {
    const r = await runPurchaseDecision(TISSUE, tissueDeps())
    expect(r.coverage.named).toBeGreaterThan(0)
    expect(r.frontier.length).toBeGreaterThan(0)
    expect(r.products.map((p) => p.name).sort()).toEqual(['洁柔', '维达'])
  })

  it('成本轴是单位价，不是整包价——否则 3 包装会斩掉 24 包装', async () => {
    const r = await runPurchaseDecision(TISSUE, tissueDeps())
    const jr = r.products.find((p) => p.name === '洁柔')!
    // ¥45 / 2640 抽 = 1.70 元/百抽。若按整包价，¥12 那条会赢——而它三天就用完了。
    expect(jr.comparable_cost).toBeCloseTo(1.7045, 3)
    expect(jr.cost_unit).toBe('元/百抽')
    expect(jr.cost).toMatchObject({ kind: 'unit', quantity: 2640, unit: '抽', sku: '洁柔 粉Face柔韧抽纸 3层110抽×24包' })
  })

  // 反过来了，而且是活体逼的（run 82779f12）：事先按 listPrice 猜的"代表 SKU"会被选成长尾
  // 促销款（联名/囤货装），拿那种长串比价回来的几乎全是历史优惠；问品牌名回来的多数是现售。
  // 用量改由**成交那一行**自己带，于是价格和用量同源，且那一行就是用户真能买的东西。
  it('比价问品牌名，用量取自成交那一行的标题', async () => {
    const asked: string[] = []
    const r = await runPurchaseDecision(
      TISSUE,
      tissueDeps({
        price: async (m) => {
          asked.push(m)
          return m === '洁柔' ? [{ platform: '京东', title: '洁柔 粉Face柔韧抽纸 3层110抽×24包', price: '45 元', amount: 45 }] : []
        },
      }),
    )
    expect(asked).toContain('洁柔')
    expect(asked).not.toContain('洁柔粉Face 3层110抽*24包')
    expect(r.products.find((p) => p.name === '洁柔')?.cost).toMatchObject({ sku: '洁柔 粉Face柔韧抽纸 3层110抽×24包', quantity: 2640 })
  })

  it('认领不到任何 SKU 的点名（抽取端噪声）不进候选，留在 unmatchedRaw 里', async () => {
    const r = await runPurchaseDecision(TISSUE, tissueDeps())
    expect(r.products.map((p) => p.name)).not.toContain('鱼眉')
    expect(r.unmatchedRaw).toContain('鱼眉')
    expect(r.unmatchedRaw).not.toContain('洁柔') // 认领成功了就不再是"没配上"
  })

  // 手机那条路必须寸步不动：横评说的就是全集里的名字，精确匹配在上游就命中，
  // unmatched 是空的 → 根本不进聚合闸 → 成本轴仍是日均持有成本。
  it('手机那条路不受影响：仍按日均持有成本比', async () => {
    const r = await runPurchaseDecision(C, deps())
    expect(r.products[0]!.cost_unit).toBe('元/天')
    expect(r.products[0]!.cost.kind).toBe('ownership')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 比价整轮空手 → 退到枚举页价。样本来自活体 2026-09-04 run 03eef4f2：
// 6 个品牌全部 no_price、前沿 0 台，**而价格本来就在 universe 里带着**。
// ─────────────────────────────────────────────────────────────────────────────
describe('买入价口径：比价空手时整轮退到枚举页价', () => {
  const noPrice = { price: async () => [] as never[] }

  it('比价一行都没回 → 整轮改用 listPrice，前沿出得来，并明说是标价', async () => {
    const r = await runPurchaseDecision(TISSUE, tissueDeps(noPrice))
    expect(r.pricing.mode).toBe('listing')
    expect(r.pricing.note).toContain('标价不是到手价')
    expect(r.frontier.length).toBeGreaterThan(0)
    // 退回来的台不再算"没价格"——否则它既在前沿里、又在没进比较的名单里，回执自相矛盾。
    expect(r.unranked.filter((u) => u.reason === 'no_price')).toHaveLength(0)
  })

  it('单位价照样按 listPrice 算，不是整包价', async () => {
    const r = await runPurchaseDecision(TISSUE, tissueDeps(noPrice))
    const jr = r.products.find((p) => p.name === '洁柔')!
    expect(jr.comparable_cost).toBeCloseTo(1.7045, 3) // ¥45 / 2640 抽
    expect(jr.cost_unit).toBe('元/百抽')
  })

  // **不许逐台顶替**：一台实付价、一台标价，两个数不在同一根轴上，而支配运算照跑不误。
  it('比价拿到了就一律用比价，绝不混用', async () => {
    const r = await runPurchaseDecision(TISSUE, tissueDeps())
    expect(r.pricing.mode).toBe('compared')
    expect(r.products.every((p) => p.prices.every((x) => x.platform !== '枚举页'))).toBe(true)
  })

  it('能退的不足 2 台就不退——退了也算不出支配关系，不如保持诚实', async () => {
    const r = await runPurchaseDecision(
      TISSUE,
      tissueDeps({
        ...noPrice,
        universe: async () => ({
          models: [{ model: '洁柔粉Face 3层110抽*24包', listPrice: 45 }],
          source: 'discovery:catalog',
          truncated: true,
          listPriceVerified: true,
        }),
      }),
    )
    expect(r.pricing.mode).toBe('compared')
    expect(r.unrankedCounts.no_price).toBeGreaterThan(0)
  })

  // 闸门是**"这个源的 listPrice 验过在售没有"**，不是"缺不缺价"。产品库直查给的是目录标价
  // （没验在售、与街价还差一个折扣），拿它顶替会把一次真实的取数失败洗成一份看着挺像样的前沿。
  it('源没申报 listPriceVerified 就绝不回落——哪怕每台都带着 listPrice', async () => {
    const r = await runPurchaseDecision(
      TISSUE,
      tissueDeps({
        price: async () => [],
        universe: async () => ({
          models: [
            { model: '洁柔粉Face 3层110抽*24包', listPrice: 45 },
            { model: '维达细韧 3层100抽*6包S码', listPrice: 30 },
          ],
          source: 'catalog:@pkg/lib/phones',
          truncated: false,
          // listPriceVerified 缺省 = false
        }),
      }),
    )
    expect(r.pricing.mode).toBe('compared')
    expect(r.products).toHaveLength(0)
    expect(r.unrankedCounts.no_price).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 回灌枚举。样本来自活体 2026-09-04 第七轮纸巾（run 7e73148c）：发现循环整份飘到了海外
// 商用擦手纸（Viva 布巾 / Tork 多折手巾 / Joe Multifold），全集 9 件、`named: 0`、
// `priced: 0`，整轮空转——而横评那一端**七轮都是同样六个牌子**，一直摆在 unmatchedRaw 里。
// ─────────────────────────────────────────────────────────────────────────────
describe('回灌枚举：横评反复点名、全集里没有的名字，是枚举漏了的硬证据', () => {
  /** 全集飘到了海外商用擦手纸，横评说的是国产抽纸品牌——两边一个都对不上。 */
  function driftedDeps(over: Partial<DecisionDeps> = {}): DecisionDeps {
    return {
      universe: async () => ({
        models: [
          { model: 'Viva Signature 布巾，3 雙捲，每捲 86 張', listPrice: 210 },
          { model: 'Tork 多折手巾 白色 H2，16 x 250，MB540A', listPrice: 480 },
        ],
        source: 'discovery:catalog',
        truncated: false,
      }),
      reviews: async () => [TISSUE_REVIEW],
      signal: async () => ({
        mentions: [],
        unmatched: [
          { model: NOT_IN_SET, attribute: '柔软', quote: '洁柔最柔', raw: '洁柔（C&S）' },
          { model: NOT_IN_SET, attribute: '厚实', quote: '维达很厚', raw: '维达（Vinda）' },
          { model: NOT_IN_SET, attribute: '好', quote: '博主自称', raw: '鱼眉' },
        ],
        dropped: [],
      }),
      price: async (m) => {
        if (m === '洁柔（C&S）') return [
          { platform: '京东', title: '洁柔 粉Face柔韧抽纸 3层110抽×24包', price: '45 元', amount: 45 },
          { platform: '京东', title: '洁柔 粉Face软抽 3层100抽×3包', price: '12 元', amount: 12 },
        ]
        if (m === '维达（Vinda）') return [{ platform: '京东', title: '维达 细韧抽纸 3层100抽×6包', price: '30 元', amount: 30 }]
        return []
      },
      residual: async () => null,
      ...over,
    }
  }

  it('枚举飘了也不再空转：验到真买得到的补进全集，斩杀线跑得起来', async () => {
    const r = await runPurchaseDecision(TISSUE, driftedDeps())
    expect(r.coverage.seeded).toBe(2)
    expect(r.coverage.named).toBe(2)
    expect(r.products.map((p) => p.name).sort()).toEqual(['洁柔（C&S）', '维达（Vinda）'])
    // 洁柔 ¥45/(110×24)=2640 抽 → 1.70 元/百抽；维达 ¥30/(100×6)=600 抽 → 5.00（层数是厚度，不乘）。
    // 点名篇数并列 → 单位价更低的洁柔斩维达。
    expect(r.frontier).toEqual(['洁柔（C&S）'])
    expect(r.dominated.map((d) => d.name)).toEqual(['维达（Vinda）'])
  })

  // 回灌的**唯一凭据**是"真买得到"。只凭被点名就收进全集，等于拿横评凑候选——
  // 那正是这条线要根治的病（没有出处的候选集不是不完整，是误导）。
  it('比价空手的名字不收——只被点名不算数，仍留在 unmatchedRaw 里', async () => {
    const r = await runPurchaseDecision(TISSUE, driftedDeps())
    expect(r.products.map((p) => p.name)).not.toContain('鱼眉')
    expect(r.unmatchedRaw).toContain('鱼眉')
    expect(r.unmatchedRaw).not.toContain('洁柔（C&S）') // 收进来了就不再是"没配上"
  })

  // 回灌来的出处比枚举来的弱一档：只证明这个牌子买得到，没证明这个品类还有哪些同类没被提及。
  it('补出来的全集一律标 truncated，且回执把"是补出来的"说出来', async () => {
    const r = await runPurchaseDecision(TISSUE, driftedDeps())
    expect(r.coverage.stopped).toBe('truncated')
    expect(r.note).toContain('补进来')
    expect(r.gaps.some((g) => g.stage === 'universe' && g.reason.includes('枚举漏了'))).toBe(true)
  })

  // 同一个名字问两遍不但白烧一次比价源，还可能拿回不一样的行（比价源按关键词返回一整片），
  // 于是"回灌验到了"和"取价没拿到"能同时成立——最难查的那种自相矛盾。
  it('回灌问过的行留给取价用，同一个名字只查一次比价', async () => {
    const asked: string[] = []
    const r = await runPurchaseDecision(
      TISSUE,
      driftedDeps({
        price: async (m) => {
          asked.push(m)
          return m === '维达（Vinda）' ? [{ platform: '京东', title: '维达 细韧抽纸 3层100抽×6包', price: '30 元', amount: 30 }] : []
        },
      }),
    )
    expect(asked.filter((a) => a === '维达（Vinda）')).toHaveLength(1)
    expect(r.products.map((p) => p.name)).toEqual(['维达（Vinda）'])
  })

  // 手机那条路：横评说的名字全集里就有，精确匹配在上游命中，unmatched 为空 → 根本不进回灌。
  it('unmatched 为空时不回灌，也不多问一次比价', async () => {
    const asked: string[] = []
    const r = await runPurchaseDecision(C, deps({ price: async (m) => { asked.push(m); return [{ platform: '京东', price: '3899 元', amount: 3899 }] } }))
    expect(r.coverage.seeded).toBe(0)
    expect(r.coverage.stopped).toBe('complete')
    expect(asked.sort()).toEqual(['A手机', 'B手机'])
  })
})
