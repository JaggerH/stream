import type { Facility, SourceManifest } from '../manifest/types.ts'
import type { PluginDescriptor, PluginSourceGrouping } from './types.ts'

export interface SourceGroupingContext {
  plugin: PluginDescriptor
  params: Record<string, unknown>
}

export type SourceGroupingResolver = (source: SourceManifest, context: SourceGroupingContext) => Facility | undefined

export interface PluginRuntime {
  adapter?: Record<string, SourceGroupingResolver>
  plugin?: Record<string, SourceGroupingResolver>
}

export interface ResolvedGroup {
  key: string
  label: string
  count: number
}

const UNGROUPED: Facility = { key: '', label: '未分类' }

const RSSHUB_RUNTIME: PluginRuntime = {
  adapter: {
    groupByNamespace: (source) => {
      const facility = source.facility
      if (facility) return facility
      if (!source.id.startsWith('rsshub:')) return undefined
      const ns = source.id.slice('rsshub:'.length).split('/')[0]
      if (!ns) return undefined
      return { key: ns, label: ns }
    },
  },
}

const RUNTIMES: Record<string, PluginRuntime> = {
  rsshub: RSSHUB_RUNTIME,
}

export function pluginGroupingMetadata(grouping?: PluginSourceGrouping): PluginSourceGrouping | undefined {
  if (!grouping) return undefined
  return {
    enabled: grouping.enabled,
    resolver: grouping.resolver,
    params: grouping.params ? { ...grouping.params } : undefined,
  }
}

export function validatePluginGrouping(descriptor: PluginDescriptor): void {
  const grouping = descriptor.sourceGrouping
  if (!grouping?.enabled) return
  if (grouping.resolver === 'manifest.facility') return
  const { scope, name } = parseResolver(grouping.resolver)
  const runtime = RUNTIMES[descriptor.id]
  const resolver = runtime?.[scope]?.[name]
  if (!resolver) {
    throw new Error(`Invalid plugin sourceGrouping resolver for ${descriptor.id}: ${grouping.resolver}`)
  }
}

export function resolveSourceGroup(source: SourceManifest, plugin: PluginDescriptor): Facility | undefined {
  const grouping = plugin.sourceGrouping
  if (!grouping?.enabled) return undefined
  if (grouping.resolver === 'manifest.facility') return source.facility
  const { scope, name } = parseResolver(grouping.resolver)
  const runtime = RUNTIMES[plugin.id]
  const resolver = runtime?.[scope]?.[name]
  if (!resolver) throw new Error(`Missing plugin sourceGrouping resolver for ${plugin.id}: ${grouping.resolver}`)
  return resolver(source, { plugin, params: grouping.params ?? {} })
}

export function buildSourceGroups(plugin: PluginDescriptor, sources: SourceManifest[]): ResolvedGroup[] {
  const counts = new Map<string, { label: string; count: number }>()
  for (const source of sources) {
    const group = resolveSourceGroup(source, plugin) ?? UNGROUPED
    const entry = counts.get(group.key) ?? { label: group.label, count: 0 }
    entry.count++
    counts.set(group.key, entry)
  }
  return [...counts.entries()]
    .map(([key, value]) => ({ key, label: value.label, count: value.count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

function parseResolver(resolver: string): { scope: 'adapter' | 'plugin'; name: string } {
  const idx = resolver.indexOf('.')
  if (idx <= 0 || idx === resolver.length - 1) {
    throw new Error(`Invalid plugin sourceGrouping resolver: ${resolver}`)
  }
  const scope = resolver.slice(0, idx)
  const name = resolver.slice(idx + 1)
  if (scope !== 'adapter' && scope !== 'plugin') {
    throw new Error(`Invalid plugin sourceGrouping resolver: ${resolver}`)
  }
  return { scope, name }
}
