import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EventInput } from '../events/store.ts'
import type { RepairJob } from '../replay/repair-runner.ts'
import { localNameOf } from '../registry/source-id.ts'
import { spawnAcpAgent } from './acp-client.ts'
import type { AgentConfig } from './agent-config.ts'
import { RepairSession, type ProbeRunner, type RepairSessionDeps } from './repair-session.ts'
import type { InterventionRunStore } from './run-store.ts'
import { TERMINAL_RUN_STATUSES } from './types.ts'

export interface RepairManagerDeps {
  store: InterventionRunStore
  notify: (e: EventInput) => void
  log: (...a: unknown[]) => void
  /** 现取配置行：用户运行期填了命令就该立刻生效，装配期取一次等于永远没配。 */
  agentConfig: () => AgentConfig | null
  /** 现取包表：`stream add` 热挂载之后新装的包也要能修。 */
  packageFor: (sourceId: string) => { dir: string; facility: string } | undefined
  mcpEndpoint: () => { url: string; token: string } | undefined
  mcpToolNames: () => string[]
  /** 和 `RepairSessionDeps.probe` 同一个形状：**thunk**，执行器可能比这条 run 晚到。 */
  probe?: () => ProbeRunner | undefined
  failureShotsFor: (localSourceId: string) => string[]
  /** 生产缺省 = `spawnAcpAgent`；测试注入进程内假 agent。 */
  openAgent?: RepairSessionDeps['openAgent']
  workRoot: string
}

/** 人还能在上面做事的状态（paused 也算活着：他随时可以点「继续」）。
 *  和 `prune()` 共用同一份名单——两处各写各的，一边就会把还活着的 run 当死的收掉。 */
const TERMINAL = TERMINAL_RUN_STATUSES

/**
 * 这份 recipe 跑不跑得了活体 probe。今天只有 canonical browser 档跑得了（执行器就是采集那条路）；
 * V1 `BrowserRecipe`（有 `actions` 没 `steps`）、http / html / desktop 都跑不了。
 */
export function isCanonicalBrowserRecipe(recipe: unknown): boolean {
  const r = recipe as { kind?: unknown; steps?: unknown } | null
  return !!r && r.kind === 'browser' && Array.isArray(r.steps)
}

/**
 * 活着的修复会话登记处（spec §6.6 露面的落点、§5.2 的入口）。**一源一会话**：同一个源被隔离
 * 一次只该有一个 agent 在修，第二次触发回 `busy`——`requestRepair` 只在进入隔离那一刻发一次，
 * 但人手动重跑、或两个 Broker 实例（测试）都可能再敲。
 *
 * 所有依赖都是 thunk：配置行、包表、MCP 端点在进程生命期里都会变
 * （AGENTS.md「装配期取的值 = 冻住的答案」）。
 *
 * **摘除靠懒扫，不靠回调。** `RepairSession.continue()` 是同步返回 boolean 的——它把主循环
 * 放出去就走，没有一个可以 `.finally()` 的 promise 给我们；只挂 `start()`/`resume()` 的 finally
 * 的话，一条「暂停 → 人点继续 → 跑完」的 run 会永远留在登记表里，把它那个源永久占成 `busy`。
 * 所以每个公开口进来先扫一遍：store 里已是终态的条目当场摘掉。store 是权威，实例不是。
 */
export class RepairManager {
  private readonly sessions = new Map<string, RepairSession>()   // runId → session
  private readonly bySource = new Map<string, string>()          // sourceId → runId

  constructor(private readonly deps: RepairManagerDeps) {}

  private sessionDeps(recipePath: string): RepairSessionDeps {
    const probe = this.probeThunk(recipePath)
    return {
      store: this.deps.store,
      notify: this.deps.notify,
      log: this.deps.log,
      openAgent: this.deps.openAgent ?? ((cmd, handlers, cwd) => spawnAcpAgent(cmd, handlers, { cwd })),
      mcpEndpoint: this.deps.mcpEndpoint,
      mcpToolNames: this.deps.mcpToolNames,
      ...(probe ? { probe } : {}),
      workRoot: this.deps.workRoot,
    }
  }

  /**
   * 这条 run 的活体 probe 拿不拿得到执行器。**「这一档跑不了」必须在这儿判成「拿不到执行器」**，
   * 不能留到执行器里抛：`validateCandidate` 把抛错记成 `活体 probe 抛错` 且**判不过**，于是一条
   * http recipe 的修复会永远卡在同一轮回执上（而 recipe 本身是对的）。回 undefined 才是如实的
   * `skipped-no-executor`——没跑，不是没过。
   *
   * 判据取**原包那份**的档次：候选和它同一个 `sourceId` 同一个 kind（换了 kind 过不了 schema）。
   * 读不到就当跑不了——跳过一次实测，比拿一个读不出的文件去判「它不过」轻得多。
   *
   * **每轮重读磁盘是被冻结接口逼的，不是有意为之**：`RepairSession` 早就把同一个文件 parse 进
   * 自己的 `original` 了，但这个 thunk 不带参数、够不到 session 的状态。代价要说清：那个文件中途
   * 变得读不出时，这里会**静默**把 probe 降成 `skipped`，而 session 手里明明还有一份好的。
   * 将来 `repair-session.ts` 解冻，这两处该收敛成一处（把 original 递给 probe 的取法）。
   */
  private probeThunk(recipePath: string): (() => ProbeRunner | undefined) | undefined {
    const outer = this.deps.probe
    if (!outer) return undefined
    return () => {
      let original: unknown
      try { original = JSON.parse(readFileSync(recipePath, 'utf8')) } catch { return undefined }
      return isCanonicalBrowserRecipe(original) ? outer() : undefined
    }
  }

  /** 登记表对账：store 说终态的条目摘掉。每个公开口的第一行。 */
  private sweep(): void {
    for (const runId of [...this.sessions.keys()]) {
      const status = this.deps.store.get(runId)?.status
      // 行没了也算终态：`prune()` 只裁终态的 run（它读同一份 `TERMINAL_RUN_STATUSES`），
      // 所以读不到行 = 这条 run 早已走完终态那条路、自己 `closeAgent()` 过了。
      if (status === undefined || TERMINAL.includes(status)) this.drop(runId)
    }
  }

  /** 只摘登记，**不做收尾**：走到终态的那条路（`finish` / `failRun` / `cancel`）自己已经
   *  `closeAgent()` 了，这里再关一次只会掩盖「谁该负责关」这个问题。 */
  private drop(runId: string): void {
    this.sessions.delete(runId)
    for (const [src, id] of this.bySource) if (id === runId) this.bySource.delete(src)
  }

  private track(sourceId: string, s: RepairSession): void {
    this.sessions.set(s.runId, s)
    this.bySource.set(sourceId, s.runId)
  }

  /** start()/resume() 的 promise 收尾时调：paused / awaiting 仍算活着，终态才摘。 */
  private untrackIfSettled(s: RepairSession): void {
    if (!TERMINAL.includes(s.status)) return
    this.drop(s.runId)
  }

  /**
   * 配了 agent 且该源没有活会话 → 开一条 run；没配 → `unconfigured`；已有活会话 → `busy`；
   * 包找不到 → 一条**已经标错**的 run（`failed: true`）。
   *
   * 第四档不能和正常那档共用 `{runId}`：调用方看到 `{runId}` 会说「开了修复会话」，
   * 而实际上那条 run 一建就是红的、没有任何 agent 在跑——**一条说反了的日志比没有日志更坏**。
   */
  start(job: RepairJob): 'unconfigured' | 'busy' | { runId: string; failed?: true } {
    this.sweep()
    const config = this.deps.agentConfig()
    if (!config) return 'unconfigured'
    if (this.bySource.has(job.sourceId)) return 'busy'
    const local = localNameOf(job.sourceId)
    const pkg = this.deps.packageFor(job.sourceId)
    if (!pkg) {
      // 如实开一条 error 的 run，而不是静默返回：「没找到包」和「没配 agent」是两种红，
      // 压成同一个回执会把「这个源的包被卸了」显示成「你还没填 ai-agent」。
      //
      // **落库之外还要通知**：这条 run 一建就是终态，没有任何后续事件会把人引到它跟前——
      // 只写库的话，界面上只是多了一条谁也不会去点开的红记录，而那个源从此不再被修。
      const message = `找不到 ${job.sourceId} 所在的 recipe 包，修不了`
      const run = this.deps.store.create({ kind: 'repair', sourceId: job.sourceId })
      this.deps.store.fail(run.id, { code: 'agent_protocol', message })
      this.deps.store.appendEvent(run.id, {
        kind: 'status_changed',
        title: '出错：agent_protocol',
        data: { status: 'error', code: 'agent_protocol', message },
      })
      this.deps.notify({
        type: 'intervention.error',
        severity: 'error',
        title: `${job.sourceId}：agent 修复没跑成（agent_protocol）`,
        body: message,
        dedupeKey: `intervention.error:${run.id}:agent_protocol`,
        ref: { kind: 'stream', id: job.sourceId },
        detail: `runId=${run.id}`,
      })
      this.deps.log(`[intervention] repair ${run.id} agent_protocol: ${message}`)
      return { runId: run.id, failed: true }
    }
    const session = new RepairSession(this.sessionDeps(join(pkg.dir, `${local}.recipe.json`)), {
      sourceId: job.sourceId,
      localSourceId: local,
      facility: pkg.facility,
      packageDir: pkg.dir,
      reason: job.reason,
      affectedSources: job.affectedSources ?? [job.sourceId],
      failureShots: this.deps.failureShotsFor(local),
      config,
    })
    this.track(job.sourceId, session)
    void session.start().finally(() => this.untrackIfSettled(session))
    return { runId: session.runId }
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

  /** 重启后：paused 且带 agentSession 的 run 可以续（`session/load`）。 */
  resume(runId: string): 'ok' | 'not-found' | 'not-resumable' | 'busy' {
    this.sweep()
    if (this.sessions.has(runId)) return 'busy'
    const run = this.deps.store.get(runId)
    if (!run) return 'not-found'
    const sess = run.agentSession
    const config = this.deps.agentConfig()
    if (run.status !== 'paused' || !sess || !config) return 'not-resumable'
    if (this.bySource.has(run.sourceId)) return 'busy'
    const pkg = this.deps.packageFor(run.sourceId)
    const session = new RepairSession(this.sessionDeps(join(sess.packageDir, `${sess.localSourceId}.recipe.json`)), {
      sourceId: run.sourceId,
      localSourceId: sess.localSourceId,
      // 包可能已经被卸了；会话句柄里的路径才是这条 run 当时用的那份，facility 退回局部名。
      facility: pkg?.facility ?? sess.localSourceId,
      packageDir: sess.packageDir,
      reason: '（续）',
      affectedSources: [run.sourceId],
      failureShots: [],
      config,
    }, { run })
    this.track(run.sourceId, session)
    void session.resume().finally(() => this.untrackIfSettled(session))
    return 'ok'
  }

  /**
   * 启动时收掉上一个进程留下的在飞 run。**分两档，不是一律 paused**：
   *
   * - **续得上的**（`kind:'repair'` 且带 `agentSession`）→ `paused`，等人在该源的修复页点「继续」（后端会退回 `resume`）。
   *   **不自动续**：那些 run 的 agent 进程早没了，自动拉起来等于用户没点过任何东西就开始烧 token。
   * - **续不上的**（`runtime-ask`／`explore`，或没留下会话句柄的 repair）→ 收成**终态** error。
   *   `resume()` 对它们一律回 `not-resumable`，前端控制条也按 `kind === 'repair'` 挡住了按钮——
   *   收成 paused 就是造一条**永生**的 run：没有人能推动它，而 `prune()` 现在只裁终态的行，
   *   于是它永远躺在库里，每重启一次多攒一条，库只涨不消。
   *
   * 返回两档各几条——**两个数分开报**：一条「N 条已暂停」的日志说不出「另有 M 条根本续不了」。
   */
  markInterruptedAtBoot(): { paused: number; failed: number } {
    const out = { paused: 0, failed: 0 }
    for (const r of this.deps.store.inFlight()) {
      if (r.kind === 'repair' && r.agentSession) {
        this.deps.store.markInterrupted(r.id, '后端重启，agent 进程没了；点「恢复」用 session/load 接着修')
        out.paused++
        continue
      }
      const message = '后端重启，这条 run 没有可续的会话'
      this.deps.store.fail(r.id, { code: 'internal', message })
      // 和 `RepairSession.failRun` 一样补一条事件：只改状态的话，时间线上这条 run 停在
      // 上一个进程的最后一步，读的人看不出它是被重启收掉的。
      this.deps.store.appendEvent(r.id, { kind: 'status_changed', title: '出错：internal', data: { status: 'error', code: 'internal', message } })
      out.failed++
    }
    return out
  }

  live(runId: string): boolean {
    this.sweep()
    return this.sessions.has(runId)
  }

  /** 关停：活着的全部取消（子进程跟着走），登记清空。 */
  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.cancel().catch(() => {})))
    this.sessions.clear()
    this.bySource.clear()
  }
}
