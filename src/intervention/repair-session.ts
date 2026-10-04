import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type * as acp from '@agentclientprotocol/sdk'
import type { Recipe } from '../replay/recipe.ts'
import type { AgentConfig } from './agent-config.ts'
import { AgentSessionBase, type AgentSessionDeps } from './agent-session.ts'
import { classifyPermission, type ApprovalDecision } from './approval.ts'
import { validateCandidate } from './recipe-validation.ts'
import { buildTaskBook, buildValidationFeedback } from './task-book.ts'
import type { RecipeValidation, RunRecord } from './types.ts'

/** 活体 probe 的执行器。**是个 thunk**：后端起来的顺序里执行器可能比这条 run 晚到，
 *  把它在装配期求一次值就等于宣称「以后不会变」——那一格会永远显示 `skipped-no-executor`。 */
export type ProbeRunner = (recipe: Recipe) => Promise<{ outcome: string; reason?: string; items: number }>

export type RepairSessionDeps = AgentSessionDeps & {
  /** 缺席、或这一刻取不到执行器 → 校验的 probe 那一格如实报 `skipped-no-executor`。 */
  probe?: () => ProbeRunner | undefined
}

export interface RepairJobInput {
  sourceId: string
  localSourceId: string
  facility: string
  packageDir: string
  reason: string
  affectedSources: string[]
  failureShots: string[]
  config: AgentConfig
}

const RESUME_PROMPT = '后端重启过一次，接着修。上一轮的校验结果如果没过，重新读一遍文件再改。'

/**
 * 一次 `repair` run 的编排（spec §5.2）。生命周期 / 主循环 / 审批 / 看门狗 / 收尾都在
 * `AgentSessionBase`；这里只补修复这一档特有的东西：拷工作副本 + 建任务书、一轮结束后校验候选、
 * 过了就落一条提议。**原包目录一个字不动**——写回是人接受时路由做的事。
 */
export class RepairSession extends AgentSessionBase<RepairSessionDeps> {
  private original: unknown

  constructor(deps: RepairSessionDeps, private readonly job: RepairJobInput, existing?: { run: RunRecord }) {
    super(deps, {
      kind: 'repair',
      sourceId: job.sourceId,
      command: job.config.command,
      limits: job.config.limits,
      label: job.sourceId,
      ref: { kind: 'stream', id: job.sourceId },
      noun: '修复',
    }, existing)
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    try {
      const cwd = join(this.deps.workRoot, this.runId, basename(this.job.packageDir))
      mkdirSync(cwd, { recursive: true })
      cpSync(this.job.packageDir, cwd, { recursive: true, filter: (p) => !p.includes('node_modules') })
      this.original = JSON.parse(readFileSync(join(this.job.packageDir, `${this.job.localSourceId}.recipe.json`), 'utf8'))
      await this.openAndNew(cwd)
      this.deps.store.setAgentSession(this.runId, {
        command: this.job.config.command.command,
        args: this.job.config.command.args,
        sessionId: this.sessionId,
        cwd: this.cwd,
        packageDir: this.job.packageDir,
        localSourceId: this.job.localSourceId,
      })
      const book = buildTaskBook({
        sourceId: this.job.sourceId,
        localSourceId: this.job.localSourceId,
        facility: this.job.facility,
        reason: this.job.reason,
        affectedSources: this.job.affectedSources,
        recipePath: join(this.cwd, `${this.job.localSourceId}.recipe.json`),
        currentVersion: Number((this.original as { version?: number }).version ?? 0),
        failureShots: this.job.failureShots,
        mcpToolNames: this.deps.mcpToolNames(),
      })
      await this.runLoop(book)
    } catch (e) {
      this.failRun('agent_spawn_failed', e)
    }
  }

  async resume(): Promise<void> {
    const sess = this.deps.store.get(this.runId)?.agentSession
    if (!sess) { this.failRun('agent_protocol', new Error('没有可续的 agent 会话')); return }
    try {
      this.original = JSON.parse(readFileSync(join(sess.packageDir, `${sess.localSourceId}.recipe.json`), 'utf8'))
      // 工作副本可能已经不在了（临时目录被清、`repair-work` 被人删）。**重建一份再续**：
      // 不重建的话 agent 的 cwd 是个空洞，它读不到文件、校验又永远读不到候选，
      // 表现成「续上了、但每一轮都说 schema 读不到」，而没有一处会说目录没了。
      if (!existsSync(sess.cwd)) {
        mkdirSync(sess.cwd, { recursive: true })
        cpSync(sess.packageDir, sess.cwd, { recursive: true, filter: (p) => !p.includes('node_modules') })
        this.event('message', '工作副本不在了，从原包重新拷了一份再续', { cwd: sess.cwd })
      }
      await this.openAndLoad(sess)
      await this.runLoop(this.queue.shift() ?? this.resumePrompt())
    } catch (e) {
      this.failRun('agent_protocol', e)
    }
  }

  protected resumePrompt(): string { return RESUME_PROMPT }

  protected permissionPolicy(req: acp.RequestPermissionRequest): ApprovalDecision {
    return classifyPermission(req, this.cwd)
  }

  // ── 一轮之后：校验候选 ──────────────────────────────────────────────────────

  protected async afterTurn(): Promise<void> {
    const local = this.job.localSourceId
    const v = await validateCandidate({
      localSourceId: local,
      original: this.original,
      candidatePath: join(this.cwd, `${local}.recipe.json`),
      probe: this.deps.probe?.(),
    })
    if (v.ok) {
      this.stuck.noteValidationOk()
      this.emitProposal(v.candidate!, v.validation)
      return
    }
    const seq = this.event('message', '校验没过', { validation: v.validation }).seq
    const sv = this.stuck.noteValidationFail(seq)
    this.noteStuck(sv)
    this.setNextPrompt(this.withQueued(buildValidationFeedback(v.validation)))
  }

  private emitProposal(candidate: Recipe, validation: RecipeValidation): void {
    const local = this.job.localSourceId
    const prop = this.deps.store.addProposal({
      runId: this.runId,
      sourceId: this.job.sourceId,
      facility: this.job.facility,
      kind: 'recipe',
      recipe: candidate,
      // 写回目标是**原包**那份，不是工作副本——人接受时路由照这条路径写。
      recipePath: join(this.job.packageDir, `${local}.recipe.json`),
      validation,
      rationale: this.turnText.slice(-300) || 'agent 交出了 v+1',
      status: 'pending',
    })
    this.event('proposal', `recipe v${String((candidate as { version?: number }).version)} 过校验，待审`, { proposalId: prop.id, validation })
    this.finish({ produced: 'proposal', reason: 'end_turn' })
    this.deps.notify({
      type: 'intervention.proposal',
      severity: 'info',
      title: `${this.job.sourceId}：agent 交出了 recipe v+1，等你审`,
      ...(validation.probe.startsWith('skipped') ? { body: `活体 probe 没跑（${validation.probe}），接受后下一趟采集就是验收` } : {}),
      dedupeKey: `intervention.proposal:${prop.id}`,
      ref: { kind: 'stream', id: this.job.sourceId },
      detail: `runId=${this.runId}\nproposalId=${prop.id}`,
    })
  }
}
