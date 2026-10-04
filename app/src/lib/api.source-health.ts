/**
 * 「源健康」两口 + 手动拉起的薄封装。**类型是后端 `src/intervention/source-health-view.ts` 的镜像**
 * （前端 import 不到后端源码），字段名逐字对齐；联合字面量放宽成 string——后端加一档时前端画灰，不是编译不过。
 */
export type SourceHealthStatus = 'awaiting' | 'exploring' | 'repairing' | 'proposed' | 'unrepairable' | 'quarantined' | 'auth' | 'dead' | 'degraded' | 'ok'

export interface StepDiff { step: number; kind: 'changed' | 'added' | 'removed'; field?: string; before?: unknown; after?: unknown }

export interface PendingPermission {
  permissionId: string
  title: string
  reason?: string
  options: Array<{ optionId: string; name: string; kind: string }>
}

export interface SourceHealthView {
  source: { id: string; title: string; description?: string; pluginName?: string; facility?: { key: string; label: string }; site?: { name: string; domain: string } }
  status: SourceHealthStatus | string
  health: { state: string; lastError?: string; lastErrorCategory?: string; lastAt: string }
  quarantine?: { since: string; reason: string; recipeVersion: number; attempts: number; affectedSources: string[] }
  affectedChannels: Array<{ id: string; label: string }>
  run?: {
    id: string
    status: string
    startedAt: string
    usage: { promptTokens: number; completionTokens: number; turns: number; wallMs: number; reported: boolean }
    limits?: { maxTurns: number; maxTokens: number; maxWallMinutes: number }
    now?: string
    pending?: PendingPermission
    lastStatusNote?: string
    /** agent 判「修不了」时给的理由（`UNREPAIRABLE:` 后那一句）。 */
    verdict?: string
    stopped?: { produced: string; reason: string }
    error?: { code: string; message: string }
  }
  /**
   * 此刻正在跑的那条探索的进度（spec 2026-09-12-explore §8）。**只在探索还活着时给**——
   * 缺席就是「没有探索在动」，别把它当成 0 个状态显示。
   */
  exploration?: { runId: string; status: string; states: number; transitions: number; remaining: number }
  /**
   * `kind` 用来分流第 ④ 格：`recipe` 看 diff，`graph` 看 `graph` 那两个数。老回执没有 `kind` 时按 recipe 走。
   * `kind === 'graph'` 时 `diff` 是空数组、`validation` 四格都是 `'n/a'`——两样都不该拿去渲染。
   */
  proposal?: {
    id: string
    kind?: string
    status: string
    recipePath: string
    validation: { schema: string; version: string; assertions: string; probe: string }
    diff: StepDiff[]
    /** 只有 `kind === 'graph'` 给：这份草稿里的状态与边条数。 */
    graph?: { states: number; transitions: number }
  }
}

/** 十个状态词（spec 2026-09-12 §5 + explore §8）。不认识的英文原样显示——编一个好听的会把「这是新东西」盖掉。 */
export const STATUS_LABEL: Record<SourceHealthStatus, string> = {
  awaiting: '等你拍板', exploring: '探索中', repairing: '修复中', proposed: '待写回', unrepairable: '修不了',
  quarantined: '被关禁', auth: '掉登录', dead: '异常', degraded: '变差', ok: '正常',
}
export const statusLabel = (s: string): string => (STATUS_LABEL as Record<string, string>)[s] ?? s

/** 只有这一档需要打断（spec §2 / §6）。 */
export const needsAttention = (s: string): boolean => s === 'awaiting'

/** 原因翻人话：键是 `FailureCategory` / 停止原因 / 错误码。**查不到原样显示**，不补一句好听的。 */
export const REASON_LABEL: Record<string, string> = {
  drift: '页面结构和 recipe 对不上了', auth: '登录态失效', timeout: '页面等不到结果', network: '网络不通',
  blocked: '被站点拦下（验证码 / 风控）', empty: '连续几轮什么都没抓到', unknown: '原因没分出来',
  'gate:turns': '轮数用完', 'gate:tokens': 'token 预算用完', 'gate:wall': '时间用完', stuck: 'agent 原地打转',
  llm_unconfigured: '没配模型', llm_all_failed: '模型全都没答上', llm_out_of_credits: '模型额度用完',
  agent_unconfigured: '没配 ai-agent', agent_spawn_failed: 'agent 进程起不来', agent_crashed: 'agent 进程崩了',
  agent_stalled: 'agent 十分钟没动静', agent_protocol: 'agent 协议不对', internal: '后端内部错误', scene_unavailable: '拿不到现场',
}
export function reasonText(raw: string | undefined, category?: string): string {
  const head = category ? REASON_LABEL[category] : undefined
  if (head && raw) return `${head}：${raw}`
  return head ?? raw ?? '原因不明'
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

export const fetchSourceHealth = (apiBase: string) =>
  fetch(`${apiBase}/api/source-health`).then(jsonOrThrow) as Promise<{ sources: SourceHealthView[] }>

export const fetchSourceHealthOf = (apiBase: string, sourceId: string) =>
  fetch(`${apiBase}/api/source-health/${encodeURIComponent(sourceId)}`).then(jsonOrThrow) as Promise<SourceHealthView>

export const startRepair = (apiBase: string, sourceId: string, reason?: string) =>
  fetch(`${apiBase}/api/interventions/repairs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(reason ? { sourceId, reason } : { sourceId }),
  }).then(jsonOrThrow) as Promise<{ runId: string; failed?: boolean }>
