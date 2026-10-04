import { describe, it, expect } from 'vitest'
import { serializeBundle, deserializeBundle, STREAM_BUNDLE_FORMAT, type StreamBundleV1 } from './bundle-format.ts'

const b: StreamBundleV1 = {
  format: STREAM_BUNDLE_FORMAT,
  meta: { title: 'T', created: '2026-07-18', revision: '1.2.0' },
  channels: [{ id: 'c1', label: 'C', present: 'timeline', stream_ids: ['s1'], options: {} }],
  streams: [{ id: 's1', label: 'S', strategy: 'fanout', cadence_seconds: 3600, members: [{ plugin: 'rsshub', source: 'x', params: {} }], options: {} }],
  providers: [],
  requires: { plugins: [], recipes: [], credentials: [], runtimeConfig: [] },
  embedded: { recipes: {} },
}

describe('round-trip', () => {
  it('serialize → deserialize 等价', () => {
    const r = deserializeBundle(serializeBundle(b))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.bundle).toEqual(b)
  })
  it('坏 JSON 文本返回 ok:false 不抛', () => {
    expect(deserializeBundle('{not json').ok).toBe(false)
  })
})
