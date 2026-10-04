import { describe, expect, it } from 'vitest'
import { loadRecipePackages } from './recipe-package.ts'
import { makeHttpFetch } from './http-fetch.ts'
import { interpret } from './interpret.ts'

// Live-only: hits huggingface.co/api/spaces. Skipped unless STREAM_LIVE=1.
const live = process.env.STREAM_LIVE === '1' ? it : it.skip

describe('huggingface-spaces http recipe (live)', () => {
  live('maps a root-array spaces search with no browser', async () => {
    const recipe = loadRecipePackages('packages').recipes.get('huggingface-spaces')
    expect(recipe?.kind).toBe('http')
    if (recipe?.kind !== 'http') return

    const { items } = await interpret(
      recipe,
      { fetchInPage: makeHttpFetch(recipe) },
      { query: 'Whisper' },
    )

    expect(items.length).toBeGreaterThan(0)
    const first = items[0]
    expect(first.title).toBeTruthy()
    expect(String(first.link)).toMatch(/^https:\/\/huggingface\.co\/spaces\/.+/)
  }, 30_000)
})
