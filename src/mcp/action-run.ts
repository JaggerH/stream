/**
 * 动作 recipe 的**异步运行**壳（spec `docs/superpowers/specs/2026-09-12-action-recipe-async-run-design.md`）。
 *
 * 它存在的理由只有一个坏结果：动作 recipe 真做完要多久没有上限，而对话宿主一次工具调用只等
 * 60s——**消息真发出去了、宿主却先超时告诉模型"失败"**，模型一重试就是第二条。这里把
 * `confirmed:true` 那次调用改成：建一条 run → 起执行 → 最多等 `waitMs`；等到了就照旧回最终结果
 * （多带 `runId`），没等到回 `{status:'running', runId}` 让调用方去 `get_agent_run` 轮询。
 *
 * 三条边界：
 * - **不认识 recipe**。校验、二次确认、就绪判断、真执行，全在 `prepare`（`action-recipe.ts` 的
 *   `prepareActionRecipe`）里；这里只管 run 的生命周期与在飞表。`prepare` 回 `result` 就原样透传、
 *   **不建 run**——needs-confirmation 和校验失败是毫秒级同步的，没有"跑没跑完"这回事。
 * - **在飞幂等**：同一把 `key`（sourceId + 归一化 params）在飞时再来一次，回同一个 runId，不起第二轮。
 *   只看在飞、不设跑完后的冷却：改成异步之后"宿主超时后重试"这个场景本身就没了，剩下的同参
 *   再调只有两种——模型手抖（在飞闸挡住）、用户真要再发一次（照发）。
 * - **run 记录复用 `agent-runs.db`**（`domain:'action'`，结果落 `result`），`get_agent_run` 读。后端
 *   中途重启时 `SearchAgentService` 会把在飞行标成 error「中断（服务重启）」，这里不另做。
 *
 * 等待用 `Promise.race`，**执行的 promise 不因等待放弃而放弃**：落定时照常写库，这是"超时后也能
 * 查到结果"的全部依据。
 */
import type { RunRecord, RunStatus } from '../agent/search/types.ts'
import type { ActionRecipeArgs, ActionRecipeResult, PreparedAction } from './action-recipe.ts'

/** `run_action_recipe confirmed:true` 在回 `running` 之前最多等多久。宿主的硬上限是 60s，留足余量。 */
export const ACTION_WAIT_MS = 25_000

/** run 记录的 `goal` 只有 sourceId：goal 会进 `get_agent_run` 的列表面，params 里有正文。 */
export const ACTION_RUN_GOAL_PREFIX = 'action:'
export const ACTION_RUN_DOMAIN = 'action'

/** `SearchRunStore` 里这里真用到的三口。 */
export interface ActionRunStore {
  create(goal: string, domain?: string): RunRecord
  put(runId: string, patch: Partial<Omit<RunRecord, 'runId' | 'updatedAt' | 'trajectory'>> & { status: RunStatus }): void
  get(runId: string): RunRecord | null
}

export interface ActionRunServiceDeps {
  store: ActionRunStore
  prepare: (args: ActionRecipeArgs) => Promise<PreparedAction>
  /** 默认 `ACTION_WAIT_MS`；测试注入。 */
  waitMs?: number
}

export interface ActionRunService {
  run(args: ActionRecipeArgs): Promise<ActionRecipeResult>
}

/** 在飞幂等键：sourceId + 键排序后的 params。用补过默认值、String 过的那份，与真打进键盘的一致。 */
export function actionRunKey(sourceId: string, params: Record<string, string>): string {
  const sorted = Object.keys(params).sort().map((k) => [k, String(params[k])])
  return `${sourceId}\n${JSON.stringify(sorted)}`
}

/** `get_agent_run` / `GET /api/recipes/action/:runId` 给调用方看的那份投影。 */
export interface ActionRunView {
  runId: string
  domain: typeof ACTION_RUN_DOMAIN
  status: RunStatus
  sourceId: string
  elapsedSec?: number
  /** run 跑完时 = `run_action_recipe` 本来会回的那份；`result.status` 才是动作的成败。 */
  result?: unknown
  error?: string
  note: string
}

/**
 * 把一条 `domain:'action'` 的 run 记录投影成调用方要看的形状。**两层状态分开**：run 的 `status`
 * 只说跑没跑完，`result.status` 才是做没做成。error 那一档必须把「动作可能已做了一部分」说出来，
 * 否则模型会把"后端重启"读成"没发出去"然后再发一条。MCP（`get_agent_run`）与 HTTP
 * （`/api/recipes/action/:runId`）共用这一份，别各投各的。
 */
export function projectActionRun(
  runId: string,
  rec: Pick<RunRecord, 'goal' | 'status' | 'updatedAt'> & { result?: unknown; error?: string },
  now: number = Date.now(),
): ActionRunView {
  const sourceId = rec.goal.startsWith(ACTION_RUN_GOAL_PREFIX) ? rec.goal.slice(ACTION_RUN_GOAL_PREFIX.length) : rec.goal
  const live = rec.status === 'running' || rec.status === 'queued'
  // `updatedAt` 是最后一次写库的时刻：在飞时 = 开跑时刻（起跑那一下写的 running），跑完后 = 结束
  // 时刻。所以 elapsedSec 只在在飞时有意义——跑完还报它，报的是"结束多久了"，会一直涨。
  const elapsedSec = live && rec.updatedAt ? Math.round((now - Date.parse(rec.updatedAt)) / 1000) : undefined
  return {
    runId,
    domain: ACTION_RUN_DOMAIN,
    status: rec.status,
    sourceId,
    ...(elapsedSec !== undefined ? { elapsedSec } : {}),
    ...(rec.status === 'done' ? { result: rec.result } : {}),
    ...(rec.error ? { error: rec.error } : {}),
    note: live
      ? `还在执行（已 ${elapsedSec ?? 0} 秒）。隔 10–15 秒再调一次；别去重新调 run_action_recipe。`
      : rec.status === 'error'
        ? `执行没有正常收尾：${rec.error ?? '未知'}。动作可能已经做了一部分（消息可能已发出）——先核目标应用的实际状态，再决定要不要重跑。`
        : '跑完了。result.status 才是动作的成败，按 run_action_recipe 的状态说明读它。',
  }
}

export function createActionRunService(deps: ActionRunServiceDeps): ActionRunService {
  const waitMs = deps.waitMs ?? ACTION_WAIT_MS
  /** key → runId，只装在飞的。 */
  const inflight = new Map<string, string>()

  function runningReceipt(runId: string, sourceId: string): ActionRecipeResult {
    return {
      status: 'running',
      sourceId,
      runId,
      reason:
        `动作还在执行（runId ${runId}）。用 get_agent_run(runId) 轮询，status 变 done 后看 result.status 才是动作的成败。` +
        '**别重新调 run_action_recipe**——同参在飞会被并到这条 run 上，而跑完之后再调就是真的再做一次。',
    }
  }

  return {
    async run(args) {
      const prepared = await deps.prepare(args)
      if (prepared.kind === 'result') return prepared.result

      const existing = inflight.get(prepared.key)
      if (existing) return runningReceipt(existing, prepared.sourceId)

      const rec = deps.store.create(`${ACTION_RUN_GOAL_PREFIX}${prepared.sourceId}`, ACTION_RUN_DOMAIN)
      const runId = rec.runId
      inflight.set(prepared.key, runId)
      deps.store.put(runId, { status: 'running' })

      const execution = prepared
        .execute()
        .then((result) => {
          deps.store.put(runId, { status: 'done', result })
          return result
        })
        .catch((e: unknown) => {
          deps.store.put(runId, { status: 'error', error: e instanceof Error ? e.message : String(e) })
          throw e
        })
        .finally(() => {
          if (inflight.get(prepared.key) === runId) inflight.delete(prepared.key)
        })

      let timer: ReturnType<typeof setTimeout> | undefined
      const waited = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), waitMs)
        timer.unref?.()
      })
      try {
        const first = await Promise.race([execution.then((r) => ({ result: r })), waited])
        if (first === 'timeout') {
          // 等待放弃 ≠ 执行放弃：execution 继续飞，落定时写库。这里要把它的 reject 收掉，
          // 否则一条晚到的异常会以 unhandledRejection 炸进程。
          execution.catch(() => {})
          return runningReceipt(runId, prepared.sourceId)
        }
        return { ...first.result, runId }
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
  }
}
