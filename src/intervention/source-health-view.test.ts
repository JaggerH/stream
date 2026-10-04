import { describe, it, expect } from 'vitest'
import { classifySource, stepDiff, pendingPermissionOf, SourceHealthIndex, type SourceHealthDeps } from './source-health-view.ts'
import type { RunRecord, RunEvent } from './types.ts'
import type { SourceManifest } from '../manifest/types.ts'

const usage = { promptTokens: 0, completionTokens: 0, turns: 0, wallMs: 0, reported: false }
const run = (over: Partial<RunRecord>): RunRecord => ({
  id: 'r1', kind: 'repair', sourceId: 'xhs-home', status: 'running', usage, startedAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:01Z', lastSeq: 0, ...over,
})
const ev = (seq: number, kind: RunEvent['kind'], title: string, data?: unknown): RunEvent => ({ seq, runId: 'r1', kind, at: 'x', title, ...(data !== undefined ? { data } : {}) })
const manifest = (id: string, uses?: string[]): SourceManifest =>
  ({ id, title: id.toUpperCase(), adapter: 'replay', auth: { type: 'none' }, params_schema: {}, ...(uses ? { uses } : {}) }) as unknown as SourceManifest
/** 模拟真实 Registry：全名精确命中，裸局部名也认（局部名不含 `/`，取最后一段比对）。 */
const resolvingManifestOf = (pool: SourceManifest[]) => (id: string): SourceManifest | undefined =>
  pool.find((m) => m.id === id || m.id.slice(m.id.lastIndexOf('/') + 1) === id)

describe('classifySource：十个词按序取第一个命中', () => {
  it('活跃 run 等人 → awaiting；在跑 → repairing', () => {
    expect(classifySource({ run: run({ status: 'awaiting_confirmation' }), pendingProposal: false })).toBe('awaiting')
    expect(classifySource({ run: run({ status: 'paused' }), pendingProposal: false })).toBe('awaiting')
    expect(classifySource({ run: run({ status: 'rate_limited' }), pendingProposal: false })).toBe('repairing')
  })
  it('在跑的探索 run → exploring；等人那一档仍是 awaiting（人要点的是同一颗按钮）', () => {
    expect(classifySource({ run: run({ kind: 'explore', status: 'running' }), pendingProposal: false })).toBe('exploring')
    expect(classifySource({ run: run({ kind: 'explore', status: 'paused' }), pendingProposal: false })).toBe('awaiting')
  })
  it('有待写回提议 → proposed（哪怕源仍被关禁）', () => {
    expect(classifySource({ run: run({ status: 'done' }), pendingProposal: true, ledger: { status: 'quarantined', consecutiveDrift: 3, attempts: 0, recipeVersion: 1 } })).toBe('proposed')
  })
  it('关禁 + 最近 run 判修不了 → unrepairable；只关禁 → quarantined', () => {
    const ledger = { status: 'quarantined' as const, consecutiveDrift: 3, attempts: 0, recipeVersion: 1 }
    expect(classifySource({ run: run({ status: 'stopped', stopped: { produced: 'verdict-unrepairable', reason: 'end_turn' } }), pendingProposal: false, ledger })).toBe('unrepairable')
    expect(classifySource({ pendingProposal: false, ledger })).toBe('quarantined')
    expect(classifySource({ pendingProposal: false, ledger: { ...ledger, status: 'failed' } })).toBe('quarantined')
  })
  it('修不了不要求关禁态：只要此刻仍不健康（如 dead）+ 最近 run 判了修不了 → unrepairable；人已修好（此刻健康）→ ok', () => {
    const unrepairableRun = run({ status: 'stopped', stopped: { produced: 'verdict-unrepairable', reason: 'end_turn' } })
    const dead = { state: 'dead' as const, lifetimeItemCount: 1, consecutiveEmpty: 0, consecutiveError: 2, lastOutcome: 'error' as const, lastAt: 'x' }
    expect(classifySource({ run: unrepairableRun, pendingProposal: false, health: dead })).toBe('unrepairable')
    expect(classifySource({ run: unrepairableRun, pendingProposal: false, health: { ...dead, state: 'healthy', lastOutcome: 'ok' } })).toBe('ok')
  })
  it('掉登录 / 异常 / 变差 / 正常', () => {
    const h = { state: 'dead' as const, lifetimeItemCount: 1, consecutiveEmpty: 0, consecutiveError: 2, lastOutcome: 'error' as const, lastAt: 'x' }
    expect(classifySource({ pendingProposal: false, health: { ...h, lastErrorCategory: 'auth' } })).toBe('auth')
    expect(classifySource({ pendingProposal: false, health: h })).toBe('dead')
    expect(classifySource({ pendingProposal: false, health: { ...h, state: 'degraded' } })).toBe('degraded')
    expect(classifySource({ pendingProposal: false })).toBe('ok')
  })
})

describe('stepDiff：步骤级', () => {
  it('改字段 / 加步 / 删步 / 顶层字段记成第 0 步；steps 与 V1 actions 都认', () => {
    const before = { version: 3, session: { url: 'https://a' }, steps: [{ do: 'goto', url: 'x' }, { do: 'click', selector: '.old' }, { do: 'wait' }] }
    const after = { version: 4, session: { url: 'https://b' }, steps: [{ do: 'goto', url: 'x' }, { do: 'click', selector: '.new' }] }
    expect(stepDiff(before, after)).toEqual([
      { step: 0, kind: 'changed', field: 'session', before: { url: 'https://a' }, after: { url: 'https://b' } },
      { step: 2, kind: 'changed', field: 'selector', before: '.old', after: '.new' },
      { step: 3, kind: 'removed', before: { do: 'wait' } },
    ])
    expect(stepDiff({ actions: [] }, { actions: [{ do: 'x' }] })).toEqual([{ step: 1, kind: 'added', after: { do: 'x' } }])
  })
  it('version 字段不算改动（+1 是规则不是变化）；没差就是空', () => {
    expect(stepDiff({ version: 1, steps: [] }, { version: 2, steps: [] })).toEqual([])
  })
})

describe('pendingPermissionOf：只挑 seq 最小那条未答的', () => {
  it('两条未答取第一条；答过的不算；auto:true 的不算', () => {
    const events = [
      ev(1, 'permission_requested', 'a', { auto: true, why: 'w' }),
      ev(2, 'permission_requested', 'b：等你点头', { auto: false, permissionId: 'p2', why: '要点击', options: [{ optionId: 'y', name: '允许', kind: 'allow_once' }], toolCall: { title: '点击登录' } }),
      ev(3, 'permission_requested', 'c', { auto: false, permissionId: 'p3', why: 'w3', options: [] }),
      ev(4, 'permission_answered', 'x', { auto: false, permissionId: 'p2', optionId: 'y' }),
    ]
    expect(pendingPermissionOf(events)).toMatchObject({ permissionId: 'p3', title: 'c' })
    expect(pendingPermissionOf(events.slice(0, 3))).toMatchObject({ permissionId: 'p2', title: '点击登录', reason: '要点击' })
    expect(pendingPermissionOf([events[0]!])).toBeUndefined()
  })
})

describe('SourceHealthIndex', () => {
  const home = manifest('@s/xhs/xhs-home', ['@s/xhs/xhs-detail'])
  const detail = manifest('@s/xhs/xhs-detail')
  const deps = (over: Partial<SourceHealthDeps> = {}): SourceHealthDeps => ({
    manifest: (id) => [home, detail].find((m) => m.id === id),
    health: () => undefined,
    healthIds: () => [],
    ledger: (id) => (id === detail.id ? { status: 'quarantined', consecutiveDrift: 3, attempts: 0, recipeVersion: 2, lastReason: '第 2 步 expect 落空', lastAt: 't', affectedSources: [detail.id, home.id] } : undefined),
    ledgerIds: () => [detail.id],
    runs: () => [],
    runSourceIds: () => [],
    events: () => [],
    proposals: () => [],
    channels: () => [{ id: 'c1', label: '小红书', stream_ids: ['s1'] }, { id: 'c2', label: '别的', stream_ids: ['s2'] }] as never,
    streams: () => [{ id: 's1', sources: [{ source_id: home.id, params: {} }] }, { id: 's2', sources: [{ source_id: 'other', params: {} }] }] as never,
    currentRecipe: () => undefined,
    limits: () => undefined,
    ...over,
  })

  it('关禁账里的源：状态词 quarantined，连累频道经 affectedSources → stream → channel 反查', () => {
    const v = new SourceHealthIndex(deps()).one(detail.id)!
    expect(v.status).toBe('quarantined')
    expect(v.source.title).toBe(detail.id.toUpperCase())
    expect(v.quarantine).toMatchObject({ reason: '第 2 步 expect 落空', recipeVersion: 2, affectedSources: [detail.id, home.id] })
    expect(v.affectedChannels).toEqual([{ id: 'c1', label: '小红书' }])
  })

  it('unhealthy() 只列非 ok；健康且无账的源不在；不认识的 id one() 回 undefined', () => {
    const idx = new SourceHealthIndex(deps({ healthIds: () => [home.id], health: (id) => (id === home.id ? { state: 'healthy', lifetimeItemCount: 3, consecutiveEmpty: 0, consecutiveError: 0, lastOutcome: 'ok', lastAt: 't' } : undefined) }))
    expect(idx.unhealthy().map((v) => v.source.id)).toEqual([detail.id])
    expect(idx.one('nope')).toBeUndefined()
    expect(idx.one(home.id)?.status).toBe('ok')
  })

  it('活跃 run + 未答许可 → awaiting，run.pending 是那条许可，run.now 是最新一条 tool_call 标题；限额随 run 给', () => {
    const r = run({ sourceId: detail.id, status: 'awaiting_confirmation' })
    const idx = new SourceHealthIndex(deps({
      runs: (id) => (id === detail.id ? [r] : []),
      runSourceIds: () => [detail.id],
      events: () => [ev(1, 'tool_call', '看截图'), ev(2, 'permission_requested', 'p', { auto: false, permissionId: 'p1', why: '要点', options: [{ optionId: 'a', name: '允许', kind: 'allow_once' }], toolCall: { title: '点击' } })],
      limits: () => ({ maxTurns: 12, maxTokens: 1_500_000, maxWallMinutes: 30 }),
    }))
    const v = idx.one(detail.id)!
    expect(v.status).toBe('awaiting')
    expect(v.run).toMatchObject({ id: 'r1', now: '看截图', pending: { permissionId: 'p1', title: '点击' }, limits: { maxTurns: 12 } })
  })

  it('run.now 不算 stderr / 协议帧那条 message：有 tool_call 时取 tool_call，只有 stderr 时 now 为 undefined', () => {
    const r = run({ sourceId: detail.id, status: 'running' })
    const withToolCall = new SourceHealthIndex(deps({
      runs: (id) => (id === detail.id ? [r] : []),
      runSourceIds: () => [detail.id],
      events: () => [
        ev(1, 'tool_call', '看截图'),
        ev(2, 'message', '[session/create] sessionId=… phase=register …', { stream: 'stderr' }),
      ],
    }))
    expect(withToolCall.one(detail.id)!.run).toMatchObject({ now: '看截图' })

    const onlyStderr = new SourceHealthIndex(deps({
      runs: (id) => (id === detail.id ? [r] : []),
      runSourceIds: () => [detail.id],
      events: () => [ev(1, 'message', '[session/create] sessionId=… phase=register …', { stream: 'stderr' })],
    }))
    expect(onlyStderr.one(detail.id)!.run?.now).toBeUndefined()
  })

  it('run.verdict：agent 判修不了时带上它写的理由；解不出（如直接拒绝）就缺席', () => {
    const withReason = run({ sourceId: detail.id, status: 'stopped', stopped: { produced: 'verdict-unrepairable', reason: 'end_turn' } })
    const idxWithReason = new SourceHealthIndex(deps({
      runs: (id) => (id === detail.id ? [withReason] : []),
      runSourceIds: () => [detail.id],
      events: () => [ev(1, 'message', '分析完了。UNREPAIRABLE: 站点要求登录，游客态看不到搜索结果', { role: 'agent' })],
    }))
    expect(idxWithReason.one(detail.id)!.run?.verdict).toBe('站点要求登录，游客态看不到搜索结果')

    const refused = run({ sourceId: detail.id, status: 'stopped', stopped: { produced: 'verdict-unrepairable', reason: 'end_turn' } })
    const idxRefused = new SourceHealthIndex(deps({
      runs: (id) => (id === detail.id ? [refused] : []),
      runSourceIds: () => [detail.id],
      events: () => [ev(1, 'message', 'agent 拒绝了这个任务')],
    }))
    expect(idxRefused.one(detail.id)!.run?.verdict).toBeUndefined()
  })

  it('待写回提议带步骤级 diff（对着磁盘上现行 recipe 算）', () => {
    const before = { version: 2, steps: [{ do: 'click', selector: '.a' }] }
    const idx = new SourceHealthIndex(deps({
      currentRecipe: (id) => (id === detail.id ? before : undefined),
      proposals: (id) => (id === detail.id ? [{ id: 'p', runId: 'r1', sourceId: detail.id, kind: 'recipe', rationale: 'x', status: 'pending', createdAt: 't', recipePath: '/p/xhs-detail.recipe.json', recipe: { version: 3, steps: [{ do: 'click', selector: '.b' }] }, validation: { schema: 'ok', version: 'ok', assertions: 'ok', probe: 'skipped-no-executor' } }] : []),
    }))
    const v = idx.one(detail.id)!
    expect(v.status).toBe('proposed')
    expect(v.proposal).toMatchObject({ id: 'p', diff: [{ step: 1, kind: 'changed', field: 'selector', before: '.a', after: '.b' }] })
  })

  it('探索中的源：状态词 exploring，exploration 格从草稿读；repair 在跑时 repair 优先', () => {
    const exploreRun = run({ id: 'e1', kind: 'explore', sourceId: detail.id, status: 'running' })
    const draft = { runId: 'e1', states: [{ id: 'xhs/a' }, { id: 'xhs/b' }], transitions: [{ from: 'xhs/a', to: 'xhs/b' }], remaining: { 'xhs/a': 0, 'xhs/b': 3 } }
    const exploring = new SourceHealthIndex(deps({
      runs: (id) => (id === detail.id ? [exploreRun] : []),
      runSourceIds: () => [detail.id],
      draftFor: (sourceId, runId) => (sourceId === detail.id && runId === 'e1' ? (draft as never) : undefined),
    })).one(detail.id)!
    expect(exploring.status).toBe('exploring')
    expect(exploring.run?.id).toBe('e1')
    expect(exploring.exploration).toEqual({ runId: 'e1', status: 'running', states: 2, transitions: 1, remaining: 3 })

    // 同一个源上 repair 也在跑：run 那一格归 repair（修复是人要盯的那条），状态词回 repairing
    const both = new SourceHealthIndex(deps({
      runs: (id) => (id === detail.id ? [exploreRun, run({ id: 'r9', sourceId: detail.id, status: 'running' })] : []),
      runSourceIds: () => [detail.id],
      draftFor: () => draft as never,
    })).one(detail.id)!
    expect(both.status).toBe('repairing')
    expect(both.run?.id).toBe('r9')
    expect(both.exploration?.runId).toBe('e1')   // 探索仍在跑，那一格照给
  })

  /** 探索已收尾 → 不该再报 exploring，也不该再给 exploration 格（草稿是「正在探」的现场）。 */
  it('探索终态：状态词不再是 exploring，exploration 缺席', () => {
    const done = run({ id: 'e1', kind: 'explore', sourceId: detail.id, status: 'done' })
    const v = new SourceHealthIndex(deps({
      runs: (id) => (id === detail.id ? [done] : []),
      runSourceIds: () => [detail.id],
      draftFor: () => ({ runId: 'e1', states: [], transitions: [], remaining: {} }) as never,
    })).one(detail.id)!
    expect(v.status).toBe('quarantined')
    expect(v.exploration).toBeUndefined()
  })

  /**
   * 探完之后源往往是**健康**的（它本来就没坏，人只是想建图）：三本账里没有一条记着它，
   * 状态词只能靠这条 pending graph 提议撑到 `proposed`——漏了它整行就从 `unhealthy()` 里消失，
   * 而第 ④ 格「并进状态图」正等着人从那儿进去点。
   */
  it('健康源 + pending graph 提议 → proposed，且整行仍在 unhealthy() 里；proposal 带 graph 计数、validation 四格 n/a、diff 空', () => {
    const graphProposal = {
      id: 'gp', runId: 'e1', sourceId: home.id, facility: 'xhs', kind: 'graph', rationale: '探完了', status: 'pending', createdAt: 't',
      draft: { states: [{ id: 'xhs/a' }, { id: 'xhs/b' }, { id: 'xhs/c' }], transitions: [{ from: 'xhs/a', to: 'xhs/b' }, { from: 'xhs/b', to: 'xhs/c' }] },
    }
    const idx = new SourceHealthIndex(deps({
      manifest: (id) => [home, detail].find((m) => m.id === id),
      health: (id) => (id === home.id ? { state: 'healthy', lifetimeItemCount: 9, consecutiveEmpty: 0, consecutiveError: 0, lastOutcome: 'ok', lastAt: 't' } : undefined),
      healthIds: () => [home.id],
      ledger: () => undefined,
      ledgerIds: () => [],
      proposals: (id) => (id === home.id ? [graphProposal as never] : []),
    }))
    const v = idx.one(home.id)!
    expect(v.status).toBe('proposed')
    expect(v.proposal).toMatchObject({ id: 'gp', kind: 'graph', graph: { states: 3, transitions: 2 } })
    expect(v.proposal!.diff).toEqual([])
    expect(v.proposal!.validation).toEqual({ schema: 'n/a', version: 'n/a', assertions: 'n/a', probe: 'n/a' })
    expect(idx.unhealthy().map((x) => x.source.id)).toContain(home.id)
  })

  /** 运行期一问一答那几类（state / discriminator / …）在提议列表里审，不该占源健康的第 ④ 格。 */
  it('只有 state 类提议 → 不进 proposal 格，状态词也不因它变 proposed', () => {
    const v = new SourceHealthIndex(deps({
      proposals: (id) => (id === detail.id ? [{ id: 's1', runId: 'r1', sourceId: detail.id, kind: 'state', rationale: 'x', status: 'pending', createdAt: 't' } as never] : []),
    })).one(detail.id)!
    expect(v.proposal).toBeUndefined()
    expect(v.status).toBe('quarantined')
  })

  it('proposal 格带 kind：前端靠它区分 recipe / graph', () => {
    const v = new SourceHealthIndex(deps({
      proposals: (id) => (id === detail.id ? [{ id: 'p', runId: 'r1', sourceId: detail.id, kind: 'recipe', rationale: 'x', status: 'pending', createdAt: 't', recipePath: '/p/x.recipe.json', recipe: { version: 2 } }] : []),
    })).one(detail.id)!
    expect(v.proposal).toMatchObject({ id: 'p', kind: 'recipe' })
  })

  describe('id 归一：全名/裸名分裂写入的三本账，只出一行', () => {
    const btbtla = manifest('@streamapp/btbtla/btbtla-search')
    const health: import('../source-health-store.ts').SourceHealth = { state: 'degraded', lifetimeItemCount: 2, consecutiveEmpty: 1, consecutiveError: 0, lastOutcome: 'empty', lastAt: 't-health', lastError: '连续空手' }
    const ledger: import('../replay/repair-ledger.ts').RepairState = { status: 'quarantined', consecutiveDrift: 3, attempts: 1, recipeVersion: 2, lastReason: 'drift', lastAt: 't-ledger', affectedSources: ['btbtla-search'] }
    const splitDeps = (over: Partial<SourceHealthDeps> = {}): SourceHealthDeps =>
      deps({
        manifest: resolvingManifestOf([home, detail, btbtla]),
        // 健康账按全名记
        health: (id) => (id === btbtla.id ? health : undefined),
        healthIds: () => [btbtla.id],
        // 关禁账按裸名记（真实 RepairLedger 的行为）
        ledger: (id) => (id === 'btbtla-search' ? ledger : undefined),
        ledgerIds: () => ['btbtla-search'],
        channels: () => [],
        streams: () => [],
        ...over,
      })

    it('unhealthy()：同一个源健康账用全名、关禁账用裸名 → 只回一行，且同时带 health.lastError 与 quarantine', () => {
      const rows = new SourceHealthIndex(splitDeps()).unhealthy()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.source.id).toBe(btbtla.id)
      expect(rows[0]!.health.lastError).toBe('连续空手')
      expect(rows[0]!.quarantine).toMatchObject({ reason: 'drift', recipeVersion: 2 })
    })

    it('one()：裸名与全名查同一个源，回同一份视图（source.id 都是全名）', () => {
      const idx = new SourceHealthIndex(splitDeps())
      const byBare = idx.one('btbtla-search')!
      const byFull = idx.one(btbtla.id)!
      expect(byBare.source.id).toBe(btbtla.id)
      expect(byFull.source.id).toBe(btbtla.id)
      expect(byBare).toEqual(byFull)
      expect(byBare.health.lastError).toBe('连续空手')
      expect(byBare.quarantine).toBeDefined()
    })

    it('one()：注册表解不出的裸名仍按原样查、不崩，回 fallbackSource', () => {
      const idx = new SourceHealthIndex(deps({
        manifest: () => undefined,
        health: (id) => (id === 'ghost-source' ? { state: 'dead', lifetimeItemCount: 0, consecutiveEmpty: 0, consecutiveError: 5, lastOutcome: 'error', lastAt: 't' } : undefined),
        healthIds: () => ['ghost-source'],
        ledgerIds: () => [],
        channels: () => [],
        streams: () => [],
      }))
      const v = idx.one('ghost-source')
      expect(v).toBeDefined()
      expect(v!.source.id).toBe('ghost-source')
      expect(v!.status).toBe('dead')
    })
  })
})
