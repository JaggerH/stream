import type { Registry } from '../registry/registry.ts'
import type { IntentResult } from '../resolve/intent.ts'
import { parseSourceId } from '../streams/store.ts'

/** A raw Stream `SourceBinding` write shape — {plugin, source, params}. */
export interface StreamMember {
  plugin: string
  source: string
  params: Record<string, unknown>
}

/**
 * Turn an intent classification into the first workable Stream member, or null if nothing
 * matches. The top candidate's canonical id is split into plugin + source template, and the
 * intent key is placed into the source's `key_param` (default `url`).
 */
export function buildStreamMemberFromIntent(intent: IntentResult, registry: Registry): StreamMember | null {
  const sourceId = intent.candidates[0]
  if (!sourceId) return null
  const { plugin_id, source_template_id } = parseSourceId(sourceId)
  const keyParam = registry.get(sourceId)?.key_param ?? 'url'
  return { plugin: plugin_id, source: source_template_id, params: { [keyParam]: intent.key } }
}
