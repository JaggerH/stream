import type { BrowserContext } from 'playwright-core'
import { parseCookieHeader } from './cookies.ts'
import type { ReplayLauncher, ReplayPage } from './browser-fetch.ts'

/**
 * AUTHORING ONLY — the harvest runtime does not come through here.
 *
 * Harvesting runs in the user's own Chrome over the extension relay (`browser-ext.ts` →
 * `transport.ts`). This file is the other, human-driven half: the recon/validate CLIs
 * (`scripts/recipe-capture.ts`, `record validate`) need *a* Playwright handle on *a* browser
 * while a developer sits at a terminal, and `connectOverCDP` gives them one without Stream
 * owning a browser at all.
 *
 * Stream used to launch CloakBrowser here — a third-party prebuilt Chromium (~206 MB baked into
 * the image, ~715 MB RSS/instance) holding the user's session on a Stream-managed profile. That
 * whole apparatus existed to look like a real user's browser to a login-gated site. It is gone:
 * the user's OWN Chrome *is* a real user's browser, so nothing has to be faked, downloaded,
 * profile-managed or fingerprint-matched.
 *
 * The developer starts that Chrome themselves, once, on a non-default profile (M136+ refuses
 * --remote-debugging-port on the default user-data-dir):
 *
 *   chrome --user-data-dir="D:\stream-chrome" --remote-debugging-port=9333
 *
 * and points these tools at it with STREAM_AUTHORING_CDP_URL (default http://127.0.0.1:9333).
 * The CDP endpoint is an attack surface: bind it to loopback, their-machine-only.
 */

export const DEFAULT_AUTHORING_CDP_URL = 'http://127.0.0.1:9333'

/** Where the authoring tools look for the developer's own debuggable Chrome. */
export function authoringCdpUrl(): string {
  return process.env.STREAM_AUTHORING_CDP_URL || DEFAULT_AUTHORING_CDP_URL
}

export interface CookieInjection {
  /** raw "a=b; c=d" Cookie header (optional — the connected Chrome usually already has the login) */
  cookieHeader?: string
  /** domain to scope injected cookies to (required if cookieHeader is set) */
  cookieDomain?: string
}

/**
 * Attach to the developer's already-running Chrome and return its default (logged-in) context.
 * Nothing is launched, so nothing has to be installed — and the context carries whatever the
 * developer is actually logged into, which is what a login-gated capture needs.
 */
export async function connectAuthoringContext(
  opts: CookieInjection & { cdpUrl?: string } = {},
): Promise<BrowserContext> {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.connectOverCDP(opts.cdpUrl ?? authoringCdpUrl())
  const ctx = browser.contexts()[0] ?? (await browser.newContext())
  await injectCookies(ctx, opts)
  return ctx
}

/**
 * Put a caller-supplied Cookie header into the context's jar. Only needed when capturing as a
 * session the connected browser is NOT logged into; re-adding an existing cookie is an
 * overwrite, not a duplicate (addCookies is keyed by name/domain/path).
 */
export async function injectCookies(ctx: BrowserContext, opts: CookieInjection): Promise<void> {
  if (opts.cookieHeader && opts.cookieDomain) {
    await ctx.addCookies(parseCookieHeader(opts.cookieHeader, opts.cookieDomain))
  }
}

/**
 * connectOverCDP launcher for the authoring replay (`record validate`): every launch() opens
 * its own tab in the connected browser and forces it fully active — Emulation.
 * setFocusEmulationEnabled + Page.setWebLifecycleState('active') — so a backgrounded tab keeps
 * rendering and scroll-loading while the developer watches. close() closes ONLY the tab it
 * opened; it NEVER closes the developer's browser.
 */
export function makeCdpLauncher(cdpUrl: string = authoringCdpUrl()): ReplayLauncher {
  let ctxP: Promise<BrowserContext> | undefined
  const ctxOf = () => (ctxP ??= connectAuthoringContext({ cdpUrl }))
  return {
    async launch(entryUrl: string, waitUntil?: string) {
      const ctx = await ctxOf()
      let page
      try {
        page = await ctx.newPage()
        const session = await ctx.newCDPSession(page)
        // force the tab to behave as foreground even when backgrounded — see doc above
        await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
        await session.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
        const wait = (waitUntil ?? 'domcontentloaded') as 'commit' | 'domcontentloaded' | 'load' | 'networkidle'
        await page.goto(entryUrl, { waitUntil: wait })
      } catch (err) {
        await page?.close().catch(() => {})
        throw err
      }
      return {
        page: page as unknown as ReplayPage,
        rawPage: page,
        // close ONLY our tab — never the developer's browser
        close: async () => { await page.close().catch(() => {}) },
      }
    },
  }
}
