import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ItemStore } from '../item-store.ts'
import { Registry } from '../registry/registry.ts'
import type { SourceManifest } from '../manifest/types.ts'
import type { StreamItem } from '../types.ts'
import { renormalizeStoredItems, RenormalizeNotFoundError } from './renormalize.ts'

function mk(partial: Partial<SourceManifest> & { id: string }): SourceManifest {
  return {
    schema_version: 1, adapter: 'fake', type: 'post', description: partial.id,
    topics: [], example_queries: [], capabilities: ['timeline'], auth: { type: 'none' },
    params_schema: {}, cadence_hint_seconds: 1800, discoverable: true, ...partial,
  }
}

function item(id: string, stream: string, extra: Partial<StreamItem> = {}): StreamItem {
  return {
    id, stream_id: stream, source_type: 'rsshub-bridge', source_route: '/x',
    fetched_at: '2026-07-23T00:00:00.000Z', timestamp: '2026-07-23T00:00:00.000Z',
    title: id, raw: { title: id, description: `<p>body of ${id}</p>` }, ...extra,
  }
}

describe('renormalizeStoredItems', () => {
  let dir: string
  let store: ItemStore
  // 'hn' resolves; 'gone' is deliberately NOT in the registry
  const registry = new Registry([mk({ id: 'hn' })])

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'renorm-'))
    store = new ItemStore(join(dir, 'i.db'))
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rewrites content from raw via the current manifest, scoped to a stream', () => {
    store.add(item('a1', 's1', { source_id: 'hn', content: { archetype: 'text', title: 'stale' } }), 'post')
    store.add(item('b1', 's2', { source_id: 'hn', content: { archetype: 'text', title: 'stale' } }), 'post')
    const res = renormalizeStoredItems(store, registry, { streamId: 's1' })
    expect(res).toEqual({ scanned: 1, updated: 1, skipped: { noSourceId: 0, manifestGone: 0, parseError: 0 } })
    expect(store.get('a1')!.content!.title).toBe('a1')       // recomputed from raw
    expect(store.get('b1')!.content!.title).toBe('stale')    // out of scope, untouched
  })

  it('is idempotent: a second run rewrites nothing', () => {
    store.add(item('a1', 's1', { source_id: 'hn' }), 'post')
    renormalizeStoredItems(store, registry, {})
    const second = renormalizeStoredItems(store, registry, {})
    expect(second.updated).toBe(0)
    expect(second.scanned).toBe(1)
  })

  it('scopes by sourceId across streams and skips noSourceId/manifestGone rows', () => {
    store.add(item('a1', 's1', { source_id: 'hn' }), 'post')
    store.add(item('a2', 's2', { source_id: 'hn' }), 'post')
    store.add(item('a3', 's1', { source_id: 'gone' }), 'post')
    store.add(item('a4', 's1', {}), 'post') // no source_id (pre-field legacy row)
    const bySource = renormalizeStoredItems(store, registry, { sourceId: 'hn' })
    expect(bySource.scanned).toBe(2)
    expect(bySource.updated).toBe(2)
    const all = renormalizeStoredItems(store, registry, {})
    expect(all.scanned).toBe(4)
    expect(all.skipped).toEqual({ noSourceId: 1, manifestGone: 1, parseError: 0 })
  })

  it('only touches content — sibling fields and untouched rows survive byte-identical', () => {
    store.add(item('a1', 's1', { source_id: 'hn', muted: { reason: 'ad', rule: 'kw' } }), 'post')
    renormalizeStoredItems(store, registry, {})
    const after = store.get('a1')!
    expect(after.muted).toEqual({ reason: 'ad', rule: 'kw' })
    expect(after.title).toBe('a1')
    expect(after.fetched_at).toBe('2026-07-23T00:00:00.000Z')
  })

  it('404-throws on unknown streamId (no stored rows) and unknown sourceId (no manifest)', () => {
    store.add(item('a1', 's1', { source_id: 'hn' }), 'post')
    expect(() => renormalizeStoredItems(store, registry, { streamId: 'nope' }))
      .toThrow(RenormalizeNotFoundError)
    expect(() => renormalizeStoredItems(store, registry, { sourceId: 'nope' }))
      .toThrow(RenormalizeNotFoundError)
    // manifest 在但该源 0 行:不是 404,是空扫
    expect(renormalizeStoredItems(store, registry, { sourceId: 'hn' }).scanned).toBe(1)
  })
})
