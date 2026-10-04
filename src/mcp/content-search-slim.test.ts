import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from './server.ts'
import type { StreamService } from './tools.ts'
import type { StoredItem } from '../item-store.ts'
import {
  slimContentSearchResults,
  communityByCategory,
  searchSourceTier,
  tierOf,
  CONTENT_SEARCH_MAX_ITEMS,
  CONTENT_SEARCH_EXCERPT_CHARS,
} from './content-search-slim.ts'

/** 假 registry：分档判据只看 manifest `categories` 含不含 `social-media`，站名无关。 */
const lookup = {
  get: (id: string) =>
    ({
      '@t/a/a-search': { categories: ['social-media', 'video'] },
      'xhs-search': { categories: ['social-media'] },
      'rsshub:bilibili/vsearch/:kw': { categories: ['social-media', 'video'] },
      'bilibili-search': { categories: ['social-media', 'video'] },
      'baidu-search': { categories: ['search'] },
      'rsshub:web/search': { categories: ['news'] },
    } as Record<string, { categories?: string[] }>)[id],
}
const isCommunity = communityByCategory(lookup)

describe('communityByCategory', () => {
  it('categories 含 social-media → 社区档', () => {
    expect(searchSourceTier('@t/a/a-search', communityByCategory(lookup))).toBe('community')
  })
  it('不含 → 网页档', () => {
    expect(searchSourceTier('rsshub:web/search', communityByCategory(lookup))).toBe('web')
  })
  it('registry 查不到 / 抛歧义 → 网页档，不炸', () => {
    const throwing = { get: () => { throw new Error('ambiguous') } }
    expect(searchSourceTier('whatever', communityByCategory(throwing))).toBe('web')
    expect(searchSourceTier('nobody-knows', communityByCategory(lookup))).toBe('web')
    expect(searchSourceTier(undefined, communityByCategory(lookup))).toBe('web')
  })
  it('tierOf 仍带 stream_id 兜底', () => {
    expect(tierOf({ stream_id: '@t/a/a-search' }, communityByCategory(lookup))).toBe('community')
  })
  // 「装配期取的值 = 冻住的答案」：谓词每次都问 registry，热装/换组之后下一轮就该认。
  it('谓词现取 registry，不在造它那一刻快照', () => {
    const live = new Map<string, { categories?: string[] }>()
    const pred = communityByCategory({ get: (id) => live.get(id) })
    expect(pred('late-pkg/search')).toBe(false)
    live.set('late-pkg/search', { categories: ['social-media'] })
    expect(pred('late-pkg/search')).toBe(true)
  })
})

function fat(n: number): StoredItem {
  return {
    id: `item-${n}`,
    stream_id: 'bilibili-search',
    source_id: 'bilibili-search',
    source_type: 'rsshub-bridge',
    source_route: '/bilibili/search',
    fetched_at: '2026-08-19T00:00:00.000Z',
    timestamp: '2026-08-18T12:00:00.000Z',
    title: `视频 ${n}`,
    author: 'UP主',
    url: `https://b23.tv/${n}`,
    body_html: '<iframe src="//player.bilibili.com/player.html?aid=1"></iframe>'.repeat(20),
    body_text: 'x'.repeat(CONTENT_SEARCH_EXCERPT_CHARS + 500),
    content: {
      archetype: 'video',
      title: `视频 ${n}`,
      text: '正文'.repeat(500),
      media: [
        { kind: 'video', url: 'https://cdn.example/v.mp4' },
        { kind: 'image', url: 'https://cdn.example/cover.jpg' },
      ],
    },
    raw: { pic: 'https://i0.hdslb.com/'.repeat(200), description: 'y'.repeat(5000), nested: { deep: true } },
    type: 'post',
  } as unknown as StoredItem
}

describe('content_search 回执瘦身', () => {
  // 封顶之前先按档排序:合并序里网页源排前,先砍再排 = 社区条目在进模型视野之前就被截没
  // (活体 2026-08-24:扇出 76 条里 xhs 40 条,回执前 20 全是 web 档)。
  it('社区档在封顶之前排到前面——web 条目再多也挤不掉 xhs/B站', () => {
    const web = Array.from({ length: CONTENT_SEARCH_MAX_ITEMS + 5 }, (_, i) =>
      ({ ...fat(i), source_id: 'baidu-search', stream_id: 'baidu-search' }) as StoredItem)
    const community = [
      { ...fat(100), source_id: 'xhs-search' } as StoredItem,
      // 扇出路的真实形状:source_id 缺席,源身份只在 stream_id 上——tier 必须兜到它
      { ...fat(101), source_id: undefined, stream_id: 'rsshub:bilibili/vsearch/:kw' } as StoredItem,
    ]
    const slim = slimContentSearchResults([...web, ...community], { isCommunity })
    expect(slim.items).toHaveLength(CONTENT_SEARCH_MAX_ITEMS)
    expect(slim.items[0].tier).toBe('community')
    expect(slim.items[1].tier).toBe('community')
    expect(slim.items.map((i) => i.id).slice(0, 2).sort()).toEqual(['item-100', 'item-101'])
    expect(slim.total).toBe(web.length + 2)
  })

  // xhs 一家 40 条就能把 B 站 10 条挤出窗口,而视频横评只有 B 站有——同档内按源轮转,
  // 每个源的头部命中都要进得了前 20;源内相对序保留(各源自己的相关性排序)。
  it('同档内按源轮转交错——单一大源挤不掉别的社区源', () => {
    const xhs = Array.from({ length: 40 }, (_, i) =>
      ({ ...fat(i), source_id: 'xhs-search' }) as StoredItem)
    const bili = Array.from({ length: 10 }, (_, i) =>
      ({ ...fat(100 + i), source_id: 'rsshub:bilibili/vsearch/:kw' }) as StoredItem)
    const slim = slimContentSearchResults([...xhs, ...bili], { isCommunity })
    expect(slim.items).toHaveLength(CONTENT_SEARCH_MAX_ITEMS)
    const biliKept = slim.items.filter((i) => (i.source_id ?? '').includes('bilibili'))
    expect(biliKept.length).toBe(10) // 20 条窗口轮转下两源各占一半,B 站 10 条全在
    // 交错形状:前两条来自两个不同的源,且各源内保持自身顺序
    expect(slim.items[0].source_id).not.toBe(slim.items[1].source_id)
    const xhsIds = slim.items.filter((i) => i.source_id === 'xhs-search').map((i) => i.id)
    expect(xhsIds).toEqual([...xhsIds].sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))))
  })

  it('withImage 档带首个 image 媒体的 URL；默认档不带', () => {
    const [withImg] = slimContentSearchResults([fat(1)], { withImage: true, isCommunity }).items
    expect(withImg.image).toBe('https://cdn.example/cover.jpg') // 跳过排在前面的 video
    const [plain] = slimContentSearchResults([fat(1)], { isCommunity }).items
    expect(plain).not.toHaveProperty('image')
  })

  it('丢掉 raw / body_html / media 明细，只留模型判切题要用的那几格', () => {
    const [one] = slimContentSearchResults([fat(1)], { isCommunity }).items
    expect(one).not.toHaveProperty('raw')
    expect(one).not.toHaveProperty('body_html')
    expect(one).not.toHaveProperty('body_text')
    expect(one).not.toHaveProperty('content')
    expect(one).toMatchObject({
      id: 'item-1',
      stream_id: 'bilibili-search',
      title: '视频 1',
      author: 'UP主',
      url: 'https://b23.tv/1',
      archetype: 'video',
      media_count: 2,
      excerpt_truncated: true,
    })
    expect(one.excerpt!.length).toBe(CONTENT_SEARCH_EXCERPT_CHARS)
  })

  it('短正文不加截断标记', () => {
    const item = fat(2)
    ;(item.content as { text: string }).text = '短'
    const [one] = slimContentSearchResults([item], { isCommunity }).items
    expect(one.excerpt).toBe('短')
    expect(one.excerpt_truncated).toBeUndefined()
  })

  it('封顶条数，并把截掉了多少条明写进回执', () => {
    const many = Array.from({ length: CONTENT_SEARCH_MAX_ITEMS + 7 }, (_, i) => fat(i))
    const r = slimContentSearchResults(many, { isCommunity })
    expect(r.items).toHaveLength(CONTENT_SEARCH_MAX_ITEMS)
    expect(r.total).toBe(CONTENT_SEARCH_MAX_ITEMS + 7)
    expect(r.note).toContain('7')
  })

  it('没截断时不编一句 note', () => {
    expect(slimContentSearchResults([fat(1)], { isCommunity }).note).toBeUndefined()
  })

  /**
   * 描述里的**下一步指路也是承诺**：`content_search` 的命中不落库，而 `extract` 的句柄解析是
   * `itemStore.get(handle) ?? searchSnapshot.get(handle)`——现搜结果经瞬时快照在 TTL 内可解
   *（spec 2026-08-23-purchase-evidence-deepread）。深挖首选 extract（视频能转写），read_url 兜底。
   */
  it('描述把深挖首选指向 extract（快照句柄），read_url 兜底', async () => {
    const server = createMcpServer({} as unknown as StreamService, { contentSearch: async () => [], isCommunitySource: isCommunity })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)

    const desc = (await client.listTools()).tools.find((t) => t.name === 'content_search')!.description!
    expect(desc).toContain('read_url')
    expect(desc).toMatch(/call `extract` with its `id`/i)
    await client.close()
  })

  /**
   * 命脉守卫：判据是**发到线上的那份 JSON 文本**里一个 `raw`/`body_html` 的字样都不许有。
   * 单测纯函数还不够——真正会把整轮对话顶爆的是工具回执本身，所以要在 MCP 边界上量。
   */
  it('MCP 线上载荷里搜不到 raw / body_html，体积也压下来了', async () => {
    const many = Array.from({ length: 30 }, (_, i) => fat(i))
    const server = createMcpServer({} as unknown as StreamService, {
      contentSearch: async () => many,
      isCommunitySource: isCommunity,
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(clientT)

    const r = await client.callTool({ name: 'content_search', arguments: { query: '大道无形我有型' } })
    const wire = JSON.stringify(r)
    expect(wire).not.toContain('body_html')
    expect(wire).not.toContain('iframe')
    expect(wire).not.toContain('hdslb.com')
    expect(wire).not.toMatch(/"raw"/)
    // 分档谓词要真的从 extras 穿到工具边界：fat() 的源在假 registry 里标着 social-media
    expect(wire).toMatch(/\\"tier\\":\s*\\"community\\"/)
    expect(wire).not.toMatch(/\\"tier\\":\s*\\"web\\"/)
    // 胖回执（原样 StoredItem × 30）是这个的十几倍——这条数字钉住的是「不许退回去」。
    expect(wire.length).toBeLessThan(JSON.stringify(many).length / 5)
    await client.close()
  })
})
