import { describe, expect, it } from 'vitest'
import { loadRecipePackages } from './recipe-package.ts'
import { makeHttpFetch } from './http-fetch.ts'
import { interpret } from './interpret.ts'

/**
 * End-to-end over the REAL lizhi vodapi, no browser. This is the worked example for the
 * whole RSSHub→http-recipe migration: load the on-disk recipe, run it on the plain-HTTP
 * transport, hit the live endpoint, map to items.
 *
 * Network test — opt in with STREAM_LIVE=1. Its value is proving the thing this migration
 * bets on: that these routes really are reachable with a bare request and no page.
 */
const live = process.env.STREAM_LIVE === '1' ? it : it.skip

describe('lizhi-user http recipe (live)', () => {
  live('fetches and maps real episodes with no browser', async () => {
    // through the real package loader, so the whole package (package.json +
    // manifests.yaml + *.recipe.json) is what gets verified — not just the json
    const recipe = loadRecipePackages('packages').recipes.get('lizhi-user')
    expect(recipe?.kind).toBe('http')
    if (recipe?.kind !== 'http') return

    const { items, pages } = await interpret(
      recipe,
      { fetchInPage: makeHttpFetch(recipe) },
      { id: '2513816802261356588' },
    )

    expect(pages).toBeGreaterThanOrEqual(1)
    expect(items.length).toBeGreaterThan(10)

    const first = items[0]
    expect(first.title).toBeTruthy()
    expect(String(first.link)).toMatch(/^https:\/\/www\.lizhi\.fm\/vod\/\d+$/)
    expect(first.author).toBeTruthy()

    // pubDate must stay a NUMBER (unix seconds). The template branch of mapItem would
    // String() it, and stream-pipeline's `< 1e11 ⇒ seconds` heuristic only fires on a
    // number — a stringified one silently becomes "now" for every episode.
    expect(typeof first.pubDate).toBe('number')
    const asDate = new Date((first.pubDate as number) * 1000)
    expect(asDate.getUTCFullYear()).toBeGreaterThan(2015)
    expect(asDate.getTime()).toBeLessThan(Date.now() + 86_400_000)
  }, 30_000)
})
