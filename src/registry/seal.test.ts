import { describe, it, expect } from 'vitest'
import { sealManifests, pluginIdForDescriptor } from './seal.ts'
import type { SourceManifest } from '../manifest/types.ts'
import type { PluginDescriptor } from '../plugins/types.ts'

function mk(over: Partial<SourceManifest>): SourceManifest {
  return {
    schema_version: 1, id: 'x', adapter: 'fake', type: 'post', description: 'x',
    topics: [], example_queries: [], capabilities: ['timeline'],
    auth: { type: 'none' }, params_schema: {}, cadence_hint_seconds: 1800, discoverable: true,
    ...over,
  }
}

const DESCRIPTORS: PluginDescriptor[] = [
  { id: 'rsshub', name: 'RSSHub' },
  { id: 'pansou', name: '盘搜', backend: { image: 'x', port: 80, service: 'pansou' } },
]

describe('sealManifests', () => {
  it('fills pluginId from explicit pluginId, else adapter, else custom', () => {
    const [a, b, c] = sealManifests(
      [mk({ id: 'a', pluginId: 'xhs' }), mk({ id: 'b', adapter: 'rsshub' }), mk({ id: 'c', adapter: '' })],
      DESCRIPTORS
    )
    expect(a.pluginId).toBe('xhs')
    expect(b.pluginId).toBe('rsshub')
    expect(c.pluginId).toBe('custom')
  })

  it('pluginId 是空串 = 没填 → 落到 adapter，不让空串当 id', () => {
    const [m] = sealManifests([mk({ id: 'a', pluginId: '', adapter: 'rsshub' })], DESCRIPTORS)
    expect(m.pluginId).toBe('rsshub')
  })

  it('keeps the adapter name as pluginId verbatim — the host maintains no alias table', () => {
    for (const adapter of ['pansou', 'xhs', 'bilibili']) {
      const [m] = sealManifests([mk({ adapter })], DESCRIPTORS)
      expect(m.pluginId).toBe(adapter)
    }
  })

  it('fills pluginName from descriptor name; falls back to pluginId when no descriptor', () => {
    const [a, b, c] = sealManifests(
      [mk({ id: 'a', adapter: 'rsshub' }), mk({ id: 'b', adapter: 'pansou' }), mk({ id: 'c', adapter: 'nobody' })],
      DESCRIPTORS
    )
    expect(a.pluginName).toBe('RSSHub')
    expect(b.pluginName).toBe('盘搜') // descriptor matched by its own id, nothing else
    expect(c.pluginName).toBe('nobody')
  })

  it('fills title: explicit wins; else last "—"-separated segment of description; else id', () => {
    const [a, b, c] = sealManifests(
      [
        mk({ id: 'a', title: '我的收藏', description: 'ignored' }),
        mk({ id: 'b', description: '哔哩哔哩 — UP 主投稿' }),
        mk({ id: 'c', description: '' }),
      ],
      DESCRIPTORS
    )
    expect(a.title).toBe('我的收藏')
    expect(b.title).toBe('UP 主投稿')
    expect(c.title).toBe('c')
  })

  it('throws loudly when a cookie manifest reaches seal without an inject', () => {
    const bad = mk({ id: 'bad', auth: { type: 'cookie', domain: 'xueqiu.com' } as never })
    expect(() => sealManifests([bad], DESCRIPTORS)).toThrow(/inject/)
  })

  it('passes a cookie manifest that declares its inject', () => {
    const ok = mk({ id: 'ok', auth: { type: 'cookie', domain: 'xueqiu.com', inject: { kind: 'env', name: 'XUEQIU_COOKIES' } } })
    expect(() => sealManifests([ok], DESCRIPTORS)).not.toThrow()
  })

  it('is idempotent and does not mutate input', () => {
    const src = [mk({ id: 'a', adapter: 'rsshub' })]
    const once = sealManifests(src, DESCRIPTORS)
    const twice = sealManifests(once, DESCRIPTORS)
    expect(twice).toEqual(once)
    expect(src[0].pluginName).toBeUndefined()
  })
})

describe('pluginIdForDescriptor', () => {
  it('returns the descriptor id verbatim; a backend service name never rewrites it', () => {
    expect(pluginIdForDescriptor({ id: 'rsshub' })).toBe('rsshub')
    expect(pluginIdForDescriptor({ id: 'pansou', backend: { image: 'x', port: 80, service: 'pansou-svc' } })).toBe('pansou')
  })
})
