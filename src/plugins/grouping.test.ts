import { describe, expect, it } from 'vitest'
import type { SourceManifest } from '../manifest/types.ts'
import type { PluginDescriptor } from './types.ts'
import { buildSourceGroups, pluginGroupingMetadata, resolveSourceGroup, validatePluginGrouping } from './grouping.ts'

function source(partial: Partial<SourceManifest> & { id: string; adapter: string }): SourceManifest {
  return {
    schema_version: 1,
    type: 'post',
    description: partial.id,
    topics: [],
    example_queries: [],
    categories: [],
    capabilities: ['timeline'],
    auth: { type: 'none' },
    params_schema: {},
    cadence_hint_seconds: 1800,
    discoverable: true,
    ...partial,
  }
}

describe('plugin source grouping', () => {
  it('uses manifest.facility as the generic built-in resolver', () => {
    const plugin: PluginDescriptor = {
      id: 'generic',
      sourceGrouping: { enabled: true, resolver: 'manifest.facility' },
    }
    const group = resolveSourceGroup(source({
      id: 'a',
      adapter: 'fake',
      facility: { key: 'alpha', label: 'Alpha' },
    }), plugin)

    expect(group).toEqual({ key: 'alpha', label: 'Alpha' })
    expect(buildSourceGroups(plugin, [
      source({ id: 'a', adapter: 'fake', facility: { key: 'alpha', label: 'Alpha' } }),
      source({ id: 'b', adapter: 'fake' }),
    ])).toEqual([
      { key: '', label: '未分类', count: 1 },
      { key: 'alpha', label: 'Alpha', count: 1 },
    ])
  })

  it('resolves RSSHub groups through adapter.groupByNamespace', () => {
    const plugin: PluginDescriptor = {
      id: 'rsshub',
      sourceGrouping: { enabled: true, resolver: 'adapter.groupByNamespace' },
    }

    expect(resolveSourceGroup(source({
      id: 'rsshub:xiaohongshu/user/:id/notes',
      adapter: 'rsshub',
    }), plugin)).toEqual({ key: 'xiaohongshu', label: 'xiaohongshu' })

    expect(resolveSourceGroup(source({
      id: 'manual-bili',
      adapter: 'rsshub',
      facility: { key: 'bilibili', label: '哔哩哔哩' },
    }), plugin)).toEqual({ key: 'bilibili', label: '哔哩哔哩' })
  })

  it('resolves Douyin bundle groups through manifest.facility, not id prefix', () => {
    const plugin: PluginDescriptor = {
      id: 'Douyin_TikTok_Download_API',
      sourceGrouping: { enabled: true, resolver: 'manifest.facility' },
    }

    expect(buildSourceGroups(plugin, [
      source({ id: 'douyin-search', adapter: 'Douyin_TikTok_Download_API', facility: { key: 'douyin', label: '抖音' } }),
      source({ id: 'bilibili-user-videos', adapter: 'Douyin_TikTok_Download_API', facility: { key: 'bilibili', label: '哔哩哔哩' } }),
      source({ id: 'tiktok-user', adapter: 'Douyin_TikTok_Download_API', facility: { key: 'tiktok', label: 'TikTok' } }),
    ])).toEqual([
      { key: 'bilibili', label: '哔哩哔哩', count: 1 },
      { key: 'douyin', label: '抖音', count: 1 },
      { key: 'tiktok', label: 'TikTok', count: 1 },
    ])
  })

  it('manifest.facility 读清单自己的 facility，宿主不认识任何平台名', () => {
    const plugin: PluginDescriptor = {
      id: 'Douyin_TikTok_Download_API',
      sourceGrouping: { enabled: true, resolver: 'manifest.facility' },
    }
    expect(resolveSourceGroup(source({
      id: 'anything-at-all',
      adapter: 'Douyin_TikTok_Download_API',
      facility: { key: 'somesite', label: '某站' },
    }), plugin)).toEqual({ key: 'somesite', label: '某站' })
  })

  it('清单没声明 facility → 不分组（而不是按 id 前缀猜）', () => {
    const plugin: PluginDescriptor = {
      id: 'Douyin_TikTok_Download_API',
      sourceGrouping: { enabled: true, resolver: 'manifest.facility' },
    }
    expect(resolveSourceGroup(source({
      id: 'somesite-video',
      adapter: 'Douyin_TikTok_Download_API',
    }), plugin)).toBeUndefined()
  })

  it('fails fast for missing scoped runtime resolvers', () => {
    expect(() => validatePluginGrouping({
      id: 'rsshub',
      sourceGrouping: { enabled: true, resolver: 'plugin.missing' },
    })).toThrow(/Invalid plugin sourceGrouping resolver for rsshub: plugin\.missing/)
  })

  it('exposes grouping metadata without sharing mutable params', () => {
    const metadata = pluginGroupingMetadata({
      enabled: true,
      resolver: 'plugin.groupByPlatform',
      params: { mode: 'platform' },
    })

    expect(metadata).toEqual({
      enabled: true,
      resolver: 'plugin.groupByPlatform',
      params: { mode: 'platform' },
    })
    expect(metadata?.params).not.toBe(pluginGroupingMetadata({
      enabled: true,
      resolver: 'plugin.groupByPlatform',
      params: { mode: 'platform' },
    })?.params)
  })
})
