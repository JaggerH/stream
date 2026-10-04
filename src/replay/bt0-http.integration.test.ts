import { describe, expect, it } from 'vitest'
import { loadRecipePackages } from './recipe-package.ts'
import { makeHttpFetch } from './http-fetch.ts'
import { interpret } from './interpret.ts'

// Live-only: hits web2.mukaku.com. Skipped unless STREAM_LIVE=1 so `pnpm test` stays offline.
const live = process.env.STREAM_LIVE === '1' ? it : it.skip

describe('bt0 (mukaku) http recipes (live)', () => {
  live('tlist maps the latest movie list with no browser', async () => {
    const recipe = loadRecipePackages('packages').recipes.get('bt0-tlist')
    expect(recipe?.kind).toBe('http')
    if (recipe?.kind !== 'http') return

    const { items, pages } = await interpret(
      recipe,
      { fetchInPage: makeHttpFetch(recipe) },
      { sc: '1' },
    )

    expect(pages).toBeGreaterThanOrEqual(1)
    expect(items.length).toBeGreaterThan(0)

    const first = items[0]
    expect(first.title).toBeTruthy()
    expect(String(first.link)).toMatch(/^https:\/\/web2\.mukaku\.com\//)
    expect(String(first.enclosure_url)).toMatch(/^magnet:/)
  }, 30_000)

  live('search maps matched titles for a keyword', async () => {
    const recipe = loadRecipePackages('packages').recipes.get('bt0-search')
    expect(recipe?.kind).toBe('http')
    if (recipe?.kind !== 'http') return

    const { items } = await interpret(
      recipe,
      { fetchInPage: makeHttpFetch(recipe) },
      { keyword: '复仇者' },
    )

    expect(items.length).toBeGreaterThan(0)
    const first = items[0]
    expect(first.title).toBeTruthy()
    expect(String(first.link)).toMatch(/^https:\/\/web2\.mukaku\.com\/mv\//)
    expect(String(first.guid)).toMatch(/^mukaku-mv-/)
  }, 30_000)
})
