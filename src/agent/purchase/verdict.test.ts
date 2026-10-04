import { describe, it, expect } from 'vitest'
import { computeDomination, type NormalizedProduct } from './verdict.ts'

/** 一台进了比较的产品:只关心两根轴。 */
function p(name: string, comparable_cost: number, experience_rank: number, cost_unit = '元'): NormalizedProduct {
  return {
    name,
    prices: [{ platform: '京东', price: `${comparable_cost}元` }],
    cost: { kind: 'once', amount: comparable_cost },
    experience_rank,
    pros: ['x'],
    cons: ['y'],
    fit: 'z',
    evidence: [{ source: 'B站 @评测', url: 'https://b.example/v' }],
    comparable_cost,
    cost_unit,
  }
}

/** 日均持有成本档:自己折算 (买入价 − 残值) / 天数,和 job 里同一个式子。 */
function own(name: string, purchase: number, resale: number, days: number, rank: number): NormalizedProduct {
  return {
    ...p(name, (purchase - resale) / days, rank, '元/天'),
    cost: { kind: 'ownership', purchase, resale, days, basis: '同代机三年保值率,新浪财经 2026-08' },
  }
}

describe('computeDomination', () => {
  it('互不支配时两个都留在前沿', () => {
    // 长城便宜但体验序靠后,龟牌体验好但贵——谁也斩不掉谁。
    const r = computeDomination([p('长城', 8.8, 2), p('龟牌', 29, 1)])
    expect(r.dominated).toEqual([])
    expect(r.frontier).toEqual(['长城', '龟牌'])
  })

  it('两根轴都不劣 = 斩杀,理由里带上双方的实测数字', () => {
    const r = computeDomination([p('长城', 8.8, 1), p('龟牌', 29, 2)])
    expect(r.frontier).toEqual(['长城'])
    expect(r.dominated).toHaveLength(1)
    expect(r.dominated[0]).toMatchObject({ name: '龟牌', by: '长城' })
    expect(r.dominated[0]!.why).toContain('8.8')
    expect(r.dominated[0]!.why).toContain('29')
  })

  it('日均持有成本会翻转结论:买入价更贵的反而斩掉便宜的,而被斩的是中间那一档', () => {
    // 模型的核心论断(docs/research/consumption-frontier-model.md 第三节)。
    // 高保值旗舰 (6000−3000)/1095≈2.74 元/天;低保值旗舰 (5000−1200)/1095≈3.47;低价机 1500/1095≈1.37。
    const r = computeDomination([own('高保值旗舰', 6000, 3000, 1095, 1), own('低保值旗舰', 5000, 1200, 1095, 2), own('低价机', 1500, 0, 1095, 3)])
    // 买入价 6000 > 5000,但日均更低且体验更好 → 反过来斩掉它。
    expect(r.dominated.map((d) => d.name)).toEqual(['低保值旗舰'])
    expect(r.dominated[0]!.by).toBe('高保值旗舰')
    expect(r.dominated[0]!.why).toContain('2.74 元/天')
    // 最便宜那档没被斩:前沿是「体验最好」和「最便宜」两端,死的是中间。
    expect(r.frontier).toEqual(['高保值旗舰', '低价机'])
  })

  it('残值 0(用户不打算转手)会改变前沿的形状', () => {
    // 同样两台机,残值一律记 0 → 贵的那台不再占优,反被便宜的斩掉。
    const r = computeDomination([own('高保值旗舰', 6000, 0, 1095, 2), own('低价机', 1500, 0, 1095, 1)])
    expect(r.dominated.map((d) => d.name)).toEqual(['高保值旗舰'])
  })

  it('两项完全并列时互不支配——支配要求至少一根轴严格更优', () => {
    const r = computeDomination([p('A', 8.8, 2), p('B', 8.8, 2)])
    expect(r.dominated).toEqual([])
    expect(r.frontier).toHaveLength(2)
  })

  it('被多个候选支配时,记最便宜的那个斩杀者', () => {
    const r = computeDomination([p('贵而差', 100, 3), p('便宜', 10, 1), p('中', 50, 2)])
    expect(r.dominated.find((d) => d.name === '贵而差')?.by).toBe('便宜')
  })

  it('「未扣残值」那一档的单位也按两位小数排版', () => {
    const r = computeDomination([p('A', 3899 / 730, 2, '元/天（未扣残值）'), p('B', 2999 / 730, 1, '元/天（未扣残值）')])
    expect(r.dominated[0]!.why).toContain('4.11 元/天（未扣残值）')
  })
})
