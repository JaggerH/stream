import { describe, it, expect } from 'vitest'
import { makeCaptureContext, captureXhr } from './capture.ts'

const gated = describe.skipIf(!process.env.RUN_BROWSER_TESTS)

gated('captureXhr — live (Hacker News Algolia SPA fires its search API)', () => {
  it('captures the search XHR carrying the results array', async () => {
    // Needs a Chrome listening on the authoring CDP port (see browser.ts) — same precondition
    // as `record validate`. RUN_BROWSER_TESTS is the opt-in that says one is up.
    const ctx = await makeCaptureContext()
    const xhrs = await captureXhr(ctx, 'https://hn.algolia.com/?query=anthropic', { settleMs: 4000 })
    // The real data XHR goes to Algolia's cloud, not hn.algolia.com — assert on the
    // payload shape (a hits array), which is what an author actually picks.
    const dataXhr = xhrs.find((x) => Array.isArray((x.json as { hits?: unknown })?.hits))
    expect(dataXhr).toBeDefined()
  }, 120_000)
})
