import { describe, expect, it, vi } from 'vitest'
import { classifyByState } from './state-classify.ts'
import type { Observation, StateGraph } from './state-graph.ts'

const dom = (selector: string) => ({ kind: 'dom', selector }) as const
const graph: StateGraph = {
  states: [
    { id: 'g/dead', features: [dom('.banned')], deadEnd: '走不通了' },
    { id: 'g/clearable', features: [dom('.chal')] },
    { id: 'g/plain', features: [dom('.plain')] },
  ],
  transitions: [{ from: 'g/clearable', steps: [{ kind: 'wait', ms: 10 }] }],
}

const driverWith = (present: string[]) =>
  ({ exists: async (s: string) => present.includes(s), currentUrl: async () => 'https://x/' }) as never

describe('classifyByState', () => {
  it('什么都不认得 → unknown，调用方照旧走今天的路', async () => {
    expect(await classifyByState(driverWith(['.article']), graph)).toEqual({ kind: 'unknown' })
  })

  it('认出死路 → deadEnd，带上 id 和那句人话', async () => {
    const v = await classifyByState(driverWith(['.banned']), graph)
    expect(v).toEqual({ kind: 'deadEnd', state: 'g/dead', reason: '走不通了' })
  })

  it('认出有逃生口的 → escapable，把那条逃生口交出去', async () => {
    const v = await classifyByState(driverWith(['.chal']), graph)
    expect(v).toMatchObject({ kind: 'escapable', state: 'g/clearable' })
    if (v.kind !== 'escapable') throw new Error('unreachable')
    expect(v.escape.steps).toHaveLength(1)
  })

  it('认得出、但既不是死路也没有逃生口 → identified，不假装能处理', async () => {
    const v = await classifyByState(driverWith(['.plain']), graph)
    expect(v).toEqual({ kind: 'identified', states: ['g/plain'] })
  })

  it('多个同时命中 → ambiguous，不挑一个', async () => {
    const v = await classifyByState(driverWith(['.chal', '.plain']), graph)
    expect(v).toMatchObject({ kind: 'ambiguous', candidates: ['g/clearable', 'g/plain'] })
  })

  it('撞车里含死路 → 仍然报死路。撞车说的是「我分不开」，和「其中一个走不通」无关', async () => {
    // 这不是罕见情形：CF 拦截页是同源返回的、URL 一个字不变，靠 url 特征认的本地状态在
    // 封禁页上照样为真。先报 ambiguous 就再也走不到死路那一档，而那是最该早停的一档。
    const v = await classifyByState(driverWith(['.banned', '.chal']), graph)
    expect(v).toEqual({ kind: 'deadEnd', state: 'g/dead', reason: '走不通了' })
  })

  it('空图直接 unknown，一次 exists 都不问', async () => {
    const exists = vi.fn(async () => false)
    const v = await classifyByState({ exists } as never, { states: [], transitions: [] })
    expect(v).toEqual({ kind: 'unknown' })
    expect(exists).not.toHaveBeenCalled()
  })

  it('探测自己抛错时回 unknown，不把它变成一次失败——这是诊断，不该反过来毁掉运行', async () => {
    const boom = { exists: async () => { throw new Error('detached') } } as never
    expect(await classifyByState(boom, graph)).toEqual({ kind: 'unknown' })
  })

  it('认出来就记一笔观测：那一刻为真的特征键，每个命中的状态一条', async () => {
    const seen: Observation[] = []
    await classifyByState(driverWith(['.plain']), graph, (o) => seen.push(o))
    expect(seen).toEqual([{ state: 'g/plain', truths: ['dom:.plain'] }])
  })

  it('死路 / 有逃生口也照记——观测账本记的是「认出来了」，不是「这一趟顺不顺」', async () => {
    const seen: Observation[] = []
    await classifyByState(driverWith(['.chal']), graph, (o) => seen.push(o))
    expect(seen).toEqual([{ state: 'g/clearable', truths: ['dom:.chal'] }])
  })

  it('认不出来 → 一条都不记（没有状态可挂）；账本自己抛错也不掀翻诊断', async () => {
    const seen: Observation[] = []
    await classifyByState(driverWith(['.nothing']), graph, (o) => seen.push(o))
    expect(seen).toEqual([])
    const v = await classifyByState(driverWith(['.plain']), graph, () => { throw new Error('盘满了') })
    expect(v).toEqual({ kind: 'identified', states: ['g/plain'] })
  })
})
