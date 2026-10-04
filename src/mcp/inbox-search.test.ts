/**
 * `inbox_search` 的**回执瘦身守卫** —— 本工具的命脉。
 *
 * 为什么它比其它用例重要：回执一胖，整轮对话当场炸。实测（2026-08-19）正是这条把一次提问打
 * 死的——`read_url` 抓整页、累计 416K token、上游 400 `Prompt exceeds max length`。库里一条
 * 雪球条目的完整 JSON 约 850 字符，其中绝大部分是 `raw`（上游原样 payload），几十条就够了。
 * 所以这里不是"检查几个字段"，是**逐个钉死三样绝不能出现的东西**：`raw` / `body_html` /
 * `content.media`。把 projectHit 改回 `{...item}` 这条测试必须当场红。
 */
import { describe, it, expect } from 'vitest'
import { projectHit, runInboxSearch, EXCERPT_LIMIT, INLINE_EXCERPT_LIMIT, MAX_LIMIT, DEFAULT_LIMIT } from './inbox-search.ts'
import type { StoredItem } from '../item-store.ts'

function stored(over: Partial<StoredItem> = {}): StoredItem {
  return {
    id: 'i1',
    stream_id: 'S',
    source_type: 'rsshub-bridge',
    source_route: '/x',
    fetched_at: '2026-08-17T00:00:00.000Z',
    timestamp: '2026-08-17T00:00:00.000Z',
    title: '标题',
    author: '大道无形我有型',
    url: 'https://xueqiu.com/1/2',
    body_html: '<p>一段 <b>富文本</b> 正文</p>',
    body_text: '一段富文本正文',
    content: {
      archetype: 'text',
      text: '正文',
      media: [{ kind: 'image', url: 'https://img.example/1.jpg' }],
    },
    raw: { huge: 'x'.repeat(5000) },
    type: 'post',
    ...over,
  } as StoredItem
}

/** 非 inline 那档的夹具（视频/图集）：正文不在条目上，转成文字要真跑一趟转换。 */
function video(over: Partial<StoredItem> = {}): StoredItem {
  return stored({ body_text: undefined, body_html: undefined, ...over })
}

describe('inbox_search 的回执投影', () => {
  it('只发瘦身字段 —— raw / body_html / content.media 一个都不进', () => {
    const hit = projectHit(stored())
    expect(Object.keys(hit).sort()).toEqual(['author', 'excerpt', 'full_text', 'id', 'stream_id', 'timestamp', 'title', 'url'])
    // 逐个钉：整份 JSON 里连这几个键名和它们的值都不该出现（嵌套着也算）。
    const wire = JSON.stringify(hit)
    expect(wire).not.toContain('raw')
    expect(wire).not.toContain('body_html')
    expect(wire).not.toContain('media')
    expect(wire).not.toContain('富文本') // body_html 的内容
    expect(wire).not.toContain('img.example') // content.media 的内容
  })

  it('回执体积比原条目小一个数量级', () => {
    const item = stored()
    const fat = JSON.stringify(item).length
    const thin = JSON.stringify(projectHit(item)).length
    expect(thin * 10).toBeLessThan(fat)
  })

  it('正文超长时截断，并把"这是截断的"明写进回执', () => {
    // 非 inline（视频档）用的是窄上限。
    const hit = projectHit(video({ content: { archetype: 'video', text: '句'.repeat(EXCERPT_LIMIT + 50), media: [{ kind: 'video', url: 'https://v/1.mp4' }] } }))
    expect(hit.excerpt).toHaveLength(EXCERPT_LIMIT)
    expect(hit.excerpt_truncated).toBe(true)
  })

  it('正文没超长时不谎报截断', () => {
    const hit = projectHit(stored({ content: { archetype: 'text', text: '短' } }))
    expect(hit.excerpt).toBe('短')
    expect(hit.excerpt_truncated).toBeUndefined()
  })

  it('没有 content.text 时回落 body_text；两者都没有就没有 excerpt 这一格', () => {
    expect(projectHit(stored({ content: undefined })).excerpt).toBe('一段富文本正文')
    expect(projectHit(stored({ content: undefined, body_text: undefined })).excerpt).toBeUndefined()
  })
})

/**
 * **inline 那档：全文已在回执里，别再去调 extract。**
 *
 * 活体实测（2026-08-19）：8 条纯文本雪球帖，模型连着调了 10 次 `extract`——因为回执只说了
 * "截断了"，而这类条目的全文本来就在库里，extract 只是把同一段文字原样再取一遍（10 个白跑的
 * 转换任务 + 一轮上下文）。判据不自己造：借 `shared/extract/plan.ts` 的 `planExtract`——
 * `inline` 档正是"正文本来就在条目上"，前端的「转成文字」按钮对这类条目根本不显示。
 */
describe('inline 条目不该被指去 extract', () => {
  it('纯文本帖：正文全给，且明写 full_text（= 别对它调 extract）', () => {
    const hit = projectHit(stored({ content: { archetype: 'text', text: '字'.repeat(EXCERPT_LIMIT + 200) } }))
    expect(hit.excerpt).toHaveLength(EXCERPT_LIMIT + 200) // 没被窄上限砍掉
    expect(hit.excerpt_truncated).toBeUndefined()
    expect(hit.full_text).toBe(true)
  })

  it('视频/音频/图片那类：不许声称 full_text —— 它们的正文真的要 extract 去取', () => {
    const v = projectHit(video({ content: { archetype: 'video', text: '标题下的一句话', media: [{ kind: 'video', url: 'https://v/1.mp4' }] } }))
    expect(v.full_text).toBeUndefined()
    const g = projectHit(video({ content: { archetype: 'gallery', text: '配图九宫格', media: [{ kind: 'image', url: 'https://i/1.jpg' }] } }))
    expect(g.full_text).toBeUndefined()
  })

  it('转发帖按被转发体判：转发一条文字 = 仍是 inline', () => {
    const hit = projectHit(stored({
      content: { archetype: 'forward', text: '转发理由', quoted: { archetype: 'text', text: '原文' } },
    }))
    expect(hit.full_text).toBe(true)
  })

  it('inline 但真的超长（过 INLINE_EXCERPT_LIMIT）：不谎称全文在此，此时指路 extract 才成立', () => {
    const hit = projectHit(stored({ content: { archetype: 'text', text: '长'.repeat(INLINE_EXCERPT_LIMIT + 1) } }))
    expect(hit.excerpt).toHaveLength(INLINE_EXCERPT_LIMIT)
    expect(hit.excerpt_truncated).toBe(true)
    expect(hit.full_text).toBeUndefined()
  })

  it('存量老行没有 content（判不了）：两个标记都不给，不瞎指路', () => {
    const hit = projectHit(stored({ content: undefined }))
    expect(hit.full_text).toBeUndefined()
  })
})

describe('inbox_search 的查询编排', () => {
  const noStore = { items: [] as StoredItem[], matched: 0 }

  const roster = () => [
    { id: 'default-timeline', label: '时间线', stream_ids: ['A', 'B'] },
    { id: 'agent-subscriptions', label: '对话订的', stream_ids: ['C'] },
  ]

  it('limit 有默认值和硬上限（模型填的参数不能指望它自觉）', () => {
    const seen: Array<number | undefined> = []
    const deps = { search: (q: { limit?: number }) => { seen.push(q.limit); return noStore }, channels: roster }
    runInboxSearch(deps, {})
    runInboxSearch(deps, { limit: 9999 })
    runInboxSearch(deps, { limit: 0 })
    expect(seen).toEqual([DEFAULT_LIMIT, MAX_LIMIT, 1])
  })

  it('单个 stream 与多个 stream 都归一成数组', () => {
    const seen: Array<string[] | undefined> = []
    const deps = { search: (q: { streams?: string[] }) => { seen.push(q.streams); return noStore }, channels: roster }
    runInboxSearch(deps, { stream: 'A' })
    runInboxSearch(deps, { stream: ['A', 'B'] })
    runInboxSearch(deps, {})
    expect(seen).toEqual([['A'], ['A', 'B'], undefined])
  })

  it('channel 认 id，也认用户嘴里的那个名字', () => {
    const seen: Array<string[] | undefined> = []
    const deps = { search: (q: { streams?: string[] }) => { seen.push(q.streams); return noStore }, channels: roster }
    runInboxSearch(deps, { channel: 'default-timeline' })
    runInboxSearch(deps, { channel: '时间线' }) // 用户说的就是这个词，模型无从知道那串 id
    expect(seen).toEqual([['A', 'B'], ['A', 'B']])
  })

  it('认不出的频道 → 明说 + 把可选项列出来，绝不静默退化成"搜全库"', () => {
    let called = false
    const r = runInboxSearch(
      { search: () => { called = true; return noStore }, channels: roster },
      { channel: '不存在' },
    )
    expect(called).toBe(false) // 这一条是关键：退化成全库搜会把无关内容当成这个频道回给模型
    // 没有任何工具能列频道，所以"自己去核对"是一条走不通的路——可选项必须就在这份回执里。
    expect(r.note).toContain('时间线')
    expect(r.note).toContain('对话订的')
    expect(r.items).toEqual([])
  })

  it('命中数多于返回数时，回执里明写还有多少 —— 指令放在模型刚读到的那份数据里', () => {
    const r = runInboxSearch(
      { search: () => ({ items: [stored()], matched: 140 }), channels: roster },
      { author: '大道无形我有型', limit: 1 },
    )
    expect(r.returned).toBe(1)
    expect(r.matched).toBe(140)
    expect(r.note).toContain('140')
  })

  it('全部命中都返回时不加那句 note', () => {
    const r = runInboxSearch({ search: () => ({ items: [stored()], matched: 1 }), channels: roster }, {})
    expect(r.note).toBeUndefined()
  })
})
