import { describe, it, expect } from 'vitest'
import { fold, sameStory, titleNeedsTextConfirm, numberSignature, serialSignature, serialConflict, foldTitle, hostOf, type Foldable } from './fold.ts'
import { SEARCH_PROFILE } from './profiles.ts'
import { titleSim } from '../text/similarity.ts'

const h = (title: string, url: string): Foldable => ({ title, url })

/**
 * **标注对**（T4）：人手标好的「是/不是同一件事」。阈值只许由这一组说了算——
 * 改阈值先来这里加反例，别去改判据迁就单条。
 *
 * 反例比正例重要：网盘那条线的教训是阈值太低把「第3期上」错配成「第3期下」，
 * 一字之差的短串也能过 0.6 分。
 */
const SAME: Array<[string, string, string]> = [
  ['转载：同一篇稿子换了个站', '怡楽播客回归首期正式上线', '怡楽播客回归首期正式上线'],
  ['转载带了个站名后缀', 'OpenAI 发布新模型 GPT-6', 'OpenAI 发布新模型 GPT-6_新浪科技'],
  ['英文转载，大小写与破折号差异', 'Apple unveils M6 chip', 'Apple Unveils M6 Chip - The Verge'],
  ['中文标题多了个书名号', '《流浪地球3》定档春节', '流浪地球3 定档春节'],
]

const DIFFERENT: Array<[string, string, string]> = [
  ['同一档节目的两集——最经典的误并', '怡乐播客-209.十五谈身边灵异事', '怡乐播客-210.十六谈身边灵异事'],
  ['上下集，一字之差', '某某访谈 第3期上', '某某访谈 第3期下'],
  ['同系列不同季', '脱口秀和Ta的朋友们 第二季', '脱口秀和Ta的朋友们 第三季'],
  ['字面像但说的是两件事', '现代版枪下留人', '现代版木仓下留人'],
  ['完全不相干', '三十探悬疑案件', '怡乐播客-209.十五谈身边灵异事'],
]

describe('sameStory —— 标注对说了算', () => {
  for (const [why, a, b] of SAME) {
    it(`并：${why}`, () => {
      // 转载天然发生在**不同站点**，所以标注对一律配不同 host。
      expect(sameStory(h(a, 'https://a.example/1'), h(b, 'https://b.example/2'), SEARCH_PROFILE)).toBeTruthy()
    })
  }
  for (const [why, a, b] of DIFFERENT) {
    it(`不并：${why}`, () => {
      expect(sameStory(h(a, 'https://a.example/1'), h(b, 'https://b.example/2'), SEARCH_PROFILE)).toBeNull()
    })
  }
})

/**
 * **同站的「标题像」要等正文确认**（`sameHostTitleNeedsText`，由 `withSameHostTextConfirm`
 * 在第 2 档可用时置位）。真样本是搜狐同一个号两天的「每日一练」：题目完全不同，
 * 标题只差最后那个尾巴词，Dice 0.857 越过 0.85，而序列身份挡不住它（一个号都没有）。
 */
describe('titleNeedsTextConfirm —— 同站的标题证据降级成疑似', () => {
  const 练一 = '每日一练|时事政治模拟题_答案_备考_普查'
  const 练二 = '每日一练|时事政治模拟题_备考_答案_结构化'
  const 沪一 = 'https://www.sohu.com/a/613889193_121124005'
  const 沪二 = 'https://www.sohu.com/a/577012683_121124005'
  const CONFIRM = { ...SEARCH_PROFILE, sameHostTitleNeedsText: true }

  it('这一对确实越过了阈值——所以拦住它的只能是这条降级，不是相似度不够', () => {
    expect(titleSim(foldTitle(练一), foldTitle(练二))).toBeGreaterThan(SEARCH_PROFILE.titleThreshold)
  })

  it('同站 + 标题过阈值 → 不在第 1 档并，留给第 2 档抓正文确认', () => {
    expect(sameStory(h(练一, 沪一), h(练二, 沪二), CONFIRM)).toBeNull()
    expect(fold([h(练一, 沪一), h(练二, 沪二)], CONFIRM)).toHaveLength(2)
  })

  it('跨站不受影响：标题像就直接并，一分钱不花', () => {
    const hit = sameStory(h(练一, 'https://a.example/1'), h(练二, 'https://b.example/2'), CONFIRM)
    expect(hit?.kind).toBe('title-dice')
  })

  it('同一个链接不受影响：URL 同一性是事实，不需要正文确认', () => {
    const hit = sameStory(h('甲标题', 'https://www.sohu.com/a/1'), h('乙标题完全不同', 'http://www.sohu.com/a/1/'), CONFIRM)
    expect(hit?.kind).toBe('url-identity')
  })

  it('第 2 档不可用（档里没置位）时维持原行为：同站标题相同照样直接并', () => {
    const hit = sameStory(h(练一, 沪一), h(练二, 沪二), SEARCH_PROFILE)
    expect(hit?.kind).toBe('title-dice')
  })

  it('抠不出 host 的（磁力）不算同站', () => {
    expect(titleNeedsTextConfirm({ title: 'a', url: 'magnet:?xt=urn:btih:abc' }, { title: 'b', url: 'magnet:?xt=urn:btih:def' }, CONFIRM)).toBe(false)
  })
})

describe('serialSignature —— 集号/期号/季号/上下集不同一票否决', () => {
  it('抠出串里所有数字，前导零不算差异（09 与 9 是同一集）', () => {
    expect(numberSignature('怡乐播客-209.十五谈')).toEqual(['209'])
    expect(numberSignature('S02E11 某剧')).toEqual(['2', '11'])
    expect(numberSignature('没有数字')).toEqual([])
    expect(numberSignature('第09期')).toEqual(numberSignature('第9期'))
  })

  it('中文数字和阿拉伯数字归到同一个签名——「第二季」就是「第2季」', () => {
    expect(serialSignature('某剧 第二季')).toContain('季:2')
    expect(serialSignature('某剧 第2季')).toContain('季:2')
    expect(serialSignature('某剧 第二十三期')).toContain('期:23')
    expect(serialSignature('某剧 第十期')).toContain('期:10')
  })

  it('上/下集只认结尾，正文里的「上」不算分卷', () => {
    expect(serialSignature('某某访谈 第3期上')).toContain('卷:上')
    expect(serialSignature('谁在操纵舆情上市公司')).not.toContain('卷:上')
  })
})

describe('foldTitle —— 比之前先把噪音抹平', () => {
  it('剪站名尾巴：转载各家加的招牌不该把相似度压下去', () => {
    expect(foldTitle('Apple Unveils M6 Chip - The Verge')).toBe(foldTitle('Apple unveils M6 chip'))
    expect(foldTitle('OpenAI 发布新模型 GPT-6_新浪科技')).toBe(foldTitle('OpenAI 发布新模型 GPT-6'))
  })

  it('不误伤标题内部的连字符（GPT-6 不是站名分隔符）', () => {
    expect(foldTitle('GPT-6 发布')).toContain('gpt6')
  })

  it('标点和大小写不承载身份', () => {
    expect(foldTitle('《流浪地球3》定档春节')).toBe(foldTitle('流浪地球3 定档春节'))
  })
})

describe('url-identity —— 同一个 URL 无条件同堆', () => {
  it('协议/尾斜杠/host 大小写的差异不算两条', () => {
    const g = fold([h('标题甲', 'http://Example.com/a/'), h('标题乙完全不同', 'https://example.com/a')], SEARCH_PROFILE)
    expect(g).toHaveLength(1)
    expect(g[0].members).toHaveLength(1)
    // 同 URL 是硬证据：标题再不像也并。
    expect(g[0].why[0].kind).toBe('url-identity')
  })

  it('路径大小写敏感——不同页面不许并', () => {
    expect(fold([h('甲', 'https://x.com/A'), h('乙', 'https://x.com/a')], SEARCH_PROFILE)).toHaveLength(2)
  })
})

describe('title-dice —— 同站跨站一视同仁，挡「同一系列两集」的是序列身份', () => {
  /**
   * **同站也并**：百家号/搜狐号/网易号是「一个域名、无数个发布者」，转载最密的地方恰好都在
   * 站内。活体样本：`baijiahao.../1873461228647244801` 与 `.../1873455319741533864` 是两个
   * 不同的号转的同一篇科技日报通稿，标题一字不差（Dice 1.00）。
   */
  it('同一个站里两条标题一样 → 两个号转了同一篇稿子，并', () => {
    const g = fold(
      [h('我科研团队成功制备单铜氧层高温超导体', 'https://baijiahao.baidu.com/s?id=1873461228647244801'),
       h('我科研团队成功制备单铜氧层高温超导体', 'https://baijiahao.baidu.com/s?id=1873455319741533864')],
      SEARCH_PROFILE,
    )
    expect(g).toHaveLength(1)
    expect(g[0].why[0].kind).toBe('title-dice')
  })

  /**
   * 同站禁并拆掉之后，**同一档节目的两集全靠序列身份挡着**。下面两条都是活体真页面
   * （同一个网易号 `…0529B00O` 连着发的两篇分集剧情），标题除了集号一模一样。
   *
   * 实测这一对的 Dice 是 **0.829**，本来就够不着 0.85——所以这条用例证明的是**结果**；
   * 证明「否决真的在起作用」的是下面那条直接断言，以及 `text-fold.test.ts` /
   * `semantic-fold.test.ts` 里「一次都不抓 / 一发都不问」的两条（那两档不看 Dice）。
   */
  it('同一个站、同一部剧的两段集号 → 不并', () => {
    const a = 'TVB最新电视剧《反黑英雄》分集剧情介绍（1-5集）'
    const b = 'TVB最新电视剧《反黑英雄》分集剧情介绍（6-10集）'
    expect(serialConflict(a, b)).toBe(true)
    expect(
      fold([h(a, 'https://www.163.com/dy/article/J5C2GU650529B00O.html'), h(b, 'https://www.163.com/dy/article/J5U5GD230529B00O.html')], SEARCH_PROFILE),
    ).toHaveLength(2)
  })

  /** 标题相似度**高到必并**、只有集号不同的同站两条：否决必须压过相似度。 */
  it('同站、Dice 高过阈值、只有集号不同 → 序列身份压过相似度', () => {
    const a = '综艺《一年一度喜剧大赛》第二季第3期完整版在线观看与嘉宾阵容一览'
    const b = '综艺《一年一度喜剧大赛》第二季第4期完整版在线观看与嘉宾阵容一览'
    // 先证明这一对**光看相似度是必并的**——否则下面那条断言就没有牙。
    expect(titleSim(foldTitle(a), foldTitle(b))).toBeGreaterThan(SEARCH_PROFILE.titleThreshold)
    expect(fold([h(a, 'https://x.example/1'), h(b, 'https://x.example/2')], SEARCH_PROFILE)).toHaveLength(2)
  })

  it('跨站同标题 → 转载，并', () => {
    const g = fold(
      [h('怡楽播客回归首期正式上线', 'https://a.com/1'), h('怡楽播客回归首期正式上线', 'https://b.com/2')],
      SEARCH_PROFILE,
    )
    expect(g).toHaveLength(1)
    expect(g[0].why[0].kind).toBe('title-dice')
  })
})

describe('fold —— 归堆本身的不变量', () => {
  const items = [
    h('OpenAI 发布新模型 GPT-6', 'https://a.com/1'),
    h('OpenAI 发布新模型 GPT-6_新浪科技', 'https://b.com/2'),
    h('OpenAI 发布新模型 GPT-6 - 腾讯网', 'https://c.com/3'),
    h('完全不相干的另一条新闻', 'https://d.com/4'),
  ]

  it('一条内容都不会消失：展开后等于输入', () => {
    const g = fold(items, SEARCH_PROFILE)
    const flat = g.flatMap((x) => [x.rep, ...x.members])
    expect(flat).toHaveLength(items.length)
    expect(new Set(flat.map((x) => x.url)).size).toBe(items.length)
  })

  it('三条转载收成一堆 + 一条独立', () => {
    const g = fold(items, SEARCH_PROFILE)
    expect(g).toHaveLength(2)
    expect(g[0].members).toHaveLength(2)
    expect(g[1].members).toHaveLength(0)
  })

  it('代表取输入序的第一条——搜索这一档里它就是相关性最高的那条', () => {
    expect(fold(items, SEARCH_PROFILE)[0].rep.url).toBe('https://a.com/1')
  })

  it('顺序保持：堆按代表在输入里的位置排，不重排结果', () => {
    const g = fold([items[3], items[0], items[1]], SEARCH_PROFILE)
    expect(g.map((x) => x.rep.url)).toEqual(['https://d.com/4', 'https://a.com/1'])
  })

  it('每次并堆都说得出理由', () => {
    const g = fold(items, SEARCH_PROFILE)
    expect(g[0].why).toHaveLength(2) // 两次并入各留一条
    for (const e of g[0].why) {
      expect(e.detail).toBeTruthy()
      expect(e.score).toBeGreaterThan(0)
    }
  })

  it('传递性：A~B、B~C 但 A≁C，三条仍进同一堆（并查集，不是逐对）', () => {
    const chain = [h('甲乙丙丁戊己庚辛', 'https://a.com/1'), h('丙丁戊己庚辛壬癸', 'https://b.com/2')]
    expect(fold(chain, { ...SEARCH_PROFILE, titleThreshold: 0.5 })).toHaveLength(1)
  })

  it('空输入不炸', () => {
    expect(fold([], SEARCH_PROFILE)).toEqual([])
  })

  it('没有 URL 的条目照样能进（站内内容那一档不一定有链接）', () => {
    const g = fold([{ title: '同一个标题' }, { title: '同一个标题' }], SEARCH_PROFILE)
    // host 未知 → 不认为是同站，按标题并。
    expect(g).toHaveLength(1)
  })
})

describe('hostOf', () => {
  it('抠 host，认不出就返回空串', () => {
    expect(hostOf('https://Www.Example.com/a')).toBe('www.example.com')
    expect(hostOf('不是个链接')).toBe('')
    expect(hostOf(undefined)).toBe('')
  })
})
