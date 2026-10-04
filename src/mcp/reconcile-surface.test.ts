import { describe, it, expect } from 'vitest'
import {
  projectReconcileStatus,
  applyReconcileDecisions,
  groupSuspectDirs,
  resolveReconcileRef,
  clampLimit,
  RECONCILE_PAGE_DEFAULT,
  RECONCILE_PAGE_MAX,
  PLANNED_DELETES_MAX,
  planFingerprint,
  runReconcileExecute,
  type DeleteLike,
  type PendingLike,
  type ReconcileDecisionSink,
} from './reconcile-surface.ts'

const DIR = '/quark/来自：分享/播客付费节目合集/凹凸电波'

/** 造一条熔断降级下来的 pending——形状照 `plan.ts` 的 `suspectDirPass` 写出来的那份。 */
function suspectRow(i: number, dir = DIR, bad = 349, total = 491): PendingLike {
  const path = `${dir}/凹凸plus/第 ${i} 集：一个足够长的中文标题好让体积贴近活体.mp3`
  const priorVerdict = `delete:${path}`
  return {
    src: { path, size: 78_152_094, durationS: 3751 },
    pendingKind: 'suspect-dir',
    suspect: { dir, bad, total, priorVerdict },
    // 活体里这句话被复制到该目录下每一条动作上——回执膨胀的正主。
    reason: `目录疑似认领错误：${dir} 内 ${bad}/${total} 个文件认不出属于本节目——确认无误可逐条裁决。原判定：${priorVerdict}`,
  }
}

/** 一张普通的待裁决卡（不是熔断降级来的）。 */
function plainCard(i: number): PendingLike {
  return {
    src: { path: `${DIR}/正片/第 ${i} 期.mp3`, size: 1000 + i, durationS: 3600 },
    pendingKind: 'duration-collision',
    episode: `第 ${i} 期`,
    collidesWith: `left-${i}`,
    compare: { authorityDurationS: 3599, candidates: [{ path: 'a' }] },
    reason: '时长撞上某一集、名字过不了地板',
  }
}

const input = (pending: PendingLike[]) => ({ counts: { pending: pending.length }, pending })

describe('groupSuspectDirs —— 一条目录级判断折回一条', () => {
  it('同一目录的 N 条折成 1 组，带计数与样本', () => {
    const rows = Array.from({ length: 491 }, (_, i) => suspectRow(i))
    const groups = groupSuspectDirs(rows)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ dir: DIR, unrecognized: 349, scanned: 491, files: 491 })
    expect(groups[0].sample).toHaveLength(3)
    // hint 要指向**先去看**，不是先去问。活体教训：第一版写「先问用户这个目录指对了没有」，
    // 模型一字不差照做、停在了问句上，而 netdisk_browse 就在它手里——目录里有什么是查得到的
    // 事实，把它抛回用户等于让人替它侦察。
    expect(groups[0].hint).toContain('netdisk_browse')
    expect(groups[0].hint).toContain('先看再说，不要直接把这个问题抛给用户')
    expect(groups[0].hint).not.toContain('先问用户这个目录指对了没有')
    // 三个出口都得在——(b) 那一档（目录没指错、节目单不覆盖）正是原先漏掉的那种情况。
    expect(groups[0].hint).toContain('节目单不覆盖这批内容')
  })

  it('两个目录各成一组，不合并', () => {
    const groups = groupSuspectDirs([suspectRow(1, '/a'), suspectRow(2, '/b'), suspectRow(3, '/a')])
    expect(groups.map((g) => [g.dir, g.files])).toEqual([
      ['/a', 2],
      ['/b', 1],
    ])
  })

  it('没有熔断标记的卡不进组', () => {
    expect(groupSuspectDirs([plainCard(1), plainCard(2)])).toEqual([])
  })
})

describe('默认回执 —— 熔断目录归组，逐条卡片封顶且截断自陈', () => {
  it('491 条 suspect-dir 不出现在 pending 里，只留一条组', () => {
    const out = projectReconcileStatus(input(Array.from({ length: 491 }, (_, i) => suspectRow(i))))
    expect(out.pending).toEqual([])
    expect(out.pendingTotal).toBe(0)
    expect(out.pendingTruncated).toBe(false)
    expect(out.suspectDirs).toHaveLength(1)
  })

  it('回执体积：491 条从 130KB+ 掉到 2KB 以内', () => {
    const rows = Array.from({ length: 491 }, (_, i) => suspectRow(i))
    // 旧行为的等价物：逐条摊平（含那句被复制 491 遍的 reason）。
    const naive = JSON.stringify(rows.map((a) => ({ file: a.src.path, sizeBytes: a.src.size, durationS: a.src.durationS, pendingKind: a.pendingKind, reason: a.reason })))
    expect(naive.length).toBeGreaterThan(130_000)
    const now = JSON.stringify(projectReconcileStatus(input(rows)))
    expect(now.length).toBeLessThan(2_000)
  })

  it('普通卡超过 limit → 截断，但总数与截断标记都说出来', () => {
    const cards = Array.from({ length: 120 }, (_, i) => plainCard(i))
    const out = projectReconcileStatus(input(cards))
    expect((out.pending as unknown[]).length).toBe(RECONCILE_PAGE_DEFAULT)
    expect(out.pendingTotal).toBe(120)
    expect(out.pendingTruncated).toBe(true)
  })

  // 它曾经在回执里，而 SuggestionQuery 没有 show 这一维——活体四个节目返回同一份
  // {total:12, agreed:7, open:5}。一个看起来有作用域、其实没有的数字比没有更坏：模型会当真，
  // 而没有任何一处会报错。删了就别让它悄悄回来。
  it('回执里不含 suggestions —— 那是全局数字，不能挂在按节目的回执上', () => {
    for (const out of [
      projectReconcileStatus(input([plainCard(1), suspectRow(1)])),
      projectReconcileStatus(input([suspectRow(1), suspectRow(2)]), { expandDir: DIR }),
    ]) {
      expect(out).not.toHaveProperty('suggestions')
      expect(JSON.stringify(out)).not.toContain('suggestions')
    }
  })

  it('没超 limit 时 pendingTruncated 是 false（不能恒真）', () => {
    const out = projectReconcileStatus(input([plainCard(1), plainCard(2)]))
    expect(out.pendingTotal).toBe(2)
    expect(out.pendingTruncated).toBe(false)
  })

  it('普通卡的证据字段一个不少（归组不许顺手削掉裁决要用的东西）', () => {
    const out = projectReconcileStatus(input([plainCard(7)]))
    expect((out.pending as Record<string, unknown>[])[0]).toMatchObject({
      file: `${DIR}/正片/第 7 期.mp3`,
      pendingKind: 'duration-collision',
      episode: '第 7 期',
      leftKey: 'left-7',
      authorityDurationS: 3599,
      candidates: [{ path: 'a' }],
    })
  })

  it('两类混在一起时各走各的', () => {
    const out = projectReconcileStatus(input([plainCard(1), suspectRow(1), plainCard(2), suspectRow(2)]))
    expect(out.pendingTotal).toBe(2)
    expect(out.suspectDirs).toHaveLength(1)
    expect((out.suspectDirs as { files: number }[])[0].files).toBe(2)
  })
})

// `reconcile_execute` 的描述要求模型执行前核对"每条删除留下的是同一集的另一份"，而在这一格
// 出现之前，回执里关于删除的全部内容是 `counts` 里的四个数字——那句要求指向一份它拿不到的数据。
describe('plannedDeletes —— 将删清单，execute 之前要核对的那一份', () => {
  const del = (over: Partial<DeleteLike> & { kind: string }): DeleteLike => ({
    src: { path: '/lib/某剧/S01/loser.mkv', size: 700_000_000 },
    ...over,
  } as DeleteLike)

  it('四种删各自摊成「删哪份 / 留哪份」', () => {
    const out = projectReconcileStatus({
      counts: {},
      pending: [],
      plan: [
        { kind: 'move', src: { path: '/src/a.mkv', size: 1 }, dstDir: '/lib' } as DeleteLike,
        del({ kind: 'delete-dup', dupOf: '/lib/某剧/S01/keep.mkv', episode: '第 1 集' }),
        del({ kind: 'delete-loser', keptPath: '/lib/某剧/S01/2160p.mkv', episode: '第 2 集' }),
        del({ kind: 'delete-redundant', episode: '第 3 集' }),
        del({ kind: 'replace', oldPath: '/lib/某剧/S01/old.mkv', episode: '第 4 集' }),
      ],
    })
    expect(out.plannedDeletes).toEqual([
      { kind: 'delete-dup', path: '/lib/某剧/S01/loser.mkv', keptPath: '/lib/某剧/S01/keep.mkv', episode: '第 1 集', sizeBytes: 700_000_000 },
      { kind: 'delete-loser', path: '/lib/某剧/S01/loser.mkv', keptPath: '/lib/某剧/S01/2160p.mkv', episode: '第 2 集', sizeBytes: 700_000_000 },
      // 留下的不是另一个文件，是源站自己 → 没有 keptPath，这不是漏了。
      { kind: 'delete-redundant', path: '/lib/某剧/S01/loser.mkv', episode: '第 3 集', sizeBytes: 700_000_000 },
      // replace 反着来：消失的是 oldPath，src 是留下的新正主。抄反了模型核的就是另一件事。
      { kind: 'replace', path: '/lib/某剧/S01/old.mkv', keptPath: '/lib/某剧/S01/loser.mkv', episode: '第 4 集' },
    ])
    expect(out.plannedDeletesTruncated).toBe(false)
  })

  it('封顶 50 并自陈截断 —— 半份将删清单被当成全份，正是这条要防的', () => {
    const plan = Array.from({ length: 73 }, (_, i) =>
      del({ kind: 'delete-loser', src: { path: `/lib/x/${i}.mkv`, size: 1 }, keptPath: '/lib/x/keep.mkv' }),
    )
    const out = projectReconcileStatus({ counts: {}, pending: [], plan })
    expect((out.plannedDeletes as unknown[]).length).toBe(PLANNED_DELETES_MAX)
    expect(out.plannedDeletesTruncated).toBe(true)
  })

  it('compare 那一坨并排证据不许跟着漏进来（它是给面板的，一条就几百字节）', () => {
    const json = JSON.stringify(
      projectReconcileStatus({
        counts: {},
        pending: [],
        plan: [
          {
            kind: 'delete-loser',
            src: { path: '/lib/a.mkv', size: 1 },
            keptPath: '/lib/b.mkv',
            compare: { authorityDurationS: 2700, candidates: [{ path: '/lib/a.mkv', size: 1, inLib: true }] },
          } as unknown as DeleteLike,
        ],
      }),
    )
    expect(json).not.toContain('candidates')
    expect(json).not.toContain('authorityDurationS')
  })

  it('没传 plan（老调用方）→ 空清单，不炸；搬运不进这份清单', () => {
    const out = projectReconcileStatus(input([plainCard(1)]))
    expect(out.plannedDeletes).toEqual([])
    expect(out.plannedDeletesTruncated).toBe(false)
  })
})

describe('expandDir —— 展开一组，分页，逐条不再复制那句公共理由', () => {
  const rows = Array.from({ length: 491 }, (_, i) => suspectRow(i))

  it('第一页：带 total/offset/returned/hasMore', () => {
    const out = projectReconcileStatus(input(rows), { expandDir: DIR })
    expect(out.expanded).toMatchObject({ dir: DIR, total: 491, offset: 0, returned: 50, hasMore: true })
    expect((out.pending as unknown[]).length).toBe(50)
  })

  it('翻到末页 hasMore 变 false', () => {
    const out = projectReconcileStatus(input(rows), { expandDir: DIR, offset: 480, limit: 50 })
    expect(out.expanded).toMatchObject({ offset: 480, returned: 11, hasMore: false })
  })

  it('逐条只留自己那份 priorVerdict，公共那半句不再逐条复制', () => {
    const out = projectReconcileStatus(input(rows), { expandDir: DIR, limit: 2 })
    const row = (out.pending as Record<string, unknown>[])[0]
    expect(row.priorVerdict).toContain('delete:')
    expect(JSON.stringify(row)).not.toContain('目录疑似认领错误')
  })

  it('展开也过 limit 闸门（一次不许把 491 条全拿走）', () => {
    const out = projectReconcileStatus(input(rows), { expandDir: DIR, limit: 9999 })
    expect((out.pending as unknown[]).length).toBe(RECONCILE_PAGE_MAX)
  })

  it('目录名不对 → 报错并列出真有的那几个，不静默回空', () => {
    expect(() => projectReconcileStatus(input(rows), { expandDir: '/打错的' })).toThrow(/不是本次的熔断目录.*凹凸电波/s)
  })

  it('本次没有熔断目录时也说清楚', () => {
    expect(() => projectReconcileStatus(input([plainCard(1)]), { expandDir: '/x' })).toThrow(/本次没有熔断目录/)
  })
})

describe('clampLimit', () => {
  it('缺省 / 非法值 → 默认档', () => {
    expect(clampLimit(undefined)).toBe(RECONCILE_PAGE_DEFAULT)
    expect(clampLimit('50')).toBe(RECONCILE_PAGE_DEFAULT)
    expect(clampLimit(Number.NaN)).toBe(RECONCILE_PAGE_DEFAULT)
  })
  it('上下界都夹住', () => {
    expect(clampLimit(0)).toBe(1)
    expect(clampLimit(-5)).toBe(1)
    expect(clampLimit(10_000)).toBe(RECONCILE_PAGE_MAX)
    expect(clampLimit(10)).toBe(10)
  })
})

describe('plannedDeletes 的四个标量 —— 「留下的那份多大/多长」不再是一份拿不到的数据', () => {
  const compare = (gone: string, kept: string) => ({
    authorityDurationS: 4742,
    candidates: [
      { path: gone, size: 1_390_000_000, durationS: 4742, inLib: false },
      { path: kept, size: 3_160_000_000, durationS: 4742, inLib: true },
    ],
  })

  it('delete-loser 带 compare → 两侧体积 + 两侧时长 + basis 四个字段齐', () => {
    const out = projectReconcileStatus({
      counts: {},
      pending: [],
      plan: [
        {
          kind: 'delete-loser',
          src: { path: '/lib/x/loser.mkv', size: 1_390_000_000 },
          keptPath: '/lib/x/keep.mkv',
          episode: '第 1 期',
          basis: 'quality-loser-of:/lib/x/keep.mkv',
          compare: compare('/lib/x/loser.mkv', '/lib/x/keep.mkv'),
        } as unknown as DeleteLike,
      ],
    })
    expect((out.plannedDeletes as unknown[])[0]).toEqual({
      kind: 'delete-loser',
      path: '/lib/x/loser.mkv',
      keptPath: '/lib/x/keep.mkv',
      episode: '第 1 期',
      sizeBytes: 1_390_000_000,
      durationS: 4742,
      keptSizeBytes: 3_160_000_000,
      keptDurationS: 4742,
      basis: 'quality-loser-of:/lib/x/keep.mkv',
    })
  })

  it('replace 方向不许反：消失的是 oldPath，kept* 才是 src 那份', () => {
    const out = projectReconcileStatus({
      counts: {},
      pending: [],
      plan: [
        {
          kind: 'replace',
          src: { path: '/lib/x/new.mkv', size: 5_200_000_000 },
          oldPath: '/lib/x/old.mkv',
          dstDir: '/lib/x',
          basis: 'quality-upgrade:/lib/x/old.mkv',
          compare: {
            candidates: [
              { path: '/lib/x/new.mkv', size: 5_200_000_000, durationS: 3050, inLib: false },
              { path: '/lib/x/old.mkv', size: 1_900_000_000, durationS: 3050, inLib: true },
            ],
          },
        } as unknown as DeleteLike,
      ],
    })
    expect((out.plannedDeletes as unknown[])[0]).toEqual({
      kind: 'replace',
      path: '/lib/x/old.mkv',
      keptPath: '/lib/x/new.mkv',
      sizeBytes: 1_900_000_000,
      durationS: 3050,
      keptSizeBytes: 5_200_000_000,
      keptDurationS: 3050,
      basis: 'quality-upgrade:/lib/x/old.mkv',
    })
  })

  it('没有 compare → 缺席这几个字段，不编 0', () => {
    const out = projectReconcileStatus({
      counts: {},
      pending: [],
      plan: [
        { kind: 'delete-loser', src: { path: '/lib/x/a.mkv', size: 7 }, keptPath: '/lib/x/b.mkv' } as unknown as DeleteLike,
      ],
    })
    const row = (out.plannedDeletes as Record<string, unknown>[])[0]
    expect(row).toEqual({ kind: 'delete-loser', path: '/lib/x/a.mkv', keptPath: '/lib/x/b.mkv', sizeBytes: 7 })
    for (const k of ['durationS', 'keptSizeBytes', 'keptDurationS', 'basis']) expect(k in row).toBe(false)
  })
})

describe('将删清单可翻页 —— deletesOffset 是独立游标，不和 expandDir 那档共用', () => {
  const many = (n: number): DeleteLike[] =>
    Array.from({ length: n }, (_, i) =>
      ({ kind: 'delete-loser', src: { path: `/lib/x/${i}.mkv`, size: 1 }, keptPath: '/lib/x/keep.mkv' }) as unknown as DeleteLike,
    )

  it('60 条、deletesOffset:50 → 回 10 条，总数 60，没有下一页', () => {
    const out = projectReconcileStatus({ counts: {}, pending: [], plan: many(60) }, { deletesOffset: 50 })
    expect((out.plannedDeletes as unknown[]).length).toBe(10)
    expect(out.plannedDeletesTotal).toBe(60)
    expect(out.plannedDeletesOffset).toBe(50)
    expect(out.plannedDeletesTruncated).toBe(false)
  })

  it('第一页仍然封顶 50 且自陈还有下一页', () => {
    const out = projectReconcileStatus({ counts: {}, pending: [], plan: many(60) })
    expect((out.plannedDeletes as unknown[]).length).toBe(PLANNED_DELETES_MAX)
    expect(out.plannedDeletesOffset).toBe(0)
    expect(out.plannedDeletesTotal).toBe(60)
    expect(out.plannedDeletesTruncated).toBe(true)
  })

  it('offset 归 expandDir 那一档，翻不动将删清单', () => {
    const out = projectReconcileStatus({ counts: {}, pending: [], plan: many(60) }, { offset: 50 })
    expect((out.plannedDeletes as Record<string, unknown>[])[0].path).toBe('/lib/x/0.mkv')
  })
})

describe('planFingerprint —— 预览与执行之间那道闸', () => {
  const plan = [
    { kind: 'move', src: { path: '/src/a.mkv' }, dstDir: '/lib/S01' },
    { kind: 'delete-loser', src: { path: '/lib/x/a.mkv' }, keptPath: '/lib/x/b.mkv' },
    { kind: 'rename', src: { path: '/lib/x/b.mkv' }, newName: 'S01E01 - b.mkv' },
  ] as unknown as DeleteLike[]

  it('同一份 plan 两次哈希相等，且是 16 位', () => {
    const a = planFingerprint(plan)
    expect(a).toBe(planFingerprint(plan))
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  it('改一条路径就变', () => {
    const other = [...plan]
    other[1] = { kind: 'delete-loser', src: { path: '/lib/x/a.mkv' }, keptPath: '/lib/x/c.mkv' } as unknown as DeleteLike
    expect(planFingerprint(other)).not.toBe(planFingerprint(plan))
  })

  it('动作顺序变了不算变 —— 指纹认的是集合', () => {
    expect(planFingerprint([...plan].reverse())).toBe(planFingerprint(plan))
  })
})

describe('runReconcileExecute —— 指纹对不上就一步都不许走', () => {
  const plan = [{ kind: 'delete-loser', src: { path: '/lib/x/a.mkv' }, keptPath: '/lib/x/b.mkv' }] as unknown as DeleteLike[]

  it('指纹对不上 → 抛，且执行器零调用', async () => {
    let executed = 0
    await expect(
      runReconcileExecute(
        { previewPlan: async () => plan, execute: async () => void (executed += 1) },
        'deadbeefdeadbeef',
      ),
    ).rejects.toThrow(/plan changed since preview \(expected deadbeefdeadbeef, now [0-9a-f]{16}\) — run reconcile_status again/)
    expect(executed).toBe(0)
  })

  it('指纹对得上 → 照常执行', async () => {
    let executed = 0
    const res = await runReconcileExecute(
      { previewPlan: async () => plan, execute: async () => (executed += 1) },
      planFingerprint(plan),
    )
    expect(res).toBe(1)
    expect(executed).toBe(1)
  })

  it('不传指纹 → 照旧执行，且不白跑一次 preview', async () => {
    let previews = 0
    const res = await runReconcileExecute({
      previewPlan: async () => {
        previews += 1
        return plan
      },
      execute: async () => 'ok',
    })
    expect(res).toBe('ok')
    expect(previews).toBe(0)
  })
})

function fakeSink() {
  const calls: unknown[][] = []
  const sink: ReconcileDecisionSink = {
    setPreferred: (k, l, p) => void calls.push(['setPreferred', k, l, p]),
    setIsEpisode: (k, p, v) => void calls.push(['setIsEpisode', k, p, v]),
    setNotEpisode: (k, p) => void calls.push(['setNotEpisode', k, p]),
  }
  return { sink, calls }
}

describe('applyReconcileDecisions —— 批量落，一条坏的不放倒整批', () => {
  it('一次落 28 条，只走一个来回', () => {
    const { sink, calls } = fakeSink()
    const decisions = Array.from({ length: 28 }, (_, i) => ({ verdict: 'not-episode' as const, leftKey: `k${i}`, path: `/p${i}` }))
    expect(applyReconcileDecisions(sink, { decisions })).toEqual({ ok: true, decided: 28, failed: 0 })
    expect(calls).toHaveLength(28)
  })

  it('三种 verdict 各自落到对的原语上', () => {
    const { sink, calls } = fakeSink()
    applyReconcileDecisions(sink, {
      decisions: [
        { verdict: 'is-episode', leftKey: 'a', path: '/1' },
        { verdict: 'not-episode', leftKey: 'b', path: '/2' },
        { verdict: null, leftKey: 'c', path: '/3' },
        { verdict: 'prefer', keptPath: '/keep', loserPath: '/lose' },
      ],
    })
    expect(calls).toEqual([
      ['setIsEpisode', 'a', '/1', undefined],
      ['setNotEpisode', 'b', '/2'],
      ['setIsEpisode', 'c', '/3', false],
      ['setPreferred', '/keep', '/lose', true],
    ])
  })

  it('坏的那条被打回（带 index + 目标），好的那些照落', () => {
    const { sink, calls } = fakeSink()
    const res = applyReconcileDecisions(sink, {
      decisions: [
        { verdict: 'not-episode', leftKey: 'a', path: '/good' },
        { verdict: 'not-episode', path: '/缺了leftKey' },
        { verdict: 'prefer', leftKey: 'c', path: '/verdict配错了' },
        { verdict: 'is-episode', leftKey: 'd', path: '/good2' },
      ],
    })
    expect(res.ok).toBe(false)
    expect(res.decided).toBe(2)
    expect(res.failed).toBe(2)
    expect(res.errors!.map((e) => [e.index, e.target])).toEqual([
      [1, '/缺了leftKey'],
      [2, '/verdict配错了'],
    ])
    expect(calls).toHaveLength(2)
  })

  it('单条写法（字段摊在顶层）还受理——它就是 1 元素的批', () => {
    const { sink, calls } = fakeSink()
    expect(applyReconcileDecisions(sink, { verdict: 'is-episode', leftKey: 'a', path: '/1' })).toEqual({ ok: true, decided: 1, failed: 0 })
    expect(calls).toEqual([['setIsEpisode', 'a', '/1', undefined]])
  })

  it('decisions 空数组 → 回落到顶层那条，不是静默什么都不做', () => {
    const { sink, calls } = fakeSink()
    applyReconcileDecisions(sink, { decisions: [], verdict: 'not-episode', leftKey: 'a', path: '/1' })
    expect(calls).toEqual([['setNotEpisode', 'a', '/1']])
  })
})

describe('resolveReconcileRef —— show 还是绑定', () => {
  const deps = { hasShow: (r: string) => r === 'aotu' || r === '凹凸电波', hasBinding: (r: string) => r === 'set-7' }

  it('binding: 前缀说得最清楚，直接走绑定（存不存在由 showForBinding 去抛）', () => {
    expect(resolveReconcileRef('binding:set-7', deps)).toEqual({ kind: 'binding', id: 'set-7' })
    expect(resolveReconcileRef('binding:不存在', deps)).toEqual({ kind: 'binding', id: '不存在' })
  })

  it('裸串先问 show —— 播客那条既有路径一个字不变', () => {
    expect(resolveReconcileRef('aotu', deps)).toEqual({ kind: 'show', id: 'aotu' })
    expect(resolveReconcileRef('凹凸电波', deps)).toEqual({ kind: 'show', id: '凹凸电波' })
  })

  it('show 那侧不认、而它是一条绑定 → 走绑定。影视绑定没有 show 配置，这是它唯一够得着的入口', () => {
    expect(resolveReconcileRef('set-7', deps)).toEqual({ kind: 'binding', id: 'set-7' })
  })

  it('两侧都不认仍当 show —— 好让报错是 showOrThrow 那句带「现有 show 有哪些」的', () => {
    expect(resolveReconcileRef('谁也不是', deps)).toEqual({ kind: 'show', id: '谁也不是' })
  })

  it('同名时 show 优先：一个串同时指得到 show 和绑定，不许把播客那条悄悄改道', () => {
    expect(resolveReconcileRef('both', { hasShow: () => true, hasBinding: () => true })).toEqual({ kind: 'show', id: 'both' })
  })
})
