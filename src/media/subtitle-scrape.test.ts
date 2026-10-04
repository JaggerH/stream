import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeScrapeTrackId,
  encodeScrapeTrackId,
  fetchSubtitleBytes,
  labelScrapeCandidates,
  searchSubtitles,
  SubtitleSourceGone,
  type ScrapeCandidate,
} from './subtitle-scrape.ts'
import { UserStore } from '../store/user-store.ts'
import { Registry } from '../registry/registry.ts'
import { ProviderExecutor } from '../providers/executor.ts'
import { ProviderDirectory } from '../providers/directory.ts'
import { ProviderStatsStore } from '../providers/stats-store.ts'
import { SYSTEM_IDENTITIES } from '../providers/system/index.ts'
import { ensureSystemRows } from '../providers/seed.ts'
import type { SourceManifest } from '../manifest/types.ts'

// 宿主这一半只管机制；两家字幕站的客户端测试在 packages/xunlei、packages/shooter。

const A = '@t/subs-a/a-subtitle'
const B = '@t/subs-b/b-subtitle'

function mk(id: string): SourceManifest {
  return {
    schema_version: 1, id, adapter: 'fake', type: 'post', description: id, topics: [], example_queries: [],
    capabilities: ['search'], auth: { type: 'none' }, params_schema: {}, cadence_hint_seconds: 3600,
    discoverable: false, provides: ['search-subtitle'],
  }
}

/** 真 UserStore + 真执行器 + `subtitle-search` 系统行（auto 段真的按 provides 展开）；成员行为由 `handlers` 模拟。 */
function harness(sources: string[], handlers: Record<string, (params: Record<string, unknown>) => unknown[]>) {
  const dir = mkdtempSync(join(tmpdir(), 'subtitle-scrape-'))
  const store = new UserStore(join(dir, 'stream.db'))
  const stats = new ProviderStatsStore(join(dir, 'stats.db'))
  ensureSystemRows(store)
  const calls: Array<{ sourceId: string; params: Record<string, unknown> }> = []
  const executor = new ProviderExecutor({
    directory: new ProviderDirectory(store, SYSTEM_IDENTITIES), registry: new Registry(sources.map(mk)), stats,
    fetchSource: async (sourceId, input) => {
      const params = input as Record<string, unknown>
      calls.push({ sourceId, params })
      return handlers[sourceId]?.(params) ?? []
    },
  })
  return { executor, calls, close: () => { store.close(); stats.close(); rmSync(dir, { recursive: true, force: true }) } }
}

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); cleanup = undefined })

describe('scrape track id：scrape:<源全名>:<base64url(包给的 id)>', () => {
  it('round-trips member + id（id 里带 : / ? 也不串）', () => {
    const id = 'https://cdn.example/a:b/c.srt?x=1'
    const t = encodeScrapeTrackId(A, id)
    expect(t.startsWith(`scrape:${A}:`)).toBe(true)
    expect(decodeScrapeTrackId(t)).toEqual({ member: A, id })
  })
  it('别的形状（embed: / 老格式 scrape:<b64>）→ null', () => {
    expect(decodeScrapeTrackId('embed:2')).toBeNull()
    expect(decodeScrapeTrackId('scrape:aHR0cHM6Ly94')).toBeNull()
  })
})

describe('searchSubtitles — 扇出 subtitle-search 行的成员', () => {
  it('合并各源候选，id 带源全名；按文件名线索稳定排序（简体优先）', async () => {
    const h = harness([A, B], {
      [A]: () => [{ id: 'a-eng', name: 'x.eng', nameHint: 'eng', label: '甲' }, { id: 'a-simp', name: 'x.chs', nameHint: 'simp', label: '甲' }],
      [B]: () => [{ id: 'b-1', name: '乙 1', nameHint: 'unknown', label: '乙' }],
    })
    cleanup = h.close
    const out = await searchSubtitles(h.executor, { name: 'Show.S01E01.mkv' })
    expect(out.map((c) => [c.nameHint, c.source])).toEqual([['simp', '甲'], ['eng', '甲'], ['unknown', '乙']])
    expect(decodeScrapeTrackId(out[0].id)).toEqual({ member: A, id: 'a-simp' })
    expect(decodeScrapeTrackId(out[2].id)).toEqual({ member: B, id: 'b-1' })
    // 成员拿到的是对象输入摊开的字段：op + name（+ 宿主给的 size/read）
    expect(h.calls.every((c) => c.params.op === 'search' && c.params.name === 'Show.S01E01.mkv')).toBe(true)
  })

  it('宿主给的 read / size 原样递到成员手里（要内容指纹的站自己算）', async () => {
    const read = async (_o: number, l: number) => new Uint8Array(l)
    const h = harness([A], { [A]: (p) => (typeof p.read === 'function' && p.size === 40_000 ? [{ id: 'ok', name: 'n', nameHint: 'unknown', label: '甲' }] : []) })
    cleanup = h.close
    expect(await searchSubtitles(h.executor, { name: 'x.mkv', size: 40_000, read })).toHaveLength(1)
  })

  it('全 miss / 成员抛错 → []，不冒泡', async () => {
    const h = harness([A, B], { [A]: () => [], [B]: () => { throw new Error('net') } })
    cleanup = h.close
    expect(await searchSubtitles(h.executor, { name: 'x.mkv' })).toEqual([])
  })
})

describe('fetchSubtitleBytes — 只调那一个源', () => {
  it('解码出源全名，只把 op:fetch 交给它，拿回字节', async () => {
    const h = harness([A, B], {
      [A]: (p) => (p.op === 'fetch' ? [{ bytes: new TextEncoder().encode(`A:${p.id}`) }] : []),
      [B]: () => { throw new Error('不该被调用') },
    })
    cleanup = h.close
    const bytes = await fetchSubtitleBytes(h.executor, encodeScrapeTrackId(A, 'sub-1'))
    expect(new TextDecoder().decode(bytes)).toBe('A:sub-1')
    expect(h.calls.map((c) => c.sourceId)).toEqual([A])
  })

  it('那个源已不在行里（包被关 / 卸了）→ 抛 SubtitleSourceGone（响亮，不是空）', async () => {
    const h = harness([B], { [B]: () => [{ bytes: new Uint8Array([1]) }] })
    cleanup = h.close
    await expect(fetchSubtitleBytes(h.executor, encodeScrapeTrackId(A, 'sub-1'))).rejects.toBeInstanceOf(SubtitleSourceGone)
    expect(h.calls).toEqual([])
  })

  it('源取失败 → 抛出它的原因', async () => {
    const h = harness([A], { [A]: () => { throw new Error('HTTP 404') } })
    cleanup = h.close
    await expect(fetchSubtitleBytes(h.executor, encodeScrapeTrackId(A, 'x'))).rejects.toThrow(/404/)
  })

  it('不是 scrape track → 抛', async () => {
    const h = harness([A], {})
    cleanup = h.close
    await expect(fetchSubtitleBytes(h.executor, 'embed:1')).rejects.toThrow()
  })
})

describe('labelScrapeCandidates — label = 语言 · 来源（语言从内容判）', () => {
  const CAND = (name: string, tail: string): ScrapeCandidate => ({
    id: encodeScrapeTrackId(A, tail),
    name,
    source: '迅雷',
    nameHint: 'unknown',
    rank: 5,
  })
  const SIMP = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n他们说这个国家会变样，很多很多中文堆在这里。'
  const TRAD = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n他們說這個國家會變樣，很多很多中文堆在這裡。'
  const ENG = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n' + 'They said the country would change many many english words here now today.'

  it('探出真实语言，每种语言·来源只留一条，简体中文排最前', async () => {
    const cands = [CAND('a', 'a'), CAND('b', 'b'), CAND('c', 'c')]
    const byId: Record<string, string> = { [cands[0].id]: ENG, [cands[1].id]: SIMP, [cands[2].id]: TRAD }
    const out = await labelScrapeCandidates(cands, async (c) => byId[c.id] ?? null)
    expect(out.map((t) => t.title)).toEqual(['简体中文 · 迅雷', '繁體中文 · 迅雷', '英文 · 迅雷'])
  })

  it('同语言多条折叠成一条（内容都判成简体）', async () => {
    const out = await labelScrapeCandidates([CAND('v1', 'a'), CAND('v2', 'b'), CAND('v3', 'c')], async () => SIMP)
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('简体中文 · 迅雷')
  })

  it('抓不到内容 → 退回文件名线索；线索也无 → 未知（不折叠，缀文件名区分）', async () => {
    const withHint: ScrapeCandidate = { ...CAND('剧.简体', 'h'), nameHint: 'simp' }
    const out = await labelScrapeCandidates([withHint, CAND('进击的巨人 (01)', 'x'), CAND('进击の巨人 01', 'y')], async () => null)
    expect(out.find((t) => t.title === '简体中文 · 迅雷')).toBeTruthy()
    expect(out.filter((t) => t.title.startsWith('未知 · 迅雷')).map((t) => t.title)).toEqual(['未知 · 迅雷 · 进击的巨人 (01)', '未知 · 迅雷 · 进击の巨人 01'])
  })

  it('抓到但内容是空的（只含字体的空壳 .ass）→ 整条丢掉，不给死轨', async () => {
    const good = CAND('good', 'g')
    const empty = CAND('empty', 'e')
    const byId: Record<string, string> = { [good.id]: SIMP, [empty.id]: 'WEBVTT\n\n' }
    const out = await labelScrapeCandidates([good, empty], async (c) => byId[c.id])
    expect(out.map((t) => t.title)).toEqual(['简体中文 · 迅雷'])
  })

  it('抓取失败（null，网络问题）不算空——保留为未知，不误杀', async () => {
    const out = await labelScrapeCandidates([CAND('进击的巨人 (01)', 'x')], async () => null)
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('未知 · 迅雷 · 进击的巨人 (01)')
  })

  it('cap 限住抓取条数——只探前 N 条', async () => {
    const cands = Array.from({ length: 20 }, (_, i) => CAND(`n${i}`, `u${i}`))
    let fetches = 0
    await labelScrapeCandidates(cands, async () => { fetches++; return SIMP }, { cap: 5 })
    expect(fetches).toBe(5)
  })
})
