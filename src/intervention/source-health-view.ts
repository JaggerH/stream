import type { SourceManifest } from '../manifest/types.ts'
import type { SourceHealth } from '../source-health-store.ts'
import type { FailureCategory } from '../failure.ts'
import type { RepairState } from '../replay/repair-ledger.ts'
import type { Stream, StreamMember } from '../streams/types.ts'
import type { ChannelRecord } from '../store/types.ts'
import { publicSource, fallbackSource, type SourceSummary } from '../registry/public.ts'
import { localNameOf } from '../registry/source-id.ts'
import { canonicalJson } from './canonical.ts'
import { parseUnrepairable } from './task-book.ts'
import type { Proposal, ProposalStatus, RecipeValidation, RunErrorCode, RunEvent, RunRecord, RunStatus, Stopped, Usage } from './types.ts'

/**
 * 「这个源现在什么状态」——把三本账（健康 / 关禁 / 修复 run）合成**一个词**（spec 2026-09-12 §5）。
 *
 * 为什么后端算、前端只译：三本账的键与语义前端一份都没有；让前端从三份原始数据里推，
 * 每个入口（列表 / 频道配置 / 通知）都会推出自己那一版，且漂了不报错。
 */
export type SourceHealthStatus =
  | 'awaiting' | 'exploring' | 'repairing' | 'proposed' | 'unrepairable' | 'quarantined' | 'auth' | 'dead' | 'degraded' | 'ok'

export interface StepDiff {
  /** 1 起的步骤号；**0 = recipe 顶层字段**（`session.url` 这类不在任何一步里的改动）。 */
  step: number
  kind: 'changed' | 'added' | 'removed'
  field?: string
  before?: unknown
  after?: unknown
}

export interface PendingPermission {
  permissionId: string
  title: string
  reason?: string
  options: Array<{ optionId: string; name: string; kind: string }>
}

export interface SourceHealthView {
  source: SourceSummary
  status: SourceHealthStatus
  health: { state: SourceHealth['state']; lastError?: string; lastErrorCategory?: FailureCategory; lastAt: string }
  quarantine?: { since: string; reason: string; recipeVersion: number; attempts: number; affectedSources: string[] }
  affectedChannels: Array<{ id: string; label: string }>
  run?: {
    id: string
    status: RunStatus
    startedAt: string
    usage: Usage
    limits?: { maxTurns: number; maxTokens: number; maxWallMinutes: number }
    now?: string
    pending?: PendingPermission
    /** 最后一条 `status_changed` 的标题——paused 时就是「为什么停」那句人话。 */
    lastStatusNote?: string
    /** agent 判「修不了」的**理由**（`UNREPAIRABLE: <原因>` 里的那句）。`lastStatusNote` 只说
     *  「结束：verdict-unrepairable / end_turn」，不是理由——这个字段才是。解不出（比如 agent
     *  直接拒绝任务，没有走 UNREPAIRABLE 标记）就缺席，不补空串。 */
    verdict?: string
    stopped?: Stopped
    error?: { code: RunErrorCode; message: string }
  }
  /**
   * 此刻正在跑的那条探索的进度（spec 2026-09-12-explore §8）。**只在探索还活着时给**：
   * 草稿是「正在探」的现场，收尾之后它要么被接受进了学到的层、要么被丢掉，再报一份数字
   * 只会让人以为还有东西在动。
   */
  exploration?: { runId: string; status: RunStatus; states: number; transitions: number; remaining: number }
  /**
   * 等人审的那一条（`recipe` 或 `graph`，pending 优先、否则最近一条）。`kind` 前端用来分流第 ④ 格：
   * `recipe` 看 `diff`，`graph` 看 `graph` 那两个数。
   *
   * **`graph` 类的 `validation` 四格一律 `'n/a'`，不许补 `'ok'`**：那四格问的是「这份候选 recipe
   * 过没过我们那一轮校验」，一张状态图根本没走那条路——补 `'ok'` 等于替一件没发生的事作证。
   */
  proposal?: {
    id: string
    kind: Proposal['kind']
    status: ProposalStatus
    recipePath: string
    validation: RecipeValidation
    diff: StepDiff[]
    /** 只有 `kind:'graph'` 有：这份草稿里有多少个状态、多少条边。 */
    graph?: { states: number; transitions: number }
  }
}

export interface ClassifyInput {
  health?: SourceHealth
  ledger?: RepairState
  /** 最近一条 `repair` / `explore` 的 run（活跃的优先，repair 优先于 explore）。 */
  run?: RunRecord
  pendingProposal: boolean
}

const WAITING: readonly RunStatus[] = ['awaiting_confirmation', 'paused']
const BUSY: readonly RunStatus[] = ['queued', 'running', 'awaiting_input', 'rate_limited']

export function classifySource(i: ClassifyInput): SourceHealthStatus {
  if (i.run && WAITING.includes(i.run.status)) return 'awaiting'
  // 探索排在 repairing 前面：两者都是「agent 正在这个源上干活」，但人要做的事不一样——
  // 修复等着审一份 recipe，探索等着审一整张图。等人那一档（paused / awaiting_confirmation）
  // 两条路是同一颗按钮，所以仍然落在上面的 `awaiting`，不为探索另造一个词。
  if (i.run && i.run.kind === 'explore' && BUSY.includes(i.run.status)) return 'exploring'
  if (i.run && BUSY.includes(i.run.status)) return 'repairing'
  if (i.pendingProposal) return 'proposed'
  const locked = i.ledger?.status === 'quarantined' || i.ledger?.status === 'failed'
  const authError = i.health?.lastOutcome === 'error' && i.health.lastErrorCategory === 'auth'
  /** 「修不了」不该只在关禁态才成立——agent 可能在源还只是 dead/degraded/auth、没进关禁账时就判了
   *  verdict-unrepairable（活体 2026-09-12：brave-search 只是 dead，仍被判 unrepairable，状态词
   *  却停在 dead，四格页第 ④ 格文案高亮到了第 ①）。只要「此刻仍不健康」+「最近一次 repair run 判了
   *  修不了」就成立；源已经被人修好（此刻健康）则不算——那份 verdict 是对着旧状态下的，不该继续挡路。 */
  const unhealthyNow = locked || authError || i.health?.state === 'dead' || i.health?.state === 'degraded'
  if (unhealthyNow && i.run?.stopped?.produced === 'verdict-unrepairable') return 'unrepairable'
  if (locked) return 'quarantined'
  if (authError) return 'auth'
  if (i.health?.state === 'dead') return 'dead'
  if (i.health?.state === 'degraded') return 'degraded'
  return 'ok'
}

const STEP_KEYS = ['steps', 'actions'] as const
/** `version` 恒 +1 是写回规则，不是改动；步骤数组另算。 */
const TOP_LEVEL_SKIP = new Set<string>(['version', ...STEP_KEYS])

function stepsOf(r: unknown): Record<string, unknown>[] {
  const o = (r ?? {}) as Record<string, unknown>
  for (const k of STEP_KEYS) {
    const arr = o[k]
    if (Array.isArray(arr)) return arr.filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
  }
  return []
}

export function stepDiff(before: unknown, after: unknown): StepDiff[] {
  const out: StepDiff[] = []
  const b = (before ?? {}) as Record<string, unknown>
  const a = (after ?? {}) as Record<string, unknown>
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (TOP_LEVEL_SKIP.has(k)) continue
    if (canonicalJson(b[k]) !== canonicalJson(a[k])) out.push({ step: 0, kind: 'changed', field: k, before: b[k], after: a[k] })
  }
  const bs = stepsOf(before)
  const as = stepsOf(after)
  for (let i = 0; i < Math.max(bs.length, as.length); i++) {
    const x = bs[i]
    const y = as[i]
    if (x === undefined) { out.push({ step: i + 1, kind: 'added', after: y }); continue }
    if (y === undefined) { out.push({ step: i + 1, kind: 'removed', before: x }); continue }
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (canonicalJson(x[k]) !== canonicalJson(y[k])) out.push({ step: i + 1, kind: 'changed', field: k, before: x[k], after: y[k] })
    }
  }
  return out
}

interface MessageData { stream?: string; role?: string }

/**
 * 「这条 `message` 事件算不算 agent 此刻在干什么」——`now` 只该给人看 agent 自己在说什么，
 * 不该把 stderr / 协议帧当成活动摘要（活体实测：`data.stream === 'stderr'` 的一行渲染成
 * `[session/create] sessionId=… phase=register …`，读起来像 agent 正在做的事，其实是日志）。
 * `data.stream` 存在 = 带外的日志/协议流；`data.role === 'user'` = 人插的话，都不算。
 */
function isUserFacingMessage(e: RunEvent): boolean {
  const d = e.data as MessageData | undefined
  return !d?.stream && d?.role !== 'user'
}

/** agent 判「修不了」时那句理由——`agent-session.ts` 落的最后一条 `message` 事件（`data.role
 *  === 'agent'`）原文带 `UNREPAIRABLE: <原因>`，靠 `parseUnrepairable` 解出后半句。解不出
 *  （比如那一轮是 `stopReason:'refusal'` 直接拒绝，没走 UNREPAIRABLE 标记）就回 undefined，
 *  不去猜通知文案说了什么——没法可靠拿到就宁可缺席。 */
function verdictOf(events: RunEvent[]): string | undefined {
  const last = [...events].reverse().find((e) => e.kind === 'message' && (e.data as MessageData | undefined)?.role === 'agent')
  if (!last) return undefined
  return parseUnrepairable(last.title) ?? undefined
}

interface PermReq { auto?: boolean; permissionId?: string; why?: string; options?: PendingPermission['options']; toolCall?: { title?: string } }

/** 「还等着的那一条」：有 `permission_requested(auto:false)`、且没有同 `permissionId` 的 `permission_answered`；多条取 seq 最小。 */
export function pendingPermissionOf(events: RunEvent[]): PendingPermission | undefined {
  const answered = new Set(
    events.filter((e) => e.kind === 'permission_answered').map((e) => (e.data as { permissionId?: string } | undefined)?.permissionId),
  )
  for (const e of events) {
    if (e.kind !== 'permission_requested') continue
    const d = e.data as PermReq | undefined
    if (!d || d.auto !== false || !d.permissionId || answered.has(d.permissionId)) continue
    return { permissionId: d.permissionId, title: d.toolCall?.title ?? e.title, ...(d.why ? { reason: d.why } : {}), options: d.options ?? [] }
  }
  return undefined
}

export interface SourceHealthDeps {
  /** 静默版 `Registry.get`（裸名歧义时回 undefined，别让一次投影 500）。 */
  manifest: (sourceId: string) => SourceManifest | undefined
  health: (sourceId: string) => SourceHealth | undefined
  healthIds: () => string[]
  ledger: (sourceId: string) => RepairState | undefined
  ledgerIds: () => string[]
  /** 该源的 run，**新的在前**。 */
  runs: (sourceId: string) => RunRecord[]
  /**
   * 那条探索 run 的草稿图。**按 sourceId 问、不按 facility**：这一层压根不知道 facility
   * （`RunRecord` 没有这一格，三本账的键都是 sourceId），由接线方拿包快照解出 facility 再拼
   * 草稿路径。缺席 / 读不到 → undefined，`exploration` 那一格就不给，不补一份全 0 的假进度。
   */
  draftFor?: (sourceId: string, runId: string) => { states?: unknown[]; transitions?: unknown[]; remaining?: Record<string, number> } | undefined
  /** 账本里出现过的全部 sourceId（活跃的 run 可能属于一个健康账 / 关禁账都没记过的源）。 */
  runSourceIds: () => string[]
  events: (runId: string) => RunEvent[]
  proposals: (sourceId: string) => Proposal[]
  channels: () => ChannelRecord[]
  streams: () => Stream[]
  /** 磁盘上现行那份 recipe（diff 的左边）。读不到 = undefined，diff 只会全是 added。 */
  currentRecipe: (sourceId: string) => unknown
  /** `ai-agent` 行的限额；没配 = undefined。 */
  limits: () => { maxTurns: number; maxTokens: number; maxWallMinutes: number } | undefined
}

const ACTIVE: readonly RunStatus[] = [...WAITING, ...BUSY]

/**
 * 「人要在第 ④ 格里审的」那两类提议。**`state` / `discriminator` / `transition` / `locator` 不在这里**：
 * 它们是运行期一问一答的产物，在提议列表里审，不是源健康这条路上的收尾动作。
 *
 * 漏掉 `graph` 的代价是静默的：探完之后一个健康的源没有任何一本账记着它，状态词退回 `ok`、
 * 整行从 `unhealthy()` 里消失，而第 ④ 格「并进状态图」正等着人从那儿进去点——
 * 那条提议还在库里躺着，只是界面上再也走不到。
 */
const REVIEWABLE = new Set<Proposal['kind']>(['recipe', 'graph'])

function memberSourceId(m: StreamMember): string | undefined {
  if (m.source_id) return m.source_id
  if (m.plugin_id && m.source_template_id) return `${m.plugin_id}:${m.source_template_id}`
  return undefined
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)))
}

export class SourceHealthIndex {
  constructor(private readonly deps: SourceHealthDeps) {}

  /**
   * 「这个 id 在三本账里可能出现的每一种写法」——健康账习惯按全名记，关禁账（`RepairLedger`）
   * 习惯按裸局部名记，两本账各自只查自己那把键会把同一个源拆成两份残缺视图（活体 2026-09-12
   * 实测：`@streamapp/btbtla/btbtla-search` 与裸名 `btbtla-search` 出现两行）。
   * 归一路径：先问注册表这个 id 是谁（无论传的是全名还是裸名，`manifest()` 都答得出），
   * 拿到全名后把「全名 / 传入的原始 id / 局部名」三者去重，三本账依次按这组键查、取第一个命中。
   */
  private keysOf(sourceId: string, m: SourceManifest | undefined): string[] {
    const full = m?.id
    const bare = localNameOf(sourceId)
    return [...new Set([full, sourceId, bare].filter((k): k is string => !!k))]
  }

  /** 不认识的 id（注册表没有、三本账都没记过）→ undefined，路由据此 404。 */
  one(sourceId: string): SourceHealthView | undefined {
    const d = this.deps
    const m = d.manifest(sourceId)
    const keys = this.keysOf(sourceId, m)
    const health = keys.map((k) => d.health(k)).find((h) => h !== undefined)
    const ledger = keys.map((k) => d.ledger(k)).find((l) => l !== undefined)
    const runs = dedupeById(keys.flatMap((k) => d.runs(k))).filter((r) => r.kind === 'repair' || r.kind === 'explore')
    if (!m && !health && !ledger && runs.length === 0) return undefined
    // 活着的那条优先，同为活着时 repair 压过 explore——修复是人这会儿必须盯的那条（它挡着采集），
    // 探索是自愿开的。两条都不活就退回最新一条 repair，没有 repair 才退到 explore。
    const pick = (kind: RunRecord['kind']) => runs.filter((r) => r.kind === kind)
    const alive = runs.filter((r) => ACTIVE.includes(r.status))
    const run = alive.find((r) => r.kind === 'repair') ?? alive.find((r) => r.kind === 'explore') ?? pick('repair')[0] ?? pick('explore')[0]
    const canonicalId = m?.id ?? sourceId
    const activeExplore = alive.find((r) => r.kind === 'explore')
    const draft = activeExplore ? d.draftFor?.(canonicalId, activeExplore.id) : undefined
    const proposalsAll = dedupeById(keys.flatMap((k) => d.proposals(k)))
    const pending = proposalsAll.find((p) => REVIEWABLE.has(p.kind) && p.status === 'pending')
    const latestReviewable = pending ?? proposalsAll.find((p) => REVIEWABLE.has(p.kind))
    const status = classifySource({ health, ledger, run, pendingProposal: pending !== undefined })
    const affected = ledger?.affectedSources?.length ? ledger.affectedSources : [canonicalId]
    return {
      source: m ? publicSource(m) : fallbackSource(sourceId),
      status,
      health: {
        state: health?.state ?? 'healthy',
        lastAt: health?.lastAt ?? ledger?.lastAt ?? run?.updatedAt ?? new Date(0).toISOString(),
        ...(health?.lastError ? { lastError: health.lastError } : {}),
        ...(health?.lastErrorCategory ? { lastErrorCategory: health.lastErrorCategory } : {}),
      },
      ...(ledger && (ledger.status === 'quarantined' || ledger.status === 'failed')
        ? { quarantine: { since: ledger.lastAt ?? '', reason: ledger.lastReason ?? 'drift', recipeVersion: ledger.recipeVersion, attempts: ledger.attempts, affectedSources: affected } }
        : {}),
      affectedChannels: this.affectedChannels(affected),
      ...(run ? { run: this.runView(run) } : {}),
      ...(activeExplore && draft
        ? {
            exploration: {
              runId: activeExplore.id,
              status: activeExplore.status,
              states: draft.states?.length ?? 0,
              transitions: draft.transitions?.length ?? 0,
              // 「还剩多少个口子没点」= 各状态剩余数之和。没列过的状态在 `remaining` 里没有键，
              // 那时它的真实剩余是未知而不是 0——这里只汇总列过的，别把未知补成 0。
              remaining: Object.values(draft.remaining ?? {}).reduce((a, b) => a + b, 0),
            },
          }
        : {}),
      ...(latestReviewable ? { proposal: this.proposalView(canonicalId, latestReviewable) } : {}),
    }
  }

  /**
   * 此刻状态词 ≠ ok 的源。候选 = 三本账里出现过的全部 id 的并集，**先经全名归一去重**——
   * 否则同一个源按全名（健康账）和裸名（关禁账）各占一个候选，会合成出两行。
   * 归一不出全名的 id（注册表都不认识）保留原样，一个 id 一行。
   */
  unhealthy(): SourceHealthView[] {
    const rawIds = [...new Set([...this.deps.healthIds(), ...this.deps.ledgerIds(), ...this.deps.runSourceIds()])]
    const canonical = new Map<string, string>()
    for (const id of rawIds) {
      const key = this.deps.manifest(id)?.id ?? id
      if (!canonical.has(key)) canonical.set(key, id)
    }
    const out: SourceHealthView[] = []
    for (const id of canonical.values()) {
      const v = this.one(id)
      if (v && v.status !== 'ok') out.push(v)
    }
    return out.sort((a, b) => a.source.id.localeCompare(b.source.id))
  }

  private affectedChannels(affected: string[]): Array<{ id: string; label: string }> {
    const norm = (id: string): string => this.deps.manifest(id)?.id ?? id
    const wanted = new Set(affected.map(norm))
    const streamIds = new Set(
      this.deps.streams()
        .filter((s) => s.sources.some((mem) => { const id = memberSourceId(mem); return id !== undefined && wanted.has(norm(id)) }))
        .map((s) => s.id),
    )
    return this.deps.channels()
      .filter((c) => c.stream_ids.some((id) => streamIds.has(id)))
      .map((c) => ({ id: c.id, label: c.label }))
  }

  private runView(run: RunRecord): NonNullable<SourceHealthView['run']> {
    const events = this.deps.events(run.id)
    const now = [...events].reverse().find((e) => e.kind === 'tool_call' || (e.kind === 'message' && isUserFacingMessage(e)))?.title
    const note = [...events].reverse().find((e) => e.kind === 'status_changed')?.title
    const limits = this.deps.limits()
    const pending = pendingPermissionOf(events)
    const verdict = run.stopped?.produced === 'verdict-unrepairable' ? verdictOf(events) : undefined
    return {
      id: run.id, status: run.status, startedAt: run.startedAt, usage: run.usage,
      ...(limits ? { limits } : {}),
      ...(now ? { now } : {}),
      ...(pending ? { pending } : {}),
      ...(note ? { lastStatusNote: note } : {}),
      ...(verdict ? { verdict } : {}),
      ...(run.stopped ? { stopped: run.stopped } : {}),
      ...(run.error ? { error: run.error } : {}),
    }
  }

  private proposalView(sourceId: string, p: Proposal): NonNullable<SourceHealthView['proposal']> {
    if (p.kind === 'graph') {
      const draft = p.draft as { states?: unknown[]; transitions?: unknown[] } | undefined
      return {
        id: p.id, kind: p.kind, status: p.status,
        // 草稿文件路径（探索会话落的那份）；没记就空串，别拿 recipe 的路径顶上。
        recipePath: p.recipePath ?? '',
        // 四格校验对一张图不成立——见 `SourceHealthView.proposal` 头注，`'n/a'` 是如实说「这一维没这回事」。
        validation: { schema: 'n/a', version: 'n/a', assertions: 'n/a', probe: 'n/a' },
        diff: [],
        graph: { states: draft?.states?.length ?? 0, transitions: draft?.transitions?.length ?? 0 },
      }
    }
    return {
      id: p.id, kind: p.kind, status: p.status, recipePath: p.recipePath ?? '',
      validation: p.validation ?? { schema: 'unknown', version: 'unknown', assertions: 'unknown', probe: 'unknown' },
      diff: stepDiff(this.deps.currentRecipe(sourceId), p.recipe),
    }
  }
}
