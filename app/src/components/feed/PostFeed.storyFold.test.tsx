// 同质内容归堆在列表里的形态。钉的是两件事，都是"信息别无声消失"的具体化：
// 折起来必须**说出还有几条**，展开必须**真的能拿回来**。
import { describe, it, expect } from 'vitest'
import type { ReactElement } from 'react'
import { render as rtlRender, screen, fireEvent } from '@testing-library/react'
import { PostFeed } from './PostFeed.tsx'
import type { Item } from '../../lib/types.ts'

const render = (ui: ReactElement) => rtlRender(ui)

const mk = (id: string, title: string, group?: { id: string; isRep: boolean }, ts = '2026-08-13T00:00:00.000Z'): Item =>
  ({
    id, stream_id: 's1', type: 'post', title,
    timestamp: ts, fetched_at: ts,
    storyGroup: group ? { ...group, size: 2, why: [{ kind: 'text-identity', score: 0.9, detail: '正文几乎一样（0.90）' }] } : undefined,
  }) as Item

const folded = [
  mk('rep', '谁在操纵舆情', { id: 'rep', isRep: true }),
  mk('m1', '谁在操纵舆情｜B站版', { id: 'rep', isRep: false }),
  mk('solo', '不相干的另一条'),
]

const feed = (items: Item[], layout: 'list' | 'waterfall' = 'list') =>
  render(<PostFeed items={items} layout={layout} channelId="default-timeline" onOpen={() => {}} />)

describe.each(['list', 'waterfall'] as const)('PostFeed 同源折叠（%s）', (layout) => {
  it('同一堆只占一行，并把收起来的条数说出口', () => {
    feed(folded, layout)
    expect(screen.getByText('谁在操纵舆情')).toBeTruthy()
    expect(screen.queryByText('谁在操纵舆情｜B站版')).toBeNull()
    expect(screen.getByText('另有 1 条同源')).toBeTruthy()
    expect(screen.getByText('不相干的另一条')).toBeTruthy() // 别的条目不受影响
  })

  it('点一下就拿得回来，再点收起', () => {
    feed(folded, layout)
    fireEvent.click(screen.getByText('另有 1 条同源'))
    expect(screen.getByText('谁在操纵舆情｜B站版')).toBeTruthy()
    fireEvent.click(screen.getByText('收起同源的'))
    expect(screen.queryByText('谁在操纵舆情｜B站版')).toBeNull()
  })

  it('**代表不在这一页时成员照常显示**，也不出折叠条', () => {
    feed([mk('m1', '孤儿成员', { id: 'rep-off-page', isRep: false })], layout)
    expect(screen.getByText('孤儿成员')).toBeTruthy()
    expect(screen.queryByText(/另有/)).toBeNull()
  })

  it('门面这条标出「首发早多久」——这是来源在归堆之后唯一的用处', () => {
    feed([
      mk('rep', '同一条内容', { id: 'rep', isRep: true }, '2026-08-13T08:00:00.000Z'),
      mk('m1', '同一条内容（转载）', { id: 'rep', isRep: false }, '2026-08-13T10:00:00.000Z'),
    ], layout)
    expect(screen.getByText('首发，早 2 小时')).toBeTruthy()
  })

  it('同一时刻发的不标首发（判谁快是编造精度）', () => {
    feed(folded, layout) // 两条时间戳相同
    expect(screen.queryByText(/首发/)).toBeNull()
  })

  it('没有归堆信息时和以前一模一样', () => {
    feed([mk('a', '甲'), mk('b', '乙')], layout)
    expect(screen.getByText('甲')).toBeTruthy()
    expect(screen.getByText('乙')).toBeTruthy()
    expect(screen.queryByText(/另有/)).toBeNull()
  })
})
