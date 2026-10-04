import { publicHttpUrl } from '../adapters/safe-fetch.ts'
import { ownedFetch } from '../http/owned-outbound.ts'
import { runCompute, type CapabilityName } from './compute-sandbox.ts'
import { substitute, type ResolvedFetch } from './interpret.ts'
import type { HttpRecipe } from './recipe.ts'
import { HostCookieJar, hostMatchesDomain } from './cookie-jar.ts'

// The matcher moved to cookie-jar.ts (the jar and the send gate share it); re-export
// keeps every existing importer working.
export { hostMatchesDomain } from './cookie-jar.ts'

/**
 * The `fetchInPage` that a kind:'http' recipe runs on: send the request straight from
 * the host process. No page, no browser, no profile.
 *
 * Two runtime guards, both non-negotiable. A recipe is authored data that Stream will
 * one day accept from other users, which makes its `request` a request-forgery
 * primitive — being declarative does not make it safe:
 *
 *  - SSRF: the URL goes through the same public-host guard safe-fetch uses, so a recipe
 *    cannot name `169.254.169.254` (cloud metadata) or `localhost:4555` (Stream's own
 *    admin API) and read them from inside the trust boundary.
 *  - cookie binding: cookieDomain must cover the request host, so a recipe cannot name
 *    one domain's credential and post it to another.
 *
 * `doFetch` is injected for tests; its default is `ownedFetch` — the undici binding captured
 * at module load, before anything can patch `globalThis`. Two independent guarantees keep
 * recipe traffic off the embedded RSSHub's request-rewriter (which replaces global
 * fetch/Headers/Request/Response and injects a self-origin Referer): RSSHub runs in a worker
 * thread, so it patches that worker's globals rather than ours (rsshub-worker.ts), and this
 * call site holds a pre-patch reference regardless (owned-outbound.ts).
 *
 * A recipe's `request.headers` are sent VERBATIM — notably the User-Agent. Two rules, and only
 * the second one is a rule you can carry between sites:
 *
 *  - **Never hardcode a conclusion about which UA a WAF accepts — measure it, dated.** Which
 *    shape passes is per-site AND changes under you. One EdgeOne-fronted site flipped in BOTH
 *    directions inside four days (dated measurements live in that facility's own package
 *    README): every browser-shaped UA was a bodyless 403 while no-UA passed, then days later
 *    a browser UA passed 200 and no-UA was the only thing rejected. A comment stating "site X
 *    blocks browser UAs" reads as fact and is how you get sent down the wrong path — run a
 *    matrix of 5-6 UAs against the live endpoint instead, and write down the date next to
 *    whatever you find.
 *  - **Pick a UA a huge crowd already sends.** A unique product token (`Stream/1.0`) is a
 *    free label for anyone who wants to filter exactly us — one WAF rule and it is over, with
 *    zero collateral for the site. `okhttp/4.12.0` (the Android HTTP client default, which is
 *    what most Chinese mobile apps put on the wire) costs a site real traffic to block.
 *
 * Exception: some upstreams REQUIRE a browser UA (baidu-share does, for its session binding).
 */
export function makeHttpFetch(
  recipe: HttpRecipe,
  cookieFor?: (domain: string) => Promise<string | undefined>,
  doFetch?: typeof fetch,
  now: () => number = () => Math.floor(Date.now() / 1000),
): (req: ResolvedFetch) => Promise<unknown> {
  const send = doFetch ?? ownedFetch

  // The jar lives exactly as long as this closure — one adapter fetch = one jar (spec §4.1
  // rule 2). It is NOT keyed per params like the prefetch memo: paging within one fetch is
  // the same browsing session and must keep its session cookies.
  const jar = recipe.jar ? new HostCookieJar() : null

  // Raw guarded send — the SSRF + cookie-binding gate every request (main + prefetch) goes
  // through, so a compute snippet can never point a prefetch at cloud metadata either.
  const guardedSend = async (req: ResolvedFetch): Promise<Response> => {
    const url = publicHttpUrl(req.url)
    if (!url) throw new Error(`http recipe "${recipe.sourceId}": refusing non-public URL ${req.url}`)
    const headers: Record<string, string> = { ...req.headers }
    // Cookie assembly: broker credential (cookieDomain-gated) + this run's jar, deduped BY
    // NAME with the jar winning — an upstream-issued session value must shadow the static
    // credential, and it must be by-name: servers take the FIRST duplicate, so "append the
    // jar last" would silently lose (spec §4.1 rule 3).
    const pairs = new Map<string, string>()
    if (recipe.cookieDomain) {
      if (!hostMatchesDomain(url.hostname, recipe.cookieDomain)) {
        throw new Error(
          `http recipe "${recipe.sourceId}": cookieDomain "${recipe.cookieDomain}" does not cover request host "${url.hostname}"`,
        )
      }
      const cookie = await cookieFor?.(recipe.cookieDomain)
      if (cookie) {
        for (const p of cookie.split(';')) {
          const eq = p.indexOf('=')
          if (eq > 0) pairs.set(p.slice(0, eq).trim(), p.slice(eq + 1).trim())
        }
      }
    }
    if (jar) for (const [n, v] of jar.cookiesFor(url.hostname)) pairs.set(n, v)
    if (pairs.size) headers.cookie = [...pairs].map(([n, v]) => `${n}=${v}`).join('; ')
    const res = await send(url, { method: req.method, headers, body: req.body, redirect: req.redirect ?? 'follow' })
    // Absorb BEFORE the ok-check: a 302/401 that plants session cookies is still a plant
    // (baidu's share landing does exactly this), and acceptNonOk probes read verdicts out
    // of error bodies.
    jar?.absorb(url.hostname, res.headers.getSetCookie?.() ?? [])
    // Surface upstream failure as an error: returning [] here would look to the scheduler
    // like "the feed is empty today" and silently evict a stream's items. A probe recipe opts
    // out (acceptNonOk) because its verdict arrives IN the error body — see the field's doc.
    if (!res.ok && !recipe.acceptNonOk) {
      throw new Error(`http recipe "${recipe.sourceId}": ${req.method} ${url.hostname}${url.pathname} → ${res.status}`)
    }
    return res
  }

  // Compute hook: prefetch (I/O, engine) runs ONCE and is memoized in this closure; sign and
  // decode (compute, sandbox) run per request. Absent compute → the plain path, unchanged.
  //
  // A prefetch templates `{param}` holes exactly like the main request does: a prefetch that
  // opens a per-target session (quark: pwd_id → stoken) is meaningless without the target's
  // own params, and having only ONE of the two request slots substitute holes is a trap —
  // the hole would be sent literally, upstream would answer "not found", and nothing would
  // say why. The memo is keyed by those params, not global: this closure is built per fetch
  // (adapter.ts), and paging within one fetch keeps its params fixed, so one run = one
  // prefetch — while a differing param set can never silently reuse another target's token.
  const compute = recipe.compute
  const prefetched = new Map<string, Promise<Record<string, unknown>>>()
  const getPrefetched = (params: Record<string, string>): Promise<Record<string, unknown>> => {
    const key = JSON.stringify(params)
    const hit = prefetched.get(key)
    if (hit) return hit
    const run = (async () => {
      const pre: Record<string, unknown> = {}
      for (const p of compute?.prefetch ?? []) {
        // Prefetch headers template {param} holes exactly like url/body — baidu's referer
        // carries the share id. Unknown holes stay literal, so existing recipes are unmoved.
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(p.request.headers ?? {})) headers[k] = substitute(v, params)
        const res = await guardedSend({
          url: substitute(p.request.url, params),
          method: p.request.method,
          headers,
          body: p.request.body == null ? undefined : substitute(p.request.body, params),
          redirect: p.request.redirect,
        })
        pre[p.as] = p.parse === 'none' ? null : p.parse === 'text' ? await res.text() : await res.json()
      }
      return pre
    })()
    prefetched.set(key, run)
    return run
  }

  return async (req) => {
    if (!compute) return await (await guardedSend(req)).json()

    let params = req.params ?? {}
    if (compute.params) {
      const derived = (await runCompute({
        code: compute.params,
        input: { params, now: now() },
        capabilities: compute.capabilities as CapabilityName[],
      })) as Record<string, unknown> | null
      // String() because params are template fill-ins by contract.
      for (const [k, v] of Object.entries(derived ?? {})) params = { ...params, [k]: String(v) }
    }

    const pre = await getPrefetched(params)

    // Derived params fill holes the FIRST substitution left literal: interpret resolves the
    // main request before the params hook exists, and substitute leaves unknown holes in
    // place — which is exactly what makes this second pass safe and backward-compatible.
    let outgoing: ResolvedFetch = {
      ...req,
      url: substitute(req.url, params),
      body: req.body == null ? undefined : substitute(req.body, params),
      params,
    }
    if (compute.sign) {
      const patch = (await runCompute({
        code: compute.sign,
        input: { params, pre, now: now() },
        capabilities: compute.capabilities as CapabilityName[],
      })) as { url?: string; body?: string; headers?: Record<string, string> }
      outgoing = {
        ...outgoing,
        url: patch.url ?? outgoing.url,
        headers: { ...outgoing.headers, ...(patch.headers ?? {}) },
        body: patch.body ?? outgoing.body,
      }
    }

    const body = await (await guardedSend(outgoing)).json()
    if (!compute.decode) return body
    // decode gets `params` too (post-hook): a probe's verdict can depend on the call's own
    // inputs — baidu must answer differently with and without a passcode.
    return await runCompute({
      code: compute.decode,
      input: { body, pre, params },
      capabilities: compute.capabilities as CapabilityName[],
    })
  }
}
