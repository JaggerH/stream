import { describe, expect, it } from 'vitest'
import { loadRecipePackages } from './recipe-package.ts'
import { makeHttpFetch } from './http-fetch.ts'
import { interpret } from './interpret.ts'

// Live-only: hits pbaccess.video.qq.com. Skipped unless STREAM_LIVE=1 so `pnpm test` stays offline.
const live = process.env.STREAM_LIVE === '1' ? it : it.skip

describe('tencent cn/episode http recipe (live)', () => {
  live('flattens vsite_episode_list into episodes with no browser', async () => {
    const recipe = loadRecipePackages('packages').recipes.get('tencent-cn-episode')
    expect(recipe?.kind).toBe('http')
    if (recipe?.kind !== 'http') return

    const { items } = await interpret(
      recipe,
      { fetchInPage: makeHttpFetch(recipe) },
      { cid: 'mzc00200tzs7ig5' },
    )

    expect(items.length).toBeGreaterThan(0)
    const first = items[0]
    expect(first.title).toBeTruthy()
    expect(String(first.link)).toMatch(/v\.qq\.com\/x\/cover\/mzc00200tzs7ig5\//)
    expect(first.guid).toBeTruthy()
  }, 30_000)
})
