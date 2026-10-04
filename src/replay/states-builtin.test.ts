import { describe, expect, it } from 'vitest'
import { BUILTIN_STATES } from './states-builtin.ts'
import { escapesFrom, validateStateGraph } from './state-graph.ts'
import { identifyWith, type FeatureTest } from './state-perception.ts'

const testerFor = (present: string[]): FeatureTest => {
  const set = new Set(present)
  return async (f) => {
    if (f.kind !== 'dom') throw new Error(`全局图目前只用 dom 特征，撞到了 ${f.kind}`)
    const there = set.has(f.selector)
    return f.absent ? !there : there
  }
}

const positivesOf = (id: string) =>
  BUILTIN_STATES.states
    .find((s) => s.id === id)!
    .features.flatMap((f) => (f.kind === 'dom' && !f.absent ? [f.selector] : []))

describe('内置全局图', () => {
  it('自己要过校验', () => {
    expect(() => validateStateGraph(BUILTIN_STATES)).not.toThrow()
  })

  it('CF 是三档，不是一档', () => {
    const ids = BUILTIN_STATES.states.map((s) => s.id)
    expect(ids).toEqual(expect.arrayContaining(['cf/js-challenge', 'cf/turnstile', 'cf/banned']))
  })

  it('封禁那档是死路，没有出口', () => {
    const banned = BUILTIN_STATES.states.find((s) => s.id === 'cf/banned')!
    expect(banned.deadEnd).toBeTruthy()
    expect(escapesFrom(BUILTIN_STATES, 'cf/banned')).toEqual([])
  })

  it('能等过去的两档各有一个逃生口', () => {
    expect(escapesFrom(BUILTIN_STATES, 'cf/js-challenge')).toHaveLength(1)
    expect(escapesFrom(BUILTIN_STATES, 'cf/turnstile')).toHaveLength(1)
  })

  // Turnstile 那一格有三条实测教训（human-verification.md），逃生口必须条条吃到，
  // 否则它比没有还坏：**在 widget 就绪之前点下去会把它打进失败态，之后重做多少次全废**。
  it('Turnstile 的逃生口：先等、点 CF 自己命名的那个宿主、给偏移不点中心', () => {
    const steps = escapesFrom(BUILTIN_STATES, 'cf/turnstile')[0]!.steps as Array<Record<string, unknown>>
    expect(steps[0]).toMatchObject({ kind: 'wait' }) // 就绪从 DOM 看不出来，只能等
    const click = steps.find((s) => s.kind === 'click')!
    // 站点自己起的容器名（`#cf-turnstile`）换个站就叫别的，不能当靶子
    expect(click.selector).toContain('input[name="cf-turnstile-response"]')
    // widget 300×72，中心落在「请验证您是真人」那行字上——点中心实测 12 秒无反应
    expect(click.position).toEqual({ x: 36, y: 36 })
  })

  // 这四条是这张图最要紧的性质：三档必须**互不同时命中**。撞在一起就永远 ambiguous、
  // 一档都清不掉，而症状是"这个源莫名其妙进冷却"。
  it('只有 JS 挑战的页面上，只认出 js-challenge', async () => {
    const r = await identifyWith(BUILTIN_STATES.states, testerFor(positivesOf('cf/js-challenge')))
    expect(r).toMatchObject({ states: ['cf/js-challenge'] })
  })

  it('Turnstile 页面上，只认出 turnstile', async () => {
    const r = await identifyWith(BUILTIN_STATES.states, testerFor(positivesOf('cf/turnstile')))
    expect(r).toMatchObject({ states: ['cf/turnstile'] })
  })

  it('封禁页面上，只认出 banned', async () => {
    const r = await identifyWith(BUILTIN_STATES.states, testerFor(positivesOf('cf/banned')))
    expect(r).toMatchObject({ states: ['cf/banned'] })
  })

  it('干净页面上一档都不认出', async () => {
    const r = await identifyWith(BUILTIN_STATES.states, testerFor(['.article', '#main']))
    expect(r).toMatchObject({ states: null, reason: 'no-match' })
  })

  // **这条才是 `absent` 守卫存在的理由。** 上面那三条各自只喂了一档自己的选择器，
  // 于是在"根本没有守卫"的实现下也全绿——真实的 Turnstile 页面上，挑战容器和那个
  // 复选控件**多半同时在场**，而那正是两档会一起命中、永远 ambiguous、一档都清不掉
  // 的场景。把守卫去掉，只有这一条会红。
  it('挑战容器和 Turnstile 控件同时在场时，只认出 turnstile——更具体的那档赢', async () => {
    const both = [...positivesOf('cf/js-challenge'), ...positivesOf('cf/turnstile')]
    const r = await identifyWith(BUILTIN_STATES.states, testerFor(both))
    expect(r).toMatchObject({ states: ['cf/turnstile'] })
  })
})
