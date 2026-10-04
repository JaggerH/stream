import { describe, it, expect } from 'vitest'
import { foldWithText, foldGroupsByText, worthFetchingText, sharedStoryRun, makeTextCache, type TextFoldDeps } from './text-fold.ts'
import { fold, foldTitle, type Foldable } from './fold.ts'
import { longestSharedRun, sketchSim, textSketch } from '../text/shingle.ts'
import { titleSim } from '../text/similarity.ts'
import { SEARCH_PROFILE, type TextFoldSettings } from './profiles.ts'

const h = (title: string, url: string): Foldable => ({ title, url })

const SETTINGS: TextFoldSettings = { minSharedChars: 120, maxFetches: 12, concurrency: 4, timeoutMs: 200 }

/** 够长的一段"正文"：短于 MIN_TEXT_CHARS 的一律被当成拦截页，判不了。 */
const body = (seed: string): string => `${seed}。`.repeat(60)

/** 记账版 readUrl：`texts` 里有就给，没有就抛；同时记下每个 URL 被抓了几次。 */
function fakeReader(texts: Record<string, string>) {
  const calls: string[] = []
  const deps: TextFoldDeps = {
    readUrl: async (url) => {
      calls.push(url)
      const t = texts[url]
      if (t === undefined) throw new Error('抓不到')
      return { text: t }
    },
    cache: makeTextCache(),
  }
  return { deps, calls }
}

describe('worthFetchingText —— 候选闸门（值不值得花钱抓正文）', () => {
  it('同一个站的两条也抓：百家号/搜狐号/网易号是「一个域名、无数个发布者」，转载最密的地方就在站内', () => {
    expect(worthFetchingText(h('A 稿', 'https://x.com/1'), h('B 稿', 'https://x.com/2'))).toBe(true)
  })

  it('集号/期号对不上不抓——硬否决必须跑在花钱之前', () => {
    expect(worthFetchingText(h('某访谈 第3期上', 'https://a.example/1'), h('某访谈 第3期下', 'https://b.example/2'))).toBe(false)
  })

  it('认不出 host 的（磁力、非链接）不抓', () => {
    expect(worthFetchingText(h('A', 'magnet:?xt=urn:btih:abc'), h('B', 'https://b.example/2'))).toBe(false)
  })

  it('标题完全不像照样抓——这正是这一档存在的理由，不设标题下限', () => {
    expect(worthFetchingText(h('毫不相干的说法', 'https://a.example/1'), h('另一种说法', 'https://b.example/2'))).toBe(true)
  })
})

describe('foldWithText —— 标题不像但正文是同一条', () => {
  it('跨站转载被改了标题，靠正文并起来', async () => {
    const hits = [h('OpenAI 发布新模型 GPT-6', 'https://a.example/1'), h('重磅！人工智能又有大动作', 'https://b.example/2')]
    const { deps } = fakeReader({
      'https://a.example/1': body('同一段稿子的正文内容在这里'),
      'https://b.example/2': body('同一段稿子的正文内容在这里'),
    })
    const groups = await foldWithText(hits, SEARCH_PROFILE, deps)
    expect(groups).toHaveLength(1)
    expect(groups[0].rep.title).toBe('OpenAI 发布新模型 GPT-6')
    expect(groups[0].members.map((m) => m.title)).toEqual(['重磅！人工智能又有大动作'])
    expect(groups[0].why.at(-1)?.kind).toBe('text-identity')
  })

  it('正文确实不同就不并（0 = 看过了不像，是结论）', async () => {
    const hits = [h('甲讲的事', 'https://a.example/1'), h('乙讲的事', 'https://b.example/2')]
    const { deps } = fakeReader({
      'https://a.example/1': body('第一件事情的完整叙述与细节'),
      'https://b.example/2': body('另一件毫不相干的事情的叙述'),
    })
    expect(await foldWithText(hits, SEARCH_PROFILE, deps)).toHaveLength(2)
  })

  it('抓不到 = 判不了，保持原样且绝不抛错', async () => {
    const hits = [h('甲讲的事', 'https://a.example/1'), h('乙讲的事', 'https://b.example/2')]
    const failures: string[] = []
    const groups = await foldWithText(hits, SEARCH_PROFILE, {
      readUrl: async () => {
        throw new Error('502')
      },
      onFetchFailure: (url) => failures.push(url),
      cache: makeTextCache(),
    })
    expect(groups).toHaveLength(2)
    expect(failures).toHaveLength(2)
  })

  it('超时的那一篇当作判不了，不拖垮整次折叠', async () => {
    const hits = [h('甲讲的事', 'https://a.example/1'), h('乙讲的事', 'https://b.example/2')]
    const reasons: string[] = []
    const groups = await foldGroupsByText(fold(hits, SEARCH_PROFILE), { ...SETTINGS, timeoutMs: 20 }, {
      readUrl: (url) =>
        url.includes('a.example')
          ? new Promise((r) => setTimeout(() => r({ text: body('同一段话') }), 200))
          : Promise.resolve({ text: body('同一段话') }),
      onFetchFailure: (_u, reason) => reasons.push(reason),
      cache: makeTextCache(),
    })
    expect(groups).toHaveLength(2)
    expect(reasons.join()).toContain('没回来')
  })

  it('太短的"正文"当判不了——两个站撞上同一种拦截页不许被并成一条', async () => {
    const hits = [h('甲讲的事', 'https://a.example/1'), h('乙讲的事', 'https://b.example/2')]
    const { deps } = fakeReader({
      'https://a.example/1': 'Just a moment...',
      'https://b.example/2': 'Just a moment...',
    })
    expect(await foldWithText(hits, SEARCH_PROFILE, deps)).toHaveLength(2)
  })

  it('已经靠标题判定的对子不再花钱抓正文', async () => {
    const hits = [h('怡楽播客回归首期正式上线', 'https://a.example/1'), h('怡楽播客回归首期正式上线', 'https://b.example/2')]
    const { deps, calls } = fakeReader({})
    const groups = await foldWithText(hits, SEARCH_PROFILE, deps)
    expect(groups).toHaveLength(1)
    expect(calls).toHaveLength(0)
  })

  it('同一个 URL 一次进程里只抓一次（http/https、尾斜杠归一）', async () => {
    const { deps, calls } = fakeReader({
      'https://a.example/1': body('同一段话'),
      'https://b.example/2': body('同一段话'),
      'https://c.example/3': body('别的话题的正文'),
    })
    await foldWithText([h('甲', 'https://a.example/1'), h('乙', 'https://b.example/2'), h('丙', 'https://c.example/3')], SEARCH_PROFILE, deps)
    // 第二次同样的输入：全部命中缓存，一次都不再抓。
    const before = calls.length
    await foldWithText([h('甲', 'https://a.example/1'), h('乙', 'https://b.example/2'), h('丙', 'https://c.example/3')], SEARCH_PROFILE, deps)
    expect(calls).toHaveLength(before)
  })

  it('抓取次数有硬上限，超出的那些保持原样', async () => {
    const texts: Record<string, string> = {}
    const hits: Foldable[] = []
    // 标题里**故意不放数字**：数字不同会先被 serialConflict 一票否决，那样测的就不是上限了。
    const words = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛']
    for (const w of words) {
      const url = `https://${'abcdefgh'[words.indexOf(w)]}.example/x`
      texts[url] = body('同一段话')
      hits.push(h(`${w}说的那件事`, url))
    }
    const { deps, calls } = fakeReader(texts)
    const groups = await foldGroupsByText(fold(hits, SEARCH_PROFILE), { ...SETTINGS, maxFetches: 3 }, deps)
    expect(calls).toHaveLength(3)
    // 抓到的 3 条并成一堆，剩下 5 条照原样各占一格。
    expect(groups).toHaveLength(6)
    expect(groups[0].members).toHaveLength(2)
  })

  it('一条内容都不会消失：展开后条数 = 输入条数', async () => {
    const hits = [h('甲', 'https://a.example/1'), h('乙', 'https://b.example/2'), h('丙', 'https://c.example/3')]
    const { deps } = fakeReader({
      'https://a.example/1': body('同一段话'),
      'https://b.example/2': body('同一段话'),
      'https://c.example/3': body('同一段话'),
    })
    const groups = await foldWithText(hits, SEARCH_PROFILE, deps)
    const total = groups.reduce((n, g) => n + 1 + g.members.length, 0)
    expect(total).toBe(hits.length)
  })

  it('没接 readUrl 就退化成原来那一档，行为一字不变', async () => {
    const hits = [h('甲', 'https://a.example/1'), h('乙', 'https://b.example/2')]
    expect(await foldWithText(hits, SEARCH_PROFILE)).toEqual(fold(hits, SEARCH_PROFILE))
  })
})

/**
 * **活体取回来的那一版**（2026-08-14，查询「OpenAI 放缓发布 Astra 网络安全担忧」，
 * 正文是 `read_url` 真抓回来的）。压缩成这个固件是为了钉住三件事，它们都不是编出来的：
 *
 * 1. 同一篇通稿挂在两个站上时，**正文只占页面的一小部分**，其余是各站自己的样板
 *    （免责声明、推荐位、股吧滚动条）——所以整篇算的相似度没用。
 * 2. 通稿那一段是**一字不差**的，长度两三百字。
 * 3. 「各写各的同一件事」（NHK 自己写的那条）**必须不并**——那是设计里明确留给语义槽位
 *    的第三种同质，这一档不碰。
 */
const WIRE = // 财联社通稿的核心段，两个站一字不差地转了它（实测共享 246 字）
  'OpenAI表示，在对即将推出的模型之一Astra进行内部评估后，“我们无法排除其具备关键性网络能力”。' +
  '在发布Astra之前，OpenAI将扩大针对该模型的测试和安全措施，并按照公司2023年首次发布的“准备框架”要求，' +
  '放缓Astra的开发进程，直到建立适当的安全防护措施。OpenAI还表示，Astra并未参与HuggingFace漏洞攻击事件。' +
  '这可能是首个人工智能前沿实验室因网络安全担忧而承诺放缓自身AI模型开发进程的案例。'

const LIVE = {
  eastmoney: `财联社 08-10 08:23\n${WIRE}\n浙商证券指出，AI大模型能力持续迭代，正在推动网络安全行业逻辑从“AI颠覆安全”转向“AI放大安全需求”。国内厂商若能在云安全、零信任、身份安全等方向形成平台化交付能力，有望受益。（文章来源：财联社）郑重声明：东方财富发布此内容旨在传播更多信息，与本站立场无关，不构成投资建议。热点阅读 商务部：对原产于印度的进口单模光纤继续征收反倾销税 利好突至！A股芯片巨头业绩大超预期 美国7月PPI涨幅低于预期`,
  sina: `观点网讯：8月10日，${WIRE}\n免责声明：本文内容与数据由观点根据公开信息整理，不构成投资建议，使用前请核实。海量资讯、精准解读，尽在新浪财经APP。股市直播 01/三预警齐发 02/内塔尼亚胡被曝曾同意从加沙部分地区撤军 03/北京“10万+”豪宅批量入市 04/宇树科技，今日打新 05/北美防空司令部出动F-16拦截 交易提示 操盘必读 证券报 最新公告 限售解禁 数据中心 条件选股 券商评级 股价预测 板块行情 千股千评 个股诊断 大宗交易 财报查询 业绩预告`,
  // NHK 自己写的一条：同一件事，但一个字都不是抄的（实测最长共享块 8 字）。
  nhk: '开发生成式人工智能（AI）“ChatGPT”的美国OpenAI公司8月7日宣布，暂时停止其人工智能模型“Astra”的开发，其理由是，该人工智能模型的能力大幅提升，不能排除其通过自主判断实施严重网络攻击的可能性。OpenAI对Astra的各项功能进行了详细评估，结果发现其编程和网络安全能力均有大幅提升。该公司指出，Astra所具备的发现未知软件漏洞的能力可能已达到危险水平。因此，公司根据内部指针，决定暂时停止开发工作，直至安全措施落实到位。',
}

describe('活体固件 —— 真实搜索结果 + 真实正文', () => {
  const hits = [
    h('OpenAI因网络安全担忧放缓发布新模型AI时代安全价值量有望提升', 'https://wap.eastmoney.com/a/202608103836048718.html'),
    h('OpenAI因网络安全担忧放缓Astra模型开发进程', 'https://finance.sina.com.cn/stock/estate/integration/2026-08-10/doc-inimuvrr1272827.shtml'),
    h('OpenAI宣布因有主动实施网络攻击可能而暂停Astra模型开发', 'https://www3.nhk.or.jp/nhkworld/zh/news/20260809_01/'),
  ]
  const texts = {
    [hits[0].url!]: LIVE.eastmoney,
    [hits[1].url!]: LIVE.sina,
    [hits[2].url!]: LIVE.nhk,
  }

  it('标题不像的两条转载并成一格；各写各的那条留在自己那格', async () => {
    const { deps } = fakeReader(texts)
    const groups = await foldWithText(hits, SEARCH_PROFILE, deps)
    expect(groups).toHaveLength(2)
    expect(groups[0].members.map((m) => m.url)).toEqual([hits[1].url])
    expect(groups[1].rep.url).toBe(hits[2].url)
    expect(groups[0].why.at(-1)?.detail).toContain('连续')
  })

  it('这三条**光看标题一条都并不上**——所以这一档确实是它自己救回来的', () => {
    expect(fold(hits, SEARCH_PROFILE)).toHaveLength(3)
  })

  it('**换成整篇算的草图相似度就并不上了**——这是「为什么判据不是 Jaccard」的实证', () => {
    // 真页面上样板压倒正文：两个站一字不差地转了同一篇通稿，草图相似度却低到和
    // 「各写各的」（下面那个数）挤在一起，中间没有能安全下刀的地方。
    const copies = sketchSim(textSketch(LIVE.eastmoney), textSketch(LIVE.sina))
    const unrelated = sketchSim(textSketch(LIVE.eastmoney), textSketch(LIVE.nhk))
    expect(copies).toBeLessThan(0.35)
    expect(unrelated).toBeLessThan(0.05)
    // 而共享块差着一个量级，怎么下刀都对。
    // 活体上这一对是 246 字；固件把通稿段裁短了一点，仍是 200。
    expect(longestSharedRun(LIVE.eastmoney, LIVE.sina)).toBeGreaterThan(150)
    expect(longestSharedRun(LIVE.eastmoney, LIVE.nhk)).toBeLessThan(30)
  })
})

/**
 * **同站那一档的活体固件**（2026-08-14 真抓的页面，`read_url` 取的正文）。
 *
 * 同站放开之后唯一有风险的地方是**同一个站的两个页面天然共享页眉页脚**，而它长得足够长，
 * 足以自己越过 130 字门槛。这一组把三件事各钉一个真样本：并该并的、不并不该并的、
 * 以及「序列身份仍然是硬否决」。数字与判法见 `text-fold.ts` 的 `sharedStoryRun`。
 */
describe('同站活体固件 —— 页脚不能变成并堆的理由', () => {
  /** 网易号每一页都挂的那段声明，一字不差（归一化后 209 字，实测三对同站文章共享的就是它）。 */
  const NETEASE_FOOTER =
    '特别声明：以上内容(如有图片或视频亦包括在内)为自媒体平台“网易号”用户上传并发布，本平台仅提供信息存储服务。\n' +
    'Notice: The content above (including the pictures and videos if any) is uploaded and posted by a user of ' +
    'NetEase Hao, which is a social media platform and only provides information storage services.'

  /** 百家号每一页的页脚（归一化后 66 字）。 */
  const BAIDU_FOOTER = '设为首页\n关于百度\nAbout Baidu\n使用百度前必读\n帮助中心\n© Baidu\n京ICP证030173号\n京公网安备11000002000001号'

  /** 复旦那篇通稿的核心段——b1（`baijiahao.../1873368180388543973`）与 b4
   *  （`.../1873390053487322718`）两个不同的号一字不差地转了它（活体实测共享 256 字）。 */
  const WIRE =
    '高温超导电性是未来高效电力传输和高性能电子器件发展的重要方向，但其微观机理始终是凝聚态物理的“皇冠之谜”。' +
    '北京时间8月12日晚间复旦大学物理学系张远波教授团队与合作者成功将铜基高温超导体削薄至仅含一个超导平面——即单个CuO₂面。' +
    '相关成果以“Superconducting 2D cuprate with a single CuO₂ plane”为题在《自然》（Nature）发表。' +
    '这一“极限操作”不仅证实了高温超导的二维本质，更在超导-绝缘体转变的临界点发现了奇异的“反常金属态”和量子临界现象，' +
    '为研究高温超导机理提供了全新的量子实验平台。'

  it('网易号的页脚有 209 字——不剥掉它，同站两篇毫不相干的文章就会被并掉', () => {
    const 养猫 = `${body('幼猫到家第一周先别急着抱')}${NETEASE_FOOTER}`
    const 黄金 = `${body('伦敦金银市场协会调查了十六位分析师')}${NETEASE_FOOTER}`
    // 裸尺读到的是页脚，而且**已经越过门槛**——这就是同站不能直接用它的全部理由。
    expect(longestSharedRun(养猫, 黄金)).toBeGreaterThan(SEARCH_PROFILE.text!.minSharedChars)
    // 剥掉共同页脚之后，剩下的正文什么都不共享。
    expect(sharedStoryRun(养猫, 黄金, true)).toBeLessThan(SEARCH_PROFILE.text!.minSharedChars)
  })

  it('同一个站的两个号转了同一篇通稿 → 并（这正是跨站闸门当初挡掉的那一类）', async () => {
    const hits = [
      h('登上《自然》，复旦张远波团队首次制备单铜氧层高温超导体', 'https://baijiahao.baidu.com/s?id=1873368180388543973'),
      h('复旦大学科研团队首次制备单铜氧层高温超导体 成果在《自然》发表', 'https://baijiahao.baidu.com/s?id=1873390053487322718'),
    ]
    const { deps } = fakeReader({
      [hits[0].url!]: `${body('这一段是甲号自己加的导语')}${WIRE}${body('这一段是甲号自己加的尾注')}${BAIDU_FOOTER}`,
      [hits[1].url!]: `${body('乙号的开头排版完全不一样')}${WIRE}${body('乙号自己的结语')}${BAIDU_FOOTER}`,
    })
    const groups = await foldWithText(hits, SEARCH_PROFILE, deps)
    expect(groups).toHaveLength(1)
    expect(groups[0].why[0].kind).toBe('text-identity')
  })

  it('同一个站的两篇毫不相干的文章 → 不并（页脚共享 209 字也不算数）', async () => {
    const hits = [
      h('幼猫饲养护理指南！新手轻松养好小奶猫', 'https://www.163.com/dy/article/L33H6S4M0556OHQ4.html'),
      h('黄金后市何去何从？业内预测：年内仍有上行空间', 'https://www.163.com/dy/article/L47L298O05198CJN.html'),
    ]
    const { deps } = fakeReader({
      [hits[0].url!]: `${body('幼猫到家第一周先别急着抱')}${NETEASE_FOOTER}`,
      [hits[1].url!]: `${body('伦敦金银市场协会调查了十六位分析师')}${NETEASE_FOOTER}`,
    })
    expect(await foldWithText(hits, SEARCH_PROFILE, deps)).toHaveLength(2)
  })

  it('同一档节目的第三期和第四期 → 不并。**闸门拆掉之后，序列身份是唯一那道防线**', async () => {
    const hits = [
      h('《歌手2026》第三期排名发布，胡彦斌第一，窦靖童第二', 'https://www.163.com/dy/article/KUN0U9AL053469KC.html'),
      h('《歌手2026》第四期排名公布：胡彦斌再夺第一，尤长靖第二，齐豫第三', 'https://www.163.com/dy/article/KV8O3MT4053469LG.html'),
    ]
    // 两期的正文高度雷同（同一档节目、同一批歌手、同一种排名句式），页脚还一模一样——
    // 靠相似度分不出来，只有标题里的期号分得出来。
    const 竞演 = body('本期竞演结果出炉，前三名进入优胜区，其余歌手进入待定区')
    const { deps } = fakeReader({
      [hits[0].url!]: `${竞演}第三期排名：胡彦斌第一，窦靖童第二。${NETEASE_FOOTER}`,
      [hits[1].url!]: `${竞演}第四期排名：胡彦斌第一，尤长靖第二。${NETEASE_FOOTER}`,
    })
    expect(await foldWithText(hits, SEARCH_PROFILE, deps)).toHaveLength(2)
    // 抓都不该抓——硬否决跑在花钱之前。
    expect(worthFetchingText(hits[0], hits[1])).toBe(false)
  })
})

/**
 * **同站的「标题像」要等正文确认**（`withSameHostTextConfirm` → `titleNeedsTextConfirm`）。
 *
 * 真样本是搜狐同一个号两天的「每日一练｜时事政治模拟题」（2026-08-14 `read_url` 真抓的正文，
 * 题目完全不同）：标题只差最后那个尾巴词，Dice 0.857 越过 0.85 阈值，`serialConflict` 又
 * 完全挡不住（标题里一个号都没有）。第 1 档要是照并，用户就再也看不到其中一天的题。
 */
describe('同站标题证据降级 —— 「每日一练」不是同一条', () => {
  /** 搜狐这个号每篇都挂的那截尾巴（两篇一字不差）。 */
  const SOHU_TAIL =
    '——////////——\n加中公老师微信\n回复“事业单位/A类/B类/C类\n拉你进相对应备考群\n宁夏事业单位考试 返回搜狐，查看更多\n' +
    '私信回复【 进群 】即可进入事业单位备考群！\n私信回复【 人工 】有疑问可在线咨询中公教师哦！'

  const 练一 = h('每日一练|时事政治模拟题_答案_备考_普查', 'https://www.sohu.com/a/613889193_121124005')
  const 练二 = h('每日一练|时事政治模拟题_备考_答案_结构化', 'https://www.sohu.com/a/577012683_121124005')

  const 正文一 =
    '扫码进群领取事业单位备考资料\n时事政治模拟题\n1.国务院日前印发( )，根据《全国经济普查条例》的规定，国务院决定于2023年开展第五次全国经济普查。答案：A\n' +
    '3.第三批适用增值税政策的抗癌药品和罕见病药品清单近日发布，包括( )抗癌药品制剂和原料药、( )罕见病药品制剂和原料药。答案：C\n' +
    '4.银保监会决定，自2023年1月1日起开展养老保险公司商业养老金业务试点，试点期限暂定( )。答案：C\n' +
    '5.商务部公布数据显示，今年1至10月，我国( )总额近5万亿元，同比增长17.2%。答案：D\n事业单位笔试3000题\n实战刷题提高答题能力\n' +
    SOHU_TAIL
  const 正文二 =
    '扫码加助教老师拉你进面试备考群\n时事政治模拟题\n1.中国证券投资基金业协会数据显示，截至2022年7月末，私募基金管理基金规模达( )亿元，较上月增加超4200亿元。答案：A\n' +
    '2.国家电影局最新数据显示，截至8月14日16时，2022年电影暑期档累计票房已达( )元，超过2021年暑期档总票房成绩。答案：C\n' +
    '3.8月14日，2022年男排亚洲杯决赛中，中国男排以3比0击败( )队，时隔十年重夺亚洲杯冠军。答案：A\n' +
    '4.8月14日，第六届丝绸之路国际博览会暨中国东西部合作与投资贸易洽谈会在( )开幕。答案：B\n结构化面试模拟题\n20道结构化模拟题\n' +
    SOHU_TAIL

  it('标题确实越过了阈值——拦住它的只能是这条降级', () => {
    expect(titleSim(foldTitle(练一.title), foldTitle(练二.title))).toBeGreaterThan(SEARCH_PROFILE.titleThreshold)
  })

  it('同站 + 标题过阈值 + 正文不同 → 不并（而且确实去抓了正文）', async () => {
    const { deps, calls } = fakeReader({ [练一.url!]: 正文一, [练二.url!]: 正文二 })
    expect(await foldWithText([练一, 练二], SEARCH_PROFILE, deps)).toHaveLength(2)
    expect(calls.sort()).toEqual([练二.url, 练一.url].sort())
  })

  it('第 2 档不可用（没接抓取器）→ 维持今天的行为，同站标题像照样直接并', async () => {
    const groups = await foldWithText([练一, 练二], SEARCH_PROFILE)
    expect(groups).toHaveLength(1)
    expect(groups[0].why[0].kind).toBe('title-dice')
  })

  it('同站标题相同的真转载：降级只是多问一句，正文确认后照样并', async () => {
    const 转载 = body('这一段是两个号一字不差转的同一篇稿子')
    const hits = [h('复旦团队制备单铜氧层高温超导体', 'https://www.sohu.com/a/111_1'), h('复旦团队制备单铜氧层高温超导体', 'https://www.sohu.com/a/222_2')]
    const { deps } = fakeReader({
      [hits[0].url!]: `甲号自己的导语。${转载}${SOHU_TAIL}`,
      [hits[1].url!]: `乙号换了个开头。${转载}${SOHU_TAIL}`,
    })
    const groups = await foldWithText(hits, SEARCH_PROFILE, deps)
    expect(groups).toHaveLength(1)
    expect(groups[0].why[0].kind).toBe('text-identity')
  })

  it('跨站的标题像仍然免费判完——一次正文都不抓', async () => {
    const { deps, calls } = fakeReader({})
    const groups = await foldWithText([h(练一.title, 'https://a.example/1'), h(练二.title, 'https://b.example/2')], SEARCH_PROFILE, deps)
    expect(groups).toHaveLength(1)
    expect(groups[0].why[0].kind).toBe('title-dice')
    expect(calls).toHaveLength(0)
  })
})

describe('sharedStoryRun —— 剥共同页眉页脚的边界', () => {
  it('跨站一律不剥：两个不同站的共同后缀是内容，不是样板', () => {
    const a = `${body('甲站自己的导航')}这是两边一字不差的通稿正文段落，长度足够越过门槛。`.repeat(1)
    const b = `${body('乙站完全不同的板块文案')}这是两边一字不差的通稿正文段落，长度足够越过门槛。`
    expect(sharedStoryRun(a, b, false)).toBe(longestSharedRun(a, b))
  })

  it('共同尾巴长过较短那篇的一半 → 认它是正文，不是页脚（同站一字不差的转载）', () => {
    const wire = body('这一段是两个号一字不差转的同一篇通稿')
    expect(sharedStoryRun(`甲号加了一句。${wire}`, `乙号换了个开头。${wire}`, true)).toBeGreaterThan(
      SEARCH_PROFILE.text!.minSharedChars,
    )
  })
})

/**
 * **门槛那条线的两侧各钉一个真样本**（跨站实测，整张表在 `src/text/shingle.ts` 的
 * `longestSharedRun`）。这两个数是门槛只能落在 (125, 142] 的全部理由——调它之前先看这里。
 */
describe('minSharedChars —— 130 卡在哪两个真样本之间', () => {
  /** 两篇毫不相干的技术页面（Qiita 的 Docker 笔记 × docling 的 GitHub issue）共享的
   *  Python traceback 尾巴。**这一段是机器生成的，谁贴出来都一模一样。** */
  const TRACEBACK =
    'inimportmodulereturnbootstrapgcdimportnamelevelpackagelevelimporterrorlibglso1cannotopensharedobjectfilenosuchfileordirectory'

  /** 同一篇英伟达财报通稿的两个转载（新浪财经 × 百家号，活体共享 654 字）里的前 142 字。 */
  const REPRINT =
    '消息公布后英伟达股价最初下跌超过3随后转涨第二季度业绩展望方面英伟达预计营收将在891亿至928亿美元之间而华尔街此前预期为873亿美元第一季度英伟达实现每股收益eps187美元营收8162亿美元高于分析师预期的每股177美元和营收7918亿美元公司还将季度股息提高至每股025美元英'

  it('机器输出那一侧：125 字的 traceback 必须够不着', () => {
    expect(TRACEBACK.length).toBe(125)
    expect(SEARCH_PROFILE.text!.minSharedChars).toBeGreaterThan(TRACEBACK.length)
  })

  it('真转载那一侧：142 字（实测里第二短的真转载）必须过得去', () => {
    expect(REPRINT.length).toBe(142)
    expect(SEARCH_PROFILE.text!.minSharedChars).toBeLessThanOrEqual(REPRINT.length)
  })

  it('端到端：只共享一段 traceback 的两篇不并，共享一段通稿的两篇并', async () => {
    const pad = (seed: string) => `${seed}`.repeat(30)
    const hits = [
      h('Docker 里 opencv 起不来的排查笔记', 'https://qiita.example/1'),
      h('docling 2.65 装完 import 就炸', 'https://github.example/2'),
      h('英伟达财报出炉营收利润双超预期', 'https://sina.example/3'),
      h('英伟达一季度业绩超预期芯片销售强劲', 'https://baijiahao.example/4'),
    ]
    const { deps } = fakeReader({
      [hits[0].url!]: `${pad('这里是笔者自己写的排查过程与环境说明。')}${TRACEBACK}`,
      [hits[1].url!]: `${pad('这是另一个项目下完全不同的一份 issue 讨论记录。')}${TRACEBACK}`,
      [hits[2].url!]: `${pad('前面各站自己的导航与推荐位。')}${REPRINT}`,
      [hits[3].url!]: `${pad('另一个站自己的板块与免责声明文案。')}${REPRINT}`,
    })
    const groups = await foldWithText(hits, SEARCH_PROFILE, deps)
    expect(groups.map((g) => g.rep.url)).toEqual([hits[0].url, hits[1].url, hits[2].url])
    expect(groups[2].members.map((m) => m.url)).toEqual([hits[3].url])
  })
})
