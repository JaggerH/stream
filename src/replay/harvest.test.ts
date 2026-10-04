import { describe, it, expect } from 'vitest'
import { HarvestAccumulator, urlMatches } from './harvest.ts'
import type { Harvest } from './recipe.ts'

const H: Harvest = {
  urlPattern: '*/recommend_all_feed*', dedupeBy: 'article_id', itemsAt: 'data',
  targetCount: 3, mapping: { title: 'info.title', link: 'info.url' },
  assert: [{ path: 'data', desc: 'feed list present' }],
}

describe('urlMatches', () => {
  it('globs on *', () => {
    expect(urlMatches('*/recommend_all_feed*', 'https://api.x.com/recommend_all_feed?a=1')).toBe(true)
    expect(urlMatches('*/recommend_all_feed*', 'https://api.x.com/other')).toBe(false)
  })
})

describe('HarvestAccumulator', () => {
  const body = (ids: string[]) => ({ data: ids.map((id) => ({ article_id: id, info: { title: 't' + id, url: 'u' + id } })) })

  it('dedupes and stops at targetCount', () => {
    const a = new HarvestAccumulator(H)
    expect(a.offer(body(['1', '2'])).fresh).toBe(2)
    expect(a.offer(body(['2', '3'])).fresh).toBe(1) // 2 is dup
    expect(a.size).toBe(3)
    expect(a.done).toBe(true)
    expect(a.items().map((i) => i.title)).toEqual(['t1', 't2', 't3'])
  })

  it('drops a malformed item (missing dedupeBy) without counting, not drift', () => {
    const a = new HarvestAccumulator(H)
    a.offer({ data: [{ info: { title: 'x' } }] }) // no article_id
    expect(a.size).toBe(0)
    expect(a.driftReason()).toBeNull()
  })

  it('flags drift when the matched responses are mostly malformed', () => {
    const a = new HarvestAccumulator({ ...H, targetCount: 100 })
    for (let i = 0; i < 5; i++) a.offer({ oops: 'login wall' }) // assert 'data' missing → malformed
    expect(a.malformedRatio).toBeGreaterThan(0.8)
    expect(a.driftReason()).toMatch(/malformed/i)
  })

  it('does not count responses towards drift check unless matchedResponses > 0 and malformedRatio > 0.8', () => {
    const a = new HarvestAccumulator({ ...H, targetCount: 100 })
    expect(a.driftReason()).toBeNull()
  })

  it('counts a non-array itemsAt as malformed even when assert passes (relocated list = drift)', () => {
    const a = new HarvestAccumulator({ ...H, targetCount: 100 })
    for (let i = 0; i < 5; i++) a.offer({ data: 'not-an-array' }) // assert 'data' present, but no list
    expect(a.malformedRatio).toBeGreaterThan(0.8)
    expect(a.driftReason()).toMatch(/malformed/i)
  })
})
