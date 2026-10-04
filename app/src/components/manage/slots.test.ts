import { describe, it, expect } from 'vitest'
import { nextSlotsFor, SLOT_DEFAULT } from './slots.ts'
import type { ChannelView } from '../../lib/types.ts'

const ch = (slots?: Record<string, string[]>): ChannelView => ({
  id: 'c1', label: '测试频道', kind: 'video', present: 'video', space_id: 'default-space', streams: [],
  options: slots ? { slots } : undefined,
})

describe('nextSlotsFor', () => {
  it('选中一个 provider → 覆盖该 callsite 为单元素数组，不动其他键', () => {
    const next = nextSlotsFor(ch({ 'video.resolve': ['p9'] }), 'search.resources', 'p1')
    expect(next).toEqual({ 'video.resolve': ['p9'], 'search.resources': ['p1'] })
  })
  it('选回默认（SLOT_DEFAULT）→ 删掉该键', () => {
    const next = nextSlotsFor(ch({ 'search.resources': ['p1'] }), 'search.resources', SLOT_DEFAULT)
    expect(next).toEqual({})
  })
  it('无 options 的频道从空对象出发', () => {
    expect(nextSlotsFor(ch(), 'search.resources', 'p1')).toEqual({ 'search.resources': ['p1'] })
  })
})
