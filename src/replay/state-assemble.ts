import { validateStateGraph, type StateGraph } from './state-graph.ts'

/**
 * 一次运行用的图 = 全局那份 ∪ 这份 recipe 自己那份。
 *
 * **装配在装载期做一次**,之后骨架看到的就是一张普通的图——`identify()`、找路、防转圈、
 * 轨迹、AI 介入闸全部照旧,一行都不用为全局状态分叉(spec §3.5)。
 *
 * id 撞车**抛错而不是让本地赢**:本地悄悄盖掉一条全局定义,症状是"别的源都认得出 CF,
 * 就这个源认不出",而没有任何一处会说出原因。
 */
export function assembleGraph(global: StateGraph, local?: StateGraph): StateGraph {
  const merged: StateGraph = {
    states: [...global.states, ...(local?.states ?? [])],
    transitions: [...global.transitions, ...(local?.transitions ?? [])],
    ...(local?.anchor !== undefined && { anchor: local.anchor }),
  }
  const seen = new Set<string>()
  for (const s of merged.states) {
    if (seen.has(s.id)) throw new Error(`状态 id 与全局那份撞车：${s.id}——本地不许盖掉全局定义`)
    seen.add(s.id)
  }
  // 合起来才校验:本地那份可以引用全局的状态，单独看它是非法的。
  validateStateGraph(merged)
  return merged
}
