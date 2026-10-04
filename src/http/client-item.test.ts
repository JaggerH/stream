import { describe, it, expect, afterEach } from 'vitest'
import { toClientItem, encodeCursor, decodeCursor, isAfterCursor, sortKeyOf, setItemProjectionSource } from './client-item.ts'
import type { ItemOwnerPackage } from '../packages/item-projection.ts'
import type { StoredItem } from '../item-store.ts'

const base = (raw: unknown): StoredItem => ({
  id: 'i1', stream_id: 's1', source_type: 'rsshub-bridge', source_route: '/x',
  fetched_at: '2026-06-08T00:00:00.000Z', timestamp: '2026-06-08T00:00:00.000Z',
  title: 't', type: 'post', raw,
})

describe('toClientItem', () => {
  it('strips raw and keeps every other field', () => {
    const out = toClientItem(base({ huge: 'x'.repeat(1000) }))
    expect('raw' in out).toBe(false)
    expect(out).toMatchObject({ id: 'i1', stream_id: 's1', title: 't', type: 'post', timestamp: '2026-06-08T00:00:00.000Z' })
  })

  it('promotes raw.noteId → note_id (xhs)', () => {
    const out = toClientItem(base({ noteId: 'n123', big: 'blob' }))
    expect(out.note_id).toBe('n123')
    expect('raw' in out).toBe(false)
  })

  it('promotes raw.guid → source_guid (hackernews, both "<id>" and "<id>-<count>")', () => {
    expect(toClientItem(base({ guid: '48517377-163' })).source_guid).toBe('48517377-163')
    expect(toClientItem(base({ guid: '48523992' })).source_guid).toBe('48523992')
  })

  it('omits note_id/source_guid when raw lacks them or values are not strings', () => {
    const noIds = toClientItem(base({ other: 1 }))
    expect('note_id' in noIds).toBe(false)
    expect('source_guid' in noIds).toBe(false)
    const wrongType = toClientItem(base({ noteId: 42, guid: null }))
    expect('note_id' in wrongType).toBe(false)
    expect('source_guid' in wrongType).toBe(false)
    const nonObject = toClientItem(base('a raw string'))
    expect('note_id' in nonObject).toBe(false)
    expect('raw' in nonObject).toBe(false)
  })
})

describe('keyset cursor', () => {
  it('round-trips sortKey|id through opaque base64url, id may contain "|"', () => {
    const cur = encodeCursor('2026-06-08T00:00:00.000Z', 'a|weird|id')
    expect(cur).not.toContain('|')
    expect(decodeCursor(cur)).toEqual({ sortKey: '2026-06-08T00:00:00.000Z', id: 'a|weird|id' })
  })

  it('rejects garbage cursors as null', () => {
    expect(decodeCursor('not-base64-!!')).toBeNull()
    expect(decodeCursor(Buffer.from('no-separator', 'utf8').toString('base64url'))).toBeNull()
  })

  it('sortKeyOf falls back timestamp → fetched_at → empty (mirrors route sort)', () => {
    expect(sortKeyOf({ timestamp: 'T1', fetched_at: 'F1' })).toBe('T1')
    expect(sortKeyOf({ timestamp: '', fetched_at: 'F1' })).toBe('F1')
    expect(sortKeyOf({})).toBe('')
  })

  it('isAfterCursor: strictly older sortKey passes, same key breaks tie on id (desc)', () => {
    const cur = { sortKey: '2026-06-08', id: 'm' }
    expect(isAfterCursor({ sortKey: '2026-06-07', id: 'z' }, cur)).toBe(true)  // older
    expect(isAfterCursor({ sortKey: '2026-06-09', id: 'a' }, cur)).toBe(false) // newer
    expect(isAfterCursor({ sortKey: '2026-06-08', id: 'a' }, cur)).toBe(true)  // tie, id smaller → after
    expect(isAfterCursor({ sortKey: '2026-06-08', id: 'z' }, cur)).toBe(false) // tie, id bigger → before
    expect(isAfterCursor({ sortKey: '2026-06-08', id: 'm' }, cur)).toBe(false) // the cursor item itself
  })
})

describe('toClientItem —— 包声明的条目投影（stream.item）', () => {
  afterEach(() => setItemProjectionSource(null))

  const pkgItem = { ...base({}), source_id: 'demo-home', author: 'A', content: { archetype: 'text', enrich: { source: 'd', params: { postId: 'p1' } } } } as StoredItem

  it('出口现取投影：包声明的动作与源名挂上', () => {
    setItemProjectionSource(() => ({
      packages: [{
        facility: 'demo',
        item: { actions: [{ id: 'like', icon: 'heart', label: '点赞', recipe: '@acme/demo/like', params: { postId: '{content.enrich.params.postId}' }, toggle: ['like', 'unlike'] }] },
      }],
      lookup: (id) => (id === 'demo-home' ? { id: '@acme/demo/demo-home', title: '首页', facility: { key: 'demo', label: '演示' } } : undefined),
    }))
    const out = toClientItem(pkgItem) as ReturnType<typeof toClientItem> & { actions?: unknown[]; source_label?: string }
    expect(out.actions).toEqual([{ id: 'like', icon: 'heart', label: '点赞', recipe: '@acme/demo/like', params: { postId: 'p1' }, toggle: ['like', 'unlike'] }])
    expect(out.source_label).toBe('演示 · 首页')
    expect('raw' in out).toBe(false)
  })

  it('每次序列化都现取（热装的包立刻生效），没接线时原样', () => {
    expect('actions' in toClientItem(pkgItem)).toBe(false)
    let pkgs: ItemOwnerPackage[] = []
    setItemProjectionSource(() => ({ packages: pkgs, lookup: () => ({ id: 'x', facility: { key: 'demo' } }) }))
    expect('actions' in toClientItem(pkgItem)).toBe(false)
    pkgs = [{ facility: 'demo', item: { actions: [{ id: 'a', icon: 'bookmark', label: '收藏', recipe: '@acme/demo/c', params: {}, toggle: ['c', 'u'] }] } }]
    expect('actions' in toClientItem(pkgItem)).toBe(true)
  })
})
