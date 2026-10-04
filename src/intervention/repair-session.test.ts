import { describe, it, expect } from 'vitest'
import * as acp from '@agentclientprotocol/sdk'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InterventionRunStore } from './run-store.ts'
import { openAcpClient } from './acp-client.ts'
import { RepairSession, type RepairSessionDeps, type RepairJobInput } from './repair-session.ts'
import { scriptedAgent, inProcess, type Turn } from './__fixtures__/scripted-agent.ts'
import type { EventInput } from '../events/store.ts'

/**
 * 一份**真的过得了 `validateRecipe`** 的 `kind:'http'` recipe（任务书里那份夹具过不了，
 * 见 recipe-validation.test.ts 的同一条注释）。
 */
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

function harness(turns: Turn[], over: Partial<RepairSessionDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rs-'))
  const pkg = join(root, 'pkg')
  mkdirSync(pkg)
  writeFileSync(join(pkg, 'demo.recipe.json'), JSON.stringify(original))
  const store = new InterventionRunStore(':memory:')
  const notes: EventInput[] = []
  const agent = scriptedAgent(turns)
  const deps: RepairSessionDeps = {
    store,
    notify: (e) => notes.push(e),
    log: () => {},
    openAgent: inProcess(agent.app),
    mcpEndpoint: () => ({ url: 'http://127.0.0.1:8900/api/mcp', token: 'T' }),
    mcpToolNames: () => ['cdp_look'],
    workRoot: join(root, 'work'),
    idleTimeoutMs: 60_000,
    ...over,
  }
  const job: RepairJobInput = {
    sourceId: '@s/pkg/demo', localSourceId: 'demo', facility: 'pkg', packageDir: pkg,
    reason: 'no items', affectedSources: ['@s/pkg/demo'], failureShots: [],
    config: { command: { command: 'fake', args: [] }, limits: { turns: 12, tokens: 1_500_000, wallMs: 60_000 } },
  }
  return { store, notes, agent, deps, job, pkg }
}

const writeCandidate = (cwd: string, patch: Record<string, unknown>): void =>
  writeFileSync(join(cwd, 'demo.recipe.json'), JSON.stringify({ ...original, ...patch }))

const until = (p: () => boolean): Promise<void> =>
  new Promise<void>((r) => { const t = setInterval(() => { if (p()) { clearInterval(t); r() } }, 5) })

/** 和 `until` 一样等，但**自带上限**：判据永远不成立时要拿到一条具体的断言失败，
 *  而不是一次 5s 的用例超时（超时只会说"慢"，不会说"它根本没走到那一步"）。 */
const untilOr = async (p: () => boolean, ms = 2000): Promise<void> => {
  const t0 = Date.now()
  while (!p() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5))
}

describe('RepairSession', () => {
  it('干净完成：任务书 → agent 写 v5 → 校验过 → recipe 提议 pending，run done(proposal/end_turn)，事件配对', async () => {
    let seenTaskBook = ''
    const h = harness([async (cx) => {
      seenTaskBook = cx.text
      await cx.notify({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: '读文件', kind: 'read', status: 'in_progress' })
      await cx.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' })
      writeCandidate(cx.cwd, { version: 5, request: { url: 'https://a.example/v2', method: 'GET' } })
      await cx.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '把 url 换成 v2 了' } })
      return { stopReason: 'end_turn', usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 } }
    }])
    const s = new RepairSession(h.deps, h.job)
    await s.start()
    const run = h.store.get(s.runId)!
    expect(run.status).toBe('done')
    expect(run.stopped).toEqual({ produced: 'proposal', reason: 'end_turn' })
    expect(run.usage).toMatchObject({ promptTokens: 80, completionTokens: 20, turns: 1, reported: true })
    expect(run.agentSession).toMatchObject({ sessionId: 'S1', packageDir: h.pkg, localSourceId: 'demo' })
    expect(h.agent.cwd()).toBe(run.agentSession!.cwd)             // agent 的 cwd 是工作副本
    expect(h.agent.cwd()).not.toBe(h.pkg)
    expect(seenTaskBook).toContain('version 改成 5')
    const kinds = h.store.events(s.runId).map((e) => e.kind)
    expect(kinds).toEqual(expect.arrayContaining(['status_changed', 'tool_call', 'tool_result', 'message', 'proposal']))
    const p = h.store.proposals({ runId: s.runId })[0]!
    expect(p).toMatchObject({
      kind: 'recipe', status: 'pending', recipePath: join(h.pkg, 'demo.recipe.json'),
      validation: { schema: 'ok', version: 'ok', assertions: 'ok', probe: 'skipped-no-executor' },
    })
    expect((p.recipe as { version: number }).version).toBe(5)
    expect(readFileSync(join(h.pkg, 'demo.recipe.json'), 'utf8')).toContain('"version":4')   // 原包一个字没动
    expect(h.notes.some((n) => n.type === 'intervention.proposal')).toBe(true)
  })

  it('校验没过 → 回执当下一条 prompt，agent 改对后收尾；usage 缺席 reported:false', async () => {
    const prompts: string[] = []
    const h = harness([
      async (cx) => { prompts.push(cx.text); writeCandidate(cx.cwd, { version: 9 }); return { stopReason: 'end_turn' } },
      async (cx) => { prompts.push(cx.text); writeCandidate(cx.cwd, { version: 5 }); return { stopReason: 'end_turn' } },
    ])
    const s = new RepairSession(h.deps, h.job)
    await s.start()
    expect(prompts[1]).toContain('version 必须是 5')
    const run = h.store.get(s.runId)!
    expect(run.status).toBe('done')
    expect(run.usage).toMatchObject({ turns: 2, reported: false })
  })

  it('UNREPAIRABLE 标记 → verdict-unrepairable/end_turn，不落提议', async () => {
    const h = harness([async (cx) => {
      await cx.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'UNREPAIRABLE: 要登录' } })
      return { stopReason: 'end_turn' }
    }])
    const s = new RepairSession(h.deps, h.job)
    await s.start()
    expect(h.store.get(s.runId)!.stopped).toEqual({ produced: 'verdict-unrepairable', reason: 'end_turn' })
    expect(h.store.proposals({ runId: s.runId })).toHaveLength(0)
    expect(h.notes.some((n) => n.type === 'intervention.unrepairable')).toBe(true)
  })

  it('越界权限 → awaiting_confirmation + 通知；人答了 → 继续；读类自动放行不等人', async () => {
    let outcome = ''
    const h = harness([async (cx) => {
      const a = await cx.ask({ toolCallId: 'r', title: '读', kind: 'read' })
      expect(a.outcome.outcome).toBe('selected')
      const b = await cx.ask({ toolCallId: 'x', title: 'bash: rm -rf', kind: 'execute' })
      outcome = b.outcome.outcome === 'selected' ? b.outcome.optionId : 'cancelled'
      writeCandidate(cx.cwd, { version: 5 })
      return { stopReason: 'end_turn' }
    }])
    const s = new RepairSession(h.deps, h.job)
    const done = s.start()
    await until(() => s.status === 'awaiting_confirmation')
    const ev = h.store.events(s.runId).filter((e) => e.kind === 'permission_requested')
    expect(ev).toHaveLength(2)
    expect((ev[0]!.data as { auto: boolean }).auto).toBe(true)
    const pid = (ev[1]!.data as { permissionId: string }).permissionId
    expect(h.notes.some((n) => n.type === 'intervention.awaiting')).toBe(true)
    expect(s.answerPermission('nope', 'n')).toBe(false)
    expect(s.answerPermission(pid, 'n')).toBe(true)
    await done
    expect(outcome).toBe('n')
    expect(h.store.get(s.runId)!.status).toBe('done')
  })

  it('两个权限请求并发到达 → 各等各的，分别答，两边拿到各自的 optionId', async () => {
    const got: Record<string, string> = {}
    const h = harness([async (cx) => {
      const ask = async (id: string, yes: string, no: string): Promise<void> => {
        const r = await cx.ask(
          { toolCallId: id, title: `bash: ${id}`, kind: 'execute' },
          [{ optionId: yes, name: 'ok', kind: 'allow_once' }, { optionId: no, name: 'no', kind: 'reject_once' }],
        )
        got[id] = r.outcome.outcome === 'selected' ? r.outcome.optionId : 'cancelled'
      }
      // 并发：两条 request_permission 同时挂在客户端这一侧。
      const both = Promise.all([ask('a', 'yes-a', 'no-a'), ask('b', 'yes-b', 'no-b')])
      writeCandidate(cx.cwd, { version: 5 })
      await both
      return { stopReason: 'end_turn' }
    }])
    const s = new RepairSession(h.deps, h.job)
    const done = s.start()
    const asked = (): ReturnType<typeof h.store.events> => h.store.events(s.runId).filter((e) => e.kind === 'permission_requested')
    await until(() => asked().length === 2)
    const idOf = (callId: string): string => (asked().find((e) => e.callId === callId)!.data as { permissionId: string }).permissionId
    expect(s.status).toBe('awaiting_confirmation')
    expect(s.answerPermission(idOf('a'), 'yes-a')).toBe(true)
    // 第一条答完，第二条还挂着 → 仍然是等人，不许提前回 running
    expect(s.status).toBe('awaiting_confirmation')
    expect(s.answerPermission(idOf('b'), 'no-b')).toBe(true)
    await done
    expect(got).toEqual({ a: 'yes-a', b: 'no-b' })
    expect(h.store.get(s.runId)!.status).toBe('done')
  })

  it('等人时 cancel → 终态之后不许再冒出一条 running', async () => {
    const h = harness([async (cx) => {
      await cx.ask({ toolCallId: 'x', title: 'bash: rm -rf', kind: 'execute' })
      return { stopReason: 'end_turn' }
    }])
    const s = new RepairSession(h.deps, h.job)
    const done = s.start()
    await until(() => s.status === 'awaiting_confirmation')
    await s.cancel()
    await done
    const run = h.store.get(s.runId)!
    expect(run.stopped).toEqual({ produced: 'nothing', reason: 'cancelled' })
    const statuses = h.store.events(s.runId).filter((e) => e.kind === 'status_changed').map((e) => (e.data as { status: string }).status)
    // 一进等人态就再没有「在跑」了：权限被回掉那一刻的续接不许在收场路上补一条。
    expect(statuses.slice(statuses.indexOf('awaiting_confirmation'))).toEqual(['awaiting_confirmation', 'cancelled'])
    expect(statuses.at(-1)).toBe('cancelled')
  })

  it('同一动作连续 3 次 → paused(stuck)；continue() 后接着跑', async () => {
    let calls = 0
    const h = harness([
      async (cx) => {
        for (let i = 0; i < 3; i++) {
          await cx.notify({ sessionUpdate: 'tool_call', toolCallId: `c${i}`, title: 'cdp_look', name: 'cdp_look', kind: 'read', rawInput: { js: 'x' } })
        }
        calls++
        return { stopReason: 'end_turn' }
      },
      async (cx) => { calls++; writeCandidate(cx.cwd, { version: 5 }); return { stopReason: 'end_turn' } },
    ])
    const s = new RepairSession(h.deps, h.job)
    await s.start()
    expect(s.status).toBe('paused')
    expect(calls).toBe(1)
    expect(h.notes.some((n) => n.type === 'intervention.paused')).toBe(true)
    expect(s.continue()).toBe(true)
    await until(() => s.status === 'done')
    expect(calls).toBe(2)
  })

  it('轮数闸撞了 → paused(gate:turns)；不续直接 cancel → nothing/cancelled', async () => {
    const h = harness([async () => ({ stopReason: 'end_turn' })])
    h.job.config.limits.turns = 1
    const s = new RepairSession(h.deps, h.job)
    await s.start()
    expect(s.status).toBe('paused')
    const last = h.store.events(s.runId).filter((e) => e.kind === 'status_changed').at(-1)!
    expect((last.data as { gate?: string }).gate).toBe('turns')
    await s.cancel()
    expect(h.store.get(s.runId)!.stopped).toEqual({ produced: 'nothing', reason: 'cancelled' })
  })

  it('用户中途的话跟在校验回执后面、同一条 prompt 发出；一轮只带一条', async () => {
    const prompts: string[] = []
    const h = harness([
      async (cx) => { prompts.push(cx.text); writeCandidate(cx.cwd, { version: 9 }); return { stopReason: 'end_turn' } },
      async (cx) => { prompts.push(cx.text); return { stopReason: 'end_turn' } },
      async (cx) => { prompts.push(cx.text); writeCandidate(cx.cwd, { version: 5 }); return { stopReason: 'end_turn' } },
    ])
    const s = new RepairSession(h.deps, h.job)
    const p = s.start()
    s.say('选择器优先用 data-testid')
    s.say('别碰 pagination')
    await p
    // 回执在前、人话在同一条里跟着；两条人话分两轮发，不挤在一起。
    expect(prompts[1]).toContain('version 必须是 5')
    expect(prompts[1]).toContain('data-testid')
    expect(prompts[1]).not.toContain('别碰 pagination')
    expect(prompts[1]!.indexOf('version 必须是 5')).toBeLessThan(prompts[1]!.indexOf('data-testid'))
    expect(prompts[2]).toContain('别碰 pagination')
  })

  it('没配 MCP 端点 → session/new 的 mcpServers 为空，仍能跑（如实，不编）', async () => {
    const agent = scriptedAgent([async (cx) => { writeCandidate(cx.cwd, { version: 5 }); return { stopReason: 'end_turn' } }])
    const h = harness([], { mcpEndpoint: () => undefined, openAgent: inProcess(agent.app) })
    const s = new RepairSession(h.deps, h.job)
    await s.start()
    expect(agent.servers()).toEqual([])
    expect(h.store.get(s.runId)!.status).toBe('done')
  })

  it('配了 MCP 端点 → session/new 带上 http 那条，Authorization 是 Bearer', async () => {
    const h = harness([async (cx) => { writeCandidate(cx.cwd, { version: 5 }); return { stopReason: 'end_turn' } }])
    await new RepairSession(h.deps, h.job).start()
    expect(h.agent.servers()).toEqual([{
      type: 'http', name: 'stream', url: 'http://127.0.0.1:8900/api/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer T' }],
    }])
  })

  it('resume：session/load 重放的 update 不重复落事件；接着发一条「继续」', async () => {
    const h = harness([async (cx) => { writeCandidate(cx.cwd, { version: 5 }); return { stopReason: 'end_turn' } }])
    const first = new RepairSession(h.deps, h.job)
    // 造一个「跑到一半重启了」的 run：先 start 拿到 agentSession，再人为改回 paused
    await first.start()
    const run = h.store.get(first.runId)!
    h.store.markInterrupted(run.id, '后端重启')
    const before = h.store.events(run.id).length
    const replayThenPrompt = scriptedAgent(
      [async (cx) => { expect(cx.text).toContain('重启'); return { stopReason: 'end_turn' } }],
      { onLoad: async (cx) => { await cx.notify({ sessionUpdate: 'tool_call', toolCallId: 'old', title: '历史', kind: 'read' }) } },
    )
    const second = new RepairSession(
      { ...h.deps, openAgent: inProcess(replayThenPrompt.app) },
      h.job,
      { run: h.store.get(run.id)! },
    )
    await second.resume()
    expect(replayThenPrompt.loaded()).toBe(true)
    const after = h.store.events(run.id)
    expect(after.filter((e) => e.kind === 'tool_call' && e.title === '历史')).toHaveLength(0)
    expect(after.length).toBeGreaterThan(before)   // 有新 status_changed / proposal
    expect(h.store.get(run.id)!.status).toBe('done')
  })

  it('resume：agent 不申报 loadSession → agent_protocol，不硬着头皮 prompt', async () => {
    const h = harness([async () => ({ stopReason: 'end_turn' })])
    const first = new RepairSession(h.deps, h.job)
    await first.start()
    const run = h.store.get(first.runId)!
    const noLoad = scriptedAgent([async () => ({ stopReason: 'end_turn' })], { loadSession: false })
    const second = new RepairSession({ ...h.deps, openAgent: inProcess(noLoad.app) }, h.job, { run })
    await second.resume()
    expect(h.store.get(run.id)!.error?.code).toBe('agent_protocol')
    expect(noLoad.loaded()).toBe(false)
  })

  it('agent 起不来 → error(agent_spawn_failed)，通知一条', async () => {
    const h = harness([], {
      openAgent: () => ({
        initialize: () => Promise.reject(new Error('ENOENT')),
        newSession: () => Promise.reject(new Error('x')),
        loadSession: () => Promise.reject(new Error('x')),
        prompt: () => Promise.reject(new Error('x')),
        cancel: async () => {},
        close: () => {},
        closed: Promise.resolve(),
        exited: Promise.resolve({ code: null, signal: null }),
        kill: () => {},
      }),
    })
    const s = new RepairSession(h.deps, h.job)
    await s.start()
    expect(h.store.get(s.runId)!.error?.code).toBe('agent_spawn_failed')
    expect(h.notes.some((n) => n.type === 'intervention.error')).toBe(true)
  })

  it('看门狗：running 且超时没心跳 → agent_stalled', async () => {
    let t = 0
    const h = harness([async () => new Promise<acp.PromptResponse>(() => {})], { now: () => t, idleTimeoutMs: 1000 })
    const s = new RepairSession(h.deps, h.job)
    const p = s.start()
    await new Promise((r) => setTimeout(r, 20))
    t = 5000
    await new Promise((r) => setTimeout(r, 300))   // 看门狗 tick = idleTimeoutMs/10 = 100ms
    await p
    expect(h.store.get(s.runId)!.error?.code).toBe('agent_stalled')
    expect(h.notes.some((n) => n.type === 'intervention.error')).toBe(true)
  })

  it('plan / usage_update 各落一条，thought chunk 一个字不落库', async () => {
    const h = harness([async (cx) => {
      await cx.notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '我在想……' } })
      await cx.notify({ sessionUpdate: 'plan', entries: [
        { content: '看页面', priority: 'high', status: 'pending' },
        { content: '改选择器', priority: 'medium', status: 'pending' },
      ] })
      await cx.notify({ sessionUpdate: 'usage_update', used: 1200, size: 200_000 })
      writeCandidate(cx.cwd, { version: 5 })
      return { stopReason: 'end_turn' }
    }])
    const s = new RepairSession(h.deps, h.job)
    await s.start()
    const evs = h.store.events(s.runId)
    expect(evs.filter((e) => e.kind === 'usage')).toHaveLength(1)
    expect(evs.some((e) => e.kind === 'message' && e.title === '计划：2 项')).toBe(true)
    expect(evs.some((e) => JSON.stringify(e).includes('我在想'))).toBe(false)
  })

  /**
   * `continue()` 是同步返回 boolean 的，没有 promise 交给调用方——裸 `void this.runLoop(next)` 时
   * 主循环里任何一次抛都是**没有 handler 的 rejection**，Node 22 默认 `--unhandled-rejections=throw`，
   * 那就是 8900 那个后端连同它挂着的定时任务一起没了。
   */
  it('continue() 后主循环抛 → 记成 error(agent_protocol)，不留未处理的 rejection', async () => {
    const h = harness([async (cx) => { writeCandidate(cx.cwd, { version: 9 }); return { stopReason: 'end_turn' } }])
    h.job.config.limits.turns = 1
    let boom = false
    const brittle = Object.assign(Object.create(h.store) as InterventionRunStore, {
      addUsage(...a: Parameters<InterventionRunStore['addUsage']>) {
        if (boom) throw new Error('run 不存在：这一行没了')
        h.store.addUsage(...a)
      },
    })
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => { unhandled.push(e) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const s = new RepairSession({ ...h.deps, store: brittle }, h.job)
      await s.start()
      expect(s.status).toBe('paused')
      boom = true
      expect(s.continue()).toBe(true)
      await untilOr(() => s.status === 'error')
      await new Promise((r) => setTimeout(r, 20))   // 给 unhandledRejection 一个落地的机会
      expect(h.store.get(s.runId)!.error?.code).toBe('agent_protocol')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })

  /**
   * 收场时回掉的权限请求必须在时间线上留痕。前端认「还等着的那一条」的判据是
   * 「有 `permission_requested(auto:false)`、且没有同 `permissionId` 的 `permission_answered`」——
   * 不落的话那张审批卡永远匹配得上，而 ACP 那条请求其实早被我们回了 cancelled。
   */
  it('取消时把挂着的权限请求回掉，并为每条落一条 permission_answered(optionId:null)', async () => {
    const h = harness([async (cx) => {
      await Promise.all([
        cx.ask({ toolCallId: 'x', title: 'bash: a', kind: 'execute' }),
        cx.ask({ toolCallId: 'y', title: 'bash: b', kind: 'execute' }),
      ])
      return { stopReason: 'end_turn' }
    }])
    const s = new RepairSession(h.deps, h.job)
    const done = s.start()
    const asked = (): ReturnType<typeof h.store.events> => h.store.events(s.runId).filter((e) => e.kind === 'permission_requested')
    await until(() => asked().length === 2)
    const ids = asked().map((e) => (e.data as { permissionId: string }).permissionId)
    await s.cancel()
    await done
    const answered = h.store.events(s.runId).filter((e) => e.kind === 'permission_answered')
    expect(answered.map((e) => (e.data as { permissionId: string }).permissionId).sort()).toEqual([...ids].sort())
    expect(answered.every((e) => (e.data as { optionId: null; outcome: string }).optionId === null)).toBe(true)
    expect(answered.every((e) => (e.data as { outcome: string }).outcome === 'cancelled')).toBe(true)
  })

  /** `kill()` 发的是 SIGTERM，不保证进程一定死。不等、不补 SIGKILL = 后端退了而 agent 子进程还在。 */
  it('关停：子进程在宽限期内没走开 → 补一发 SIGKILL，cancel() 等到那时才返回', async () => {
    const signals: (string | undefined)[] = []
    const agent = scriptedAgent([async () => new Promise<acp.PromptResponse>(() => {})])
    const h = harness([], {
      closeGraceMs: 30,
      openAgent: (_cmd, handlers) => ({
        ...openAcpClient(agent.app, handlers),
        exited: new Promise(() => {}),                       // 这个子进程就是不肯死
        kill: (sig) => { signals.push(sig) },
      }),
    })
    const s = new RepairSession(h.deps, h.job)
    const done = s.start()
    await until(() => s.status === 'running')
    await s.cancel()
    expect(signals).toEqual([undefined, 'SIGKILL'])          // 先 SIGTERM，宽限期后 SIGKILL
    expect(h.store.get(s.runId)!.status).toBe('cancelled')
    await done
  })

  it('关停：子进程收到 SIGTERM 就走开了 → 不补 SIGKILL', async () => {
    const signals: (string | undefined)[] = []
    const agent = scriptedAgent([async () => new Promise<acp.PromptResponse>(() => {})])
    let resolveExit: (v: { code: number | null; signal: string | null }) => void = () => {}
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { resolveExit = r })
    const h = harness([], {
      closeGraceMs: 2000,
      openAgent: (_cmd, handlers) => ({
        ...openAcpClient(agent.app, handlers),
        exited,
        // 真子进程的 exit 是异步的：kill() 先返回，退出事件下一轮才到。
        kill: (sig) => { signals.push(sig); setTimeout(() => resolveExit({ code: 0, signal: 'SIGTERM' }), 0) },
      }),
    })
    const s = new RepairSession(h.deps, h.job)
    const done = s.start()
    await until(() => s.status === 'running')
    await s.cancel()
    expect(signals).toEqual([undefined])
    await done
  })

  /**
   * 有些 adapter 收到 `session/cancel` 就自己退了。`cancel()` 里 `terminal` 要到最后 `finish()`
   * 才置位，那个 await 窗口里子进程一走，`exited` 的 handler 会抢先落一条 `agent_crashed`——
   * **用户点的取消，界面上显示成 agent 崩了。**
   */
  it('取消途中子进程退出 → 仍是 cancelled，不记成 agent_crashed', async () => {
    const agent = scriptedAgent([async () => new Promise<acp.PromptResponse>(() => {})])
    let resolveExit: (v: { code: number | null; signal: string | null }) => void = () => {}
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { resolveExit = r })
    const h = harness([], {
      closeGraceMs: 30,
      openAgent: (_cmd, handlers) => {
        const c = openAcpClient(agent.app, handlers)
        return {
          ...c,
          // 收到 session/cancel 就退：退出事件落在 `finish()` 之前的那个 await 窗口里。
          cancel: async (sid: string) => {
            await c.cancel(sid)
            resolveExit({ code: 0, signal: null })
            await new Promise((r) => setTimeout(r, 10))
          },
          exited,
          kill: () => {},
        }
      },
    })
    const s = new RepairSession(h.deps, h.job)
    const done = s.start()
    await until(() => s.status === 'running')
    await s.cancel()
    const run = h.store.get(s.runId)!
    expect(run.status).toBe('cancelled')
    expect(run.error).toBeUndefined()
    expect(h.notes.some((n) => n.type === 'intervention.error')).toBe(false)
    await done
  })

  it('stopReason refusal → verdict-unrepairable，不落提议', async () => {
    const h = harness([async (cx) => { writeCandidate(cx.cwd, { version: 5 }); return { stopReason: 'refusal' } }])
    const s = new RepairSession(h.deps, h.job)
    await s.start()
    expect(h.store.get(s.runId)!.stopped).toEqual({ produced: 'verdict-unrepairable', reason: 'end_turn' })
    expect(h.store.proposals({ runId: s.runId })).toHaveLength(0)
  })
})
