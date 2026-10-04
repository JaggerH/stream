import { describe, it, expect } from 'vitest'
import { orphanedStreams, attachCandidates, manageableChannelId } from './manage-helpers.ts'
import type { ChannelView } from '../../lib/types.ts'

const st = (id: string) => ({ id, description: id, sources: [], cadence_seconds: 3600, vault_subdir: '' })
const ch = (id: string, streamIds: string[]): ChannelView => ({
  id, label: id, kind: 'timeline', present: 'timeline', space_id: 'default-space', streams: streamIds.map(st),
})

describe('orphanedStreams', () => {
  it('只被本频道引用的流会孤儿化；别的频道还引用的不算', () => {
    const a = ch('a', ['s1', 's2'])
    const b = ch('b', ['s2'])
    expect(orphanedStreams(a, [a, b]).map((s) => s.id)).toEqual(['s1'])
  })
})

describe('attachCandidates', () => {
  it('列出不在本频道的流，并标注引用它的频道名', () => {
    const a = ch('a', ['s1'])
    const b = ch('b', ['s2'])
    const all = [st('s1'), st('s2'), st('s3')]
    expect(attachCandidates(a, all as any, [a, b])).toEqual([
      { stream: st('s2'), referencedBy: ['b'] },
      { stream: st('s3'), referencedBy: [] },
    ])
  })
})

describe('manageableChannelId', () => {
  const VIRTUAL = ['__discover__', '__ads__', '__content_search__']
  it('未选中（全部时间线）→ 系统 default-timeline', () => {
    expect(manageableChannelId(null, null, VIRTUAL)).toBe('default-timeline')
  })
  it('选中真实频道 → 该频道 id', () => {
    expect(manageableChannelId('c1', { id: 'c1' }, VIRTUAL)).toBe('c1')
  })
  it('虚拟频道（发现/广告/搜索）→ null（没有可管的频道记录）', () => {
    expect(manageableChannelId('__ads__', null, VIRTUAL)).toBeNull()
  })
  it('选中的是裸 stream（非频道）→ null', () => {
    expect(manageableChannelId('some-stream', null, VIRTUAL)).toBeNull()
  })
})
