import { describe, it, expect } from 'vitest'
import { UserStore } from '../store/user-store.ts'
import { collectClosure, collectNetdiskBindings, exportBundle, buildDependencyCatalog } from './export-closure.ts'
import type { MappingSet } from '../netdisk/types.ts'

function freshStore(): UserStore {
  return new UserStore(':memory:')
}

describe('collectClosure', () => {
  it('以 Channel 为根收 channel + 被引用 streams + bindings', () => {
    const s = freshStore()
    s.putStream({ id: 's1', label: 'S1', strategy: 'fanout', cadence_seconds: 3600, members: [{ plugin: 'rsshub', source: 'a', params: {} }], options: {} })
    s.putStream({ id: 's2', label: 'S2', strategy: 'fanout', cadence_seconds: 3600, members: [{ plugin: 'xhs', source: 'xhs-home', params: {} }], options: {} })
    s.putChannel({ id: 'mine', label: 'Mine', present: 'timeline', stream_ids: ['s1', 's2'], options: {} })
    const c = collectClosure({ kind: 'channel', id: 'mine' }, s)
    expect(c.channels.map((x) => x.id)).toEqual(['mine'])
    expect(c.streams.map((x) => x.id).sort()).toEqual(['s1', 's2'])
    expect(c.bindings).toHaveLength(2)
    s.close()
  })

  it('以 Stream 为根：无 channel，仅该 stream + bindings', () => {
    const s = freshStore()
    s.putStream({ id: 's1', label: 'S1', strategy: 'fanout', cadence_seconds: 3600, members: [{ plugin: 'rsshub', source: 'a', params: {} }], options: {} })
    const c = collectClosure({ kind: 'stream', id: 's1' }, s)
    expect(c.channels).toHaveLength(0)
    expect(c.streams.map((x) => x.id)).toEqual(['s1'])
    s.close()
  })
})

describe('slotProviderCandidates / options.slots 净化', () => {
  it('surfaces slot-referenced providers as candidates and strips unshipped slot refs', () => {
    const s = new UserStore(':memory:')
    s.putStream({ id: 's1', label: 'S1', strategy: 'fanout', cadence_seconds: 3600, members: [{ plugin: 'rsshub', source: 'a', params: {} }], options: {} })
    s.putProvider({ id: 'p-nsfw', label: 'NSFW', description: '', category: 'resolve', serves: ['search.resources'], strategy: 'sequential', members: [], contract: null, options: {} })
    s.putChannel({ id: 'c1', label: 'C1', present: 'timeline', stream_ids: ['s1'], options: { slots: { 'search.resources': ['p-nsfw'] } } })

    const closure = collectClosure({ kind: 'channel', id: 'c1' }, s)
    expect(closure.slotProviderCandidates).toEqual(['p-nsfw'])
    expect(closure.providers.map((p) => p.id)).not.toContain('p-nsfw')

    const catalog = buildDependencyCatalog({ plugins: [], recipePackages: [], readManifest: () => undefined, readEmbedded: () => undefined })
    const meta = { title: 'C1', created: '2026-07-18', revision: '1.0.0' }

    const notShipped = exportBundle({ kind: 'channel', id: 'c1' }, s, catalog, meta)
    expect((notShipped.bundle.channels[0].options as { slots?: Record<string, unknown> })?.slots ?? {}).not.toHaveProperty('search.resources')

    const shipped = exportBundle({ kind: 'channel', id: 'c1' }, s, catalog, meta, { providerIds: ['p-nsfw'] })
    expect(shipped.bundle.providers?.map((p) => p.id)).toContain('p-nsfw')
    expect((shipped.bundle.channels[0].options as { slots?: Record<string, unknown> })?.slots).toEqual({ 'search.resources': ['p-nsfw'] })
    s.close()
  })
})

describe('collectNetdiskBindings 投影', () => {
  const set = (over: Partial<MappingSet> = {}): MappingSet => ({
    id: 'map_a', left: { kind: 'tmdb', id: '1399', media: 'tv', title: '权游' },
    right: { kind: 'alist-dir', path: '/夸克网盘/我的转存/权游', boundAt: '2026-07-19' },
    rightHistory: [], autoSync: true,
    entries: [
      { leftKey: 'k1', leftTitle: '第一集', rightFile: 'S01E01.mkv', status: 'auto' },
      { leftKey: 'k2', leftTitle: '第二集', rightFile: '第二集.mkv', status: 'confirmed', corrected: { at: '2026-07-19', autoFile: null } },
    ],
    matchSpec: { version: 2, stages: [{ by: 'title', titleStrip: [], threshold: 0.6, margin: 0.1 }] } as never,
    ...over,
  })
  const storeOf = (s: MappingSet) => ({ get: (id: string) => (id === s.id ? s : undefined) })

  it('剥掉 right、只保留有 corrected 的 entries、保 left+matchSpec', () => {
    const [b] = collectNetdiskBindings(['map_a'], storeOf(set()))
    expect('right' in b).toBe(false)
    expect(b.left).toEqual({ kind: 'tmdb', id: '1399', media: 'tv', title: '权游' })
    expect(b.matchSpec?.version).toBe(2)
    expect(b.entries).toHaveLength(1)
    expect(b.entries?.[0].leftKey).toBe('k2')
  })

  it('全项文本不含本机 right.path 与任何 fileId（快照断言）', () => {
    const [b] = collectNetdiskBindings(['map_a'], storeOf(set()))
    const text = JSON.stringify(b)
    expect(text).not.toContain('/夸克网盘/我的转存')
    expect(text.toLowerCase()).not.toContain('fileid')
  })

  it('无 corrected entry 时省略 entries 字段', () => {
    const [b] = collectNetdiskBindings(['map_a'], storeOf(set({ entries: [{ leftKey: 'k1', leftTitle: 'x', rightFile: 'a.mkv', status: 'auto' }] })))
    expect(b.entries).toBeUndefined()
  })

  it('缺失 id 静默跳过', () => {
    expect(collectNetdiskBindings(['nope'], storeOf(set()))).toHaveLength(0)
  })

  it('entry.lastError（可能含作者 AList 路径）被白名单剥掉——不泄漏', () => {
    const leaky = set({ entries: [
      { leftKey: 'k2', leftTitle: '第二集', rightFile: '第二集.mkv', status: 'confirmed', corrected: { at: '2026-07-19', autoFile: null }, lastError: '[alist] object not found: /夸克网盘/我的转存/权游/S01E02.mkv' } as never,
    ] })
    const [b] = collectNetdiskBindings(['map_a'], storeOf(leaky))
    const text = JSON.stringify(b)
    expect(text).not.toContain('/夸克网盘/我的转存')
    expect(b.entries?.[0]).not.toHaveProperty('lastError')
    expect(b.entries?.[0].corrected).toBeTruthy() // 人工订正仍保留
  })
})
