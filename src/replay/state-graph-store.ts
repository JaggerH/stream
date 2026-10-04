import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertStateIdPrefix, validateStateGraph, type StateDef, type StateGraph, type Transition } from './state-graph.ts'
import { facilityFileName } from './observation-ledger.ts'

/** 学到那一层的状态多两格来源：能撤、能审、以后能一键「升格进包」。装配进 runner 时剥掉。 */
export interface LearnedState extends StateDef { proposalId: string; acceptedAt: string }
export interface LearnedStateGraph { version: 1; facility: string; states: LearnedState[]; transitions: Transition[] }

function strip(s: LearnedState): StateDef {
  const { proposalId: _p, acceptedAt: _a, ...def } = s
  return def
}

/**
 * 状态图的本地两层（spec §9.1）：**包自带**（`packages/<id>/states.json`，由 recipe-package 扫描器读进
 * `RecipePackage.states`，这里只经 `authored(facility)` 现取）与**本机学到的**（`<dataDir>/state-graphs/
 * <facility>.json`，接受提议时写）。`graphFor` 合成两层；runner 再并上内置全局那张（`assembleGraph`）。
 *
 * 学到的层放 `<dataDir>` 而不是包目录：npm 装来的包不该被我们改写，而且它是「这台机器上学到的」。
 */
export class StateGraphStore {
  constructor(
    private readonly learnedDir: string,
    /** 调用时现取：install 热挂载后包快照会整体换掉，装配期取一次就是冻住的那份。 */
    private readonly authored: (facility: string) => StateGraph | undefined,
  ) {}

  private path(facility: string): string { return join(this.learnedDir, `${facilityFileName(facility)}.json`) }

  learned(facility: string): LearnedStateGraph | undefined {
    const p = this.path(facility)
    if (!existsSync(p)) return undefined
    try { return JSON.parse(readFileSync(p, 'utf8')) as LearnedStateGraph } catch { return undefined }
  }

  /**
   * authored ∪ learned 合成图 + 撞车判据——**读（`graphFor`）和写（`put`）必须用同一套**，
   * 否则会出现「写的时候只查了学到那层、读的时候才拿合成图去校验」的两头不一致：
   * `addLearnedTransition` 的 from/to 指向包自带状态会在写时被误拒（因为写时看不到 authored 那层），
   * `addLearnedState` 与包自带 id 撞车却写成功、留到下次 `graphFor` 才炸。
   *
   * 两层 id 撞车抛错而不是让学到的赢：静默盖掉包里的一条定义，症状是"这个源认不出、别的都认得出"。
   */
  private assembled(facility: string, learnedStates: LearnedState[], learnedTransitions: Transition[]): StateGraph {
    const a = this.authored(facility)
    const authoredIds = new Set((a?.states ?? []).map((s) => s.id))
    const clash = learnedStates.find((s) => authoredIds.has(s.id))
    if (clash) throw new Error(`学到的状态 ${clash.id} 与包自带的 states.json 撞车——删掉学到的那条，或改包里的名字`)
    return {
      states: [...(a?.states ?? []), ...learnedStates.map(strip)],
      transitions: [...(a?.transitions ?? []), ...learnedTransitions],
      ...(a?.anchor !== undefined ? { anchor: a.anchor } : {}),
    }
  }

  graphFor(facility: string): StateGraph | undefined {
    const a = this.authored(facility)
    const l = this.learned(facility)
    // 两层都没有 → 如实回 undefined，不补一张空图：空图和"这个源没配状态"是同一件事，
    // 但下游拿到空图会以为图配过了（`stateGraph` 传下去、identify 空转），缺席就该看得见。
    if (!a && !l) return undefined
    const merged = this.assembled(facility, l?.states ?? [], l?.transitions ?? [])
    validateStateGraph(merged)
    return merged
  }

  private put(facility: string, g: LearnedStateGraph): LearnedStateGraph {
    for (const s of g.states) assertStateIdPrefix(facility, s.id)
    // 校验**合成后**的图（authored ∪ 这次要写的 learned），不是只看学到的这层——
    // 见上面 `assembled` 头注。
    validateStateGraph(this.assembled(facility, g.states, g.transitions))
    mkdirSync(this.learnedDir, { recursive: true })
    const tmp = join(this.learnedDir, `.${facilityFileName(facility)}.${process.pid}.tmp`)
    writeFileSync(tmp, JSON.stringify(g, null, 2))
    renameSync(tmp, this.path(facility))
    return g
  }

  private fresh(facility: string): LearnedStateGraph {
    return this.learned(facility) ?? { version: 1, facility, states: [], transitions: [] }
  }

  addLearnedState(facility: string, s: StateDef, origin: { proposalId: string; acceptedAt: string }): LearnedStateGraph {
    const cur = this.fresh(facility)
    if (cur.states.some((x) => x.id === s.id)) throw new Error(`状态 id 重复：${s.id}`)
    return this.put(facility, { ...cur, states: [...cur.states, { ...s, ...origin }] })
  }

  replaceLearnedState(facility: string, s: StateDef): LearnedStateGraph {
    const cur = this.fresh(facility)
    const old = cur.states.find((x) => x.id === s.id)
    // 不存在就抛，**不悄悄当成新增**：replace 的语义是"改一条已被接受的"，静默新增会绕过
    // addLearnedState 那条路上的来源记账（proposalId / acceptedAt），从此撤不回、审不出。
    if (!old) throw new Error(`学到的层里不存在状态 ${s.id}`)
    return this.put(facility, {
      ...cur,
      states: cur.states.map((x) => (x.id === s.id ? { ...s, proposalId: old.proposalId, acceptedAt: old.acceptedAt } : x)),
    })
  }

  addLearnedTransition(facility: string, t: Transition): LearnedStateGraph {
    const cur = this.fresh(facility)
    return this.put(facility, { ...cur, transitions: [...cur.transitions, t] })
  }
}
