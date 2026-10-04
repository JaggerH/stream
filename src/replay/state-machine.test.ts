// src/replay/state-machine.test.ts
import { describe, expect, it, vi } from 'vitest'
import { runToState, type StepExecutor } from './state-machine.ts'
import type { StateGraph } from './state-graph.ts'
import type { IdentifyResult, Perception } from './state-perception.ts'

const graph: StateGraph = {
  states: [
    { id: 'a', features: [{ kind: 'url', pattern: 'a' }] },
    { id: 'b', features: [{ kind: 'url', pattern: 'b' }] },
    { id: 'c', features: [{ kind: 'url', pattern: 'c' }] },
  ],
  transitions: [
    { from: 'a', to: 'b', steps: [] },
    { from: 'b', to: 'c', steps: [] },
  ],
}

/** 依次吐出预设结果的假 Perception。 */
const scripted = (results: IdentifyResult[]): Perception & { calls: number } => {
  const p = {
    calls: 0,
    async identify() {
      const r = results[Math.min(p.calls, results.length - 1)]!
      p.calls += 1
      return r
    },
  }
  return p
}

/** `graph` 加一个「什么都匹配、但图上到不了 c」的 z——多源找路那两格用。 */
const withZ: StateGraph = {
  ...graph,
  states: [...graph.states, { id: 'z', features: [{ kind: 'url', pattern: '*' }] }],
}

const okExec: StepExecutor = { run: async () => ({ ok: true }) }
const failExec: StepExecutor = { run: async () => ({ ok: false, failedLabel: '点了没反应' }) }

describe('runToState', () => {
  it('顺路一路走到目标，且只认了一次状态', async () => {
    const p = scripted([{ states: ['a'], matched: [] }])
    const r = await runToState(graph, 'c', { perception: p, exec: okExec, sourceId: 's' })
    expect(r.outcome).toBe('reached')
    expect(r.finalState).toBe('c')
    // 顺路那一支一次都不重认——这是整套设计的成本基础
    expect(p.calls).toBe(1)
  })

  it('同时命中好几个：从有路的那个走，不是取第一个', async () => {
    // 'z' 排在前面但图上到不了 'c'；不做多源找路的话这一趟会当场判成 stuck。
    const p = scripted([{ states: ['z', 'a'], matched: [] }])
    const r = await runToState(withZ, 'c', { perception: p, exec: okExec, sourceId: 's' })
    expect(r.outcome).toBe('reached')
  })

  it('目标在命中集合里就算到了——不要求它是唯一命中的那个', async () => {
    const p = scripted([{ states: ['z', 'c'], matched: [] }])
    const r = await runToState(withZ, 'c', { perception: p, exec: okExec, sourceId: 's' })
    expect(r.outcome).toBe('reached')
    expect(r.finalState).toBe('c')
  })

  it("identifyPolicy:'every-step' 每走一段都重认", async () => {
    const p = scripted([
      { states: ['a'], matched: [] },
      { states: ['b'], matched: [] },
      { states: ['c'], matched: [] },
    ])
    const r = await runToState(graph, 'c', {
      perception: p,
      exec: okExec,
      sourceId: 's',
      identifyPolicy: 'every-step',
    })
    expect(r.outcome).toBe('reached')
    expect(p.calls).toBe(3)
  })

  it('起步就认不出 → 走 proposeState，结果是 stuck', async () => {
    const repair = { proposeState: vi.fn(async () => {}) }
    const p = scripted([{ states: null, reason: 'no-match', candidates: [] }])
    const r = await runToState(graph, 'c', {
      perception: p,
      exec: okExec,
      sourceId: 's',
      repair: repair as never,
    })
    expect(r.outcome).toBe('stuck')
    expect(repair.proposeState).toHaveBeenCalledOnce()
  })

  it('ambiguous 走的是 proposeDiscriminator，不是 proposeState', async () => {
    const repair = { proposeState: vi.fn(async () => {}), proposeDiscriminator: vi.fn(async () => {}) }
    const p = scripted([{ states: null, reason: 'ambiguous', candidates: ['a', 'b'] }])
    await runToState(graph, 'c', { perception: p, exec: okExec, sourceId: 's', repair: repair as never })
    expect(repair.proposeDiscriminator).toHaveBeenCalledOnce()
    expect(repair.proposeState).not.toHaveBeenCalled()
  })

  it('认出来了但没有路 → proposeTransition', async () => {
    const repair = { proposeTransition: vi.fn(async () => {}) }
    const noPath: StateGraph = { ...graph, transitions: [] }
    const p = scripted([{ states: ['a'], matched: [] }])
    const r = await runToState(noPath, 'c', {
      perception: p,
      exec: okExec,
      sourceId: 's',
      repair: repair as never,
    })
    expect(r.outcome).toBe('stuck')
    expect(repair.proposeTransition).toHaveBeenCalledOnce()
  })

  it('走完不假定到了 to——expect 落空就回去重认', async () => {
    const p = scripted([
      { states: ['a'], matched: [] },
      { states: ['a'], matched: [] }, // 动作失败，重认发现还在原地
    ])
    const r = await runToState(graph, 'c', { perception: p, exec: failExec, sourceId: 's' })
    // 原地打转，最终被防转圈拦下
    expect(r.outcome).toBe('looping')
    expect(p.calls).toBeGreaterThan(1)
  })

  it('同一状态访问第 3 次判转圈——阈值 2 会误伤合法的重走一次', async () => {
    const p = scripted([{ states: ['a'], matched: [] }])
    const r = await runToState(graph, 'c', { perception: p, exec: failExec, sourceId: 's' })
    expect(r.outcome).toBe('looping')
    expect(r.visited.filter((s) => s === 'a')).toHaveLength(3)
  })

  it('步数预算超了就停', async () => {
    const p = scripted([{ states: ['a'], matched: [] }])
    const r = await runToState(graph, 'c', {
      perception: p,
      exec: okExec,
      sourceId: 's',
      budget: { steps: 1 },
    })
    expect(r.outcome).toBe('budget')
  })

  it('AI 介入次数超预算就停，不再问', async () => {
    const proposeState = vi.fn(async () => {})
    const p = scripted([{ states: null, reason: 'no-match', candidates: [] }])
    await runToState(graph, 'c', {
      perception: p,
      exec: okExec,
      sourceId: 's',
      repair: { proposeState } as never,
      budget: { repairs: 0 },
    })
    expect(proposeState).not.toHaveBeenCalled()
  })

  it('起点即终点直接成功，一步都不走', async () => {
    const run = vi.fn(async () => ({ ok: true }))
    const p = scripted([{ states: ['c'], matched: [] }])
    const r = await runToState(graph, 'c', { perception: p, exec: { run }, sourceId: 's' })
    expect(r.outcome).toBe('reached')
    expect(run).not.toHaveBeenCalled()
  })

  it('没给 repair 时落空即失败，不抛错', async () => {
    const p = scripted([{ states: null, reason: 'no-match', candidates: [] }])
    const r = await runToState(graph, 'c', { perception: p, exec: okExec, sourceId: 's' })
    expect(r.outcome).toBe('stuck')
  })
})
