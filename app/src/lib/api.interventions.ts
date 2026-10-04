/**
 * 「AI 介入」四个端点的薄封装。
 *
 * **这里的类型是后端 `src/intervention/types.ts` 的镜像，不是它本身**——前端不 import 后端源码
 * （两棵 tsconfig 不共享那条路径）。所以字段名必须逐字对齐：镜像一漂，前端读到的就是 `undefined`，
 * 而 `undefined` 在界面上和"这条 run 没有这一项"长得一模一样，没有任何一处会喊。
 *
 * 联合字面量（`RunStatus` 那种）在这一侧一律放宽成 `string`：后端加一档新状态时，前端该做的是
 * "不认识就画灰"，而不是编译不过——这一层只负责搬运和显示。
 */

/** 一次 run 的台账。`usage.reported === false` = 端点没回用量，**不是 0**。 */
export interface InterventionRun {
  id: string
  kind: string
  sourceId: string
  question?: string
  status: string
  stopped?: { produced: string; reason: string }
  error?: { code: string; message: string }
  usage: { promptTokens: number; completionTokens: number; turns: number; wallMs: number; reported: boolean }
  startedAt: string
  updatedAt: string
  lastSeq: number
  /** 后端重启后收成的 paused 才有：这条 run 已经不在内存会话里了，得靠 `resumeRun` 而不是 `continueRun`。 */
  agentSession?: { command: string; sessionId: string; cwd: string }
}

/** 一条事件。`seq` 单调、只追加——增量拉取靠它。 */
export interface InterventionEvent {
  seq: number
  kind: string
  at: string
  title: string
  data?: unknown
  callId?: string
}

/** 现场引用：给人审提议时看的截图与元素表。 */
export interface InterventionScene {
  side: string
  url?: string
  title?: string
  text?: string
  /** `truncated` = 抓到了但太大没落库（后端 `SHOT_CAP`）。和「没抓到」是两件事，界面要分开说。 */
  shot?: { mime: string; base64: string; truncated?: boolean }
  elements: Array<{ n?: number; name?: string; tag?: string; role?: string; kind?: string }>
  truncated?: boolean
}

export interface InterventionProposal {
  id: string
  runId: string
  sourceId: string
  /** 设施键（状态图按它分文件）；老路径缺席时后端退回 sourceId。 */
  facility?: string
  kind: string
  features?: unknown[]
  target?: unknown
  rationale: string
  stateId?: string
  candidates?: string[]
  status: string
  rejection?: string
  gateNote?: string
  scene?: InterventionScene
  createdAt: string
  /** `kind === 'recipe'` 时才有：候选 recipe 本体与它要写回的路径。 */
  recipe?: unknown
  recipePath?: string
  validation?: { schema: string; version: string; assertions: string; probe: string }
}

/**
 * 非 2xx 一律抛，**并把响应体前 300 字带上**：后端的错误信息就在正文里，只报一个状态码等于
 * 把"为什么"扔掉，界面上只剩一个数字。
 */
async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

export const fetchInterventions = (apiBase: string, source?: string) =>
  fetch(`${apiBase}/api/interventions${source ? `?source=${encodeURIComponent(source)}` : ''}`).then(jsonOrThrow) as Promise<{ runs: InterventionRun[]; pending: number }>

export const fetchIntervention = (apiBase: string, id: string) =>
  fetch(`${apiBase}/api/interventions/${encodeURIComponent(id)}`).then(jsonOrThrow) as
    Promise<{ run: InterventionRun; proposals: InterventionProposal[] }>

export const fetchInterventionEvents = (apiBase: string, id: string, since = 0) =>
  fetch(`${apiBase}/api/interventions/${encodeURIComponent(id)}/events?since=${since}`).then(jsonOrThrow) as
    Promise<{ events: InterventionEvent[] }>

/**
 * 手动开一条探索（spec 2026-09-12-explore §9）。**回执只有 runId**，没有 sourceId——
 * 探索挂在 facility 上，界面要跳去哪一行得自己从装了的包里取那个 facility 的首源。
 *
 * 400 `bad-target` / `unknown-facility`、409 `explore-busy`、503 `agent-unavailable` 一律抛，
 * 正文前 300 字带着（`jsonOrThrow`）——这四句全是给人看的、要原样显示在表单下面。
 */
export const startExploration = (apiBase: string, body: { facility: string; target: string; goal: string }) =>
  fetch(`${apiBase}/api/interventions/explorations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ facility: body.facility, target: body.target, goal: body.goal }),
  }).then(jsonOrThrow) as Promise<{ runId: string }>

/** 装了的 recipe 包（`GET /api/recipes/packages`）。探索表单只用它的 `facility` 与 `sourceIds[0]`。 */
export interface ExploreFacility { name: string; facility: string; sourceIds: string[] }

/** 读不到就回空数组：表单退回「手填 facility」，不是整个入口消失。 */
export const fetchExploreFacilities = (apiBase: string): Promise<ExploreFacility[]> =>
  fetch(`${apiBase}/api/recipes/packages`)
    .then((r) => (r.ok ? (r.json() as Promise<unknown>) : []))
    .then((d) => (Array.isArray(d) ? (d as ExploreFacility[]).filter((p) => typeof p?.facility === 'string' && p.facility) : []))
    .catch(() => [])

export const acceptProposal = (apiBase: string, pid: string, body: { stateId?: string }) =>
  fetch(`${apiBase}/api/interventions/proposals/${encodeURIComponent(pid)}/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(jsonOrThrow) as Promise<{ proposal: InterventionProposal; applied: boolean; path?: string }>

export const rejectProposal = (apiBase: string, pid: string) =>
  fetch(`${apiBase}/api/interventions/proposals/${encodeURIComponent(pid)}/reject`, { method: 'POST' })
    .then(jsonOrThrow) as Promise<{ proposal: InterventionProposal }>

const postJson = (url: string, body?: unknown) =>
  fetch(url, body === undefined ? { method: 'POST' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(jsonOrThrow) as Promise<{ ok: true }>

/** `kind:'repair'` run 专用的五个控制端点——直接对着一条正在跑（或曾经跑过）的 agent 会话下动作。 */
export const answerPermission = (apiBase: string, runId: string, permissionId: string, optionId: string) =>
  postJson(`${apiBase}/api/interventions/${encodeURIComponent(runId)}/permissions/${encodeURIComponent(permissionId)}`, { optionId })
export const continueRun = (apiBase: string, runId: string) =>
  postJson(`${apiBase}/api/interventions/${encodeURIComponent(runId)}/continue`)
export const cancelRun = (apiBase: string, runId: string) =>
  postJson(`${apiBase}/api/interventions/${encodeURIComponent(runId)}/cancel`)
export const sendMessage = (apiBase: string, runId: string, text: string) =>
  postJson(`${apiBase}/api/interventions/${encodeURIComponent(runId)}/messages`, { text })
export const resumeRun = (apiBase: string, runId: string) =>
  postJson(`${apiBase}/api/interventions/${encodeURIComponent(runId)}/resume`)
