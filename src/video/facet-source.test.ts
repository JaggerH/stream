import { describe, it, expect, vi, afterEach } from 'vitest'
import { facetOneSource, MAX_RAW_ITEMS } from './facet-source.ts'
import { setPackageSearchSources } from '../search/seeds.ts'
import { Deduper } from './dedupe.ts'
import type { RawVideoItem } from './extract.ts'

// 真实 source_id（`nyaa` 只是 key）——searchMetaBySourceId 按 source_id 查，
// 传 key 会落空退到「未知源」分支，那就测不到 flat 这条路了。
const NYAA = 'rsshub:nyaa/search/:query?'
const U3C3 = 'rsshub:u3c3/search/:keyword/:preview?'

const flatItem = (title: string, link: string): RawVideoItem => ({ title, link, enclosure_url: link })

const btih = (n: number) => `magnet:?xt=urn:btih:${String(n).padStart(40, 'a')}`

describe('facetOneSource', () => {
  it('btbtla 源:paired 解析器把每条 link 的 desc 摊成一条独立 loose Release（纯扁平,无 ShowSeason/无 links[]）', () => {
    const raw = [{ title: '上载新生 第三季', content: '上载新生', links: [
      { url: 'magnet:?xt=urn:btih:aaa', type: 'magnet', desc: '上载新生.第三季 第01集 1080p' },
      { url: 'magnet:?xt=urn:btih:bbb', type: 'magnet', desc: '上载新生.第三季 第02集 2160p' },
    ] }] as unknown as RawVideoItem[]
    const r = facetOneSource('btbtla', raw, '上载新生')
    expect(r.part.shows).toEqual([])
    expect(r.part.loose.length).toBe(2) // 一条 link = 一条 Release
    // 名字来自 desc(内容),不是秃季名;facets 从 desc 解析;不再有 links[]
    expect(r.part.loose[0].title).toContain('第01集')
    expect(r.part.loose[0].links).toBeUndefined()
    expect(r.part.loose[0].quality).toBe('1080p')
    expect(r.part.loose[1].quality).toBe('2160p')
    expect(r.part.loose[0].sourceType).toBe('magnet')
  })

  it('pansou digest 走完整管线:一条合集消息拆成 per-work loose 行,并按 query 去噪只留搜的那部', () => {
    const raw = [{
      title: '入室抢劫',
      content: '入室抢劫 (2021)\n链接：https://cloud.189.cn/t/AAA（访问码：1111）上载新生.Upload.(2020)\n链接：https://cloud.189.cn/t/BBB（访问码：2222）赏金姐妹花 (2020)\n链接：https://cloud.189.cn/t/CCC（访问码：3333）',
      channel: 'tianyifc',
      origin: 'https://t.me/tianyifc/99',
      channel_url: 'https://t.me/tianyifc',
    }] as unknown as RawVideoItem[]
    const r = facetOneSource('pansou', raw, '上载新生')
    expect(r.part.shows).toEqual([])
    // 只有"上载新生"那条留下(digest 去噪),它的链接是它自己的(BBB),不是相邻的
    expect(r.part.loose.length).toBe(1)
    expect(r.part.loose[0].title).toContain('上载新生')
    expect(r.part.loose[0].link).toBe('https://cloud.189.cn/t/BBB')
    expect(r.part.loose[0].password).toBe('2222')
    expect(r.part.loose[0].sourceType).toBe('unknown') // 天翼未被 SourceType 建模
    expect(r.part.loose[0].netdiskLabel).toBe('天翼')
    // 出处是源给的通用字段，原样上 Release（spec 2026-09-26-boundary-stage9 §2.1）
    expect(r.part.loose[0].origin).toBe('https://t.me/tianyifc/99')
    expect(r.part.loose[0].channelUrl).toBe('https://t.me/tianyifc')
    expect(r.part.loose[0].channel).toBe('tianyifc')
  })

  it('宿主只读通用出处字段：只带上游 message_id / unique_id 形状的条目不会被拼出出处', () => {
    const content = '上载新生.Upload.(2020)\n链接：https://cloud.189.cn/t/BBB（访问码：2222）'
    const upstreamOnly = [
      { title: '上载新生', content, channel: 'tianyifc', message_id: 99 },
      { title: '上载新生', content: content.replace('BBB', 'CCC'), unique_id: 'hdr4k-1' },
    ] as unknown as RawVideoItem[]
    const r = facetOneSource('pansou', upstreamOnly, '上载新生')
    expect(r.part.loose.length).toBe(2)
    for (const rel of r.part.loose) {
      expect(rel.origin).toBeUndefined()
      expect(rel.channelUrl).toBeUndefined()
      expect(rel.provider).toBeUndefined()
    }
    const generic = [{ title: '上载新生', content, provider: 'hdr4k', origin: 'https://example.test/p/1' }] as unknown as RawVideoItem[]
    const g = facetOneSource('pansou', generic, '上载新生')
    expect(g.part.loose[0]).toMatchObject({ provider: 'hdr4k', origin: 'https://example.test/p/1' })
  })

  it('pansou 单资源消息也按 query 过滤:不含关键词的整条丢掉(loose 全文搜的去噪)', () => {
    const raw = [
      { title: '知否知否应是绿肥红瘦 (2018) 全73集', content: '知否知否应是绿肥红瘦 (2018) 链接：https://pan.quark.cn/s/aaa' },
      { title: '古诺希亚 (2025) 全21集', content: '古诺希亚 (2025) 链接：https://pan.quark.cn/s/bbb' },
    ] as unknown as RawVideoItem[]
    const r = facetOneSource('pansou', raw, '知否')
    expect(r.part.loose.length).toBe(1)
    expect(r.part.loose[0].title).toContain('知否')
  })

  it('flat 源不按 query 中文子串过滤(服务端已搜过,别误杀罗马音/英文命中)', () => {
    // 查中文名,但 nyaa 结果是罗马音标题 —— 不能因为标题没有中文就丢
    const raw = [flatItem('[SubsPlease] Mushoku Tensei - 12 (1080p)', btih(1))]
    const r = facetOneSource(NYAA, raw, '无职转生')
    expect(r.part.loose.length).toBe(1)
  })

  it('已知源 id → key/label 取自 seeds 元数据（包声明挂进来之后）', () => {
    setPackageSearchSources(() => [{ source: NYAA, key: 'nyaa', label: 'Nyaa', param: 'query', kind: 'flat' }])
    try {
      const r = facetOneSource(NYAA, [], 'q')
      expect(r.key).toBe('nyaa')
      expect(r.label).toBe('Nyaa')
    } finally { setPackageSearchSources(() => []) }
  })

  it('未知源 id → key/label 退到 id 本身，不抛', () => {
    const r = facetOneSource('no-such-source', [], 'q')
    expect(r.key).toBe('no-such-source')
    expect(r.label).toBe('no-such-source')
    expect(r.count).toBe(0)
  })

  it('空输入 → 空 part，count 0', () => {
    const r = facetOneSource(NYAA, [], '上载新生')
    expect(r.part.shows).toEqual([])
    expect(r.part.loose).toEqual([])
    expect(r.count).toBe(0)
  })

  it('count = shows 里所有 release 数 + loose 数', () => {
    const raw = [
      flatItem('上载新生 S03E01 1080p', btih(1)),
      flatItem('上载新生 S03E02 1080p', btih(2)),
    ]
    const r = facetOneSource(NYAA, raw, '上载新生')
    const inShows = r.part.shows.reduce((n, ss) => n + ss.qualities.reduce((m, qb) => m + qb.releases.length, 0), 0)
    expect(r.count).toBe(inShows + r.part.loose.length)
    expect(r.count).toBe(2)
  })

  it('超过 MAX_RAW_ITEMS → 截断并 log（炸弹护栏）', () => {
    const log = vi.fn()
    const raw = Array.from({ length: MAX_RAW_ITEMS + 5 }, (_, i) => flatItem(`Show S01E${i} 1080p`, btih(i)))
    facetOneSource(NYAA, raw, 'Show', { log })
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0][0]).toContain('capped')
  })

  it('未超过 MAX_RAW_ITEMS → 不 log', () => {
    const log = vi.fn()
    facetOneSource(NYAA, [flatItem('x', btih(1))], 'x', { log })
    expect(log).not.toHaveBeenCalled()
  })
})

describe('facetOneSource — 去重', () => {
  it('不传 deduper → 不去重，dropped 恒为 0', () => {
    const r = facetOneSource(NYAA, [flatItem('Show S01E01 1080p', btih(1))], 'Show')
    expect(r.dropped).toBe(0)
    expect(r.count).toBe(1)
  })

  it('同一个 deduper 喂两个源 → 第二个源的重复被丢，dropped 记账', () => {
    const deduper = new Deduper()
    const first = facetOneSource(NYAA, [flatItem('Show S01E01 1080p', btih(1))], 'Show', { deduper })
    expect(first.count).toBe(1)
    expect(first.dropped).toBe(0)

    const second = facetOneSource(U3C3, [flatItem('Show S01E01 1080p', btih(1))], 'Show', { deduper })
    expect(second.count).toBe(0)
    expect(second.dropped).toBe(1)
  })

  it('全被去重的源：count=0 但 dropped>0 —— 与「真无结果」可区分', () => {
    const deduper = new Deduper()
    facetOneSource(NYAA, [flatItem('Show S01E01 1080p', btih(1))], 'Show', { deduper })
    const dupOnly = facetOneSource(U3C3, [flatItem('Show S01E01 1080p', btih(1))], 'Show', { deduper })
    const trulyEmpty = facetOneSource(U3C3, [], 'Show', { deduper })
    expect(dupOnly.count).toBe(0)
    expect(dupOnly.dropped).toBeGreaterThan(0)
    expect(trulyEmpty.count).toBe(0)
    expect(trulyEmpty.dropped).toBe(0)
  })

  it('去重发生在 aggregate 之前 —— 被丢的 release 不进 shows/loose', () => {
    const deduper = new Deduper()
    facetOneSource(NYAA, [flatItem('Show S01E01 1080p', btih(1))], 'Show', { deduper })
    const r = facetOneSource(U3C3, [flatItem('Show S01E01 1080p', btih(1))], 'Show', { deduper })
    expect(r.part.shows).toEqual([])
    expect(r.part.loose).toEqual([])
  })
})

// 发现池只收 digest 形状源的频道名；形状由源的元数据声明（宿主表或包的 searchSources），不由出处名判。
describe('facetOneSource —— digest 形状源的频道进发现池', () => {
  const digestRaw = [{
    title: '入室抢劫',
    content: '入室抢劫 (2021)\n链接：https://cloud.189.cn/t/AAA（访问码：1111）',
    channel: 'somechan',
  }] as unknown as RawVideoItem[]
  afterEach(() => setPackageSearchSources(() => []))

  it('包声明 kind:digest → recordChannels 收到频道名', () => {
    setPackageSearchSources(() => [{ source: '@t/d/digest-search', key: 'd', label: 'D', param: 'keyword', kind: 'digest' }])
    const recordChannels = vi.fn()
    facetOneSource('@t/d/digest-search', digestRaw, '入室抢劫', { recordChannels })
    expect(recordChannels).toHaveBeenCalledWith('@t/d/digest-search', ['somechan'])
  })

  it('声明成 flat（或查不到元数据）→ 不记', () => {
    setPackageSearchSources(() => [{ source: '@t/d/digest-search', key: 'd', label: 'D', param: 'keyword', kind: 'flat' }])
    const recordChannels = vi.fn()
    facetOneSource('@t/d/digest-search', digestRaw, '入室抢劫', { recordChannels })
    facetOneSource('@t/unknown/x', digestRaw, '入室抢劫', { recordChannels })
    expect(recordChannels).not.toHaveBeenCalled()
  })
})
