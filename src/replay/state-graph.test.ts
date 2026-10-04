import { describe, expect, it } from 'vitest'
import {
  checkDiscriminative,
  escapesFrom,
  featureKey,
  findPath,
  matchesObservation,
  validateStateGraph,
  type Observation,
  type StateDef,
  type StateGraph,
} from './state-graph.ts'

const url = (pattern: string) => ({ kind: 'url', pattern }) as const
const dom = (selector: string, absent?: boolean) =>
  ({ kind: 'dom', selector, ...(absent !== undefined && { absent }) }) as const

describe('featureKey', () => {
  it('同一条特征的键稳定，且 absent 与否是两条不同的键', () => {
    expect(featureKey(dom('.a'))).toBe(featureKey(dom('.a')))
    expect(featureKey(dom('.a'))).not.toBe(featureKey(dom('.a', true)))
  })

  it('不同 kind 不会撞键', () => {
    expect(featureKey(url('.a'))).not.toBe(featureKey(dom('.a')))
  })
})

describe('validateStateGraph', () => {
  it('特征为空的状态非法——它会匹配一切', () => {
    const g: StateGraph = { states: [{ id: 'a', features: [] }], transitions: [] }
    expect(() => validateStateGraph(g)).toThrow(/特征为空/)
  })

  it('状态 id 重复非法', () => {
    const g: StateGraph = {
      states: [{ id: 'a', features: [url('x')] }, { id: 'a', features: [url('y')] }],
      transitions: [],
    }
    expect(() => validateStateGraph(g)).toThrow(/重复/)
  })

  it('转移指向不存在的状态非法', () => {
    const g: StateGraph = {
      states: [{ id: 'a', features: [url('x')] }],
      transitions: [{ from: 'a', to: 'ghost', steps: [] }],
    }
    expect(() => validateStateGraph(g)).toThrow(/ghost/)
  })

  it('合法的图原样通过', () => {
    const g: StateGraph = {
      states: [{ id: 'a', features: [url('x')] }, { id: 'b', features: [url('y')] }],
      transitions: [{ from: 'a', to: 'b', steps: [] }],
    }
    expect(() => validateStateGraph(g)).not.toThrow()
  })
})

describe('checkDiscriminative', () => {
  const existing: StateDef[] = [
    { id: 'logged-in', features: [dom('.feed')] },
    { id: 'login-wall', features: [dom('.login-btn')] },
  ]
  const obs: Observation[] = [
    { state: 'logged-in', truths: [featureKey(dom('.feed')), featureKey(dom('.header'))] },
    { state: 'login-wall', truths: [featureKey(dom('.login-btn')), featureKey(dom('.header'))] },
  ]

  it('跨组不算撞车——一个屏上可以既"开着搜索面板"又"在某人的对话里"', () => {
    // 两者用同一条特征，撞得结结实实；但它们描述的是屏幕上不相干的两件事。
    // 没有 group 这一格，闸会把这个完全合法的定义挡下来。
    const grouped: StateDef[] = [{ id: 'middle/search', group: 'middle', features: [dom('.x')] }]
    const o: Observation[] = [{ state: 'middle/search', truths: [featureKey(dom('.x'))] }]
    const candidate: StateDef = { id: 'right/convo', group: 'right', features: [dom('.x')] }
    expect(checkDiscriminative(candidate, grouped, o)).toEqual({ ok: true })
  })

  it('同组照旧撞车', () => {
    const grouped: StateDef[] = [{ id: 'middle/search', group: 'middle', features: [dom('.x')] }]
    const o: Observation[] = [{ state: 'middle/search', truths: [featureKey(dom('.x'))] }]
    const candidate: StateDef = { id: 'middle/list', group: 'middle', features: [dom('.x')] }
    expect(checkDiscriminative(candidate, grouped, o)).toEqual({ ok: false, collidesWith: ['middle/search'] })
  })

  it('别的屏上都没有的特征通过', () => {
    const candidate: StateDef = { id: 'compose', features: [dom('.editor')] }
    expect(checkDiscriminative(candidate, existing, obs)).toEqual({ ok: true })
  })

  it('两屏都有的特征被打回，并点名撞上了谁', () => {
    const candidate: StateDef = { id: 'compose', features: [dom('.header')] }
    expect(checkDiscriminative(candidate, existing, obs)).toEqual({
      ok: false,
      collidesWith: ['logged-in', 'login-wall'],
    })
  })

  // 这条钉的是「撞上一个就够」。写成「撞上所有才算」也能让上面那条绿——但那样的闸在
  // 10 个状态时撞上 9 个照样放行，正好把它要防的事（状态库越长越糊）反过来。
  it('只撞上一个也要打回——还会在别的状态上成立的特征，就回答不了「我在哪」', () => {
    const candidate: StateDef = { id: 'compose', features: [dom('.header'), dom('.feed')] }
    expect(checkDiscriminative(candidate, existing, obs)).toEqual({
      ok: false,
      collidesWith: ['logged-in'],
    })
  })

  it('单条不够、两条合起来才唯一的组合能通过——闸看的是整组不是单条', () => {
    const candidate: StateDef = { id: 'compose', features: [dom('.header'), dom('.editor')] }
    expect(checkDiscriminative(candidate, existing, obs)).toEqual({ ok: true })
  })

  it('候选自己那条观测不算撞车', () => {
    const withSelf = [
      ...obs,
      { state: 'compose', truths: [featureKey(dom('.header')), featureKey(dom('.editor'))] },
    ]
    const candidate: StateDef = { id: 'compose', features: [dom('.header'), dom('.editor')] }
    expect(checkDiscriminative(candidate, existing, withSelf)).toEqual({ ok: true })
  })
})

describe('findPath', () => {
  const g: StateGraph = {
    states: [
      { id: 'a', features: [url('a')] },
      { id: 'b', features: [url('b')] },
      { id: 'c', features: [url('c')] },
      { id: 'd', features: [url('d')] },
    ],
    transitions: [
      { from: 'a', to: 'b', steps: [] },
      { from: 'b', to: 'c', steps: [] },
      { from: 'a', to: 'd', steps: [] },
      { from: 'd', to: 'c', steps: [] },
    ],
  }

  it('起点即终点返回空路径，不是 null', () => {
    expect(findPath(g, 'a', 'a')).toEqual([])
  })

  it('找得到最短的那条', () => {
    const p = findPath(g, 'a', 'c')
    expect(p?.map((t) => `${t.from}->${t.to}`)).toEqual(['a->b', 'b->c'])
  })

  it('走不到就 null', () => {
    const isolated: StateGraph = { ...g, transitions: [{ from: 'a', to: 'b', steps: [] }] }
    expect(findPath(isolated, 'a', 'c')).toBeNull()
  })

  it('有环也不会转不出来', () => {
    const cyclic: StateGraph = {
      ...g,
      transitions: [...g.transitions, { from: 'c', to: 'a', steps: [] }],
    }
    expect(findPath(cyclic, 'a', 'c')).toHaveLength(2)
  })
})

describe('matchesObservation', () => {
  it('全部特征都在观测里才算匹配（AND）', () => {
    const o: Observation = { state: 'x', truths: [featureKey(dom('.a'))] }
    expect(matchesObservation([dom('.a')], o)).toBe(true)
    expect(matchesObservation([dom('.a'), dom('.b')], o)).toBe(false)
  })
})

describe('逃生口（没有目的地的转移）', () => {
  const g: StateGraph = {
    states: [
      { id: 'a', features: [url('a')] },
      { id: 'cf', features: [url('cf')] },
      { id: 'z', features: [url('z')] },
    ],
    transitions: [
      { from: 'a', to: 'z', steps: [] },
      { from: 'cf', steps: [] }, // 逃生口：清掉之后落在哪，取决于本来要去哪
    ],
  }

  it('findPath 不把逃生口当成路——它不是路线', () => {
    // 从 cf 出发到 z 没有已知路径：那条逃生口通向"未知"，规划不了
    expect(findPath(g, 'cf', 'z')).toBeNull()
  })

  it('逃生口也不能被当成到达任何状态的最后一跳', () => {
    expect(findPath(g, 'a', 'cf')).toBeNull()
  })

  it('escapesFrom 把某个状态的逃生口取出来', () => {
    expect(escapesFrom(g, 'cf')).toHaveLength(1)
    expect(escapesFrom(g, 'a')).toEqual([])
  })

  it('校验：逃生口的 from 仍然必须存在', () => {
    const bad: StateGraph = { states: [{ id: 'a', features: [url('a')] }], transitions: [{ from: 'ghost', steps: [] }] }
    expect(() => validateStateGraph(bad)).toThrow(/ghost/)
  })
})

describe('死路状态', () => {
  it('deadEnd 是一句给人看的理由，不是布尔', () => {
    const g: StateGraph = {
      states: [{ id: 'banned', features: [url('b')], deadEnd: '出口已被封禁' }],
      transitions: [],
    }
    expect(() => validateStateGraph(g)).not.toThrow()
    expect(g.states[0]!.deadEnd).toBe('出口已被封禁')
  })

  it('死路状态不许再声明出口——两者矛盾，留着必然有人照着走', () => {
    const g: StateGraph = {
      states: [{ id: 'banned', features: [url('b')], deadEnd: 'x' }, { id: 'z', features: [url('z')] }],
      transitions: [{ from: 'banned', to: 'z', steps: [] }],
    }
    expect(() => validateStateGraph(g)).toThrow(/死路/)
  })
})
