import { describe, it, expect } from 'vitest'
import { parseUnitSpec, foldByMention, unitCost, pickRepresentative, pickCheapestByUnit } from './spec-parse.ts'

// 样本全部来自活体 2026-09-04 那一轮纸巾（run 98c45f5d）的真实 universe / unmatchedRaw，
// **不是编的**——这条线上"凭想象写解析器"是明令禁止的。
describe('parseUnitSpec', () => {
  it('抽出数量和单位：包装数要相乘，层数是厚度不是数量', () => {
    expect(parseUnitSpec('洁柔粉Face 3层110抽*24包')).toEqual({ line: '洁柔粉Face', quantity: 2640, unit: '抽' })
    expect(parseUnitSpec('维达细韧 3层100抽*6包S码')).toEqual({ line: '维达细韧', quantity: 600, unit: '抽' })
    expect(parseUnitSpec('心相印茶语丝享 3层110抽*6包S码')).toEqual({ line: '心相印茶语丝享', quantity: 660, unit: '抽' })
  })

  // 「3层」若被乘进去，110抽*24包 会变成 7920——**贵三倍的东西看起来更便宜**，
  // 而支配运算照跑不误、没有一处会报错。这是这个文件里最该钉死的一条。
  it('层数绝不进数量', () => {
    expect(parseUnitSpec('某牌 4层100抽*1包')!.quantity).toBe(100)
    expect(parseUnitSpec('某牌 2层100抽*1包')!.quantity).toBe(100)
  })

  it('张 = 抽，归一成同一个单位（否则同一批货被判成两种不可比的东西）', () => {
    expect(parseUnitSpec('清风原木 4层1000张*1提')).toEqual({ line: '清风原木', quantity: 1000, unit: '抽' })
  })

  it('没有包装数就是 1 提/1 包', () => {
    expect(parseUnitSpec('得宝 3层90抽')).toEqual({ line: '得宝', quantity: 90, unit: '抽' })
  })

  // 电商标题垃圾：规格出现在最前面，切完产品线名是空的。宁可判不可解析，
  // 也不要造一个空名字的候选混进支配运算。
  it('解析不出产品线名 → null，不硬凑', () => {
    expect(parseUnitSpec('6提悬挂式6000张抽纸整箱更划算抽纸大包纸巾加厚家用干湿两用 4层1000张*1提')?.line).toBeTruthy()
    expect(parseUnitSpec('维达')).toBeNull() // 没有规格串
    expect(parseUnitSpec('')).toBeNull()
  })

  // 活体 2026-09-04 第一份结果就错在这里：「得宝Tempo 3层90抽无香抽纸整箱装 ¥18.1」被按
  // 一包 90 抽算成 20.11 元/百抽，而抽纸正常是 1–3 元/百抽（同轮洁柔 ¥45/2640抽 = 1.70）。
  // **差一个数量级，不报错、不缺失，就是安静地错**，而它是支配运算的 x 轴。
  it('名字说了整箱却没说箱里几包 → 用量未知，判 null，不按一包算', () => {
    expect(parseUnitSpec('得宝Tempo 3层90抽无香抽纸整箱装')).toBeNull()
    expect(parseUnitSpec('植护婴儿抽纸整箱装')).toBeNull()
    expect(parseUnitSpec('聪妈大包抽纸整箱装')).toBeNull()
  })

  it('写了包装数的「整箱」照常解析——有数字就不是未知', () => {
    expect(parseUnitSpec('洁柔 Face 软抽 3层 100抽×24包 整箱装')).toEqual({ line: '洁柔 Face 软抽', quantity: 2400, unit: '抽' })
  })

  it('卷纸是另一套单位，不归成抽——不同单位不许进同一个支配运算', () => {
    expect(parseUnitSpec('清风有芯卷纸 10卷')).toEqual({ line: '清风有芯卷纸', quantity: 10, unit: '卷' })
    expect(parseUnitSpec('某牌 3层180克*10卷')).toEqual({ line: '某牌', quantity: 1800, unit: '克' })
  })
})

describe('unitCost', () => {
  it('按每百单位算，便于人读', () => {
    expect(unitCost(45, 2640)).toBeCloseTo(1.7045, 3) // ¥45 / 2640 抽 → 1.70 元/百抽
    expect(unitCost(12, 300)).toBeCloseTo(4, 3)
  })
})

describe('pickRepresentative — 派谁去比价', () => {
  it('取单位价最低的那个 SKU，不是标价最低的', () => {
    // ¥45/2640抽 = 1.70 元/百抽 比 ¥12/300抽 = 4.00 元/百抽 便宜，尽管它标价贵三倍。
    // **这一条就是整个改动的理由**：不换算单位，3 包装会把 24 包装斩掉。
    const r = pickRepresentative([
      { model: '洁柔粉Face 3层110抽*24包', listPrice: 45 },
      { model: '洁柔粉Face 3层100抽*3包', listPrice: 12 },
    ])
    expect(r?.model).toBe('洁柔粉Face 3层110抽*24包')
    expect(r?.spec.quantity).toBe(2640)
  })

  it('单位混了按多数派切——1.7 元/百抽 和 0.3 元/百克 比大小毫无意义', () => {
    const r = pickRepresentative([
      { model: '清风原木 3层100抽*6包', listPrice: 30 },
      { model: '清风原木 3层120抽*6包', listPrice: 32 },
      { model: '清风有芯卷纸 3层180克*10卷', listPrice: 25 },
    ])
    expect(r?.spec.unit).toBe('抽')
  })

  it('没有价格或解析不出规格的成员不参与；全都不行就返回 null', () => {
    expect(pickRepresentative([{ model: '洁柔粉Face 3层110抽*24包' }])).toBeNull() // 无 listPrice
    expect(pickRepresentative([{ model: '维达', listPrice: 20 }])).toBeNull() // 无规格串
    expect(pickRepresentative([])).toBeNull()
  })
})

describe('foldByMention — 横评自己就是词表', () => {
  const universe = [
    '洁柔粉Face 3层110抽*24包',
    '洁柔face古龙水香 3层100抽*12包',
    '维达细韧 3层100抽*6包S码',
    '心相印茶语丝享 3层110抽*6包S码',
  ]

  it('横评说品牌，就按品牌聚；成员是所有含这个词的 SKU', () => {
    const folded = foldByMention(universe, ['洁柔', '维达'])
    expect(folded.get('洁柔')).toEqual(['洁柔粉Face 3层110抽*24包', '洁柔face古龙水香 3层100抽*12包'])
    expect(folded.get('维达')).toEqual(['维达细韧 3层100抽*6包S码'])
  })

  // 抽取端的噪声（小红书用户昵称被当成型号）认领不到任何 SKU，自动出局——
  // 不需要一份"噪声词表"，也就不会有名单漏更新的问题。
  it('认领不到任何 SKU 的点名直接出局，不进结果', () => {
    const folded = foldByMention(universe, ['鱼眉', '预约鸦鸦', '寄语'])
    expect(folded.size).toBe(0)
  })

  // 活体 2026-09-04：`维达` 裸名聚上了、`维达（Vinda）` 没聚上——**同一个牌子因为写法不同
  // 被算成两个东西**，一个进候选、一个留在 unmatchedRaw 里。
  it('品牌名带中英并列括号也要聚上', () => {
    const u = ['维达细韧 3层100抽*6包S码', '洁柔粉Face 3层110抽*24包']
    expect(foldByMention(u, ['维达（Vinda）']).get('维达（Vinda）')).toEqual(['维达细韧 3层100抽*6包S码'])
    expect(foldByMention(u, ['洁柔（C&S）']).get('洁柔（C&S）')).toEqual(['洁柔粉Face 3层110抽*24包'])
    expect(foldByMention(u, ['得宝(Tempo)']).size).toBe(0) // 剥完确实没有这个牌子 → 照常出局
  })

  it('大小写/空格不敏感（走 modelIdentity 那套归一）', () => {
    expect(foldByMention(['Vida 超韧 3层100抽*6包'], ['vida 超韧'])?.size).toBe(1)
  })

  // 手机那条路不能被这个改动碰到：横评说 `vivo X300`、全集里就有 `vivo X300`，
  // 精确匹配在上游第一道就命中了，根本走不到这里。这条钉的是"聚合不会把它拆散"。
  it('点名与 SKU 同名时，聚出来就是它自己一条', () => {
    const folded = foldByMention(['vivo X300', 'vivo X300 Pro'], ['vivo X300'])
    expect(folded.get('vivo X300')).toEqual(['vivo X300', 'vivo X300 Pro'])
  })
})

describe('pickCheapestByUnit — 取最小之前先剔垃圾行', () => {
  const row = (title: string, amount: number) => ({ title, amount })

  // 活体 2026-09-04（run 697b07e2）：得宝取到 ¥1 的「黄油小熊联名」行 → 0.21 元/百抽，
  // 而同批其余行在 1–3。**最小的那个垃圾赢**——正是 listPrice 价格带原本防的东西，
  // 快消品档去掉那道带子时没把它一起换掉。
  it('促销碎数字/凑单价被中位数闸剔掉，不让它赢', () => {
    const r = pickCheapestByUnit([
      row('得宝 TEMPO 黄油小熊联名抽纸 4层80抽×6包', 1),
      row('得宝 抽纸 3层90抽×24包', 39),   // 1.81 元/百抽
      row('得宝 软抽 4层100抽×12包', 26),  // 2.17
      row('得宝 加厚 3层120抽×18包', 38),  // 1.76
    ])
    expect(r?.amount).toBe(38)
    expect(r?.title).toContain('120抽')
  })

  it('正常的便宜行照样赢——闸只剔量级外的，不剔真便宜', () => {
    const r = pickCheapestByUnit([
      row('洁柔 粉Face 3层110抽×24包', 28),  // 1.06
      row('洁柔 软抽 3层100抽×6包', 19),     // 3.17
      row('洁柔 face 3层100抽×3包', 12),     // 4.00
    ])
    expect(r?.amount).toBe(28)
  })

  // 中位数在两行时就是其中一行，闸失效——退到枚举观察价做宽松下限。
  it('行数不足时用枚举观察价兜底：远低于它的孤行不采信', () => {
    expect(pickCheapestByUnit([row('得宝 联名 4层80抽×6包', 1)], 39)).toBeNull()
    expect(pickCheapestByUnit([row('得宝 抽纸 3层90抽×24包', 30)], 39)?.amount).toBe(30)
  })

  it('没有锚又只有一行：照常采信（没有依据说它不对，别自己编一个）', () => {
    expect(pickCheapestByUnit([row('得宝 抽纸 3层90抽×24包', 30)])?.amount).toBe(30)
  })

  it('单位混了仍按多数派切', () => {
    const r = pickCheapestByUnit([
      row('清风 原木 3层100抽×6包', 30),
      row('清风 原木 3层120抽×6包', 32),
      row('清风 卷纸 3层180克×10卷', 25),
    ])
    expect(r?.spec.unit).toBe('抽')
  })
})
