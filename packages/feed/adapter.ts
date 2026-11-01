import { safeFetchResponse } from '../../src/adapters/safe-fetch.ts'
import type { Adapter, AdapterFetchResult } from '../../src/adapters/types.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'
import { parseFeed } from './parse.ts'

/**
 * `feed` adapter — subscribe to an RSS 2.0 / Atom feed URL directly: the server fetches
 * and parses the feed document itself. No browser, no extension, no device — an ordinary
 * outbound HTTP GET through the same SSRF/caller guard every server-side fetch uses
 * (`safeFetchResponse`, the transport of read_url's gate).
 *
 * Each entry is one item whose identity is the FEED's own per-entry guid/id (parse.ts), so
 * a feed that publishes a new entry yields exactly one new item on the next harvest.
 *
 * The fetcher is INJECTED with this same module function as the default; tests inject to
 * serve fixture documents and to observe the guard without a real network.
 */
export class FeedAdapter implements Adapter {
  readonly id = 'feed'
  constructor(
    private readonly fetchDoc: (url: string) => Promise<string> = defaultFetchDoc,
  ) {}

  async init(_env: Record<string, string>): Promise<void> {}

  async fetch(params: Record<string, unknown>, _manifest: SourceManifest): Promise<AdapterFetchResult> {
    const url = String(params.url ?? '').trim()
    if (!url) throw new Error('[feed] fetch needs a `url` param (the RSS/Atom feed address)')
    const xml = await this.fetchDoc(url)
    const parsed = parseFeed(xml)
    if (parsed.items.length === 0) {
      // A document that parses to nothing is almost always not a feed (an HTML page, an
      // error page) — say so instead of emitting a silent empty timeline.
      throw new Error(`[feed] ${url}: no RSS <item> or Atom <entry> found — is this a feed URL?`)
    }
    return {
      items: parsed.items.map((e) => ({
        guid: e.guid,
        ...(e.link ? { link: e.link } : {}),
        ...(e.title ? { title: e.title } : {}),
        ...(e.description ? { description: e.description } : {}),
        ...(e.pubDate ? { pubDate: e.pubDate } : {}),
        ...(e.author ? { author: e.author } : {}),
      })),
      // 报 feed 的频道名，订阅时流名自动填好（scheduler → backfillLabel）；空不报。
      title: parsed.title?.trim() || undefined,
    }
  }
}

/** Default transport: the shared guarded server-side fetch (SSRF baseline + the caller
 *  fetch guard when active). A guard rejection propagates (it IS the answer); any other
 *  null (non-2xx, timeout, redirect to a private host, over-cap size) becomes an error. */
const defaultFetchDoc = async (url: string): Promise<string> => {
  const res = await safeFetchResponse(url, { maxBytes: 5_000_000, timeoutMs: 15_000 })
  if (!res) throw new Error(`[feed] ${url}: fetch failed (not public http(s), timeout, or non-2xx)`)
  return res.text()
}
