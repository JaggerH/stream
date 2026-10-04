import type { VideoReference } from '../../video/types.ts'
import type { BuiltinFn } from './adapter.ts'
import { tmdbConfig, tmdbJson, type TmdbSourceDeps } from './video-metadata.ts'

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/original'

/** A search hit carries its own display projections (rating/overview) on top of the reference
 *  facts; the endpoint promotes these to `VideoWorkCandidate` after adding `sources`. */
export type TmdbSearchHit = VideoReference & { rating?: number; overview?: string }

/** One TMDb `/search/multi` result → an unverified work reference (+ display projections).
 *  `person` hits (and anything without a usable title) are dropped by returning null. The real
 *  title/year always come back from TMDb itself; this is the discovery fact the row emits. */
export function tmdbSearchHit(raw: Record<string, any>): TmdbSearchHit | null {
  const mediaType = raw.media_type
  if (mediaType !== 'movie' && mediaType !== 'tv') return null
  const title = (typeof raw.title === 'string' && raw.title) || (typeof raw.name === 'string' && raw.name) || ''
  if (!title || raw.id == null) return null
  const date = mediaType === 'movie' ? raw.release_date : raw.first_air_date
  const year = typeof date === 'string' ? Number(date.match(/^(\d{4})/)?.[1]) || undefined : undefined
  const poster = typeof raw.poster_path === 'string' && raw.poster_path ? `${TMDB_IMAGE_BASE}${raw.poster_path}` : undefined
  return {
    title,
    kind: mediaType === 'tv' ? 'series' : 'movie',
    ...(year ? { year } : {}),
    ...(poster ? { poster } : {}),
    externalIds: { tmdb: String(raw.id) },
    ...(typeof raw.vote_average === 'number' && raw.vote_average > 0 ? { rating: raw.vote_average } : {}),
    ...(typeof raw.overview === 'string' && raw.overview ? { overview: raw.overview } : {}),
  }
}

/** builtin Source `tmdb-title-search` (mode `tmdb-title-search`): keyword → candidate works via
 *  TMDb `/search/multi` (one call covers movie + tv). Member of the `video-search` Provider row;
 *  future region sources (腾讯综艺 / 爱奇艺短剧) join that row the same way. Empty keyword or an
 *  unconfigured TMDb key declines (returns []), never throws. */
export function makeTmdbTitleSearchFn(deps: TmdbSourceDeps = {}): BuiltinFn {
  return async (input, params, context) => {
    const keyword = String(params.keyword ?? params.input ?? input ?? '').trim()
    if (!keyword) return []
    const settings = tmdbConfig(deps, context)
    if (!settings?.tmdbApiKey) return []
    const fetch = deps.fetch ?? globalThis.fetch.bind(globalThis)
    const body = await tmdbJson(fetch, `/search/multi?query=${encodeURIComponent(keyword)}&include_adult=false`, settings.tmdbApiKey, settings.language)
    const results = Array.isArray(body.results) ? body.results : []
    return results.flatMap((raw: Record<string, any>) => {
      const hit = tmdbSearchHit(raw)
      return hit ? [hit] : []
    })
  }
}
