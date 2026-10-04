import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import type { LlmForTask } from '../llm/task.ts'
import type { ObservationLedger } from '../replay/observation-ledger.ts'
import { DomPerception } from '../replay/state-perception-dom.ts'
import type { PageDriver } from '../../shared/browser-relay/page-driver.ts'
import { assertStateIdPrefix, checkDiscriminative, featureKey, type Feature, type StateDef, type StateGraph, type StateId } from '../replay/state-graph.ts'
import type { StateGraphStore } from '../replay/state-graph-store.ts'
import { assembleGraph } from '../replay/state-assemble.ts'
import { BUILTIN_STATES } from '../replay/states-builtin.ts'
import type { AgentConfig } from './agent-config.ts'
import { AgentSessionBase, type AgentSessionDeps, type FinishReason } from './agent-session.ts'
import type { GateName } from './gates.ts'
import { classifyPermissionExplore, type ExploreDecision } from './approval.ts'
import { askOnce, ALLOWED_FEATURE_KINDS } from './ask.ts'
import {
  draftPath, frontierOf, isExhausted, newDraft, noteFrontier, readDraft, recordAct, setStart, stableSelector, writeDraft,
  type EdgeEffect, type ExploreDraft, type FrontierItem,
} from './explore-graph.ts'
import type { ExploreSurface } from './explore-surface.ts'
import { buildExploreTaskBook } from './explore-task-book.ts'
import type { RunRecord } from './types.ts'

export interface ExploreJobInput {
  facility: string
  /** 露面挂在哪一行：该 facility 下第一个源的 id。 */
  sourceId: string
  target: string
  goal: string
  config: AgentConfig
  limits: { maxStates: number; maxDepth: number }
}

export const DEFAULT_EXPLORE_LIMITS = { maxStates: 60, maxDepth: 8 }

export interface ExploreSessionDeps extends AgentSessionDeps {
  surface: (target: string) => ExploreSurface
  /** **现取**：`stream add` 之后包自带那层会整体换掉，装配期取一次就是冻住的那份。 */
  graphs: Pick<StateGraphStore, 'graphFor'>
  observations: Pick<ObservationLedger, 'for' | 'record'>
  /** 拉黑闸问的那个运行时模型。缺席（没配 / 额度尽）→ 该屏整个冻结，**不赌**。 */
  llm: () => LlmForTask | undefined
  /** 草稿图落在哪（`<dataDir>/explore-drafts`）。 */
  draftDir: string
}

export type RecordStateResult =
  /**
   * `edgeRecorded`：起名同时把「刚才那一步」补成了一条边（点完认不出的那条，或被判成死键而其实开出了这一屏的那条）。
   * `replaced`：改的是本次草稿里同名那条的特征，不是新起了一屏。
   */
  | { ok: true; stateId: StateId; edgeRecorded: boolean; replaced: boolean }
  | { ok: false; reason: 'not-discriminative'; collidesWith: StateId[] }
  | { ok: false; reason: 'bad-feature' | 'bad-id' | 'clash'; why: string }

export interface ActResult {
  from: StateId
  to: StateId | 'unknown' | 'unchanged'
  effect: EdgeEffect
  edgeRecorded: boolean
  /**
   * **点完这一步人此刻在哪**——和 `to` 不是一回事，混用是这条线最容易犯的错。
   *
   * `to` 说的是这条边通向哪；`at` 说的是判完效果之后我们站在哪一屏。`reversible` 那一档为了判效果
   * 退过一次又点了回来（`replayTo`），`one-way` 那一档留在实际所在（不一定是 `to`），`noop` 哪也没去。
   * agent 下一步要 `graph_frontier` 的正是 `at` 这一屏，没有这一格它只能猜。
   */
  at: StateId | 'unknown'
}

/**
 * 一次 `explore` run（spec §6）。**图由 Stream 持有**：agent 只经五个建图工具出主意，
 * 点、认、记边、算 frontier、判收敛全在这里。生命周期 / 主循环 / 审批 / 看门狗 / 收尾在
 * `AgentSessionBase`；这里只补探索这一档特有的三样：任务书、一轮之后判收敛、五个工具面。
 *
 * 为什么不让 agent 自己点：边的 `effect`（点完退不退得回）只有真点一次才知道，而模型自报的边
 * 一条都不能收——收了就等于把一张**没验过**的图写进状态图，运行期才在某个有副作用的动作上炸。
 */
export class ExploreSession extends AgentSessionBase<ExploreSessionDeps> {
  private draft: ExploreDraft
  private readonly surface: ExploreSurface
  private current: StateId | null = null
  /** 点了之后没认出的那一步：起名成功后补落这条边。 */
  private pendingEdge?: { from: StateId; via: FrontierItem }
  /** 上一次被判成死键的那一步。**下一次 act / frontier 就作废**——补边的机会只有紧接着那一下。 */
  private lastNoop?: { from: StateId; via: FrontierItem }
  private readonly history: StateId[] = []
  private readonly draftFile: string
  /** 空转闸的账：连续多少轮草稿一个字没变。 */
  private idleTurns = 0
  private lastSig: string

  constructor(deps: ExploreSessionDeps, private readonly job: ExploreJobInput, existing?: { run: RunRecord }) {
    super(deps, {
      kind: 'explore',
      sourceId: job.sourceId,
      command: job.config.command,
      limits: job.config.limits,
      label: `${job.facility} 探索`,
      // 探索挂在 facility 上，露面时落到该包第一个源那一行（spec §8）。
      ref: { kind: 'stream', id: job.sourceId },
      noun: '探索',
    }, existing)
    this.surface = deps.surface(job.target)
    this.draftFile = draftPath(deps.draftDir, job.facility, this.runId)
    this.draft = readDraft(this.draftFile) ?? newDraft({ runId: this.runId, facility: job.facility, target: job.target, goal: job.goal })
    this.lastSig = draftSignature(this.draft)
  }

  /** 只读快照：给测试与 §8 露面读草稿用（外面拿到的是副本，改不动我们的图）。 */
  draftSnapshot(): ExploreDraft { return structuredClone(this.draft) }

  async start(): Promise<void> {
    try {
      const cwd = join(this.deps.workRoot, this.runId)
      mkdirSync(cwd, { recursive: true })
      await this.openAndNew(cwd)
      // 先认一眼当前屏：认出来就直接有 frontier，认不出（常态——图还空着）就等 agent 起名。
      this.current = await this.identify()
      await this.runLoop(buildExploreTaskBook({
        runId: this.runId,
        facility: this.job.facility,
        target: this.job.target,
        goal: this.job.goal,
        mcpToolNames: this.deps.mcpToolNames(),
        limits: this.job.limits,
      }))
    } catch (e) {
      this.failRun('agent_spawn_failed', e)
    }
  }

  protected resumePrompt(): string { return '后端重启过一次，接着探。先 graph_frontier 看看我们在哪。' }

  protected permissionPolicy(req: RequestPermissionRequest): ExploreDecision {
    return classifyPermissionExplore(req)
  }

  // ── 一轮之后：判收敛 ────────────────────────────────────────────────────────

  protected async afterTurn(): Promise<void> {
    if (this.draft.states.length >= this.job.limits.maxStates) {
      // `StopReason` 里没有 `gate:states` 这一档，借 `gate:turns` 记账——文案说清是**状态数**到顶，
      // 别让读的人以为 agent 话说多了。
      this.emitGraph({ produced: this.draft.states.length ? 'proposal' : 'nothing', reason: 'gate:turns' }, `状态数到上限 ${this.job.limits.maxStates}，截断`)
      return
    }
    if (isExhausted(this.draft) && !this.pendingEdge && this.current !== null) {
      this.emitGraph({ produced: this.draft.states.length ? 'proposal' : 'nothing', reason: 'frontier-exhausted' }, 'frontier 空了，收敛')
      return
    }
    if (this.noteIdleTurn()) {
      this.pause({ why: `agent 连续 ${IDLE_TURNS} 轮没有推进探索`, snapshot: { idleTurns: this.idleTurns, states: this.draft.states.length, transitions: this.draft.transitions.length } })
      return
    }
    const where = this.current ?? '（没认出的屏，先 graph_record_state 起名）'
    const remaining = Object.values(this.draft.remaining).reduce((a, b) => a + b, 0)
    this.setNextPrompt(this.withQueued(
      `进度：${this.draft.states.length} 个状态、${this.draft.transitions.length} 条边，frontier 还剩约 ${remaining}。你在 ${where}。继续。`,
    ))
  }

  /**
   * 空转闸：**连续 N 轮草稿一个字没变就暂停**（spec §6）。
   *
   * 闸不是判据，这一条也一样——但没有它，一个只顾说话不调工具的 agent 会一路把 turns 闸撞满：
   * 每一轮都要真发一次 prompt、真烧一次 token，而人看到的只是「在跑」。**判据是草稿有没有动**，
   * 不是 agent 说了什么：它可以调了五个工具全被拒、也可以只是复述任务书，两种在文本上分不出来，
   * 在草稿上一目了然。
   *
   * `continue()` 时归零（见下），否则人点一次继续、下一轮又立刻撞上同一道闸。
   */
  private noteIdleTurn(): boolean {
    const sig = draftSignature(this.draft)
    if (sig === this.lastSig) this.idleTurns++
    else { this.idleTurns = 0; this.lastSig = sig }
    return this.idleTurns >= IDLE_TURNS
  }

  override continue(): boolean {
    this.idleTurns = 0
    this.lastSig = draftSignature(this.draft)
    return super.continue()
  }

  // ── 建图工具 ────────────────────────────────────────────────────────────────

  async frontier(): Promise<{ state: StateId | null; items: FrontierItem[]; exhausted: boolean; blocked: number }> {
    this.beat()
    // 要清单 = 重新看这一屏，上一次 noop 的补边机会过期（这一屏到底变没变，现在由它自己说）。
    this.lastNoop = undefined
    if (this.current === null) return { state: null, items: [], exhausted: false, blocked: 0 }
    const state = this.current
    const blockedCount = (): number => this.draft.blocked[state]?.length ?? 0
    if (this.draft.frozen.includes(state) || this.draft.irrelevant.includes(state)) {
      return { state, items: [], exhausted: isExhausted(this.draft), blocked: blockedCount() }
    }
    const dead = this.deadEndOf(state)
    if (dead !== undefined) {
      // **死路上一条边都不能落。** `validateStateGraph` 明说「已声明为死路的状态不该再有出口」，
      // 而 `known()` 每次都过 `assembleGraph` 的校验——真落下去之后，此后每一次 identify 都抛，
      // 这条 run 再也回不来（而且抛的地方离死因十万八千里）。所以拦在列清单这一步，不是拦在写图那一步。
      this.draft = noteFrontier(this.draft, state, [])
      this.persist()
      this.event('message', `${state} 是死路（${dead}），不展开`, { state, deadEnd: dead })
      return { state, items: [], exhausted: isExhausted(this.draft), blocked: blockedCount() }
    }
    // 拉黑闸一屏只问一次：`blocked[state]` 有没有这一格就是「问过没有」的判据。
    if (this.draft.blocked[state] === undefined) {
      await this.beatAround(() => this.screen(state))
      if (this.draft.frozen.includes(state)) return { state, items: [], exhausted: isExhausted(this.draft), blocked: blockedCount() }
    }
    if ((this.draft.depth[state] ?? 0) >= this.job.limits.maxDepth) {
      this.draft = noteFrontier(this.draft, state, [])
      this.persist()
      this.event('message', `${state} 已到最大深度 ${this.job.limits.maxDepth}，不再展开`, { state })
      return { state, items: [], exhausted: isExhausted(this.draft), blocked: blockedCount() }
    }
    const items = frontierOf(this.draft, state, await this.surface.inventory())
    this.draft = noteFrontier(this.draft, state, items)
    this.persist()
    this.event('tool_call', `frontier@${state}：${items.length} 条可点`, { state, refs: items.map((i) => i.ref) })
    return { state, items, exhausted: isExhausted(this.draft), blocked: blockedCount() }
  }

  async act(ref: number, note?: string): Promise<ActResult> {
    this.beat()
    if (this.current === null) throw new Error('当前屏还没认出——先 graph_record_state 起名')
    if (this.pendingEdge) throw new Error('上一步到了一个没见过的屏，先 graph_record_state 起名（或 graph_back）')
    const from = this.current
    const dead = this.deadEndOf(from)
    if (dead !== undefined) throw new Error(`${from} 是死路（${dead}），死路上不能点——先 graph_back 退出去`)
    // **拉黑闸必须在这里也过一遍，不能只挂在 `frontier()` 上。** agent 手里有允许的
    // `cdp_look({inventory:true})`，编号它自己就能拿到——不经 frontier 直接 `graph_act` 时，
    // `blocked[from]` 还是 undefined、frozen 也没查过，那道「点了收不回」的闸就整个绕过去了，
    // 而它正是真账号上的第二道防线。闸要挂在**动作**上，不是挂在看清单那一步上。
    if (this.draft.frozen.includes(from)) throw new Error(`${from} 没过拉黑闸（这一屏不探），点不了——换一屏或 graph_back`)
    if (this.draft.blocked[from] === undefined) {
      await this.beatAround(() => this.screen(from))
      if (this.draft.frozen.includes(from)) throw new Error(`${from} 没过拉黑闸（这一屏不探），点不了——换一屏或 graph_back`)
    }
    // 这一步要么落自己的边、要么什么都没发生——上一次 noop 的补边机会到此为止。
    this.lastNoop = undefined
    const items = frontierOf(this.draft, from, await this.surface.inventory())
    const via = items.find((i) => i.ref === ref)
    if (!via) throw new Error(`ref ${ref} 不在 ${from} 的 frontier 里（点过 / 被拉黑 / 没有稳定选择器 / 编号过期——重新 graph_frontier）`)
    this.event('tool_call', `点 #${ref}${via.name ? `「${via.name}」` : ''}${note ? `：${note}` : ''}`, { from, ref, selector: via.selector })
    const clicked = await this.beatAround(() => this.surface.click(ref))
    // 点不着 / 点了没变都记成 noop：记它只为**不再点它**，不落边。
    // **先等这一屏停下来再认**：点击是异步的，认得太早会把一次真实的导航读成死键（`settle` 的头注）。
    const to = clicked ? await this.beatAround(() => this.settled()) : from
    if (to === from) {
      this.draft = recordAct(this.draft, { from, to: undefined, via, effect: 'noop' })
      this.persist()
      // **「identify 认不出变化」不等于「什么都没发生」。** 活体（xhs，2026-09-12）：点搜索框
      // 开出一个面板，URL 一个字没变、当前状态仍是 `from`，我们判成死键——而 agent 紧接着用
      // dom 特征给那一屏起了名。记住这一步，起名成功时补落这条边（见 `recordState`）。
      this.lastNoop = { from, via }
      this.event('tool_result', `${from} 点 #${ref} 没变化（死键；这一屏若其实变了，现在 graph_record_state 给它起名，我会补上这条边）`, { from, ref })
      return { from, to: 'unchanged', effect: 'noop', edgeRecorded: false, at: from }
    }
    if (to === null) {
      // 认不出：边先挂起，等 `graph_record_state` 起名成功再补落（effect 那时才判得了）。
      this.pendingEdge = { from, via }
      this.current = null
      this.event('tool_result', `${from} 点 #${ref} 到了一个没见过的屏，等你起名`, { from, ref })
      return { from, to: 'unknown', effect: 'one-way', edgeRecorded: false, at: 'unknown' }
    }
    const effect = await this.beatAround(() => this.judgeEffect(from, to, via))
    this.draft = recordAct(this.draft, { from, to, via, effect, ...(effect === 'reversible' ? { backSteps: [{ do: 'back' }] } : {}) })
    this.persist()
    // `at` 取判完效果之后的实际所在：reversible 已被 `replayTo` 送回 `to`，one-way 留在实际所在。
    const at = this.current ?? 'unknown'
    this.event('tool_result', `${from} → ${to}（${effect}），现在在 ${at}`, { from, to, effect, at })
    return { from, to, effect, edgeRecorded: true, at }
  }

  async recordState(i: { id: string; features: unknown[]; group?: string; note?: string }): Promise<RecordStateResult> {
    this.beat()
    try { assertStateIdPrefix(this.job.facility, i.id) } catch (e) { return { ok: false, reason: 'bad-id', why: (e as Error).message } }
    const bad = badFeatures(i.features)
    if (bad) return { ok: false, reason: 'bad-feature', why: bad }
    const feats = i.features as Feature[]
    const known = this.known()
    // **本次草稿里自己起的名可以再改特征，别人的不行。** 活体（xhs，2026-09-12 第二条）：agent 先给
    // `xhs/home` 写了 `/explore*`，随后发现笔记详情 `/explore/<id>` 也匹配、想收紧成 dom 特征——
    // 一律拒的话，那个太宽的判据就被钉死在图里，而它会把后面每一屏都认成首页。
    // 包自带 / 学到的那两层仍然拒：那是别人已经接受过的定义，改它是另一件事（走提议）。
    const replaced = this.draft.states.some((s) => s.id === i.id)
    if (!replaced && known.states.some((s) => s.id === i.id)) return { ok: false, reason: 'clash', why: `${i.id} 已经存在（包自带 / 学到的），改它要走提议` }
    const def: StateDef = { id: i.id, features: feats, ...(i.group ? { group: i.group } : {}), ...(i.note ? { note: i.note } : {}) }
    const gate = checkDiscriminative(def, known.states, this.deps.observations.for(this.job.facility))
    if (!gate.ok) return { ok: false, reason: 'not-discriminative', collidesWith: gate.collidesWith }
    // 这一屏必须真的匹配它自己起的名字——否则起了个名却认不出，frontier 永远列不出来，
    // 而每一处看起来都正常（状态进了图、闸也过了）。
    const r = await this.beatAround(() => this.perception().identify([def]))
    if (r.states === null) return { ok: false, reason: 'bad-feature', why: '这组特征在当前屏上不成立——起名要描述你现在看到的这一屏' }
    // 这一屏是从哪儿来的：明着挂起的那条（点完认不出），或上一次被判成死键、而它其实开出了
    // 这一屏的那条。`from !== 新 id` 是必须的——同一屏又起一次名不该给自己连一条自环。
    const pending = this.pendingEdge ?? (this.lastNoop && this.lastNoop.from !== def.id ? this.lastNoop : undefined)
    // 改特征不动深度：那一格记的是「从起点几步能到」，和这一屏叫什么、拿什么认出来无关。
    const depth = replaced ? (this.draft.depth[def.id] ?? 0) : pending ? (this.draft.depth[pending.from] ?? 0) + 1 : (this.draft.depth[def.id] ?? 0)
    this.draft = {
      ...this.draft,
      states: replaced ? this.draft.states.map((s) => (s.id === def.id ? def : s)) : [...this.draft.states, def],
      depth: { ...this.draft.depth, [def.id]: depth },
    }
    // 起点按构造没有入边——`isExhausted` 的 one-way 判据要靠它，不然第一个状态会被当成「到不了」。
    if (depth === 0) this.draft = setStart(this.draft, def.id)
    this.persist()
    this.event(
      'proposal',
      replaced
        // 「点过」是按选择器记在这个 id 名下的，而旧特征认出来的可能不止这一屏——换了特征之后，
        // 那些记录仍挂在这个 id 上。审图的人要知道这一点，我们自己没法替他分辨。
        ? `改了 ${def.id} 的特征；旧特征期间记下的「点过」可能混进别的屏上的入口，审图时留意`
        : `新状态 ${def.id}`,
      { state: def, replaced },
    )
    this.current = def.id
    this.pendingEdge = undefined
    this.lastNoop = undefined
    // 改特征不落边：那一步点击在上一次起名时就已经记过账了，再记一次就是同一条路记两遍。
    if (!pending || replaced) return { ok: true, stateId: def.id, edgeRecorded: false, replaced }
    const { from, via } = pending
    const effect = await this.beatAround(() => this.judgeEffect(from, def.id, via))
    this.draft = recordAct(this.draft, { from, to: def.id, via, effect, ...(effect === 'reversible' ? { backSteps: [{ do: 'back' }] } : {}) })
    this.persist()
    this.event('tool_result', `${from} → ${def.id}（${effect}）`, { from, to: def.id, effect })
    return { ok: true, stateId: def.id, edgeRecorded: true, replaced }
  }

  async back(): Promise<{ at: StateId | 'unknown'; how: 'edge' | 'browser-back' | 'none' }> {
    this.beat()
    const prev = this.history.at(-1)
    const depth = this.history.length
    await this.beatAround(() => this.surface.back())
    const at = await this.beatAround(() => this.settled())
    if (at === null) {
      // **认不出就说认不出**，别把 `current` 留在退回之前那一屏（和 `act()` 的 unknown 支对齐）：
      // 留着的话下一次 `frontier()` 会列出一屏我们其实已经不在的元素，`act()` 照着它去点，
      // 而每一步的回执都正常。
      this.current = null
      return { at: 'unknown', how: 'none' }
    }
    // 退回本身就是一次「我在哪」的更新：挂起的那条边没法再判效果了，丢掉它比留着假装能补更诚实。
    // `lastNoop` 同理，而且更坏——留着它，「点了没反应 → 退回去 → 给退到的这一屏起名」会落一条
    // **假边**（那一下点击根本没通向这里），而假边和真边在图里长得一模一样。
    this.pendingEdge = undefined
    this.lastNoop = undefined
    // **退回要让 history 变浅，不是变深。** `identify()` 每换一屏就往栈里压一个「我刚才在哪」，
    // 而这一次换屏是**往回走**：压进去的那格得撤掉，真退到了上一格还要把那一格也消费掉。
    // 只涨不消的话，「上一个状态」会永远停在很早以前的某一屏，之后每次 back 的 `how` 都读成
    // browser-back，而它本该是这条链上最近的一步。
    this.history.length = depth
    if (prev !== undefined && at === prev) {
      this.history.pop()
      return { at, how: 'edge' }
    }
    return { at, how: 'browser-back' }
  }

  markIrrelevant(state: StateId): { ok: boolean } {
    if (!this.draft.states.some((s) => s.id === state)) return { ok: false }
    if (!this.draft.irrelevant.includes(state)) this.draft = { ...this.draft, irrelevant: [...this.draft.irrelevant, state] }
    this.persist()
    this.event('message', `${state} 标为与目标无关，不再展开`, { state })
    return { ok: true }
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  /** 这一屏是不是死路（包自带 / 全局 / 草稿都算），是就回人能读的那句理由。 */
  private deadEndOf(state: StateId): string | undefined {
    return this.known().states.find((s) => s.id === state)?.deadEnd
  }

  private perception(): DomPerception {
    return new DomPerception(this.surface.perceptionDriver() as unknown as PageDriver)
  }

  /**
   * **内置全局 ∪ 包自带 ∪ 学到的 ∪ 本次草稿**——四层，不是三层。
   *
   * `graphFor` 只合后两层，全局那张（`BUILTIN_STATES`：CF 三档）是 `assembleGraph` 并进去的，
   * 而全仓只有 `recipe-runner` 调它。漏掉这一层的代价不是少认一个状态：撞上 Cloudflare 挑战页时
   * identify 回 null，探索会把那一屏当成**一个没见过的新屏**交给 agent 起名，于是一条描述 CF 拦截页的
   * 「状态」被提议进这个 facility 的图——而拦截页是同源返回的，URL 一个字不变，它看起来完全正常。
   */
  private known(): StateGraph {
    const g = this.deps.graphs.graphFor(this.job.facility)
    return assembleGraph(BUILTIN_STATES, {
      states: [...(g?.states ?? []), ...this.draft.states],
      transitions: [...(g?.transitions ?? []), ...this.draft.transitions.map((t) => ({ from: t.from, ...(t.to ? { to: t.to } : {}), steps: t.steps }))],
    })
  }

  /** 等这一屏停下来，再认。**动过页面之后的每一次 identify 都要走它**——见 `ExploreSurface.settle` 的头注。 */
  private async settled(): Promise<StateId | null> {
    const r = await this.surface.settle()
    // **退路要留痕**：等到头了还在动，接下来这一认就是在一个没停稳的屏上做的——它认错的概率比
    // 平时高得多。不说的话，「等稳之后认的」和「等烦了认的」在事件流里长得一模一样。
    if (!r.settled) {
      this.event('message', `这一屏等了 ${Math.round(r.waitedMs / 1000)}s 还没停下来，按当前样子认`, { waitedMs: r.waitedMs, settled: false })
    }
    return this.identify()
  }

  /** 认状态。认出就记一笔观测（区分度闸靠它才有东西可撞）；同组歧义当没认出，等 agent 加特征。 */
  private async identify(): Promise<StateId | null> {
    const known = this.known()
    if (known.states.length === 0) return null
    const r = await this.perception().identify(known.states)
    if (r.states === null) return null
    const truths = r.matched.map(featureKey)
    for (const id of r.states) {
      try { this.deps.observations.record(this.job.facility, { state: id, truths }) } catch { /* 记不上不挡探索 */ }
    }
    const pick = this.pickState(known, r.states)
    if (this.current !== null && this.current !== pick) this.history.push(this.current)
    this.current = pick
    return pick
  }

  /**
   * 多命中（跨组）是合法的——状态是部分描述，一屏上同时成立好几个很正常。挑哪个当「我在哪」有次序：
   *
   * 1. **死路优先**：认出 `deadEnd` 就该立刻停，而它常常和一个 url 特征的本地状态同时成立
   *    （CF 拦截页同源返回，URL 一个字不变）。
   * 2. **非草稿优先**：全局 / 包自带那几条是别人验过的定义，草稿里的是这一轮刚起的名字。
   *    反过来（草稿优先）会让一个宽松的 url 状态**吞掉**全局障碍页——症状是探索在挑战页上继续点。
   * 3. 最后才是草稿。
   */
  private pickState(known: StateGraph, hits: StateId[]): StateId {
    const isDraft = (id: StateId): boolean => this.draft.states.some((s) => s.id === id)
    const dead = hits.find((id) => known.states.find((s) => s.id === id)?.deadEnd)
    return dead ?? hits.find((id) => !isDraft(id)) ?? hits[0]!
  }

  /**
   * 效果：退一次看能不能回到 from（spec §5.2）。**判据始终是「退回后 identify 认出 from」**，
   * 不是「back() 没报错」。
   *
   * 判出 reversible 之后**把那一步再点一遍，让人停在 `to`**——这不是可有可无的收尾：
   * `recordAct` 会把这次的选择器记进 `visited[from]`，同一个入口再也不会出现在 from 的 frontier 里；
   * 而我们没有 `graph_goto`。不重放的话 `to` 从此**没有任何人能走到**，它的 frontier 一次都列不出来，
   * `remaining[to]` 永远是 undefined，`isExhausted` 永远为假——只要图里出现过一条可逆边，
   * `frontier-exhausted` 就永远不会发生，而每一步看起来都正常。
   *
   * 重放的风险是零新增：这一步刚刚被证明可逆，我们是照原样再走一遍。
   */
  private async judgeEffect(from: StateId, to: StateId, via: FrontierItem): Promise<EdgeEffect> {
    await this.surface.back()
    const at = await this.settled()
    if (at !== from) {
      // 退不回：把 current 修正成实际所在（可能是 to，也可能是别处）
      this.current = at ?? to
      return 'one-way'
    }
    await this.replayTo(from, to, via)
    return 'reversible'
  }

  /** 把刚证明可逆的那一步再走一遍。**按选择器重新找编号**：退回之后 inventory 重编号，旧 ref 可能指着别的东西。 */
  private async replayTo(from: StateId, to: StateId, via: FrontierItem): Promise<void> {
    const again = (await this.surface.inventory()).find((i) => stableSelector(i) === via.selector)
    const landed = again && (await this.surface.click(again.n)) ? await this.settled() : null
    if (landed === to) return
    // 重放没回到 to：**如实说，不假装我们在 to**。current 已由 identify 修正（或退回 from）。
    this.current = landed ?? from
    this.event('message', `${from} → ${to} 判为可逆，但重放那一步没回到 ${to}（现在在 ${this.current}）——${to} 这一屏这轮展不开`, { from, to, at: this.current })
  }

  /** 拉黑闸（spec §5.3）：一屏一次问运行时模型；模型不可用或答歪 → 整屏 frozen。宁可少探，不赌。 */
  private async screen(state: StateId): Promise<void> {
    const llm = this.deps.llm()
    if (!llm) { this.freeze(state, '没配运行时模型'); return }
    try {
      const scene = await this.surface.scene()
      const items = frontierOf(this.draft, state, await this.surface.inventory())
      const a = await askOnce(llm, {
        kind: 'irreversible', sourceId: this.job.sourceId, side: 'browser', facility: this.job.facility,
        known: [], reason: '探索前筛一屏', scene,
      })
      // **不算一轮**：这是一屏问一次的闸，不是一轮对话。算进 turns 就是拿问闸次数去撞 agent 的轮数闸。
      this.deps.store.addUsage(this.runId, { ...a.usage, wallMs: a.wallMs }, { countTurn: false })
      if (!a.answer.ok) throw new Error(a.answer.why)
      const ans = a.answer.answer
      if (ans.kind !== 'irreversible') throw new Error(`模型没按格式回答：${ans.kind}`)
      const refs = new Set(ans.refs)
      const blocked = items.filter((i) => refs.has(i.ref)).map((i) => i.selector)
      this.draft = { ...this.draft, blocked: { ...this.draft.blocked, [state]: blocked } }
      this.persist()
      this.event('message', `${state} 拉黑闸：剔掉 ${blocked.length} 个（${ans.rationale}）`, { state, refs: [...refs], blocked })
    } catch (e) {
      this.freeze(state, (e as Error).message)
    }
  }

  private freeze(state: StateId, why: string): void {
    this.draft = { ...this.draft, frozen: [...this.draft.frozen, state], blocked: { ...this.draft.blocked, [state]: [] } }
    this.persist()
    this.event('message', `${state} 没过拉黑闸（${why}），这一屏不探`, { state, why })
  }

  private emitGraph(stopped: { produced: 'proposal' | 'nothing'; reason: FinishReason }, why: string): void {
    if (stopped.produced === 'proposal') this.addGraphProposal(why)
    this.finish(stopped)
  }

  /** 把手里这份草稿落成一条待审提议（不收尾）。收敛 / 截断 / 取消三条路都用它——**草稿非空就有价值**。 */
  private addGraphProposal(why: string): void {
    const p = this.deps.store.addProposal({
      runId: this.runId, sourceId: this.job.sourceId, facility: this.job.facility,
      kind: 'graph', draft: this.draft, rationale: why, status: 'pending',
    })
    this.event('proposal', `探索图：${this.draft.states.length} 个状态、${this.draft.transitions.length} 条边，待并入`, { proposalId: p.id })
    this.deps.notify({
      type: 'intervention.proposal',
      severity: 'info',
      title: `${this.job.facility}：探索交出 ${this.draft.states.length} 个状态的图，等你并入`,
      body: why,
      dedupeKey: `intervention.proposal:${p.id}`,
      ref: { kind: 'stream', id: this.job.sourceId },
      detail: `runId=${this.runId}\nproposalId=${p.id}`,
    })
  }

  /**
   * agent 说「探不下去」——**放弃的是后半程，不是已经探到的那部分**。草稿非空就先把图交出来，
   * 通知照发（人要知道这条 run 是 agent 主动放弃的，不是探完了）。活体 2026-09-12 的 xhs 那条
   * run 就是这么白探的：两个状态、一条边，agent 一句 `UNREPAIRABLE:` 之后一条提议都没落。
   */
  protected override onUnrepairable(why: string): 'default' | 'handled' {
    if (!this.draft.states.length) return 'default'
    this.emitGraph({ produced: 'proposal', reason: 'end_turn' }, `agent 说探不下去了：${why}`)
    this.notifyVerdict(why)
    return 'handled'
  }

  /**
   * 撞闸也要交图（spec §5.4：收敛与截断**都**交提议，`nothing` 只在草稿为空时）。
   * 默认的「暂停等人续」对探索是错的——人回来点继续要么接着探、要么取消，而取消那条路
   * 在没有这一步时把整份草稿当垃圾扔了：几十次真点击换来的图，一个闸就没了。
   */
  protected override onGate(hit: GateName): 'pause' | 'handled' {
    if (!this.draft.states.length) return 'pause'
    this.emitGraph({ produced: 'proposal', reason: `gate:${hit}` }, `撞了 ${hit} 闸，把探到的这一份交出来`)
    return 'handled'
  }

  /**
   * 人点取消：**先把草稿交出来再收尾**。基类的 `cancel()` 按「库里有没有提议」决定 produced，
   * 所以这里只要在它之前落一条提议就够了——不自己 finish，否则基类那段「等子进程真的走开」
   * 会被 terminal 挡掉，dispose() 就等不到 agent 退出了。
   */
  override async cancel(): Promise<void> {
    if (!this.terminal && this.draft.states.length && !this.deps.store.proposals({ runId: this.runId }).length) {
      this.addGraphProposal('人点了取消，把探到的这一份交出来')
    }
    await super.cancel()
  }

  /**
   * 长活前后各报一次心跳。`screen()` 要问模型、`identify()` 要打一串 DOM 查询，都可能比看门狗的
   * idle 还久——不报的话它会把「我们自己在干活」判成 `agent_stalled`，run 当场被自己的看护杀掉。
   */
  private async beatAround<T>(fn: () => Promise<T>): Promise<T> {
    this.beat()
    try { return await fn() } finally { this.beat() }
  }

  private persist(): void { writeDraft(this.draftFile, this.draft) }
}

/** 连续多少轮草稿没变算空转。 */
const IDLE_TURNS = 3

/**
 * 「这一轮探索有没有推进」的规范化指纹。**只取真正代表进展的那几格**——`remaining` / `depth` 是
 * 从它们算出来的，`frozen` 跟着 `blocked` 走。键排序后序列化：同一份内容按不同插入顺序序列化出
 * 两个串的话，空转闸会把「原地踏步」读成「有进展」，而它正是为了拦这个。
 */
function draftSignature(d: ExploreDraft): string {
  const sortedMap = (m: Record<string, string[]>): [string, string[]][] =>
    Object.keys(m).sort().map((k) => [k, [...(m[k] ?? [])].sort()])
  return JSON.stringify({
    states: d.states.map((s) => s.id).sort(),
    transitions: d.transitions.map((t) => `${t.from}>${t.to ?? ''}:${t.effect}:${t.via.selector}`).sort(),
    visited: sortedMap(d.visited),
    blocked: sortedMap(d.blocked),
    irrelevant: [...d.irrelevant].sort(),
  })
}

/** 特征白名单 + 载荷检查。返回一句为什么不收，`undefined` = 收。 */
function badFeatures(features: unknown[]): string | undefined {
  if (!Array.isArray(features) || features.length === 0) return '特征不能为空——空特征匹配一切，等于把 identify 关掉'
  for (const f of features) {
    const k = (f as { kind?: string } | null)?.kind
    if (!k || !(ALLOWED_FEATURE_KINDS.browser as readonly string[]).includes(k)) {
      return `网页面只认 ${ALLOWED_FEATURE_KINDS.browser.join(' / ')} 特征，收到 ${String(k)}`
    }
    if (k === 'url' && typeof (f as { pattern?: unknown }).pattern !== 'string') return 'url 特征要有 pattern'
    if (k === 'dom' && typeof (f as { selector?: unknown }).selector !== 'string') return 'dom 特征要有 selector'
  }
  return undefined
}
