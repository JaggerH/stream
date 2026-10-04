/**
 * 历次执行的读侧：直接读 Sidequest 自己的账本，**不建第二份存储**。
 *
 * 账本里本来就逐次存着需求要的全部字段（实测 2026-08-28）：任务身份在 `args`（`["<taskId>"]`），
 * `result` 是 `TaskOutcome` 的 JSON，另有 state / 三个时间戳 / errors / attempt。
 * 再抄一份到自己的表 = 两个真相源，且会和重试语义不一致。
 */
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'

export type RunState = 'waiting' | 'claimed' | 'running' | 'completed' | 'failed' | 'canceled'

export interface TaskRun {
  id: number
  taskId: string
  state: RunState
  insertedAt: number
  attemptedAt: number | null
  completedAt: number | null
  /** 没跑完就是 null——不要拿"现在"去减，那会让一条卡住的任务看起来越跑越久 */
  durationMs: number | null
  attempt: number
  summary: string | null
  detail: unknown
  errors: unknown
  /** 失败的那句人话（errors 里第一条的 message，引擎自己的英文已翻译）；没失败或没说明就是 null。
   *  前端「上次」那一格失败时显示它，不显示 summary——失败的 run 基本没有 summary，
   *  照 summary 画出来就是一句「没报摘要」，把"为什么失败"整个藏掉了。 */
  failure: string | null
}

/**
 * 引擎自己写进 errors 的几句英文 → 人话。只翻我们确认过含义的那几句，其余原样。
 * `Stale job released for retry`：Sidequest 的 stale 巡检把一条"running 超过 10 分钟"的行收掉了。
 * 在 inline runner 下这只在**上一个进程死了**之后发生（活的进程里 running 的行是真的在跑），
 * 所以它和 INTERRUPTED_BY_RESTART 是同一件事，只是发现得晚（巡检一小时一轮）。
 */
const ENGINE_MESSAGES: Record<string, string> = {
  'Stale job released for retry': '后端重启时这一轮还在跑，被中断（引擎稍后巡检才发现）',
}

function failureOf(state: string, errors: unknown): string | null {
  if (state !== 'failed') return null
  const first = Array.isArray(errors) ? errors[0] : errors
  const msg = first !== null && typeof first === 'object' && typeof (first as { message?: unknown }).message === 'string'
    ? (first as { message: string }).message
    : typeof first === 'string' ? first : null
  if (msg === null) return null
  return ENGINE_MESSAGES[msg] ?? msg
}

interface Raw {
  id: number; args: string; state: string; result: string | null; errors: string | null
  inserted_at: number; attempted_at: number | null; completed_at: number | null; attempt: number
}

function parseLoose(text: string | null): { summary: string | null; detail: unknown } {
  if (text === null) return { summary: null, detail: undefined }
  try {
    const o = JSON.parse(text) as { summary?: unknown; detail?: unknown }
    return { summary: typeof o.summary === 'string' ? o.summary : text, detail: o.detail }
  } catch {
    // 坏 JSON 不该让整页 500——把原文当摘要，人一眼看得出是它坏了
    return { summary: text, detail: undefined }
  }
}

function hydrate(r: Raw): TaskRun {
  const { summary, detail } = parseLoose(r.result)
  let errors: unknown
  if (r.errors !== null) { try { errors = JSON.parse(r.errors) } catch { errors = r.errors } }
  return {
    id: r.id,
    taskId: (JSON.parse(r.args) as string[])[0],
    state: r.state as RunState,
    insertedAt: r.inserted_at,
    attemptedAt: r.attempted_at,
    completedAt: r.completed_at,
    durationMs: r.attempted_at !== null && r.completed_at !== null ? r.completed_at - r.attempted_at : null,
    attempt: r.attempt,
    summary, detail, errors,
    failure: failureOf(r.state, errors),
  }
}

const DEFAULT_LIMIT = 50

/** 一条任务的执行记录，新的在前。`/api/tasks` 每条任务都查一次（lastRun），所以它必须走
 *  `stream_sq_jobs_args` 索引（见 orphan-sweep.ts `LEDGER_INDEXES`；测试用 EXPLAIN 钉着）。 */
export const RUNS_SQL = `SELECT id, args, state, result, errors, inserted_at, attempted_at, completed_at, attempt
       FROM sidequest_jobs WHERE args = ? ORDER BY inserted_at DESC, id DESC LIMIT ?`

export class RunLedger {
  private db: Database.Database | undefined
  constructor(private readonly dbPath: string, private readonly now: () => number = () => Date.now()) {
    // 账本由 Sidequest 建；它还没起过（首次启动）时文件不存在，此时一切读都是空，不是错误。
    if (existsSync(dbPath)) this.db = new Database(dbPath)
  }

  private open(): Database.Database | undefined {
    if (!this.db && existsSync(this.dbPath)) this.db = new Database(this.dbPath)
    return this.db
  }

  runs(taskId: string, limit = DEFAULT_LIMIT): TaskRun[] {
    const db = this.open()
    if (!db) return []
    const rows = db.prepare(RUNS_SQL).all(JSON.stringify([taskId]), limit) as Raw[]
    return rows.map(hydrate)
  }

  lastRun(taskId: string): TaskRun | undefined {
    return this.runs(taskId, 1)[0]
  }

  /** 每个任务保留最近 keepPerTask 条**或** keepMs 内的，取宽的那个；其余删。返回删了几行。
   *  不做这一步页面第一天就慢——分钟级任务一天攒 1440 条，实测账本已 22 万行。 */
  prune(opts: { keepPerTask: number; keepMs: number }): number {
    const db = this.open()
    if (!db) return 0
    const cutoff = this.now() - opts.keepMs
    return db.prepare(
      `DELETE FROM sidequest_jobs WHERE id IN (
         SELECT id FROM (
           SELECT id, inserted_at,
                  ROW_NUMBER() OVER (PARTITION BY args ORDER BY inserted_at DESC, id DESC) AS rn
           FROM sidequest_jobs
         ) WHERE rn > ? AND inserted_at < ?
       )`,
    ).run(opts.keepPerTask, cutoff).changes
  }

  close(): void { this.db?.close(); this.db = undefined }
}
