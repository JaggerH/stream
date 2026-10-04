// src/mcp/tool-catalog.explore.test.ts
import { describe, it, expect } from 'vitest'
import { toolCatalog, type McpExtras } from './tool-catalog.ts'
import type { StreamService } from './tools.ts'

const fakeService = {} as StreamService

const GRAPH_TOOLS = ['graph_frontier', 'graph_act', 'graph_record_state', 'graph_back', 'graph_mark_irrelevant']

/** 只长出五个建图工具真正会调的那几个方法——多一个都不需要，接线错了当场是 typecheck 红。 */
function fakeSession() {
  const calls: Array<[string, unknown[]]> = []
  const rec = <T>(name: string, out: T) => (...a: unknown[]): T => (calls.push([name, a]), out)
  return {
    calls,
    session: {
      frontier: rec('frontier', Promise.resolve({ state: 'xhs/home', items: [], exhausted: false, blocked: 0 })),
      act: rec('act', Promise.resolve({ from: 'xhs/home', to: 'xhs/detail', effect: 'reversible', edgeRecorded: true })),
      recordState: rec('recordState', Promise.resolve({ ok: true, stateId: 'xhs/detail' })),
      back: rec('back', Promise.resolve({ at: 'xhs/home', how: 'edge' })),
      markIrrelevant: rec('markIrrelevant', { ok: true }),
    },
  }
}

const extrasWith = (get: (id: string) => unknown): McpExtras =>
  ({ explorations: () => ({ get }) } as unknown as McpExtras)

describe('toolCatalog — graph_* 五个建图工具', () => {
  it('explorations 缺席时五个都不注册——工具面上要么在要么不在，不留半个空壳', () => {
    const names = toolCatalog(fakeService, { isCommunitySource: () => false }).map((t) => t.name)
    for (const n of GRAPH_TOOLS) expect(names).not.toContain(n)
  })

  it('explorations 在场时五个都注册', () => {
    const names = toolCatalog(fakeService, extrasWith(() => undefined)).map((t) => t.name)
    for (const n of GRAPH_TOOLS) expect(names).toContain(n)
  })

  it('按 runId 找到活会话，五个动作逐个转发到它身上', async () => {
    const f = fakeSession()
    const cat = toolCatalog(fakeService, extrasWith((id) => (id === 'r1' ? f.session : undefined)))
    const tool = (n: string) => cat.find((t) => t.name === n)!

    expect(await tool('graph_frontier').run({ runId: 'r1' })).toMatchObject({ state: 'xhs/home' })
    expect(await tool('graph_act').run({ runId: 'r1', ref: 3, note: '试试详情' })).toMatchObject({ to: 'xhs/detail' })
    await tool('graph_record_state').run({ runId: 'r1', id: 'xhs/detail', features: [{ kind: 'url', pattern: '/detail' }], group: 'g', note: 'n' })
    await tool('graph_back').run({ runId: 'r1' })
    await tool('graph_mark_irrelevant').run({ runId: 'r1', state: 'xhs/ads' })

    expect(f.calls.map(([n]) => n)).toEqual(['frontier', 'act', 'recordState', 'back', 'markIrrelevant'])
    expect(f.calls[1]![1]).toEqual([3, '试试详情'])
    expect(f.calls[2]![1]).toEqual([{ id: 'xhs/detail', features: [{ kind: 'url', pattern: '/detail' }], group: 'g', note: 'n' }])
    expect(f.calls[4]![1]).toEqual(['xhs/ads'])
  })

  /**
   * run 不活时**回一句话，不抛**：抛出去模型只看到一句 tool error，读不出「这条 run 已经结束了」
   * 和「后端坏了」的差别，于是它会原样重试到烧完预算。那句话还得**指对库**——探索 run 住
   * `interventions.db`，`get_agent_run` 读的是搜索 agent 那一本，指过去只会再拿一句「没这条 run」。
   */
  it('runId 不在登记表里 → 回 { error }（叫它别重试、指向 /api/interventions），不抛', async () => {
    const cat = toolCatalog(fakeService, extrasWith((id) => (id === 'r1' ? fakeSession().session : undefined)))
    for (const n of GRAPH_TOOLS) {
      const out = (await cat.find((t) => t.name === n)!.run({ runId: 'nope', ref: 1, id: 'x/y', features: [], state: 's' })) as { error?: string }
      expect(out.error).toMatch(/不要重试/)
      expect(out.error).toContain('/api/interventions/nope')
      expect(out.error).not.toContain('get_agent_run')
    }
  })
})
