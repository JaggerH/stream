import type { ItemStore } from '../item-store.ts'
import type { Registry } from '../registry/registry.ts'
import { normalize, type RawItem } from './normalize.ts'

export type RenormalizeFilter = { streamId?: string; sourceId?: string }

export interface RenormalizeResult {
  scanned: number
  updated: number
  skipped: { noSourceId: number; manifestGone: number; parseError: number }
}

/** Thrown when the requested scope doesn't exist — the endpoint maps it to 404 so a
 *  typo'd id can't masquerade as a successful `{scanned: 0}` no-op. */
export class RenormalizeNotFoundError extends Error {
  constructor(
    public readonly what: 'stream' | 'source',
    message: string
  ) {
    super(message)
    this.name = 'RenormalizeNotFoundError'
  }
}

/**
 * Re-run `normalize(raw, currentManifest)` over stored items and overwrite ONLY their
 * `content` — the maintenance half of "ingest-time normalization is a cache, not a
 * one-way door" (raw is always persisted; see the design spec). Sibling fields (id,
 * muted, title, …) are never touched: id is the dedup/UNIQUE/read-state identity.
 * Idempotent: a recomputed content deep-equal to the stored one is not rewritten.
 */
export function renormalizeStoredItems(
  itemStore: ItemStore,
  registry: Registry,
  filter: RenormalizeFilter = {}
): RenormalizeResult {
  if (filter.streamId && itemStore.maxSeq(filter.streamId) === 0) {
    throw new RenormalizeNotFoundError('stream', `no stored items for stream ${filter.streamId}`)
  }
  if (filter.sourceId && !registry.get(filter.sourceId)) {
    throw new RenormalizeNotFoundError('source', `unknown source ${filter.sourceId}`)
  }
  const counts: RenormalizeResult = {
    scanned: 0,
    updated: 0,
    skipped: { noSourceId: 0, manifestGone: 0, parseError: 0 },
  }
  const res = itemStore.rewriteItems({ streamId: filter.streamId }, (item) => {
    if (filter.sourceId && item.source_id !== filter.sourceId) return null // out of scope
    counts.scanned++
    if (!item.source_id) {
      counts.skipped.noSourceId++
      return null
    }
    const manifest = registry.get(item.source_id)
    if (!manifest) {
      counts.skipped.manifestGone++
      return null
    }
    const next = normalize(item.raw as RawItem, manifest)
    if (JSON.stringify(next) === JSON.stringify(item.content)) return null // unchanged → idempotent
    counts.updated++
    return { ...item, content: next }
  })
  counts.skipped.parseError = res.parseErrors
  return counts
}
