import { describe, it, expect } from 'vitest'
import { LexicalSearch } from './search.ts'
import type { SourceManifest } from '../manifest/types.ts'

function mk(partial: Partial<SourceManifest> & { id: string }): SourceManifest {
  return {
    schema_version: 1,
    adapter: 'rsshub',
    type: 'post',
    description: '',
    topics: [],
    example_queries: [],
    capabilities: ['timeline'],
    auth: { type: 'none' },
    params_schema: {},
    cadence_hint_seconds: 1800,
    discoverable: true,
    ...partial,
  }
}

const manifests: SourceManifest[] = [
  mk({
    id: 'xhs-fav',
    description: '小红书收藏夹笔记',
    topics: ['护肤', '美妆', '收藏'],
    example_queries: ['我收藏的护肤帖'],
  }),
  mk({ id: 'hn-best', description: 'Hacker News top tech stories', topics: ['tech'] }),
  mk({
    id: 'rsshub-raw',
    description: 'raw passthrough',
    topics: ['护肤'],
    discoverable: false,
  }),
]

describe('LexicalSearch', () => {
  it('ranks by term frequency, CJK substring match', () => {
    const ranked = new LexicalSearch().rank('护肤 美妆', manifests, 5)
    expect(ranked[0].manifest.id).toBe('xhs-fav')
    expect(ranked[0].score).toBeGreaterThan(0)
  })

  it('excludes non-discoverable sources even when they match', () => {
    const ranked = new LexicalSearch().rank('护肤', manifests, 5)
    expect(ranked.find((r) => r.manifest.id === 'rsshub-raw')).toBeUndefined()
  })

  it('returns empty on no match', () => {
    expect(new LexicalSearch().rank('量子物理', manifests, 5)).toEqual([])
  })

  it('returns empty on empty query', () => {
    expect(new LexicalSearch().rank('   ', manifests, 5)).toEqual([])
  })
})
