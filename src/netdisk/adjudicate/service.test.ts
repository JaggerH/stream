import { describe, it, expect, vi } from 'vitest'
import { AdjudicationService, type AdjudicationServiceDeps } from './service.ts'
import type { MappingSet } from '../types.ts'
import type { FollowCandidate } from '../follow/types.ts'
import { cardsFromPending, cardsHash, selectCards } from './cards.ts'
import type { AuthorityEntry } from '../reconcile/plan.ts'
import type { PendingLike } from '../../mcp/reconcile-surface.ts'

const NOW = new Date('2026-09-03T10:00:00Z')

const AUTH: AuthorityEntry[] = [
  { leftKey: 'tmdb:9:S01E01', title: '第1期', durationS: 3600 },
  { leftKey: 'tmdb:9:S01E02', title: '第2期', durationS: 3700 },
]

const PENDING_CARD: PendingLike = {
  src: { path: '/lib/S01/b.mkv', size: 200, durationS: 3701 },
  pendingKind: 'duration-collision',
  collidesWith: 'tmdb:9:S01E02',
  reason: '时长撞上',
}

function baseSet(over: Partial<MappingSet> = {}): MappingSet {
  return {
    id: 'map_1',
    left: { kind: 'tmdb', id: '9', media: 'tv', title: '测试剧' },
    right: { kind: 'alist-dir', path: '/lib', boundAt: '2026-08-01T00:00:00Z' },
    rightHistory: [], autoSync: true, entries: [],
    ...over,
  }
}

interface Harness {
  svc: AdjudicationService
  store: { get: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; saved: MappingSet[] }
  reconcile: {
    previewBinding: ReturnType<typeof vi.fn>
    authorityForBinding: ReturnType<typeof vi.fn>
    setIsEpisode: ReturnType<typeof vi.fn>
    setNotEpisode: ReturnType<typeof vi.fn>
    executeBinding: ReturnType<typeof vi.fn>
    revokeAdjudication: ReturnType<typeof vi.fn>
  }
  suggestions: { record: ReturnType<typeof vi.fn> }
  invokeLlm: ReturnType<typeof vi.fn>
  events: Array<Record<string, unknown>>
  shares?: { save: ReturnType<typeof vi.fn> }
}

function harness(over: {
  set?: MappingSet
  pending?: PendingLike[]
  authority?: AuthorityEntry[]
  invokeLlm?: (msgs: unknown) => Promise<string | null>
  withShares?: boolean
  /** 预览回执里的「目录 → 季」表（多季绑定才有）。缺省 = 单季/播客，卡上没有季这回事。 */
  seasonOfDir?: Record<string, number | null>
} = {}): Harness {
  let set = over.set ?? baseSet()
  const sets = new Map<string, MappingSet>([[set.id, set]])
  const savedSets: MappingSet[] = []
  const store = {
    get: vi.fn((id: string) => sets.get(id)),
    save: vi.fn((s: MappingSet) => { sets.set(s.id, s); savedSets.push(s) }),
    saved: savedSets,
  }
  const pending = over.pending ?? [PENDING_CARD]
  const authority = over.authority ?? AUTH
  const reconcile = {
    previewBinding: vi.fn(async () => ({
      plan: pending.map((p, i) => ({ ...p, kind: 'pending', key: `k${i}` })),
      counts: {} as never, shelves: { claimed: '/lib' }, sourceDirs: [], ledger: {} as never,
      ...(over.seasonOfDir ? { seasonOfDir: over.seasonOfDir } : {}),
    })),
    authorityForBinding: vi.fn(async () => ({ entries: authority, stats: {} as never, source: 'test' })),
    setIsEpisode: vi.fn(),
    setNotEpisode: vi.fn(),
    executeBinding: vi.fn(async () => ({ moved: 0, deleted: 0, renamed: 0, removedDirs: 0, pending: 0, errors: [], runId: 'run_x', ledger: {} as never })),
    revokeAdjudication: vi.fn(() => 3),
  }
  const suggestions = { record: vi.fn() }
  const events: Array<Record<string, unknown>> = []
  const shares = over.withShares ? { save: vi.fn(async () => ({ saved: true, stage: 'done', message: 'ok' })) } : undefined
  const invokeLlm = vi.fn(over.invokeLlm ?? (async () => null))
  const deps: AdjudicationServiceDeps = {
    reconcile: reconcile as never,
    store: store as never,
    suggestions: suggestions as never,
    invokeLlm,
    ...(shares ? { shares } : {}),
    events: { append: (e) => events.push(e as unknown as Record<string, unknown>) },
    now: () => NOW,
    log: () => {},
  }
  return { svc: new AdjudicationService(deps), store, reconcile, suggestions, invokeLlm, events, ...(shares ? { shares } : {}) }
}

describe('AdjudicationService.run', () => {
  it('过闸的 is-episode 落账（note llm:<runId>）+ 归档卡有采纳就重新 executeBinding 一次', async () => {
    const h = harness({
      invokeLlm: async () => JSON.stringify({ decisions: [{ id: '1', verdict: 'is-episode', leftKey: 'tmdb:9:S01E02', confidence: 'high', reason: '同一集另一版' }] }),
    })
    const res = await h.svc.run('map_1', { trigger: 'manual', losers: false })
    expect(res.applied).toBe(1)
    expect(res.rejected).toBe(0)
    expect(h.reconcile.setIsEpisode).toHaveBeenCalledWith('tmdb:9:S01E02', '/lib/S01/b.mkv', true, `llm:${res.runId}`)
    expect(h.reconcile.executeBinding).toHaveBeenCalledTimes(1)
    expect(h.reconcile.executeBinding).toHaveBeenCalledWith('map_1', { losers: false, gated: false })
    expect(h.suggestions.record).toHaveBeenCalledWith(expect.objectContaining({ path: '/lib/S01/b.mkv', verdict: 'is-episode', leftKey: 'tmdb:9:S01E02' }))
    expect(h.events).toHaveLength(1)
    expect(h.events[0]).toMatchObject({ type: 'netdisk.adjudicate', severity: 'info' })
  })

  it('闸拒收：时长差得太多 → 留卡，不落账，不重新归档', async () => {
    const h = harness({
      pending: [{ src: { path: '/lib/S01/b.mkv', size: 200, durationS: 100 }, pendingKind: 'duration-collision', collidesWith: 'tmdb:9:S01E02', reason: 'x' }],
      invokeLlm: async () => JSON.stringify({ decisions: [{ id: '1', verdict: 'is-episode', leftKey: 'tmdb:9:S01E02', confidence: 'high', reason: 'x' }] }),
    })
    const res = await h.svc.run('map_1', { trigger: 'manual', losers: false })
    expect(res.applied).toBe(0)
    expect(res.rejected).toBe(1)
    expect(h.reconcile.setIsEpisode).not.toHaveBeenCalled()
    expect(h.reconcile.executeBinding).not.toHaveBeenCalled()
  })

  /**
   * 季一致性那条闸（spec §5 第 4 条）吃的是预览回执里的 `seasonOfDir`——不带过来，闸就对所有卡静默失效
   * （`dirSeason` 缺席 = "没有季这回事" = 放行）。这条钉的是"服务层真的把它递到造卡那一步了"。
   */
  it('季一致性闸：预览回执带 seasonOfDir，文件在 S01 目录、模型指向 S02 的集 → 拒收', async () => {
    const h = harness({
      authority: [...AUTH, { leftKey: 'tmdb:9:S02E01', title: '第1期', durationS: 3701 }],
      pending: [{ src: { path: '/lib/S01/b.mkv', size: 200, durationS: 3701 }, pendingKind: 'evidence-conflict', conflictsWith: ['tmdb:9:S01E02', 'tmdb:9:S02E01'], reason: 'x' }],
      seasonOfDir: { '/lib/S01': 1 },
      invokeLlm: async () => JSON.stringify({ decisions: [{ id: '1', verdict: 'is-episode', leftKey: 'tmdb:9:S02E01', confidence: 'high', reason: 'x' }] }),
    })
    const res = await h.svc.run('map_1', { trigger: 'manual', losers: false })
    expect(res.rejected).toBe(1)
    expect(h.reconcile.setIsEpisode).not.toHaveBeenCalled()
  })

  it('「都不是」（not-episode 不带 leftKey）→ 对卡上每个候选各落一条 not-episode', async () => {
    const h = harness({
      authority: [...AUTH, { leftKey: 'tmdb:9:S01E03', title: '第3期', durationS: 3800 }],
      pending: [{ src: { path: '/lib/S01/b.mkv', size: 200, durationS: 3701 }, pendingKind: 'evidence-conflict', conflictsWith: ['tmdb:9:S01E02', 'tmdb:9:S01E03'], reason: 'x' }],
      invokeLlm: async () => JSON.stringify({ decisions: [{ id: '1', verdict: 'not-episode', confidence: 'high', reason: '纯享不是正片' }] }),
    })
    const res = await h.svc.run('map_1', { trigger: 'manual', losers: false })
    expect(res.applied).toBe(1)
    expect(h.reconcile.setNotEpisode).toHaveBeenCalledTimes(2)
    expect(h.reconcile.setNotEpisode).toHaveBeenCalledWith('tmdb:9:S01E02', '/lib/S01/b.mkv', true, `llm:${res.runId}`)
    expect(h.reconcile.setNotEpisode).toHaveBeenCalledWith('tmdb:9:S01E03', '/lib/S01/b.mkv', true, `llm:${res.runId}`)
    expect(h.reconcile.setIsEpisode).not.toHaveBeenCalled()
  })

  it('decision.id 对不上这次发出去的任何 card.id → 丢弃，不落账、不计入 applied/rejected', async () => {
    const h = harness({
      invokeLlm: async () => JSON.stringify({ decisions: [{ id: '999', verdict: 'is-episode', leftKey: 'tmdb:9:S01E02', confidence: 'high', reason: 'x' }] }),
    })
    const res = await h.svc.run('map_1', { trigger: 'manual', losers: false })
    expect(res.applied).toBe(0)
    expect(res.rejected).toBe(0)
    expect(res.unsure).toBe(0)
    expect(h.reconcile.setIsEpisode).not.toHaveBeenCalled()
    expect(h.suggestions.record).not.toHaveBeenCalled()
  })

  it('节流：卡集合指纹相同且距上次不足 7 天 → 不调用 invokeLlm', async () => {
    const cards = selectCards(cardsFromPending([PENDING_CARD], AUTH))
    const hash = cardsHash(cards)
    const set = baseSet({ adjudication: { lastCardsHash: hash, lastAt: new Date('2026-09-01T00:00:00Z').toISOString(), lastRunId: 'adj_old' } })
    const h = harness({ set })
    const res = await h.svc.run('map_1', { trigger: 'manual', losers: false })
    expect(res.skipped).toBe('same cards')
    expect(h.invokeLlm).not.toHaveBeenCalled()
    expect(h.events).toHaveLength(0)
  })

  it('节流：手动入口传 force → 同一批卡照样问', async () => {
    const cards = selectCards(cardsFromPending([PENDING_CARD], AUTH))
    const set = baseSet({ adjudication: { lastCardsHash: cardsHash(cards), lastAt: new Date('2026-09-01T00:00:00Z').toISOString(), lastRunId: 'adj_old' } })
    const h = harness({ set, invokeLlm: async () => null })
    const res = await h.svc.run('map_1', { trigger: 'manual', losers: false, force: true })
    expect(res.skipped).toBeUndefined()
    expect(h.invokeLlm).toHaveBeenCalledTimes(1)
  })

  it('节流：指纹相同但已过 7 天 → 照常问', async () => {
    const cards = selectCards(cardsFromPending([PENDING_CARD], AUTH))
    const hash = cardsHash(cards)
    const set = baseSet({ adjudication: { lastCardsHash: hash, lastAt: new Date('2026-08-01T00:00:00Z').toISOString(), lastRunId: 'adj_old' } })
    const h = harness({ set, invokeLlm: async () => null })
    const res = await h.svc.run('map_1', { trigger: 'manual', losers: false })
    expect(res.skipped).toBeUndefined()
    expect(h.invokeLlm).toHaveBeenCalledTimes(1)
  })

  it('没有卡可问 → 跳过（no cards），不写节流状态、不通知', async () => {
    const h = harness({ pending: [] })
    const res = await h.svc.run('map_1', { trigger: 'manual', losers: false })
    expect(res.skipped).toBe('no cards')
    expect(h.invokeLlm).not.toHaveBeenCalled()
    expect(h.store.save).not.toHaveBeenCalled()
    expect(h.events).toHaveLength(0)
  })

  it('解析失败（非法 JSON）→ 整批 failed:unparseable，不落任何账', async () => {
    const h = harness({ invokeLlm: async () => '不是 JSON' })
    const res = await h.svc.run('map_1', { trigger: 'manual', losers: false })
    expect(res.failed).toBe('unparseable')
    expect(h.reconcile.setIsEpisode).not.toHaveBeenCalled()
    expect(h.events[0]).toMatchObject({ severity: 'warn' })
  })

  it('invokeLlm 未配置/调用失败（返回 null）→ 整批 failed:no llm', async () => {
    const h = harness({ invokeLlm: async () => null })
    const res = await h.svc.run('map_1', { trigger: 'manual', losers: false })
    expect(res.failed).toBe('no llm')
    expect(h.reconcile.setIsEpisode).not.toHaveBeenCalled()
  })

  it('追更候选过闸后：转存被调一次，决定落在 landingPathOf 的路径上，不触发归档重跑', async () => {
    const candidate: FollowCandidate = {
      netdisk: 'quark', pwdId: 'p1',
      file: { fid: 'fid1', token: 'tok', pdirFid: 'dir:S01', name: '第1期.mp4', size: 123, path: 'S01/第1期.mp4' },
      subdir: 'From Stream/tv-9/S01',
      candidateLeftKeys: ['tmdb:9:S01E01'],
    }
    const h = harness({
      pending: [],
      // service.run 里的 selectCards 才真正分配 id（这批只有这一张卡，会分到 "1"）——
      // 卡自己（`cardsFromFollowCandidates` 的产出）此刻 id 恒为 ''，不能直接拿来当模型回执的 id。
      invokeLlm: async () => JSON.stringify({ decisions: [{ id: '1', verdict: 'is-episode', leftKey: 'tmdb:9:S01E01', confidence: 'high', reason: 'x' }] }),
      withShares: true,
    })
    const res = await h.svc.run('map_1', { trigger: 'follow', losers: true, followCandidates: [candidate] })
    expect(res.applied).toBe(1)
    expect(h.shares!.save).toHaveBeenCalledTimes(1)
    expect(h.shares!.save).toHaveBeenCalledWith('quark', 'p1', {
      files: [{ fid: 'fid1', token: 'tok', pdirFid: 'dir:S01' }],
      subdir: 'From Stream/tv-9/S01',
    })
    expect(h.reconcile.setIsEpisode).toHaveBeenCalledWith('tmdb:9:S01E01', '/lib/From Stream/tv-9/S01/第1期.mp4', true, `llm:${res.runId}`)
    // 追更候选的采纳不触发"重新归档"（那是归档 pending 卡专属的 §7 出口）。
    expect(h.reconcile.executeBinding).not.toHaveBeenCalled()
  })

  it('追更候选没有 shares 依赖（手动入口场景）→ 转存不生效，算拒收', async () => {
    const candidate: FollowCandidate = {
      netdisk: 'quark', pwdId: 'p1',
      file: { fid: 'fid1', token: 'tok', name: '第1期.mp4', size: 123, path: 'S01/第1期.mp4' },
      subdir: 'From Stream/tv-9/S01',
      candidateLeftKeys: ['tmdb:9:S01E01'],
    }
    const h = harness({
      pending: [],
      // service.run 里的 selectCards 才真正分配 id（这批只有这一张卡，会分到 "1"）——
      // 卡自己（`cardsFromFollowCandidates` 的产出）此刻 id 恒为 ''，不能直接拿来当模型回执的 id。
      invokeLlm: async () => JSON.stringify({ decisions: [{ id: '1', verdict: 'is-episode', leftKey: 'tmdb:9:S01E01', confidence: 'high', reason: 'x' }] }),
      withShares: false,
    })
    const res = await h.svc.run('map_1', { trigger: 'manual', losers: false, followCandidates: [candidate] })
    expect(res.applied).toBe(0)
    expect(res.rejected).toBe(1)
    expect(h.reconcile.setIsEpisode).not.toHaveBeenCalled()
  })
})

describe('AdjudicationService.revoke', () => {
  it('透传给 reconcile.revokeAdjudication', async () => {
    const h = harness()
    const n = await h.svc.revoke('adj_x')
    expect(n).toBe(3)
    expect(h.reconcile.revokeAdjudication).toHaveBeenCalledWith('adj_x')
  })
})
