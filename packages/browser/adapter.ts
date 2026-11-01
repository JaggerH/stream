import { createHash } from 'crypto'
import type { Adapter, AdapterFetchResult } from '../../src/adapters/types.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

/** A rendered web page, the raw shape the browser adapter emits (one item per page). */
export interface RenderedPage {
  url: string
  title: string
  text: string
  html: string
}

/** Renders a URL to its loaded DOM. Injected so tests don't launch a real browser. */
export interface PageRenderer {
  render(url: string): Promise<RenderedPage>
}

/**
 * Collapse whitespace and strip text that changes on every render without being content:
 * absolute dates/times and relative-age phrases ("3 min ago", "更新于 5 分钟前"). Deliberately
 * conservative — a changelog's version numbers and dates INSIDE sentences are content, so only
 * standalone timestamp-shaped spans are removed, and whatever slips through is contained by the
 * emission cap rather than by more aggressive stripping.
 */
export function normalizePageText(text: string): string {
  return text
    .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, ' ') // 2026-11-01, 2026/11/1
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ') // 10:00, 10:00:00
    .replace(/\b\d{1,2}\s*(?:sec|second|min|minute|hour|day|week|month)s?\s*ago\b/gi, ' ')
    .replace(/\b(?:just\s*now|today|yesterday)\b/gi, ' ')
    .replace(/(?:\d+|[几半一两二三两俩三四五六七八九十百千万]+)\s*(?:秒|分钟|小时|天|周|个月|月|年)前/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Digest of a page's normalized body text — the content half of a tracked item's identity. */
function contentDigest(text: string): string {
  return createHash('sha256').update(normalizePageText(text)).digest('hex').slice(0, 16)
}

/** Anti-flood cap, sized against the manifest's cadence: cadence_hint_seconds is 3600, so a
 *  page is harvested AT MOST ~24 times a day — an hourly cap could never bind. A rolling 24h
 *  window with 6 slots bounds a page that renders differently every tick to ≤6 notifications a
 *  day (a quarter of the possible harvests), while a genuinely active changelog publishing
 *  several updates a day still fits; anything tighter would drop real same-day changes until
 *  the window slides, anything looser stops being flood protection. The cap counts NEW digests
 *  only: a digest this url has emitted before is re-emitted freely (no slot) — per-stream dedup
 *  swallows what each stream already has, so a repeat only ever serves streams that joined
 *  after that content was current. */
const CAP_WINDOW_MS = 86_400_000
export { CAP_WINDOW_MS }
const CAP_MAX_NEW_DIGESTS = 6

/** The adapter's tracking memory is IN-PROCESS state, one instance per engine (same tier as
 *  the adapter request cache): it only shapes the anti-flood budget, never item identity.
 *  Item identity is `url#<digest>`, so a restart can at worst spend the fresh cap budget on
 *  content each stream's dedup already has (a no-op per stream), never duplicate an item. */
export interface BrowserAdapterOptions {
  /** injectable clock for cap-window tests */
  now?: () => number
}

/**
 * `browser` adapter — the universal failover last rung. A source with `adapter: browser`
 * and a `url` param renders that page and returns it as a single raw item. Just another
 * adapter, so creds/cache/dedup wiring is unchanged.
 *
 * By default the item identity is the page address: one snapshot per page, later changes
 * produce nothing. With `track_changes: true` the identity becomes `url#<content digest>`:
 * every harvest emits the current content under that identity and each stream's dedup decides
 * whether it is new — so two streams may watch the same url and each gets its own baseline,
 * and a substantive change to the normalized body text yields exactly one new item per stream.
 * A title-only rewrite is noise, not a change (same digest). New digests are subject to the
 * per-page anti-flood cap; already-seen digests are not.
 *
 * The renderer is INJECTED and there is no default. Stream owns no browser of its own to fall
 * back on: rendering happens in the user's Chrome over the extension relay, wired in bootstrap
 * (which is also where "is that browser even up?" is answered). An adapter that quietly
 * launched its own second browser is exactly what this rung must not do.
 */
export class BrowserAdapter implements Adapter {
  readonly id = 'browser'
  private readonly now: () => number
  /** every digest this url has EVER emitted (cap exemption + restart independence) */
  private readonly seenDigests = new Map<string, Set<string>>()
  /** when each NEW digest was emitted, for the rolling cap window */
  private readonly newDigestTimes = new Map<string, number[]>()
  constructor(private readonly renderer: PageRenderer, opts: BrowserAdapterOptions = {}) {
    this.now = opts.now ?? Date.now
  }

  async init(_env: Record<string, string>): Promise<void> {}

  async fetch(params: Record<string, unknown>, _manifest: SourceManifest): Promise<AdapterFetchResult> {
    const url = String(params.url ?? '').trim()
    if (!url) throw new Error('[browser] fetch needs a `url` param')
    const page = await this.renderer.render(url)
    const item = { guid: page.url, url: page.url, title: page.title, text: page.text }
    if (!isTracked(params)) {
      return {
        items: [item],
        // 这条流 = 这一个页面，所以页面标题就是流的名字。报上去，订阅时名字自动填好
        // （scheduler → backfillLabel）；空标题不报，占位名比空名字好。
        title: page.title.trim() || undefined,
      }
    }
    const digest = contentDigest(page.text)
    if (this.seenDigests.get(url)?.has(digest)) {
      // content already emitted under this identity: re-emit freely, each stream's dedup
      // swallows what it has; this costs no cap slot
      return { items: [{ ...item, guid: `${url}#${digest}` }], title: page.title.trim() || undefined }
    }
    if (!this.takeNewDigestSlot(url, digest)) return { items: [] } // over the anti-flood cap
    return {
      items: [{ ...item, guid: `${url}#${digest}` }],
      title: page.title.trim() || undefined,
    }
  }

  /** One cap slot per NEW digest, bounded to CAP_MAX_NEW_DIGESTS per page per rolling
   *  CAP_WINDOW_MS. Over the cap the change is NOT queued and NOT memorized: the next allowed
   *  slot reports whatever the page shows then (latest content wins, stale changes are
   *  dropped). A suppressed digest stays unseen, so once the window slides it is emitted —
   *  unless the page has moved on again, in which case only the newest content ever reports. */
  private takeNewDigestSlot(url: string, digest: string): boolean {
    const now = this.now()
    const recent = (this.newDigestTimes.get(url) ?? []).filter((t) => now - t < CAP_WINDOW_MS)
    if (recent.length >= CAP_MAX_NEW_DIGESTS) {
      this.newDigestTimes.set(url, recent)
      return false
    }
    const seen = this.seenDigests.get(url) ?? new Set<string>()
    seen.add(digest)
    this.seenDigests.set(url, seen)
    recent.push(now)
    this.newDigestTimes.set(url, recent)
    return true
  }
}

function isTracked(params: Record<string, unknown>): boolean {
  return params.track_changes === true || params.track_changes === 'true'
}
