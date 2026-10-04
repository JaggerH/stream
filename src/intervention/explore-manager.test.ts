import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InterventionRunStore } from './run-store.ts'
import { ExploreManager, type ExploreManagerDeps } from './explore-manager.ts'
import { StateGraphStore } from '../replay/state-graph-store.ts'
import { ObservationLedger } from '../replay/observation-ledger.ts'
import { scriptedAgent, inProcess } from './__fixtures__/scripted-agent.ts'
import type { ExploreSurface } from './explore-surface.ts'
import type { EventInput } from '../events/store.ts'

/** 一屏什么都没有的假面：探索跑不动，但 run 活着——登记表那几条判据只关心活没活。 */
const idleSurface = (): ExploreSurface => ({
  side: 'browser',
  url: async () => 'https://a.example/home',
  inventory: async () => [],
  exists: async () => false,
  click: async () => false,
  back: async () => {},
  settle: async () => ({ settled: true, waitedMs: 0 }),
  scene: async () => ({ side: 'browser', elements: [] }),
  perceptionDriver: () => ({ currentUrl: async () => 'https://a.example/home', exists: async () => false }),
})

function mk(configured = true, over: Partial<ExploreManagerDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'em-'))
  const store = new InterventionRunStore(':memory:')
  const notes: EventInput[] = []
  // 永不结束的一轮：run 一直活着，`get` / `busy` 才有东西可判。
  const agent = scriptedAgent([() => new Promise(() => {})])
  const m = new ExploreManager({
    store,
    notify: (e) => notes.push(e),
    log: () => {},
    agentConfig: () => (configured
      ? { command: { command: 'fake', args: [] }, limits: { turns: 12, tokens: 1_000_000, wallMs: 60_000 } }
      : null),
    surface: () => idleSurface(),
    graphs: new StateGraphStore(join(dir, 'learned'), () => undefined),
    observations: new ObservationLedger(join(dir, 'obs')),
    llm: () => undefined,
    mcpEndpoint: () => undefined,
    mcpToolNames: () => [],
    openAgent: inProcess(agent.app),
    workRoot: join(dir, 'work'),
    draftDir: join(dir, 'drafts'),
    ...over,
  })
  return { store, notes, m }
}

const job = { facility: 'a', sourceId: 'a-home', target: 'chrome:1', goal: '到搜索页' }
const settle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('ExploreManager', () => {
  it('没配 agent → unconfigured，不建 run', () => {
    const { store, m } = mk(false)
    expect(m.start(job)).toBe('unconfigured')
    expect(store.list()).toHaveLength(0)
  })

  it('同一个 facility 第二次 → busy（一 facility 一条探索）', async () => {
    const { store, m } = mk()
    const r = m.start(job) as { runId: string }
    expect(r.runId).toBeTruthy()
    await settle()
    expect(m.start(job)).toBe('busy')
    // 换个 facility 不受影响
    expect(m.start({ ...job, facility: 'b', sourceId: 'b-home' })).toMatchObject({ runId: expect.any(String) })
    expect(store.list()).toHaveLength(2)
    await m.dispose()
  })

  it('get(runId)：活着有、终态后 sweep 摘掉；动作面对不存在的 run 一律 not-found', async () => {
    const { m } = mk()
    const { runId } = m.start(job) as { runId: string }
    await settle()
    expect(m.get(runId)).toBeDefined()
    expect(m.say(runId, '看看设置页')).toBe('ok')
    expect(m.answerPermission(runId, 'nope', 'x')).toBe('no-such-permission')
    expect(m.continue(runId)).toBe('not-paused')
    expect(await m.cancel(runId)).toBe('ok')
    expect(m.get(runId)).toBeUndefined()
    // 摘掉之后那个 facility 就不再 busy
    expect(m.start(job)).toMatchObject({ runId: expect.any(String) })
    expect(m.say('no-such-run', 'x')).toBe('not-found')
    expect(await m.cancel('no-such-run')).toBe('not-found')
    await m.dispose()
  })

  it('驾驭面取不到 → surface-unavailable，那条已经建出来的 run 如实标红（不留 queued 幽灵）', async () => {
    const { store, notes, m } = mk(true, { surface: () => { throw new Error('agent 域没起 / 扩展没连') } })
    expect(m.start(job)).toBe('surface-unavailable')
    // 行是基类在 super() 里写的，构造抛在那之后——捞出来标红，别留一条谁也推不动的「探索中」
    const runs = store.list({ sourceId: job.sourceId })
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('error')
    expect(runs[0]!.error).toMatchObject({ code: 'scene_unavailable' })
    expect(m.get(runs[0]!.id)).toBeUndefined()
    expect(notes.some((n) => n.type === 'intervention.error')).toBe(true)
    // 没被登记成 busy：修好扩展之后同一个 facility 还能再开
    expect(m.start({ ...job })).toBe('surface-unavailable')
  })

  it('dispose：活着的全部取消，登记清空', async () => {
    const { store, m } = mk()
    const { runId } = m.start(job) as { runId: string }
    await settle()
    await m.dispose()
    expect(m.get(runId)).toBeUndefined()
    expect(store.get(runId)!.status).toBe('cancelled')
  })
})
