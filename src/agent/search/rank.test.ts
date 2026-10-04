// src/agent/search/rank.test.ts
import { describe, it, expect } from 'vitest'
import { rankTargets } from './rank.ts'
import type { ScoredHit } from './types.ts'

const h = (over: Partial<ScoredHit>): ScoredHit => ({
  link: 'l', netdisk: 'baidu', sourceId: 'pansou', topicality: 1, ...over,
})

describe('rankTargets', () => {
  it('puts quark ahead of other netdisks regardless of score', () => {
    const out = rankTargets([
      h({ link: 'a', netdisk: 'baidu', topicality: 3 }),
      h({ link: 'b', netdisk: 'quark', topicality: 1 }),
    ])
    expect(out.map((x) => x.link)).toEqual(['b', 'a'])
  })

  it('within the same netdisk, higher topicality first', () => {
    const out = rankTargets([
      h({ link: 'a', netdisk: 'quark', topicality: 1 }),
      h({ link: 'b', netdisk: 'quark', topicality: 3 }),
    ])
    expect(out.map((x) => x.link)).toEqual(['b', 'a'])
  })

  it('dedupes by link, keeping the higher score', () => {
    const out = rankTargets([
      h({ link: 'dup', netdisk: 'quark', topicality: 1 }),
      h({ link: 'dup', netdisk: 'quark', topicality: 3 }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].topicality).toBe(3)
  })
})
