import type { StreamItem } from '../types.ts'
import type { VideoMetadataResult, VideoPerson } from './types.ts'

/**
 * A ranking shelf is discovery, not an external-id authority. Some shelves nevertheless carry a
 * small, trustworthy detail subset; the normalizer that parses them declares it as
 * `content.meta.discovery` (today `packages/rsshub/movie.ts`, for the Douban shelves). When
 * TMDb/OMDb do not identify a work, expose that subset as an explicit source fallback rather than
 * rendering an empty page. The host parses no site's text here — only the declared fields.
 *
 * `source` is `<meta.source>-discovery`: the frontend tells a fallback page apart by that suffix.
 */
export function videoDiscoveryFallback(item: StreamItem): VideoMetadataResult | null {
  const meta = item.content?.meta
  if (!meta?.discovery) return null
  const d = meta.discovery
  const origin = meta.source ?? 'discovery'
  const rating = Number(meta.rating)
  const people: VideoPerson[] = [
    ...(d.directors ?? []).map((name) => ({ name, role: 'director' as const })),
    ...(d.actors ?? []).map((name) => ({ name, role: 'actor' as const })),
  ]
  return {
    source: `${origin}-discovery`,
    title: item.content!.title ?? item.title,
    ...(d.runtimeMinutes ? { runtimeMinutes: d.runtimeMinutes } : {}),
    ratings: Number.isFinite(rating) && rating > 0 ? [{ source: origin, value: rating, scale: 10 }] : [],
    people,
    externalIds: {},
  }
}
