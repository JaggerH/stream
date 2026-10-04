/**
 * Audio resolution — turn a song *reference* (platform + id / title / artist) into a
 * directly-playable audio URL. Feeds (e.g. a music RSSHub route) carry song metadata
 * and a page link but NOT a playable file; a resolver bridges that gap at play time.
 *
 * Multiple providers, tried in order: the official platform path is just ONE of them, so
 * third-party / mirror / search-based providers can be added without touching callers.
 * Resolution is on-demand (audio URLs expire), behind the `/api/audio/resolve` endpoint.
 */

/** What we know about the song to resolve. `id` is the platform's song id (the fast path);
 *  `title`/`artist` let search-based providers resolve when no id is available or it fails. */
export interface TrackRef {
  /** source platform key — 平台键由取歌 Provider 行的 serveKeys 声明 */
  platform: string
  /** platform song id (from the feed item's link), when known */
  id?: string
  title?: string
  artist?: string
  /**
   * 专辑名。**下载链路上这是唯一能拿到它的地方**：下载 provider（按平台派发选出的那条取歌 Provider 行）只解析
   * 播放地址，返回的 item 里没有专辑；而搜索/歌单那一侧早就从 item 的 `专辑：X` 描述里解析出来了
   * （`shared/music/album.ts` 的 `albumFromText`，前后端同一份），前端每一行都带着它。不把它随 ref 一路带下来，写进文件的
   * ID3 里专辑就永远是空的——2026-08-04 活体：新下载的 87 条 `track_asset.album` 全是 NULL。
   */
  album?: string
  /** the song's web page (for providers that scrape / for diagnostics) */
  pageUrl?: string
}

/** A resolved, playable audio location. `headers` are what a proxy must send upstream
 *  (e.g. Referer) if the URL can't be hot-linked directly. */
export interface ResolvedAudio {
  url: string
  format?: string
  bitrate?: number
  headers?: Record<string, string>
  /** the provider that produced it (telemetry / debugging) */
  via?: string
}

/** One resolution strategy. `supports` is a cheap pre-filter; `resolve` does the work and
 *  returns null when this provider can't produce a URL (the chain then tries the next). */
export interface AudioResolver {
  readonly name: string
  supports(ref: TrackRef): boolean
  resolve(ref: TrackRef): Promise<ResolvedAudio | null>
}

/**
 * Run the provider chain: the first supporting provider that yields a non-null result wins.
 * A provider that returns null OR throws is skipped (a flaky provider never blocks the rest).
 * Returns null when nothing resolves.
 */
export async function resolveAudio(ref: TrackRef, providers: AudioResolver[]): Promise<ResolvedAudio | null> {
  for (const p of providers) {
    if (!p.supports(ref)) continue
    try {
      const r = await p.resolve(ref)
      if (r?.url) return { ...r, via: r.via ?? p.name }
    } catch {
      // a flaky provider must not block the fallbacks
    }
  }
  return null
}
