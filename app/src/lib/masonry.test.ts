// 分列器是瀑布流唯一有真算法的地方,也是唯一能在没有 DOM 的情况下彻底测掉的地方。
// 三条不变量:阅读顺序(左→右)、追加不重排、列数变了才全量重算。
import { describe, it, expect } from 'vitest'
import {
  assignColumns, cardMetrics, clampMediaRatio, columnCountFor, estimateCardHeight,
  DEFAULT_MEDIA_RATIO, MAX_COLUMNS, MEDIA_RATIO_MAX, MEDIA_RATIO_MIN, MIN_COLUMNS,
  type CardMetrics,
} from './masonry.ts'
import type { Item } from './types.ts'

const m = (id: string, over: Partial<CardMetrics> = {}): CardMetrics => ({
  id, hasMedia: false, title: '', summary: '', quote: '', ...over,
})

describe('columnCountFor', () => {
  it('按目标卡宽 210 算列数,并夹在 2..6', () => {
    expect(columnCountFor(300)).toBe(MIN_COLUMNS)   // 只够 1 列 → 抬到下界 2
    expect(columnCountFor(0)).toBe(MIN_COLUMNS)     // 容器还没测出来
    expect(columnCountFor(800)).toBe(3)
    expect(columnCountFor(872)).toBe(4)             // 工作台开着对话抽屉时的实测容器宽
    expect(columnCountFor(1050)).toBe(5)
    expect(columnCountFor(4000)).toBe(MAX_COLUMNS)  // 超宽屏 → 夹在上界 6
  })
})

describe('estimateCardHeight', () => {
  it('有封面时高度随图片比例增长', () => {
    const wide = estimateCardHeight(m('a', { hasMedia: true, mediaW: 800, mediaH: 400 }), 260)
    const tall = estimateCardHeight(m('b', { hasMedia: true, mediaW: 400, mediaH: 800 }), 260)
    expect(tall).toBeGreaterThan(wide)
  })

  it('缺尺寸的图退成默认比例,不是 0', () => {
    const h = estimateCardHeight(m('a', { hasMedia: true }), 260)
    expect(h).toBeGreaterThan(260 * 0.5)
  })

  it('纯文字卡有高度,且摘要越长越高', () => {
    const short = estimateCardHeight(m('a', { title: '短' }), 260)
    const long = estimateCardHeight(m('b', { title: '短', summary: '很长'.repeat(200) }), 260)
    expect(short).toBeGreaterThan(0)
    expect(long).toBeGreaterThan(short)
  })

  it('出带的竖图夹到上界,一张卡不能独占一整列', () => {
    const tall = estimateCardHeight(m('a', { hasMedia: true, mediaW: 100, mediaH: 5000 }), 260)
    const atMax = estimateCardHeight(m('b', { hasMedia: true, mediaW: 4, mediaH: 5 }), 260)
    expect(tall).toBe(atMax)   // 50 倍和 1.25 倍最终占同样高——都被夹到上界
  })

  it('出带的横幅图夹到下界,不缩成一条缝', () => {
    const wide = estimateCardHeight(m('a', { hasMedia: true, mediaW: 3000, mediaH: 300 }), 260)
    const atMin = estimateCardHeight(m('b', { hasMedia: true, mediaW: 16, mediaH: 9 }), 260)
    expect(wide).toBe(atMin)
  })

  // 估高器和渲染端共用这一个函数——这条链上"只改一端"出过三次事,所以带的边界值本身也要钉。
  it('clampMediaRatio 只夹出界的,带内原样返回', () => {
    expect(clampMediaRatio(5)).toBe(MEDIA_RATIO_MAX)
    expect(clampMediaRatio(0.1)).toBe(MEDIA_RATIO_MIN)
    expect(clampMediaRatio(0.75)).toBe(0.75)          // 实测中位数,必须在带内
    expect(clampMediaRatio(MEDIA_RATIO_MIN)).toBe(MEDIA_RATIO_MIN)
    expect(clampMediaRatio(MEDIA_RATIO_MAX)).toBe(MEDIA_RATIO_MAX)
  })

  it('占位比例落在带内(否则缺尺寸的图一上来就被自己的默认值夹一刀)', () => {
    expect(clampMediaRatio(DEFAULT_MEDIA_RATIO)).toBe(DEFAULT_MEDIA_RATIO)
  })
})

describe('assignColumns', () => {
  it('等高卡片按阅读顺序左→右铺开(并列时取最左的列)', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => m(id, { title: 'x' }))
    const s = assignColumns(items, 3, 260)
    expect(s.columns).toEqual([['a', 'd'], ['b', 'e'], ['c', 'f']])
  })

  it('矮卡片投进当前最矮的列', () => {
    const items = [
      m('tall', { hasMedia: true, mediaW: 100, mediaH: 300 }),
      m('short', { title: 'x' }),
      m('next', { title: 'x' }),
    ]
    const s = assignColumns(items, 2, 260)
    // tall→col0, short→col1(空), next→col1(仍然比 col0 矮)
    expect(s.columns[0]).toEqual(['tall'])
    expect(s.columns[1]).toEqual(['short', 'next'])
  })

  it('追加走增量:已经分好的卡片列归属一个都不动', () => {
    // 用不等高的卡片(而不是清一色 title:'x')做夹具,让高度分布贴近真实场景。
    //
    // 注意:对这里这种纯贪心左折叠算法而言,"从零全量重算"和"接着上次状态继续折叠"
    // 在数学上必然给出完全相同的列归属(折叠的可结合性:把 fold 从中间切开,用前半段
    // 的累积状态接着跑后半段,和整段一次跑完是同一个结果)。所以这条测试**抓不到**
    // "把追加偷偷实现成每次全量重算"这一类 bug(因为该 bug 对这个算法而言不改变输出)。
    // 这条测试真正守住的是:已经分配过列归属的前缀卡片不会被重排/挪列——比如换成按
    // 高度排序的 bin-packing、或非确定性的并列 tie-break,都会让前缀的列归属发生变化,
    // 能被下面的前缀断言抓到。它还守住 e、f 这两张新卡确实被放进了某一列(不会因为
    // start 下标算错——比如误用 metrics.length 而不是 prev.itemCount——被悄悄漏算掉)。
    // start 算错导致**重复** push 的情形(如 start 误为 0 却复用 prev.columns)也会被
    // 下面那条 flat().sort() 断言抓到——重复会让它变成 10 项而不是 6 项;不过专门守这一类
    // 的是下面「重复调用是幂等的」那条测试,它把同一批 items 再喂一遍,更直接。
    const first = [
      m('a', { hasMedia: true, mediaW: 100, mediaH: 400 }),
      m('b', { title: 'x' }),
      m('c', { hasMedia: true, mediaW: 100, mediaH: 100 }),
      m('d', { title: 'x'.repeat(80) }),
    ]
    const s1 = assignColumns(first, 3, 260)
    const appended = [
      ...first,
      m('e', { hasMedia: true, mediaW: 100, mediaH: 900 }),
      m('f', { title: 'x' }),
    ]
    const s2 = assignColumns(appended, 3, 260, s1)
    for (let i = 0; i < 3; i++) {
      expect(s2.columns[i].slice(0, s1.columns[i].length)).toEqual(s1.columns[i])
    }
    // 新追加的 e、f 必须真的落进某一列——不能因 start 下标算错(比如误用 metrics.length
    // 而不是 prev.itemCount)被悄悄丢弃。
    expect(s2.columns.flat().sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(s2.itemCount).toBe(6)
  })

  it('同一批 items 重复调用是幂等的(StrictMode 双跑不会重复追加)', () => {
    const items = ['a', 'b', 'c'].map((id) => m(id, { title: 'x' }))
    const s1 = assignColumns(items, 2, 260)
    const s2 = assignColumns(items, 2, 260, s1)
    expect(s2.columns).toEqual(s1.columns)
    expect(s2.itemCount).toBe(3)
  })

  it('列表被换掉(不再是上次的前缀)时全量重算', () => {
    const s1 = assignColumns(['a', 'b', 'c'].map((id) => m(id, { title: 'x' })), 2, 260)
    const s2 = assignColumns(['x', 'y'].map((id) => m(id, { title: 'x' })), 2, 260, s1)
    expect(s2.columns.flat().sort()).toEqual(['x', 'y'])
    expect(s2.itemCount).toBe(2)
  })

  it('列数变了全量重排(用户自己改了窗口宽度,这时重排是对的)', () => {
    const items = ['a', 'b', 'c', 'd'].map((id) => m(id, { title: 'x' }))
    const s1 = assignColumns(items, 2, 260)
    const s2 = assignColumns(items, 4, 260, s1)
    expect(s2.colCount).toBe(4)
    expect(s2.columns).toEqual([['a'], ['b'], ['c'], ['d']])
  })

  it('只有列宽变了(列数没变)不重排——缩放窗口不该让卡片洗牌', () => {
    // 夹具专门挑过。两类卡随列宽变化的方式不同,翻转就出在这个差上:
    //   媒体卡的高度随列宽**连续**变(colWidth × 比例),而文字卡是**离散**跳的(36 字标题
    //   在列宽 260 下换行成 2 行、300 下只 1 行,差一整个行高)。
    // 于是 4 张文字卡累加到某个点时,"下一张该投哪列"在 260 和 300 下会给出不同答案。
    // 下面的佐证断言证明这不是巧合:同一份卡片在列宽 300 下从零全量分配,列归属确实不同
    // ——所以"列宽变化不重排"这条断言是在验证一个真实会被打破的行为,不是空话。
    // (媒体卡的比例 0.11 会被 clampMediaRatio 夹到 MEDIA_RATIO_MIN,这里要的就是夹后的高度。)
    const items = [
      m('e', { hasMedia: true, mediaW: 1000, mediaH: 110 }),
      m('t1', { title: 'x'.repeat(36) }),
      m('t2', { title: 'x'.repeat(36) }),
      m('t3', { title: 'x'.repeat(36) }),
      m('t4', { title: 'x'.repeat(36) }),
    ]
    const s1 = assignColumns(items, 2, 260)
    const s2 = assignColumns(items, 2, 300, s1)
    expect(s2.columns).toEqual(s1.columns)

    // 佐证:同一份卡片在列宽 300 下从零全量分配,列归属确实会不同——证明上面的
    // 断言不是"反正列宽变了也分不出差异"的空话。
    const full = assignColumns(items, 2, 300)
    expect(full.columns).not.toEqual(s1.columns)
  })

  it('colCount<=0 时不炸,而是退化成 1 列(调用方绕过 columnCountFor 时的兜底)', () => {
    const items = ['a', 'b', 'c'].map((id) => m(id, { title: 'x' }))
    expect(() => assignColumns(items, 0, 260)).not.toThrow()
    const s = assignColumns(items, 0, 260)
    expect(s.columns.flat().sort()).toEqual(['a', 'b', 'c'])
  })

  it('每张卡恰好出现一次,一张不丢一张不重', () => {
    const ids = Array.from({ length: 37 }, (_, i) => `i${i}`)
    const s = assignColumns(ids.map((id) => m(id, { title: 'x'.repeat(id.length * 3) })), 4, 260)
    expect(s.columns.flat().sort()).toEqual([...ids].sort())
  })
})

describe('cardMetrics', () => {
  const base = { id: 'i1', stream_id: 's1', type: 'rss', timestamp: '', fetched_at: '' }

  it('从 item 取出封面尺寸和文字', () => {
    const item = { ...base, title: '标题', body_text: '正文内容' } as Item
    const got = cardMetrics(item)
    expect(got.id).toBe('i1')
    expect(got.title).toBe('标题')
    expect(got.summary).toContain('正文')
  })

  it('占位标题被剔成空串(和 usePostPresentation 用同一个规则)', () => {
    expect(cardMetrics({ ...base, title: '(无标题)' } as Item).title).toBe('')
  })

  // 引用卡是新的高度因素——按本文件头注那条前提,它必须两端同源:PostCard 画得出来,
  // 估高器就得记这笔账,否则转发帖多出来的那一块全是白账(雪球那条流 55/55 都是转发)。
  it('转发帖把原帖带进估高的账里(卡片会多画一个引用块)', () => {
    const item = {
      ...base,
      content: { archetype: 'forward', text: '我的评论', quoted: { author: '原作者', text: '原帖正文' } },
    } as unknown as Item
    const got = cardMetrics(item)
    expect(got.quote).toBe('原作者原帖正文')
    expect(estimateCardHeight(got, 260)).toBeGreaterThan(
      estimateCardHeight({ ...got, quote: '' }, 260)
    )
  })

  it('转发语为空时摘要不记两遍(渲染端也只画引用卡那一份)', () => {
    const item = {
      ...base,
      content: { archetype: 'forward', quoted: { author: '原作者', text: '原帖正文' } },
    } as unknown as Item
    expect(cardMetrics(item).summary).toBe('')
  })
})
