// src/agent/search/domains/catalog.test.ts
import { describe, it, expect, vi } from 'vitest'
import { catalogDomain, coarsePriceRows, modelIdentity, type CatalogHit } from './catalog.ts'
import { runSearch, type SearchFlowDeps } from '../flow.ts'
import type { TrajectoryStep, WebHit } from '../types.ts'
import { textOf } from '../../../llm/client.ts'
import type { ChatMessage, ChatResult } from '../../../llm/client.ts'

const web = (over: Partial<WebHit>): WebHit => ({ title: 't', url: 'https://example.com', ...over })
const reply = (content: string): ChatResult => ({ content, raw: {} })

// 按系统提示词标记路由到 pairModels（提取）/ scoreCatalogTopicality（切题）。
const chatStub = (r: { pair?: string; score?: string }) =>
  vi.fn(async (messages: ChatMessage[]) => {
    const sys = textOf(messages[0].content)
    if (sys.includes('提取')) return reply(r.pair ?? '[]')
    if (sys.includes('切题')) return reply(r.score ?? '[]')
    return reply('[]')
  })

const mk = (over: Partial<Parameters<typeof catalogDomain>[0]> = {}) =>
  catalogDomain({
    chat: chatStub({ score: '[{"i":0,"score":3}]' }),
    priceSearch: async () => [{ excerpt: '¥4299' }],
    constraints: { category: ['手机'], priceRange: { min: 3000, max: 5000 } },
    ...over,
  })

describe('coarsePriceRows — 规则粗筛（Task 4 Step 1，不许碰 LLM）', () => {
  it('掺着导航/页脚/评论的页面文本只留下含价格的行，行数少一个量级', () => {
    const nav = '首页 分类 购物车 登录 注册\n'
    const footer = '© 2026 某某商城 保留所有权利 客服电话 400-000-0000\n'
    const comment = '评论：手感很好，电池耐用，就是有点重。\n'
    const text =
      nav.repeat(30) +
      '小米17 Pro 到手价4999元\n' +
      '华为 Mate70 12+256 券后价 4599 元\n' +
      '红米 Note14 ¥1299\n' +
      footer.repeat(30) +
      comment.repeat(30)
    const rows = coarsePriceRows(text)
    expect(rows).toEqual(['小米17 Pro 到手价4999元', '华为 Mate70 12+256 券后价 4599 元', '红米 Note14 ¥1299'])
    // 行数比原文少一个量级——粗筛存在的唯一理由是砍掉喂给 LLM 的体积。
    expect(rows.length * 10).toBeLessThan(text.split('\n').length)
  })
})

describe('parse — 粗筛后 LLM 配对（Task 4 Step 2）', () => {
  it('只把含价格的短行喂给 LLM，配上 hubUrl 出处', async () => {
    const chat = chatStub({ pair: '[{"model":"小米17 Pro","price":4999}]', score: '[]' })
    const d = mk({ chat, priceSearch: async () => [] })
    const page = '首页 导航 购物车 登录\n小米17 Pro 到手价4999元\n© 2026 某商城 保留所有权利\n华为 Mate70 券后价4599元\n评论：好用'
    const hits = await d.parse(page, 'https://shop.example.com/list')
    expect(hits).toEqual([{ model: '小米17 Pro', price: 4999, hubUrls: ['https://shop.example.com/list'] }])
    // 喂给 LLM 的只有粗筛后的行——导航/页脚/评论都没进去。
    const user = textOf(chat.mock.calls[0][0][1].content)
    expect(user).toContain('小米17 Pro')
    expect(user).toContain('华为 Mate70')
    expect(user).not.toContain('© 2026')
    expect(user).not.toContain('评论')
  })
})

describe('check — 两段：便宜段粗筛 + price_search 核实（Task 4 Step 3）', () => {
  it('不在区间内的 dead、查无此型号的 unchecked，都被刷掉且 stats 分得清', async () => {
    const priceSearch = vi.fn(async (model: string) =>
      model === '查无此型号' ? [] : [{ excerpt: model === '华为 Mate70' ? '¥5999' : '¥4299' }]
    )
    const chat = chatStub({ score: '[{"i":0,"score":3}]' })
    const d = mk({ chat, priceSearch })
    const { kept, stats } = await d.check(
      '5000 以内拍照手机',
      [
        { model: '小米17 Pro', price: 4299, hubUrls: ['h1'] }, // 在区间内 → alive
        { model: '华为 Mate70', price: 5999, hubUrls: ['h1'] }, // 配对价就不在区间 → dead（便宜段，不花钱验）
        { model: '查无此型号', price: 3999, hubUrls: ['h2'] }, // price_search 查无 → unchecked → 刷掉
      ],
      chat,
    )
    expect(priceSearch).toHaveBeenCalledWith('小米17 Pro')
    expect(priceSearch).toHaveBeenCalledWith('查无此型号')
    expect(priceSearch).not.toHaveBeenCalledWith('华为 Mate70') // 便宜段就毙了，不调比价
    expect(kept.map((k) => k.model)).toEqual(['小米17 Pro'])
    expect(stats).toEqual({ alive: 1, dead: 1, unchecked: 1 })
  })

  it('在售但比价后发现不在区间内 → dead（price_search 的回执为准）', async () => {
    const priceSearch = vi.fn(async () => [{ excerpt: '¥5999' }]) // 在售，但 5999 超 5000
    const chat = chatStub({ score: '[]' })
    const d = mk({ chat, priceSearch })
    const { kept, stats } = await d.check('g', [{ model: '小米17 Pro', hubUrls: ['h1'] }], chat)
    expect(kept).toEqual([])
    expect(stats).toEqual({ alive: 0, dead: 1, unchecked: 0 })
  })
})

describe('identityOf + 去重出处（Task 4 Step 4）', () => {
  it('容量/空格/大小写差异归一到一起', () => {
    const d = mk({ chat: chatStub({}), priceSearch: async () => [] })
    expect(d.identityOf({ model: '小米17 Pro 12+256', hubUrls: ['a'] })).toBe(
      d.identityOf({ model: '小米 17Pro', hubUrls: ['b'] }),
    )
    expect(modelIdentity('小米17 Pro 12GB+256GB')).toBe(modelIdentity('小米17 Pro 12+256'))
    expect(d.identityOf({ model: '小米17', hubUrls: ['a'] })).not.toBe(
      d.identityOf({ model: '小米17 Pro', hubUrls: ['b'] }),
    )
  })

  it('同一型号从多个窝抽到合并成一条，hubUrls 累积全部来源', async () => {
    const priceSearch = vi.fn(async () => [{ excerpt: '¥4299' }])
    const chat = chatStub({ score: '[{"i":0,"score":3}]' })
    const d = mk({ chat, priceSearch })
    const { kept } = await d.check(
      'g',
      [
        { model: '小米17 Pro 12+256', price: 4299, hubUrls: ['h1'] },
        { model: '小米 17 Pro', price: 4599, hubUrls: ['h2'] },
      ],
      chat,
    )
    expect(kept).toHaveLength(1)
    expect(kept[0].hubUrls).toEqual(['h1', 'h2'])
    expect(kept[0].price).toBe(4299) // 保留先到的那份价格
  })
})

// Task 4 Step 5：商品档没有「直链」这一档（spec §2.5 ①），三分类退化成二分类是这个域的
// 正常形态，不是缺陷——directLinks 恒空不该报错，候选只来自进窝抽。
describe('flow 整跑（Task 4 Step 5）：商品档 directLinks 恒空不报错', () => {
  it('候选只来自进窝抽，targets 是配对出的型号', async () => {
    const webSearch = vi.fn(async () => [web({ title: '手机排行榜 2026', url: 'https://top.example.com/phones' })])
    const fetchPage = vi.fn(async (url: string) =>
      url.includes('top.example.com')
        ? '小米17 Pro 到手价4999元\n华为 Mate70 券后价4599元\n首页 导航 评论区'
        : ''
    )
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      const sys = textOf(messages[0].content)
      if (sys.includes('生成')) return reply('["q0"]')
      if (sys.includes('分类')) return reply('{"items":[{"i":0,"kind":"hub"}],"vocab":["手机"]}')
      if (sys.includes('提取')) return reply('[{"model":"小米17 Pro","price":4999},{"model":"华为 Mate70","price":4599}]')
      if (sys.includes('切题')) return reply('[{"i":0,"score":3},{"i":1,"score":3}]')
      return reply('[]')
    })
    const d = mk({ chat, priceSearch: async () => [{ excerpt: '¥4999' }] })
    const deps: SearchFlowDeps<CatalogHit> = {
      webSearch,
      chat,
      fetchPage,
      domain: d,
      maxRounds: 1,
      maxHubsPerRound: 5,
      earlyStop: { topical: 2, hubs: 99 },
    }

    const steps: TrajectoryStep[] = []
    const out = await runSearch('5000 以内拍照手机', deps, (s) => steps.push(s as TrajectoryStep))

    // classify 的 directLinks 恒空（排行榜 url 不是网盘链）——二分类退化形态，run 照常出清单。
    expect(steps.find((s) => s.kind === 'classify')?.output).toMatchObject({ directLinks: 0, hubs: 1 })
    expect(out.targets.map((t) => t.model)).toEqual(['小米17 Pro', '华为 Mate70'])
    expect(out.hubs.map((h) => h.url)).toEqual(['https://top.example.com/phones'])
    expect(out.stopped).toBe('early')
  })
})

// 评审补的一条（2026-09-02）：归一化写错方向的代价是候选**消失**，不是虚胖。
describe('modelIdentity 的边界', () => {
  it('型号自带数字时，不同型号不许塌缩成同一个身份', () => {
    // 先去空白再剥容量的话，`\d+` 贪婪吃掉「8012+256」，K80 / K70 双双变成「红米k」。
    expect(modelIdentity('红米K80 12+256')).not.toBe(modelIdentity('红米K70 12+256'))
    expect(modelIdentity('红米K80 12+256')).toBe(modelIdentity('红米K80'))
  })

  it('同型号的不同容量仍归到一起（这一格本来的用途）', () => {
    expect(modelIdentity('小米17 Pro 12+256')).toBe(modelIdentity('小米17 Pro'))
    expect(modelIdentity('小米17 Pro 256GB')).toBe(modelIdentity('小米17 Pro'))
  })
})

// 活体（2026-09-02）真跑出来的第二个：同一台机器分两轮抽到，双双进了最终清单
//（「vivo X300S 4499」+「vivo X300s 12GB+256GB 4999」）。check 只在单轮内按 identityOf
// 合并，跨轮累积那一段过去只有 rankTargets 的 `link || JSON.stringify` 兜着——商品档没有
// link，价格差一块钱就是两条。后果不是清单虚胖那么轻：支配运算会拿同一台机器的两个价格
// 互斩，卡片上印出一行自己跟自己比出来的「已排除」。
describe('跨轮去重（活体 2026-09-02）', () => {
  it('同一型号分两轮抽到 → 最终清单只留一条，且留 fit 高的那份', async () => {
    let round = -1
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      const sys = textOf(messages[0].content)
      if (sys.includes('生成')) return reply(`["q${++round}"]`)
      if (sys.includes('分类')) return reply('{"items":[{"i":0,"kind":"hub"}],"vocab":[]}')
      // 两轮抽到同一台机器的两种写法（含容量后缀、价格不同）——identityOf 应当认出是同一台。
      if (sys.includes('提取')) {
        return reply(
          round === 0
            ? '[{"model":"vivo X300S","price":4499}]'
            : '[{"model":"vivo X300s 12GB+256GB","price":4999}]'
        )
      }
      if (sys.includes('切题')) return reply(round === 0 ? '[{"i":0,"score":2}]' : '[{"i":0,"score":3}]')
      return reply('[]')
    })
    const deps: SearchFlowDeps<CatalogHit> = {
      webSearch: async (q) => [web({ title: '榜单', url: `https://top.example.com/${encodeURIComponent(q)}` })],
      chat,
      fetchPage: async () => 'vivo X300S 到手价4499元',
      domain: mk({ chat, priceSearch: async () => [{ excerpt: '¥4499' }] }),
      maxRounds: 2,
      maxHubsPerRound: 1,
    }

    const out = await runSearch('手机 拍照，5000 元以内', deps, () => {})

    expect(out.targets).toHaveLength(1)
    expect(out.targets[0].fit).toBe(3) // 留 fit 高的那份
  })
})

// 活体（2026-09-02）真跑出来的那个偏：habitat 只有「手机/拍照/5000元以内」，第 0 轮生成的
// 查询却是「5000元以内拍照手机 网盘」「手机拍照 五千元 下载」——网盘词全来自两个"通用"关节
// 硬写在提示里的口径。**关节的代码通用，它问什么不通用**，所以口径进域（`framing`）。
describe('关节口径（framing）：商品档不许带着网盘口径去搜', () => {
  it('两个 LLM 关节的系统提示里没有网盘词，且带着清单类页面的说法', async () => {
    const prompts: string[] = []
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      const sys = textOf(messages[0].content)
      prompts.push(sys)
      if (sys.includes('生成')) return reply('["q0"]')
      if (sys.includes('分类')) return reply('{"items":[{"i":0,"kind":"hub"}],"vocab":[]}')
      if (sys.includes('提取')) return reply('[{"model":"小米17 Pro","price":4999}]')
      if (sys.includes('切题')) return reply('[{"i":0,"score":3}]')
      return reply('[]')
    })
    const deps: SearchFlowDeps<CatalogHit> = {
      webSearch: async () => [web({ title: '手机排行榜', url: 'https://top.example.com/phones' })],
      chat,
      fetchPage: async () => '小米17 Pro 到手价4999元',
      domain: mk({ chat, priceSearch: async () => [{ excerpt: '¥4999' }] }),
      maxRounds: 1,
      maxHubsPerRound: 5,
      earlyStop: { topical: 1, hubs: 99 },
    }

    await runSearch('手机 拍照，5000 元以内', deps, () => {})

    const joints = prompts.filter((p) => p.includes('生成') || p.includes('分类'))
    expect(joints.length).toBeGreaterThanOrEqual(2) // 出词 + 分类都问过了
    for (const p of joints) {
      expect(p).not.toMatch(/网盘|夸克|资源站|福利号|下架/)
    }
    expect(joints.find((p) => p.includes('生成'))).toMatch(/排行榜|榜单|导购/)
    expect(joints.find((p) => p.includes('分类'))).toMatch(/排行榜|榜单|比价|横评/)
  })

  it('商品档没有「直链」这一档，提示里就不出现它——免得模型把排行榜硬塞进一个不存在的类', async () => {
    const prompts: string[] = []
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      const sys = textOf(messages[0].content)
      prompts.push(sys)
      if (sys.includes('生成')) return reply('["q0"]')
      return reply('{"items":[],"vocab":[]}')
    })
    const deps: SearchFlowDeps<CatalogHit> = {
      webSearch: async () => [web({ title: 't', url: 'https://a.example.com' })],
      chat,
      domain: mk({ chat, priceSearch: async () => [] }),
      maxRounds: 1,
    }

    await runSearch('手机', deps, () => {})

    const classify = prompts.find((p) => p.includes('分类'))!
    expect(classify).toContain('"hub|noise"')
    expect(classify).not.toContain('direct')
  })
})
