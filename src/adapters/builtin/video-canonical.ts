import type { VideoCanonicalMatchedBy, VideoLookupIdentity, VideoPosterCandidateScore, VideoPosterMatch } from '../../video/types.ts'
import type { BuiltinFn, SourceExecutionContext } from './adapter.ts'
import { tmdbConfig, tmdbJson, type TmdbFetch, type TmdbSourceDeps } from './video-metadata.ts'
import { comparePosterUrls } from '../../video/poster-similarity.ts'

/** Compares two cover URLs; null when either side cannot be downloaded or decoded. */
export type PosterComparer = (sourceUrl: string, candidateUrl: string) => Promise<number | null>

export interface TmdbCanonicalSourceDeps extends TmdbSourceDeps {
  comparePosters?: PosterComparer
}

type TmdbKind = 'movie' | 'tv'
/** A search row, plus its detail once something forced us to fetch one. */
type Candidate = { id: string; row: Record<string, any>; detail?: Record<string, any> }

// Cover comparison runs against w185 thumbnails: the hash downsamples to 32x32 anyway, so the
// 2000px original only buys download time (a full candidate set drops from ~20s to ~4s).
const TMDB_POSTER_COMPARE_BASE = 'https://image.tmdb.org/t/p/w185'
/** Bounds the *expensive* steps (cover comparison, alternative-title re-checks) — never the
 *  search itself: TMDb matches fuzzily, so the exact-title work can sit well down the list
 *  ("痴迷" returns 19 rows whose 3rd and 4th are the same-titled works that matter). */
const CANDIDATE_LIMIT = 10
/** Covers compared per candidate. TMDb carries 200+ for a wide release, so this cap is real;
 *  `orderPosters` puts the likely matches in front of it. */
const POSTER_SCAN_LIMIT = 24
/** Douban dates a work by production/premiere, TMDb by release, so the same film routinely
 *  differs by a year (痴迷: Douban 2025 vs TMDb 2026-05-13). Year is only ever used to choose
 *  between same-titled works — never to filter a search, which would return nothing at all. */
const YEAR_TOLERANCE = 1
/** Measured on real Douban↔TMDb pairs: the same key art re-cut for a local release correlates
 *  0.72–0.99, unrelated works reach at most 0.36. 0.60 sits in that gap with room on both sides. */
const POSTER_THRESHOLD = 0.6
const POSTER_MIN_MARGIN = 0.05

function identityOf(input: unknown): VideoLookupIdentity | null {
  if (!input || typeof input !== 'object') return null
  const value = input as Partial<VideoLookupIdentity>
  if (typeof value.title !== 'string' || !value.title.trim()) return null
  return { ...value, title: value.title, externalIds: value.externalIds ?? {} }
}

function mediaType(identity: VideoLookupIdentity): TmdbKind {
  return identity.kind === 'series' || identity.kind === 'season' || identity.kind === 'episode' ? 'tv' : 'movie'
}

/** Which TMDb indexes to search. `/search/<type>` forces the caller to know the answer up front
 *  — but a discovery row often does NOT (only a themoviedb.org/tv/… URL proves it, and most
 *  sources carry no such URL). `identity.kind` is optional precisely so "unknown" can be said out
 *  loud; treat it as unknown and search BOTH rather than silently narrowing to films.
 *
 *  This is what the miss looked like: an award roster of preschool TV series came in with no
 *  kind, `mediaType` defaulted it to 'movie', and every lookup searched only /search/movie —
 *  no error, just nothing found, while `/search/multi` for the same title returned the series
 *  on the first try. Search is the cheap rung (see searchCandidates); one extra call beats a
 *  guess that fails silently. */
function mediaTypes(identity: VideoLookupIdentity): TmdbKind[] {
  if (identity.kind === undefined || identity.kind === 'unknown') return ['movie', 'tv']
  return [mediaType(identity)]
}

/** How decisive a rung's evidence is — used only to choose between the movie and the tv index
 *  when the identity never said which it was. An id beats a dated title beats a lone title
 *  beats a cover; equal strength keeps the first index tried (movie), so a row that already
 *  resolved as a film keeps resolving as that film. */
const MATCH_STRENGTH: Record<string, number> = { id: 4, 'title-year': 3, 'title-unique': 2, poster: 1 }

function yearOf(value: unknown): number | undefined {
  const match = typeof value === 'string' ? value.match(/^(?:19|20)\d{2}/) : undefined
  return match ? Number(match[0]) : undefined
}

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '') : ''
}

function rows(value: unknown): Record<string, any>[] {
  return Array.isArray(value) ? value.filter((row): row is Record<string, any> => !!row && typeof row === 'object') : []
}

function detailTitles(detail: Record<string, any>, type: TmdbKind): string[] {
  const alternatives = type === 'movie' ? rows(detail.alternative_titles?.titles) : rows(detail.alternative_titles?.results)
  return [detail.title, detail.original_title, detail.name, detail.original_name, ...alternatives.map((row) => row.title)]
    .filter((title): title is string => typeof title === 'string')
}

function hasMatchingTitle(identity: VideoLookupIdentity, detail: Record<string, any>, type: TmdbKind): boolean {
  const wanted = new Set([identity.title, ...(identity.aliases ?? [])].map(normalize).filter(Boolean))
  return detailTitles(detail, type).some((title) => wanted.has(normalize(title)))
}

function candidateYear(detail: Record<string, any>): number | undefined {
  return yearOf(detail.release_date ?? detail.first_air_date)
}

function result(detail: Record<string, any>, type: TmdbKind, fallback: VideoLookupIdentity, matchedBy: VideoCanonicalMatchedBy, posterMatch?: VideoPosterMatch): Record<string, unknown> | null {
  if (detail.id == null) return null
  const title = typeof (type === 'movie' ? detail.title : detail.name) === 'string' ? type === 'movie' ? detail.title : detail.name : fallback.title
  return {
    source: 'tmdb-canonical',
    externalIds: { tmdb: String(detail.id), ...(typeof detail.external_ids?.imdb_id === 'string' && detail.external_ids.imdb_id ? { imdb: detail.external_ids.imdb_id } : {}) },
    kind: type === 'movie' ? 'movie' : 'series', title, ...(candidateYear(detail) ? { year: candidateYear(detail) } : fallback.year ? { year: fallback.year } : {}),
    matchedBy, ...(posterMatch ? { posterMatch } : {}),
  }
}

/** `alternative_titles` carries the localized names an exact-title match needs; `external_ids`
 *  carries the imdb id the result publishes. Credits are not requested — no rung reads them. */
async function detail(fetch: TmdbFetch, id: string, type: TmdbKind, apiKey: string, language?: string): Promise<Record<string, any>> {
  return tmdbJson(fetch, `/${type}/${encodeURIComponent(id)}?append_to_response=alternative_titles,external_ids`, apiKey, language)
}

/** Deliberately unbounded and year-free: the search is the cheap step, and both narrowing
 *  devices are traps. `primary_release_year` drops the right work outright when Douban and TMDb
 *  disagree by a year, and a top-N cut hides same-titled works behind fuzzy ones. */
async function searchCandidates(fetch: TmdbFetch, identity: VideoLookupIdentity, type: TmdbKind, apiKey: string, language?: string): Promise<Candidate[]> {
  const query = new URLSearchParams({ query: identity.title })
  const found = await tmdbJson(fetch, `/search/${type}?${query}`, apiKey, language)
  return rows(found.results).filter((row) => row.id != null).map((row) => ({ id: String(row.id), row }))
}

/** TMDb search matches fuzzily, so "one result" is not "the right result" — querying 痴迷 with a
 *  2024 year returns exactly one row, 她痴迷于我的丈夫, a different film. Every rung below the id
 *  lookup therefore starts from an exact title, never from search relevance.
 *
 *  Search rows only carry the lookup-language title, while a work's Chinese name may live solely
 *  in `alternative_titles` (1339713 is CN:痴迷 but HK/TW:愛你致死不渝). Fetching details for all
 *  19 rows to see those would be wasteful, so details are only pulled when the cheap pass finds
 *  nothing at all. */
async function exactTitleCandidates(fetch: TmdbFetch, identity: VideoLookupIdentity, candidates: Candidate[], type: TmdbKind, apiKey: string, language?: string): Promise<Candidate[]> {
  const cheap = candidates.filter((candidate) => hasMatchingTitle(identity, candidate.row, type))
  if (cheap.length) return cheap
  const checked: Candidate[] = []
  for (const candidate of candidates.slice(0, CANDIDATE_LIMIT)) {
    const full = await detail(fetch, candidate.id, type, apiKey, language)
    if (hasMatchingTitle(identity, full, type)) checked.push({ ...candidate, detail: full })
  }
  return checked
}

/** Same-titled works separated by year: pick the one the discovery row dates to. */
function withinYear(candidates: Candidate[], year: number): Candidate[] {
  return candidates.filter((candidate) => {
    const candidateYear = yearOf(candidate.row.release_date ?? candidate.row.first_air_date)
    return candidateYear != null && Math.abs(candidateYear - year) <= YEAR_TOLERANCE
  })
}

/** Put the covers most likely to match the discovery row in front of POSTER_SCAN_LIMIT: a
 *  localized one-sheet matches TMDb's cover for the same locale first, and the untagged art
 *  next. Ordering rather than filtering is deliberate — filtering to `zh,null` discarded the
 *  only matching cover for works whose art is tagged some other way, and rejected them. */
function orderPosters(posters: Record<string, any>[], language?: string): Record<string, any>[] {
  const region = (language ?? '').split('-')[0]
  const rank = (poster: Record<string, any>) => (region && poster.iso_639_1 === region ? 0 : poster.iso_639_1 == null ? 1 : 2)
  return posters.map((poster, index) => ({ poster, index })).sort((left, right) => rank(left.poster) - rank(right.poster) || left.index - right.index)
    .map((entry) => entry.poster)
}

async function candidatePosters(fetch: TmdbFetch, id: string, type: TmdbKind, apiKey: string, language?: string): Promise<string[]> {
  // No `language`/`include_image_language`: both narrow /images to one exact tag.
  const images = await tmdbJson(fetch, `/${type}/${encodeURIComponent(id)}/images`, apiKey)
  return orderPosters(rows(images.posters), language)
    .map((poster) => poster.file_path)
    .filter((path): path is string => typeof path === 'string' && !!path)
    .slice(0, POSTER_SCAN_LIMIT)
}

async function scoreCandidate(fetch: TmdbFetch, compare: PosterComparer, poster: string, candidate: Candidate, type: TmdbKind, apiKey: string, language?: string): Promise<VideoPosterCandidateScore> {
  const raw = candidate.row
  const title = typeof (type === 'movie' ? raw.title : raw.name) === 'string' ? (type === 'movie' ? raw.title : raw.name) : undefined
  const paths = await candidatePosters(fetch, candidate.id, type, apiKey, language)
  const scores = (await Promise.all(paths.map((path) => compare(poster, `${TMDB_POSTER_COMPARE_BASE}${path}`))))
    .filter((score): score is number => score != null)
  return { tmdbId: candidate.id, ...(title ? { title } : {}), compared: scores.length, score: scores.length ? Math.max(...scores) : null }
}

/** The tie-breaker: only reached once the textual evidence has failed to single a work out.
 *  A winner must clear the threshold AND out-score the runner-up, otherwise nothing is admitted —
 *  an undecidable cover never falls back to a title guess. */
async function posterCandidate(fetch: TmdbFetch, compare: PosterComparer, identity: VideoLookupIdentity, candidates: Candidate[], type: TmdbKind, apiKey: string, language?: string): Promise<{ candidate: Candidate; posterMatch: VideoPosterMatch } | null> {
  if (!identity.poster || !candidates.length) return null
  const batch = candidates.slice(0, CANDIDATE_LIMIT)
  const scored: VideoPosterCandidateScore[] = []
  for (const candidate of batch) scored.push(await scoreCandidate(fetch, compare, identity.poster, candidate, type, apiKey, language))
  const ranked = scored.filter((row): row is VideoPosterCandidateScore & { score: number } => row.score != null)
    .sort((left, right) => right.score - left.score)
  const [winner, runnerUp] = ranked
  const posterMatch: VideoPosterMatch = {
    threshold: POSTER_THRESHOLD, minMargin: POSTER_MIN_MARGIN, score: winner?.score ?? 0,
    ...(runnerUp ? { runnerUp: runnerUp.score } : {}), candidates: scored,
  }
  if (!winner || winner.score < POSTER_THRESHOLD) return null
  if (runnerUp && winner.score - runnerUp.score < POSTER_MIN_MARGIN) return null
  const chosen = batch.find((candidate) => candidate.id === winner.tmdbId)
  return chosen ? { candidate: chosen, posterMatch } : null
}

/** Resolves the discovery row against TMDb by ascending cost, stopping at the first rung whose
 *  evidence singles out exactly one work:
 *
 *    an authority id            → use it
 *    exact title, one match     → accept when the year agrees (±1)
 *    exact title, several       → let the year choose between them
 *    still undecided            → compare covers, among the exact-title works
 *    no exact title at all      → compare covers, among the fuzzy rows
 *    nothing decisive           → decline
 *
 *  Covers are the tie-breaker, not the gate. Downloading them to confirm a work the title and
 *  year already single out costs seconds and, worse, rejects perfectly good matches whenever the
 *  two sites happen to ship different art. Credits are not consulted at any rung: a localized
 *  row's cast names rarely align with TMDb's, and they are exactly what the covers replaced. */
export function makeTmdbCanonicalFn(deps: TmdbCanonicalSourceDeps = {}): BuiltinFn {
  return async (input, _params, context?: SourceExecutionContext) => {
    const identity = identityOf(input)
    if (!identity) return []
    // 仅供下面「TMDb 不可达时的降级发布」用——那条路拿不到 TMDb 的回答，只能沿用调用方给的
    // kind（未知时仍落到 movie）。真正的查询路径不再用它，各自按 mediaTypes 决定搜哪些索引。
    const type = mediaType(identity)
    const settings = tmdbConfig(deps, context)
    if (identity.externalIds.tmdb) {
      const id = identity.externalIds.tmdb
      // canonical.title 是下游命名（网盘目录、绑定左侧）的权威，必须是 TMDb 官方名。调用方传来的
      // title 只是提示——tmdb:<id> 详情路径没带提示时它就是 id 本身。所以 id 在手也要拉一次
      // detail 核实；拉不到时提示可用（非 id 回显）才降级发布，否则宁可 miss——
      // status=resolved 必须等价于「官方名已核实或至少有个真名」。
      // 同一个 id 在 /movie 和 /tv 下是两部不同的作品，所以 kind 未知时不能挑一个试——两个都试，
      // 命中的那个就是答案（错的那个 404，被 catch 掉）。
      if (settings?.tmdbApiKey) {
        for (const t of mediaTypes(identity)) {
          try {
            const full = await detail(deps.fetch ?? globalThis.fetch.bind(globalThis), id, t, settings.tmdbApiKey, settings.language ?? 'zh-CN')
            const canonical = result(full, t, identity, 'id')
            if (canonical) return [canonical]
          } catch { /* 这个索引下没有这个 id（或 TMDb 不可达）→ 试下一个 / 走降级判定 */ }
        }
      }
      if (identity.title.trim() && identity.title !== id) {
        return [{ source: 'tmdb-canonical', externalIds: { tmdb: id, ...(identity.externalIds.imdb ? { imdb: identity.externalIds.imdb } : {}) }, kind: type === 'movie' ? 'movie' : 'series', title: identity.title, ...(identity.year ? { year: identity.year } : {}), matchedBy: 'id' }]
      }
      return []
    }
    if (!settings?.tmdbApiKey) return []
    const apiKey = settings.tmdbApiKey
    const fetch = deps.fetch ?? globalThis.fetch.bind(globalThis)
    // Canonical lookup starts from the discovery row's localized title. The manifest default
    // is zh-CN, but absent runtime values do not carry that default into a Source execution.
    const language = settings.language ?? 'zh-CN'
    if (identity.externalIds.imdb) {
      // /find 一次就把两个索引的命中都带回来了（movie_results / tv_results），所以 kind 未知时
      // 读哪一格是本地判断，不用多打一次请求。
      const found = await tmdbJson(fetch, `/find/${encodeURIComponent(identity.externalIds.imdb)}?external_source=imdb_id`, apiKey, language)
      for (const t of mediaTypes(identity)) {
        const foundDetail = rows(found[t === 'movie' ? 'movie_results' : 'tv_results'])[0]
        const canonical = foundDetail && result({ ...foundDetail, external_ids: { imdb_id: identity.externalIds.imdb } }, t, identity, 'id')
        if (canonical) return [canonical]
      }
      // /find 空手而归 = TMDb 这一侧没登记这个 IMDb 号（它自己那条记录的 imdb_id 是 null，或者
      // 记的是另一个号）。**这不是"这部作品不存在"，只是这条捷径不通** —— 往下走片名那条梯子，
      // 它可能一查就中（实测 Monster Café：/find 空，片名搜到唯一一部 tv 15417）。
      //
      // 以前这里直接 return []，于是**多一个 id 反而比没有 id 更糟**：一条只有片名的行会正常走
      // 梯子，同一行加上一个 TMDb 不认识的 IMDb 号反倒直接 miss。多一份证据永远不该让结果更差。
      //
      // 上面 tmdb-id 那条分支没有跟着改：它的两个索引都 404 时会先走"降级发布"（拿调用方的标题
      // 当真名），那条路是给「TMDb 不可达」准备的，和这里的语义不是一回事，动它得单独判。
    }

    // Wikidata 的编号兑换不在这里发生：采集时 recipe 自己带着 Q 号去问过了（wikipedia 包的
    // hops），换来的 TMDb/IMDb 编号早就落在 item 上，走的就是上面那两条 id fast-path。
    // externalIds.wikidata 仍会出现——它只是身份证据（enrich-queue 拿它判"新证据"），
    // 这一层不再拿它发任何请求。

    /** The title→cover ladder against ONE TMDb index. Unchanged from when `type` was decided
     *  once up front; it is a parameter now only so an identity that never said movie-or-series
     *  can run it against both (see mediaTypes). */
    const resolveIn = async (type: TmdbKind): Promise<Record<string, unknown>[]> => {
      const emit = async (candidate: Candidate, matchedBy: VideoCanonicalMatchedBy, posterMatch?: VideoPosterMatch) => {
        const full = candidate.detail ?? await detail(fetch, candidate.id, type, apiKey, language)
        const canonical = result(full, type, identity, matchedBy, posterMatch)
        return canonical ? [canonical] : []
      }

      const candidates = await searchCandidates(fetch, identity, type, apiKey, language)
      if (!candidates.length) return []
      const exact = await exactTitleCandidates(fetch, identity, candidates, type, apiKey, language)

      // Without a year there is nothing to corroborate a lone exact title with, and a title alone
      // is not enough to write an authority id — such a row goes to the covers like any other.
      if (identity.year && exact.length) {
        const dated = withinYear(exact, identity.year)
        if (exact.length === 1 && dated.length === 1) return emit(exact[0], 'title-unique')
        if (exact.length > 1 && dated.length === 1) return emit(dated[0], 'title-year')
      }

      const pool = exact.length ? exact : candidates
      const matched = await posterCandidate(fetch, deps.comparePosters ?? comparePosterUrls, identity, pool, type, apiKey, language)
      return matched ? emit(matched.candidate, 'poster', matched.posterMatch) : []
    }

    const types = mediaTypes(identity)
    if (types.length === 1) return resolveIn(types[0])
    // Kind unknown: ask both indexes and keep the stronger evidence rather than picking an order
    // and calling it the answer — that ordering IS the bug this replaces.
    const both = await Promise.all(types.map((t) => resolveIn(t)))
    const strength = (r: Record<string, unknown>[]) =>
      r.length ? (MATCH_STRENGTH[String(r[0].matchedBy)] ?? 0) : 0
    return both.reduce((best, current) => (strength(current) > strength(best) ? current : best), [])
  }
}
