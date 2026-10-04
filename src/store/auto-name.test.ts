import { describe, it, expect } from 'vitest'
import { backfillLabel, inferFeedTitle } from './auto-name.ts'
import type { StreamRecord } from './types.ts'

const base: StreamRecord = {
  id: 's1', label: 'rsshub:weibo/user', strategy: 'fanout', cadence_seconds: 1800,
  members: [], options: { vault_subdir: 's1', labelAuto: true },
}

describe('backfillLabel', () => {
  it('sets the label from the feed title and clears labelAuto when auto is set', () => {
    const next = backfillLabel(base, '张三的微博')
    expect(next).toEqual({ label: '张三的微博', options: { vault_subdir: 's1' } })
  })
  it('preserves a user rename (labelAuto absent) → no-op', () => {
    const renamed: StreamRecord = { ...base, label: 'My feed', options: { vault_subdir: 's1' } }
    expect(backfillLabel(renamed, '张三的微博')).toBeNull()
  })
  it('ignores an empty/whitespace title', () => {
    expect(backfillLabel(base, '   ')).toBeNull()
  })
})

describe('inferFeedTitle', () => {
  it('uses the author when the whole batch shares one', () => {
    expect(inferFeedTitle([
      { author: '不明白播客', title: 'ep1' },
      { author: '不明白播客', title: 'ep2' },
      { author: '不明白播客', title: 'ep3' },
    ])).toBe('不明白播客')
  })
  it('trims and tolerates surrounding whitespace', () => {
    expect(inferFeedTitle([{ author: ' 雪球 ' }, { author: '雪球' }])).toBe('雪球')
  })
  // 首页 feed / 搜索结果：作者人各不同。这条流不该叫某个作者的名字——占位名比错名字好。
  it('declines a mixed-author batch', () => {
    expect(inferFeedTitle([{ author: 'a' }, { author: 'b' }, { author: 'a' }])).toBeUndefined()
  })
  // 单条一致是废话：搜索源恰好只返回一条时会被它误命名。
  it('declines a single-item batch', () => {
    expect(inferFeedTitle([{ author: '张三' }])).toBeUndefined()
  })
  it('declines when any item has no author', () => {
    expect(inferFeedTitle([{ author: '张三' }, { title: 'no author' }, { author: '张三' }])).toBeUndefined()
    expect(inferFeedTitle([{ author: '张三' }, { author: '  ' }])).toBeUndefined()
  })
  it('declines an empty batch and non-object rows', () => {
    expect(inferFeedTitle([])).toBeUndefined()
    expect(inferFeedTitle([null, 'x'])).toBeUndefined()
  })
  it('ignores a non-string author (some adapters emit an object)', () => {
    expect(inferFeedTitle([{ author: { name: '张三' } }, { author: { name: '张三' } }])).toBeUndefined()
  })
})
