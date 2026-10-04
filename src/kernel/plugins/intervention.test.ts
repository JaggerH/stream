import { describe, it, expect, vi } from 'vitest'
import { Context } from 'cordis'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interventionPlugin } from './intervention.ts'
import { settingsPlugin } from './settings.ts'

/**
 * 钉住一条活体撞出来的规则（2026-09-11）：**没写 inject 的插件读 `ctx.intervention` 不是拿到
 * undefined，是抛错** `cannot get property "intervention" without inject`。harvest / adapters 两个域
 * 装配得比介入域早、不能 inject 它，所以它们只能经 bootstrap 递进来的根 kernel thunk 现取。
 * 这条测试红了 = 有人又把 `ctx.intervention` 写回了早装配的域里。
 */
describe('介入域的跨域取法', () => {
  it('没 inject 的插件直接读 ctx.intervention 会抛，不是 undefined', async () => {
    const kernel = new Context()
    let caught: unknown
    await kernel.plugin({
      name: 'early-domain',
      apply(ctx: Context) {
        try {
          void ctx.intervention
        } catch (e) {
          caught = e
        }
      },
    })
    expect(String(caught)).toMatch(/without inject/)
  })

  it('从根 kernel 现取：挂上之前 undefined，挂上之后拿到真身', async () => {
    const kernel = new Context()
    const thunk = () => kernel.intervention
    expect(thunk()).toBeUndefined()
    const marker = { store: 1 } as unknown as Context['intervention']
    kernel.provide('intervention', marker)
    expect(thunk()).toBe(marker)
  })
})

/** 真 cordis + 假 llm/streamEvents/sources + 真 settings（指一个临时目录）。 */
async function mount(extra: Record<string, unknown> = {}): Promise<Context> {
  const dataDir = mkdtempSync(join(tmpdir(), 'iv-'))
  const kernel = new Context()
  kernel.provide('llm', { forTask: undefined } as unknown as Context['llm'])
  kernel.provide('streamEvents', undefined as unknown as Context['streamEvents'])
  kernel.provide('sources', {
    recipePackages: () => ({ byFacility: new Map(), list: [] }),
  } as unknown as Context['sources'])
  await kernel.plugin(settingsPlugin, { path: join(dataDir, 'settings.json') })
  await kernel.plugin(interventionPlugin, { dataDir, log: () => {}, ...extra })
  return kernel
}

/** 一个**不起任何进程**的 agent：`initialize()` 直接拒，run 随即落 error 收场。 */
const fakeOpenAgent = (onOpen?: (cmd: string) => void) => (cmd: { command?: string }) => {
  onOpen?.(cmd.command ?? '?')
  return {
    initialize: () => Promise.reject(new Error('fake agent：不起真进程')),
    exited: new Promise(() => {}),
    kill: () => {},
  }
}

describe('介入域挂载', () => {
  it('挂上后有 repairs，且 ai-agent 行已注册', async () => {
    const kernel = await mount()
    expect(kernel.intervention.repairs).toBeDefined()
    expect(kernel.settings.rows.has('ai-agent')).toBe(true)
    kernel.intervention.store.close()
  })

  it('没填命令 → manager 回 unconfigured（Broker 退回只落通知那条路）', async () => {
    const kernel = await mount()
    expect(kernel.intervention.repairs.start({ sourceId: '@s/p/x', reason: 'r' })).toBe('unconfigured')
    kernel.intervention.store.close()
  })

  it('用户在设置里填了命令 → 立刻生效（配置是现取的，不是装配期冻住的）', async () => {
    // **注入假 agent**：这条用例要的只是「配置这一格读到了」，不需要真起一个进程——原来靠
    // `spawnAcpAgent('fake-agent --acp')` 命令不存在来收场，那是在真 spawn 上赌一次失败。
    const kernel = await mount({ openAgent: fakeOpenAgent() })
    await kernel.settings.rows.put('ai-agent', { command: 'fake-agent --acp' })
    // 包表里没有这个源 → 如实开一条 error 的 run，而不是 unconfigured：说明配置这一格已经读到了
    const r = kernel.intervention.repairs.start({ sourceId: '@s/p/x', reason: 'r' })
    expect(typeof r).toBe('object')
    await vi.waitFor(() => expect(kernel.intervention.store.get((r as { runId: string }).runId)!.error?.code).toBe('agent_protocol'))
    kernel.intervention.store.close()
  })
})

/**
 * 这个域的两条会话都会 spawn 一个真 agent 子进程，而 qrun 的锁只管「同时只有一轮 vitest」——
 * 一条用例放生的子进程活到它自己算完为止（AGENTS.md 那条 20 个孤儿 npm 把 48GB 打穿的事故）。
 * 所以域上必须有 `openAgent` 这个注入点，且**真被用上**：这条用例钉的就是「起一条探索落在注入的
 * 那个 spawn 上」，改回写死 `spawnAcpAgent` 当场红。
 */
describe('agent 子进程的注入口', () => {
  it('探索起一条 → 落在注入的 openAgent 上，不碰真 spawn', async () => {
    const opened: string[] = []
    const kernel = await mount({
      openAgent: fakeOpenAgent((c) => opened.push(c)),
      // 探索面在 ExploreSession 的构造里就要 surface，所以 cdp 也得给一份假的（一个动词都不会被调到）。
      cdp: () => ({ look: async () => ({}), act: async () => ({}), shot: async () => ({ shot: null }) }),
    })
    await kernel.settings.rows.put('ai-agent', { command: 'never-spawned --acp' })

    const r = kernel.intervention.explorations.start({
      facility: 'xhs', sourceId: '@s/p/x', target: 'chrome:1', goal: '摸一遍',
    })
    expect(typeof r).toBe('object')
    const runId = (r as { runId: string }).runId
    await vi.waitFor(() => expect(kernel.intervention.store.get(runId)!.status).toBe('error'))

    expect(opened).toEqual(['never-spawned'])
    expect(kernel.intervention.store.get(runId)!.error?.code).toBe('agent_spawn_failed')
    kernel.intervention.store.close()
  })
})

/**
 * 动作面只有一张（`sessions`）：HTTP 那一层只认 runId，不知道这条 run 是修复还是探索。
 * 只问 repairs 的话，探索 run 的每一次「继续 / 取消 / 说一句」都回 404——而 404 读起来
 * 完全像「这条 run 已经结束了」，没有任何一处会喊。
 */
describe('两档会话的同一张动作面', () => {
  it('repairs 回 not-found → 转问 explorations，两处都没有才回 not-found', async () => {
    const kernel = await mount()
    const { sessions, explorations } = kernel.intervention
    const seen: string[] = []
    // 探索那一档此刻没有活会话（起一条要真 agent + 活标签页），所以这里换掉实例上的方法，
    // 钉的是**转发这件事本身**：facade 是调用时才问 explorations 的，不是装配期取了个快照。
    Object.assign(explorations, {
      answerPermission: (id: string) => (seen.push(`perm:${id}`), 'ok' as const),
      continue: (id: string) => (seen.push(`continue:${id}`), 'ok' as const),
      cancel: async (id: string) => (seen.push(`cancel:${id}`), 'ok' as const),
      say: (id: string) => (seen.push(`say:${id}`), 'ok' as const),
      resume: (id: string) => (seen.push(`resume:${id}`), 'not-resumable' as const),
    })

    expect(sessions.answerPermission('r9', 'p', 'o')).toBe('ok')
    expect(sessions.continue('r9')).toBe('ok')
    expect(await sessions.cancel('r9')).toBe('ok')
    expect(sessions.say('r9', 'hi')).toBe('ok')
    expect(sessions.resume('r9')).toBe('not-resumable')
    expect(seen).toEqual(['perm:r9', 'continue:r9', 'cancel:r9', 'say:r9', 'resume:r9'])

    kernel.intervention.store.close()
  })

  it('两档都没有这条 run → not-found（不许被哪一档吞成 ok）', async () => {
    const kernel = await mount()
    const { sessions } = kernel.intervention
    expect(sessions.continue('nope')).toBe('not-found')
    expect(sessions.say('nope', 'x')).toBe('not-found')
    expect(await sessions.cancel('nope')).toBe('not-found')
    expect(sessions.answerPermission('nope', 'p', 'o')).toBe('not-found')
    kernel.intervention.store.close()
  })
})
