import type { EventInput } from '../events/store.ts'
import { spawnAcpAgent } from './acp-client.ts'
import type { AgentConfig } from './agent-config.ts'
import { DEFAULT_EXPLORE_LIMITS, ExploreSession, type ExploreJobInput, type ExploreSessionDeps } from './explore-session.ts'
import type { InterventionRunStore } from './run-store.ts'
import { TERMINAL_RUN_STATUSES } from './types.ts'

export interface ExploreManagerDeps {
  store: InterventionRunStore
  notify: (e: EventInput) => void
  log: (...a: unknown[]) => void
  /** 现取配置行：用户运行期填了命令就该立刻生效，装配期取一次等于永远没配。 */
  agentConfig: () => AgentConfig | null
  surface: ExploreSessionDeps['surface']
  graphs: ExploreSessionDeps['graphs']
  observations: ExploreSessionDeps['observations']
  llm: ExploreSessionDeps['llm']
  mcpEndpoint: ExploreSessionDeps['mcpEndpoint']
  mcpToolNames: ExploreSessionDeps['mcpToolNames']
  /** 生产缺省 = `spawnAcpAgent`；测试注入进程内假 agent。 */
  openAgent?: ExploreSessionDeps['openAgent']
  workRoot: string
  draftDir: string
  /** 三闸里由本期定的那两个（第三个是 `ai-agent` 行的 maxWallMinutes，随 config 走）。 */
  defaultLimits?: ExploreJobInput['limits']
}

export type ExploreStartInput = Omit<ExploreJobInput, 'config' | 'limits'> & { limits?: Partial<ExploreJobInput['limits']> }

const TERMINAL = TERMINAL_RUN_STATUSES

/**
 * 活着的探索会话登记处（spec §6）。形状照 `RepairManager`——**同一份判据、同一套摘除方式**：
 * 两处各写各的，一边就会把还活着的 run 当死的收掉。
 *
 * **一 facility 一条探索**（不是一源一条）：探索建的是整个 facility 的状态图，两条并行就是
 * 两个 agent 在同一张标签页上抢着点，而它们互相看不见对方的草稿——图会各缺一半，且两边都不报错。
 *
 * 摘除靠懒扫不靠回调：`continue()` 同步返回 boolean，没有 promise 可挂 `.finally()`，
 * 只挂 `start()` 的话「暂停 → 人点继续 → 跑完」的 run 会永远占着那个 facility。
 */
export class ExploreManager {
  private readonly sessions = new Map<string, ExploreSession>()   // runId → session
  private readonly byFacility = new Map<string, string>()         // facility → runId

  constructor(private readonly deps: ExploreManagerDeps) {}

  private sessionDeps(): ExploreSessionDeps {
    return {
      store: this.deps.store,
      notify: this.deps.notify,
      log: this.deps.log,
      openAgent: this.deps.openAgent ?? ((cmd, handlers, cwd) => spawnAcpAgent(cmd, handlers, { cwd })),
      mcpEndpoint: this.deps.mcpEndpoint,
      mcpToolNames: this.deps.mcpToolNames,
      workRoot: this.deps.workRoot,
      draftDir: this.deps.draftDir,
      surface: this.deps.surface,
      graphs: this.deps.graphs,
      observations: this.deps.observations,
      llm: this.deps.llm,
    }
  }

  /** 登记表对账：store 说终态的条目摘掉。每个公开口的第一行。store 是权威，实例不是。 */
  private sweep(): void {
    for (const runId of [...this.sessions.keys()]) {
      const status = this.deps.store.get(runId)?.status
      // 行没了也算终态：`prune()` 只裁终态的 run，读不到行 = 这条 run 早已走完终态那条路。
      if (status === undefined || TERMINAL.includes(status)) this.drop(runId)
    }
  }

  /** 只摘登记，**不做收尾**：走到终态的那条路自己已经 `closeAgent()` 了。 */
  private drop(runId: string): void {
    this.sessions.delete(runId)
    for (const [f, id] of this.byFacility) if (id === runId) this.byFacility.delete(f)
  }

  private track(facility: string, s: ExploreSession): void {
    this.sessions.set(s.runId, s)
    this.byFacility.set(facility, s.runId)
  }

  private untrackIfSettled(s: ExploreSession): void {
    if (!TERMINAL.includes(s.status)) return
    this.drop(s.runId)
  }

  start(job: ExploreStartInput): 'unconfigured' | 'busy' | 'surface-unavailable' | { runId: string } {
    this.sweep()
    const config = this.deps.agentConfig()
    if (!config) return 'unconfigured'
    if (this.byFacility.has(job.facility)) return 'busy'
    const base = this.deps.defaultLimits ?? DEFAULT_EXPLORE_LIMITS
    let session: ExploreSession
    try {
      session = new ExploreSession(this.sessionDeps(), {
        ...job,
        config,
        limits: { maxStates: job.limits?.maxStates ?? base.maxStates, maxDepth: job.limits?.maxDepth ?? base.maxDepth },
      })
    } catch (e) {
      // **构造就抛**（驾驭面取不到 / target 形状不对）：基类在 super() 里**已经把 run 行写进库了**，
      // 而这里的异常发生在那之后——不接住的话那条 run 永远停在 `queued`，界面上就是一条
      // 「正在探索」而其实什么都没起来的幽灵，谁也推不动它。捞出这条行、如实标红。
      this.failStillbornRun(job, e)
      return 'surface-unavailable'
    }
    this.track(job.facility, session)
    void session.start().finally(() => this.untrackIfSettled(session))
    return { runId: session.runId }
  }

  /**
   * 收拾一条「行已经建了、会话没建起来」的死胎 run。
   *
   * **只能靠捞**：run id 是基类在 `super()` 里生成的，构造抛出来时我们手上没有它。判据取
   * 「这个 sourceId 上最新那条还在 `queued` 的 explore run」——`queued` 只存在于建行到第一次
   * `setStatus('running')` 之间的那一瞬，而同 facility 已被 `busy` 挡住，不会有第二条在飞。
   * 捞不到就只发通知不落库：**宁可少标一条，也不要把别人的 run 标红**。
   */
  private failStillbornRun(job: ExploreStartInput, e: unknown): void {
    const message = `探索起不来：${e instanceof Error ? e.message : String(e)}`
    const row = this.deps.store.list({ sourceId: job.sourceId, status: ['queued'], limit: 5 })
      .find((r) => r.kind === 'explore' && !this.sessions.has(r.id))
    if (row) {
      // `scene_unavailable`（「拿不到现场」）而不是 `agent_unconfigured`：`ai-agent` 那一行**是配了的**
      // （上面刚读过），报成没配会把人支去改一个没问题的配置。
      this.deps.store.fail(row.id, { code: 'scene_unavailable', message })
      this.deps.store.appendEvent(row.id, { kind: 'status_changed', title: '出错：scene_unavailable', data: { status: 'error', code: 'scene_unavailable', message } })
    }
    this.deps.notify({
      type: 'intervention.error',
      severity: 'error',
      title: `${job.facility}：探索没起来（拿不到浏览器驾驭面）`,
      body: message,
      dedupeKey: `intervention.error:${row?.id ?? job.facility}:scene_unavailable`,
      ref: { kind: 'stream', id: job.sourceId },
      ...(row ? { detail: `runId=${row.id}` } : {}),
    })
    this.deps.log(`[intervention] explore ${row?.id ?? '(无行)'} scene_unavailable: ${message}`)
  }

  /** 建图工具经它现取会话（`ctx.intervention.explorations.get(runId)`）——不活就报「run 不活」，不补空实现。 */
  get(runId: string): ExploreSession | undefined {
    this.sweep()
    return this.sessions.get(runId)
  }

  answerPermission(runId: string, permissionId: string, optionId: string): 'ok' | 'not-found' | 'no-such-permission' {
    this.sweep()
    const s = this.sessions.get(runId)
    if (!s) return 'not-found'
    return s.answerPermission(permissionId, optionId) ? 'ok' : 'no-such-permission'
  }

  continue(runId: string): 'ok' | 'not-found' | 'not-paused' {
    this.sweep()
    const s = this.sessions.get(runId)
    if (!s) return 'not-found'
    return s.continue() ? 'ok' : 'not-paused'
  }

  async cancel(runId: string): Promise<'ok' | 'not-found'> {
    this.sweep()
    const s = this.sessions.get(runId)
    if (!s) return 'not-found'
    await s.cancel()
    this.untrackIfSettled(s)
    return 'ok'
  }

  say(runId: string, text: string): 'ok' | 'not-found' {
    this.sweep()
    const s = this.sessions.get(runId)
    if (!s) return 'not-found'
    s.say(text)
    return 'ok'
  }

  /**
   * 重启后续上一条探索——**今天一条都续不了，如实回 `not-resumable`**，不是忘了写。
   *
   * 两个理由，都不是「以后补」能绕过去的：
   * 1. `RepairManager.markInterruptedAtBoot()` 把非 repair 的在飞 run **收成终态 error**（它带着
   *    理由：那些 run 没有可续的会话）。所以重启之后没有任何一条 explore run 还是 `paused`，
   *    这条路根本走不到。
   * 2. 更要紧的是**「我在哪」是内存里的信念**：`current` / `pendingEdge` / 那张标签页此刻停在哪一屏，
   *    重启后三样都没了。带着一个陈旧的信念续上去，接下来每一步都点在错的屏上——而它不会崩，
   *    只会把一张错的图探完交给人。要真续得上，得先在活页面上重认一遍，那是另一件事。
   *
   * 留着这个方法是为了**动作面和 `RepairManager` 对齐**（HTTP 那一层一个形状调两处），
   * 不是留一个能返回 `'ok'` 的空壳。
   */
  resume(runId: string): 'ok' | 'not-found' | 'not-resumable' | 'busy' {
    this.sweep()
    if (this.sessions.has(runId)) return 'busy'
    return this.deps.store.get(runId) ? 'not-resumable' : 'not-found'
  }

  live(runId: string): boolean {
    this.sweep()
    return this.sessions.has(runId)
  }

  /** 关停：活着的全部取消（子进程跟着走），登记清空。 */
  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.cancel().catch(() => {})))
    this.sessions.clear()
    this.byFacility.clear()
  }
}
