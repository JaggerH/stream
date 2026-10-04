/**
 * 桌面 recipe 的**单步调试会话**：起一趟真实的 `runDesktopRecipe`，在每一步之前停下来等人放行。
 *
 * 为什么不是"另一个只跑一步的 runner"：单步下能过、整跑就挂的差异，只有两条路是同一条路时才
 * 查得出来。所以这里只做两件事——把 runner 的 `stepGate` 接到一个"等 next 调用"的 promise 上，
 * 把探针那几行攒起来回给看的人。recipe 一个字不改，identify / expect / branch 全走原路。
 *
 * 会话状态机（每个 sessionId 一个）：
 *
 *   start → 停在第 0 步之前（`waitingAt`）→ next → 跑这一步 → 停在下一步之前 / 整轮结束 → …
 *
 * 三个入口都回同一个形状 {sessionId, state, step?, probes, outcome?}，`state` 是唯一要看的字段：
 * `paused`（停在 `step` 之前，等 next）/ `running`（上一步还没跑完，再 next 一次接着等）/
 * `finished`（`outcome` 是整轮结果）/ `aborted`。
 *
 * 没人来 `next` 的会话 `IDLE_ABORT_MS` 之后自己中止——停着的那一趟占着桌面会话租约，其它 recipe
 * 全在排队。
 */
import { randomUUID } from 'node:crypto'
import type { DesktopDriver } from '../replay/desktop-driver.ts'
import type { DesktopRecipe, DesktopStep } from '../replay/desktop-recipe.ts'
import type { SeeResolver } from '../replay/desktop-see.ts'
import { runDesktopRecipe, type DesktopRunOutcome, type OverrideSource } from '../replay/desktop-runner.ts'
import type { Recipe } from '../replay/recipe.ts'
import { INTERACTIVE_SESSION_WAIT_MS } from '../http/host-relay.ts'
import { materializeParams, validateParams, type ParamEnv } from './validate-params.ts'

/** 停着不动多久算没人管。单步调试是人在看着的事，十分钟没人放行就当他走开了。 */
export const IDLE_ABORT_MS = 10 * 60_000
/** `next` 等这一步跑完的上限：过了就回 `running` 让调用方再问一次——宿主的 MCP 客户端
 *  自己有 60s 硬上限（见 docs/TODO.md 那条），这里必须比它短。 */
export const NEXT_WAIT_MS = 45_000

export interface RecipeDebugDeps {
  findRecipe: (sourceId: string) => Recipe | undefined
  desktopDriver: () => DesktopDriver | undefined
  makeSee?: (driver: DesktopDriver, sourceId: string) => SeeResolver
  /** 本机学到的落地方式——**和 `run_action_recipe` 那份同源**（见 mcp-extras 那一跳的头注）。
   *  不递的话单步调试跑的是"没有本机落地方式"的另一条路，而它本来就是拿来复现真实那趟的。
   *
   *  **递了就意味着单步调试也在写这本账**：跑通的那几步照样 `recordRun` 记一笔、开头照样对账。
   *  这是有意的——人盯着一步步跑通的落地方式，和自动跑通的是同一个 driver、同一个界面，没有
   *  理由算得更轻。不想让调试污染记账的话，这一格别递。 */
  recipeOverrides?: OverrideSource
  /** `format:'path'` 参数的翻译环境（同 `ActionRecipeDeps.paramEnv`）。 */
  paramEnv?: ParamEnv
  /** 可注入的执行器（测试用）。 */
  runDesktop?: typeof runDesktopRecipe
  now?: () => number
  /** 可注入的定时器（测试用）。 */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

export interface StepView {
  index: number
  total: number
  kind: string
  label?: string
  /** 这一步 recipe 里写的原文（去掉 `_why*` 说明），看的人据此知道它要点什么、验什么。 */
  spec: Record<string, unknown>
}

export type RecipeDebugState = 'paused' | 'running' | 'finished' | 'aborted'

export interface RecipeDebugView {
  sessionId: string
  sourceId: string
  state: RecipeDebugState
  /** `paused` 时：停在这一步之前。 */
  step?: StepView
  /** 上一次回执之后新攒下的探针行（`+123ms #3 branch 成立 …`）。 */
  probes: string[]
  /** `finished` 时整轮的结果。 */
  outcome?: DesktopRunOutcome
  reason?: string
}

export type RecipeDebugStartResult =
  | RecipeDebugView
  | { status: 'not-found' | 'not-desktop' | 'invalid-params' | 'no-desktop'; sourceId: string; reason: string }

interface Session {
  id: string
  sourceId: string
  state: RecipeDebugState
  step?: StepView
  probes: string[]
  outcome?: DesktopRunOutcome
  reason?: string
  /** 停在某一步之前时，放行它的那只手。 */
  release?: (v: 'run' | 'abort') => void
  /** 答过 abort：整轮收场时记成 `aborted` 而不是 `finished`（runner 那边同样以 drift 收场）。 */
  abortRequested?: boolean
  /** 状态一变就叫醒等着的 `next`/`start`。 */
  wake: Array<() => void>
  idle?: unknown
  done: Promise<void>
}

function stepView(step: DesktopStep, index: number, total: number): StepView {
  const spec: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(step)) {
    if (k.startsWith('_why') || k === 'label' || k === 'kind') continue
    spec[k] = v
  }
  return { index, total, kind: step.kind, ...(step.label ? { label: step.label } : {}), spec }
}

export function createRecipeDebugSessions(deps: RecipeDebugDeps) {
  const sessions = new Map<string, Session>()
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout))

  const view = (s: Session): RecipeDebugView => {
    const probes = s.probes
    s.probes = []
    return {
      sessionId: s.id,
      sourceId: s.sourceId,
      state: s.state,
      ...(s.state === 'paused' && s.step ? { step: s.step } : {}),
      probes,
      ...(s.outcome ? { outcome: s.outcome } : {}),
      ...(s.reason ? { reason: s.reason } : {}),
    }
  }
  const notify = (s: Session) => {
    const w = s.wake
    s.wake = []
    for (const fn of w) fn()
  }
  /** 等到状态离开 `running`，或等满 ms。 */
  const settle = (s: Session, ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (s.state !== 'running') return resolve()
      const h = setTimer(() => resolve(), ms)
      s.wake.push(() => {
        clearTimer(h)
        resolve()
      })
    })
  const armIdle = (s: Session) => {
    if (s.idle) clearTimer(s.idle)
    s.idle = setTimer(() => {
      if (s.state === 'paused' && s.release) {
        s.reason = `${IDLE_ABORT_MS / 60_000} 分钟没人放行，会话自动中止（停着的那一趟占着桌面会话租约）`
        s.release('abort')
      }
    }, IDLE_ABORT_MS)
  }

  async function start(args: { sourceId: string; params?: Record<string, unknown> }): Promise<RecipeDebugStartResult> {
    const { sourceId } = args
    const recipe = deps.findRecipe(sourceId)
    if (!recipe) return { status: 'not-found', sourceId, reason: `没有叫 "${sourceId}" 的 recipe` }
    if (recipe.kind !== 'desktop') return { status: 'not-desktop', sourceId, reason: `"${sourceId}" 是 kind:"${recipe.kind}"，单步调试今天只接桌面 recipe` }
    // 参数闸与 `runActionRecipe` 同一套（未声明的键拒、按 schema 校验、String() 进键盘、补 default）：
    // 单步跑的必须是整跑时那份一模一样的参数，否则"单步能过、整跑就挂"又多了一个来源。
    const paramsSchema = (recipe.meta?.params_schema ?? {}) as Record<string, unknown>
    const params = args.params ?? {}
    const unknownKeys = Object.keys(params).filter((k) => !Object.prototype.hasOwnProperty.call(paramsSchema, k))
    if (unknownKeys.length > 0) {
      return { status: 'invalid-params', sourceId, reason: `params 里有 params_schema 没声明过的键：${unknownKeys.join(', ')}` }
    }
    let stringParams: Record<string, string>
    try {
      validateParams(paramsSchema, params)
      stringParams = materializeParams(paramsSchema, params, deps.paramEnv)
    } catch (e) {
      return { status: 'invalid-params', sourceId, reason: e instanceof Error ? e.message : String(e) }
    }
    const driver = deps.desktopDriver()
    if (!driver) return { status: 'no-desktop', sourceId, reason: 'Stream Desktop 没连着，单步调试起不来' }

    const s: Session = { id: randomUUID().slice(0, 8), sourceId, state: 'running', probes: [], wake: [], done: Promise.resolve() }
    sessions.set(s.id, s)
    const makeSee = deps.makeSee
    s.done = (deps.runDesktop ?? runDesktopRecipe)(recipe as DesktopRecipe, stringParams, driver, {
      waitMs: INTERACTIVE_SESSION_WAIT_MS,
      ...(makeSee && { see: (d: DesktopDriver) => makeSee(d, sourceId) }),
      // 原样递（不填 `packageInfo`：这一跳手里只有 `Recipe`，没有包身份）。
      ...(deps.recipeOverrides && { overrides: deps.recipeOverrides }),
      onProbe: (line) => s.probes.push(line),
      stepGate: ({ index, step, total }) =>
        new Promise<'run' | 'abort'>((resolve) => {
          s.state = 'paused'
          s.step = stepView(step, index, total)
          s.release = (v) => {
            s.release = undefined
            s.step = undefined
            // 答 abort 之后 runner 还要收场（写 outcome、清指示条），所以这里仍是 `running`，
            // 等 run 的 promise 落定再记成 aborted——否则调用方拿到的 view 里没有 outcome。
            if (v === 'abort') s.abortRequested = true
            s.state = 'running'
            resolve(v)
          }
          armIdle(s)
          notify(s)
        }),
    })
      .then((outcome) => {
        s.outcome = outcome
        s.state = s.abortRequested ? 'aborted' : 'finished'
      })
      .catch((e) => {
        s.state = 'aborted'
        s.reason = e instanceof Error ? e.message : String(e)
      })
      .finally(() => {
        if (s.idle) clearTimer(s.idle)
        notify(s)
      })
    await settle(s, NEXT_WAIT_MS)
    return view(s)
  }

  async function next(sessionId: string): Promise<RecipeDebugView> {
    const s = sessions.get(sessionId)
    if (!s) return { sessionId, sourceId: '', state: 'aborted', probes: [], reason: '没有这个会话（可能已经结束并被回收）' }
    if (s.state === 'paused' && s.release) s.release('run')
    await settle(s, NEXT_WAIT_MS)
    const v = view(s)
    if (s.state === 'finished' || s.state === 'aborted') sessions.delete(s.id)
    return v
  }

  async function abort(sessionId: string): Promise<RecipeDebugView> {
    const s = sessions.get(sessionId)
    if (!s) return { sessionId, sourceId: '', state: 'aborted', probes: [], reason: '没有这个会话' }
    s.reason = '调用方中止'
    if (s.state === 'paused' && s.release) s.release('abort')
    // 正在跑的那一步打断不了（op 在物理连接上串行），跑完停在下一步之前时再中止。
    else if (s.state === 'running') {
      s.wake.push(() => {
        if (s.state === 'paused' && s.release) s.release('abort')
      })
    }
    await settle(s, NEXT_WAIT_MS)
    const v = view(s)
    if (s.state === 'finished' || s.state === 'aborted') sessions.delete(s.id)
    return v
  }

  return { start, next, abort, _sessions: sessions, _now: now }
}
