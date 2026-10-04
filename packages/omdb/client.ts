import type { VideoImageResult, VideoLookupIdentity, VideoMetadataResult } from '../../src/video/types.ts'

/** OMDb 的 HTTP 客户端与响应解析——这一家在 Stream 里的全部知识。宿主只认识「影视详情行上有个成员」。 */

const OMDB_BASE = 'https://www.omdbapi.com/'

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

/** 标题查询只是候选搜索：没有显式 imdb id 时，别让 OMDb 的模糊匹配把一部作品静默换成另一部。
 *  （与宿主 TMDb 那档是各自上游各自的核对，不共用一份——两家的模糊匹配行为不同。） */
function matchesIdentity(identity: VideoLookupIdentity, title: unknown, year: unknown): boolean {
  const wanted = normalizedTitle(identity.title)
  const actual = normalizedTitle(title)
  if (!wanted || !actual || !(wanted === actual || wanted.includes(actual) || actual.includes(wanted))) return false
  if (!identity.year) return true
  const match = typeof year === 'number' ? year : typeof year === 'string' ? year.match(/(?:19|20)\d{2}/)?.[0] : undefined
  return Number(match) === identity.year
}

/** 查一次 OMDb；查不到 / 对不上身份 → null；HTTP 失败 → 抛。 */
export async function omdbLookup(identity: VideoLookupIdentity, apiKey: string): Promise<Record<string, any> | null> {
  const url = new URL(OMDB_BASE)
  url.searchParams.set('apikey', apiKey)
  url.searchParams.set('plot', 'full')
  if (identity.externalIds.imdb) url.searchParams.set('i', identity.externalIds.imdb)
  else {
    url.searchParams.set('t', identity.title)
    if (identity.year) url.searchParams.set('y', String(identity.year))
    if (identity.kind === 'movie' || identity.kind === 'series' || identity.kind === 'episode') url.searchParams.set('type', identity.kind)
  }
  const response = await fetch(url.toString(), { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`OMDb request failed (${response.status})`)
  const body = await response.json()
  const parsed = body && typeof body === 'object' && (body as Record<string, any>).Response === 'True' ? body as Record<string, any> : null
  return parsed && (identity.externalIds.imdb || matchesIdentity(identity, parsed.Title, parsed.Year)) ? parsed : null
}

function split(value: unknown): string[] {
  return typeof value === 'string' && value !== 'N/A' ? value.split(',').map((part) => part.trim()).filter(Boolean) : []
}

/** OMDb 响应 → 宿主的影视元数据形状。 */
export function omdbMetadata(raw: Record<string, any>): VideoMetadataResult {
  const ratings = arrayOf<Record<string, any>>(raw.Ratings).flatMap((rating) => {
    const match = typeof rating.Value === 'string' ? rating.Value.match(/([\d.]+)\/(\d+)/) : null
    return match ? [{ source: typeof rating.Source === 'string' ? rating.Source.toLowerCase() : 'omdb', value: Number(match[1]), scale: Number(match[2]) }] : []
  })
  if (typeof raw.imdbRating === 'string' && raw.imdbRating !== 'N/A') ratings.push({ source: 'imdb', value: Number(raw.imdbRating), scale: 10, ...(typeof raw.imdbVotes === 'string' ? { votes: Number(raw.imdbVotes.replace(/,/g, '')) } : {}) })
  return {
    source: 'omdb-metadata',
    ...(typeof raw.Title === 'string' ? { title: raw.Title } : {}),
    ...(typeof raw.Released === 'string' && raw.Released !== 'N/A' ? { releaseDate: raw.Released, year: yearOf(raw.Year) } : typeof raw.Year === 'string' ? { year: yearOf(raw.Year) } : {}),
    ...(typeof raw.Runtime === 'string' && /^\d+/.test(raw.Runtime) ? { runtimeMinutes: Number.parseInt(raw.Runtime, 10) } : {}),
    ...(typeof raw.Rated === 'string' && raw.Rated !== 'N/A' ? { certification: raw.Rated } : {}),
    ...(typeof raw.Plot === 'string' && raw.Plot !== 'N/A' ? { overview: raw.Plot } : {}),
    genres: split(raw.Genre),
    people: [
      ...split(raw.Actors).map((name) => ({ name, role: 'actor' as const })),
      ...split(raw.Director).map((name) => ({ name, role: 'director' as const })),
      ...split(raw.Writer).map((name) => ({ name, role: 'writer' as const })),
    ],
    ratings: ratings.filter((rating) => Number.isFinite(rating.value)),
    externalIds: typeof raw.imdbID === 'string' ? { imdb: raw.imdbID } : {},
  }
}

/** OMDb 响应 → 海报候选；没有海报 → null。 */
export function omdbPoster(raw: Record<string, any>): VideoImageResult | null {
  const poster = typeof raw.Poster === 'string' && raw.Poster !== 'N/A' ? raw.Poster : null
  return poster ? { source: 'omdb-images', images: [{ kind: 'poster', url: poster, source: 'omdb-images' }] } : null
}
