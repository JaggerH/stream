import { describe, it, expect } from 'vitest'
import { isCurrentNewOffer, offerTitleMatches, pickResaleRow, predecessorName, predecessorVariants, resolveResidual, sameModel } from './resale-pick.ts'

describe('sameModel — 精确对名，只放行品牌前缀', () => {
  it('整串相等（忽略空格大小写）', () => {
    expect(sameModel('iQOO Z11 Turbo', 'iqoo z11 turbo')).toBe(true)
    expect(sameModel('红米 Turbo 5', '红米Turbo 5')).toBe(true)
  })
  it('来源补了品牌前缀 → 算同一台', () => {
    expect(sameModel('iQOO Z11 Turbo', 'vivo iQOO Z11 Turbo')).toBe(true)
  })
  it('品牌中英别名折成同一台（活体 4 台里 3 台就是这么对丢的）', () => {
    expect(sameModel('真我Neo7 Turbo', 'realme Neo7 Turbo')).toBe(true)
    expect(sameModel('Redmi Turbo 5 MAX', '红米 Turbo 5 Max')).toBe(true)
    expect(sameModel('荣耀Power2', '荣耀 Power 2')).toBe(true)
    expect(sameModel('真我Neo8', 'realme Neo8')).toBe(true)
    expect(sameModel('真我Neo8', 'realme GT Neo3 (80W)')).toBe(false)
  })
  it('来源带着老系列名（realme GT Neo → Neo）→ 允许去掉开头两个词', () => {
    expect(sameModel('真我Neo6', 'realme GT Neo6')).toBe(true)
    expect(sameModel('真我Neo6', 'realme GT Neo6 SE')).toBe(false)
    // 品牌词只用来对齐：去掉品牌后型号必须整串相等，跨品牌的同名系列不许串
    expect(sameModel('iQOO Neo 6', 'realme GT Neo6')).toBe(false)
  })
  it('后缀多出 Max / Pro / 至尊版 / T → 不是这台', () => {
    expect(sameModel('红米 Turbo 5', '红米 Turbo 5 Max')).toBe(false)
    expect(sameModel('一加 Ace 6', '一加 Ace 6T')).toBe(false)
    expect(sameModel('一加 Ace 6', '一加 Ace 6 至尊版')).toBe(false)
    expect(sameModel('一加 Ace 6', '一加 Ace 5')).toBe(false)
  })
})

describe('pickResaleRow — 实测形状（转转 2026-09-03）', () => {
  const rows = [
    { title: '一加 Ace 6', excerpt: '最高回收价 ¥3160｜一加 · 手机', source: '转转回收' },
    { title: '一加 Ace 6T', excerpt: '最高回收价 ¥3005｜一加 · 手机', source: '转转回收' },
    { title: '一加 Ace 6 至尊版', excerpt: '最高回收价 ¥3640｜一加 · 手机', source: '转转回收' },
    { title: '一加 Ace 5', excerpt: '最高回收价 ¥2140｜一加 · 手机', source: '转转回收' },
  ]
  it('挑出问的那台，不拿最贵的也不拿第一行', () => {
    const r = pickResaleRow('一加 Ace 6', rows)
    expect(r?.resale).toBe(3160)
    expect(r?.basis).toContain('转转回收')
    expect(r?.basis).toContain('最高回收价 ¥3160')
  })
  it('对不上 → null（让 job 退到 purchase_only，不猜）', () => {
    expect(pickResaleRow('一加 Ace 7', rows)).toBeNull()
    expect(pickResaleRow('一加 Ace 6', [])).toBeNull()
  })
  it('多源都命中 → 取最高，出处逐个列', () => {
    const r = pickResaleRow('iQOO Z11 Turbo', [
      { title: 'vivo iQOO Z11 Turbo', excerpt: '最高回收价 ¥3060｜vivo · 手机', source: '转转回收' },
      { title: 'iQOO Z11 Turbo', excerpt: '最高可卖 ¥2770', source: '爱回收' },
    ])
    expect(r?.resale).toBe(3060)
    expect(r?.basis).toContain('爱回收 最高可卖 ¥2770')
  })
  it('命中但没价 → 当没命中', () => {
    expect(pickResaleRow('一加 Ace 6', [{ title: '一加 Ace 6', excerpt: '暂无报价', source: '转转回收' }])).toBeNull()
  })
})

describe('predecessorName — 同系列上 N 代的命名规律', () => {
  it('个位代数减 1', () => {
    expect(predecessorName('一加 Ace 6', 1)).toBe('一加 Ace 5')
    expect(predecessorName('真我Neo7 Turbo', 2)).toBe('真我Neo5 Turbo')
    expect(predecessorName('iPhone 17', 2)).toBe('iPhone 15')
    expect(predecessorName('Redmi Turbo 5 MAX', 1)).toBe('Redmi Turbo 4 MAX')
  })
  it('整十按 10 一代、整百按 100 一代', () => {
    expect(predecessorName('荣耀X80 Pro Max', 1)).toBe('荣耀X70 Pro Max')
    expect(predecessorName('vivo Y600 Pro', 2)).toBe('vivo Y400 Pro')
    expect(predecessorName('Redmi K90 Pro', 1)).toBe('Redmi K80 Pro')
  })
  it('没数字 / 减成非正 → null', () => {
    expect(predecessorName('iPhone Air', 1)).toBeNull()
    expect(predecessorName('荣耀Power2', 2)).toBeNull()
  })
  it('0 代就是它自己', () => {
    expect(predecessorName('一加 Ace 6', 0)).toBe('一加 Ace 6')
  })
})

describe('resolveResidual — 按持有年限选代', () => {
  const db: Record<string, number> = { '一加 Ace 6': 3160, '一加 Ace 5': 2140, '一加 Ace 4': 1500, 'iPhone 17': 6300, 'iPhone 16': 4200 }
  const search = async (name: string) =>
    Object.entries(db)
      .filter(([k]) => sameModel(name, k))
      .map(([k, v]) => ({ title: k, excerpt: `最高回收价 ¥${v}`, source: '转转回收' }))

  it('半年内 → 今天自己的价', async () => {
    expect((await resolveResidual('一加 Ace 6', 90, search))?.resale).toBe(3160)
  })
  it('一年 → 上一代；两年 → 上两代，basis 写明是代理', async () => {
    const one = await resolveResidual('一加 Ace 6', 365, search)
    expect(one?.resale).toBe(2140)
    expect(one?.basis).toContain('上一代 一加 Ace 5')
    const two = await resolveResidual('一加 Ace 6', 730, search)
    expect(two?.resale).toBe(1500)
    expect(two?.basis).toContain('上两代 一加 Ace 4')
  })
  it('推出来的上代名不存在 → 逐个去尾词退到同代基础款，basis 写明', async () => {
    const db2: Record<string, number> = { 'realme Neo6': 1200, 'realme Neo7 Turbo': 1845 }
    const search2 = async (name: string) =>
      Object.entries(db2).filter(([k]) => sameModel(name, k)).map(([k, v]) => ({ title: k, excerpt: `¥${v}`, source: '转转回收' }))
    const r = await resolveResidual('真我Neo7 Turbo', 365, search2)
    expect(r?.resale).toBe(1200)
    expect(r?.basis).toContain('退到了 真我Neo6')
    expect(predecessorVariants('Redmi Turbo 3 MAX Pro')).toEqual(['Redmi Turbo 3 MAX Pro', 'Redmi Turbo 3 MAX', 'Redmi Turbo 3'])
    // 第一代常不带数字：荣耀 Power 2 的上一代叫「荣耀 Power」
    expect(predecessorVariants('荣耀Power1')).toEqual(['荣耀Power1', '荣耀Power'])
  })

  it('上两代没收录 → 退到上一代并写明会偏高；长持有绝不退到 0 代', async () => {
    const r = await resolveResidual('iPhone 17', 730, search)
    expect(r?.resale).toBe(4200)
    expect(r?.basis).toContain('退了一代')
    expect(await resolveResidual('荣耀Power2', 730, search)).toBeNull()
  })

  it('上两代推成非正数 → 退到上一代再试，而且首代不带数字也能对上（荣耀Power2 → 荣耀 Power）', async () => {
    const search3 = async (name: string) =>
      [{ title: '荣耀 Power', excerpt: '最高回收价 ¥1375', source: '转转回收' }, { title: '荣耀 Power 2', excerpt: '最高回收价 ¥2005', source: '转转回收' }]
        .filter((r) => sameModel(name, r.title))
    const r = await resolveResidual('荣耀Power2', 730, search3)
    expect(r?.resale).toBe(1375)
    expect(r?.basis).toContain('退了一代')
    expect(await resolveResidual('iPhone Air', 730, search3)).toBeNull()
  })
})


describe('offerTitleMatches / isCurrentNewOffer — 比价行是不是这台的现售新品', () => {
  it('长 SKU 串里包含型号核心就认', () => {
    expect(offerTitleMatches('Redmi K80至尊版', 'REDMI 红米 K80 至尊版 手机 天玑9400  砂岩灰 12 512G')).toBe(true)
    expect(offerTitleMatches('Redmi K90', 'REDMI/红米 K90 手机 骁龙®8至尊版 白色 12+256G')).toBe(true)
    expect(offerTitleMatches('iQOO Z11 Turbo', 'vivo iQOO Z11 Turbo 5G手机 12GB+256GB')).toBe(true)
  })
  it('兄弟款不认：紧跟 Pro / 至尊版 / max / 6T / 更长的数字', () => {
    expect(offerTitleMatches('Redmi K80至尊版', '【95成新】小米（MI）REDMI K80 Pro 骁龙8至尊版 2K新国屏')).toBe(false)
    expect(offerTitleMatches('Redmi K90', 'REDMI/红米 K90至尊版 手机 暗影黑 16+256G')).toBe(false)
    expect(offerTitleMatches('Redmi K90', 'REDMI/红米 K90max 手机 天际蓝 12+256G')).toBe(false)
    expect(offerTitleMatches('一加Ace 6', '一加 Ace 6T 手机 12GB+256GB')).toBe(false)
    expect(offerTitleMatches('Redmi K8', 'Redmi K80 手机')).toBe(false)
    expect(offerTitleMatches('iQOO Z10 Turbo', 'iQOO Z10 Turbo Pro 12GB+256GB')).toBe(false)
  })
  it('已结束的优惠和二手行不是现售新品', () => {
    expect(isCurrentNewOffer('已结束REDMI K80 至尊版 手机 砂岩灰 12GB+512GB')).toBe(false)
    expect(isCurrentNewOffer('【95成新】小米 REDMI K80 Pro')).toBe(false)
    expect(isCurrentNewOffer('REDMI 红米 K80 至尊版 手机')).toBe(true)
  })
})

describe('中英并列的品牌名（活体 run 82779f12）', () => {
  // 那一轮维达的 20 行里唯一一行正确商品被判成"不是这个"，于是整个品牌 no_price：
  // 候选名是 `维达（Vinda）`，在售标题是 `Vinda/维达 细韧100抽 3层S码 抽纸 6包`。
  it('括号注释要剥掉，否则同一个牌子永远匹配不上', () => {
    expect(offerTitleMatches('维达（Vinda）', 'Vinda/维达 细韧100抽 3层S码 抽纸 6包')).toBe(true)
    expect(offerTitleMatches('得宝（Tempo）', '得宝Tempo 3层90抽无香抽纸')).toBe(true)
    expect(offerTitleMatches('洁柔（C&S）', 'C&S/洁柔 粉Face110抽 3层 抽纸 24包')).toBe(true)
  })

  it('剥括号不能把不同牌子混成一个', () => {
    expect(offerTitleMatches('维达（Vinda）', '清风 原木纯品 3层130抽×8包')).toBe(false)
  })
})
