import type { Registry } from '../registry/registry.ts'

export function parseSourceId(sourceId: string): { plugin_id: string; source_template_id: string } {
  const idx = sourceId.indexOf(':')
  if (idx > 0) {
    return { plugin_id: sourceId.slice(0, idx), source_template_id: sourceId.slice(idx + 1) }
  }
  return { plugin_id: 'custom', source_template_id: sourceId }
}

export function canonicalSourceId(pluginId: string, templateId: string): string {
  if (!pluginId || pluginId === 'custom') return templateId
  return `${pluginId}:${templateId}`
}

export function normalizeSource(src: any, registry?: Registry): any {
  if (src.plugin_id && src.source_template_id) {
    if (registry) {
      const sourceId = canonicalSourceId(src.plugin_id, src.source_template_id)
      const manifest = registry.get(sourceId)
      if (manifest) {
        return {
          plugin_id: manifest.pluginId || src.plugin_id,
          source_template_id: src.source_template_id,
          params: src.params || {},
        }
      }
      const manifestByTemplate = registry.get(src.source_template_id)
      if (manifestByTemplate) {
        return {
          plugin_id: manifestByTemplate.pluginId || src.plugin_id,
          source_template_id: src.source_template_id,
          params: src.params || {},
        }
      }
    }
    return {
      plugin_id: src.plugin_id,
      source_template_id: src.source_template_id,
      params: src.params || {},
    }
  }
  if (src.source_id) {
    if (registry) {
      const manifest = registry.get(src.source_id)
      if (manifest) {
        return {
          plugin_id: manifest.pluginId || 'custom',
          source_template_id: src.source_id,
          params: src.params || {},
        }
      }
    }
    const resolved = parseSourceId(src.source_id)
    return {
      plugin_id: resolved.plugin_id,
      source_template_id: resolved.source_template_id,
      params: src.params || {},
    }
  }
  return {
    plugin_id: 'custom',
    source_template_id: 'unknown',
    params: src.params || {},
  }
}
