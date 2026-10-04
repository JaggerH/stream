import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountInterventionRoutes } from './intervention-routes.ts'
import { InterventionRunStore } from '../intervention/run-store.ts'
import { StateGraphStore } from '../replay/state-graph-store.ts'
import { DEFAULT_EXPLORE_LIMITS } from '../intervention/explore-session.ts'
import type { StateGraph } from '../replay/state-graph.ts'

/**
 * 一份**真的过得了 `validateRecipe`** 的 `kind:'http'` recipe（与 `src/intervention/recipe-validation.test.ts`
 * 同一份夹具）：http 的 items 档要求 `request` / `pagination.mode` / `assert` / `mapping` 四件都在。
 */
const validHttpRecipe = {
  version: 1,
  kind: 'http',
  sourceId: 'demo',
  request: { url: 'https://a.example/api', method: 'GET' },
  pagination: { mode: 'increment', param: 'page', start: 1, step: 1, itemsAt: 'items', maxPages: 1 },
  assert: [{ path: 'items', desc: 'items' }],
  mapping: { guid: 'id', title: 'title' },
  meta: { type: 'post', description: 'd', normalizer: 'generic' },
}

const authored: StateGraph = { states: [{ id: 'xhs/home', features: [{ kind: 'url', pattern: 'https://www.xiaohongshu.com/explore*' }] }], transitions: [] }
const setup = () => {
  const app = new Hono()
  const store = new InterventionRunStore(':memory:')
  const graphs = new StateGraphStore(mkdtempSync(join(tmpdir(), 'sg-')), (f) => (f === 'xhs' ? authored : undefined))
  mountInterventionRoutes(app, { store, graphs })
  return { app, store, graphs }
}
const post = (app: Hono, path: string, body?: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
const mkState = (store: InterventionRunStore, over: Partial<{ stateId: string; kind: 'state' | 'discriminator' | 'transition' }> = {}) => {
  const r = store.create({ kind: 'runtime-ask', sourceId: 'xhs-search', question: over.kind ?? 'state' })
  return store.addProposal({
    runId: r.id, sourceId: 'xhs-search', facility: 'xhs', kind: over.kind ?? 'state', rationale: '有笔记卡',
    features: [{ kind: 'dom', selector: '.note' }], stateId: over.stateId ?? 'xhs/results', status: 'pending',
  })
}

describe('intervention routes', () => {
  it('列表带 pending 计数；详情带提议；事件读口按 since；不存在 404', async () => {
    const { app, store } = setup()
    const p = mkState(store)
    store.appendEvent(p.runId, { kind: 'message', title: 'a' })
    store.appendEvent(p.runId, { kind: 'message', title: 'b' })
    const list = await (await app.request('/api/interventions')).json() as { runs: unknown[]; pending: number }
    expect(list.runs).toHaveLength(1)
    expect(list.pending).toBe(1)
    const detail = await (await app.request(`/api/interventions/${p.runId}`)).json() as { proposals: unknown[] }
    expect(detail.proposals).toHaveLength(1)
    const ev = await (await app.request(`/api/interventions/${p.runId}/events?since=1`)).json() as { events: { seq: number }[] }
    expect(ev.events.map((e) => e.seq)).toEqual([2])
    const notFound = await app.request('/api/interventions/nope')
    expect(notFound.status).toBe(404)
    expect(((await notFound.json()) as { error: { code: string } }).error.code).toBe('not-found')
  })

  it('按 source 过滤时全名与裸名都认：运行时一问记的是裸名，修复页拿全名来问历史也得看见它', async () => {
    const { app, store } = setup()
    mkState(store) // sourceId 'xhs-search'（裸名）
    store.create({ kind: 'repair', sourceId: '@streamapp/xhs/xhs-search' })
    store.create({ kind: 'repair', sourceId: '@streamapp/other/other-search' })
    const byFull = await (await app.request('/api/interventions?source=@streamapp/xhs/xhs-search')).json() as { runs: { sourceId: string }[] }
    expect(byFull.runs.map((r) => r.sourceId).sort()).toEqual(['@streamapp/xhs/xhs-search', 'xhs-search'])
    const byBare = await (await app.request('/api/interventions?source=xhs-search')).json() as { runs: { sourceId: string }[] }
    expect(byBare.runs).toHaveLength(1) // 裸名问裸名：不往全名反推（裸名对不上唯一的包）
  })

  it('接受 state 提议 → 学到的层里多一个带来源的状态；合成图里包自带 + 学到的都在；再接受一次 409', async () => {
    const { app, store, graphs } = setup()
    const p = mkState(store)
    const res = await post(app, `/api/interventions/proposals/${p.id}/accept`)
    expect(res.status).toBe(200)
    expect(graphs.learned('xhs')?.states[0]).toMatchObject({ id: 'xhs/results', proposalId: p.id })
    expect(graphs.graphFor('xhs')?.states.map((s) => s.id)).toEqual(['xhs/home', 'xhs/results'])
    expect(store.getProposal(p.id)!.status).toBe('accepted')
    expect((await post(app, `/api/interventions/proposals/${p.id}/accept`)).status).toBe(409)
  })

  it('接受时可改名；名字不带 facility 前缀 400；和包自带撞车 409', async () => {
    const { app, store, graphs } = setup()
    const p = mkState(store)
    expect((await post(app, `/api/interventions/proposals/${p.id}/accept`, { stateId: 'bad' })).status).toBe(400)
    expect((await post(app, `/api/interventions/proposals/${p.id}/accept`, { stateId: 'xhs/home' })).status).toBe(409)
    await post(app, `/api/interventions/proposals/${p.id}/accept`, { stateId: 'xhs/search-results' })
    expect(graphs.learned('xhs')?.states[0]?.id).toBe('xhs/search-results')
  })

  it('discriminator：追加到学到的状态 ok；追加到包自带的 409 cannot-edit-authored；不给 stateId 400', async () => {
    const { app, store, graphs } = setup()
    const base = mkState(store)
    await post(app, `/api/interventions/proposals/${base.id}/accept`)
    const d = mkState(store, { kind: 'discriminator' })
    expect((await post(app, `/api/interventions/proposals/${d.id}/accept`)).status).toBe(400)
    const denied = await post(app, `/api/interventions/proposals/${d.id}/accept`, { stateId: 'xhs/home' })
    expect(denied.status).toBe(409)
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('cannot-edit-authored')
    const ok = await post(app, `/api/interventions/proposals/${d.id}/accept`, { stateId: 'xhs/results' })
    expect(ok.status).toBe(200)
    expect(graphs.learned('xhs')?.states[0]?.features).toHaveLength(2)
  })

  it('拒绝 → rejected-by-user；transition 接受只改状态、applied:false', async () => {
    const { app, store } = setup()
    const t = mkState(store, { kind: 'transition' })
    const acc = await (await post(app, `/api/interventions/proposals/${t.id}/accept`)).json() as { applied: boolean }
    expect(acc.applied).toBe(false)
    const q = mkState(store, { stateId: 'xhs/y' })
    await app.request(`/api/interventions/proposals/${q.id}/reject`, { method: 'POST' })
    expect(store.getProposal(q.id)!.status).toBe('rejected-by-user')
  })

  /** 拒绝必须同时把缓存里那条答案也拒掉，否则同指纹再落空时缓存照旧命中，拒绝等于白做。 */
  it('拒绝一条提议 → 它背后那条缓存答案也变成 rejected-by-user', async () => {
    const { app, store } = setup()
    const p = mkState(store)
    store.putAnswer({ key: 'k1', sourceId: 'xhs-search', kind: 'state', fingerprint: 'fp1', status: 'pending', proposalId: p.id, answer: { kind: 'state' } })
    await app.request(`/api/interventions/proposals/${p.id}/reject`, { method: 'POST' })
    expect(store.getAnswer('k1')!.status).toBe('rejected-by-user')
  })

  /** accept 也要跟着把缓存里那条答案同步成 accepted——不同步的话同指纹再落空时缓存还报
   *  「有一条待审提议」，而人刚接受掉的那一条其实已经进了状态图，不该再等审一遍。 */
  it('接受一条提议 → 它背后那条缓存答案也变成 accepted', async () => {
    const { app, store } = setup()
    const p = mkState(store)
    store.putAnswer({ key: 'k1', sourceId: 'xhs-search', kind: 'state', fingerprint: 'fp1', status: 'pending', proposalId: p.id, answer: { kind: 'state' } })
    await post(app, `/api/interventions/proposals/${p.id}/accept`)
    expect(store.getAnswer('k1')!.status).toBe('accepted')
  })

  it('接受一条 transition 提议（不落地那一路）→ 缓存答案同样变成 accepted', async () => {
    const { app, store } = setup()
    const t = mkState(store, { kind: 'transition' })
    store.putAnswer({ key: 'k2', sourceId: 'xhs-search', kind: 'transition', fingerprint: 'fp2', status: 'pending', proposalId: t.id, answer: { kind: 'transition' } })
    await post(app, `/api/interventions/proposals/${t.id}/accept`)
    expect(store.getAnswer('k2')!.status).toBe('accepted')
  })

  it('accept 的 body 写错键名 → 400 并指出该写哪个，提议状态不变', async () => {
    const { app, store } = setup()
    const p = mkState(store)
    const res = await post(app, `/api/interventions/proposals/${p.id}/accept`, { state_id: 'xhs/renamed' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('validation_error')
    expect(body.error.message).toContain('state_id')
    expect(body.error.message).toContain('stateId')
    expect(store.getProposal(p.id)!.status).toBe('pending')
  })

  it('提议不存在：accept / reject 都是 404 + not-found', async () => {
    const { app } = setup()
    const acc = await post(app, '/api/interventions/proposals/nope/accept')
    expect(acc.status).toBe(404)
    expect(((await acc.json()) as { error: { code: string } }).error.code).toBe('not-found')
    const rej = await app.request('/api/interventions/proposals/nope/reject', { method: 'POST' })
    expect(rej.status).toBe(404)
    expect(((await rej.json()) as { error: { code: string } }).error.code).toBe('not-found')
  })

  it('discriminator：graphFor 撞车抛错时不透出无结构 500，兜成 409 learned-rejected', async () => {
    const { store } = setup()
    const d = mkState(store, { kind: 'discriminator', stateId: 'xhs/ghost' })
    // 假 graphs：目标状态不在学到的层里（触发去查 authored 那条分支），但 graphFor 本身
    // 模拟「两层 id 撞车」抛错——这是 StateGraphStore 写入时就会拦下的组合，真实存储造不出这个现场，
    // 所以这里直接换一个假对象来复现「discriminator 分支没兜住 graphFor 抛错」这条路径。
    const graphs = {
      learned: () => undefined,
      graphFor: () => { throw new Error('学到的状态 xhs/ghost 与包自带的 states.json 撞车') },
      addLearnedState: () => { throw new Error('unused') },
      replaceLearnedState: () => { throw new Error('unused') },
      addLearnedTransition: () => { throw new Error('unused') },
    }
    const app2 = new Hono()
    mountInterventionRoutes(app2, { store, graphs })
    const res = await post(app2, `/api/interventions/proposals/${d.id}/accept`, { stateId: 'xhs/ghost' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('learned-rejected')
  })

  it('discriminator：target 在学到层里查得到，但 replaceLearnedState 写回时撞车抛错，兜成 409 learned-rejected', async () => {
    const { store } = setup()
    const d = mkState(store, { kind: 'discriminator', stateId: 'xhs/results' })
    // 假 graphs：模拟「包升级后 states.json 新增了和学到层同 id 的状态」——target 仍能在
    // 学到层里查到、走到 replaceLearnedState，但底层 put() 的合成校验会撞车拒绝。
    const graphs = {
      learned: () => ({
        version: 1 as const, facility: 'xhs',
        states: [{ id: 'xhs/results', features: [], proposalId: 'old', acceptedAt: '2026-01-01T00:00:00.000Z' }],
        transitions: [],
      }),
      graphFor: () => ({ states: [{ id: 'xhs/results', features: [] }], transitions: [] }) as StateGraph,
      addLearnedState: () => { throw new Error('unused') },
      replaceLearnedState: () => { throw new Error('学到的状态 xhs/results 与包自带的 states.json 撞车') },
      addLearnedTransition: () => { throw new Error('unused') },
    }
    const app2 = new Hono()
    mountInterventionRoutes(app2, { store, graphs })
    const res = await post(app2, `/api/interventions/proposals/${d.id}/accept`, { stateId: 'xhs/results' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('learned-rejected')
    expect(store.getProposal(d.id)!.status).toBe('pending')
  })

  describe('agent 档的端点', () => {
    const fakeRepairs = () => {
      const calls: string[] = []
      return {
        calls,
        answerPermission: (r: string, p: string, o: string) => { calls.push(`perm ${r} ${p} ${o}`); return r === 'live' ? (p === 'P1' ? 'ok' : 'no-such-permission') : 'not-found' as const },
        continue: (r: string) => (r === 'live' ? 'ok' : r === 'running' ? 'not-paused' : 'not-found') as 'ok' | 'not-paused' | 'not-found',
        cancel: async (r: string) => (r === 'live' ? 'ok' : 'not-found') as 'ok' | 'not-found',
        say: (r: string, t: string) => { calls.push(`say ${r} ${t}`); return (r === 'live' ? 'ok' : 'not-found') as 'ok' | 'not-found' },
        resume: (r: string) => (r === 'paused' ? 'ok' : r === 'live' ? 'busy' : 'not-resumable') as 'ok' | 'busy' | 'not-resumable' | 'not-found',
      }
    }
    it('答权限：严格闸、404、409、200', async () => {
      const app = new Hono(); const repairs = fakeRepairs()
      mountInterventionRoutes(app, { store: new InterventionRunStore(':memory:'), graphs: setup().graphs, repairs })
      expect((await post(app, '/api/interventions/live/permissions/P1', { option: 'y' })).status).toBe(400)
      expect((await post(app, '/api/interventions/dead/permissions/P1', { optionId: 'y' })).status).toBe(404)
      expect((await post(app, '/api/interventions/live/permissions/P9', { optionId: 'y' })).status).toBe(409)
      expect((await post(app, '/api/interventions/live/permissions/P1', { optionId: 'y' })).status).toBe(200)
      expect(repairs.calls).toContain('perm live P1 y')
    })
    it('continue / cancel / messages / resume 的状态码', async () => {
      const app = new Hono()
      mountInterventionRoutes(app, { store: new InterventionRunStore(':memory:'), graphs: setup().graphs, repairs: fakeRepairs() })
      expect((await post(app, '/api/interventions/live/continue')).status).toBe(200)
      expect((await post(app, '/api/interventions/running/continue')).status).toBe(409)
      expect((await post(app, '/api/interventions/live/cancel')).status).toBe(200)
      expect((await post(app, '/api/interventions/dead/cancel')).status).toBe(404)
      expect((await post(app, '/api/interventions/live/messages', { text: '' })).status).toBe(400)
      expect((await post(app, '/api/interventions/live/messages', { msg: 'x' })).status).toBe(400)
      expect((await post(app, '/api/interventions/live/messages', { text: '用 data-testid' })).status).toBe(200)
      expect((await post(app, '/api/interventions/paused/resume')).status).toBe(200)
      expect((await post(app, '/api/interventions/live/resume')).status).toBe(409)
    })
    /**
     * 五个端点各写各的 `if (!deps.repairs)`，共用不了一条路——只打其中一个的话，哪天有人在
     * `cancel` 或 `resume` 上把守卫删了，没有一条测试会红。
     */
    it.each([
      ['/api/interventions/x/permissions/P1', { optionId: 'y' }],
      ['/api/interventions/x/continue', undefined],
      ['/api/interventions/x/cancel', undefined],
      ['/api/interventions/x/messages', { text: 'hi' }],
      ['/api/interventions/x/resume', undefined],
    ] as const)('没接 repairs（agent 档没挂）→ %s 回 503 agent-unavailable', async (path, body) => {
      const { app } = setup()
      const res = await post(app, path, body as Record<string, unknown> | undefined)
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('agent-unavailable')
    })

    /**
     * 这五个端点唯一的用户可见出口就是这句 message。把 code 抄一遍（`{code:'busy',message:'busy'}`）
     * 等于什么都没说——而 `code` 必须原样保留：前端「继续」那颗按钮按 `not-found` 字面判。
     */
    it('回执带人话，且 code 原样保留', async () => {
      const app = new Hono()
      mountInterventionRoutes(app, { store: new InterventionRunStore(':memory:'), graphs: setup().graphs, repairs: fakeRepairs() })
      const body = async (p: string): Promise<{ error: { code: string; message: string } }> =>
        (await (await post(app, p)).json()) as { error: { code: string; message: string } }
      const dead = await body('/api/interventions/dead/cancel')
      expect(dead.error.code).toBe('not-found')
      expect(dead.error.message).toContain('恢复')
      expect(dead.error.message).not.toBe('not-found')
      const notPaused = await body('/api/interventions/running/continue')
      expect(notPaused.error).toMatchObject({ code: 'not-paused' })
      expect(notPaused.error.message).toContain('paused')
      const busy = await body('/api/interventions/live/resume')
      expect(busy.error).toMatchObject({ code: 'busy' })
      expect(busy.error.message).toContain('正忙')
    })
    it('accept recipe 提议 → writeRecipe 写到 recipePath 本身，applied:true；写失败 409', async () => {
      const written: Array<{ path: string; version: number }> = []
      const app = new Hono(); const store = new InterventionRunStore(':memory:')
      mountInterventionRoutes(app, { store, graphs: setup().graphs, writeRecipe: (path, r) => { if (path === '/boom/demo.recipe.json') throw new Error('disk full'); written.push({ path, version: (r as { version: number }).version }) } })
      const run = store.create({ kind: 'repair', sourceId: '@s/p/demo' })
      const p = store.addProposal({ runId: run.id, sourceId: '@s/p/demo', kind: 'recipe', rationale: 'r', status: 'pending', recipe: { version: 5, sourceId: 'demo' }, recipePath: '/pkg/demo.recipe.json', validation: { schema: 'ok', version: 'ok', assertions: 'ok', probe: 'skipped-no-executor' } })
      const res = await post(app, `/api/interventions/proposals/${p.id}/accept`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ applied: true, path: '/pkg/demo.recipe.json' })
      expect(written).toEqual([{ path: '/pkg/demo.recipe.json', version: 5 }])
      expect(store.getProposal(p.id)!.status).toBe('accepted')
      const p2 = store.addProposal({ runId: run.id, sourceId: '@s/p/demo', kind: 'recipe', rationale: 'r', status: 'pending', recipe: { version: 5 }, recipePath: '/boom/demo.recipe.json' })
      const bad = await post(app, `/api/interventions/proposals/${p2.id}/accept`)
      expect(bad.status).toBe(409)
      expect(store.getProposal(p2.id)!.status).toBe('pending')   // 没写成就别标接受
    })

    /** 真写盘：默认 writeRecipe 原子写回 `recipePath` 本身，不在旁边多出一个 `<sourceId>.json`
     *  （这条分支上真写错过一次落点——引擎只装载 `*.recipe.json`，写去别处不报错、只是白写）。 */
    it('accept recipe 提议（真写盘）→ 内容落在 recipePath 本身，目录里不多出 <sourceId>.json；候选过不了校验 → 409 write-failed，提议仍 pending', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'accept-recipe-'))
      const recipePath = join(dir, 'demo.recipe.json')
      writeFileSync(recipePath, JSON.stringify(validHttpRecipe))
      const app = new Hono(); const store = new InterventionRunStore(':memory:')
      mountInterventionRoutes(app, { store, graphs: setup().graphs })
      const run = store.create({ kind: 'repair', sourceId: '@s/p/demo' })
      const candidate = { ...validHttpRecipe, version: 2 }
      const p = store.addProposal({ runId: run.id, sourceId: '@s/p/demo', kind: 'recipe', rationale: 'r', status: 'pending', recipe: candidate, recipePath })
      const res = await post(app, `/api/interventions/proposals/${p.id}/accept`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ applied: true, path: recipePath })
      expect(store.getProposal(p.id)!.status).toBe('accepted')
      expect(JSON.parse(readFileSync(recipePath, 'utf8'))).toMatchObject({ version: 2 })
      expect(readdirSync(dir).sort()).toEqual(['demo.recipe.json'])   // 没多出 demo.json

      // 候选不合法（pagination.mode 不是 cursor/increment）→ 校验挡下，409 write-failed，提议保持 pending，原文件不动
      const invalidCandidate = { ...validHttpRecipe, version: 3, pagination: { ...validHttpRecipe.pagination, mode: 'bogus' } }
      const p2 = store.addProposal({ runId: run.id, sourceId: '@s/p/demo', kind: 'recipe', rationale: 'r', status: 'pending', recipe: invalidCandidate, recipePath })
      const bad = await post(app, `/api/interventions/proposals/${p2.id}/accept`)
      expect(bad.status).toBe(409)
      const badBody = (await bad.json()) as { error: { code: string } }
      expect(badBody.error.code).toBe('write-failed')
      expect(store.getProposal(p2.id)!.status).toBe('pending')
      expect(JSON.parse(readFileSync(recipePath, 'utf8'))).toMatchObject({ version: 2 })   // 原文件没被半写坏
    })
  })
})

describe('POST /api/interventions/explorations', () => {
  const explore = (over: Partial<{ start: (job: unknown) => 'unconfigured' | 'busy' | { runId: string }; facilityOf: (f: string) => { sourceId: string } | undefined }> = {}) => {
    const seen: unknown[] = []
    const app = new Hono()
    const store = new InterventionRunStore(':memory:')
    mountInterventionRoutes(app, {
      store, graphs: setup().graphs,
      explorations: { start: ((job: never) => { seen.push(job); return (over.start ?? (() => ({ runId: 'run-1' })))(job) }) as never },
      facilityOf: over.facilityOf ?? ((f: string) => (f === 'xhs' ? { sourceId: 'xhs-home' } : undefined)),
    })
    return { app, seen }
  }
  const body = async (res: Response): Promise<{ error?: { code: string }; runId?: string }> => (await res.json()) as { error?: { code: string }; runId?: string }

  it('开一条探索 → 201 带 runId，limits 缺省补上默认三闸，sourceId 由 facilityOf 解出', async () => {
    const { app, seen } = explore()
    const res = await post(app, '/api/interventions/explorations', { facility: 'xhs', target: 'chrome:42', goal: '把搜索那条路探出来' })
    expect(res.status).toBe(201)
    expect(await body(res)).toEqual({ runId: 'run-1' })
    expect(seen[0]).toMatchObject({ facility: 'xhs', sourceId: 'xhs-home', target: 'chrome:42', goal: '把搜索那条路探出来', limits: DEFAULT_EXPLORE_LIMITS })
  })

  it('limits 给了就照给的走', async () => {
    const { app, seen } = explore()
    await post(app, '/api/interventions/explorations', { facility: 'xhs', target: 'chrome:1', goal: 'g', limits: { maxStates: 3 } })
    expect(seen[0]).toMatchObject({ limits: { maxStates: 3, maxDepth: DEFAULT_EXPLORE_LIMITS.maxDepth } })
  })

  /** `0` 会让探索一步不走却报成功，小数 / 负数变成永远比不过的阈值——两种都不报错，只是什么都没探出来。 */
  it('limits 里不是正整数 → 400 bad-limits（0 / 小数 / 负数 / 字符串都算）', async () => {
    const { app, seen } = explore()
    for (const limits of [{ maxStates: 0 }, { maxDepth: 2.5 }, { maxStates: -1 }, { maxDepth: '3' }]) {
      const res = await post(app, '/api/interventions/explorations', { facility: 'xhs', target: 'chrome:1', goal: 'g', limits })
      expect(res.status).toBe(400)
      expect((await body(res)).error!.code).toBe('bad-limits')
    }
    expect(seen).toHaveLength(0)   // 一条都没开起来
  })

  it('limits 里写错子键 → 400 unknown-key 并指出该写哪个', async () => {
    const { app } = explore()
    const res = await post(app, '/api/interventions/explorations', { facility: 'xhs', target: 'chrome:1', goal: 'g', limits: { max_states: 3 } })
    expect(res.status).toBe(400)
    const b = (await res.json()) as { error: { code: string; message: string } }
    expect(b.error.code).toBe('unknown-key')
    expect(b.error.message).toContain('max_states')
    expect(b.error.message).toContain('maxStates')
  })

  it('缺字段 400 need-fields；写错键名 400 unknown-key', async () => {
    const { app } = explore()
    const missing = await post(app, '/api/interventions/explorations', { target: 'chrome:1', goal: 'g' })
    expect(missing.status).toBe(400)
    expect((await body(missing)).error!.code).toBe('need-fields')
    const wrongKey = await post(app, '/api/interventions/explorations', { facility: 'xhs', target: 'chrome:1', goal: 'g', max_states: 3 })
    expect(wrongKey.status).toBe(400)
    expect((await body(wrongKey)).error!.code).toBe('unknown-key')
  })

  /** 本期只探网页面：`facility:xhs`（采集正骑着那一页）不是一个能自由乱点的面，放行等于让 agent 去抢采集的标签页。 */
  it('target 不是 chrome:<tabId> → 400 bad-target', async () => {
    const { app } = explore()
    const res = await post(app, '/api/interventions/explorations', { facility: 'xhs', target: 'facility:xhs', goal: 'g' })
    expect(res.status).toBe(400)
    expect((await body(res)).error!.code).toBe('bad-target')
  })

  it('不认识的 facility → 400 unknown-facility', async () => {
    const { app } = explore()
    const res = await post(app, '/api/interventions/explorations', { facility: 'nope', target: 'chrome:1', goal: 'g' })
    expect(res.status).toBe(400)
    expect((await body(res)).error!.code).toBe('unknown-facility')
  })

  it('没配 ai-agent → 503 agent-unavailable；同 facility 已有一条在跑 → 409 explore-busy', async () => {
    const un = explore({ start: () => 'unconfigured' })
    const r1 = await post(un.app, '/api/interventions/explorations', { facility: 'xhs', target: 'chrome:1', goal: 'g' })
    expect(r1.status).toBe(503)
    expect((await body(r1)).error!.code).toBe('agent-unavailable')
    const busy = explore({ start: () => 'busy' })
    const r2 = await post(busy.app, '/api/interventions/explorations', { facility: 'xhs', target: 'chrome:1', goal: 'g' })
    expect(r2.status).toBe(409)
    expect((await body(r2)).error!.code).toBe('explore-busy')
  })

  /** 探索这一格没接线（宿主没挂 explorations / facilityOf）→ 503，别静默 404 装作没这个口。 */
  it('deps 里没有 explorations → 503', async () => {
    const app = new Hono()
    mountInterventionRoutes(app, { store: new InterventionRunStore(':memory:'), graphs: setup().graphs })
    const res = await post(app, '/api/interventions/explorations', { facility: 'xhs', target: 'chrome:1', goal: 'g' })
    expect(res.status).toBe(503)
  })
})

describe('accept kind:graph：整份草稿并进学到的层', () => {
  const draftOf = (states: { id: string }[], transitions: unknown[]) => ({
    version: 1, runId: 'r1', facility: 'xhs', side: 'browser', target: 'chrome:1', goal: 'g',
    states: states.map((s) => ({ id: s.id, features: [{ kind: 'dom', selector: `.${s.id.split('/')[1]}` }] })),
    transitions, visited: {}, blocked: {}, frozen: [], irrelevant: [], remaining: {}, depth: {},
  })
  const mkGraph = (store: InterventionRunStore, draft: unknown) => {
    const r = store.create({ kind: 'explore', sourceId: 'xhs-home' })
    return store.addProposal({ runId: r.id, sourceId: 'xhs-home', facility: 'xhs', kind: 'graph', rationale: '探完了', status: 'pending', draft })
  }

  it('两个状态 + 一条边 → 200，学到的层两条状态都带 proposalId，转移只留 from/to/steps（effect/via 剥掉），noop 边不落', async () => {
    const { app, store, graphs } = setup()
    const draft = draftOf([{ id: 'xhs/a' }, { id: 'xhs/b' }], [
      { from: 'xhs/a', to: 'xhs/b', steps: [{ do: 'click', selector: '.go' }], effect: 'reversible', via: { ref: 1, selector: '.go', rect: { x: 0, y: 0, w: 1, h: 1 } } },
      { from: 'xhs/a', steps: [{ do: 'click', selector: '.noop' }], effect: 'noop', via: { ref: 2, selector: '.noop', rect: { x: 0, y: 0, w: 1, h: 1 } } },
    ])
    const p = mkGraph(store, draft)
    const res = await post(app, `/api/interventions/proposals/${p.id}/accept`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ applied: true, states: 2, transitions: 1 })
    const learned = graphs.learned('xhs')!
    expect(learned.states.map((s) => s.id)).toEqual(['xhs/a', 'xhs/b'])
    expect(learned.states.every((s) => s.proposalId === p.id)).toBe(true)
    expect(learned.transitions).toEqual([{ from: 'xhs/a', to: 'xhs/b', steps: [{ do: 'click', selector: '.go' }] }])
    expect(store.getProposal(p.id)!.status).toBe('accepted')
  })

  /** 撞车 = **整份不写**：学到的层没有删接口，写一半再回滚是另一次会失败的写。 */
  it('草稿里有一条与包自带撞 id → 409 learned-rejected，学到的层一条都没有', async () => {
    const { app, store, graphs } = setup()
    const p = mkGraph(store, draftOf([{ id: 'xhs/a' }, { id: 'xhs/home' }], []))
    const res = await post(app, `/api/interventions/proposals/${p.id}/accept`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('learned-rejected')
    expect(graphs.learned('xhs')).toBeUndefined()
    expect(store.getProposal(p.id)!.status).toBe('pending')
  })

  it('状态 id 不带 facility 前缀 → 409，且一条都不写', async () => {
    const { app, store, graphs } = setup()
    const p = mkGraph(store, draftOf([{ id: 'xhs/a' }, { id: 'bad' }], []))
    expect((await post(app, `/api/interventions/proposals/${p.id}/accept`)).status).toBe(409)
    expect(graphs.learned('xhs')).toBeUndefined()
  })

  it('转移的 to 指向图里不存在的状态 → 409，且一条都不写', async () => {
    const { app, store, graphs } = setup()
    const p = mkGraph(store, draftOf([{ id: 'xhs/a' }], [
      { from: 'xhs/a', to: 'xhs/ghost', steps: [], effect: 'one-way', via: { ref: 1, selector: '.x', rect: { x: 0, y: 0, w: 1, h: 1 } } },
    ]))
    expect((await post(app, `/api/interventions/proposals/${p.id}/accept`)).status).toBe(409)
    expect(graphs.learned('xhs')).toBeUndefined()
  })

  it('提议没带草稿 → 409 no-draft', async () => {
    const { app, store } = setup()
    const p = mkGraph(store, undefined)
    const res = await post(app, `/api/interventions/proposals/${p.id}/accept`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('no-draft')
  })
})
