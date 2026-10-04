import { connectAuthoringContext } from '../src/replay/browser.ts'
import { captureDom } from '../src/replay/dom-capture.ts'

/**
 * Tier-C authoring aid for building-browser-recipes: open a URL and print a structured DOM
 * snapshot — repeating-container candidates (the feed card = itemSelector), field candidates
 * sampled from the top card, and (with --open) a post-modal scan.
 *
 * It attaches to YOUR OWN Chrome over CDP (see browser.ts), so whatever you are logged into is
 * what it sees — start that browser with a debugging port first:
 *   chrome --user-data-dir=/tmp/stream-chrome --remote-debugging-port=9333
 *
 * Usage:
 *   pnpm exec tsx scripts/recipe-dom-capture.ts "<entryUrl>" [--open "<cardSelector>"]
 */
async function main() {
  const url = process.argv[2]
  if (!url || url.startsWith('--')) {
    console.error('usage: tsx scripts/recipe-dom-capture.ts "<entryUrl>" [--open "<cardSelector>"]')
    process.exit(1)
  }
  const openIdx = process.argv.indexOf('--open')
  const openSelector = openIdx > 0 ? process.argv[openIdx + 1] : undefined

  const ctx: any = await connectAuthoringContext()
  let page: any
  try {
    page = await ctx.newPage()
    await page.goto(url, { waitUntil: 'load' })
    await new Promise((r) => setTimeout(r, 3000)) // settle: let the feed render

    const report = await captureDom(page)

    if (openSelector) {
      // open the first card, let the modal render, scan it for humanize selectors
      await page.locator(openSelector).first().click().catch(() => {})
      await new Promise((r) => setTimeout(r, 1500))
      report.modal = await page.evaluate(() => {
        // self-contained scan: a <video>, an element whose text is a bare number
        // (comment count), and a right-arrow control (next image). No inner
        // const-arrow helpers — esbuild keepNames would wrap them as __name(...),
        // which is undefined once this closure is serialized into the page.
        const out: { commentCountSelector?: string; nextImageSelector?: string; videoSelector?: string } = {}
        if (document.querySelector('video')) out.videoSelector = 'video'
        const els = document.querySelectorAll('body *')
        for (let i = 0; i < els.length; i++) {
          const el = els[i]
          const cls = Array.from(el.classList).filter((c) => c && !/\d/.test(c)).sort()
          const sel = el.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : '')
          const txt = (el.textContent || '').trim()
          if (!out.commentCountSelector && /^\d[\d,.]*$/.test(txt) && el.children.length === 0) out.commentCountSelector = sel
          const label = ((el.getAttribute('class') || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase()
          if (!out.nextImageSelector && /(right|next|arrow)/.test(label)) out.nextImageSelector = sel
        }
        return out
      })
    }

    console.log(JSON.stringify(report, null, 2))
  } finally {
    // Close OUR tab only — the browser belongs to the developer, and their other tabs with it.
    await page?.close().catch(() => {})
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
