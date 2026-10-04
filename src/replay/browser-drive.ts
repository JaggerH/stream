import crypto from 'node:crypto'
import type { Page } from 'playwright-core'
import type { BrowserRecipe } from './recipe.ts'
import type { ReplayLauncher } from './browser-fetch.ts'
import { HarvestAccumulator, urlMatches } from './harvest.ts'
import { runActions, makeRandom, FeatureDriftError, WalledError, detectLoginState, type PageDriver, type ActionTrace } from './actions.ts'
import { extractCards, domAccumulatorInput, stateAccumulatorInput, evalAccumulatorInput } from './dom-harvest.ts'
import { CARD_ID_RE_SOURCE } from './card-id.ts'
import { getPath, substitute, type MappedItem } from './interpret.ts'
import { CLICK_WAIT_MS } from '../../shared/browser-relay/ext-page.ts'

export interface RunBrowserOutcome {
  outcome: 'ok' | 'needsLogin' | 'drift'
  items: MappedItem[]
  trace: ActionTrace[]
  seed: number
  driftReason: string | null
}

/**
 * Optional record-mode hooks. Replay passes none — a wall then ends the run as
 * needsLogin (deterministic, no human). Record supplies onWall: called when a
 * wall is detected (entry or mid-run); it prompts the operator and resolves
 * 'resume' once they have logged in (the interpreter re-probes) or 'abort' to
 * give up. Still-walled after a 'resume' → needsLogin, never an infinite wait.
 */
export interface RunHooks {
  onWall?: () => Promise<'resume' | 'abort'>
}

/** How long a `click` waits for its target to become clickable before reporting a miss.
 *  Bounded so a genuinely-absent selector fails fast instead of hanging on Playwright's 30s
 *  default — but long enough for the next control of a form to render.
 *
 *  真相源在 `shared/browser-relay/ext-page.ts`：**两条 transport 必须等一样久**，否则同一份
 *  recipe 换条路走就有不同的成败。这里只是转出去，别在本文件另写一个数。 */
export { CLICK_WAIT_MS }

export function makePageDriver(page: Page): PageDriver {
  return {
    async goto(url: string, waitUntil?: string): Promise<void> {
      const wait = (waitUntil ?? 'domcontentloaded') as 'commit' | 'domcontentloaded' | 'load' | 'networkidle'
      await page.goto(url, { waitUntil: wait })
    },
    async currentUrl(): Promise<string> {
      return page.url()
    },
    async scrollOnce(px: number): Promise<void> {
      await page.mouse.wheel(0, px)
    },
    async scrollProbe(): Promise<{ scrollY: number; viewportH: number; scrollHeight: number }> {
      const geom = await page.evaluate(() => ({
        scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
        viewportH: window.innerHeight || 0,
        scrollHeight: Math.max(
          document.documentElement?.scrollHeight || 0,
          document.body?.scrollHeight || 0,
        ),
      }))
      return geom ?? { scrollY: 0, viewportH: 0, scrollHeight: 0 }
    },
    async readViewport(selector: string): Promise<Array<{ id: string; top: number; height: number }>> {
      // ONE entry per feed card, viewport-only. A card carries several anchors for the same id
      // (cover + title) and the virtual list keeps a buffer of off-screen cards; both must be
      // dropped or the locator's geometry (avg card height, mid index) is garbage.
      // 身份怎么从 href 抠出来见 card-id.ts —— 页内求值带不过闭包，所以传的是正则源码。
      // 可见性判据和 VISIBLE_EL_FN_SOURCE 是同一条（盒子非空 + 非 visibility:hidden），但这里
      // **抄一份而不是 new Function 那份源码**：页面的 CSP 可以禁掉 eval，而这个函数是被 Playwright
      // 序列化进主世界跑的。两处必须同步改；两处都有测试守着。
      const cards = await page.$$eval(selector, (els, reSource) => {
        const re = new RegExp(reSource)
        const visible = (el: Element): boolean => {
          const r = el.getBoundingClientRect()
          if (!(r.width > 0) || !(r.height > 0)) return false
          return getComputedStyle(el).visibility !== 'hidden'
        }
        const vh = window.innerHeight
        const seen = new Set<string>()
        const out: Array<{ id: string; top: number; height: number }> = []
        for (const el of els) {
          const href = (el as HTMLAnchorElement).getAttribute('href') || ''
          const m = href.split(/[?#]/)[0].match(re)
          if (!m) continue
          const id = m[1]
          if (seen.has(id)) continue // dedupe the cover/title anchors of the same card
          // 可见先判、再记 seen：一张卡带一个 display:none 的同 id anchor（rect 全 0），
          // 反过来的话它先把 id 占住，真卡就被自己的影子挤掉了。
          if (!visible(el)) continue
          const r = el.getBoundingClientRect()
          if (r.bottom <= 0 || r.top >= vh) continue // viewport-overlapping only
          seen.add(id)
          out.push({ id, top: Math.round(r.top), height: Math.round(r.height) })
        }
        return out
      }, CARD_ID_RE_SOURCE)
      return cards ?? []
    },
    async findCard(selector: string, identity: string) {
      // A loaded feed keeps its off-screen cards in the DOM, so the target's anchor is usually right
      // here with a real box — read its document Y instead of estimating one. Prefer an anchor with
      // a real box (a card carries a zero-size one too), but take any match rather than none: even a
      // collapsed anchor tells us roughly where to scroll, and the loop re-measures after the move.
      return page.evaluate(
        ([sel, id]) => {
          const hits = [...document.querySelectorAll(sel)].filter((el) =>
            (el.getAttribute('href') || '').includes(id),
          )
          // 同一条可见判据（见 readViewport 里那份，以及 card-id.ts 的 VISIBLE_EL_FN_SOURCE）
          const visible = (el: Element): boolean => {
            const r = el.getBoundingClientRect()
            if (!(r.width > 0) || !(r.height > 0)) return false
            return getComputedStyle(el).visibility !== 'hidden'
          }
          const el = hits.find(visible) ?? hits[0]
          if (!el) return null
          const r = el.getBoundingClientRect()
          return {
            docY: Math.round(r.top + window.scrollY),
            scrollY: Math.round(window.scrollY),
            viewportH: window.innerHeight,
          }
        },
        [selector, identity] as [string, string],
      )
    },
    async openTarget(selector: string, identity: string): Promise<boolean> {
      // Trusted click of the card carrying the call-time identity. Target it with ONE selector
      // rather than iterating every anchor: the virtualized feed re-renders mid-iteration, which
      // invalidates nth() indices and throws.
      // `:visible` matters — a card carries several anchors for the same note (cover + title) and the
      // first in DOM order can be zero-size/hidden, which never passes Playwright's actionability
      // check and burns the whole click timeout.
      //
      // Returns whether a :visible target was FOUND and clicked — NOT whether the note opened.
      // `noWaitAfter` makes the click return once the (humanized) press/release is dispatched,
      // WITHOUT waiting for the resulting navigation; the caller confirms the open separately
      // (observeOpened). That split is deliberate: the click's wall-clock is humanize's human-like
      // cursor travel (anti-detection, and the real cost here), and the wait-for-it-to-open is a
      // different thing — the probe reports them as separate phases instead of one opaque block.
      const loc = page.locator(`${selector}[href*="${identity}"]:visible`).first()
      if ((await loc.count()) === 0) return false
      await loc.click({ timeout: 5000, noWaitAfter: true }).catch(() => {})
      return true
    },
    async openItem(selector: string, index: number): Promise<void> {
      const count = await page.locator(selector).count()
      if (count === 0) return
      const clampedIndex = index % count
      // Bounded, and the timeout is swallowed: a click that can't become actionable should fail
      // FAST (we've already located the element), not hang on Playwright's 30s default. Success is
      // no longer judged by this call returning — the caller's expect/confirm poll decides, so a
      // click that didn't land shows up as acted-unconfirmed rather than a 30s stall.
      await page.locator(selector).nth(clampedIndex).click({ timeout: 4000 }).catch(() => {})
    },
    async click(selector: string, position?: { x: number; y: number }): Promise<boolean> {
      // No count() pre-check: that would short-circuit Playwright's auto-wait and turn "the button
      // hasn't rendered YET" into "no such button". Real forms render the next control only after
      // the previous one resolves (Groq's submit button appears only once the Turnstile token
      // lands), so the wait IS the semantics — same as Playwright's own click.
      // `position` is Playwright's own — same units and origin as the recipe field, so there is no
      // conversion here to get wrong. (Pedantically it is the PADDING box, while the ext driver
      // measures getBoundingClientRect() = border box; identical unless the target has a border.)
      // Bounded, and failure is reported rather than thrown: the caller's confirm decides.
      return page
        .locator(selector)
        .first()
        .click({ timeout: CLICK_WAIT_MS, ...(position ? { position } : {}) })
        .then(() => true)
        .catch(() => false)
    },
    async shotOf(selector: string): Promise<string | null> {
      const loc = page.locator(selector).first()
      const box = await loc.boundingBox().catch(() => null)
      if (!box || !box.width || !box.height) return null
      const buf = await page.screenshot({ clip: box, type: 'jpeg', quality: 80 }).catch(() => null)
      return buf ? Buffer.from(buf).toString('base64') : null
    },
    /** 整屏（当前视口）一张，给人和模型看；与 `shotOf` 的取舍相反，见 `PageDriver.shotViewport` 头注。 */
    async shotViewport(): Promise<string | null> {
      const buf = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null)
      return buf ? Buffer.from(buf).toString('base64') : null
    },
    async back(): Promise<void> {
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {})
    },
    async type(selector: string, text: string): Promise<boolean> {
      // count() 而非直接 fill() + catch：fill 找不到目标会抛，但这里要的是「找没找到」这个
      // 布尔事实，不是一次异常兜底——和 click 同一份契约。
      if ((await page.locator(selector).count()) === 0) return false
      await page.locator(selector).first().fill(text)
      return true
    },
    async submit(selector: string): Promise<boolean> {
      if ((await page.locator(selector).count()) === 0) return false
      await page.locator(selector).first().press('Enter')
      return true
    },
    async sleep(ms: number): Promise<void> {
      await new Promise(resolve => setTimeout(resolve, ms))
    },
    async exists(selector: string): Promise<boolean> {
      return (await page.locator(selector).count()) > 0
    },
    async readItems(itemSelector, fields): Promise<Record<string, string>[]> {
      // extractCards is self-contained so Playwright can serialize it into the page.
      return page.$$eval(itemSelector, extractCards as any, fields as any)
    },
    async readState(statePath: string): Promise<unknown> {
      // Walk the dot-path off `window` in-page (inline arrow, no free vars → safe to
      // serialize under esbuild keepNames). Returns whatever is there (array or undefined).
      return page.evaluate((path: string) => {
        let cur: unknown = window as unknown
        for (const seg of path.split('.')) cur = cur == null ? cur : (cur as Record<string, unknown>)[seg]
        return cur
      }, statePath)
    },
    async evalJson(expression: string): Promise<unknown> {
      // Playwright evaluates a string expression in-page and auto-awaits a returned
      // promise — same contract as the ext driver's Runtime.evaluate(awaitPromise).
      return page.evaluate(expression)
    },
    async moveMouse(x: number, y: number): Promise<void> {
      await page.mouse.move(x, y, { steps: 8 })
    },
  }
}

export async function runBrowserRecipe(
  recipe: BrowserRecipe,
  params: Record<string, string>,
  launcher: ReplayLauncher,
  seed?: number,
  driverFactory?: (page: any) => PageDriver,
  hooks?: RunHooks
): Promise<RunBrowserOutcome> {
  const actualSeed = seed ?? (crypto.randomInt ? crypto.randomInt(0, 2 ** 31 - 1) : Math.floor(Math.random() * 2 ** 31))
  
  // Interactive = needs a managed window (scroll/render/trusted input). Default: DOM
  // harvest does, eval/state don't. A recipe may override with `interactive`.
  const interactive = recipe.interactive ?? (recipe.harvest.mode === 'dom')
  // entryUrl may template run params (e.g. a detail page /item/{id}?sig={token});
  // unknown holes are left literally (a param-free recipe's URL is unchanged).
  const entryUrl = substitute(recipe.entryUrl, params)
  const { rawPage, close } = await launcher.launch(entryUrl, recipe.entryWait, { interactive })
  try {
    if (!rawPage) {
      throw new Error('launcher launch did not return rawPage')
    }

    // Explicit arg wins (tests); else the transport's own factory (ext-cdp supplies
    // an evaluate+CDP-Input driver); else the default Playwright page driver.
    const factory = driverFactory ?? launcher.driverFactory ?? ((p: any) => makePageDriver(p as Page))
    const driver = factory(rawPage)

    // Login state at entry keys on a POSITIVE wall signal, consistent with the
    // per-tick and end-of-run probes. Only WALLED short-circuits to needsLogin; in
    // record mode onWall gets one chance to prompt the operator to clear it, then we
    // re-probe. UNKNOWN (neither signal painted yet, e.g. slow SPA hydration) is NOT
    // treated as walled — the scroll loop's per-tick probe and the end check resolve
    // it, so a logged-in session whose signal hasn't rendered isn't bounced to login.
    let entryState = await detectLoginState(driver, recipe.loginCheck)
    if (entryState === 'WALLED') {
      if (hooks?.onWall && (await hooks.onWall()) === 'resume') {
        entryState = await detectLoginState(driver, recipe.loginCheck)
      }
      if (entryState === 'WALLED') {
        return {
          outcome: 'needsLogin',
          items: [],
          trace: [],
          seed: actualSeed,
          driftReason: null
        }
      }
    }

    const harvest = recipe.harvest
    const isDom = harvest.mode === 'dom'
    const accumulator = new HarvestAccumulator(
      harvest.mode === 'dom' ? domAccumulatorInput(harvest)
      : harvest.mode === 'state' ? stateAccumulatorInput(harvest)
      : harvest.mode === 'eval' ? evalAccumulatorInput(harvest)
      : harvest,
    )

    const p = rawPage as any
    // XHR feeds the accumulator async via the response listener; DOM pulls the
    // rendered cards on each scroll tick (onTick). Only one path is armed.
    const domState = { sawAnyCard: false }
    let evalError: string | null = null
    let onTick: (() => Promise<void>) | undefined
    let responseHandler: ((resp: any) => void) | undefined

    if (harvest.mode === 'dom') {
      const dom = harvest
      const domTick = async () => {
        const cards = driver.readItems ? await driver.readItems(dom.itemSelector, dom.fields) : []
        if (cards.length > 0) domState.sawAnyCard = true
        accumulator.offer({ items: cards })
      }
      onTick = domTick
      // catch the first screenful before any scroll can evict it (virtualized lists)
      await domTick()
    } else if (harvest.mode === 'state') {
      // SSR-state harvest is a ONE-SHOT read of a global the page already rendered —
      // no scroll, no focus, no input, no listener. But the entry nav can resolve on the
      // initial about:blank document (readyState 'complete' races ahead of the real doc),
      // so `__INITIAL_STATE__` may not exist for a beat. Poll a few times for the array to
      // appear before giving up; a genuine miss (shape moved / logged-out shell) still
      // offers a non-array so the assert/itemsAt check trips drift, never a silent empty.
      // Read as EARLY as possible: xhs's SSR seeds `feeds` as a plain array, but its app
      // JS hydrates it into a MobX-style observable (Array.isArray → false, not sliceable)
      // within a beat of load — so a delayed/retried read misses the plain-array window.
      const arr = driver.readState ? await driver.readState(harvest.statePath) : undefined
      accumulator.offer({ items: arr })
    } else if (harvest.mode === 'eval') {
      // In-page eval harvest: call the site's OWN signed request client page by page,
      // threading the returned cursor. Render-INDEPENDENT — no scroll, no focus, no
      // anti-throttle flags (a fetch runs on a background/unfocused tab). The `call`
      // (recipe-authored plain JS) throws in-page on a non-success API body (e.g. xhs
      // `300011 账号异常`); we surface that as drift, never a silent empty "ok".
      const ev = harvest
      const pageSize = ev.pageSize ?? 20
      const maxPages = ev.maxPages ?? 30
      let cursor = ''
      let emptyStreak = 0
      for (let pg = 0; pg < maxPages && !accumulator.done; pg++) {
        // 3rd arg = recipe run params (the item id / signature token of a detail fetch); paginated
        // list evals (homefeed) simply ignore it — backward-compatible.
        const expr = `(()=>{const __name=(f)=>f;return (${ev.call})(${JSON.stringify(cursor)},${pageSize},${JSON.stringify(params)});})()`
        let resp: unknown
        try {
          resp = driver.evalJson ? await driver.evalJson(expr) : undefined
        } catch (e) {
          evalError = e instanceof Error ? e.message : String(e)
          break
        }
        const batch = getPath(resp, ev.itemsAt)
        const { fresh } = accumulator.offer({ items: batch })
        // two consecutive fresh-0 pages = the recommendation stream is repeating → stop
        if (fresh === 0) { if (++emptyStreak >= 2) break } else emptyStreak = 0
        const next = getPath(resp, ev.cursorField)
        cursor = next == null ? '' : String(next)
        if (!cursor) break
        // human-ish spacing between calls (seeded jitter would need the RNG; a small
        // varied delay is enough — this is a handful of calls, not a scroll loop)
        if (!accumulator.done && pg + 1 < maxPages) await driver.sleep(900 + (pg % 3) * 400)
      }
    } else {
      const xhr = harvest
      responseHandler = async (resp: any) => {
        if (urlMatches(xhr.urlPattern, resp.url())) {
          try {
            accumulator.offer(await resp.json())
          } catch {
            // swallow read errors
          }
        }
      }
      p.on('response', responseHandler)
    }

    // Probe the login wall on EVERY scroll tick (both harvest modes) so a wall
    // that appears mid-run aborts scrolling at once — abort-on-wall — instead of
    // grinding a blocked page to a false "drift". Composed over the dom tick.
    const baseTick = onTick
    onTick = async () => {
      if ((await detectLoginState(driver, recipe.loginCheck)) === 'WALLED') {
        if (!hooks?.onWall) {
          // Replay: a single WALLED probe may be a transient overlay (interstitial,
          // toast). Re-confirm after a short settle before aborting, so a flicker
          // doesn't masquerade as needsLogin and discard a live harvest.
          await driver.sleep(400)
          if ((await detectLoginState(driver, recipe.loginCheck)) === 'WALLED') throw new WalledError()
        } else {
          // Record: prompt the operator; the prompt itself is the settle. Resume if
          // they cleared the wall, else abort.
          if ((await hooks.onWall()) === 'abort') throw new WalledError()
          if ((await detectLoginState(driver, recipe.loginCheck)) === 'WALLED') throw new WalledError()
        }
      }
      if (baseTick) await baseTick()
    }

    let actionsTrace: ActionTrace[] = []
    let caughtDriftError: FeatureDriftError | null = null
    let caughtWall = false

    try {
      actionsTrace = await runActions(
        recipe.actions,
        driver,
        makeRandom(actualSeed),
        accumulator,
        {
          cookieDomain: recipe.cookieDomain,
          params,
          entryWait: recipe.entryWait,
          onTick, // always armed: at minimum probes the login wall each scroll tick
        }
      )
    } catch (err) {
      if (err instanceof FeatureDriftError) {
        caughtDriftError = err
      } else if (err instanceof WalledError) {
        caughtWall = true
      } else {
        throw err
      }
    } finally {
      // Remove response handler if possible
      if (responseHandler) {
        if (typeof p.off === 'function') {
          p.off('response', responseHandler)
        } else if (typeof p.removeListener === 'function') {
          p.removeListener('response', responseHandler)
        }
      }
    }

    // A wall caught mid-run short-circuits to needsLogin — never drift, never
    // quarantine. Cards already harvested before the wall came from the still-valid
    // session, so hand them back rather than discarding the partial run.
    if (caughtWall) {
      return {
        outcome: 'needsLogin',
        items: accumulator.items(),
        trace: actionsTrace,
        seed: actualSeed,
        driftReason: null
      }
    }

    // Evaluate drift
    let driftReason: string | null = null
    if (caughtDriftError) {
      driftReason = caughtDriftError.message
    } else {
      driftReason = accumulator.driftReason()
      if (!driftReason) {
        if (isDom && !domState.sawAnyCard) {
          driftReason = 'no cards matched itemSelector'
        } else if (harvest.mode === 'eval') {
          // an in-page failure with nothing harvested is drift; a partial harvest before
          // the failure is still handed back as ok (like the abort-on-wall partial).
          if (evalError && accumulator.size === 0) driftReason = `eval harvest failed: ${evalError}`
        } else if (!isDom && accumulator.matchedResponses === 0) {
          driftReason = 'no response matched urlPattern'
        }
      }
    }

    if (driftReason) {
      // Before concluding drift, probe login state once more: a WALLED session is
      // needsLogin, not drift. UNKNOWN (the logged-in signal transiently absent
      // mid-rerender, no wall) is NOT reclassified — that would mask genuine drift as
      // needsLogin and skip quarantine; only a positive wall overrides drift.
      const endState = await detectLoginState(driver, recipe.loginCheck)
      if (endState === 'WALLED') {
        return {
          outcome: 'needsLogin',
          items: accumulator.items(),
          trace: actionsTrace,
          seed: actualSeed,
          driftReason: null
        }
      }

      return {
        outcome: 'drift',
        items: [],
        trace: actionsTrace,
        seed: actualSeed,
        driftReason
      }
    }

    return {
      outcome: 'ok',
      items: accumulator.items(),
      trace: actionsTrace,
      seed: actualSeed,
      driftReason: null
    }

  } finally {
    await close()
  }
}
