import type { VideoSourceSettings } from '../../settings-store.ts'
import type { VideoImageCandidate, VideoImageResult, VideoLookupIdentity, VideoMetadataResult, VideoPerson, VideoRating } from '../../video/types.ts'
import type { BuiltinFn, SourceExecutionContext } from './adapter.ts'

export type TmdbFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface TmdbSourceDeps {
  getSettings?: () => VideoSourceSettings | undefined
  fetch?: TmdbFetch
}

export interface VideoMetadataSourceDeps extends TmdbSourceDeps {}

/** Shared TMDb source configuration. Runtime config takes precedence over the settings overlay. */
export function tmdbConfig(deps: TmdbSourceDeps, context?: SourceExecutionContext): VideoSourceSettings | undefined {
  if (context && Object.keys(context.runtimeConfig).length) return { tmdbApiKey: String(context.runtimeConfig.apiKey ?? ''), language: typeof context.runtimeConfig.language === 'string' ? context.runtimeConfig.language : undefined }
  return deps.getSettings?.()
}

const TMDB_BASE = 'https://api.themoviedb.org/3'
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/original'
/** Headshots are shown as small tiles, never full-bleed like a poster or backdrop, so they are
 *  requested at a headshot size: `original` is ~209KB each against ~43KB here, and a full cast
 *  is dozens of them (痴迷: 37 photos → ~7.5MB vs ~1.6MB). h632 (421x632) still out-resolves the
 *  tile on a 2x display; w185 would not. */
const TMDB_PROFILE_BASE = 'https://image.tmdb.org/t/p/h632'

function videoIdentity(input: unknown): VideoLookupIdentity | null {
  if (!input || typeof input !== 'object') return null
  const value = input as Partial<VideoLookupIdentity>
  if (!value.title || typeof value.title !== 'string') return null
  return { ...value, title: value.title, externalIds: value.externalIds ?? {} }
}

function mediaType(identity: VideoLookupIdentity): 'movie' | 'tv' {
  return identity.kind === 'series' || identity.kind === 'season' || identity.kind === 'episode' ? 'tv' : 'movie'
}

function yearOf(date?: string): number | undefined {
  const match = date?.match(/^(\d{4})/)
  return match ? Number(match[1]) : undefined
}

function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function normalizedTitle(value: unknown): string {
  return typeof value === 'string' ? value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '') : ''
}

/** A title query is only a candidate search. Without an explicit source ID, do not let a
 * provider's fuzzy matching silently turn one work into another. */
function matchesIdentity(identity: VideoLookupIdentity, title: unknown, year: unknown): boolean {
  const wanted = normalizedTitle(identity.title)
  const actual = normalizedTitle(title)
  if (!wanted || !actual || !(wanted === actual || wanted.includes(actual) || actual.includes(wanted))) return false
  if (!identity.year) return true
  const match = typeof year === 'number' ? year : typeof year === 'string' ? year.match(/(?:19|20)\d{2}/)?.[0] : undefined
  return Number(match) === identity.year
}

function matchesCandidate(identity: VideoLookupIdentity, candidate: Record<string, any>): boolean {
  const release = candidate.release_date ?? candidate.first_air_date
  return [candidate.title, candidate.original_title, candidate.name, candidate.original_name]
    .some((title) => matchesIdentity(identity, title, release))
}

function alternativeTitles(raw: Record<string, any>, type: 'movie' | 'tv'): unknown[] {
  const alternatives = raw.alternative_titles
  if (type === 'movie') return arrayOf<Record<string, any>>(alternatives?.titles).map((row) => row.title)
  return arrayOf<Record<string, any>>(alternatives?.results).map((row) => row.title)
}

/** TMDb v3 transport shared by metadata and canonical-resolution Sources. */
export async function tmdbJson(fetch: TmdbFetch, path: string, apiKey: string, language?: string): Promise<Record<string, any>> {
  const url = new URL(`${TMDB_BASE}${path}`)
  // The Source Config Sheet asks for TMDb's v3 API Key, whose documented transport is
  // `api_key`; Bearer auth is for the distinct API Read Access Token.
  url.searchParams.set('api_key', apiKey)
  if (language) url.searchParams.set('language', language)
  const response = await fetch(url.toString(), { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`TMDb request failed (${response.status})`)
  const body = await response.json()
  if (!body || typeof body !== 'object') throw new Error('TMDb returned an invalid response')
  return body as Record<string, any>
}

async function tmdbId(fetch: TmdbFetch, identity: VideoLookupIdentity, apiKey: string, language?: string): Promise<string | null> {
  if (identity.externalIds.tmdb) return identity.externalIds.tmdb
  const type = mediaType(identity)
  if (identity.externalIds.imdb) {
    const found = await tmdbJson(fetch, `/find/${encodeURIComponent(identity.externalIds.imdb)}?external_source=imdb_id`, apiKey, language)
    const candidate = arrayOf<Record<string, any>>(found[type === 'movie' ? 'movie_results' : 'tv_results'])[0]
    if (candidate?.id != null) return String(candidate.id)
  }
  return tmdbCandidateId(fetch, identity, apiKey, language)
}

/** TMDb metadata owns the authority-side lookup it needs before it can return a detail. */
async function tmdbCandidateId(fetch: TmdbFetch, identity: VideoLookupIdentity, apiKey: string, language?: string): Promise<string | null> {
  const type = mediaType(identity)
  const query = new URLSearchParams({ query: identity.title })
  if (identity.year) query.set(type === 'movie' ? 'primary_release_year' : 'first_air_date_year', String(identity.year))
  const found = await tmdbJson(fetch, `/search/${type}?${query}`, apiKey, language)
  const candidates = arrayOf<Record<string, any>>(found.results).slice(0, 5)
  const direct = candidates.find((row) => matchesCandidate(identity, row))
  if (direct?.id != null) return String(direct.id)

  // Search results are localized. A Chinese discovery title can correctly return an English
  // display title, so inspect only the small candidate set's authority-provided aliases before
  // declining. This remains a TMDb-only verification step; it never fetches the discovery site.
  for (const candidate of candidates) {
    if (candidate.id == null) continue
    const detail = await tmdbJson(fetch, `/${type}/${encodeURIComponent(String(candidate.id))}?append_to_response=alternative_titles`, apiKey, language)
    const release = detail.release_date ?? detail.first_air_date ?? candidate.release_date ?? candidate.first_air_date
    if (alternativeTitles(detail, type).some((title) => matchesIdentity(identity, title, release))) return String(candidate.id)
  }
  return null
}

async function tmdbDetails(deps: VideoMetadataSourceDeps, identity: VideoLookupIdentity, context?: SourceExecutionContext): Promise<Record<string, any> | null> {
  const settings = tmdbConfig(deps, context)
  if (!settings?.tmdbApiKey) return null
  const fetch = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const id = await tmdbId(fetch, identity, settings.tmdbApiKey, settings.language)
  if (!id) return null
  return tmdbJson(fetch, `/${mediaType(identity)}/${encodeURIComponent(id)}?append_to_response=credits,external_ids,images`, settings.tmdbApiKey, settings.language)
}

function person(role: VideoPerson['role'], raw: Record<string, any>): VideoPerson | null {
  if (typeof raw.name !== 'string' || !raw.name) return null
  return { name: raw.name, role, ...(typeof raw.character === 'string' && raw.character ? { character: raw.character } : {}), ...(raw.profile_path ? { image: `${TMDB_PROFILE_BASE}${raw.profile_path}` } : {}) }
}

function tmdbMetadata(raw: Record<string, any>): VideoMetadataResult {
  const releaseDate = typeof raw.release_date === 'string' ? raw.release_date : typeof raw.first_air_date === 'string' ? raw.first_air_date : undefined
  const people: VideoPerson[] = [
    ...arrayOf<Record<string, any>>(raw.credits?.cast).map((row) => person('actor', row)).filter((row): row is VideoPerson => !!row),
    ...arrayOf<Record<string, any>>(raw.credits?.crew).map((row) => {
      const job = String(row.job ?? '').toLowerCase()
      const role: VideoPerson['role'] = job === 'director' ? 'director' : job.includes('writer') || job === 'screenplay' ? 'writer' : job === 'creator' ? 'creator' : job === 'producer' ? 'producer' : 'other'
      return person(role, row)
    }).filter((row): row is VideoPerson => !!row),
  ]
  const ratings: VideoRating[] = typeof raw.vote_average === 'number' && raw.vote_average > 0
    ? [{ source: 'tmdb', value: raw.vote_average, scale: 10, ...(typeof raw.vote_count === 'number' ? { votes: raw.vote_count } : {}) }]
    : []
  return {
    source: 'tmdb-metadata',
    ...(typeof raw.title === 'string' ? { title: raw.title } : typeof raw.name === 'string' ? { title: raw.name } : {}),
    ...(typeof raw.original_title === 'string' ? { originalTitle: raw.original_title } : typeof raw.original_name === 'string' ? { originalTitle: raw.original_name } : {}),
    ...(releaseDate ? { releaseDate, year: yearOf(releaseDate) } : {}),
    ...(typeof raw.runtime === 'number' ? { runtimeMinutes: raw.runtime } : typeof raw.episode_run_time?.[0] === 'number' ? { runtimeMinutes: raw.episode_run_time[0] } : {}),
    ...(typeof raw.overview === 'string' && raw.overview ? { overview: raw.overview } : {}),
    ...(typeof raw.tagline === 'string' && raw.tagline ? { tagline: raw.tagline } : {}),
    genres: arrayOf<Record<string, any>>(raw.genres).map((genre) => genre.name).filter((name): name is string => typeof name === 'string' && !!name),
    people,
    ratings,
    externalIds: {
      ...(raw.id != null ? { tmdb: String(raw.id) } : {}),
      ...(typeof raw.external_ids?.imdb_id === 'string' && raw.external_ids.imdb_id ? { imdb: raw.external_ids.imdb_id } : {}),
    },
  }
}

function tmdbImages(raw: Record<string, any>): VideoImageCandidate[] {
  const out: VideoImageCandidate[] = []
  const push = (kind: VideoImageCandidate['kind'], path: unknown, extras: Partial<VideoImageCandidate> = {}) => {
    if (typeof path === 'string' && path) out.push({ kind, url: `${TMDB_IMAGE_BASE}${path}`, source: 'tmdb-images', ...extras })
  }
  push('poster', raw.poster_path)
  push('backdrop', raw.backdrop_path)
  for (const kind of ['posters', 'backdrops', 'logos'] as const) {
    const target: VideoImageCandidate['kind'] = kind === 'posters' ? 'poster' : kind === 'backdrops' ? 'backdrop' : 'logo'
    for (const image of arrayOf<Record<string, any>>(raw.images?.[kind])) {
      push(target, image.file_path, {
        ...(typeof image.iso_639_1 === 'string' ? { language: image.iso_639_1 } : {}),
        ...(typeof image.width === 'number' ? { width: image.width } : {}),
        ...(typeof image.height === 'number' ? { height: image.height } : {}),
      })
    }
  }
  return out.filter((image, index, images) => images.findIndex((other) => other.kind === image.kind && other.url === image.url) === index)
}

export function makeTmdbMetadataFn(deps: VideoMetadataSourceDeps = {}): BuiltinFn {
  return async (input, _params, context) => {
    const identity = videoIdentity(input)
    if (!identity) return []
    const detail = await tmdbDetails(deps, identity, context)
    return detail ? [tmdbMetadata(detail)] : []
  }
}

export function makeTmdbImagesFn(deps: VideoMetadataSourceDeps = {}): BuiltinFn {
  return async (input, _params, context) => {
    const identity = videoIdentity(input)
    if (!identity) return []
    const detail = await tmdbDetails(deps, identity, context)
    return detail ? [{ source: 'tmdb-images', images: tmdbImages(detail) } satisfies VideoImageResult] : []
  }
}

