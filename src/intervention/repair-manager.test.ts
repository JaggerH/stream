import { describe, it, expect } from 'vitest'
import * as acp from '@agentclientprotocol/sdk'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InterventionRunStore } from './run-store.ts'
import { openAcpClient, type AcpHandlers, type SpawnedAgent } from './acp-client.ts'
import { RepairManager, type RepairManagerDeps } from './repair-manager.ts'
import type { EventInput } from '../events/store.ts'
import type { RunStatus } from './types.ts'

/** 和 repair-session.test.ts 同一份：真过得了 `validateRecipe` 的 `kind:'http'` recipe。 */
const original = {
  version: 4,
  kind: 'http',
  sourceId: 'demo',
  request: { url: 'https://a.example/api', method: 'GET' },
  pagination: { mode: 'increment', param: 'page', start: 1, step: 1, itemsAt: 'items', maxPages: 1 },
  assert: [{ path: 'items', desc: 'items' }],
  mapping: { guid: 'id', title: 'title' },
  meta: { type: 'post', description: 'd', normalizer: 'generic' },
}

/** 进程内假 agent：每次 prompt 就把 v+1 写进 cwd，`session/load` 也认（resume 那条线要）。 */
function agentThatWritesV5(): acp.AgentApp {
  let cwd = ''
  return acp.agent({ name: 'a' })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
    }))
    .onRequest(acp.methods.agent.session.new, async (cx) => { cwd = cx.params.cwd; return { sessionId: 'S' } })
    .onRequest(acp.methods.agent.session.load, async (cx) => { cwd = cx.params.cwd; return {} })
    .onNotification(acp.methods.agent.session.cancel, async () => {})
    .onRequest(acp.methods.agent.session.prompt, async () => {
      writeFileSync(join(cwd, 'demo.recipe.json'), JSON.stringify({ ...original, version: 5 }))
      return { stopReason: 'end_turn' }
    })
}

const inProcess = (app: acp.AgentApp) => (_cmd: unknown, handlers: AcpHandlers): SpawnedAgent => ({
  ...openAcpClient(app, handlers),
  exited: new Promise(() => {}),
  kill: () => {},
})

function mk(configured = true, over: Partial<RepairManagerDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rm-'))
  const pkg = join(root, 'pkg')
  mkdirSync(pkg)
  writeFileSync(join(pkg, 'demo.recipe.json'), JSON.stringify(original))
  const store = new InterventionRunStore(':memory:')
  const notes: EventInput[] = []
  const m = new RepairManager({
    store,
    notify: (e) => notes.push(e),
    log: () => {},
    agentConfig: () => (configured
      ? { command: { command: 'fake', args: [] }, limits: { turns: 12, tokens: 1_500_000, wallMs: 60_000 } }
      : null),
    packageFor: (id) => (id === '@s/pkg/demo' ? { dir: pkg, facility: 'pkg' } : undefined),
    mcpEndpoint: () => undefined,
    mcpToolNames: () => [],
    failureShotsFor: () => [],
    openAgent: inProcess(agentThatWritesV5()),
    workRoot: join(root, 'work'),
    ...over,
  })
  return { store, notes, m, pkg }
}

const TERMINAL: RunStatus[] = ['done', 'error', 'cancelled', 'stopped']
const settle = (store: InterventionRunStore, runId: string): Promise<void> =>
  new Promise<void>((r) => {
    const t = setInterval(() => {
      const s = store.get(runId)!.status
      if (TERMINAL.includes(s) || s === 'paused') { clearInterval(t); r() }
    }, 5)
  })

describe('RepairManager', () => {
  it('没配 agent → unconfigured，不建 run', () => {
    const { store, m } = mk(false)
    expect(m.start({ sourceId: '@s/pkg/demo', reason: 'r' })).toBe('unconfigured')
    expect(store.list()).toHaveLength(0)
  })

  it('找不到包 → 建一条 error(agent_protocol) 的 run + 事件 + 通知，回执带 failed（如实，不静默）', () => {
    const { store, notes, m } = mk()
    const r = m.start({ sourceId: '@s/nope/x', reason: 'r' }) as { runId: string; failed?: true }
    expect(r.failed).toBe(true)
    const runId = r.runId
    expect(store.get(runId)!.error?.code).toBe('agent_protocol')
    // 这条 run 一建就是终态，没有后续事件会把人引到它跟前——所以必须当场喊一声
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ type: 'intervention.error', severity: 'error', dedupeKey: `intervention.error:${runId}:agent_protocol` })
    expect(store.events(runId).some((e) => e.kind === 'status_changed' && String(e.title).includes('agent_protocol'))).toBe(true)
    // 这条没有活会话：不该把这个源占住，下次还能再试
    expect(m.live(runId)).toBe(false)
    expect(typeof m.start({ sourceId: '@s/nope/x', reason: 'r' })).toBe('object')
  })

  it('开一条会话跑到 done；同源第二次 busy；跑完后 live=false', async () => {
    const { store, m } = mk()
    const r = m.start({ sourceId: '@s/pkg/demo', reason: 'r' }) as { runId: string }
    expect(m.start({ sourceId: '@s/pkg/demo', reason: 'r' })).toBe('busy')
    expect(m.live(r.runId)).toBe(true)
    await settle(store, r.runId)
    expect(store.get(r.runId)!.status).toBe('done')
    expect(m.live(r.runId)).toBe(false)
    expect(m.continue(r.runId)).toBe('not-found')
    // 终态之后同一个源可以再开一条
    expect(typeof m.start({ sourceId: '@s/pkg/demo', reason: 'r2' })).toBe('object')
  })

  it('启动时把 inFlight 收成 paused；paused 且有 agentSession 的可 resume', async () => {
    const { store, m } = mk()
    const r = m.start({ sourceId: '@s/pkg/demo', reason: 'r' }) as { runId: string }
    await settle(store, r.runId)
    // 人造一条「上次进程里没跑完」的
    store.setStatus(r.runId, 'running')
    expect(m.markInterruptedAtBoot()).toEqual({ paused: 1, failed: 0 })
    expect(store.get(r.runId)!.status).toBe('paused')
    expect(m.resume(r.runId)).toBe('ok')
    expect(m.resume(r.runId)).toBe('busy')
    await settle(store, r.runId)
    expect(store.get(r.runId)!.status).toBe('done')
  })

  /**
   * `prune()` 现在只裁终态的行，所以「收成 paused」这个动作等于宣称「有人还能推动它」。
   * 对续不上的 run 这句话是假的：`resume()` 一律回 `not-resumable`，前端控制条按 `kind === 'repair'`
   * 挡住了按钮——收成 paused 就是造一条永生的 run，每重启一次多攒一条，库只涨不消。
   */
  it('重启收尾分两档：只有带 agentSession 的 repair 收成 paused，runtime-ask 与裸 repair 收成终态 error', () => {
    const { store, m } = mk()
    const ask = store.create({ kind: 'runtime-ask', sourceId: '@s/pkg/demo', question: 'state' })
    store.setStatus(ask.id, 'running')
    const resumable = store.create({ kind: 'repair', sourceId: '@s/pkg/other' })
    store.setAgentSession(resumable.id, { command: 'fake', args: [], sessionId: 'S', cwd: '/w', packageDir: '/p', localSourceId: 'demo' })
    store.setStatus(resumable.id, 'running')
    const bare = store.create({ kind: 'repair', sourceId: '@s/pkg/bare' })
    store.setStatus(bare.id, 'awaiting_confirmation')

    expect(m.markInterruptedAtBoot()).toEqual({ paused: 1, failed: 2 })
    expect(store.get(ask.id)!.status).toBe('error')
    expect(store.get(ask.id)!.error).toMatchObject({ code: 'internal' })
    expect(store.get(bare.id)!.status).toBe('error')
    expect(store.get(resumable.id)!.status).toBe('paused')
    // 收成终态的那两条要在时间线上留痕，否则看起来停在上一个进程的最后一步。
    expect(store.events(ask.id).at(-1)).toMatchObject({ kind: 'status_changed', title: expect.stringContaining('internal') })
    // 终态了 → prune 收得走；paused 那条留着等人点「恢复」。
    expect(store.prune({ maxRuns: 0, maxAgeDays: 0 })).toBe(2)
    expect(store.get(resumable.id)).not.toBeNull()
  })

  it('resume：没有这条 run → not-found；不是 paused / 没有 agentSession → not-resumable', async () => {
    const { store, m } = mk()
    expect(m.resume('nope')).toBe('not-found')
    const r = m.start({ sourceId: '@s/pkg/demo', reason: 'r' }) as { runId: string }
    await settle(store, r.runId)
    expect(m.resume(r.runId)).toBe('not-resumable')           // done，不是 paused
    const bare = store.create({ kind: 'repair', sourceId: '@s/pkg/demo' })
    store.markInterrupted(bare.id, '重启')
    expect(m.resume(bare.id)).toBe('not-resumable')           // paused 但没有 agentSession
  })

  it('非 canonical browser 的 recipe：有执行器也不跑，如实记 skipped-no-executor（不是抛错、更不是不过）', async () => {
    let called = 0
    const { store, m } = mk(true, { probe: () => async () => { called++; return { outcome: 'ok', items: 1 } } })
    const r = m.start({ sourceId: '@s/pkg/demo', reason: 'r' }) as { runId: string }
    await settle(store, r.runId)
    expect(called).toBe(0)
    expect(store.get(r.runId)!.status).toBe('done')
    expect(store.proposals({ runId: r.runId })[0]!.validation!.probe).toBe('skipped-no-executor')
  })

  it('say / answerPermission / cancel 对不认识的 runId 一律 not-found', async () => {
    const { m } = mk()
    expect(m.say('nope', 'hi')).toBe('not-found')
    expect(m.answerPermission('nope', 'p', 'o')).toBe('not-found')
    await expect(m.cancel('nope')).resolves.toBe('not-found')
  })

  it('dispose：活着的会话全部取消，登记清空', async () => {
    // 永不回应的 agent：会话一直挂在 running，dispose 才收
    const hanging = acp.agent({ name: 'h' })
      .onRequest(acp.methods.agent.initialize, async () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
      .onRequest(acp.methods.agent.session.new, async () => ({ sessionId: 'S' }))
      .onNotification(acp.methods.agent.session.cancel, async () => {})
      .onRequest(acp.methods.agent.session.prompt, async () => new Promise<acp.PromptResponse>(() => {}))
    const { store, m } = mk(true, { openAgent: inProcess(hanging) })
    const r = m.start({ sourceId: '@s/pkg/demo', reason: 'r' }) as { runId: string }
    await new Promise((res) => setTimeout(res, 30))
    expect(m.live(r.runId)).toBe(true)
    await m.dispose()
    expect(m.live(r.runId)).toBe(false)
    expect(store.get(r.runId)!.status).toBe('cancelled')
  })
})
