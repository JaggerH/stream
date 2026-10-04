import { describe, expect, it } from 'vitest'
import { identifyWith, type FeatureTest } from './state-perception.ts'
import type { StateDef } from './state-graph.ts'

const dom = (selector: string) => ({ kind: 'dom', selector }) as const

const states: StateDef[] = [
  { id: 'feed', features: [dom('.feed')] },
  { id: 'wall', features: [dom('.login')] },
  { id: 'both', features: [dom('.feed'), dom('.login')] },
]

const testerFor = (present: string[]): FeatureTest => {
  const set = new Set(present)
  return async (f) => {
    if (f.kind !== 'dom') throw new Error(`这条路线判不了 ${f.kind} 特征`)
    return set.has(f.selector)
  }
}

describe('identifyWith', () => {
  it('恰好一个命中就认出来，并带回凭哪条特征判的', async () => {
    const r = await identifyWith(states, testerFor(['.feed']))
    expect(r).toEqual({ states: ['feed'], matched: [dom('.feed')] })
  })

  it('一个都不命中是 no-match', async () => {
    const r = await identifyWith(states, testerFor([]))
    expect(r).toEqual({ states: null, reason: 'no-match', candidates: [] })
  })

  it('多个命中必须报 ambiguous，绝不挑一个返回', async () => {
    const r = await identifyWith(states, testerFor(['.feed', '.login']))
    expect(r).toEqual({
      states: null,
      reason: 'ambiguous',
      candidates: ['feed', 'wall', 'both'],
    })
  })

  it('判不了的特征让整条 identify 抛错，而不是静默当成不匹配', async () => {
    const withA11y: StateDef[] = [{ id: 'x', features: [{ kind: 'a11y', query: { role: 'Button' } }] }]
    await expect(identifyWith(withA11y, testerFor([]))).rejects.toThrow(/判不了/)
  })

  it('一条特征为假就短路，不再问后面的', async () => {
    const asked: string[] = []
    const spy: FeatureTest = async (f) => {
      if (f.kind !== 'dom') throw new Error('unreachable')
      asked.push(f.selector)
      return false
    }
    await identifyWith([{ id: 'x', features: [dom('.a'), dom('.b')] }], spy)
    expect(asked).toEqual(['.a'])
  })
})
