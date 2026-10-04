import { writeFileSync } from 'node:fs'
import { makeCaptureContext, captureXhr } from '../src/replay/capture.ts'

/**
 * Authoring aid for building-browser-recipes: open a URL and print every JSON XHR it fires, so
 * you can pick the data endpoint to templatize.
 *
 * It attaches to YOUR OWN Chrome over CDP — start one with a debugging port first (a dedicated
 * profile; M136+ refuses the flag on the default one):
 *   chrome --user-data-dir=/tmp/stream-chrome --remote-debugging-port=9333
 * Point it elsewhere with STREAM_AUTHORING_CDP_URL. Since it is your browser, a login-gated
 * capture just works when you are logged in — no cookie plumbing needed.
 *
 * Usage: pnpm exec tsx scripts/recipe-capture.ts "<entryUrl>"
 * Cookies (capturing as a session that browser is NOT logged into):
 *   COOKIE_HEADER="a=b; c=d" COOKIE_DOMAIN=example.com
 */
async function main() {
  const url = process.argv[2]
  // Optional 2nd arg: a URL substring. When given, the FULL JSON body of the first
  // captured XHR whose url contains it is written to data/capture-dump.json. The 400-char
  // console preview is for PICKING the data endpoint (new recipe); this full dump is for
  // INSPECTING one endpoint's real shape when ENHANCING an existing recipe — e.g. checking
  // whether user_timeline actually nests `retweeted_status` or only gives a `retweet_status_id`.
  const dumpMatch = process.argv[3]
  if (!url) {
    console.error('usage: tsx scripts/recipe-capture.ts "<entryUrl>" [urlSubstringToDumpFull]')
    process.exit(1)
  }
  const ctx = await makeCaptureContext({
    cookieHeader: process.env.COOKIE_HEADER,
    cookieDomain: process.env.COOKIE_DOMAIN,
  })
  // SETTLE_MS: 3s covers most sites; a slow SPA fires its data XHR later.
  // WARM_URL: visit the origin first — a site that gates deep-links on origin-minted
  // anti-bot cookies (douyin) serves an empty page and no XHR to a cold /search link.
  // SHOT: screenshot the settled page — when a capture returns no data XHR, the page itself
  // (login wall? verify interstitial?) is the answer, and guessing at it wastes rounds.
  const xhrs = await captureXhr(ctx, url, {
    settleMs: Number(process.env.SETTLE_MS ?? 3000),
    warmUrl: process.env.WARM_URL,
    shotPath: process.env.SHOT,
  })
  if (xhrs.length === 0) {
    console.log('no JSON XHRs captured — try a longer settle, an interaction, or the right entry URL')
    return
  }
  for (const x of xhrs) {
    const preview = JSON.stringify(x.json).slice(0, 400)
    console.log(`\n${x.method} ${x.status} ${x.url}`)
    console.log(`  ${preview}${preview.length >= 400 ? '…' : ''}`)
  }
  if (dumpMatch) {
    // An endpoint often fires several times and the FIRST response is a warm-up shell with an
    // empty item array (douyin's search does exactly this) — mapping against it reads "no such
    // field". Dump the biggest matching body, which is the one that actually carries items.
    const hits = xhrs.filter((x) => x.url.includes(dumpMatch))
    const hit = hits.sort((a, b) => JSON.stringify(b.json).length - JSON.stringify(a.json).length)[0]
    if (!hit) {
      console.log(`\n[dump] no captured XHR url contained "${dumpMatch}"`)
    } else {
      writeFileSync('data/capture-dump.json', JSON.stringify(hit.json, null, 2))
      console.log(`\n[dump] biggest of ${hits.length} matching ${hit.method} ${hit.url.slice(0, 80)}… → data/capture-dump.json`)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
