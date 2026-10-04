import type { Feature, StateId } from '../replay/state-graph.ts'
import type { Scene } from '../replay/scene.ts'

/** 三条线的 run 只在时长和事件多少上不同，形状相同（spec §6.1）。 */
export type RunKind = 'runtime-ask' | 'repair' | 'explore'

/**
 * 等人三态 + paused 与 error **平级**（spec §6.2）。别复用 SearchRunStore 的 StopReason——
 * 那儿的 `interrupted` 已经是「中途挂了」，含义相反。
 */
export type RunStatus =
  | 'queued' | 'running'
  | 'awaiting_input' | 'awaiting_confirmation' | 'rate_limited' | 'paused'
  | 'done' | 'stopped' | 'cancelled' | 'error'

/**
 * 终态：不会再有新事件、也没有人还能在上面做事。**`paused` 不在里面**——它还活着，
 * 人随时可以点「继续」。裁剪（`prune`）与登记表对账（`RepairManager.sweep`）共用这一份，
 * 两处各写各的列表时，一边会把还活着的 run 当死的收掉。
 */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['done', 'stopped', 'cancelled', 'error']

/** 有没有东西。`verdict-unrepairable` 是模型说得出理由的结论，和撞闸是两回事。 */
export type StopProduced = 'proposal' | 'verdict-unrepairable' | 'nothing'
/** 为什么停。`gate:*` 是兜底，**撞闸停的绝不能被读成「修不了」**。 */
export type StopReason =
  | 'end_turn' | 'gate:turns' | 'gate:tokens' | 'gate:wall' | 'stuck'
  | 'cancelled' | 'error' | 'frontier-exhausted'
export interface Stopped { produced: StopProduced; reason: StopReason }

/** 错误细分：「没钱了」和「代码错了」不是同一种红。 */
export type RunErrorCode =
  | 'llm_unconfigured' | 'llm_all_failed' | 'llm_out_of_credits'
  | 'scene_unavailable' | 'internal'
  | 'agent_unconfigured' | 'agent_spawn_failed' | 'agent_crashed' | 'agent_stalled' | 'agent_protocol'

/**
 * 账：token 是事实、钱是派生（spec §8）。`reported:false` = 端点没回 usage，
 * **不是 0**——UI 显示「用量不可用」。
 */
export interface Usage {
  promptTokens: number
  completionTokens: number
  turns: number
  wallMs: number
  reported: boolean
}

export type ProposalKind = 'state' | 'discriminator' | 'transition' | 'locator' | 'recipe' | 'graph'
export type ProposalRejection = 'unparseable' | 'not-observed' | 'not-discriminative' | 'target-unresolvable'
export type ProposalStatus = 'pending' | 'accepted' | 'rejected-by-gate' | 'rejected-by-user'

export interface Proposal {
  id: string
  runId: string
  sourceId: string
  /** 这条 recipe 的设施键——状态图与观测账本按它分文件（spec §9.1）。老路径缺席时退回 sourceId。 */
  facility?: string
  kind: ProposalKind
  /** `state` / `discriminator`：建议的特征；`transition` / `locator`：建议的目标（`see` 语法）。 */
  features?: Feature[]
  target?: unknown
  /** 模型给的一句话「这像是哪个已知状态的变体 / 新状态 / 为什么这样区分」。 */
  rationale: string
  /** `state`：模型建议的状态名（人可改）；`discriminator`：要区分的候选。 */
  stateId?: StateId
  candidates?: StateId[]
  status: ProposalStatus
  rejection?: ProposalRejection
  /** 闸的说明（撞了谁 / 解析不到什么）。 */
  gateNote?: string
  /** 触发那一刻的现场引用——给审核界面看的截图与元素表（spec §9）。 */
  scene?: Scene
  createdAt: string
  /** `recipe` 类：候选 recipe 整体（v+1 的 JSON）。人接受时校验后原子写回 `recipePath` 本身。 */
  recipe?: unknown
  /**
   * `recipe` 类：写回的目标路径（包目录里那份 `<local>.recipe.json`），给人看「会改哪个文件」。
   * **必须是绝对路径**：写回端 `writeRecipeAtomic` 对相对路径会解到后端自己的 cwd，
   * 于是文件落在一个谁也不会去装载的地方，而回执仍是 `applied:true`。
   */
  recipePath?: string
  /** `recipe` 类：我们自己那一轮校验的结果，每格 `'ok'` 或一句为什么不过。`probe` 多两档「没跑」，如实说。 */
  validation?: RecipeValidation
  /**
   * `graph` 类：整份探索草稿（`ExploreDraft`），人接受时并进学到的层。
   * 类型写成 `unknown` 是为了不让 `types.ts` 依赖 `explore-graph.ts`（那边 import 了 fs / 路径工具，
   * 而这份类型文件是前后端都读的）；消费端自己断言。`cappedShot` 只裁 scene，不碰它。
   */
  draft?: unknown
}

/** 候选 recipe 的四格校验（spec §5.2 第 6 步）。**没跑 ≠ 过**：`probe` 的两个 skipped 档必须原样显示给人。 */
export interface RecipeValidation {
  schema: 'ok' | string
  version: 'ok' | string
  assertions: 'ok' | string
  probe: 'ok' | 'skipped-needs-params' | 'skipped-no-executor' | string
}

/** agent 档的会话句柄（spec §6.1 `agentSession`）——重启后 `session/load` 靠它。 */
export interface AgentSession {
  command: string
  args: string[]
  sessionId: string
  /** agent 的 cwd = 包目录的工作副本。 */
  cwd: string
  /** 原包目录（写回目标）。 */
  packageDir: string
  /** 裸 sourceId（文件名 `<local>.recipe.json` 用它）。 */
  localSourceId: string
}

/**
 * 一条缓存答案的状态（spec §4.3）。**必须连状态一起记**：被拒的答案也要留在缓存里
 * （同指纹再问一次，模型只会给出同一个被拒的答案，白烧 token），但它不是一条提议——
 * 只记 answer 的话，第二次命中会凭空多出一条根本不存在的待审提议。
 *
 * `rejected-by-user` 是**人**拒的：比闸拒更硬，复用时要说清「命中的是一条被人拒过的答案」。
 * `accepted` 也是**人**认的：比 `pending` 更硬——命中它说明这条答案已经被人接受、状态图（或人的
 * 认可）已经吃了它，复用时不该再落一条新提议等人重新审一遍。
 */
export type AnswerStatus = 'pending' | 'accepted' | 'rejected-by-gate' | 'rejected-by-user' | 'unrepairable'

/** 缓存里的一条答案。`key` = `cacheKey(sourceId, kind, fingerprint)`。 */
export interface AnswerRow {
  key: string
  sourceId: string
  kind: ProposalKind
  fingerprint: string
  status: AnswerStatus
  proposalId?: string
  /** 模型那次给的答案原样（`AskAnswer`），JSON 落库。 */
  answer: unknown
  updatedAt: string
}

export type RunEventKind =
  | 'status_changed' | 'message' | 'tool_call' | 'tool_result' | 'tool_failed'
  | 'permission_requested' | 'permission_answered' | 'usage' | 'proposal' | 'heartbeat' | 'cache_hit'

/** 一条事件。`seq` 单调、只追加、**先落库后广播**（spec §6.4）。 */
export interface RunEvent {
  seq: number
  runId: string
  kind: RunEventKind
  at: string
  /** 给人看的一句话。 */
  title: string
  /** 结构化载荷，随 kind 变。 */
  data?: unknown
  /** tool_call / tool_result / tool_failed 用它配对。 */
  callId?: string
}

export interface RunRecord {
  id: string
  kind: RunKind
  sourceId: string
  /** 触发它的那一问是哪种（runtime-ask 专用）。 */
  question?: ProposalKind
  status: RunStatus
  stopped?: Stopped
  error?: { code: RunErrorCode; message: string }
  usage: Usage
  startedAt: string
  updatedAt: string
  /** 最新一条事件的 seq——列表页不拉事件也能画「有没有新动静」。 */
  lastSeq: number
  agentSession?: AgentSession
}
