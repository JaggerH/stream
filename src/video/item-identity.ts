import type { StreamItem } from '../types.ts'
import type { VideoDetail, VideoLookupIdentity, VideoReference } from './types.ts'

export interface VideoDetailPreview {
  title?: string
  year?: number
  rating?: number
  poster?: string
  backdrop?: string
}

/** ONE extraction rule per authority, applied to every place that id can arrive from — the item's
 *  own URL and the fields a source declares. A source often has the id only as a link (a recipe
 *  reads it off an `<a href>`; a CSS selector cannot slice the id back out), so a declared field
 *  must accept the link form too. Writing a second regex at each new call site is how a codebase
 *  ends up with two answers to "what is this work's IMDb id"; there is exactly one here. */
function idFrom(pattern: RegExp, bare: RegExp, candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate) continue
    const linked = candidate.match(pattern)
    if (linked) return linked[1]
    if (bare.test(candidate)) return candidate
  }
  return undefined
}

function canonicalIds(
  sourceUrl: string | undefined,
  raw: Record<string, unknown>,
  kind: VideoLookupIdentity['kind'] | undefined,
): { ids: Record<string, string>; kindHint?: VideoLookupIdentity['kind'] } {
  // Declared fields first, the item URL last: a source that names an id means it, while the URL
  // is merely where the row happened to live.
  let tmdb = idFrom(/themoviedb\.org\/(?:movie|tv)\/(\d+)/i, /^\d+$/, [raw.tmdb_id, raw.tmdbId, sourceUrl])
  const imdb = idFrom(/imdb\.com\/title\/(tt\d+)/i, /^tt\d+$/i, [raw.imdb_id, raw.imdbId, sourceUrl])
  // Wikidata 实体只是标识符：采集时 recipe 已经拿它去 Wikidata 换过编号（见 wikipedia 包的
  // hops），换来的落在下面 tmdb_movie_id / tmdb_tv_id / imdb_id 里；这格留着是**新证据**的
  // 判据来源（enrich-queue 的 missWithNewEvidence 按 externalIds 比对）。
  const wikidata = idFrom(/wikidata\.org\/wiki\/(?:Special:EntityPage\/)?(Q\d+)/i, /^Q\d+$/, [raw.wikidata_id, raw.wikidataId])
  // Wikidata 的 TMDb 编号是分索引的（P4947 电影 / P4983 剧集），同一个数字在两个索引下是两部
  // 不同的作品，所以这两格不能合并进一个 tmdb_id 交出来——哪格有值本身就是 kind 的证据。
  // 两格都有（Revolting Rhymes 那种电影剧集双登记）而 kind 未知时取电影，与 canonical 阶梯
  // kind 未知时先问 /movie 的既有顺序一致。
  const tmdbMovie = idFrom(/themoviedb\.org\/movie\/(\d+)/i, /^\d+$/, [raw.tmdb_movie_id])
  const tmdbTv = idFrom(/themoviedb\.org\/tv\/(\d+)/i, /^\d+$/, [raw.tmdb_tv_id])
  let kindHint: VideoLookupIdentity['kind'] | undefined
  if (!tmdb && (tmdbMovie || tmdbTv)) {
    // kind 已知就只认那个索引的编号——拿电影编号去剧集索引撞，撞上的只会是别的作品。
    if (kind === 'series') tmdb = tmdbTv
    else if (kind === 'movie') tmdb = tmdbMovie
    else {
      tmdb = tmdbMovie ?? tmdbTv
      // 只有一格有值时它同时说清了自己是电影还是剧集；两格都有则不猜。
      if (!tmdbMovie !== !tmdbTv) kindHint = tmdbMovie ? 'movie' : 'series'
    }
  }
  return {
    ids: {
      ...(tmdb ? { tmdb } : {}),
      ...(imdb ? { imdb } : {}),
      ...(wikidata ? { wikidata } : {}),
    },
    ...(kindHint ? { kindHint } : {}),
  }
}

function weeklyPeople(item: StreamItem, raw: Record<string, unknown>): VideoReference['people'] {
  if (!item.source_route.endsWith('/douban/movie/weekly') || typeof raw.description !== 'string') return undefined
  const label = raw.description.match(/标签：\s*([^<\n]+)/)?.[1]
  if (!label) return undefined
  const parts = label.split('/').map((part) => part.trim())
  const names = (value: string | undefined, role: 'director' | 'actor') => (value ?? '')
    .split(/\s*(?:[/／、]|\s+)\s*/).map((name) => name.trim()).filter(Boolean).map((name) => ({ name, role }))
  const people = [...names(parts[3], 'director'), ...names(parts[4], 'actor')]
  return people.length ? people : undefined
}

/** Extract source facts once, without granting a non-authority URL the status of a mapping. */
export function videoItemReference(item: StreamItem): VideoReference {
  const raw = item.raw && typeof item.raw === 'object' ? item.raw as Record<string, unknown> : {}
  const meta = item.content?.meta as Record<string, unknown> | undefined
  const sourceUrl = item.videoRef?.sourceUrl ?? item.url
  // **没有证据就不要填 kind。** 以前这里默认 'movie'，于是任何不带 themoviedb.org/tv/… 链接的源
  // ——也就是绝大多数新接进来的源——都被断言成电影，而下游 tmdb-canonical 只会去 /search/movie
  // 找。剧集因此一条也匹配不上，且不报错：`kind` 表达不出"不知道"，信息在源头就丢了，下游再
  // 聪明也补不回来。留空 = 如实说"不知道"，canonical 会两个索引都问（见 mediaTypes）。
  let kind: VideoLookupIdentity['kind'] | undefined
  const tmdb = sourceUrl?.match(/themoviedb\.org\/(movie|tv)\/(\d+)/i)
  if (tmdb) kind = tmdb[1].toLowerCase() === 'tv' ? 'series' : 'movie'
  const canonical = canonicalIds(sourceUrl, raw, item.videoRef?.kind ?? kind)
  // Wikidata 分索引的 TMDb 编号本身就是 kind 证据（只有 P4983 → 剧集）——比"没有证据就留空"
  // 多一步，但仍然只在别处都答不出 kind 时才采信。
  kind ??= canonical.kindHint
  const metaYear = meta?.year
  // Feed timestamps describe when a ranking entry was published or harvested, not when the
  // work was released. Using them as a search year silently rules out valid TMDb/OMDb matches
  // (for example a current Douban shelf item acquired in 2026). Only a normalizer-provided work
  // year is admissible matching evidence.
  const metaWorkYear = typeof metaYear === 'number' ? metaYear : typeof metaYear === 'string' && /^\d{4}$/.test(metaYear) ? Number(metaYear) : undefined
  const year = item.videoRef?.year ?? metaWorkYear
  const title = item.videoRef?.title?.trim() || item.content?.title?.trim() || item.title
  const people = item.videoRef?.people ?? weeklyPeople(item, raw)
  const poster = item.videoRef?.poster ?? item.content?.media?.find((media) => media.kind === 'image')?.url
  return {
    title,
    ...(item.videoRef?.aliases?.length ? { aliases: item.videoRef.aliases } : {}),
    ...(people?.length ? { people } : {}),
    ...(year ? { year } : {}),
    // 两边都可能没有 → 这一格就整个不出现（`kind?` 本来就是可选的），别落一个空键出去。
    ...((item.videoRef?.kind ?? kind) ? { kind: item.videoRef?.kind ?? kind } : {}),
    ...(poster ? { poster } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    externalIds: { ...canonical.ids, ...(item.videoRef?.externalIds ?? {}) },
  }
}

/** Build a metadata lookup only from the discovery item's own facts. Canonical IDs returned by
 * metadata live with the cached VideoDetail, not as a second item-level mapping workflow. */
export function videoWorkLookupIdentity(item: StreamItem): VideoLookupIdentity {
  const ref = videoItemReference(item)
  return {
    title: ref.title,
    ...(ref.aliases?.length ? { aliases: ref.aliases } : {}),
    ...(ref.year ? { year: ref.year } : {}),
    ...(ref.kind ? { kind: ref.kind } : {}),
    ...(ref.poster ? { poster: ref.poster } : {}),
    ...(ref.sourceUrl ? { sourceUrl: ref.sourceUrl } : {}),
    externalIds: { ...(ref.externalIds ?? {}) },
    ...(ref.people?.length ? { people: ref.people } : {}),
  }
}

/** Build a lookup identity directly from an already-known TMDb id — no Item/Stream needed. The
 *  canonical Provider (video-canonical.ts) fast-paths `externalIds.tmdb`: it skips the title
 *  search and fetches that work's detail to publish the official TMDb title — `title` here is
 *  only a hint, used as a fallback when TMDb is unreachable (and dropped entirely when it is
 *  just the id echoed back). Used by 收藏-by-tmdb-id (a ranking-only work, no Stream) and a
 *  TMDB-search result — both start from exactly this triple and nothing else. */
export function videoTmdbLookupIdentity(ref: { id: string; media: 'movie' | 'tv'; title: string }): VideoLookupIdentity {
  return { title: ref.title, kind: ref.media === 'movie' ? 'movie' : 'series', externalIds: { tmdb: ref.id } }
}

/** Card-safe projection: the detail cache remains the source of truth, while list callers avoid
 * fetching full Provider results one card at a time. */
export function videoDetailPreview(detail: VideoDetail | null): VideoDetailPreview | undefined {
  if (!detail?.metadata) return undefined
  return {
    ...(detail.metadata.title ? { title: detail.metadata.title } : {}),
    ...(detail.metadata.year ? { year: detail.metadata.year } : {}),
    ...(detail.metadata.ratings?.[0]?.value != null ? { rating: detail.metadata.ratings[0].value } : {}),
    ...(detail.images.poster?.url ? { poster: detail.images.poster.url } : {}),
    ...(detail.images.backdrop?.url ? { backdrop: detail.images.backdrop.url } : {}),
  }
}
