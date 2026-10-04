import { describe, expect, it } from 'vitest'
import { loadRecipePackages } from './recipe-package.ts'
import { makeHttpFetch } from './http-fetch.ts'
import { interpret } from './interpret.ts'

const live = process.env.STREAM_LIVE === '1' ? it : it.skip

describe('imdb-chart http recipe (live)', () => {
  live('fetches and maps real movies with no browser', async () => {
    const recipe = loadRecipePackages('packages').recipes.get('imdb-chart')
    expect(recipe?.kind).toBe('http')
    if (recipe?.kind !== 'http') return

    const { items, pages } = await interpret(
      recipe,
      { fetchInPage: makeHttpFetch(recipe) },
      { chart: 'MOST_POPULAR_MOVIES' },
    )

    expect(pages).toBeGreaterThanOrEqual(1)
    expect(items.length).toBeGreaterThan(10)

    const first = items[0]
    expect(first.title).toBeTruthy()
    expect(String(first.link)).toMatch(/^https:\/\/www\.imdb\.com\/title\/tt\d+$/)
  }, 30_000)
})
