import type { VideoCanonicalDiagnostic, VideoCanonicalResult, VideoDetail, VideoImageCandidate, VideoImageResult, VideoLookupIdentity, VideoMetadataResult, VideoPerson, VideoProviderFailure, VideoRating } from './types.ts'
import type { UserStore } from '../store/user-store.ts'
import type { ProviderExecutor } from '../providers/executor.ts'

type ProviderResult = { member: string; value: unknown }

const strings = ['title', 'originalTitle', 'releaseDate', 'certification', 'overview', 'tagline'] as const

function metadataResults(results: ProviderResult[]): VideoMetadataResult[] {
  return results.flatMap((result) => Array.isArray(result.value) ? result.value : [result.value])
    .filter((value): value is VideoMetadataResult => !!value && typeof value === 'object' && typeof (value as VideoMetadataResult).source === 'string' && 'externalIds' in value && !('images' in value))
}

function imageResults(results: ProviderResult[]): VideoImageResult[] {
  return results.flatMap((result) => Array.isArray(result.value) ? result.value : [result.value])
    .filter((value): value is VideoImageResult => !!value && typeof value === 'object' && Array.isArray((value as VideoImageResult).images))
}

function canonicalResult(results: ProviderResult[]): { member: string; value: VideoCanonicalResult } | null {
  for (const result of results) {
    const values = Array.isArray(result.value) ? result.value : [result.value]
    for (const value of values) {
      if (!value || typeof value !== 'object') continue
      const candidate = value as VideoCanonicalResult
      if (typeof candidate.source === 'string' && candidate.externalIds && typeof candidate.externalIds === 'object' && Object.values(candidate.externalIds).some(Boolean)) return { member: result.member, value: candidate }
    }
  }
  return null
}

function unique<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const id = key(value)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

export function videoDetailCacheKey(identity: VideoLookupIdentity): string {
  if (identity.externalIds.tmdb) return `tmdb:${identity.externalIds.tmdb}`
  if (identity.externalIds.imdb) return `imdb:${identity.externalIds.imdb}`
  return `${identity.kind ?? 'unknown'}:${identity.title.trim().toLocaleLowerCase()}:${identity.year ?? ''}`
}

/** Deterministic provider merge: `results` is already ordered by Provider member declaration. */
export function mergeVideoDetail(
  identity: VideoLookupIdentity,
  results: ProviderResult[],
  failures: VideoProviderFailure[],
  fetchedAt: string,
  expiresAt: string,
  resolvedIdentity: VideoLookupIdentity = identity,
  canonical?: VideoCanonicalDiagnostic,
): VideoDetail {
  const values = metadataResults(results)
  const merged: VideoMetadataResult = { source: values[0]?.source ?? 'video-metadata', externalIds: {} }
  for (const value of values) {
    for (const field of strings) if (!merged[field] && value[field]) merged[field] = value[field]
    if (!merged.year && value.year) merged.year = value.year
    if (!merged.runtimeMinutes && value.runtimeMinutes) merged.runtimeMinutes = value.runtimeMinutes
    merged.externalIds = { ...value.externalIds, ...merged.externalIds }
  }
  merged.genres = unique(values.flatMap((value) => value.genres ?? []), (value) => value.toLocaleLowerCase())
  merged.tags = unique(values.flatMap((value) => value.tags ?? []), (value) => value.toLocaleLowerCase())
  merged.people = unique(values.flatMap((value) => value.people ?? []), (value: VideoPerson) => `${value.name.toLocaleLowerCase()}:${value.role}:${value.character ?? ''}`)
  merged.ratings = unique(values.flatMap((value) => value.ratings ?? []), (value: VideoRating) => value.source.toLocaleLowerCase())

  const imageCandidates = unique(
    imageResults(results).flatMap((value) => value.images.map((image) => ({ ...image, source: image.source ?? value.source }))),
    (image) => `${image.kind}:${image.url}`,
  )
  const images: Partial<Record<VideoImageCandidate['kind'], VideoImageCandidate>> = {}
  for (const image of imageCandidates) if (!images[image.kind]) images[image.kind] = image

  return {
    // Keep the key derived from the lookup identity. A title-only Stream learns external IDs only
    // after its first lookup; switching its persisted key to that new ID would make later
    // title-only reads miss the cache forever.
    cacheKey: videoDetailCacheKey(identity),
    identity: { ...resolvedIdentity, externalIds: { ...resolvedIdentity.externalIds, ...merged.externalIds } },
    ...(canonical ? { canonical } : {}),
    metadata: values.length ? merged : undefined,
    images,
    imageCandidates,
    failures,
    fetchedAt,
    expiresAt,
  }
}

export interface VideoDetailServiceDeps {
  store: Pick<UserStore, 'getVideoDetail' | 'putVideoDetail'>
  executor: Pick<ProviderExecutor, 'collect'>
  /** Resolves the user-selected implementation for each stable detail capability. */
  providerFor?: (callsiteId: 'video.detail.canonical' | 'video.detail.metadata' | 'video.detail.images') => string | null
  now?: () => string
  ttlMs?: number
}

export type VideoDetailRead = { detail: VideoDetail; cache: 'hit' | 'miss' | 'refreshed' | 'stale-fallback' }

/** Cache-backed orchestration for the two system detail Providers. This service deliberately
 * accepts an already-derived identity: Stream/item interpretation stays at the HTTP boundary. */
export class VideoDetailService {
  private readonly now: () => string
  private readonly ttlMs: number

  constructor(private readonly deps: VideoDetailServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
    this.ttlMs = deps.ttlMs ?? 7 * 24 * 60 * 60 * 1000
  }

  /** Read an already-enriched work without invoking Providers. List surfaces use this to project
   * cached card fields while prefetch keeps the cache warm in the background. */
  peek(identity: VideoLookupIdentity): VideoDetail | null {
    return this.deps.store.getVideoDetail(videoDetailCacheKey(identity))
  }

  async get(identity: VideoLookupIdentity, opts: { force?: boolean } = {}): Promise<VideoDetailRead> {
    const key = videoDetailCacheKey(identity)
    const cached = this.deps.store.getVideoDetail(key)
    const now = this.now()
    // 自愈两类「不该让 TTL 说了算」的 canonical（都以 identity 带 tmdb id 为前提）：
    //  - resolved 但 title 就是那个 id——旧版 id 快速路径把调用方回显写成了官方名（毒数据，
    //    「55157 (1993) [tmdbid-55157]」这个网盘目录就是它起的名）；
    //  - miss——id 都在手了，miss 只说明当时 TMDb 不可达，不是权威结论。
    // 当过期处理重走 Provider。官方名恰好等于自身 id 的作品会因此永不缓存——影响只是多一次
    // 请求，比放过毒数据便宜得多。
    const cachedTmdbId = cached?.identity.externalIds.tmdb
    const tainted = !!cached?.canonical && !!cachedTmdbId &&
      (cached.canonical.status === 'miss' || cached.canonical.title === cachedTmdbId)
    if (cached && !opts.force && !tainted && cached.expiresAt > now) return { detail: cached, cache: 'hit' }

    const canonicalProvider = this.deps.providerFor?.('video.detail.canonical') ?? 'video-canonical'
    const metadataProvider = this.deps.providerFor?.('video.detail.metadata') ?? 'video-metadata'
    const imagesProvider = this.deps.providerFor?.('video.detail.images') ?? 'video-images'
    const canonical = canonicalProvider ? await this.deps.executor.collect(canonicalProvider, identity) : null
    const resolved = canonicalResult(canonical?.results ?? [])
    const canonicalFailures = this.failures(canonicalProvider || 'video.detail.canonical', canonical)
    const expiresAt = new Date(Date.parse(now) + this.ttlMs).toISOString()
    if (!resolved) {
      const provider = canonicalProvider || 'video.detail.canonical'
      const failures = canonicalFailures.length ? canonicalFailures : [{ provider, member: provider, phase: 'lookup' as const, message: 'no verified canonical identity' }]
      const detail = mergeVideoDetail(identity, [], failures, now, expiresAt, identity, { status: 'miss', provider })
      this.deps.store.putVideoDetail(detail)
      return { detail, cache: cached ? 'refreshed' : 'miss' }
    }

    const canonicalIdentity: VideoLookupIdentity = {
      ...identity,
      ...(resolved.value.kind ? { kind: resolved.value.kind } : {}),
      externalIds: { ...identity.externalIds, ...resolved.value.externalIds },
    }
    const canonicalDiagnostic: VideoCanonicalDiagnostic = {
      status: 'resolved', provider: canonicalProvider || 'video.detail.canonical', member: resolved.member, ...resolved.value,
    }
    const metadata = metadataProvider ? await this.deps.executor.collect(metadataProvider, canonicalIdentity) : null
    const metadataIds = metadataResults(metadata?.results ?? []).reduce<Record<string, string>>(
      (ids, result) => ({ ...ids, ...result.externalIds }), {},
    )
    const imageIdentity: VideoLookupIdentity = { ...canonicalIdentity, externalIds: { ...canonicalIdentity.externalIds, ...metadataIds } }
    const images = imagesProvider ? await this.deps.executor.collect(imagesProvider, imageIdentity) : null
    const failures: VideoProviderFailure[] = [
      ...canonicalFailures,
      ...this.failures(metadataProvider || 'video.detail.metadata', metadata),
      ...this.failures(imagesProvider || 'video.detail.images', images),
    ]
    const results = [...(metadata?.results ?? []), ...(images?.results ?? [])]
    // A normal expired read may keep a last known-good detail when every provider is
    // temporarily unavailable. An explicit refresh is different: it is the user's
    // correction action, so persisting the empty verified result clears a bad match
    // instead of resurrecting it indefinitely.
    if (!results.length && cached && !opts.force) {
      return { detail: { ...cached, failures: [...cached.failures, ...failures] }, cache: 'stale-fallback' }
    }
    const detail = mergeVideoDetail(identity, results, failures, now, expiresAt, imageIdentity, canonicalDiagnostic)
    if (results.length || opts.force) this.deps.store.putVideoDetail(detail)
    return { detail, cache: cached ? 'refreshed' : 'miss' }
  }

  /**
   * 未绑剧集的懒加载分集索引：把投影后的 `{leftKey,title}` 存回该 detail 的缓存（键不变），返回新
   * detail。命中由调用方查 `detail.episodeIndex` 自行短路——这里只负责「写一次」。绝不在此发 TMDb
   * 请求，也绝不接受未投影的原始载荷：投影是调用方（bootstrap 的 fetchEpisodeIndex）的责任。
   */
  cacheEpisodeIndex(detail: VideoDetail, entries: Array<{ leftKey: string; title: string; still?: string; airDate?: string }>): VideoDetail {
    const next: VideoDetail = { ...detail, episodeIndex: { fetchedAt: this.now(), entries } }
    this.deps.store.putVideoDetail(next)
    return next
  }

  /** A capability (canonical/metadata/images) usually fans out to several members and merges
   *  whatever succeeds — one member missing while another covers the same ground is normal,
   *  redundant-source noise, not a visible gap. Only surface misses when the WHOLE capability
   *  came back empty, i.e. nothing is actually missing from what got rendered. */
  private failures(provider: string, outcome: Awaited<ReturnType<ProviderExecutor['collect']>>): VideoProviderFailure[] {
    if (!outcome) return [{ provider, member: provider, phase: 'lookup', message: 'provider is unavailable' }]
    if (outcome.results.length) return []
    return outcome.misses.map((miss) => ({ provider, member: miss.member, phase: 'lookup' as const, message: miss.reason }))
  }
}
