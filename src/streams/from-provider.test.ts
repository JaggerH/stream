import { describe, it, expect } from 'vitest'
import { makeStreamFromProviderLadder, type LadderSnapshotDeps } from './from-provider.ts'
import type { ProviderRecord } from '../store/types.ts'

const row: ProviderRecord = {
  id: 'podcast-feed',
  label: '播客订阅',
  description: '',
  category: 'resolve',
  serves: ['podcast'],
  strategy: 'sequential',
  members: [{ mode: 'auto', matches: 'lizhi.fm/user/:id', params: { id: '$input' } }],
  options: {},
}

/** 可变的展开结果，模拟 executor.resolvedMembers（行演化 = 改这个数组）。 */
function makeDeps(expanded: Array<{ name: string; params?: Record<string, unknown> }>): LadderSnapshotDeps {
  return {
    getProvider: (id) => (id === row.id ? row : null),
    resolvedMembers: () => expanded,
  }
}

describe('makeStreamFromProviderLadder', () => {
  it('snapshots the expanded ladder with $input holes filled by the key', () => {
    const deps = makeDeps([
      { name: 'rsshub:lizhi/user/:id', params: { id: '$input' } },
      { name: 'rsshub:xiaoyuzhou/podcast/:id', params: { id: '$input' } },
    ])
    const rec = makeStreamFromProviderLadder(deps, 'podcast-feed', '251381', 3600, {
      harvest: { backfillLimit: 1000, incrementalLimit: 50 },
    })
    expect(rec.strategy).toBe('exclusive')
    expect(rec.cadence_seconds).toBe(3600)
    expect(rec.members).toEqual([
      { plugin: 'rsshub', source: 'lizhi/user/:id', params: { id: '251381' } },
      { plugin: 'rsshub', source: 'xiaoyuzhou/podcast/:id', params: { id: '251381' } },
    ])
    expect(rec.options).toEqual({ harvest: { backfillLimit: 1000, incrementalLimit: 50 } })
  })

  it('is a creation-time snapshot — later row changes do not mutate the produced Stream', () => {
    const expanded = [{ name: 'rsshub:lizhi/user/:id', params: { id: '$input' } }]
    const deps = makeDeps(expanded)
    const rec = makeStreamFromProviderLadder(deps, 'podcast-feed', '251381', 3600)
    // the row gains a member afterwards
    expanded.push({ name: 'rsshub:new/source/:id', params: { id: '$input' } })
    expect(rec.members).toHaveLength(1)
    expect(rec.members[0].source).toBe('lizhi/user/:id')
  })
})
