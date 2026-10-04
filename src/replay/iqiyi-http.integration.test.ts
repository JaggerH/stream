import { describe, expect, it } from 'vitest'
import { loadRecipePackages } from './recipe-package.ts'
import { makeHttpFetch } from './http-fetch.ts'
import { interpret } from './interpret.ts'

// Live-only: hits mesh.if.iqiyi.com. Skipped unless STREAM_LIVE=1 so `pnpm test` stays offline.
const live = process.env.STREAM_LIVE === '1' ? it : it.skip

describe('iqiyi cn/search http recipe (live)', () => {
  live('maps album search results with no browser', async () => {
    const recipe = loadRecipePackages('packages').recipes.get('iqiyi-cn-search')
    expect(recipe?.kind).toBe('http')
    if (recipe?.kind !== 'http') return

    const { items } = await interpret(
      recipe,
      { fetchInPage: makeHttpFetch(recipe) },
      { keyword: '喜剧之王单口季3' },
    )

    // The templates array mixes album rows with intent cards; at least one real album must map.
    const albums = items.filter((i) => i.title && String(i.link).includes('iqiyi.com'))
    expect(albums.length).toBeGreaterThan(0)
    expect(String(albums[0].guid)).toMatch(/^iqiyi-\d+$/)
  }, 30_000)
})

describe('iqiyi cn/album http recipe (live)', () => {
  live('signs the tvg selector and flattens a season into episodes', async () => {
    const recipe = loadRecipePackages('packages').recipes.get('iqiyi-cn-album')
    expect(recipe?.kind).toBe('http')
    if (recipe?.kind !== 'http') return

    const { items } = await interpret(
      recipe,
      { fetchInPage: makeHttpFetch(recipe) },
      { albumId: '1444399879630401' },
    )

    expect(items.length).toBeGreaterThan(0)
    const first = items[0]
    expect(first.title).toBeTruthy()
    expect(String(first.link)).toMatch(/iqiyi\.com/)
    // decode upscaled the cover to the 720x405 episode thumb
    expect(String(first.image)).toMatch(/_720_405\./)
  }, 30_000)
})
