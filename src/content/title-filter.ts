import type { StreamItem } from '../types.ts'

/** 只看包含 (title-include allow-filter). Returns a `filtered` mute when `title` matches NONE of
 *  the include keywords (case-insensitive substring); a match or an empty/absent list → undefined
 *  (keep visible). Shared by ingest (makeStreamItem) and the reclassify-history endpoint so both
 *  fold identically. Ad classification takes precedence — callers apply this only when the item is
 *  not already ad-muted. */
export function includeFold(title: string | undefined, titleInclude?: string[]): StreamItem['muted'] | undefined {
  if (!titleInclude || titleInclude.length === 0) return undefined
  const t = String(title ?? '').toLowerCase()
  const hit = titleInclude.some((k) => t.includes(k.toLowerCase()))
  return hit ? undefined : { reason: 'filtered', rule: titleInclude.join('|') }
}
