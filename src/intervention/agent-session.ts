import { randomUUID } from 'node:crypto'
import type * as acp from '@agentclientprotocol/sdk'
import type { EventInput } from '../events/store.ts'
import type { AcpHandlers, SpawnedAgent } from './acp-client.ts'
import type { AgentCommand, AgentGateLimits } from './agent-config.ts'
import { pickOption, type ApprovalDecision } from './approval.ts'
import { RepairGates, type GateName } from './gates.ts'
import type { InterventionRunStore } from './run-store.ts'
import { StuckDetector } from './stuck.ts'
import { parseUnrepairable } from './task-book.ts'
import type { AgentSession, RunEvent, RunEventKind, RunKind, RunRecord, RunStatus, StopProduced, StopReason } from './types.ts'

export interface AgentSessionDeps {
  store: InterventionRunStore
  notify: (e: EventInput) => void
  log: (...a: unknown[]) => void
  /** 生产 = `spawnAcpAgent`；测试 = 进程内假 agent。 */
  openAgent: (cmd: AgentCommand, handlers: AcpHandlers, cwd: string) => SpawnedAgent
  mcpEndpoint: () => { url: string; token: string } | undefined
  mcpToolNames: () => string[]
  now?: () => number
  /** 默认 600_000。 */
  idleTimeoutMs?: number
  /** 关停时等子进程自己走开多久，超时改发 SIGKILL。默认 5000。 */
  closeGraceMs?: number
  /** `<dataDir>/repair-work` */
  workRoot: string
}

/** 一条 run 的身份与外观：建库那一行、通知文案里的主语、事件的归属、闸的初始刻度。 */
export interface AgentSessionInit {
  kind: RunKind
  sourceId: string
  /** agent 子进程的启动命令（`openAgentOrFail` 用）。 */
  command: AgentCommand
  limits: AgentGateLimits
  /** 通知标题里的主语。 */
  label: string
  /** 通知挂到哪条流上。 */
  ref: { kind: 'stream'; id: string }
  /** 通知文案里的名词（如「修复」），拼进「XX暂停」「agent XX没跑成」。 */
  noun: string
}

const STDERR_CAP = 200
const DEFAULT_IDLE_MS = 600_000
const DEFAULT_CLOSE_GRACE_MS = 5_000

export type FinishReason = Exclude<StopReason, 'error'>

/**
 * 一条 agent run 的编排骨架（spec §5.2 / §6）。**一个实例 = 一条 run**；活着的实例由 manager 登记，
 * HTTP 动作（答权限 / 继续 / 取消 / 发消息）经 manager 找到实例再调这里的方法。
 *
 * 它不认识 ACP 的传输（acp-client.ts）、不认识 cordis（repair-manager.ts）。所有对外副作用只有三种：
 * 写 store、发通知、写工作副本目录。**原包目录一个字不动**——写回是人接受时路由做的事。
 *
 * 子类只补三件事：一轮结束之后怎么判（`afterTurn`）、权限怎么分档（`permissionPolicy`）、
 * 重启续上时第一句说什么（`resumePrompt`）。生命周期 / 主循环 / 审批 / 看门狗 / 收尾都在这里。
 */
export abstract class AgentSessionBase<D extends AgentSessionDeps = AgentSessionDeps> {
  readonly runId: string
  protected agent?: SpawnedAgent
  protected sessionId = ''
  protected cwd = ''
  protected readonly stuck = new StuckDetector()
  protected readonly gates: RepairGates
  protected readonly queue: string[] = []
  /**
   * 等人点头的权限请求，**按 id 存多条**：agent 可以并行发起工具调用，于是 `request_permission`
   * 也会并发到达。只留一个槽位的话，第二条会把第一条的 `resolve` 覆盖掉——那条 ACP 请求
   * 从此没有回音，agent 就在那儿等着，而这边看起来一切正常。
   */
  private readonly pending = new Map<string, { resolve: (r: acp.RequestPermissionResponse) => void; options: acp.PermissionOption[] }>()
  /** 正在收场（cancel 已开始、还没落 finish）。挡住等人那条路径在终态前补一条 `running`。 */
  protected stopping = false
  protected pendingStuck?: { why: string; sinceSeq: number }
  protected turnText = ''
  private lastBeat: number
  private stderrLines = 0
  private replaying = false
  private watchdog?: ReturnType<typeof setInterval>
  protected terminal = false
  private nextPrompt?: string
  protected readonly now: () => number

  constructor(protected readonly deps: D, protected readonly init: AgentSessionInit, existing?: { run: RunRecord }) {
    this.now = deps.now ?? Date.now
    this.lastBeat = this.now()
    this.gates = new RepairGates(init.limits, this.now)
    if (existing) {
      this.runId = existing.run.id
      this.sessionId = existing.run.agentSession?.sessionId ?? ''
      this.cwd = existing.run.agentSession?.cwd ?? ''
    } else {
      this.runId = deps.store.create({ kind: init.kind, sourceId: init.sourceId }).id
    }
  }

  get status(): RunStatus { return this.deps.store.get(this.runId)?.status ?? 'error' }

  /** 一轮 prompt 结束、闸与卡住已记之后：决定 finish / 设 nextPrompt / pause。 */
  protected abstract afterTurn(): Promise<void>
  /** 这个动作放行、等人、还是自动拒。 */
  protected abstract permissionPolicy(req: acp.RequestPermissionRequest): ApprovalDecision | { verdict: 'reject'; why: string }
  /** 后端重启续上这条 run 时的第一句。 */
  protected abstract resumePrompt(): string

  /**
   * 撞闸了怎么办。默认 `'pause'`（暂停等人点继续）——**不要**把它改成默认交付：
   * 修复那条线上撞闸时手里那份 recipe 还没过校验，交出去就是把一份半成品说成结果。
   * 探索那条线相反（草稿非空就有价值），它覆写这里、自己收尾、回 `'handled'`。
   */
  protected onGate(_hit: GateName): 'pause' | 'handled' { return 'pause' }

  /**
   * agent 说「做不了」（`UNREPAIRABLE:` 或协议级 refusal）时怎么收场。默认 `'default'`：
   * 落 `verdict-unrepairable` + 发通知。**这是结论不是失败**，所以子类手里若已经攒下有价值的
   * 半成品（探索的草稿图），它可以自己交付再回 `'handled'`——放弃的是**后半程**，不是已经做完的那部分。
   */
  protected onUnrepairable(_why: string): 'default' | 'handled' { return 'default' }

  /** 两条「agent 放弃」的路共用同一条收场（refusal 与 `UNREPAIRABLE:` 只是说法不同）。 */
  private giveUp(why: string): void {
    if (this.onUnrepairable(why) === 'handled') return
    this.finish({ produced: 'verdict-unrepairable', reason: 'end_turn' })
    this.notifyVerdict(why)
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────────

  /** 开 agent + `session/new`。调用方先把 `cwd` 那个目录准备好。 */
  protected async openAndNew(cwd: string): Promise<void> {
    this.cwd = cwd
    await this.openAgentOrFail()
    const s = await this.agent!.newSession({ cwd: this.cwd, mcpServers: this.mcpServers() })
    this.sessionId = s.sessionId
  }

  /** 开 agent + `session/load`（含重放期屏蔽）。调用方先确保 `sess.cwd` 存在。 */
  protected async openAndLoad(sess: AgentSession): Promise<void> {
    this.cwd = sess.cwd
    const init = await this.openAgentOrFail()
    if (!init.agentCapabilities?.loadSession) throw new Error('agent 不支持 session/load，这条 run 续不了')
    // load 期间 agent 会把历史重放一遍。那些事件我们**已经落过库了**，再落一次就是同一段
    // 对话在时间线上出现两份——看的人分不清哪份是刚发生的。
    this.replaying = true
    try {
      await this.agent!.loadSession({ sessionId: sess.sessionId, cwd: sess.cwd, mcpServers: this.mcpServers() })
    } finally {
      this.replaying = false
    }
  }

  protected async openAgentOrFail(): Promise<acp.InitializeResponse> {
    const handlers: AcpHandlers = {
      onUpdate: (n) => this.onUpdate(n),
      onPermission: (r) => this.onPermission(r),
      // stderr 这根管子不读会把子进程堵死（acp-client.ts）——所以永远挂着它，哪怕只是记一条。
      onStderr: (line) => this.onStderr(line),
      onProtocolError: (m) => { if (!this.terminal) this.event('message', `协议流里有解不开的一行：${m.slice(0, 200)}`, { stream: 'protocol' }) },
    }
    this.agent = this.deps.openAgent(this.init.command, handlers, this.cwd)
    const init = await this.agent.initialize()
    // 子进程退出的看护**必须挂在 initialize 之后**：起不来那一档 `exited` 立刻就落地，
    // 挂在前面会抢先把 run 标成 agent_crashed，把真正的原因（spawn 失败）盖掉。
    void this.agent.exited.then(({ code, signal }) => {
      // **`stopping` 也要读**：`cancel()` 先立牌子、再 `await agent.cancel(...)`，而 `terminal`
      // 要到最后的 `finish()` 才置位。有些 adapter 收到 `session/cancel` 就自己退了——那个 await
      // 窗口里子进程一走，这里会抢先落一条 `agent_crashed`，随后 `finish()` 因 terminal 已置而
      // 静默返回：**用户点的取消，界面上显示成 agent 崩了**。
      if (!this.terminal && !this.stopping && this.status !== 'paused') {
        this.failRun('agent_crashed', new Error(`agent 进程退出：code=${code} signal=${signal}`))
      }
    })
    this.startWatchdog()
    return init
  }

  protected mcpServers(): acp.McpServer[] {
    const ep = this.deps.mcpEndpoint()
    return ep ? [{ type: 'http', name: 'stream', url: ep.url, headers: [{ name: 'Authorization', value: `Bearer ${ep.token}` }] }] : []
  }

  // ── 主循环 ──────────────────────────────────────────────────────────────────

  protected async runLoop(firstPrompt: string): Promise<void> {
    this.nextPrompt = firstPrompt
    while (this.nextPrompt !== undefined && !this.terminal) {
      const text = this.nextPrompt
      this.nextPrompt = undefined
      this.setStatus('running')
      this.turnText = ''
      const t0 = this.now()
      let res: acp.PromptResponse
      try {
        res = await this.agent!.prompt(this.sessionId, text)
      } catch (e) {
        // 看门狗 / cancel 关连接时这里也会抛——那时 run 已经有结论了，别再盖一层。
        if (!this.terminal) this.failRun('agent_protocol', e)
        return
      }
      this.beat()
      if (this.terminal) return
      const wallMs = this.now() - t0
      if (res.usage) {
        this.deps.store.addUsage(this.runId, { promptTokens: res.usage.inputTokens, completionTokens: res.usage.outputTokens, reported: true, wallMs })
        this.gates.noteTokens(res.usage.totalTokens)
      } else {
        // 端点没报用量：**不补 0**，`reported:false` 让 UI 说「用量不可用」（spec §8）。
        this.deps.store.addUsage(this.runId, { promptTokens: 0, completionTokens: 0, reported: false, wallMs })
      }
      this.gates.noteTurn()
      // 一个 turn 落**一条** message：逐 chunk 落会把事件流刷成字碎片。
      if (this.turnText) this.event('message', this.turnText.slice(0, 2000), { role: 'agent' })

      if (res.stopReason === 'cancelled') { this.finish({ produced: 'nothing', reason: 'cancelled' }); return }
      if (res.stopReason === 'refusal') {
        this.event('message', 'agent 拒绝了这个任务')
        this.giveUp('agent 拒绝了这个任务')
        return
      }
      // `max_tokens` / `max_turn_requests` 是 agent 自己的上限，当 end_turn 处理——我们的闸在下面判。
      const unrepairable = parseUnrepairable(this.turnText)
      if (unrepairable) { this.giveUp(unrepairable); return }

      await this.afterTurn()
      if (this.terminal) return
      if (this.pendingStuck) { this.pause({ why: this.pendingStuck.why, sinceSeq: this.pendingStuck.sinceSeq }); return }
      const g = this.gates.check()
      if (g.hit) {
        // 撞闸的**默认**处置是暂停等人续；子类可以先把手里的半成品交出去再决定
        // （探索：截断也要交图，spec §5.4）。回 `'handled'` = 它自己已经收尾了。
        if (this.onGate(g.hit) === 'pause') this.pause({ why: `撞了 ${g.hit} 闸`, gate: g.hit, snapshot: this.gates.snapshot() })
        return
      }
    }
  }

  /** 子类在 `afterTurn()` 里定下一轮说什么。 */
  protected setNextPrompt(text: string): void { this.nextPrompt = text }

  /**
   * 下一条 prompt：**校验回执在前，人话跟在同一条里**——agent 得先知道哪儿没过，
   * 但人话不能因此被推迟到某个「回执恰好重复」的时刻，否则整趟都发不出去。
   *
   * 一轮最多带一条人话：一次塞进去五条，agent 只会挑一条照做，其余静静地丢了。
   */
  protected withQueued(feedback: string): string {
    const said = this.queue.shift()
    return said ? `${feedback}\n\n用户补充：${said}` : feedback
  }

  /** 卡住只记**第一次**：后面的会把 `sinceSeq` 一路前移，而人要看的正是循环的起点。 */
  protected noteStuck(v: { stuck: true; why: string; sinceSeq: number } | { stuck: false }): void {
    if (v.stuck && !this.pendingStuck) this.pendingStuck = { why: v.why, sinceSeq: v.sinceSeq }
  }

  // ── agent → 我们 ────────────────────────────────────────────────────────────

  private onUpdate(n: acp.SessionNotification): void {
    this.beat()
    if (this.replaying || this.terminal) return
    const u = n.update
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content.type === 'text') this.turnText += u.content.text
        return
      // 思考过程不落库：它很长、会变、而且不是我们判任何事情的依据。
      case 'agent_thought_chunk':
        return
      case 'tool_call': {
        // 事件里存截断版（整段 HTML 塞进 rawInput 的工具是有的），**卡住检测吃原件**：
        // 截断会让两次不同的调用在尾部之后长得一模一样，凭空判出一个不存在的循环。
        const e = this.event('tool_call', u.title, { kind: u.kind, rawInput: summarize(u.rawInput), locations: u.locations }, u.toolCallId)
        this.noteStuck(this.stuck.noteToolCall(e.seq, u.name ?? u.title, u.rawInput))
        return
      }
      case 'tool_call_update':
        // 只有终态落库：in_progress 那些是同一次调用的中间态，落了就是同一件事记三遍。
        if (u.status === 'completed') this.event('tool_result', u.title ?? '完成', { rawOutput: summarize(u.rawOutput) }, u.toolCallId)
        else if (u.status === 'failed') this.event('tool_failed', u.title ?? '失败', { rawOutput: summarize(u.rawOutput) }, u.toolCallId)
        return
      case 'plan':
        this.event('message', `计划：${u.entries.length} 项`, { plan: u.entries.map((e) => e.content) })
        return
      case 'plan_update': {
        const entries = u.plan.type === 'items' ? u.plan.entries : []
        this.event('message', `计划：${entries.length} 项`, { plan: entries.map((e) => e.content) })
        return
      }
      case 'usage_update':
        // 只记录，**不进账**：闸的刻度取 `prompt` 回来的那份 usage，两处都算会把数字翻倍。
        this.event('usage', `上下文 ${u.used}/${u.size}`, { used: u.used, size: u.size, cost: u.cost ?? null })
        return
      default:
        return
    }
  }

  private async onPermission(req: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    this.beat()
    const decision = this.permissionPolicy(req)
    const tc = { title: req.toolCall.title, kind: req.toolCall.kind, locations: req.toolCall.locations }
    if (decision.verdict === 'allow') {
      const opt = pickOption(req.options, 'allow')
      this.event('permission_requested', `${req.toolCall.title ?? '动作'}：自动放行（${decision.why}）`, { auto: true, why: decision.why, toolCall: tc }, req.toolCall.toolCallId)
      this.event('permission_answered', opt ? `选了 ${opt.name}` : 'agent 没给可放行的选项，回 cancelled', { auto: true, optionId: opt?.optionId ?? null }, req.toolCall.toolCallId)
      return opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } }
    }
    if (decision.verdict === 'reject') {
      const opt = pickOption(req.options, 'reject')
      this.event('permission_requested', `${req.toolCall.title ?? '动作'}：自动拒绝（${decision.why}）`, { auto: true, rejected: true, why: decision.why, toolCall: tc }, req.toolCall.toolCallId)
      this.event('permission_answered', opt ? `选了 ${opt.name}` : 'agent 没给拒绝选项，回 cancelled', { auto: true, optionId: opt?.optionId ?? null }, req.toolCall.toolCallId)
      return opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } }
    }
    const id = randomUUID()
    this.event('permission_requested', `${req.toolCall.title ?? '动作'}：等你点头（${decision.why}）`, { auto: false, permissionId: id, why: decision.why, options: req.options, toolCall: tc }, req.toolCall.toolCallId)
    // 已经在等人了就不再重复落一条状态；通知每条都发（每条都要有人去点）。
    if (this.pending.size === 0 && this.status !== 'awaiting_confirmation') this.setStatus('awaiting_confirmation')
    this.deps.notify({
      type: 'intervention.awaiting',
      severity: 'warn',
      title: `${this.init.label}：agent 想${req.toolCall.title ?? '做一件白名单外的事'}，等你点头`,
      body: decision.why,
      dedupeKey: `intervention.awaiting:${id}`,
      ref: { ...this.init.ref },
      detail: `runId=${this.runId}\npermissionId=${id}`,
    })
    const answered = await new Promise<acp.RequestPermissionResponse>((resolve) => {
      this.pending.set(id, { resolve, options: req.options })
    })
    this.pending.delete(id)
    // 等人这段时间不算 agent 沉默——人不是 agent，看门狗醒来时状态也不是 running。
    this.beat()
    // 还有别的请求在等人就别回 running；正在收场也别回——那会在终态之后补一条假的「在跑」。
    if (!this.terminal && !this.stopping && this.pending.size === 0) this.setStatus('running')
    return answered
  }

  private onStderr(line: string): void {
    if (this.terminal) return
    if (this.stderrLines === STDERR_CAP) { this.stderrLines++; this.event('message', `stderr 超过 ${STDERR_CAP} 行，后面的不再记`, { stream: 'stderr' }); return }
    if (this.stderrLines > STDERR_CAP) return
    this.stderrLines++
    this.event('message', line.slice(0, 500), { stream: 'stderr' })
  }

  // ── 人 → 我们 ───────────────────────────────────────────────────────────────

  answerPermission(permissionId: string, optionId: string): boolean {
    if (this.terminal) return false
    const p = this.pending.get(permissionId)
    if (!p) return false
    const opt = p.options.find((o) => o.optionId === optionId)
    if (!opt) return false
    this.event('permission_answered', `你选了 ${opt.name}`, { auto: false, permissionId, optionId })
    p.resolve({ outcome: { outcome: 'selected', optionId } })
    return true
  }

  /** 人中途说的话进队列，下一轮发出去（当轮正在飞，插不进去）。run 已经有结论了就丢掉——
   *  落一条没人会读的事件，比不落更容易让人以为「我说的话进去了」。 */
  say(text: string): void {
    if (this.terminal) return
    this.queue.push(text)
    this.event('message', text.slice(0, 500), { role: 'user', queued: true })
  }

  /** paused → 抬闸 / 清卡住，回主循环。不是 paused、或 agent 还没就绪，回 false。 */
  continue(): boolean {
    if (this.status !== 'paused' || this.terminal || this.stopping || !this.agent || !this.sessionId) return false
    const limits = this.gates.extend()
    this.pendingStuck = undefined
    this.stuck.reset()
    this.event('status_changed', `继续：闸抬到 ${limits.turns} 轮 / ${limits.tokens} token / ${Math.round(limits.wallMs / 60_000)} 分钟`, { status: 'running', limits })
    const next = this.nextPrompt ?? this.queue.shift() ?? '继续。'
    this.nextPrompt = undefined
    // **必须带 catch**，和 `start()`/`resume()` 的 try/catch 对齐：这条路是同步返回 boolean 的，
    // 没有 promise 交给调用方，裸 `void` 就意味着 `runLoop` 里任何一次抛（库写不进去、
    // 通知回调自己炸）都是一次**没有 handler 的 rejection**——Node 22 默认 `--unhandled-rejections=throw`，
    // 那就是 8900 那个后端连同它挂着的定时任务一起没了。
    void this.runLoop(next).catch((e) => this.failRun('agent_protocol', e))
    return true
  }

  async cancel(): Promise<void> {
    if (this.terminal) return
    // **先立牌子再回权限**：resolve 会把 onPermission 里那段续接排进微任务，它跑在下面的
    // finish 之前；不挡住的话，事件流里会在「已取消」之后冒出一条「在跑」。
    this.stopping = true
    this.releasePending()
    try { if (this.sessionId) await this.agent?.cancel(this.sessionId) } catch { /* agent 可能已经死了 */ }
    // 已经落了提议再取消，**产物是提议不是 nothing**：人还得去审它。
    this.finish({ produced: this.deps.store.proposals({ runId: this.runId }).length ? 'proposal' : 'nothing', reason: 'cancelled' })
    // **等子进程真的走开**：`dispose()` await 的是这条 promise，这里不等就等于关停不等 agent 走开
    // ——进程退了，agent 子进程还在。`finish()` 之前已经 terminal 的那一档没有 `closing`，直接返回。
    await this.closing
  }

  // ── 看门狗 / 收尾 ───────────────────────────────────────────────────────────

  /**
   * 心跳与看门狗是**同一个机制**（spec §6.5）：每 tick 落一条 heartbeat 说「还在跑」，
   * 而判的正是「上一次心跳有多久了」。只在 `running` 计时——等人、paused 都不算 agent 沉默。
   */
  private startWatchdog(): void {
    const idle = this.deps.idleTimeoutMs ?? DEFAULT_IDLE_MS
    this.watchdog = setInterval(() => {
      if (this.terminal) { this.stopWatchdog(); return }
      if (this.status !== 'running') return
      this.event('heartbeat', '还在跑', this.gates.snapshot())
      if (this.now() - this.lastBeat > idle) {
        void this.agent?.cancel(this.sessionId).catch(() => {})
        this.failRun('agent_stalled', new Error(`${Math.round(idle / 1000)}s 没有任何动静`))
      }
    }, Math.max(50, Math.floor(idle / 10)))
    // run 结束后这根定时器不该再把 Node 的事件循环钉住（测试里表现为 vitest 收不了工）。
    this.watchdog.unref?.()
  }

  private stopWatchdog(): void { if (this.watchdog) clearInterval(this.watchdog); this.watchdog = undefined }
  /** protected：子类在 `afterTurn()` 里做长活时要能报「我还在动」，否则被自己的看门狗判 `agent_stalled`。 */
  protected beat(): void { this.lastBeat = this.now() }

  protected pause(data: { why: string; sinceSeq?: number; gate?: GateName; snapshot?: unknown }): void {
    this.setStatus('paused', `暂停：${data.why}`, data)
    this.deps.notify({
      type: 'intervention.paused',
      severity: 'warn',
      title: `${this.init.label}：${this.init.noun}暂停，${data.why}`,
      body: data.gate ? '点「继续」各抬一档；不续就取消' : '看事件流里循环起点，换个提示继续，或取消',
      dedupeKey: `intervention.paused:${this.runId}:${this.deps.store.get(this.runId)?.lastSeq ?? 0}`,
      ref: { ...this.init.ref },
      detail: `runId=${this.runId}`,
    })
  }

  protected finish(stopped: { produced: StopProduced; reason: FinishReason }): void {
    if (this.terminal) return
    this.terminal = true
    this.stopWatchdog()
    this.deps.store.finish(this.runId, stopped)
    this.event('status_changed', `结束：${stopped.produced} / ${stopped.reason}`, { status: this.status, stopped })
    this.releasePending()
    this.startClosingAgent()
  }

  protected failRun(code: 'agent_spawn_failed' | 'agent_crashed' | 'agent_stalled' | 'agent_protocol', e: unknown): void {
    if (this.terminal) return
    this.terminal = true
    this.stopWatchdog()
    const message = e instanceof Error ? e.message : String(e)
    this.deps.store.fail(this.runId, { code, message })
    try { this.event('status_changed', `出错：${code}`, { status: 'error', code, message }) } catch { /* store 也挂了 */ }
    this.releasePending()
    this.deps.notify({
      type: 'intervention.error',
      severity: 'error',
      title: `${this.init.label}：agent ${this.init.noun}没跑成（${code}）`,
      body: message,
      dedupeKey: `intervention.error:${this.runId}:${code}`,
      ref: { ...this.init.ref },
      detail: `runId=${this.runId}`,
    })
    this.startClosingAgent()
    this.deps.log(`[intervention] ${this.init.kind} ${this.runId} ${code}: ${message}`)
  }

  /**
   * 收场时把**每一条**还挂着的权限请求回掉。漏掉一条，agent 就在那条请求上永远等下去。
   *
   * **每条都要落一条 `permission_answered`**：前端认「还等着的那一条」的判据是
   * 「有 `permission_requested(auto:false)`、且没有同 `permissionId` 的 `permission_answered`」，
   * 不落的话取消 / 出错之后那张审批卡永远匹配得上，点下去只有 404 / 409。事件流这一侧同样有洞——
   * 那条 ACP 请求**确实**被我们回了 `cancelled`，时间线上却一个字都没有，
   * 于是「agent 在等我点头」和「我们替它回了取消」长得一模一样。
   */
  private releasePending(): void {
    for (const [permissionId, p] of this.pending) {
      // 库可能也一起挂了（failRun 那条路），但请求该回还得回——先记后回，记不下也照回。
      try {
        this.event('permission_answered', '收场：替你回了取消', { auto: false, permissionId, optionId: null, outcome: 'cancelled' })
      } catch { /* store 也挂了 */ }
      p.resolve({ outcome: { outcome: 'cancelled' } })
    }
    this.pending.clear()
  }

  /**
   * 关停子进程那条 promise。`finish()` / `failRun()` 是同步的，但「子进程真的走开了」不是——
   * `cancel()` 要等它，`RepairManager.dispose()` 才等得到，cordis 的 `ctx.effect` 才等得到。
   */
  private closing?: Promise<void>

  private startClosingAgent(): void {
    this.closing = this.closeAgent().catch(() => {})
  }

  /**
   * 关连接 + 收子进程。**`kill()` 发的是 SIGTERM，不保证进程一定死**（acp-client.ts 的头注点名了
   * 这件事，并说「需要『一定收掉』的场景由上层再加 SIGKILL 兜底」——这里就是那个上层）。
   * 不等、不补 SIGKILL 的话，后端进程退了而一个不肯死的 agent 子进程还在。
   */
  private async closeAgent(): Promise<void> {
    const agent = this.agent
    if (!agent) return
    try { agent.close() } catch { /* 已经关了 */ }
    try { agent.kill() } catch { /* 已经死了 */ }
    const grace = this.deps.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS
    const gone = await Promise.race([
      agent.exited.then(() => true),
      // 定时器 unref：等宽限期这件事本身不该把 Node 的事件循环钉住。
      new Promise<false>((r) => { const t = setTimeout(() => r(false), grace); t.unref?.() }),
    ])
    if (gone) return
    this.deps.log(`[intervention] ${this.init.kind} ${this.runId} agent 没在 ${grace}ms 内退出，改发 SIGKILL`)
    try { agent.kill('SIGKILL') } catch { /* 已经死了 */ }
  }

  protected notifyVerdict(why: string): void {
    this.deps.notify({
      type: 'intervention.unrepairable',
      severity: 'warn',
      title: `${this.init.label}：agent 判定修不了`,
      body: why,
      dedupeKey: `intervention.unrepairable:${this.runId}`,
      ref: { ...this.init.ref },
      detail: `runId=${this.runId}`,
    })
  }

  protected setStatus(status: RunStatus, title?: string, data?: Record<string, unknown>): void {
    this.deps.store.setStatus(this.runId, status)
    this.event('status_changed', title ?? `状态：${status}`, { status, ...(data ?? {}) })
  }

  protected event(kind: RunEventKind, title: string, data?: unknown, callId?: string): RunEvent {
    return this.deps.store.appendEvent(this.runId, {
      kind, title,
      ...(data !== undefined ? { data } : {}),
      ...(callId ? { callId } : {}),
    })
  }
}

/** tool 输出可能很大（整页 HTML）；事件里只留头 2000 字，原文 agent 自己有。 */
function summarize(v: unknown): unknown {
  if (v === undefined || v === null) return v
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 2000 ? `${s.slice(0, 2000)}…（截断，共 ${s.length} 字）` : v
}
