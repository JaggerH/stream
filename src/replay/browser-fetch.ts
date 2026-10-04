import { interpret, ReplayDriftError, substitute, type InterpretDeps, type MappedItem, type ResolvedFetch } from './interpret.ts'
import type { FetchRecipe } from './recipe.ts'
import type { PageDriver } from './actions.ts'
import type { GroupTab } from '../../shared/browser-relay/relay.ts'

/** The sliver of Playwright's Page we depend on — real Page satisfies this. */
export interface ReplayPage {
  evaluate<T>(fn: (arg: ResolvedFetch) => T | Promise<T>, arg: ResolvedFetch): Promise<T>
}

/**
 * A fetchInPage that runs the request via the PAGE's own fetch — so the site's own
 * JS signs it (X-s/X-t for xhs) — then returns the parsed JSON body. Non-JSON
 * (a login-wall or block page) throws, surfacing as a miss in the resolve ladder.
 */
export function buildInPageFetch(page: ReplayPage): InterpretDeps['fetchInPage'] {
  return async (req: ResolvedFetch) => {
    const { status, text } = await page.evaluate(async (r): Promise<{ status: number; text: string }> => {
      const resp = await fetch(r.url, {
        method: r.method,
        headers: r.headers,
        body: r.body,
        credentials: 'include',
      })
      return { status: resp.status, text: await resp.text() }
    }, req)
    try {
      return JSON.parse(text)
    } catch {
      // A non-JSON body (login-wall / block page) is drift, not a transient blip —
      // surface it as ReplayDriftError so it classifies + quarantines correctly.
      throw new ReplayDriftError(`in-page fetch returned non-JSON (HTTP ${status}) — likely a login-wall or block`, 0)
    }
  }
}

/** Creates a page whose context, cookies, and entry-URL navigation are already done. */
export interface ReplayLauncher {
  /**
   * Optional: how to build a browser-recipe PageDriver from this launcher's `rawPage`.
   * The authoring Playwright launcher omits it (runBrowserRecipe defaults to makePageDriver
   * over a Playwright Page); the ext-cdp launcher supplies an evaluate+CDP-Input driver since
   * its rawPage is not a Playwright Page.
   */
  driverFactory?: (rawPage: unknown) => PageDriver
  /**
   * `opts.interactive`: true → a foreground tab in the user's current window, joined to the
   * visible session tab group (scroll / render / trusted input); false/omitted → a lightweight
   * background tab, opened and closed per harvest. The authoring launcher ignores it.
   */
  launch(entryUrl: string, waitUntil?: string, opts?: { interactive?: boolean }): Promise<{ page: ReplayPage; rawPage?: unknown; close: () => Promise<void> }>
  /** The tabs in the session tab group — what `adopt` may ride. Absent = this launcher cannot adopt. */
  listTabs?(): Promise<GroupTab[]>
  /**
   * Ride an existing group tab (the user's own) without opening or navigating anything. `close`
   * is a no-op: the tab is the user's, so releasing the ride must never close it.
   */
  adopt?(tabId: number): Promise<{ page: ReplayPage; rawPage?: unknown; close: () => Promise<void> }>
}

/** Launch a live page for the recipe's entry URL, replay the recipe, always tear down.
 *  FetchRecipe only — entryUrl is what makes a recipe need a page at all, and kind:'http'
 *  (which has none) never reaches here. */
export async function runFetchRecipe(
  recipe: FetchRecipe,
  params: Record<string, string>,
  launcher: ReplayLauncher,
): Promise<MappedItem[]> {
  // entryUrl may template run params (e.g. xueqiu's /u/{id}); an un-substituted hole
  // navigates to a bogus path and the site serves its 404 — the in-page fetch would
  // then run from a foreign document.
  const { page, close } = await launcher.launch(substitute(recipe.entryUrl, params), recipe.entryWait)
  try {
    const out = await interpret(recipe, { fetchInPage: buildInPageFetch(page) }, params)
    return out.items
  } finally {
    await close()
  }
}
