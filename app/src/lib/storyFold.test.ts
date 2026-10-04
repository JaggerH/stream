import { describe, it, expect } from 'vitest'
import { foldFeed, toggleExpanded, foldedLabel, leadLabel } from './storyFold.ts'
import type { Item } from './types.ts'

const it_ = (id: string, group?: { id: string; isRep: boolean; size: number }): Item =>
  ({
    id, stream_id: 's', type: 'post', title: id, timestamp: '2026-08-13T00:00:00Z',
    fetched_at: '2026-08-13T00:00:00Z',
    storyGroup: group ? { ...group, why: [] } : undefined,
  }) as Item

const g = (id: string, isRep: boolean) => ({ id, isRep, size: 2 })

describe('foldFeed', () => {
  it('同一堆只占一行，成员收起来并报出数目', () => {
    const { rendered, hidden } = foldFeed(
      [it_('rep', g('rep', true)), it_('m1', g('rep', false)), it_('m2', g('rep', false)), it_('solo')],
      new Set(),
    )
    expect(rendered.map((x) => x.id)).toEqual(['rep', 'solo'])
    expect(hidden.get('rep')).toBe(2)
  })

  it('展开之后成员就地出现，顺序不变', () => {
    const { rendered } = foldFeed(
      [it_('rep', g('rep', true)), it_('m1', g('rep', false)), it_('solo')],
      new Set(['rep']),
    )
    expect(rendered.map((x) => x.id)).toEqual(['rep', 'm1', 'solo'])
  })

  it('**代表不在这一页时成员照常显示**——否则这条内容凭空消失且没有入口找回', () => {
    const { rendered, hidden } = foldFeed([it_('m1', g('rep-off-page', false)), it_('solo')], new Set())
    expect(rendered.map((x) => x.id)).toEqual(['m1', 'solo'])
    expect(hidden.size).toBe(0)
  })

  it('没有归堆信息的列表原样返回', () => {
    const items = [it_('a'), it_('b')]
    expect(foldFeed(items, new Set()).rendered).toEqual(items)
  })

  it('两个堆各折各的', () => {
    const { hidden } = foldFeed(
      [it_('r1', g('r1', true)), it_('a', g('r1', false)), it_('r2', g('r2', true)), it_('b', g('r2', false))],
      new Set(),
    )
    expect([...hidden.entries()].sort()).toEqual([['r1', 1], ['r2', 1]])
  })
})

describe('leadLabel —— 门面这条早发了多久', () => {
  const at = (id: string, ts: string, group?: { id: string; isRep: boolean }): Item =>
    ({ ...it_(id, group && { ...group, size: 2 }), timestamp: ts }) as Item

  it('按最近的那个对手算领先多久', () => {
    const rep = at('rep', '2026-08-13T08:00:00Z')
    const members = [at('m1', '2026-08-13T09:00:00Z'), at('m2', '2026-08-13T12:00:00Z')]
    expect(leadLabel(rep, members)).toBe('首发，早 1 小时')
  })

  it('分钟 / 小时 / 天 各说各的话', () => {
    const rep = at('rep', '2026-08-13T08:00:00Z')
    expect(leadLabel(rep, [at('m', '2026-08-13T08:10:00Z')])).toBe('首发，早 10 分钟')
    expect(leadLabel(rep, [at('m', '2026-08-15T08:00:00Z')])).toBe('首发，早 2 天')
  })

  it('**领先不到一分钟不标**——那个数字对人没有意义，只让这行变吵', () => {
    const rep = at('rep', '2026-08-13T08:00:00Z')
    expect(leadLabel(rep, [at('m', '2026-08-13T08:00:30Z')])).toBeNull()
  })

  it('同一时刻发的不标（判谁快是编造精度），没有成员也不标', () => {
    const rep = at('rep', '2026-08-13T08:00:00Z')
    expect(leadLabel(rep, [at('m', '2026-08-13T08:00:00Z')])).toBeNull()
    expect(leadLabel(rep, [])).toBeNull()
  })
})

describe('toggleExpanded / foldedLabel', () => {
  it('开了再点就是关', () => {
    const once = toggleExpanded(new Set(), 'g')
    expect(once.has('g')).toBe(true)
    expect(toggleExpanded(once, 'g').has('g')).toBe(false)
  })

  it('收起来的数目要说出口', () => {
    expect(foldedLabel(3, false)).toBe('另有 3 条同源')
    expect(foldedLabel(3, true)).toBe('收起同源的')
  })
})
