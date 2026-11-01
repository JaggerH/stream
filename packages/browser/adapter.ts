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

/** Anti-flood cap: a page whose normalized text still differs on every render must not emit
 *  one timeline item per harvest. These bounds let such a page contribute at most 10 items per
 *  rolling hour (the manifest cadence is 3600s, so even a page that changes every tick is
 *  capped at ~10/day-of-change notifications per hour window). */
const CAP_WINDOW_MS = 3_600_000
export { CAP_WINDOW_MS }
const CAP_MAX_EMISSIONS = 10

/** The adapter keeps NO durable state: the cap memory and the last-seen digest are in-process
 *  only (same tier as the adapter request cache). Losing them on restart is safe — the item
 *  identity (url + content digest) makes a repeated emission land on an id dedup already has,
 *  so a restart can produce at most a no-op, never a duplicate item. */
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
 * a substantive change to the normalized body text yields exactly one new item, no change
 * yields none (a title-only rewrite is noise, not a change). Subject to the emission cap.
 *
 * The renderer is INJECTED and there is no default. Stream owns no browser of its own to fall
 * back on: rendering happens in the user's Chrome over the extension relay, wired in bootstrap
 * (which is also where "is that browser even up?" is answered). An adapter that quietly
 * launched its own second browser is exactly what this rung must not do.
 */
export class BrowserAdapter implements Adapter {
  readonly id = 'browser'
  private readonly now: () => number
  /** last digest EMITTED per url; only emissions update it, so a cap-suppressed change is
   *  not swallowed forever — it becomes the "next change" once the window slides */
  private readonly lastEmitted = new Map<string, string>()
  private readonly emissions = new Map<string, number[]>()
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
    if (this.lastEmitted.get(url) === digest) return { items: [] } // unchanged: nothing to report
    if (!this.takeEmissionSlot(url)) return { items: [] } // over the anti-flood cap: stay silent
    this.lastEmitted.set(url, digest)
    return {
      items: [{ ...item, guid: `${url}#${digest}` }],
      title: page.title.trim() || undefined,
    }
  }

  /** One emission slot per changed-content harvest, bounded to CAP_MAX_EMISSIONS per page per
   *  rolling CAP_WINDOW_MS. Over the cap the change is NOT queued: the next allowed emission
   *  reports whatever the page shows then (latest content wins, stale changes are dropped). */
  private takeEmissionSlot(url: string): boolean {
    const now = this.now()
    const recent = (this.emissions.get(url) ?? []).filter((t) => now - t < CAP_WINDOW_MS)
    if (recent.length >= CAP_MAX_EMISSIONS) {
      this.emissions.set(url, recent)
      return false
    }
    recent.push(now)
    this.emissions.set(url, recent)
    return true
  }
}

function isTracked(params: Record<string, unknown>): boolean {
  return params.track_changes === true || params.track_changes === 'true'
}
