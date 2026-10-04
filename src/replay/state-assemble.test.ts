import { describe, expect, it } from 'vitest'
import { assembleGraph } from './state-assemble.ts'
import { validateStateGraph, type StateGraph } from './state-graph.ts'

const url = (pattern: string) => ({ kind: 'url', pattern }) as const
const G: StateGraph = {
  states: [{ id: 'cf/banned', features: [url('*cf*')], deadEnd: '被封禁' }],
  transitions: [],
}
const L: StateGraph = {
  states: [{ id: 'x/home', features: [url('*x*')] }, { id: 'x/list', features: [url('*x/l*')] }],
  transitions: [{ from: 'x/home', to: 'x/list', steps: [] }],
}

describe('assembleGraph', () => {
  it('两份合成一份，装配后仍是一张合法的图', () => {
    const g = assembleGraph(G, L)
    expect(g.states.map((s) => s.id).sort()).toEqual(['cf/banned', 'x/home', 'x/list'])
    expect(g.transitions).toHaveLength(1)
  })

  it('没有本地那份时，只有全局的也成立', () => {
    expect(assembleGraph(G).states.map((s) => s.id)).toEqual(['cf/banned'])
  })

  it('两份都为空时给一张空图，不抛错——绝大多数 recipe 今天就是这样', () => {
    const empty = assembleGraph({ states: [], transitions: [] })
    expect(empty.states).toEqual([])
  })

  it('id 撞车要抛错并点名——本地不许悄悄盖掉全局的定义', () => {
    const clash: StateGraph = { states: [{ id: 'cf/banned', features: [url('*other*')] }], transitions: [] }
    expect(() => assembleGraph(G, clash)).toThrow(/cf\/banned/)
  })

  // 这两条是一对：正向那条钉的是 `assembleGraph` 存在的理由（本地图单独看非法、合起来才合法），
  // 反向那条钉的是「合起来也照样过一遍 validateStateGraph」。只留反向那条的话，正向路径
  // 一次都没被证明过——而那正是这个函数唯一要干的事。
  it('本地引用了全局的状态就算合法——单独看它是非法的', () => {
    const refsGlobal: StateGraph = {
      states: [{ id: 'x/home', features: [url('*x*')] }],
      transitions: [{ from: 'x/home', to: 'cf/banned', steps: [] }], // to 在全局那份里
    }
    expect(() => validateStateGraph(refsGlobal)).toThrow(/to 指向不存在/)
    expect(() => assembleGraph(G, refsGlobal)).not.toThrow()
  })

  it('装配结果照样要过 validateStateGraph——死路不许再有出口', () => {
    const fromDeadEnd: StateGraph = {
      states: [{ id: 'x/home', features: [url('*x*')] }],
      transitions: [{ from: 'cf/banned', steps: [] }],
    }
    expect(() => assembleGraph(G, fromDeadEnd)).toThrow(/死路/)
  })
})
