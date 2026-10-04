/** Split a manifest source id into (pluginId, templateId) — mirrors backend parseSourceId
 *  (src/streams/store.ts): first ':' separates; a colonless id is a 'custom'-plugin template. */
export function splitSourceId(sourceId: string): { pluginId: string; templateId: string } {
  const i = sourceId.indexOf(':')
  if (i > 0) return { pluginId: sourceId.slice(0, i), templateId: sourceId.slice(i + 1) }
  return { pluginId: 'custom', templateId: sourceId }
}

/** djb2 — deterministic, dependency-free. */
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const ID_BUDGET = 200

/** canonical(pluginId, sourceTemplateId, sortedParams). Params sorted by key, values NOT
 *  truncated; when the readable form would exceed the id budget, append a stable hash of the
 *  full form so long values still disambiguate without blowing the budget. */
export function memberKey(pluginId: string, templateId: string, params: Record<string, unknown>): string {
  const kv = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k] == null ? '' : String(params[k])}`)
    .join('&')
  const readable = `${pluginId} ${templateId} ${kv}`
  if (readable.length <= ID_BUDGET) return readable
  const head = readable.slice(0, ID_BUDGET - 12)
  return `${head}#${hash(readable)}`
}

/** Key a payload that carries the full manifest id (both radar candidates and channel members do). */
export function candidateKey(sourceId: string, params: Record<string, unknown>): string {
  const { pluginId, templateId } = splitSourceId(sourceId)
  return memberKey(pluginId, templateId, params)
}
