/**
 * 五张定制卡的纯渲染单测。每张都喂三种 block：**结构化 / 纯文本 / 坏数据**——
 * 三条路都必须走通，且坏数据那条**绝不抛**（渲染器抛错会被 DSH 的 entry boundary 记成崩溃
 * 并把这一格退出去，坏数据不该有这个后果）。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { configureBackend } from '../src/deep-links.ts'
import { ContentSearchCard } from '../src/client/cards/ContentSearchCard.tsx'
import { EventsCard } from '../src/client/cards/EventsCard.tsx'
import { ExtractCard } from '../src/client/cards/ExtractCard.tsx'
import { StreamListCard } from '../src/client/cards/StreamListCard.tsx'
import { SubscribeCard } from '../src/client/cards/SubscribeCard.tsx'
import { PurchaseDecideCard } from '../src/client/cards/PurchaseDecideCard.tsx'
import { AgentRunCard } from '../src/client/cards/AgentRunCard.tsx'

// 深链的基址不再是常量，由 `apply()` 从页面常量下发（见 src/wire.ts）。这些卡的断言里带着
// 具体 URL，所以这里先配一个——**没配到时深链降级成不可点文本**，那条路由
// `test/backend-config.test.tsx` 钉着，不在这里重复。
beforeAll(() => { configureBackend('http://127.0.0.1:8900') })

/** Stream 的 MCP 面今天的常态：一个 text block，内容是 JSON.stringify 的结果。 */
function textResult(data: unknown, args: Record<string, unknown> = {}): ToolCallBlock {
  return {
    kind: 'tool-result',
    seq: 1,
    time: 0,
    callId: 'call-1',
    call: { name: 'x', argsRaw: JSON.stringify(args) },
    callTime: null,
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError: false,
    callView: null,
    resultView: null,
    subCalls: [],
  } as unknown as ToolCallBlock
}

/** 结构化那条路：`structuredContent` 在场时优先吃它（文本刻意写成噪音，读到它就是走错了）。 */
function structuredResult(data: unknown, args: Record<string, unknown> = {}): ToolCallBlock {
  return {
    ...(textResult('TEXT-FALLBACK-SENTINEL', args) as unknown as Record<string, unknown>),
    structuredContent: data,
  } as unknown as ToolCallBlock
}

/** 坏数据：既不是 JSON，也没有结构化。 */
function malformed(text = '<<not json at all>>'): ToolCallBlock {
  return {
    kind: 'tool-result',
    seq: 1,
    time: 0,
    callId: 'call-1',
    call: null,
    callTime: null,
    content: [{ type: 'text', text }],
    isError: false,
    callView: null,
    resultView: null,
    subCalls: [],
  } as unknown as ToolCallBlock
}

/** 还在跑。 */
function running(args: Record<string, unknown> = {}): ToolCallBlock {
  return {
    callId: 'call-1',
    name: 'x',
    argsRaw: JSON.stringify(args),
    turn: 0,
    step: 0,
    time: 0,
    callView: null,
    subCalls: [],
  } as unknown as ToolCallBlock
}

const href = (name: string | RegExp) => screen.getByRole('link', { name }).getAttribute('href')

describe('ExtractCard', () => {
  const done = { status: 'done', result: { text: '第一段正文。', format: 'plain', branch: 'stt' } }

  it('文本回落：从 JSON 文本里读出正文和分支', () => {
    render(<ExtractCard block={textResult(done, { item: 'item-1' })} />)
    expect(screen.getByText('第一段正文。')).toBeTruthy()
    expect(screen.getByText('语音识别')).toBeTruthy()
    expect(screen.getByText('item item-1')).toBeTruthy()
  })

  it('结构化优先：structuredContent 在场时不去读文本', () => {
    render(<ExtractCard block={structuredResult(done)} />)
    expect(screen.getByText('第一段正文。')).toBeTruthy()
    expect(screen.queryByText(/TEXT-FALLBACK-SENTINEL/)).toBeNull()
  })

  it('坏数据：原样摆文本，不抛', () => {
    const { container } = render(<ExtractCard block={malformed()} />)
    expect(container.querySelector('[data-stream-fallback]')?.textContent).toBe('<<not json at all>>')
  })

  it('长正文折起来并说清折了多少', () => {
    const long = { status: 'done', result: { text: 'あ'.repeat(3000), branch: 'stt' } }
    render(<ExtractCard block={textResult(long)} />)
    expect(screen.getByText(/共 3000 字/)).toBeTruthy()
  })

  it('running 只报进行中', () => {
    render(<ExtractCard block={running({ item: 'i' })} />)
    expect(screen.getByText('进行中')).toBeTruthy()
  })

  // 「这是哪一条」归这张卡答：提示语那边只发句柄和标题（作者/来源/链接不是 extract 的入参，
  // 倒进去只会把用户那条消息撑成一屏 query string）。回执自己就带着 snapshot。
  it('回执带 snapshot → 画标题 + 来源 + 原文链接，不再只报一串裸 id', () => {
    const withSnap = {
      ...done,
      snapshot: { title: '郑钦文捐赠100万元，驰援西藏吉隆泥石流灾区', source: 'douyin-follow', url: 'https://x.test/v/1' },
    }
    render(<ExtractCard block={textResult(withSnap, { item: '54302ede' })} />)
    expect(screen.getByText('郑钦文捐赠100万元，驰援西藏吉隆泥石流灾区')).toBeTruthy()
    expect(screen.getByText('douyin-follow')).toBeTruthy()
    expect(screen.getByRole('link', { name: '原文' }).getAttribute('href')).toBe('https://x.test/v/1')
    expect(screen.queryByText('item 54302ede')).toBeNull()
  })

  it('snapshot 缺席 / 标题就是句柄本身 → 退回 `item <句柄>`，绝不空着', () => {
    render(<ExtractCard block={textResult(done, { item: 'i-1' })} />)
    expect(screen.getByText('item i-1')).toBeTruthy()
    const asHandle = { ...done, snapshot: { title: 'tmdb:99:S01E02', source: 'netdisk' } }
    render(<ExtractCard block={textResult(asHandle, { item: 'tmdb:99:S01E02' })} />)
    expect(screen.getByText('item tmdb:99:S01E02')).toBeTruthy()
  })

  // 画面文字层（frames）在场 = 这条视频画面上另有一份字，正文里一个都没有。
  it('回执带 on_screen_text → 标出状态，并把画面上的字单独画一块', () => {
    const withText = { ...done, on_screen_text: { status: 'done', text: '[00:03] 中华慈善总会携手网球运动员郑钦文', note: 'n' } }
    render(<ExtractCard block={textResult(withText)} />)
    expect(screen.getByText('画面文字·已就绪')).toBeTruthy()
    expect(screen.getByText('画面上的字')).toBeTruthy()
    expect(screen.getByText(/中华慈善总会携手网球运动员郑钦文/)).toBeTruthy()
  })

  it('探过没料 → 说「画面上没有转写之外的字」，不留空块', () => {
    render(<ExtractCard block={textResult({ ...done, on_screen_text: { status: 'done', empty: true, note: 'n' } })} />)
    expect(screen.getByText(/画面上没有转写之外的字/)).toBeTruthy()
  })

  // 后端在这一档**刻意不给正文**（src/mcp/extract-frames-layer.ts）：给了半份，模型就会
  // 拿它总结。卡片得把它画成一个正常的中间态，别掉进「结构读不出来」那条原文回落。
  it('等画面文字那一档：画成「还在取」，不摊一坨 JSON', () => {
    const waiting = { status: 'running', item: 'i-1', waiting_for: 'on_screen_text', note: '…' }
    const { container } = render(<ExtractCard block={textResult(waiting, { item: 'i-1' })} />)
    expect(screen.getByText('等画面文字')).toBeTruthy()
    expect(screen.getByText(/正文现在还不完整/)).toBeTruthy()
    expect(container.querySelector('[data-stream-fallback]')).toBeNull()
  })

  // 这一档比上一档更常见（转写本身在跑），而它此前**没有自己的分支**——直接掉进原文回落。
  // 活体 2026-08-30 用户看到的就是这个：一轮五张卡、张张是 JSON。
  it('转写还在跑那一档：也要画成「还在取」，不摊 JSON', () => {
    const running = { status: 'running', item: 'i-1', snapshot: { title: '泛式新番导视' } }
    const { container } = render(<ExtractCard block={textResult(running, { item: 'i-1' })} />)
    expect(screen.getByText('转写中')).toBeTruthy()
    expect(screen.getByText('泛式新番导视')).toBeTruthy() // 说清"在转哪一条"
    expect(container.querySelector('[data-stream-fallback]')).toBeNull()
  })

  it('缩略图：snapshot.poster 在场就画一张，缺席不留空框', () => {
    const withPoster = { ...done, snapshot: { title: '泛式新番导视', source: 'bilibili', poster: 'https://x.test/cover.jpg' } }
    const { container } = render(<ExtractCard block={textResult(withPoster, { item: 'i-1' })} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://x.test/cover.jpg')
    const noPoster = render(<ExtractCard block={textResult({ ...done, snapshot: { title: 'T2' } }, { item: 'i-2' })} />)
    expect(noPoster.container.querySelector('img')).toBeNull()
  })

  // 回落那一档也要说清"这是哪一条"——否则形状一变，用户面前就是一坨没有主语的 JSON。
  it('原文回落时仍然画出条目身份', () => {
    const weird = { status: 'done', snapshot: { title: '泛式新番导视' }, result: { branch: 'stt' } }
    const { container } = render(<ExtractCard block={textResult(weird, { item: 'i-1' })} />)
    expect(screen.getByText('泛式新番导视')).toBeTruthy()
    expect(container.querySelector('[data-stream-fallback]')).toBeTruthy()
  })

  it('digested: true → 标「要点摘要」badge，footer 用 full_text_chars 报全文字数（不是摘要自身长度）', () => {
    const digested = {
      status: 'done',
      result: { text: '- 要点一「引文」', branch: 'stt', digested: true, full_text_chars: 9000 },
    }
    render(<ExtractCard block={textResult(digested)} />)
    expect(screen.getByText('要点摘要')).toBeTruthy()
    expect(screen.getByText(/全文共 9000 字/)).toBeTruthy()
    // 不把摘要自身的字符数当成"共 N 字"报出来（那是旧的截断 footer,digest 档不该出现）。
    expect(screen.queryByText(/共 \d+ 字，上面是开头/)).toBeNull()
  })

  it('digest 档带 item → 出「查看全文」入口(全文由卡片从 API 取给人看,不经模型)', () => {
    const digested = {
      status: 'done',
      result: { text: '- 要点「引」', branch: 'stt', digested: true, full_text_chars: 9000 },
    }
    render(<ExtractCard block={textResult(digested, { item: 'i9' })} />)
    expect(screen.getByText('查看全文')).toBeTruthy()
  })

  it('digest_failed: true → 显式标出压缩失败、以下为截断原文', () => {
    const failed = {
      status: 'done',
      result: { text: 'A'.repeat(4000), branch: 'stt', digested: true, digest_failed: true, full_text_chars: 9000 },
    }
    render(<ExtractCard block={textResult(failed)} />)
    expect(screen.getByText('压缩失败·原文截断')).toBeTruthy()
    expect(screen.getByText(/压缩失败，以下为截断原文/)).toBeTruthy()
  })
})

describe('SubscribeCard', () => {
  it('文本回落 + 深链回具名频道', () => {
    render(
      <SubscribeCard
        block={textResult({ subscribed: 'my-feed' }, { id: 'my-feed', description: '我的订阅', cadence_seconds: 900, sources: [{}, {}] })}
      />,
    )
    expect(screen.getByText('我的订阅')).toBeTruthy()
    expect(screen.getByText('每 900 秒刷新 · 2 个源')).toBeTruthy()
    expect(href(/在 Stream 打开这个频道/)).toBe('http://127.0.0.1:8900/c/my-feed')
  })

  it('结构化优先', () => {
    render(<SubscribeCard block={structuredResult({ subscribed: 'a b' }, { id: 'a b' })} />)
    expect(href(/在 Stream 打开这个频道/)).toBe('http://127.0.0.1:8900/c/a%20b')
  })

  it('坏数据不抛，摆原文', () => {
    const { container } = render(<SubscribeCard block={malformed()} />)
    expect(container.querySelector('[data-stream-fallback]')).toBeTruthy()
  })
})

describe('ContentSearchCard', () => {
  const items = [
    { id: 'i1', title: '第一条', url: 'https://example.com/1', stream_id: 's1', author: '小明', timestamp: '2026-08-01T00:00:00Z' },
    { id: 'i2', title: '第二条', stream_id: 's2' },
  ]

  it('文本回落：每条一行，带外链和回频道的深链', () => {
    render(<ContentSearchCard block={textResult(items, { query: '播客' })} />)
    expect(screen.getByText('内容搜索：播客')).toBeTruthy()
    expect(href('第一条')).toBe('https://example.com/1')
    expect(screen.getByText('小明 · 2026-08-01')).toBeTruthy()
    expect(screen.getAllByRole('link', { name: '在 Stream 打开' })[0]?.getAttribute('href')).toBe(
      'http://127.0.0.1:8900/c/s1',
    )
    expect(href(/去 Stream 的内容搜索页/)).toBe('http://127.0.0.1:8900/search')
  })

  it('结构化优先', () => {
    render(<ContentSearchCard block={structuredResult(items)} />)
    expect(screen.getByText('第二条')).toBeTruthy()
  })

  it('空结果说「没有结果」，坏数据摆原文 —— 两者不能混为一谈', () => {
    const empty = render(<ContentSearchCard block={textResult([])} />)
    expect(empty.getByText('没有结果')).toBeTruthy()
    const bad = render(<ContentSearchCard block={malformed()} />)
    expect(bad.container.querySelector('[data-stream-fallback]')).toBeTruthy()
  })
})

describe('StreamListCard', () => {
  it('文本回落：每行一个 /c/<id> 深链', () => {
    render(<StreamListCard block={textResult([{ id: 'feed-a', description: 'A 站动态' }])} />)
    expect(href('A 站动态')).toBe('http://127.0.0.1:8900/c/feed-a')
  })

  it('结构化优先 + 空清单', () => {
    render(<StreamListCard block={structuredResult([])} />)
    expect(screen.getByText('还没有订阅')).toBeTruthy()
  })

  it('坏数据不抛', () => {
    const { container } = render(<StreamListCard block={malformed()} />)
    expect(container.querySelector('[data-stream-fallback]')).toBeTruthy()
  })
})

describe('EventsCard', () => {
  const events = [
    { id: 3, type: 'transcribe.done', at: 1, title: '转写完成', severity: 'info', ref: { kind: 'item', id: 'i1' } },
    { id: 4, type: 'harvest.error', at: 2, title: '采集失败', body: '连不上', severity: 'error', ref: { kind: 'stream', id: 's9' } },
  ]

  it('文本回落：stream ref 给深链，item ref 不给（Stream 没有 item 路由）', () => {
    render(<EventsCard block={textResult(events)} />)
    expect(screen.getByText('转写完成')).toBeTruthy()
    expect(screen.getByText('连不上')).toBeTruthy()
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute('href')).toBe('http://127.0.0.1:8900/c/s9')
  })

  it('结构化优先', () => {
    render(<EventsCard block={structuredResult(events)} />)
    expect(screen.getByText('采集失败')).toBeTruthy()
  })

  it('空 / 坏数据两条路都稳', () => {
    expect(render(<EventsCard block={textResult([])} />).getByText('没有新通知')).toBeTruthy()
    expect(render(<EventsCard block={malformed()} />).container.querySelector('[data-stream-fallback]')).toBeTruthy()
  })
})

describe('PurchaseDecideCard', () => {
  /** job 回执的形状(src/agent/purchase/job.ts DecisionReceipt),数字全是后端算的。 */
  const receipt = {
    constraints: { category: ['手机'], priceRange: { min: 0, max: 5000 }, softCriteria: ['拍照'], holdDays: 730, willResell: false },
    universeSource: 'catalog:@streamapp/zol/zol-phones',
    products: [
      {
        name: 'OPPO Find X9',
        image: 'https://2a.zol-img.com.cn/product/x.jpg',
        prices: [{ platform: '京东自营', price: '3898元', url: 'https://cu.manmanbuy.com/a.aspx' }, { platform: '天猫', price: '3951元(含国补)' }],
        cost: { kind: 'ownership', purchase: 3749, resale: 0, days: 730, basis: '用户说不会转手,残值按 0 计。' },
        experience_rank: 1,
        pros: ['主摄能拍清日常'],
        cons: [],
        fit: '被 2 篇横评就「拍照」点名。',
        evidence: [{ source: '【2026年9月手机推荐】', url: 'https://www.bilibili.com/video/av1', point: '主摄能拍清日常' }],
        comparable_cost: 5.1356,
        cost_unit: '元/天',
      },
      {
        name: 'vivo X300',
        prices: [{ platform: '京东自营', price: '4299元' }],
        cost: { kind: 'ownership', purchase: 4299, resale: 0, days: 730, basis: '用户说不会转手,残值按 0 计。' },
        experience_rank: 2,
        pros: ['长焦'],
        cons: [],
        fit: '被 1 篇横评就「拍照」点名。',
        evidence: [{ source: '小红书 @评测 拍照梯队' }],
        comparable_cost: 5.889,
        cost_unit: '元/天',
      },
    ],
    frontier: ['OPPO Find X9'],
    dominated: [{ name: 'vivo X300', by: 'OPPO Find X9', why: '代价更低(5.14 元/天 vs 5.89 元/天),体验也更好——两个维度都不占优,不必再考虑。' }],
    unranked: [{ model: '荣耀X80', reason: 'no_mention', detail: '读过的横评没有为这个条件点它的名。' }],
    unrankedCounts: { no_mention: 156 },
    unmatchedRaw: [],
    coverage: { universe: 158, named: 2, unmatched: 0, droppedMentions: 0, reviewsRead: 3, reviewsFound: 20, priced: 2, residualKnown: 0, stopped: 'truncated' },
    residual: { mode: 'none', note: '用户说不会转手,残值按 0 计。' },
    gaps: [{ stage: 'signal', subject: '某篇', reason: 'fetch failed' }],
    legend: {},
    note: 'x',
  }

  it('文本回落:产品做列、维度做行,前沿列打星,被斩的划掉但留在表里,覆盖率在卡头', () => {
    render(<PurchaseDecideCard block={textResult(receipt)} />)
    expect(screen.getByText('选品对比：手机')).toBeTruthy()
    expect(screen.getAllByText('OPPO Find X9').length).toBeGreaterThan(0)
    expect(screen.getAllByText('vivo X300').length).toBeGreaterThan(0)
    expect(screen.getByTitle('前沿')).toBeTruthy()
    expect(screen.getByText('已排除')).toBeTruthy()
    expect(screen.getByText(/代价更低/)).toBeTruthy()
    // 覆盖率是结论的一部分:枚举了多少、点名多少、进比较多少;truncated 要有徽标
    expect(screen.getByText(/枚举 158 台 · 横评点名 2 台 · 进比较 2 台/)).toBeTruthy()
    expect(screen.getByText('清单不全')).toBeTruthy()
    // 代价格 + 斩杀理由里各出现一次——两处都该有
    expect(screen.getAllByText(/5\.14 元\/天/).length).toBe(2)
    expect(screen.getByText(/3951元/)).toBeTruthy()
    expect(screen.getByText('+ 长焦')).toBeTruthy()
    // 页脚:没进比较的数字来自 unrankedCounts,不是数 unranked 的举例
    expect(screen.getByText(/156 台没被横评点名/)).toBeTruthy()
    expect(screen.getByText(/1 处取数失败/)).toBeTruthy()
    // 购买链接:平台名就是入口;商品图:列头缩略图,no-referrer 防 CDN 拒热链
    const buy = screen.getByText(/京东自营 ↗/)
    expect(buy.getAttribute('href')).toBe('https://cu.manmanbuy.com/a.aspx')
    const img = document.querySelector('[data-stream-card] img')
    expect(img?.getAttribute('src')).toBe('https://2a.zol-img.com.cn/product/x.jpg')
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('依据行:有 url 的来源渲染成外链,没 url 的纯文本,point 跟在后面', () => {
    render(<PurchaseDecideCard block={textResult(receipt)} />)
    const ev = screen.getByText(/【2026年9月手机推荐】 ↗/)
    expect(ev.getAttribute('href')).toBe('https://www.bilibili.com/video/av1')
    // 优点行一次、依据的 point 一次
    expect(screen.getAllByText(/主摄能拍清日常/).length).toBe(2)
    expect(screen.getByText(/小红书 @评测 拍照梯队/).getAttribute('href')).toBeNull()
  })

  it('残值口径 purchase_only 要在表上方大声说,不许只藏在某台的 basis 里', () => {
    const r = JSON.parse(JSON.stringify(receipt)) as typeof receipt
    r.residual = { mode: 'purchase_only', note: '用户打算 365 天后转手,但残值来源没接上——这里按买入价算,没扣残值。' }
    render(<PurchaseDecideCard block={textResult(r)} />)
    expect(screen.getByText('未扣残值')).toBeTruthy()
    expect(screen.getByText(/没扣残值/)).toBeTruthy()
  })

  it('一台都没进比较:不画空表,说清是没被点名还是没拿到价', () => {
    const r = JSON.parse(JSON.stringify(receipt)) as typeof receipt
    r.products = []
    r.frontier = []
    r.dominated = []
    r.unrankedCounts = { no_mention: 150, no_price: 3 } as never
    const { container } = render(<PurchaseDecideCard block={textResult(r)} />)
    expect(container.querySelector('table')).toBeNull()
    expect(container.querySelector('[data-stream-empty]')?.textContent).toContain('150 台没被横评点名')
    expect(container.querySelector('[data-stream-empty]')?.textContent).toContain('3 台没拿到可算的价格')
  })

  it('非 http 的 image/url/evidence url 渲染端也丢弃', () => {
    const bad = JSON.parse(JSON.stringify(receipt)) as { products: { image?: string; prices: { url?: string }[]; evidence: { url?: string }[] }[] }
    bad.products[0]!.image = 'javascript:alert(1)'
    bad.products[0]!.prices[0]!.url = 'javascript:alert(1)'
    bad.products[0]!.evidence[0]!.url = 'javascript:alert(1)'
    render(<PurchaseDecideCard block={textResult(bad)} />)
    expect(document.querySelector('[data-stream-card] img')).toBeNull()
    expect(screen.queryByText(/京东自营 ↗/)).toBeNull()
    expect(screen.getByText(/【2026年9月手机推荐】/).getAttribute('href')).toBeNull()
  })

  it('结构化优先', () => {
    render(<PurchaseDecideCard block={structuredResult(receipt)} />)
    expect(screen.getAllByText('OPPO Find X9').length).toBeGreaterThan(0)
    expect(screen.queryByText(/TEXT-FALLBACK-SENTINEL/)).toBeNull()
  })

  it('坏数据不抛,摆原文', () => {
    const { container } = render(<PurchaseDecideCard block={malformed()} />)
    expect(container.querySelector('[data-stream-fallback]')?.textContent).toBe('<<not json at all>>')
  })

  it('running 只报进行中', () => {
    render(<PurchaseDecideCard block={running()} />)
    expect(screen.getByText('进行中')).toBeTruthy()
  })

  it('异步发起回执 {runId,status} → 画"已发起"，不摆 JSON', () => {
    const { container } = render(<PurchaseDecideCard block={textResult({ runId: 'r1', status: 'queued' })} />)
    expect(screen.getByText('已发起')).toBeTruthy()
    expect(container.querySelector('[data-stream-fallback]')).toBeNull()
  })

  describe('AgentRunCard（get_agent_run 的 purchase 档）', () => {
    it('跑着时把阶段一条条摆出来，当前那步加粗', () => {
      const run = { runId: 'r1', domain: 'purchase', status: 'running', stage: '找到 20 篇横评，读前 6 篇', stages: [{ note: '枚举全集' }, { note: '找到 20 篇横评，读前 6 篇' }] }
      const { container } = render(<AgentRunCard block={textResult(run)} />)
      expect(screen.getByText('进行中')).toBeTruthy()
      expect(container.querySelector('[data-stream-stages]')?.textContent).toContain('枚举全集')
      expect(screen.getByText('找到 20 篇横评，读前 6 篇').tagName).toBe('STRONG')
    })

    it('跑完把 receipt 交给同一张对比表', () => {
      render(<AgentRunCard block={textResult({ runId: 'r1', domain: 'purchase', status: 'done', receipt })} />)
      expect(screen.getByText('选品对比：手机')).toBeTruthy()
      expect(screen.getAllByText('OPPO Find X9').length).toBeGreaterThan(0)
      expect(screen.getByText('已排除')).toBeTruthy()
    })

    it('挂了：说原因和走到哪一步', () => {
      render(<AgentRunCard block={textResult({ runId: 'r1', domain: 'purchase', status: 'error', error: 'LLM 梯子上没有一个成员答成', stages: [{ note: '枚举全集' }] })} />)
      expect(screen.getByText('失败')).toBeTruthy()
      expect(screen.getByText(/LLM 梯子/)).toBeTruthy()
      expect(screen.getByText(/走到：枚举全集/)).toBeTruthy()
    })

    it('发现档（netdisk/catalog）不画表，摆原文回落', () => {
      const { container } = render(<AgentRunCard block={textResult({ runId: 'r2', domain: 'netdisk', status: 'done', targets: [] })} />)
      expect(container.querySelector('[data-stream-fallback]')).toBeTruthy()
    })

    it('坏数据不抛', () => {
      const { container } = render(<AgentRunCard block={malformed()} />)
      expect(container.querySelector('[data-stream-fallback]')?.textContent).toBe('<<not json at all>>')
    })
  })
})
