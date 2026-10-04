import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MappingStore } from './mapping-store.ts'
import { openNetdiskDb, type NetdiskDb } from './db.ts'
import { NetdiskService, resolveSpec, type ListLeft, type LeftEntry } from './sync.ts'
import type { AlistClient, AlistFile } from './alist-client.ts'
import type { MappingSet, PlayableHit, MatchSpec } from './types.ts'
import { DEFAULT_MATCH_SPEC, DEFAULT_EPNUM_REGEX } from './match-spec.ts'
import type { InvokeLlm } from './match-generate.ts'

/** listDir + listDirRecursive both serve the same flat file list unless a separate recursive
 *  list is given (subdir scenarios). Spec path uses listDirRecursive; legacy funnel uses listDir. */
function fakeAlist(files: AlistFile[], opts: { recursive?: AlistFile[]; raw?: string } = {}): {
  client: AlistClient
  listDir: ReturnType<typeof vi.fn>
  listDirRecursive: ReturnType<typeof vi.fn>
  rawUrl: ReturnType<typeof vi.fn>
} {
  const listDir = vi.fn(async (_p: string) => files)
  const listDirRecursive = vi.fn(async (_p: string) => opts.recursive ?? files)
  const rawUrl = vi.fn(async (_p: string) => opts.raw ?? 'http://cdn/x')
  return { client: { listDir, listDirRecursive, rawUrl } as unknown as AlistClient, listDir, listDirRecursive, rawUrl }
}

function file(name: string, size: number): AlistFile {
  return { name, size, isDir: false }
}

describe('NetdiskService · spec path (deterministic)', () => {
  let db: NetdiskDb
  let store: MappingStore
  beforeEach(() => {
    db = openNetdiskDb(':memory:')
    store = new MappingStore(db)
  })

  it('bind seeds default spec, matches by episode number as auto, never calls LLM', async () => {
    const left: LeftEntry[] = [{ leftKey: 'yile:20', title: '020.再谈身边灵异事' }]
    const { client } = fakeAlist([file('020.再谈身边灵异事.mp3', 10)])
    const invokeLlm = vi.fn<InvokeLlm>()
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => left, invokeLlm })
    const set = await svc.bind({ left: { kind: 'stream', streamId: 's', title: '怡乐播客' }, dirPath: '/d' })

    expect(set.matchSpec).toBeTruthy()
    expect(invokeLlm).not.toHaveBeenCalled()
    const e = set.entries.find((x) => x.leftKey === 'yile:20')!
    expect(e.status).toBe('auto')
    expect(e.confidence).toBe(1)
    expect(e.rightFile).toBe('020.再谈身边灵异事.mp3')
    expect(e.fingerprint?.size).toBe(10)
    expect(set.coverage?.left.matched).toBe(1)
    expect(set.coverage?.right.orphan).toBe(0)
  })

  it('coverage surfaces missing episodes (source gap) and orphan files (rule miss)', async () => {
    const left: LeftEntry[] = [
      { leftKey: 'yile:66', title: '066.凑活聊道德绑架' },
      { leftKey: 'yile:20', title: '020.再谈身边灵异事' },
    ]
    const { client } = fakeAlist([file('020.再谈身边灵异事.mp3', 5), file('随手一条没有集号.mp3', 7)])
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => left, invokeLlm: vi.fn<InvokeLlm>() })
    const set = await svc.bind({ left: { kind: 'stream', streamId: 's', title: '怡乐播客' }, dirPath: '/d' })

    expect(set.coverage?.left.missing).toBe(1)
    expect(set.coverage?.missingEpisodes).toEqual([66])
    expect(set.coverage?.right.orphan).toBe(1)
    expect(set.coverage?.orphanFiles).toContain('随手一条没有集号.mp3')
    expect(set.entries.find((e) => e.leftKey === 'yile:66')!.status).toBe('unmatched')
  })

  it('recursive right listing: rightFile keeps the subdir path, still matched by basename', async () => {
    const left: LeftEntry[] = [{ leftKey: 'yile:707', title: '707.风水鱼要在棺材里？' }]
    const { client } = fakeAlist([], { recursive: [file('更新/707.风水鱼要在棺材里？.mp3', 9)] })
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => left, invokeLlm: vi.fn<InvokeLlm>() })
    const set = await svc.bind({ left: { kind: 'stream', streamId: 's', title: '怡乐播客' }, dirPath: '/d' })

    const e = set.entries.find((x) => x.leftKey === 'yile:707')!
    expect(e.status).toBe('auto')
    expect(e.rightFile).toBe('更新/707.风水鱼要在棺材里？.mp3') // subpath preserved for resolveUrl
  })

  it('a user-confirmed entry survives resync untouched (decision wins over spec)', async () => {
    const set: MappingSet = {
      id: 'map_cf',
      left: { kind: 'stream', streamId: 's', title: '怡乐播客' },
      right: { kind: 'alist-dir', path: '/d', boundAt: 'now' },
      rightHistory: [],
      autoSync: true,
      matchSpec: DEFAULT_MATCH_SPEC,
      entries: [{ leftKey: 'yile:20', leftTitle: '020.再谈身边灵异事', rightFile: '我手动选的.mp3', status: 'confirmed' }],
    }
    store.save(set)
    const { client } = fakeAlist([file('怡乐播客 - 020.再谈身边灵异事.mp3', 10)])
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => [{ leftKey: 'yile:20', title: '020.再谈身边灵异事' }], invokeLlm: vi.fn<InvokeLlm>() })
    await svc.sync(store.get('map_cf')!)

    const e = store.get('map_cf')!.entries.find((x) => x.leftKey === 'yile:20')!
    expect(e.status).toBe('confirmed')
    expect(e.rightFile).toBe('我手动选的.mp3')
  })

  it('prunes entries whose left item is gone (e.g. free episodes excluded from a paid-only left), keeping user decisions', async () => {
    const set: MappingSet = {
      id: 'map_shrink',
      left: { kind: 'stream', streamId: 's', title: '怡乐播客' },
      right: { kind: 'alist-dir', path: '/d', boundAt: 'now' },
      rightHistory: [],
      autoSync: true,
      matchSpec: DEFAULT_MATCH_SPEC,
      entries: [
        { leftKey: 'yile:20', leftTitle: '020.再谈身边灵异事', rightFile: null, status: 'unmatched' },
        // stale auto match for a left item no longer present → must be pruned
        { leftKey: 'yile:99', leftTitle: '099.免费集', rightFile: '099.免费集.mp3', status: 'auto', confidence: 1 },
        // user decision for a now-absent left item → must be preserved
        { leftKey: 'yile:88', leftTitle: '088.我确认过', rightFile: '手动.mp3', status: 'confirmed' },
      ],
    }
    store.save(set)
    const { client } = fakeAlist([file('020.再谈身边灵异事.mp3', 10)])
    // paid-only left now yields just yile:20
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => [{ leftKey: 'yile:20', title: '020.再谈身边灵异事' }], invokeLlm: vi.fn<InvokeLlm>() })
    await svc.sync(store.get('map_shrink')!)

    const keys = store.get('map_shrink')!.entries.map((e) => e.leftKey).sort()
    expect(keys).toEqual(['yile:20', 'yile:88']) // yile:99 (stale auto) pruned, yile:88 (confirmed) kept
    expect(store.get('map_shrink')!.entries.find((e) => e.leftKey === 'yile:88')!.status).toBe('confirmed')
  })

  it('a rejected entry is not recomputed on the spec path', async () => {
    const set: MappingSet = {
      id: 'map_rej',
      left: { kind: 'stream', streamId: 's', title: '怡乐播客' },
      right: { kind: 'alist-dir', path: '/d', boundAt: 'now' },
      rightHistory: [],
      autoSync: true,
      matchSpec: DEFAULT_MATCH_SPEC,
      entries: [{ leftKey: 'yile:20', leftTitle: '020.再谈身边灵异事', rightFile: 'x.mp3', status: 'rejected' }],
    }
    store.save(set)
    const { client } = fakeAlist([file('020.再谈身边灵异事.mp3', 5)])
    const invokeLlm = vi.fn<InvokeLlm>()
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => [{ leftKey: 'yile:20', title: '020.再谈身边灵异事' }], invokeLlm })
    await svc.sync(store.get('map_rej')!)

    expect(invokeLlm).not.toHaveBeenCalled()
    const e = store.get('map_rej')!.entries[0]
    expect(e.status).toBe('rejected')
    expect(e.rightFile).toBe('x.mp3')
  })
})

describe('NetdiskService · matchSpec-less binding (funnel retired → default spec)', () => {
  let db: NetdiskDb
  let store: MappingStore
  beforeEach(() => {
    db = openNetdiskDb(':memory:')
    store = new MappingStore(db)
  })

  it('a legacy binding with no matchSpec now runs the deterministic default spec (no LLM at runtime)', async () => {
    // Pre-Phase-2 bindings could lack matchSpec; the retired funnel used to handle them. Now sync
    // falls back to DEFAULT_MATCH_SPEC — deterministic, zero-LLM.
    store.save({
      id: 'map_legacy', left: { kind: 'stream', streamId: 's', title: 'P' },
      right: { kind: 'alist-dir', path: '/d', boundAt: 'now' }, rightHistory: [], autoSync: true,
      entries: [], // note: no matchSpec
    })
    const { client } = fakeAlist([], { recursive: [file('020.再谈身边灵异事.mp3', 10)] })
    const invokeLlm = vi.fn<InvokeLlm>()
    const svc = new NetdiskService({ store, alist: client, invokeLlm, listLeft: async () => [{ leftKey: 'yile:20', title: '020.再谈身边灵异事' }] })
    await svc.sync(store.get('map_legacy')!)
    expect(invokeLlm).not.toHaveBeenCalled() // runtime is zero-LLM
    const e = store.get('map_legacy')!.entries.find((x) => x.leftKey === 'yile:20')!
    expect(e.status).toBe('auto')
    expect(e.rightFile).toBe('020.再谈身边灵异事.mp3')
    expect(store.get('map_legacy')!.coverage?.left.matched).toBe(1)
  })

  // 幸运女神 bug:tmdb-tv 绑定里冻着「season-episode 之前」的两阶段默认(bind 时存的快照),默认
  // 修好了它还用旧的 → 0/N。库存默认无 generatedBy = 无用户意图 → 该随默认重解析。
  it('re-resolves a stock-default binding (no generatedBy) to the current default → tmdb-tv scene files match', async () => {
    const frozenOldDefault = { version: 2 as const, stages: [
      { by: 'epnum' as const, epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: ['【[^】]*】'], threshold: 0.6, margin: 0.15 },
      { by: 'title' as const, titleStrip: ['【[^】]*】'], threshold: 0.85, margin: 0.15 },
    ] } // 关键:无 generatedBy —— 这是库存默认的冻结快照
    store.save({
      id: 'map_heal', left: { kind: 'tmdb', id: '278624', media: 'tv', title: '幸运女神' },
      right: { kind: 'alist-dir', path: '/d', boundAt: 'now' }, rightHistory: [], autoSync: true,
      entries: [], matchSpec: frozenOldDefault,
    })
    const { client } = fakeAlist([], { recursive: [file('Lucky.S01E01.2160p.mkv', 10), file('Lucky.S01E02.2160p.mkv', 10)] })
    const svc = new NetdiskService({ store, alist: client, invokeLlm: vi.fn<InvokeLlm>(), listLeft: async () => [
      { leftKey: 'tmdb:278624:S01E01', title: '脚踏实地' }, { leftKey: 'tmdb:278624:S01E02', title: '股掌之间' },
    ] })
    await svc.sync(store.get('map_heal')!)
    expect(store.get('map_heal')!.coverage?.left.matched).toBe(2) // 重解析到含 season-episode 的默认 → 配上
  })

  it('keeps a custom spec (generatedBy) frozen — NOT re-resolved to the default', async () => {
    const customTitleOnly = { version: 2 as const, generatedBy: 'app-llm', stages: [
      { by: 'title' as const, titleStrip: ['【[^】]*】'], threshold: 0.85, margin: 0.15 },
    ] } // 用户/AI 产的自定义谱:只 title
    store.save({
      id: 'map_custom', left: { kind: 'tmdb', id: '9', media: 'tv', title: 'X' },
      right: { kind: 'alist-dir', path: '/d', boundAt: 'now' }, rightHistory: [], autoSync: true,
      entries: [], matchSpec: customTitleOnly,
    })
    const { client } = fakeAlist([], { recursive: [file('Show.S01E01.mkv', 10)] })
    const svc = new NetdiskService({ store, alist: client, invokeLlm: vi.fn<InvokeLlm>(), listLeft: async () => [{ leftKey: 'tmdb:9:S01E01', title: '中文标题' }] })
    await svc.sync(store.get('map_custom')!)
    // 只 title 的自定义谱:中文标题 vs 英文文件名相似度 0 → 不配。若被换成含 season-episode 的默认就会配上——
    // 这条 0 匹配正是「自定义谱没被顶掉」的证据。
    expect(store.get('map_custom')!.coverage?.left.matched).toBe(0)
  })
})

describe('NetdiskService · lifecycle & corrections', () => {
  let db: NetdiskDb
  let store: MappingStore
  beforeEach(() => {
    db = openNetdiskDb(':memory:')
    store = new MappingStore(db)
  })

  it('rebind: confirmed fingerprint inherited, old path recorded, non-inherited reset', async () => {
    const initial: MappingSet = {
      id: 'map_rb',
      left: { kind: 'stream', streamId: 's', title: 'P' },
      right: { kind: 'alist-dir', path: '/old', boundAt: 'now' },
      rightHistory: [],
      autoSync: true,
      entries: [
        { leftKey: 'k:1', leftTitle: 'A', rightFile: 'old-1.m4a', status: 'confirmed', fingerprint: { size: 100 } },
        { leftKey: 'k:2', leftTitle: 'B', rightFile: 'old-2.m4a', status: 'auto', fingerprint: { size: 200 } },
      ],
    }
    store.save(initial)
    const { client } = fakeAlist([file('new-1.m4a', 100), file('new-2.m4a', 999)])
    const svc = new NetdiskService({
      store, alist: client,
      listLeft: async () => [{ leftKey: 'k:1', title: 'A' }, { leftKey: 'k:2', title: 'B' }],
      invokeLlm: vi.fn<InvokeLlm>().mockResolvedValue('[]'),
    })
    const set = await svc.rebind('map_rb', '/new')
    const e1 = set.entries.find((e) => e.leftKey === 'k:1')!
    expect(e1.status).toBe('confirmed')
    expect(e1.rightFile).toBe('new-1.m4a')
    expect(e1.fingerprint?.size).toBe(100)
    const e2 = set.entries.find((e) => e.leftKey === 'k:2')!
    expect(e2.status).toBe('unmatched') // auto not inherited → reset
    expect(set.rightHistory).toEqual([{ path: '/old', unboundAt: expect.any(String) }])
    expect(set.right.path).toBe('/new')
  })

  it('markError persists lastError on the matching entry', async () => {
    store.save({
      id: 'map_err',
      left: { kind: 'stream', streamId: 's', title: 'P' },
      right: { kind: 'alist-dir', path: '/d', boundAt: 'now' },
      rightHistory: [],
      autoSync: true,
      entries: [{ leftKey: 'k:1', leftTitle: 'A', rightFile: 'a.m4a', status: 'auto' }],
    })
    const { client } = fakeAlist([])
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => [], invokeLlm: vi.fn() })
    const hit: PlayableHit = { setId: 'map_err', dirPath: '/d', rightFile: 'a.m4a' }
    svc.markError(hit, 'boom')
    expect(store.get('map_err')!.entries[0].lastError?.message).toBe('boom')
    const reloaded = new MappingStore(db)
    expect(reloaded.get('map_err')!.entries[0].lastError?.message).toBe('boom')
  })

  it('setEntry: confirm keeps rightFile; reject frees it back', async () => {
    store.save({
      id: 'map_se',
      left: { kind: 'stream', streamId: 's', title: 'P' },
      right: { kind: 'alist-dir', path: '/d', boundAt: 'now' },
      rightHistory: [],
      autoSync: true,
      entries: [{ leftKey: 'k:1', leftTitle: 'A', rightFile: 'a.m4a', status: 'auto' }],
    })
    const { client } = fakeAlist([])
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => [], invokeLlm: vi.fn() })

    svc.setEntry('map_se', 'k:1', { status: 'confirmed' })
    expect(store.get('map_se')!.entries[0].status).toBe('confirmed')
    expect(store.get('map_se')!.entries[0].rightFile).toBe('a.m4a')

    svc.setEntry('map_se', 'k:1', { status: 'rejected' })
    expect(store.get('map_se')!.entries[0].status).toBe('rejected')
  })

  it('setEntry rightFile = manual correction: confirmed + stamps corrected with the rule\'s original (wrong) answer', () => {
    store.save({
      id: 'map_c', left: { kind: 'stream', streamId: 's', title: 'P' },
      right: { kind: 'alist-dir', path: '/d', boundAt: 'now' }, rightHistory: [], autoSync: true,
      entries: [{ leftKey: 'k:1', leftTitle: 'A', rightFile: 'wrong.m4a', status: 'auto', confidence: 0.7 }],
    })
    const { client } = fakeAlist([])
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => [], invokeLlm: vi.fn() })

    svc.setEntry('map_c', 'k:1', { rightFile: 'right.m4a' })
    const e = store.get('map_c')!.entries[0]
    expect(e.rightFile).toBe('right.m4a')
    expect(e.status).toBe('confirmed') // playable (mapping-store indexes auto/confirmed) + pinned
    expect(e.corrected).toEqual({ at: expect.any(String), autoFile: 'wrong.m4a' })

    // re-edit keeps the ORIGINAL rule answer as the training negative, not the intermediate manual pick
    svc.setEntry('map_c', 'k:1', { rightFile: 'righter.m4a' })
    expect(store.get('map_c')!.entries[0].corrected!.autoFile).toBe('wrong.m4a')
  })

  it('setEntry clear (rightFile null) = manual "no file" correction: unmatched but stamped corrected', () => {
    store.save({
      id: 'map_x', left: { kind: 'stream', streamId: 's', title: 'P' },
      right: { kind: 'alist-dir', path: '/d', boundAt: 'now' }, rightHistory: [], autoSync: true,
      entries: [{ leftKey: 'k:1', leftTitle: 'A', rightFile: 'guess.m4a', status: 'auto' }],
    })
    const { client } = fakeAlist([])
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => [], invokeLlm: vi.fn() })

    svc.setEntry('map_x', 'k:1', { rightFile: null })
    const e = store.get('map_x')!.entries[0]
    expect(e.rightFile).toBeNull()
    expect(e.status).toBe('unmatched')
    expect(e.corrected).toEqual({ at: expect.any(String), autoFile: 'guess.m4a' })
  })

  it('clearCorrection releases a temporary human decision back to automatic matching', () => {
    store.save({
      id: 'map_release', left: { kind: 'stream', streamId: 's', title: 'P' },
      right: { kind: 'alist-dir', path: '/d', boundAt: 'now' }, rightHistory: [], autoSync: true,
      entries: [{ leftKey: 'k:1', leftTitle: 'A', rightFile: 'manual.m4a', status: 'confirmed', confidence: 1,
        corrected: { at: '2026-07-13T00:00:00Z', autoFile: null } }],
    })
    const { client } = fakeAlist([])
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => [], invokeLlm: vi.fn() })

    svc.clearCorrection('map_release', 'k:1')
    const e = store.get('map_release')!.entries[0]
    expect(e).toMatchObject({ rightFile: null, status: 'unmatched' })
    expect(e.confidence).toBeUndefined()
    expect(e.corrected).toBeUndefined()
  })

  it('sync lists the netdisk with refresh:true (sees renames, not AList\'s stale cache)', async () => {
    store.save({
      id: 'map_r', left: { kind: 'stream', streamId: 's', title: 'P' },
      right: { kind: 'alist-dir', path: '/d', boundAt: 'now' }, rightHistory: [], autoSync: true,
      matchSpec: DEFAULT_MATCH_SPEC, entries: [],
    })
    const { client, listDirRecursive } = fakeAlist([file('020.x.mp3', 100)])
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => [], invokeLlm: vi.fn<InvokeLlm>() })
    await svc.sync(store.get('map_r')!)
    expect(listDirRecursive).toHaveBeenCalledWith('/d', 5, true)
  })

  it('a corrected entry (even unmatched) survives resync — the rule does not guess it back', async () => {
    store.save({
      id: 'map_p', left: { kind: 'stream', streamId: 's', title: 'P' },
      right: { kind: 'alist-dir', path: '/d', boundAt: 'now' }, rightHistory: [], autoSync: true,
      matchSpec: DEFAULT_MATCH_SPEC,
      entries: [{ leftKey: 'yile:20', leftTitle: '020.再谈身边灵异事', rightFile: null, status: 'unmatched',
        corrected: { at: '2026-07-09T00:00:00Z', autoFile: '020.mp3' } }],
    })
    // right side HAS a file the spec would happily match — but the correction must win.
    const { client } = fakeAlist([], { recursive: [file('020.再谈身边灵异事.mp3', 100)] })
    const svc = new NetdiskService({
      store, alist: client,
      listLeft: async () => [{ leftKey: 'yile:20', title: '020.再谈身边灵异事' }], invokeLlm: vi.fn<InvokeLlm>(),
    })
    const set = await svc.sync(store.get('map_p')!)
    const e = set.entries.find((x) => x.leftKey === 'yile:20')!
    expect(e.rightFile).toBeNull() // pinned by `corrected`, not re-matched
    expect(e.status).toBe('unmatched')
  })
})

describe('NetdiskService · spec editing primitives (residue / preview / apply)', () => {
  let db: NetdiskDb
  let store: MappingStore
  beforeEach(() => {
    db = openNetdiskDb(':memory:')
    store = new MappingStore(db)
  })

  // The Phase-2 scenario: netdisk filenames carry a channel prefix "怡乐播客 - " ahead of the
  // episode number, so the default epnum stage can't read the number → those entries are residue.
  const prefixed = (n: string, title: string) => file(`怡乐播客 - ${n}.${title}.mp3`, 10)
  const tunedSpec = {
    version: 2,
    generatedBy: 'test',
    stages: [
      { by: 'epnum', epNumRegex: DEFAULT_EPNUM_REGEX, titleStrip: ['【[^】]*】', '^怡乐播客\\s*[-—]\\s*'], threshold: 0.6, margin: 0.15 },
      { by: 'title', titleStrip: ['【[^】]*】'], threshold: 0.85, margin: 0.15 },
    ],
  }

  function seedPrefixedBinding(id: string, entries: MappingSet['entries'] = []): void {
    store.save({
      id, left: { kind: 'stream', streamId: 's', title: '怡乐播客' },
      right: { kind: 'alist-dir', path: '/d', boundAt: 'now' }, rightHistory: [], autoSync: true,
      matchSpec: DEFAULT_MATCH_SPEC, entries,
    })
  }
  const prefixedLeft: LeftEntry[] = [
    { leftKey: 'yile:20', title: '020.再谈身边灵异事' },
    { leftKey: 'yile:21', title: '021.香港灵异地点盘点' },
  ]
  const prefixedFiles = [prefixed('020', '再谈身边灵异事'), prefixed('021', '香港灵异地点盘点')]

  it('residue surfaces the prefix-blocked entries as unmatched and the files as orphan', async () => {
    seedPrefixedBinding('map_res')
    const { client } = fakeAlist([], { recursive: prefixedFiles })
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => prefixedLeft, invokeLlm: vi.fn<InvokeLlm>() })
    const r = await svc.residue('map_res')
    expect(r.unmatchedLeft.map((l) => l.leftKey).sort()).toEqual(['yile:20', 'yile:21'])
    expect(r.orphanRight).toHaveLength(2)
    expect(r.coverage.left.matched).toBe(0)
  })

  it('previewSpec dry-runs a tuned spec: before/after coverage + changed rows, nothing persisted', async () => {
    seedPrefixedBinding('map_prev')
    const { client } = fakeAlist([], { recursive: prefixedFiles })
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => prefixedLeft, invokeLlm: vi.fn<InvokeLlm>() })
    const p = await svc.previewSpec('map_prev', tunedSpec)
    expect(p.before.left.matched).toBe(0)
    expect(p.after.left.matched).toBe(2)
    expect(p.changed).toHaveLength(2)
    expect(p.changed.find((c) => c.leftKey === 'yile:20')).toMatchObject({ from: null, to: '怡乐播客 - 020.再谈身边灵异事.mp3' })
    // dry-run: binding still on the default spec, no entries mutated
    expect(store.get('map_prev')!.matchSpec).toEqual(DEFAULT_MATCH_SPEC)
    expect(store.get('map_prev')!.entries).toHaveLength(0)
  })

  it('previewSpec reports a corrected conflict and pins it out of changed', async () => {
    seedPrefixedBinding('map_conf', [
      // human already corrected yile:20 to a specific file; the tuned rule would pick the prefixed one
      { leftKey: 'yile:20', leftTitle: '020.再谈身边灵异事', rightFile: '我手动选的.mp3', status: 'confirmed',
        corrected: { at: '2026-07-09T00:00:00Z', autoFile: null } },
    ])
    const { client } = fakeAlist([], { recursive: prefixedFiles })
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => prefixedLeft, invokeLlm: vi.fn<InvokeLlm>() })
    const p = await svc.previewSpec('map_conf', tunedSpec)
    expect(p.correctedConflicts).toHaveLength(1)
    expect(p.correctedConflicts[0]).toMatchObject({ leftKey: 'yile:20', ruleSays: '怡乐播客 - 020.再谈身边灵异事.mp3', human: '我手动选的.mp3' })
    expect(p.changed.some((c) => c.leftKey === 'yile:20')).toBe(false) // pinned, not in changed
  })

  it('applySpec validates + persists the spec + resyncs (residue now matches)', async () => {
    seedPrefixedBinding('map_apply')
    const { client } = fakeAlist([], { recursive: prefixedFiles })
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => prefixedLeft, invokeLlm: vi.fn<InvokeLlm>() })
    const set = await svc.applySpec('map_apply', tunedSpec)
    expect(set.matchSpec?.generatedBy).toBe('test')
    expect(set.entries.find((e) => e.leftKey === 'yile:20')!.status).toBe('auto')
    expect(set.coverage?.left.matched).toBe(2)
    // persisted
    expect(store.get('map_apply')!.matchSpec?.stages?.[0]).toMatchObject({ by: 'epnum' })
  })

  // provenance 缺席的谱(外部 agent/手工 apply 常不自报)必须被补盖 generatedBy,否则 resolveSpec
  // 判成库存默认快照、下次 sync 绕过它回退默认 → 谱看着落了却永远不生效(0/N 的真凶)。
  it('applySpec stamps provenance on a spec missing generatedBy so it actually takes effect', async () => {
    seedPrefixedBinding('map_noprov')
    const { generatedBy: _drop, ...specNoProvenance } = tunedSpec // 有意应用、但没自报 provenance
    const { client } = fakeAlist([], { recursive: prefixedFiles })
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => prefixedLeft, invokeLlm: vi.fn<InvokeLlm>() })
    const set = await svc.applySpec('map_noprov', specNoProvenance)
    expect(set.matchSpec?.generatedBy).toBe('applied') // 补盖,不再空
    // 真生效:默认 epnum 读不出带前缀文件的号 → 若被当默认丢弃则 0；tuned 谱剥前缀 → 2/2。
    expect(set.coverage?.left.matched).toBe(2)
    expect(set.entries.find((e) => e.leftKey === 'yile:20')!.status).toBe('auto')
    // 再同步一次仍生效(resolveSpec 认 generatedBy,不回退默认)
    const resynced = await svc.sync(store.get('map_noprov')!)
    expect(resynced.coverage?.left.matched).toBe(2)
  })

  it('applySpec rejects a malformed spec before touching the binding', async () => {
    seedPrefixedBinding('map_bad')
    const { client } = fakeAlist([], { recursive: prefixedFiles })
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => prefixedLeft, invokeLlm: vi.fn<InvokeLlm>() })
    await expect(svc.applySpec('map_bad', { version: 2, stages: [{ by: 'fingerprint' }] })).rejects.toThrow(/invalid matchSpec/)
    expect(store.get('map_bad')!.matchSpec).toEqual(DEFAULT_MATCH_SPEC) // untouched
  })
})

describe('NetdiskService.waitDirReady —— 转存后等 AList 目录就绪', () => {

  // 转存通过夸克 API 直接建目录（不经 AList），AList 缓存视图有几秒延迟看不到新目录/文件——
  // 立即 sync 会 object not found 或空。poll 到有文件为止，闭环才不会「转存了却没配上」。
  it('目录几次为空/抛错后出现文件 → 重试到就绪返回 true', async () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    let call = 0
    const listDirRecursive = vi.fn(async () => {
      call++
      if (call === 1) throw new Error('[alist] object not found')
      if (call === 2) return [] // AList 还没 index
      return [file('movie.mkv', 100)]
    })
    const sleep = vi.fn(async () => {})
    const svc = new NetdiskService({
      store, alist: { listDir: vi.fn(async () => []), listDirRecursive, rawUrl: vi.fn() } as unknown as AlistClient,
      listLeft: async () => [], invokeLlm: vi.fn<InvokeLlm>(), sleep,
    })
    expect(await svc.waitDirReady('/quark/From Stream/x')).toBe(true)
    expect(call).toBe(3)
    expect(sleep).toHaveBeenCalledTimes(2) // 两次失败后各睡一次
  })

  it('目录只有子目录、没有视频文件 → 也算未就绪（转存的文件还没落）', async () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    const listDirRecursive = vi.fn(async () => [{ name: '子目录', size: 0, isDir: true } as AlistFile])
    const svc = new NetdiskService({
      store, alist: { listDir: vi.fn(async () => []), listDirRecursive, rawUrl: vi.fn() } as unknown as AlistClient,
      listLeft: async () => [], invokeLlm: vi.fn<InvokeLlm>(), sleep: async () => {},
    })
    expect(await svc.waitDirReady('/quark/x')).toBe(false)
  })

  it('始终空 → 超时返回 false，不无限等', async () => {
    const store = new MappingStore(openNetdiskDb(':memory:'))
    const listDirRecursive = vi.fn(async () => [])
    const svc = new NetdiskService({
      store, alist: { listDir: vi.fn(async () => []), listDirRecursive, rawUrl: vi.fn() } as unknown as AlistClient,
      listLeft: async () => [], invokeLlm: vi.fn<InvokeLlm>(), sleep: async () => {},
    })
    expect(await svc.waitDirReady('/quark/x')).toBe(false)
    expect(listDirRecursive.mock.calls.length).toBeGreaterThan(1) // 重试过
  })
})

describe('NetdiskService · browseUrl（跳转网盘）', () => {
  let store: MappingStore
  beforeEach(() => { store = new MappingStore(openNetdiskDb(':memory:')) })
  afterEach(() => { vi.unstubAllGlobals() })

  const stor = (mount_path: string, driver: string) => ({ id: 1, mount_path, driver, addition: '{}', disabled: false })
  const seed = (path: string, over: Record<string, unknown> = {}) => {
    store.save({
      id: 'map_b', left: { kind: 'tmdb', id: '1', media: 'tv', title: 'X' },
      right: { kind: 'alist-dir', path, boundAt: 'now', ...over }, rightHistory: [], autoSync: true, entries: [],
    })
    return store.get('map_b')!
  }
  // browseUrl 现在把「路径段 → 网盘网页 URL」委托给 netdisk.folder Provider（folder capability）；
  // 这里只测 NetdiskService 那层的编排:缓存命中、driver→网盘判定、缓存落盘。provider dispatch
  // 本身在 folder-capability.test.ts 测。
  const folderMock = (folderUrl: (netdisk: string, segments: string[]) => Promise<{ url: string; fid?: string } | null>) =>
    ({ supports: (b: string) => b === 'quark', folderUrl } as unknown as import('./folder-capability.ts').NetdiskFolderCapability)
  const svcWith = (listStorages: () => Promise<unknown>, folder: import('./folder-capability.ts').NetdiskFolderCapability) => {
    const client = { listDir: vi.fn(), listDirRecursive: vi.fn(), rawUrl: vi.fn(), listStorages: vi.fn(listStorages) } as unknown as AlistClient
    return new NetdiskService({ store, alist: client, invokeLlm: vi.fn<InvokeLlm>(), listLeft: async () => [], folder })
  }

  it('缓存了 browseUrl → 直接返回，不问 AList 也不问网盘', async () => {
    const set = seed('/quark/From Stream/X', { browseUrl: 'https://pan.quark.cn/list#/list/all/FID' })
    const svc = svcWith(async () => { throw new Error('listStorages 不该被调用') }, folderMock(vi.fn()))
    expect(await svc.browseUrl(set)).toBe('https://pan.quark.cn/list#/list/all/FID')
  })

  it('无跳转 Provider 的网盘（Local）→ null（前端回落 AList 链接）', async () => {
    const set = seed('/local/movies/X')
    const svc = svcWith(async () => [stor('/local', 'Local')], folderMock(vi.fn()))
    expect(await svc.browseUrl(set)).toBeNull()
  })

  it('夸克挂载 → dispatch 解析出 URL，并缓存落盘', async () => {
    const set = seed('/quark/From Stream/X')
    const folderUrl = vi.fn(async () => ({ url: 'https://pan.quark.cn/list#/list/all/fidB', fid: 'fidB' }))
    const svc = svcWith(async () => [stor('/quark', 'Quark')], folderMock(folderUrl))
    expect(await svc.browseUrl(set)).toBe('https://pan.quark.cn/list#/list/all/fidB')
    expect(folderUrl).toHaveBeenCalledWith('quark', ['From Stream', 'X'])
    expect(store.get('map_b')!.right.browseUrl).toBe('https://pan.quark.cn/list#/list/all/fidB')
  })

  it('夸克挂载但目录解析不到 → null（目录被删/改名），不缓存', async () => {
    const set = seed('/quark/From Stream/不存在')
    const svc = svcWith(async () => [stor('/quark', 'Quark')], folderMock(async () => null))
    expect(await svc.browseUrl(set)).toBeNull()
    expect(store.get('map_b')!.right.browseUrl).toBeUndefined()
  })
})

describe('NetdiskService · 播放判定文件已没 → 后台自愈', () => {
  let store: MappingStore
  beforeEach(() => { store = new MappingStore(openNetdiskDb(':memory:')) })

  const seedAt = (id: string, path: string) => {
    store.save({
      id, left: { kind: 'tmdb', id, media: 'tv', title: 'X' },
      right: { kind: 'alist-dir', path, boundAt: 'now' }, rightHistory: [], autoSync: true, entries: [],
    })
  }

  describe('bindingForPath', () => {
    it('按目录前缀反查出文件所属绑定', () => {
      seedAt('map_a', '/quark/From Stream/剧A')
      const svc = new NetdiskService({ store, alist: {} as AlistClient, invokeLlm: vi.fn<InvokeLlm>(), listLeft: async () => [] })
      expect(svc.bindingForPath('/quark/From Stream/剧A/S01/01.mkv')?.id).toBe('map_a')
      expect(svc.bindingForPath('/quark/From Stream/剧A')?.id).toBe('map_a')
    })
    it('前缀不是完整目录段 → 不误命中（剧A 不该配上剧AB）', () => {
      seedAt('map_a', '/quark/From Stream/剧A')
      const svc = new NetdiskService({ store, alist: {} as AlistClient, invokeLlm: vi.fn<InvokeLlm>(), listLeft: async () => [] })
      expect(svc.bindingForPath('/quark/From Stream/剧AB/01.mkv')).toBeUndefined()
    })
    it('多绑定嵌套 → 取最长（最具体）前缀', () => {
      seedAt('map_outer', '/quark/From Stream')
      seedAt('map_inner', '/quark/From Stream/剧A')
      const svc = new NetdiskService({ store, alist: {} as AlistClient, invokeLlm: vi.fn<InvokeLlm>(), listLeft: async () => [] })
      expect(svc.bindingForPath('/quark/From Stream/剧A/01.mkv')?.id).toBe('map_inner')
    })
  })

  describe('resyncAfterGone', () => {
    it('触发一次递归重列的 sync（自愈同步），且不阻塞调用方', async () => {
      seedAt('map_a', '/quark/From Stream/剧A')
      const listDirRecursive = vi.fn(async () => [] as AlistFile[])
      const client = { listDir: vi.fn(async () => []), listDirRecursive, rawUrl: vi.fn() } as unknown as AlistClient
      const svc = new NetdiskService({ store, alist: client, invokeLlm: vi.fn<InvokeLlm>(), listLeft: async () => [] })

      svc.resyncAfterGone('map_a')
      // fire-and-forget：同步在后台跑，等微任务队列排空后断言它确实列了目录
      await vi.waitFor(() => expect(listDirRecursive).toHaveBeenCalledTimes(1))
    })

    it('同一绑定在飞时去重：狂点死链不会叠触发多次同步', async () => {
      seedAt('map_a', '/quark/From Stream/剧A')
      let release: () => void = () => {}
      const gate = new Promise<void>((r) => { release = r })
      const listDirRecursive = vi.fn(async () => { await gate; return [] as AlistFile[] })
      const client = { listDir: vi.fn(async () => []), listDirRecursive, rawUrl: vi.fn() } as unknown as AlistClient
      const svc = new NetdiskService({ store, alist: client, invokeLlm: vi.fn<InvokeLlm>(), listLeft: async () => [] })
      // resyncAfterGone 同步调用 this.sync——直接 spy 它计次，比 listDirRecursive（隔着一个 await listLeft）可靠
      const syncSpy = vi.spyOn(svc, 'sync')

      svc.resyncAfterGone('map_a')
      svc.resyncAfterGone('map_a')
      svc.resyncAfterGone('map_a')
      expect(syncSpy).toHaveBeenCalledTimes(1) // 第 2、3 次被在飞去重挡下
      release()
      await vi.waitFor(() => expect((svc as unknown as { healing: Set<string> }).healing.has('map_a')).toBe(false))
      // 上一轮结束后再触发 → 允许再同步（去重只针对在飞的那次）
      svc.resyncAfterGone('map_a')
      expect(syncSpy).toHaveBeenCalledTimes(2)
    })

    it('绑定不存在 → 静默无操作', () => {
      const client = { listDirRecursive: vi.fn() } as unknown as AlistClient
      const svc = new NetdiskService({ store, alist: client, invokeLlm: vi.fn<InvokeLlm>(), listLeft: async () => [] })
      expect(() => svc.resyncAfterGone('nope')).not.toThrow()
    })
  })

  it('a multi-season tmdb-tv binding resolves obfuscated per-season folders and does not cross-season collide', async () => {
    const left: LeftEntry[] = [
      { leftKey: 'tmdb:1:S01E01', title: '第1期上' }, { leftKey: 'tmdb:1:S01E02', title: '第1期下' },
      { leftKey: 'tmdb:1:S02E01', title: '第1期上' }, { leftKey: 'tmdb:1:S02E02', title: '第1期下' },
    ]
    // 顺序刻意反过来(第2季文件夹先列):不这样摆,快路径(不分季直接摊平匹配)会因为"哪份先被
    // 消耗"这个实现细节巧合对上答案——把它掩盖成假绿。真正的季隔离必须与右侧列举顺序无关。
    const { client } = fakeAlist([], { recursive: [
      file('乱码季二/第2季/第1期上.mp4', 900), file('乱码季二/第2季/第1期下.mp4', 900),
      file('乱码季一/第1季/第1期上.mp4', 900), file('乱码季一/第1季/第1期下.mp4', 900),
    ] })
    const spec: MatchSpec = { version: 2, stages: [
      { by: 'episode-part', keyRegex: '第0*(\\d{1,3})期.*?(上|下)', titleStrip: [], threshold: 0, margin: 0.15 },
    ] }
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => left, invokeLlm: vi.fn<InvokeLlm>() })
    const set = await svc.bind({ left: { kind: 'tmdb', id: '1', media: 'tv', title: 'X' }, dirPath: '/d', autoSync: false })
    set.matchSpec = { ...spec, generatedBy: 'test' } // 冻结自定义谱,跳过随默认演进重解析
    const synced = await svc.sync(set)

    expect(synced.entries.find((e) => e.leftKey === 'tmdb:1:S01E01')?.rightFile).toBe('乱码季一/第1季/第1期上.mp4')
    expect(synced.entries.find((e) => e.leftKey === 'tmdb:1:S02E01')?.rightFile).toBe('乱码季二/第2季/第1期上.mp4')
    expect(synced.coverage?.left).toMatchObject({ matched: 4, ambiguous: 0, missing: 0 })
  })

  it('a second sync() on an unchanged obfuscated folder reuses the cached LLM season answer instead of asking again', async () => {
    const left: LeftEntry[] = [
      { leftKey: 'tmdb:1:S01E01', title: '第1期上' }, { leftKey: 'tmdb:1:S01E02', title: '第1期下' },
      // 陪衬的第 2 季(同样 2 集,只为让 fingerprints.length>1 触发季分区路径,右侧没有它的文件,
      // 判 missing 不影响本用例)——同时让结构指纹在两季集数打平(都是 2)时正确弃权,逼真落到
      // LLM 兜底,而不是被结构指纹意外唯一命中拦下,测不到缓存这层。
      { leftKey: 'tmdb:1:S02E01', title: '第1期上' }, { leftKey: 'tmdb:1:S02E02', title: '第1期下' },
    ]
    // 顶层名彻底乱码、无子目录/杂项文件——结构指纹(两季集数打平,判不出)和嵌套干净名都判不出,
    // 真落到 LLM 兜底,才用得上缓存。
    const { client } = fakeAlist([], { recursive: [
      file('乱码顶层名字/第1期上.mp4', 900), file('乱码顶层名字/第1期下.mp4', 900),
    ] })
    const spec: MatchSpec = { version: 2, stages: [
      { by: 'episode-part', keyRegex: '第0*(\\d{1,3})期.*?(上|下)', titleStrip: [], threshold: 0, margin: 0.15 },
    ] }
    const invokeLlm: InvokeLlm = vi.fn(async () => JSON.stringify({ 乱码顶层名字: 1 }))
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => left, invokeLlm })
    const set = await svc.bind({ left: { kind: 'tmdb', id: '1', media: 'tv', title: 'X' }, dirPath: '/d', autoSync: false })
    set.matchSpec = { ...spec, generatedBy: 'test' }

    const first = await svc.sync(set)
    expect(first.entries.find((e) => e.leftKey === 'tmdb:1:S01E01')?.rightFile).toBe('乱码顶层名字/第1期上.mp4')
    expect(invokeLlm).toHaveBeenCalledTimes(1)
    expect(first.llmSeasonCache).toEqual({ 乱码顶层名字: 1 }) // 结果落到 binding 上,持久化

    const second = await svc.sync(first)
    expect(second.entries.find((e) => e.leftKey === 'tmdb:1:S01E01')?.rightFile).toBe('乱码顶层名字/第1期上.mp4')
    expect(invokeLlm).toHaveBeenCalledTimes(1) // 文件夹名没变 → 第二次同步不该再问模型
  })
})

// 时长主锚（spec 2026-07-30）：匹配器保持纯函数,右侧时长由 NetdiskService 探好再喂进去。
describe('NetdiskService · 右侧时长探测（时长主锚的进料口）', () => {
  let store: MappingStore
  beforeEach(() => {
    store = new MappingStore(openNetdiskDb(':memory:'))
  })

  it('左侧带时长 → 探右侧文件时长,编号错位的那一集照样配上（端到端）', async () => {
    const left: LeftEntry[] = [{ leftKey: 'yile:53', title: '53.财克印、印克食伤', durationS: 2011 }]
    const { client } = fakeAlist([file('52.财克印、印克食伤.mp3', 10)])
    const durations = vi.fn(async () => new Map([['/d/52.财克印、印克食伤.mp3', 2011]]))
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => left, invokeLlm: vi.fn<InvokeLlm>(), durations })
    const set = await svc.bind({ left: { kind: 'stream', streamId: 's', title: '怡乐播客' }, dirPath: '/d' })

    expect(durations).toHaveBeenCalledWith([{ path: '/d/52.财克印、印克食伤.mp3', size: 10 }])
    const e = set.entries.find((x) => x.leftKey === 'yile:53')!
    expect(e.rightFile).toBe('52.财克印、印克食伤.mp3')
    expect(e.status).toBe('auto')
  })

  it('左侧没有一条带时长（TMDb 绑定）→ 一次探测都不发', async () => {
    const left: LeftEntry[] = [{ leftKey: 'tmdb:1:S01E01', title: '第一集' }]
    const { client } = fakeAlist([file('Show.S01E01.mkv', 10)])
    const durations = vi.fn(async () => new Map<string, number>())
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => left, invokeLlm: vi.fn<InvokeLlm>(), durations })
    await svc.bind({ left: { kind: 'tmdb', id: '1', media: 'tv', title: 'X' }, dirPath: '/d' })
    expect(durations).not.toHaveBeenCalled()
  })

  it('没注入 durations（AList 无直链 / 单测）→ 右侧无时长,逐字退回文件名规则链', async () => {
    // 用编号错位 + 规避字那一组（文件名链救不了它），才量得出"时长确实没参与"。
    const left: LeftEntry[] = [{ leftKey: 'yile:454', title: '454.现代版枪下留人', durationS: 2605 }]
    const { client } = fakeAlist([file('455.现代版木仓下留人.mp3', 10)])
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => left, invokeLlm: vi.fn<InvokeLlm>() })
    const set = await svc.bind({ left: { kind: 'stream', streamId: 's', title: '怡乐播客' }, dirPath: '/d' })
    expect(set.entries.find((x) => x.leftKey === 'yile:454')!.status).toBe('unmatched')
  })
})

/**
 * **人工覆盖（`matchSpec.needsSupply`）不能被"库存默认随默认演进"那条规则吃掉。**
 *
 * `resolveSpec` 只冻结**自定义谱**（有 `generatedBy`），库存默认（无 `generatedBy`）整份丢掉、
 * 重解析到当前默认——这条本身是对的（否则默认修好了、存量绑定还用着旧快照）。但 `needsSupply`
 * 不是"当时默认"的一部分，它是**用户意图**：绑定绝大多数用的就是库存默认，覆盖一落在那种谱上
 * 就会在下一轮 sync/整理时静默消失，表现是"开关点了、下一轮照旧按算出来的走"。
 */
describe('resolveSpec 保留人工覆盖 needsSupply', () => {
  const stream = { kind: 'stream', streamId: 's', title: '怡乐播客' } as const

  it('库存默认谱（无 generatedBy）上的覆盖照旧带过来', () => {
    const spec = resolveSpec({ left: stream, matchSpec: { version: 2, needsSupply: true } })
    expect(spec.needsSupply).toBe(true)
    // 其余部分仍然重解析到当前默认（这条规则本身没变）
    expect(spec.stages).toEqual(DEFAULT_MATCH_SPEC.stages)
  })

  it('两个方向都带；没填就不凭空造一个', () => {
    expect(resolveSpec({ left: stream, matchSpec: { version: 2, needsSupply: false } }).needsSupply).toBe(false)
    expect('needsSupply' in resolveSpec({ left: stream, matchSpec: { version: 2 } })).toBe(false)
    expect('needsSupply' in resolveSpec({ left: stream })).toBe(false)
  })

  it('自定义谱照旧整份冻结（本来就带着它）', () => {
    const custom: MatchSpec = { version: 2, stages: [{ by: 'solo' }], generatedBy: 'app-llm', needsSupply: true }
    expect(resolveSpec({ left: stream, matchSpec: custom })).toBe(custom)
  })
})

/**
 * 改一次规则要连着 residue → preview ×N → apply，每一步都拉一次两侧。左侧那一半是**出网**的
 * （tmdb 分集索引：一部五季的剧 2 个请求、约 1MB），而它在一次会话里根本不会变。
 *
 * 活体（2026-09-02）：模型为一条绑定连跑 8 次，其中两次撞上 `Error: fetch failed` 而失败——
 * 错误原文既没说是哪一端挂了、也没重试，模型只能猜"网络抖动"，再拿一个别的工具去试连通性。
 */
describe('左侧清单：一次会话里只出网一次，失败要说是哪一端', () => {
  let db: NetdiskDb
  let store: MappingStore
  beforeEach(() => { db = openNetdiskDb(':memory:'); store = new MappingStore(db) })
  afterEach(() => { vi.useRealTimers() })

  const bindOnce = async (svc: NetdiskService): Promise<MappingSet> =>
    svc.bind({ left: { kind: 'stream', streamId: 's', title: '怡乐播客' }, dirPath: '/quark/x' })

  it('residue/preview 反复调用不重复拉左侧；右侧照旧每次现列', async () => {
    const { client, listDirRecursive } = fakeAlist([file('020.再谈身边灵异事.mp3', 10)])
    const listLeft = vi.fn<ListLeft>(async () => [{ leftKey: 'yile:20', title: '020.再谈身边灵异事' }])
    const svc = new NetdiskService({ store, alist: client, listLeft, invokeLlm: vi.fn<InvokeLlm>() })
    const set = await bindOnce(svc)
    const calls = listLeft.mock.calls.length
    const recursive = listDirRecursive.mock.calls.length
    await svc.residue(set.id)
    await svc.previewSpec(set.id, DEFAULT_MATCH_SPEC)
    await svc.previewSpec(set.id, DEFAULT_MATCH_SPEC)
    expect(listLeft.mock.calls.length).toBe(calls) // 三次调用，一次都没再出网
    // 右侧是会变的那一半（用户刚往网盘里丢了文件）——它必须每次现列，不许跟着一起缓存。
    expect(listDirRecursive.mock.calls.length).toBe(recursive + 3)
  })

  it('缓存会过期——不是把开机那一刻的答案冻住', async () => {
    vi.useFakeTimers()
    const { client } = fakeAlist([file('020.再谈身边灵异事.mp3', 10)])
    const listLeft = vi.fn<ListLeft>(async () => [{ leftKey: 'yile:20', title: '020.再谈身边灵异事' }])
    const svc = new NetdiskService({ store, alist: client, listLeft, invokeLlm: vi.fn<InvokeLlm>() })
    const set = await bindOnce(svc)
    await svc.residue(set.id)
    const calls = listLeft.mock.calls.length
    vi.advanceTimersByTime(11 * 60_000)
    await svc.residue(set.id)
    expect(listLeft.mock.calls.length).toBe(calls + 1)
  })

  it('左侧挂了 → 错误带上是哪一端，且已重试过一次', async () => {
    vi.useFakeTimers()
    const { client } = fakeAlist([file('a.mp3', 10)])
    const listLeft = vi.fn<ListLeft>(async () => [{ leftKey: 'yile:20', title: 'x' }])
    const svc = new NetdiskService({ store, alist: client, listLeft, invokeLlm: vi.fn<InvokeLlm>() })
    const set = await bindOnce(svc)
    // 跨过备忘的存活期才够得着真正的取数——备忘期内它连挂都挂不了（这本身就是本次修的一半）。
    vi.advanceTimersByTime(11 * 60_000)
    listLeft.mockRejectedValue(new Error('fetch failed'))
    const before = listLeft.mock.calls.length
    await expect(svc.residue(set.id)).rejects.toThrow(/清单.*fetch failed/)
    expect(listLeft.mock.calls.length).toBe(before + 2) // 重试过一次，不是一挂就报
  })

  it('右侧挂了 → 说的是网盘那一端，别让人去查错地方', async () => {
    const listDirRecursive = vi.fn(async () => { throw new Error('fetch failed') })
    const client = { listDir: vi.fn(), listDirRecursive, rawUrl: vi.fn() } as unknown as AlistClient
    const ok = fakeAlist([file('a.mp3', 10)])
    const svc = new NetdiskService({ store, alist: ok.client, listLeft: async () => [{ leftKey: 'k', title: 'x' }], invokeLlm: vi.fn<InvokeLlm>() })
    const set = await bindOnce(svc)
    const broken = new NetdiskService({ store, alist: client, listLeft: async () => [{ leftKey: 'k', title: 'x' }], invokeLlm: vi.fn<InvokeLlm>() })
    await expect(broken.residue(set.id)).rejects.toThrow(/网盘.*fetch failed/)
  })
})

/**
 * `resolveSeasons`（归档器共用的那一口）**只在缓存真的变了才落盘**：它每轮预览都会被调一次，
 * 缓存全命中时写一次盘只是白写——而这条口子的存在意义正是"与同步共用同一份缓存"，
 * 不是"每次预览都改一次绑定"。
 */
describe('resolveSeasons：缓存没变就不落盘', () => {
  let db: NetdiskDb
  let store: MappingStore
  beforeEach(() => { db = openNetdiskDb(':memory:'); store = new MappingStore(db) })

  const groups = [{ folder: '来路不明', files: [{ name: '来路不明/x.mkv', size: 10 }] }]
  const fingerprints = [{ season: 2, episodeCount: 5 }]

  it('第一次问 LLM（缓存新增一项）→ 落盘；第二次全命中缓存 → 不落盘', async () => {
    const { client } = fakeAlist([file('a.mp3', 10)])
    // 模型答不上来 → 缓存里记一条 null（"问过了，判不出"），这仍然是一次真实的缓存变更。
    const svc = new NetdiskService({ store, alist: client, listLeft: async () => [{ leftKey: 'k', title: 'x' }], invokeLlm: vi.fn<InvokeLlm>(async () => '不知道') })
    const set = await svc.bind({ left: { kind: 'stream', streamId: 's', title: '怡乐播客' }, dirPath: '/quark/x' })

    const save = vi.spyOn(store, 'save')
    await svc.resolveSeasons(set.id, groups, fingerprints)
    expect(save).toHaveBeenCalledTimes(1)

    save.mockClear()
    await svc.resolveSeasons(set.id, groups, fingerprints)
    expect(save).not.toHaveBeenCalled()
  })
})
