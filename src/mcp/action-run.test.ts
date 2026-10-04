import { describe, it, expect, vi } from 'vitest'
import { createActionRunService, actionRunKey, ACTION_RUN_GOAL_PREFIX, type ActionRunStore } from './action-run.ts'
import type { ActionRecipeResult, PreparedAction } from './action-recipe.ts'
import type { RunRecord, RunStatus } from '../agent/search/types.ts'

/** 一本最小的 run 库：只实现服务真用到的 create / put / get。 */
function memStore(): ActionRunStore & { rows: Map<string, RunRecord> } {
  const rows = new Map<string, RunRecord>()
  let n = 0
  return {
    rows,
    create(goal, domain) {
      const runId = `run-${++n}`
      const rec: RunRecord = { runId, goal, domain: domain ?? 'netdisk', status: 'queued', trajectory: [], updatedAt: new Date().toISOString() }
      rows.set(runId, rec)
      return rec
    },
    put(runId, patch) {
      const rec = rows.get(runId)!
      rows.set(runId, { ...rec, ...patch, status: patch.status as RunStatus })
    },
    get(runId) {
      return rows.get(runId) ?? null
    },
  }
}

/** 一次可控的执行：`resolve` 由用例决定什么时候落定。 */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const DONE: ActionRecipeResult = { status: 'done', sourceId: 'qq-send', items: [] }

function ready(execute: () => Promise<ActionRecipeResult>, key = actionRunKey('qq-send', { contact: 'a', message: 'b' })): PreparedAction {
  return { kind: 'ready', sourceId: 'qq-send', key, execute }
}

describe('createActionRunService', () => {
  it('等待窗内跑完 → 直接回最终结果并带 runId；库里 status done、result 同一份', async () => {
    const store = memStore()
    const svc = createActionRunService({ store, prepare: async () => ready(async () => DONE), waitMs: 1000 })
    const out = await svc.run({ sourceId: 'qq-send', params: { contact: 'a', message: 'b' }, confirmed: true })
    expect(out).toEqual({ ...DONE, runId: 'run-1' })
    const rec = store.get('run-1')!
    expect(rec.status).toBe('done')
    expect(rec.domain).toBe('action')
    expect(rec.result).toEqual(DONE)
    // goal 里只有 sourceId，绝不带 params（正文会进列表面）
    expect(rec.goal).toBe(`${ACTION_RUN_GOAL_PREFIX}qq-send`)
  })

  it('等待窗内没跑完 → 回 running + runId；执行落定后库里变 done', async () => {
    const store = memStore()
    const d = deferred<ActionRecipeResult>()
    const svc = createActionRunService({ store, prepare: async () => ready(() => d.promise), waitMs: 10 })
    const out = await svc.run({ sourceId: 'qq-send', params: { contact: 'a', message: 'b' }, confirmed: true })
    expect(out.status).toBe('running')
    expect(out.runId).toBe('run-1')
    expect(out.reason).toMatch(/get_agent_run/)
    expect(store.get('run-1')!.status).toBe('running')
    d.resolve(DONE)
    await d.promise
    await new Promise((r) => setImmediate(r))
    expect(store.get('run-1')!.status).toBe('done')
    expect(store.get('run-1')!.result).toEqual(DONE)
  })

  it('同参在飞再调 → 同一个 runId，execute 只跑一次；不同 params → 新 run', async () => {
    const store = memStore()
    const d = deferred<ActionRecipeResult>()
    const execute = vi.fn(() => d.promise)
    const svc = createActionRunService({
      store,
      prepare: async (args) => ready(execute, actionRunKey(args.sourceId, args.params as Record<string, string>)),
      waitMs: 5,
    })
    const a = await svc.run({ sourceId: 'qq-send', params: { contact: 'a', message: 'b' }, confirmed: true })
    const b = await svc.run({ sourceId: 'qq-send', params: { contact: 'a', message: 'b' }, confirmed: true })
    expect(a.runId).toBe('run-1')
    expect(b).toMatchObject({ status: 'running', runId: 'run-1' })
    expect(execute).toHaveBeenCalledTimes(1)
    const c = await svc.run({ sourceId: 'qq-send', params: { contact: 'a', message: 'c' }, confirmed: true })
    expect(c.runId).toBe('run-2')
    expect(execute).toHaveBeenCalledTimes(2)
    d.resolve(DONE)
  })

  it('跑完之后同参再调 → 新 run（不挡"再发一次"）', async () => {
    const store = memStore()
    const execute = vi.fn(async () => DONE)
    const svc = createActionRunService({ store, prepare: async () => ready(execute), waitMs: 1000 })
    const a = await svc.run({ sourceId: 'qq-send', params: {}, confirmed: true })
    const b = await svc.run({ sourceId: 'qq-send', params: {}, confirmed: true })
    expect(a.runId).toBe('run-1')
    expect(b.runId).toBe('run-2')
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('execute 抛 → 库里 error，在飞表清掉（下一次同参是新 run）', async () => {
    const store = memStore()
    let first = true
    const svc = createActionRunService({
      store,
      prepare: async () => ready(async () => {
        if (first) { first = false; throw new Error('agent 炸了') }
        return DONE
      }),
      waitMs: 1000,
    })
    await expect(svc.run({ sourceId: 'qq-send', params: {}, confirmed: true })).rejects.toThrow('agent 炸了')
    expect(store.get('run-1')!.status).toBe('error')
    expect(store.get('run-1')!.error).toBe('agent 炸了')
    const b = await svc.run({ sourceId: 'qq-send', params: {}, confirmed: true })
    expect(b.runId).toBe('run-2')
  })

  it('prepare 直接给结果（needs-confirmation / 校验失败）→ 同步回、不建 run', async () => {
    const store = memStore()
    const nc: ActionRecipeResult = { status: 'needs-confirmation', sourceId: 'qq-send' }
    const svc = createActionRunService({ store, prepare: async () => ({ kind: 'result', result: nc }), waitMs: 1000 })
    const out = await svc.run({ sourceId: 'qq-send', params: {} })
    expect(out).toEqual(nc)
    expect(store.rows.size).toBe(0)
  })

  it('actionRunKey：键序无关、值 String 化', () => {
    expect(actionRunKey('x', { b: '2', a: '1' })).toBe(actionRunKey('x', { a: '1', b: '2' }))
    expect(actionRunKey('x', { a: '1' })).not.toBe(actionRunKey('y', { a: '1' }))
  })
})
