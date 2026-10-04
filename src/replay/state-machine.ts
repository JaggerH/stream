// src/replay/state-machine.ts
import { findPath, validateStateGraph, type StateGraph, type StateId, type Transition } from './state-graph.ts'
import type { Perception } from './state-perception.ts'
import type { RepairRunner } from './repair-runner.ts'
import type { StateTrace } from './state-trace.ts'

/** 走完一段转移的所有步骤。骨架不认识步骤长什么样——那是路线的事。 */
export interface StepExecutor {
  run(t: Transition): Promise<{ ok: boolean; failedLabel?: string }>
}

/**
 * `repairs` 不叫 `modelCalls`：本期的 `identify()` 只用本地感知（DOM 选择器 / URL / a11y / OCR），
 * 不花模型钱，唯一的模型支出是 AI 介入。
 */
export interface Budget {
  steps: number
  wallMs: number
  repairs: number
}

export const DEFAULT_BUDGET: Budget = { steps: 40, wallMs: 300_000, repairs: 3 }

/** 同一状态访问到第几次算转圈。取 3 不取 2：合法的「回家重走一次」会让某个状态出现两次。 */
export const LOOP_LIMIT = 3

export interface RunOptions {
  sourceId: string
  perception: Perception
  exec: StepExecutor
  /** 省略 = 不介入，落空即失败。 */
  repair?: RepairRunner
  /** 网页侧传 `'every-step'`（identify 免费，认得越勤越早发现走偏）；桌面侧用默认。 */
  identifyPolicy?: 'on-failure' | 'every-step'
  budget?: Partial<Budget>
  trace?: StateTrace
  now?: () => number
}

export interface RunResult {
  outcome: 'reached' | 'looping' | 'budget' | 'stuck'
  finalState: StateId | null
  visited: StateId[]
}

export async function runToState(graph: StateGraph, goal: StateId, opts: RunOptions): Promise<RunResult> {
  validateStateGraph(graph)
  const budget = { ...DEFAULT_BUDGET, ...opts.budget }
  const now = opts.now ?? Date.now
  const started = now()
  const visited: StateId[] = []
  let state: StateId | null = null
  let steps = 0
  let repairs = 0

  /** 只在预算内介入。超了就不问——**别在已经决定放弃的时候还去花一次钱**。 */
  const intervene = async (fn: (r: RepairRunner) => Promise<void>): Promise<void> => {
    if (!opts.repair || repairs >= budget.repairs) return
    repairs += 1
    await fn(opts.repair)
  }

  const done = (outcome: RunResult['outcome']): RunResult => ({ outcome, finalState: state, visited })

  while (true) {
    if (steps >= budget.steps || now() - started >= budget.wallMs) return done('budget')

    // 认状态：起步时，或上一趟 expect 落空之后。顺路那一支走不到这里——这是成本基础。
    // 认状态可能同时命中好几个（跨组的状态互不相干，见 identifyWith）。**不在这里挑一个**——
    // 下面按"哪个起点到目标最短"来定，选择由路径做出，不是随手取第一个。
    let hits: StateId[]
    if (state !== null) {
      hits = [state]
    } else {
      const r = await opts.perception.identify(graph.states)
      await opts.trace?.write({
        identified: {
          states: r.states ?? [],
          ...(r.states === null && { reason: r.reason, candidates: r.candidates }),
          matched: r.states === null ? [] : r.matched,
        },
      })
      if (r.states === null) {
        const base = { sourceId: opts.sourceId, reason: `identify 未认出（${r.reason}）`, observed: [] }
        if (r.reason === 'ambiguous') {
          await intervene((x) =>
            x.proposeDiscriminator({ ...base, kind: 'discriminator', candidates: r.candidates }),
          )
        } else {
          await intervene((x) => x.proposeState({ ...base, kind: 'state' }))
        }
        return done('stuck')
      }
      // 目标在命中集合里就是到了——不要求它是"唯一"命中的那个。
      if (r.states.includes(goal)) {
        state = goal
        visited.push(goal)
        return done('reached')
      }
      hits = r.states
    }

    // 多源找路：每个命中都当一次起点，取最短的那条。都走不到才算卡住。
    let best: { from: StateId; path: Transition[] } | null = null
    for (const from of hits) {
      const p = findPath(graph, from, goal)
      if (p !== null && p.length > 0 && (best === null || p.length < best.path.length)) {
        best = { from, path: p }
      }
    }
    state = best?.from ?? hits[0]!
    visited.push(state)
    // 防转圈：线性脚本走不出环，状态图会——而 AI 介入会让它转得特别自信。
    if (visited.filter((s) => s === state).length >= LOOP_LIMIT) return done('looping')

    if (state === goal) return done('reached')

    // `best` 只在找到非空路径时才被赋值，所以这里没有「有 best 但路是空的」那一档。
    if (best === null) {
      await intervene((x) =>
        x.proposeTransition({
          sourceId: opts.sourceId,
          kind: 'transition',
          reason: '认出了当前状态，但没有到目标的已知路径',
          observed: [],
          from: state!,
          goal,
        }),
      )
      return done('stuck')
    }

    const t = best.path[0]!
    // findPath 回来的每一段都跳过了逃生口（无 to 的转移不参与找路），所以这里 to 必有值。
    const to = t.to!
    const res = await opts.exec.run(t)
    steps += 1
    await opts.trace?.write({
      identified: { states: [state], matched: [] },
      action: { from: t.from, to, ...(res.failedLabel && { label: res.failedLabel }) },
      outcome: { expectMet: res.ok },
    })

    // 走完**不假定**到了 `t.to`：到没到由下一轮 identify 说了算。
    // 落空则回到 null，下一圈重认——识别是故障处理器，正是在这里点火。
    state = res.ok && opts.identifyPolicy !== 'every-step' ? to : null
  }
}
