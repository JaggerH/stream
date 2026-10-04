/**
 * Authoring-time XHR capture. Drives a browser context, records the JSON responses
 * the page fires on load, and returns them for a human/skill to pick the data
 * endpoint from. Authoring only — never on the runtime path.
 */

export interface CapturedXhr {
  url: string
  method: string
  status: number
  requestHeaders: Record<string, string>
  requestBody?: string
  json: unknown
}

/** The page sliver capture drives. Beyond `goto`, the diagnostic methods are optional so a
 *  test fake stays trivial — a capture that returns nothing is usually a page you must SEE
 *  (login wall / verify interstitial), not an endpoint you guessed wrong. */
export interface CapturePage {
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>
  screenshot?(opts: { path: string }): Promise<unknown>
  url?(): string
  title?(): Promise<string>
}

/** The sliver of a browser context capture needs — a real Playwright context satisfies it. */
export interface CaptureContext {
  onResponse(cb: (r: CapturedXhr) => void): void
  newPage(): Promise<CapturePage>
  close(): Promise<void>
}

/** wait helper injected so tests don't actually sleep */
export interface CaptureDeps {
  settle: (ms: number) => Promise<void>
}

const realDeps: CaptureDeps = { settle: (ms) => new Promise((r) => setTimeout(r, ms)) }

/**
 * Navigate to entryUrl, collect every JSON XHR fired during load + a short settle,
 * dedup by method+url (last write wins), and return them. Pure over the injected
 * CaptureContext, so unit-tested with a fake that emits canned responses.
 */
export async function captureXhr(
  ctx: CaptureContext,
  entryUrl: string,
  opts: { settleMs?: number; warmUrl?: string; warmMs?: number; shotPath?: string } = {},
  deps: CaptureDeps = realDeps,
): Promise<CapturedXhr[]> {
  const byKey = new Map<string, CapturedXhr>()
  ctx.onResponse((r) => byKey.set(`${r.method} ${r.url}`, r))
  try {
    const page = await ctx.newPage()
    // Some SPAs won't serve a cold deep-link: douyin's /search page renders nothing and
    // fires no data XHR unless the origin was visited first (its JS mints the __ac_* tokens
    // on the homepage). warmUrl visits the origin in the SAME page before the real entry.
    if (opts.warmUrl) {
      await page.goto(opts.warmUrl, { waitUntil: 'commit' })
      await deps.settle(opts.warmMs ?? 5000)
    }
    // 'commit' avoids SPA domcontentloaded stalls; the settle window lets the
    // page's JS run and fire its data XHRs.
    await page.goto(entryUrl, { waitUntil: 'commit' })
    await deps.settle(opts.settleMs ?? 1500)
    if (opts.shotPath && page.screenshot) {
      await page.screenshot({ path: opts.shotPath }).catch(() => {})
      console.log(`[capture] ${page.url?.() ?? entryUrl} — "${await page.title?.().catch(() => '?')}" → ${opts.shotPath}`)
    }
    return [...byKey.values()]
  } finally {
    await ctx.close().catch(() => {})
  }
}

/**
 * Real capture context over the developer's own debuggable Chrome (connectOverCDP — see
 * browser.ts): listens for JSON responses and adapts them to CapturedXhr. That browser already
 * carries the developer's logins, so a login-gated capture usually needs nothing extra; the
 * cookie options remain for capturing as a session it is NOT logged into.
 */
export async function makeCaptureContext(
  opts: { cookieHeader?: string; cookieDomain?: string; cdpUrl?: string } = {},
): Promise<CaptureContext> {
  const { connectAuthoringContext } = await import('./browser.ts')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = (await connectAuthoringContext(opts)) as any
  const listeners: Array<(r: CapturedXhr) => void> = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx.on('response', async (resp: any) => {
    try {
      const headers = resp.headers()
      if (!/application\/json/i.test(headers['content-type'] ?? '')) return
      let json: unknown
      try { json = await resp.json() } catch { return }
      const req = resp.request()
      const captured: CapturedXhr = {
        url: resp.url(),
        method: req.method(),
        status: resp.status(),
        requestHeaders: req.headers(),
        requestBody: req.postData() ?? undefined,
        json,
      }
      for (const l of listeners) l(captured)
    } catch { /* ignore a body we can't read */ }
  })
  // Track the tabs WE opened so close() takes only those. The browser is the developer's, and
  // closing its context would take their other tabs down with the capture.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ours: any[] = []
  return {
    onResponse(cbFn) { listeners.push(cbFn) },
    newPage: async () => {
      const page = await ctx.newPage()
      ours.push(page)
      return page
    },
    close: async () => { await Promise.all(ours.map((p) => p.close().catch(() => {}))) },
  }
}
