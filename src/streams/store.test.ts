import { describe, it, expect } from 'vitest'
import { parseSourceId, canonicalSourceId, normalizeSource } from './store.ts'
import { Registry } from '../registry/registry.ts'
import type { SourceManifest } from '../manifest/types.ts'

function mk(partial: Partial<SourceManifest> & { id: string }): SourceManifest {
  return {
    schema_version: 1,
    adapter: 'fake',
    type: 'post',
    description: partial.id,
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

describe('source id helpers', () => {
  it('parseSourceId splits plugin:template and defaults bare ids to custom', () => {
    expect(parseSourceId('rsshub:hn-best')).toEqual({ plugin_id: 'rsshub', source_template_id: 'hn-best' })
    expect(parseSourceId('hn-best')).toEqual({ plugin_id: 'custom', source_template_id: 'hn-best' })
  })

  it('canonicalSourceId round-trips with parseSourceId; custom stays bare', () => {
    expect(canonicalSourceId('rsshub', 'hn-best')).toBe('rsshub:hn-best')
    expect(canonicalSourceId('custom', 'hn-best')).toBe('hn-best')
    expect(canonicalSourceId('', 'hn-best')).toBe('hn-best')
  })
})

describe('normalizeSource', () => {
  const registry = new Registry([mk({ id: 'hn-best', pluginId: 'rsshub' })])

  it('resolves a bare source_id to its plugin via the registry', () => {
    expect(normalizeSource({ source_id: 'hn-best' }, registry)).toEqual({
      plugin_id: 'rsshub',
      source_template_id: 'hn-best',
      params: {},
    })
  })

  it('falls back to parseSourceId when the registry misses', () => {
    expect(normalizeSource({ source_id: 'douyin:feed', params: { mode: 'feed' } }, registry)).toEqual({
      plugin_id: 'douyin',
      source_template_id: 'feed',
      params: { mode: 'feed' },
    })
  })

  it('keeps explicit plugin_id + source_template_id members intact', () => {
    expect(normalizeSource({ plugin_id: 'bilibili', source_template_id: 'dynamic', params: { uid: '1' } })).toEqual({
      plugin_id: 'bilibili',
      source_template_id: 'dynamic',
      params: { uid: '1' },
    })
  })
})
