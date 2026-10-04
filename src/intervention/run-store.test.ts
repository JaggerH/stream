import { describe, it, expect, vi } from 'vitest'
import { ANSWER_CAP, InterventionRunStore, SHOT_CAP, statusForStop } from './run-store.ts'
import type { AnswerStatus } from './types.ts'

describe('InterventionRunStore', () => {
  it('create → running；事件 seq 从 1 单调递增；since 读口只回之后的', () => {
    const s = new InterventionRunStore(':memory:')
    const run = s.create({ kind: 'runtime-ask', sourceId: 'xhs-search', question: 'state' })
    expect(run.status).toBe('queued')
    expect(run.usage).toEqual({ promptTokens: 0, completionTokens: 0, turns: 0, wallMs: 0, reported: false })
    s.setStatus(run.id, 'running')
    const e1 = s.appendEvent(run.id, { kind: 'message', title: '开问' })
    const e2 = s.appendEvent(run.id, { kind: 'tool_call', title: '截图', callId: 'c1' })
    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
    expect(s.events(run.id, { since: 1 }).map((e) => e.seq)).toEqual([2])
    expect(s.get(run.id)!.lastSeq).toBe(2)
    expect(s.get(run.id)!.status).toBe('running')
  })

  it('finish 写两格停止原因；fail 写错误码；两者互斥', () => {
    const s = new InterventionRunStore(':memory:')
    const a = s.create({ kind: 'runtime-ask', sourceId: 'a', question: 'state' })
    s.finish(a.id, { produced: 'proposal', reason: 'end_turn' })
    expect(s.get(a.id)!.status).toBe('done')
    expect(s.get(a.id)!.stopped).toEqual({ produced: 'proposal', reason: 'end_turn' })
    const b = s.create({ kind: 'runtime-ask', sourceId: 'b', question: 'state' })
    s.fail(b.id, { code: 'llm_unconfigured', message: 'LLM 未配置' })
    expect(s.get(b.id)!.status).toBe('error')
    expect(s.get(b.id)!.error?.code).toBe('llm_unconfigured')
    expect(s.get(b.id)!.stopped).toEqual({ produced: 'nothing', reason: 'error' })
  })

  it('statusForStop 按 reason 映射四档终态；error 抛错（那是 fail 的事）', () => {
    expect(statusForStop({ produced: 'proposal', reason: 'end_turn' })).toBe('done')
    expect(statusForStop({ produced: 'verdict-unrepairable', reason: 'frontier-exhausted' })).toBe('done')
    expect(statusForStop({ produced: 'nothing', reason: 'cancelled' })).toBe('cancelled')
    expect(statusForStop({ produced: 'nothing', reason: 'gate:turns' })).toBe('stopped')
    expect(statusForStop({ produced: 'nothing', reason: 'gate:tokens' })).toBe('stopped')
    expect(statusForStop({ produced: 'nothing', reason: 'gate:wall' })).toBe('stopped')
    expect(statusForStop({ produced: 'nothing', reason: 'stuck' })).toBe('stopped')
    expect(() => statusForStop({ produced: 'nothing', reason: 'error' })).toThrow()
  })

  it('finish 按 reason 落对应终态：cancelled/gate:* 不再被 done 吞掉', () => {
    const s = new InterventionRunStore(':memory:')
    const c = s.create({ kind: 'runtime-ask', sourceId: 'c', question: 'state' })
    s.finish(c.id, { produced: 'nothing', reason: 'cancelled' })
    expect(s.get(c.id)!.status).toBe('cancelled')
    const d = s.create({ kind: 'runtime-ask', sourceId: 'd', question: 'state' })
    s.finish(d.id, { produced: 'nothing', reason: 'gate:wall' })
    expect(s.get(d.id)!.status).toBe('stopped')
  })

  it('usage 累加；reported 只要有一次未报就为 false', () => {
    const s = new InterventionRunStore(':memory:')
    const r = s.create({ kind: 'runtime-ask', sourceId: 'a', question: 'state' })
    s.addUsage(r.id, { promptTokens: 100, completionTokens: 20, reported: true, wallMs: 500 })
    expect(s.get(r.id)!.usage).toMatchObject({ promptTokens: 100, completionTokens: 20, turns: 1, reported: true })
    s.addUsage(r.id, { promptTokens: 0, completionTokens: 0, reported: false, wallMs: 300 })
    expect(s.get(r.id)!.usage).toMatchObject({ turns: 2, wallMs: 800, reported: false })
  })

  it('countTurn:false 的那笔记 token 不记轮数，而「有一笔没报」照样传下去', () => {
    const s = new InterventionRunStore(':memory:')
    const r = s.create({ kind: 'explore', sourceId: 'a' })
    // 探索的拉黑闸：问一次运行时模型，是开销不是一轮对话
    s.addUsage(r.id, { promptTokens: 7, completionTokens: 3, reported: true, wallMs: 40 }, { countTurn: false })
    expect(s.get(r.id)!.usage).toMatchObject({ promptTokens: 7, completionTokens: 3, turns: 0, wallMs: 40, reported: true })
    s.addUsage(r.id, { promptTokens: 0, completionTokens: 0, reported: false, wallMs: 10 }, { countTurn: false })
    s.addUsage(r.id, { promptTokens: 100, completionTokens: 20, reported: true, wallMs: 500 })
    const u = s.get(r.id)!.usage
    expect(u).toMatchObject({ turns: 1, promptTokens: 107 })
    // 中间那笔没报用量 —— 真轮次不能把它抹掉（判据若写成 turns===0 就会）
    expect(u.reported).toBe(false)
  })

  it('提议入库、按 run 读、改状态', () => {
    const s = new InterventionRunStore(':memory:')
    const r = s.create({ kind: 'runtime-ask', sourceId: 'a', question: 'state' })
    const p = s.addProposal({
      runId: r.id, sourceId: 'a', kind: 'state', rationale: '像是搜索结果页',
      features: [{ kind: 'dom', selector: '.result-list' }], stateId: 'xhs/results', status: 'pending',
    })
    expect(s.proposals({ runId: r.id })).toHaveLength(1)
    s.setProposalStatus(p.id, 'accepted')
    expect(s.proposals({ status: 'pending' })).toHaveLength(0)
    expect(s.proposals({ runId: r.id })[0]!.status).toBe('accepted')
  })

  it('list 最新在前，可按 sourceId / status 过滤', () => {
    const s = new InterventionRunStore(':memory:')
    const a = s.create({ kind: 'runtime-ask', sourceId: 'a', question: 'state' })
    const b = s.create({ kind: 'runtime-ask', sourceId: 'b', question: 'state' })
    s.setStatus(b.id, 'awaiting_confirmation')
    expect(s.list().map((r) => r.id)).toEqual([b.id, a.id])
    expect(s.list({ sourceId: 'a' }).map((r) => r.id)).toEqual([a.id])
    expect(s.list({ status: ['awaiting_confirmation'] }).map((r) => r.id)).toEqual([b.id])
  })
})

describe('截图上限', () => {
  it('太大的截图落库时换成 truncated 标记，而不是当没有截图', () => {
    const s = new InterventionRunStore(':memory:')
    const r = s.create({ kind: 'runtime-ask', sourceId: 'a', question: 'state' })
    const big = s.addProposal({
      runId: r.id, sourceId: 'a', kind: 'state', rationale: 'r', status: 'pending',
      scene: { side: 'browser', elements: [], shot: { mime: 'image/jpeg', base64: 'x'.repeat(SHOT_CAP + 1) } },
    })
    expect(s.getProposal(big.id)!.scene!.shot).toEqual({ mime: 'image/jpeg', base64: '', truncated: true })
    // 小图原样留着（别把这条闸做成"一律不存"）。
    const small = s.addProposal({
      runId: r.id, sourceId: 'a', kind: 'state', rationale: 'r', status: 'pending',
      scene: { side: 'browser', elements: [], shot: { mime: 'image/jpeg', base64: 'abc' } },
    })
    expect(s.getProposal(small.id)!.scene!.shot).toEqual({ mime: 'image/jpeg', base64: 'abc' })
  })
})

describe('prune：库不许无上限地涨', () => {
  /** 建一条**已经收尾**的 run：`prune` 只裁终态的，夹具留在 `queued` 就什么也裁不掉。 */
  const mkRun = (s: InterventionRunStore, sourceId = 'a'): ReturnType<InterventionRunStore['create']> => {
    const r = s.create({ kind: 'runtime-ask', sourceId, question: 'state' })
    s.finish(r.id, { produced: 'nothing', reason: 'end_turn' })
    return r
  }

  it('按条数裁：只留最近 N 条，事件与提议跟着删', () => {
    const s = new InterventionRunStore(':memory:')
    const first = mkRun(s)
    s.appendEvent(first.id, { kind: 'message', title: 'x' })
    const p = s.addProposal({ runId: first.id, sourceId: 'a', kind: 'state', rationale: 'r', status: 'pending' })
    for (let i = 0; i < 3; i++) mkRun(s)
    expect(s.prune({ maxRuns: 2 })).toBe(2)
    expect(s.get(first.id)).toBeNull()
    expect(s.events(first.id)).toHaveLength(0)
    expect(s.getProposal(p.id)).toBeNull()
    expect(s.list()).toHaveLength(2)
  })

  it('按天数裁：比窗口还旧的 run 删掉，窗口内的留着', () => {
    const s = new InterventionRunStore(':memory:')
    const old = mkRun(s)
    const fresh = mkRun(s)
    // 直接改 started_at 造一条 40 天前的：`create` 只会写此刻。
    ;(s as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare('UPDATE runs SET started_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 40 * 86_400_000).toISOString(), old.id)
    expect(s.prune({ maxAgeDays: 30, maxRuns: 999 })).toBe(1)
    expect(s.get(old.id)).toBeNull()
    expect(s.get(fresh.id)).not.toBeNull()
  })

  /**
   * 裁掉一条**还活着**的 run 不是省空间，是把权威从一个正在跑的会话底下抽走：登记表下一次对账
   * 读不到行会把它当终态摘掉，而 `RepairSession.status` 读不到行只回 `'error'`，看门狗每次醒来都
   * 早退——ACP 连接、定时器、agent 子进程一起成孤儿，且没有一处会喊。
   */
  it('只裁终态的：paused / running / queued 的行留着，哪怕两档上限都撞了', () => {
    const s = new InterventionRunStore(':memory:')
    const paused = s.create({ kind: 'repair', sourceId: 'a' })
    s.setStatus(paused.id, 'paused')
    const running = s.create({ kind: 'repair', sourceId: 'b' })
    s.setStatus(running.id, 'running')
    const queued = s.create({ kind: 'repair', sourceId: 'c' })
    const dead = s.create({ kind: 'repair', sourceId: 'd' })
    s.finish(dead.id, { produced: 'nothing', reason: 'end_turn' })
    // 条数与天数两档都开到最狠：只有那条终态的该消失。
    expect(s.prune({ maxRuns: 0, maxAgeDays: 0 })).toBe(1)
    expect(s.get(dead.id)).toBeNull()
    expect(s.get(paused.id)).not.toBeNull()
    expect(s.get(running.id)).not.toBeNull()
    expect(s.get(queued.id)).not.toBeNull()
  })

  /** 裁剪失败（库锁住 / 磁盘满）不该连累新建：run 已经写进去了，裁剪只是省空间的旁路。 */
  it('create() 里 prune() 抛错不影响新建成功', () => {
    const s = new InterventionRunStore(':memory:')
    const spy = vi.spyOn(s, 'prune').mockImplementation(() => { throw new Error('boom') })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = s.create({ kind: 'runtime-ask', sourceId: 'a', question: 'state' })
    expect(s.get(run.id)).not.toBeNull()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('prune 失败'))
    spy.mockRestore()
    errSpy.mockRestore()
  })
})

describe('agent 档的几格', () => {
  it('agentSession 落列、读回原样；没设过就没有这一格', () => {
    const s = new InterventionRunStore(':memory:')
    const r = s.create({ kind: 'repair', sourceId: 'xhs-search' })
    expect(s.get(r.id)!.agentSession).toBeUndefined()
    const sess = { command: 'npx', args: ['-y', 'a'], sessionId: 'sid', cwd: '/w', packageDir: '/p', localSourceId: 'xhs-search' }
    s.setAgentSession(r.id, sess)
    expect(s.get(r.id)!.agentSession).toEqual(sess)
  })
  it('inFlight 只回非终态、非 paused 的 run；markInterrupted 把它们变成 paused 并留一条事件', () => {
    const s = new InterventionRunStore(':memory:')
    const a = s.create({ kind: 'repair', sourceId: 'a' }); s.setStatus(a.id, 'running')
    const b = s.create({ kind: 'repair', sourceId: 'b' }); s.setStatus(b.id, 'awaiting_confirmation')
    const c = s.create({ kind: 'repair', sourceId: 'c' }); s.finish(c.id, { produced: 'nothing', reason: 'cancelled' })
    const d = s.create({ kind: 'repair', sourceId: 'd' }); s.setStatus(d.id, 'paused')
    expect(s.inFlight().map((r) => r.sourceId).sort()).toEqual(['a', 'b'])
    s.markInterrupted(a.id, '后端重启')
    expect(s.get(a.id)!.status).toBe('paused')
    expect(s.events(a.id).at(-1)).toMatchObject({ kind: 'status_changed', title: expect.stringContaining('后端重启') })
  })
  it('recipe 类提议带候选体与校验结果', () => {
    const s = new InterventionRunStore(':memory:')
    const r = s.create({ kind: 'repair', sourceId: 'x' })
    const p = s.addProposal({
      runId: r.id, sourceId: 'x', kind: 'recipe', rationale: '选择器改了', status: 'pending',
      recipe: { version: 5 }, recipePath: '/p/x.recipe.json',
      validation: { schema: 'ok', version: 'ok', assertions: 'ok', probe: 'skipped-needs-params' },
    })
    expect(s.getProposal(p.id)).toMatchObject({ kind: 'recipe', recipe: { version: 5 }, validation: { probe: 'skipped-needs-params' } })
  })
})

describe('answers 缓存表', () => {
  const put = (s: InterventionRunStore, key: string, over: Partial<{ status: AnswerStatus; proposalId: string }> = {}) =>
    s.putAnswer({
      key, sourceId: 'x/search', kind: 'state', fingerprint: key, answer: { kind: 'state', stateId: 'x/a' },
      status: over.status ?? 'pending', ...(over.proposalId ? { proposalId: over.proposalId } : {}),
    })

  it('写了能读回来，同 key 再写是覆盖不是重复', () => {
    const s = new InterventionRunStore(':memory:')
    put(s, 'k')
    put(s, 'k', { status: 'rejected-by-gate' })
    expect(s.getAnswer('k')).toMatchObject({ status: 'rejected-by-gate', sourceId: 'x/search', fingerprint: 'k' })
    expect(s.getAnswer('没有这个 key')).toBeNull()
  })

  it('按 proposalId 改状态（人拒了那条提议）', () => {
    const s = new InterventionRunStore(':memory:')
    put(s, 'k', { proposalId: 'p1' })
    s.setAnswerStatusByProposal('p1', 'rejected-by-user')
    expect(s.getAnswer('k')!.status).toBe('rejected-by-user')
  })

  it('超过上限就删最旧的（缓存丢了只是多问一次，不是错）', () => {
    const s = new InterventionRunStore(':memory:')
    for (let i = 0; i < ANSWER_CAP + 5; i++) put(s, `k${i}`)
    expect(s.getAnswer('k0')).toBeNull()
    expect(s.getAnswer(`k${ANSWER_CAP + 4}`)).not.toBeNull()
  })
})
