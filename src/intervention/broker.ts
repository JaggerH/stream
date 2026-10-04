import { createHash } from 'node:crypto'
import type { EventInput } from '../events/store.ts'
import type { LlmForTask } from '../llm/task.ts'
import { ladderOf } from '../providers/ladder-trace.ts'
import type { RepairJob, RepairProposal, RepairRunner, StateProposal } from '../replay/repair-runner.ts'
import type { ObservationLedger } from '../replay/observation-ledger.ts'
import { matchUrlPattern } from '../replay/state-perception-dom.ts'
import { featureKey, type Feature, type StateDef } from '../replay/state-graph.ts'
import { askOnce, featureKindAllowed, illegalKindWhy, type AskAnswer, type AskInput } from './ask.ts'
import { cacheKey, sceneFingerprint } from './fingerprint.ts'
import { gateStateLike } from './gate.ts'
import type { InterventionRunStore } from './run-store.ts'
import type { Proposal, RunErrorCode, RunRecord, StopProduced } from './types.ts'

export interface BrokerDeps {
  store: InterventionRunStore
  observations: ObservationLedger
  /** 调用时现取：llm 域比 adapters / harvest 晚装配（AGENTS.md「装配期取的值 = 冻住的答案」）。 */
  llm: () => LlmForTask | undefined
  notify: (e: EventInput) => void
  log?: (...a: unknown[]) => void
  /** agent 档（`RepairManager`）。缺席或回 `unconfigured` = 只落一条「该修了」的通知，不开会话。
   *  类型只写这一个方法：Broker 不该拿到取消 / 答权限那些口，它只负责**开**一条。 */
  repairs?: { start(job: RepairJob): 'unconfigured' | 'busy' | { runId: string; failed?: true } }
}

/** 进 dedupeKey 的短哈希：原文可能很长、还带路径与引号，直接拼会让去重键变成一整段话。 */
function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8)
}

/**
 * 通知标题里那半句：说人话，不把 `prop.kind` 的内部枚举名直接拼上去。曾经是「AI 给了一条state提议」——
 * 读的人（活体 2026-09-12）看不懂它在提议什么。每一种都说清「它认出了什么 / 要往哪儿加什么」。
 */
export function proposalHeadline(prop: Pick<Proposal, 'kind' | 'stateId' | 'candidates'>): string {
  switch (prop.kind) {
    case 'state':
      return `AI 认出一个状态图里没有的页面，提议记为「${prop.stateId ?? '（未命名）'}」`
    case 'discriminator':
      return `AI 提议补一条特征，好把 ${prop.candidates?.length ? prop.candidates.join(' / ') : '几个'} 这几个撞车的页面状态分开`
    case 'transition':
      return 'AI 提议往状态图里加一条跳转边'
    case 'locator':
      return 'AI 提议给这一步换一个定位靶子'
    case 'recipe':
      return 'agent 修好了 recipe，交出一份改动'
    case 'graph':
      return '探索完了，交出一份状态图草稿'
    default:
      return `AI 给了一条 ${String(prop.kind)} 提议`
  }
}

/**
 * 「一个成员都没配」与「配了但全失败」、「没钱了」三件事分开报（同 chatViaLlm 那条教训）：
 * 合成一种红会把「去设置里填」指给一份本来就填对了的配置。
 */
export function classifyLlmError(e: unknown): { code: RunErrorCode; message: string } {
  const msg = e instanceof Error ? e.message : String(e)
  const ladder = ladderOf(e)
  if (ladder && ladder.rungs.length === 0) return { code: 'llm_unconfigured', message: msg }
  if (/402|insufficient|余额|balance|quota/i.test(msg)) return { code: 'llm_out_of_credits', message: msg }
  if (ladder) return { code: 'llm_all_failed', message: msg }
  return { code: 'internal', message: msg }
}

/**
 * 介入代理（spec §3）：唯一的分发点，实现 `RepairRunner`。**运行时一问一答**：
 * `proposeState` / `proposeDiscriminator` / `proposeTransition` 各开一个短 run；`proposeLocator`
 * 不问模型、直接落提议；`requestRepair`（源级隔离）交给 `deps.repairs` 开一条 agent 修复会话，
 * 没接或没配 agent 时退回落一条给人的通知。
 *
 * 引擎是异步收件人的调用方：这里**永不抛**（抛出去只会把一次采集失败换成另一种失败）。
 */
export class InterventionBroker implements RepairRunner {
  // 答案缓存在 store 的 `answers` 表里（spec §4.3），**不在进程内**：后端重载后同一个界面
  // 第二次落空又会重新问一次模型，而那件事没有任何一处会喊。

  constructor(private readonly deps: BrokerDeps) {}

  private get log(): (...a: unknown[]) => void { return this.deps.log ?? console.error }

  /**
   * 引擎是异步收件人的调用方：**每个公开口的整段实现**都从这里过一遍，抛了只记一行日志。
   * 包住整段（含 `store.create` 那一行）是有原因的：try 之外的那一行照样能抛，而它抛出去就是
   * 把「状态图缺一条」升级成「这趟采集炸了」——比不介入更坏。
   */
  private async neverThrow(label: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn()
    } catch (e) {
      this.log(`[intervention] ${label} 内部错误（已吞，不掀翻采集）：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  requestRepair(job: RepairJob): Promise<void> { return this.neverThrow('requestRepair', () => this.doRequestRepair(job)) }

  private doRequestRepair(job: RepairJob): void {
    // 连累到的其他源单独点名：它们各自的健康状态是绿的（没人替它们跑过这份 recipe），
    // 不在这里说，就没有任何一处会提到它们哑了。
    const others = (job.affectedSources ?? []).filter((id) => id !== job.sourceId)
    const also = others.length ? `；跟着哑的还有：${others.join('、')}` : ''
    const r = this.deps.repairs?.start(job) ?? 'unconfigured'
    if (typeof r === 'object') {
      // 那条 run 一建就是红的（包找不到），没有任何 agent 在跑——照成功那句记就是在骗读日志的人。
      // 通知由 manager 自己发（它才有 runId 和错误码），这里只留一行说得清的日志。
      if (r.failed) {
        this.log(`[repair] ${job.sourceId}: 找不到这个源所在的包，run=${r.runId} 已标错（${job.reason}${also}）`)
        return
      }
      // run 自己会在等人 / 出提议 / 出错时各通知一声（spec §6.6），这里不再叠一条——
      // 叠了的话人会先收到一条「需要你手动重写」，而其实 agent 已经在修了。
      this.log(`[repair] ${job.sourceId}: 开了 agent 修复会话 run=${r.runId}（${job.reason}${also}）`)
      return
    }
    if (r === 'busy') {
      this.deps.notify({
        type: 'intervention.repair-needed',
        severity: 'info',
        title: `${job.sourceId} 再次被隔离，已有 agent 会话在修`,
        body: `${job.reason}${also}`,
        // 去重键和首次那条**分开**：两条讲的不是同一件事，共用一个键会让其中一条被通知中心吞掉。
        dedupeKey: `intervention.repair-busy:${job.sourceId}:${shortHash(job.reason)}`,
        ref: { kind: 'stream', id: job.sourceId },
      })
      return
    }
    this.deps.notify({
      type: 'intervention.repair-needed',
      severity: 'warn',
      title: `${job.sourceId} 连漂多次已隔离，需要重写 recipe`,
      body: `${job.reason}${also}；设置里填了 ai-agent 就能让你的 code agent 来修`,
      // reason 进 dedupeKey：隔离 → 人修好 → 换个原因再隔离，是**两件事**；只按 sourceId 去重的话
      // 第二次会被通知中心当重复吞掉，人再也收不到第二声。
      dedupeKey: `intervention.repair-needed:${job.sourceId}:${shortHash(job.reason)}`,
      ref: { kind: 'stream', id: job.sourceId },
    })
    this.log(`[repair-needed] ${job.sourceId}: ${job.reason} — 没配 ai-agent，请手动修（write-recipe skill）`)
  }

  proposeLocator(p: RepairProposal): Promise<void> { return this.neverThrow('proposeLocator', () => this.doProposeLocator(p)) }

  private doProposeLocator(p: RepairProposal): void {
    // 不问模型：locator 的正解在现场梯子里，模型给不出比它更好的靶子；这条只是把
    //「它当时是怎么找到的」交给人看。
    const store = this.deps.store
    const run = store.create({ kind: 'runtime-ask', sourceId: p.sourceId, question: 'locator' })
    // `create` 之后的每一行都可能抛（库锁住 / 截图太大 / 磁盘满）。不兜住的话 `neverThrow`
    // 会把错误吞掉，而这条 run 永远停在 `running`——列表页上一条永不结束的记录，
    // 和"正在跑"长得一模一样。
    try {
      store.setStatus(run.id, 'running')
      store.appendEvent(run.id, {
        kind: 'message',
        title: `${p.stepLabel ?? '某一步'}：${p.reason}（靶子来自 ${p.wasVia}${p.wasRef ? `，当时指 ${p.wasRef}` : ''}）`,
      })
      const prop = store.addProposal({
        runId: run.id,
        sourceId: p.sourceId,
        ...(p.facility ? { facility: p.facility } : {}),
        kind: 'locator',
        target: p.see,
        rationale: p.reason,
        status: 'pending',
        ...(p.scene ? { scene: p.scene } : {}),
      })
      store.appendEvent(run.id, { kind: 'proposal', title: '落一条 locator 提议（待审）', data: { proposalId: prop.id } })
      store.finish(run.id, { produced: 'proposal', reason: 'end_turn' })
      this.notifyProposal(run.id, p.sourceId, prop)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // 记完再抛回去，让 `neverThrow` 照旧吞掉并留一行日志——这里只负责别留孤儿。
      try { store.fail(run.id, { code: 'internal', message }) } catch { /* 存储也挂了，只剩日志 */ }
      throw e
    }
  }

  proposeState(p: StateProposal): Promise<void> { return this.neverThrow('proposeState', () => this.ask(p, 'state')) }
  proposeDiscriminator(p: StateProposal & { candidates: string[] }): Promise<void> { return this.neverThrow('proposeDiscriminator', () => this.ask(p, 'discriminator')) }
  proposeTransition(p: StateProposal & { from: string; goal: string }): Promise<void> { return this.neverThrow('proposeTransition', () => this.ask(p, 'transition')) }

  // `irreversible` 是探索建图前的一屏一次筛查（ask.ts 新增），今天还没有任何 propose* 走它——
  // 排掉它只是让 `kind` 在这里继续能当 `ProposalKind` 用，不改行为；接进来是另一个任务的事。
  private async ask(p: StateProposal, kind: Exclude<AskInput['kind'], 'irreversible'>): Promise<void> {
    const store = this.deps.store
    // `create` 也在 try 里：它一样会抛（库锁住 / 磁盘满），而它是这一路上唯一没被兜住的一行。
    let run: RunRecord | undefined
    try {
      run = store.create({ kind: 'runtime-ask', sourceId: p.sourceId, question: kind })
      store.setStatus(run.id, 'running')
      store.appendEvent(run.id, {
        kind: 'message',
        title: p.reason,
        data: { observed: p.observed, candidates: p.candidates, from: p.from, goal: p.goal },
      })
      const known = p.known ?? []
      const truths = this.truthsNow(known, p)
      const fp = sceneFingerprint(p.scene, truths)
      const key = cacheKey(p.sourceId, kind, fp)

      // 先查库再问（spec §4.3）：同源同问题同指纹 → 复用，0 token。
      const cached = store.getAnswer(key)
      if (cached) {
        // produced 按缓存条目自己的 status 推，不按「有答案」推——被拒的答案复用出来仍然是「什么都没产出」。
        // `accepted` 沿用 `pending` 的 produced（都算「有一份提议在」，只是这次不新落一条）：
        // 状态图已经吃过这个答案，人不需要再审一遍。
        const produced: StopProduced =
          cached.status === 'unrepairable' ? 'verdict-unrepairable'
          : cached.status === 'pending' || cached.status === 'accepted' ? 'proposal'
          : 'nothing'
        const title =
          cached.status === 'accepted' ? '同指纹的答案已有，复用——命中的答案已被人接受过（状态已入图），这次不再落提议'
          : cached.status === 'rejected-by-user' ? '同指纹的答案已有，复用——命中的是一条被人拒过的答案'
          : cached.status === 'rejected-by-gate' ? '同指纹的答案已有，复用——命中的是一条被拒的答案'
          : '同指纹的答案已有，复用'
        store.appendEvent(run.id, {
          kind: 'cache_hit',
          title,
          data: { fingerprint: fp, proposalId: cached.proposalId, status: cached.status },
        })
        store.finish(run.id, { produced, reason: 'end_turn' })
        return
      }

      const llm = this.deps.llm()
      if (!llm) {
        store.fail(run.id, { code: 'llm_unconfigured', message: 'LLM 未配置' })
        this.notifyError(run.id, p.sourceId, 'LLM 未配置，无法介入')
        this.log(`[state-proposal:${kind}] ${p.sourceId}: ${p.reason} — LLM 未配置，状态图要人来补`)
        return
      }

      // 一趟 run 只问一次，callId 固定就够配对（tool_call / tool_result / tool_failed 三者）。
      const callId = `ask-${kind}`
      store.appendEvent(run.id, {
        kind: 'tool_call',
        title: `问模型：${kind}`,
        callId,
        data: { fingerprint: fp, hasShot: !!p.scene?.shot, elements: p.scene?.elements.length ?? 0 },
      })
      let r: Awaited<ReturnType<typeof askOnce>>
      try {
        r = await askOnce(llm, {
          kind, sourceId: p.sourceId, scene: p.scene, known,
          // 现场缺席时按浏览器侧问（这条线今天的常态）；facility 缺席退回 sourceId，
          // 与观测账本那一处退法保持同一个答案——两处分家会让「问的是谁」和「学给谁」对不上。
          side: p.scene?.side ?? 'browser',
          facility: p.facility ?? p.sourceId,
          candidates: p.candidates, from: p.from, goal: p.goal, reason: p.reason,
        })
      } catch (e) {
        const err = classifyLlmError(e)
        store.appendEvent(run.id, { kind: 'tool_failed', title: err.message.slice(0, 200), callId })
        store.fail(run.id, err)
        this.notifyError(run.id, p.sourceId, err.message)
        return
      }
      store.addUsage(run.id, { ...r.usage, wallMs: r.wallMs })
      store.appendEvent(run.id, {
        kind: 'tool_result',
        title: r.answer.ok ? `模型答了：${r.answer.answer.kind}` : `答案不合格：${r.answer.why}`,
        callId,
        data: r.answer,
      })
      store.appendEvent(run.id, {
        kind: 'usage',
        // 端点没回 usage 就如实说「不可用」，**不补 0**——一个看着精确其实是猜的数字比没有更坏。
        title: r.usage.reported ? `${r.usage.promptTokens}/${r.usage.completionTokens} tokens` : '用量不可用（端点没回 usage）',
        data: r.usage,
      })

      if (!r.answer.ok) {
        // 解析不了也落一条提议：人要能在轨迹里看到模型究竟说了什么，而不是一条空记录。
        // **不进缓存**——下一次换个模型/换句话可能就答对了。
        store.addProposal({
          runId: run.id, sourceId: p.sourceId, kind, rationale: '',
          status: 'rejected-by-gate', rejection: 'unparseable', gateNote: r.answer.why,
          ...(p.scene ? { scene: p.scene } : {}),
        })
        store.finish(run.id, { produced: 'nothing', reason: 'end_turn' })
        return
      }
      const a = r.answer.answer
      if (a.kind === 'unrepairable') {
        store.putAnswer({ key, sourceId: p.sourceId, kind, fingerprint: fp, status: 'unrepairable', answer: a })
        store.finish(run.id, { produced: 'verdict-unrepairable', reason: 'end_turn' })
        this.deps.notify({
          type: 'intervention.unrepairable', severity: 'warn',
          title: `${p.sourceId}：模型判断修不了`, body: a.rationale,
          dedupeKey: `intervention.unrepairable:${p.sourceId}:${fp}`,
          ref: { kind: 'stream', id: p.sourceId },
        })
        return
      }
      // 不可达：`kind` 在这里已经排掉了 'irreversible'（见 ask() 的参数类型），askOnce 不会答出它。
      // 只是给 TS 一个类型收窄的锚点，别改行为。
      if (a.kind === 'irreversible') throw new Error('unreachable: ask() 从不以 irreversible 提问')

      const prop = this.gateAndStore(run.id, p, kind, a, known, fp)
      store.putAnswer({
        key, sourceId: p.sourceId, kind, fingerprint: fp, answer: a, proposalId: prop.id,
        status: prop.status === 'pending' ? 'pending' : 'rejected-by-gate',
      })
      if (prop.status === 'pending') {
        store.finish(run.id, { produced: 'proposal', reason: 'end_turn' })
        this.notifyProposal(run.id, p.sourceId, prop)
      } else {
        store.finish(run.id, { produced: 'nothing', reason: 'end_turn' })
      }
    } catch (e) {
      // 兜底：Broker 自己的 bug 也不许掀翻采集。
      const msg = e instanceof Error ? e.message : String(e)
      // run 可能压根没建起来（`create` 自己抛），那就只剩日志——别为了写一条记录再抛一次。
      if (run) try { store.fail(run.id, { code: 'internal', message: msg }) } catch { /* 存储也挂了，只剩日志 */ }
      this.log(`[intervention] Broker 内部错误：${msg}`)
    }
  }

  /**
   * 此刻为真的特征键：`p.observed` 之外，拿 known 里的 url 特征对现场 url 现算。
   * **必须现算**：引擎侧今天恒传空的 `observed`，只用它的话指纹会丢掉「现在在哪一类页面上」
   * 这一维，两个完全不同的界面会共用同一个缓存答案。dom 特征现场判不了，不进 truths。
   */
  private truthsNow(known: StateDef[], p: StateProposal): string[] {
    const out = new Set<string>(p.observed)
    const url = p.scene?.url
    if (url) for (const s of known) for (const f of s.features) if (f.kind === 'url' && matchUrlPattern(f.pattern, url)) out.add(featureKey(f))
    return [...out]
  }

  /**
   * 「此刻成立」的判定：url 现验；dom / a11y / text / image **不现验**（现场里没有 DOM
   * 快照），放行但把类型记进 `unverified` → 落到 gateNote 里，人审时看得见哪几条没验过。
   */
  private holdsNow(p: StateProposal, unverified: string[]): (f: Feature) => boolean {
    return (f) => {
      if (f.kind === 'url') {
        // `absent` 今天不在 url 那一档的类型里；照 `absent` 取反写，是为了将来加上那一格时
        // 不会静默反了（漏取反的表现是「不在」被当成「在」，而两边都不报错）。
        const absent = !!(f as { absent?: boolean }).absent
        return !!p.scene?.url && matchUrlPattern(f.pattern, p.scene.url) !== absent
      }
      unverified.push(f.kind)
      return true
    }
  }

  private gateAndStore(
    runId: string,
    p: StateProposal,
    kind: Exclude<AskInput['kind'], 'irreversible'>,
    a: Exclude<AskAnswer, { kind: 'unrepairable' | 'irreversible' }>,
    known: StateDef[],
    fp: string,
  ): Proposal {
    const store = this.deps.store
    const base = {
      runId, sourceId: p.sourceId,
      ...(p.facility ? { facility: p.facility } : {}),
      rationale: a.rationale,
      ...(p.scene ? { scene: p.scene } : {}),
    }
    if (a.kind === 'transition') {
      // 目标必须**看起来**能在现场元素里找到（按 name / selector 字面）。真正的 find() 现验还没做。
      const t = a.target as { selector?: string; name?: string }
      const found = !!(t.name && p.scene?.elements.some((e) => e.name === t.name)) || !!t.selector
      const prop = store.addProposal({
        ...base, kind: 'transition', target: { ...t, action: a.action },
        status: found ? 'pending' : 'rejected-by-gate',
        // 两种拒法要分开说：模型压根没给靶子 ≠ 给了个名字但现场没有。写成同一句，人会去现场
        // 元素表里找一个根本不存在的名字。
        ...(found
          ? {}
          : {
              rejection: 'target-unresolvable' as const,
              gateNote: !t.name && !t.selector ? '目标没有 name 也没有 selector' : '现场元素表里没有这个名字',
            }),
      })
      store.appendEvent(runId, {
        kind: 'proposal',
        title: found ? '落一条 transition 提议（待审）' : '目标在现场里找不到，拒',
        data: { proposalId: prop.id },
      })
      return prop
    }
    const unverified: string[] = []
    // **组必须由这里填**（见 gate.ts 头注）：`AskAnswer` 不带 group，不填的话闸永远比不到
    // 有组的状态，与它们的撞车会被整片漏掉。
    // - state：只有当模型给的 stateId 就是某个已知状态时，才沿用那个状态的组（它答的是「这个状态特征漂了」）；
    //   新状态归哪一组人来定，这里留空（默认组）而不是猜一个。
    // - discriminator：要区分的那几个本来就同组，取 candidates[0] 的组。
    const groupOf = (id: string | undefined): string | undefined => known.find((s) => s.id === id)?.group
    const candidate: StateDef = a.kind === 'state'
      ? { id: a.stateId, features: a.features, ...(groupOf(a.stateId) ? { group: groupOf(a.stateId) } : {}) }
      : { id: `${p.sourceId}/__discriminator__`, features: a.features, ...(groupOf(p.candidates?.[0]) ? { group: groupOf(p.candidates?.[0]) } : {}) }
    // 观测账本按 facility 分文件（spec §9.1）；老路径没带 facility 时退回 sourceId，同站的状态会学散——新接线一律带。
    const side = p.scene?.side ?? 'browser'
    // 纵深防守：解析那一关已经按路线拒过了，这里再拦一次。两道都要，是因为它们守的不是同一件事——
    // 解析守「模型这次答歪了」，闸守「任何走到入库这一步的候选」（换个上游、换个缓存路径、
    // 将来多一个提议来源，都从这儿过）。漏了它的代价是整个 facility 的 identify 从此每趟都抛。
    const illegal = candidate.features.find((f) => !featureKindAllowed(side, f.kind))
    const g = illegal
      ? { ok: false as const, rejection: 'not-observed' as const, note: illegalKindWhy(side, illegal.kind) }
      : gateStateLike(candidate, known, this.deps.observations.for(p.facility ?? p.sourceId), this.holdsNow(p, unverified))
    // 闸是**部分的**就得说出来：候选没有 group 时，`checkDiscriminative` 只拿它和无组状态比，
    // 与有组状态的撞车整片没查过。不说的话，一条 `pending` 看起来和「全比过了」一模一样。
    const groupsInKnown = [...new Set(known.map((s) => s.group).filter((x): x is string => !!x))]
    const partialGate = !candidate.group && groupsInKnown.length
      ? `区分度只和无组状态比过：候选没有 group，与 ${groupsInKnown.join('、')} 这些组的状态没比`
      : ''
    const note = [
      g.ok ? '' : g.note,
      unverified.length ? `未现验的特征类型：${[...new Set(unverified)].join('、')}` : '',
      partialGate,
      // 解析期做过的改写也要摆到人眼前（今天只有 stateId 前缀这一条）：提议里的 stateId
      // 已经不是模型原话了，不说的话人审时看到的是一个没人承认写过的名字。
      ...(a.kind === 'state' ? (a.notes ?? []) : []),
    ].filter(Boolean).join('；')
    const prop = store.addProposal({
      ...base, kind, features: a.features,
      ...(a.kind === 'state' ? { stateId: a.stateId } : p.candidates ? { candidates: p.candidates } : {}),
      status: g.ok ? 'pending' : 'rejected-by-gate',
      ...(g.ok ? {} : { rejection: g.rejection }),
      ...(note ? { gateNote: note } : {}),
    })
    store.appendEvent(runId, {
      kind: 'proposal',
      title: g.ok ? `落一条 ${kind} 提议（待审）` : `闸拒：${g.rejection}`,
      data: { proposalId: prop.id, fingerprint: fp, note },
    })
    return prop
  }

  private notifyProposal(runId: string, sourceId: string, prop: Proposal): void {
    this.deps.notify({
      type: 'intervention.proposal', severity: 'info',
      title: `${sourceId}：${proposalHeadline(prop)}，等你审`,
      body: prop.rationale || undefined,
      dedupeKey: `intervention.proposal:${prop.id}`,
      ref: { kind: 'stream', id: sourceId },
      detail: `runId=${runId}\nproposalId=${prop.id}`,
    })
  }

  private notifyError(runId: string, sourceId: string, why: string): void {
    this.deps.notify({
      type: 'intervention.error', severity: 'error',
      title: `${sourceId}：AI 介入没跑成`, body: why,
      // 用短哈希而不是截前 40 字：错误原文常带同样的前缀（"LLM 梯子上没有一个成员答成：…"），
      // 截断后两种完全不同的红会共用一个去重键，第二种被通知中心当重复吞掉。
      dedupeKey: `intervention.error:${sourceId}:${shortHash(why)}`,
      ref: { kind: 'stream', id: sourceId },
      detail: `runId=${runId}`,
    })
  }
}
